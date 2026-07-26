// Blocker Buddy widget body.
//
// Two layered surfaces in one widget:
//   1) Live data block (hero + secondary metrics) driven by fetchWidgetData
//   2) Categories management surface (existing MVP — add/remove categories,
//      writes through to ExtensionDataService on every action)
//
// Data fetch is non-blocking — categories UI renders synchronously from
// teamConfig, then a background fetch swaps the metrics block from "Loading…"
// to live data. This keeps the widget feeling instant on dashboard load
// even when the WIQL + per-item comment fetches take a second or two.

import "./Widget.scss";
import * as SDK from "azure-devops-extension-sdk";
import { WidgetStatusHelper } from "azure-devops-extension-api/Dashboard/WidgetHelpers";
import {
    getTeamConfig,
    setTeamConfig,
    deleteTeamConfig,
    validateCategoryName,
    STARTER_CATEGORIES,
    DEFAULT_CONFIG,
    WINDOW_OPTIONS,
    resolveWindowDays,
    formatWindowLabel,
    TeamConfig
} from "../../Library/teamConfig";
import {
    ensureProjectContext,
    getDashboardTeamIdOrNull,
    isCurrentUserAdmin,
    isDevExtension
} from "../../Library/blockerBuddyLibrary";
import { fetchWidgetData, buildRollingWindow } from "../../Library/widgetData";
import { WidgetAggregateData, formatDurationDays } from "../../Library/blockerAggregation";
import { WorkItemBlockerHistory } from "../../Library/blockerEventTimeline";
import {
    CategoryRow,
    buildCategoryRows,
    canEdit,
    collectMatchingIds,
    buildBlockerTsv,
    buildWorkItemUrlPrefix
} from "../../Library/widgetView";


interface WidgetCustomSettings {
    teamId?: string;
}

interface WidgetSettings {
    customSettings?: { data?: string };
    name?: string;
    size?: { rowSpan: number; columnSpan: number };
}

type DataState =
    | { kind: "loading" }
    | {
        kind: "ready";
        aggregate: WidgetAggregateData;
        /** Per-work-item histories — kept so per-row affordances (📋 copy TSV) can drill into specific intervals. */
        histories: ReadonlyArray<WorkItemBlockerHistory>;
        windowDays: number;
        teamHasNoAreaPaths: boolean;
        /** True when WIQL likely hit ADO's 20K row cap. Surface a banner so the user knows the displayed data is incomplete. */
        wiqlPossiblyTruncated: boolean;
      }
    | { kind: "error"; message: string };

/**
 * Two-mode widget state:
 *
 *   - "needs-config" — the widget has no resolvable team. This happens when
 *     the widget config doesn't supply a teamId AND the dashboard isn't
 *     team-scoped (project-level dashboard). We must NOT fetch data with a
 *     fallback team, because that would silently mis-scope counts. Instead,
 *     render a CTA pointing the user at the widget config pane.
 *
 *   - "configured" — we have a teamId from either widget config or dashboard
 *     context. Full UI: live data block + categories management surface.
 */
type WidgetState =
    | { mode: "needs-config"; widgetName: string }
    | {
        mode: "configured";
        widgetName: string;
        teamId: string;
        teamConfig: TeamConfig;
        /**
         * True when the current user is a team or project admin. Combined
         * with teamConfig.allowMemberEdit to decide whether edit affordances
         * (× delete, add row, suggestion chips) render on the widget body.
         * Cached at initialize-time; isCurrentUserAdmin is fail-open on
         * error (treats as admin) so transient permission API failures
         * don't lock legitimate admins out.
         */
        isAdmin: boolean;
        status:
            | { kind: "idle" | "saving" }
            | { kind: "error"; message: string }
            | { kind: "info"; message: string };
        data: DataState;
        /**
         * Increments on every initialize() call. Background fetches compare
         * against this so a slow query from a previous reload can't overwrite
         * fresher state. ADO calls reload() any time config changes.
         */
        fetchToken: number;
      };

/** True when the current user can edit the team's curated categories. */
function canEditCategories(s: WidgetState): boolean {
    if (s.mode !== "configured") return false;
    return canEdit(s.isAdmin, s.teamConfig.allowMemberEdit);
}

const DEFAULT_WIDGET_NAME = "Blocker Buddy";

let state: WidgetState | undefined;

console.log("[BlockerBuddy] Widget.js loaded");

SDK.init({ loaded: false });

SDK.ready().then(() => {
    SDK.register("blocker-buddy-widget", () => ({
        async load(widgetSettings: WidgetSettings) {
            try {
                await initialize(widgetSettings);
                return WidgetStatusHelper.Success();
            } catch (err) {
                console.error("[BlockerBuddy] Widget load failed:", err);
                renderError(err);
                const msg = (err as Error)?.message ?? String(err);
                return WidgetStatusHelper.Failure(msg);
            }
        },
        async reload(widgetSettings: WidgetSettings) {
            try {
                await initialize(widgetSettings);
                return WidgetStatusHelper.Success();
            } catch (err) {
                console.error("[BlockerBuddy] Widget reload failed:", err);
                renderError(err);
                const msg = (err as Error)?.message ?? String(err);
                return WidgetStatusHelper.Failure(msg);
            }
        }
    }));
    SDK.notifyLoadSucceeded();
}).catch((err: unknown) => {
    console.error("[BlockerBuddy] Widget SDK.ready() rejected:", err);
    renderError(err);
});

// ─── Initialization ──────────────────────────────────────────────────────

async function initialize(widgetSettings: WidgetSettings): Promise<void> {
    await ensureProjectContext();
    const customSettings = parseCustomSettings(widgetSettings.customSettings?.data);

    // ADO passes the user-customized widget name on every load/reload — echo
    // it in the body title so renames in the config pane round-trip to the
    // surface a user actually reads. Falls back to the brand name when the
    // widget hasn't been renamed.
    const widgetName = (widgetSettings.name?.trim()) || DEFAULT_WIDGET_NAME;

    // Resolve team in priority order: explicit widget config → dashboard team
    // context → null. Critically, we do NOT fall back to "first team in
    // project" — that would silently misattribute counts on a project
    // dashboard. The user must open widget config and pick a team explicitly.
    const teamId = customSettings.teamId ?? getDashboardTeamIdOrNull();

    const previousFetchToken = state?.mode === "configured" ? state.fetchToken : 0;
    const nextFetchToken = previousFetchToken + 1;

    if (!teamId) {
        state = { mode: "needs-config", widgetName };
        render();
        return;
    }

    // Fetch team config + admin status in parallel — both are cheap and we
    // need both before first render to gate edit affordances correctly.
    const [teamConfig, isAdmin] = await Promise.all([
        getTeamConfig(teamId),
        isCurrentUserAdmin(teamId)
    ]);

    state = {
        mode: "configured",
        widgetName,
        teamId,
        teamConfig,
        isAdmin,
        status: { kind: "idle" },
        data: { kind: "loading" },
        fetchToken: nextFetchToken
    };
    render();

    // Non-blocking background fetch — render() doesn't wait on this.
    void loadBlockerData(nextFetchToken);
}

async function loadBlockerData(token: number): Promise<void> {
    if (!state || state.mode !== "configured") return;
    const teamId = state.teamId;
    const tagName = state.teamConfig.tagName;
    const windowDays = resolveWindowDays(state.teamConfig.selectedWindowDays);
    const { windowStart, windowEnd } = buildRollingWindow(windowDays);
    try {
        const result = await fetchWidgetData({ teamId, tagName, windowStart, windowEnd });
        // Stale-fetch guard: if a reload kicked off a newer fetch, ignore this one.
        if (!state || state.mode !== "configured" || state.fetchToken !== token) return;
        state.data = {
            kind: "ready",
            aggregate: result.aggregate,
            histories: result.histories,
            windowDays,
            teamHasNoAreaPaths: result.teamHasNoAreaPaths,
            wiqlPossiblyTruncated: result.wiqlPossiblyTruncated
        };
        render();
    } catch (err) {
        if (!state || state.mode !== "configured" || state.fetchToken !== token) return;
        console.error("[BlockerBuddy] loadBlockerData failed:", err);
        state.data = {
            kind: "error",
            message: (err as Error)?.message ?? String(err)
        };
        render();
    }
}

function parseCustomSettings(data?: string): WidgetCustomSettings {
    if (!data) return {};
    try {
        return JSON.parse(data) as WidgetCustomSettings;
    } catch {
        return {};
    }
}

// ─── Rendering ───────────────────────────────────────────────────────────

function render(): void {
    if (!state) return;
    const root = document.getElementById("root");
    if (!root) return;

    if (state.mode === "needs-config") {
        root.innerHTML = renderNeedsConfig();
        return;
    }

    // Single unified surface: hero + metrics block at top, then ONE category
    // list that's both the live data view AND the editing surface (per the
    // "edit-where-you-see" design intent in project_blocker_buddy_design.md).
    // The list merges the team's curated categories with whatever appears in
    // the aggregate data window — three row states surface naturally:
    //   - active: in team config + has window data → full color, × delete
    //   - in-config-no-data: curated but quiet → muted, × delete
    //   - deleted-with-history: removed from config but markers still in
    //     window → greyed, no edit (ages off automatically as data falls
    //     out of window)

    root.innerHTML = `
        <div class="bb-widget">
            ${renderTitleRow()}
            ${renderHeroRow()}
            ${renderDataBlock()}
            ${renderEditingFooter()}
            ${isDevExtension() ? renderDevTools() : ""}
        </div>
    `;

    wireUpHandlers();
}

/**
 * Title row + hero/window row.
 *
 * Title row: user-customized widget name on its own line.
 *
 * Hero/window row (combined): the "X blocked now" hero on the left, the
 * time-window selector on the right, baseline-aligned. This pulls the
 * hero up into prime real-estate (matching ADO's "big number upper-left"
 * convention for metric widgets) while keeping the dropdown on its own
 * vertical band (out of ADO's hover hot-zone for widget chrome at the
 * top-right). When there's no hero to show (loading, empty, error
 * states), the dropdown still right-aligns alone.
 */
function renderTitleRow(): string {
    if (!state) return "";
    const widgetName = state.widgetName;
    return `<h2 class="bb-widget-title">${escapeText(widgetName)}</h2>`;
}

function renderHeroRow(): string {
    if (!state || state.mode !== "configured") return "";

    // Hero appears when there's a current count to display (mixed and
    // day-zero states). The selector appears whenever the widget is
    // attempting to show data (loading/error/ready, not the no-area-paths
    // takeover).
    let heroHtml = "";
    if (state.data.kind === "ready" && !state.data.teamHasNoAreaPaths) {
        const { currentlyBlocked, inWindow } = state.data.aggregate;
        if (currentlyBlocked > 0 || inWindow.blockerCount > 0) {
            heroHtml = renderHero(currentlyBlocked);
        }
    }

    const showSelector = state.data.kind === "loading"
        || state.data.kind === "error"
        || (state.data.kind === "ready" && !state.data.teamHasNoAreaPaths);

    if (!heroHtml && !showSelector) return "";

    const selectedDays = resolveWindowDays(state.teamConfig.selectedWindowDays);
    const selectorHtml = showSelector ? `
        <select id="bb-window-select" class="bb-window-select" aria-label="Time window">
            ${WINDOW_OPTIONS.map(o => `
                <option value="${o.days}" ${o.days === selectedDays ? "selected" : ""}>${escapeText(o.label)}</option>
            `).join("")}
        </select>
    ` : "";

    return `
        <div class="bb-hero-row">
            ${heroHtml || `<div class="bb-hero-spacer"></div>`}
            ${selectorHtml}
        </div>
    `;
}

/**
 * Bottom footer present in any "configured" state where the team can edit
 * categories (i.e., not in needs-config / no-area-paths / loading / error
 * takeover states). The categories list itself is rendered inside
 * renderDataBlock so it sits adjacent to the hero/metrics for the unified
 * "single living legend" surface.
 */
function renderEditingFooter(): string {
    if (!state || state.mode !== "configured") return "";
    if (state.data.kind === "loading" || state.data.kind === "error") return "";
    // The needs-config / no-area-paths data states already take over the
    // whole widget surface — no footer needed for those either.
    if (state.data.kind === "ready" && state.data.teamHasNoAreaPaths) return "";
    // Edit-permission gate: hide entirely for non-admins when the team's
    // allowMemberEdit toggle is off (per design memo permissions table).
    // No "read-only" indicator — the absence of the add row is itself the
    // signal that curation isn't allowed at the user's permission level.
    if (!canEditCategories(state)) return "";

    return `
        <div class="bb-add-row">
            <input
                id="bb-add-input"
                type="text"
                class="bb-input"
                placeholder="Type your category here…"
                maxlength="50"
                aria-label="New category name"
            />
            <button id="bb-add-button" class="bb-btn-add" type="button">Add</button>
        </div>
        <div id="bb-add-error" class="bb-error" role="alert"></div>
        ${renderStatus()}
    `;
}

// ─── Dev tools (dev VSIX only) ────────────────────────────────────────────
//
// Two utilities for tight test-iteration loops:
//   - "Reset team config" — delete the ExtensionDataService blob so the
//     widget falls back to DEFAULT_CONFIG (empty categories, "Blocked" tag,
//     allowMemberEdit off). Verifies the read-fallback path on every reset.
//   - "Re-fetch data" — re-runs loadBlockerData() without a full widget
//     reload. Useful for "I just blocked an item via right-click — does the
//     widget see it?" without leaving the dashboard.
//
// Gated on isDevExtension() (extension id ends in -dev), so this code is
// dead in production bundles even though it ships in the same source.

function renderDevTools(): string {
    return `
        <div class="bb-dev-tools" aria-label="Developer tools (dev VSIX only)">
            <p class="bb-dev-tools-label">Dev tools</p>
            <div class="bb-dev-tools-row">
                <button id="bb-dev-reset" class="bb-btn-dev" type="button" title="Delete this team's Blocker Buddy config blob">
                    Reset team config
                </button>
                <button id="bb-dev-refetch" class="bb-btn-dev" type="button" title="Re-run the WIQL + comment fetch (without reloading the dashboard)">
                    Re-fetch data
                </button>
            </div>
        </div>
    `;
}

async function onResetTeamConfig(): Promise<void> {
    if (!state || state.mode !== "configured") return;
    const ok = window.confirm(
        "Reset team config?\n\nThis deletes the team's Blocker Buddy categories, " +
        "tag override, and allowMemberEdit flag. Cannot be undone."
    );
    if (!ok) return;

    try {
        // Critical ordering: setValue FIRST, then deleteDocument. The SDK's
        // ExtensionDataService.getValue is cached and deleteDocument does NOT
        // invalidate the cache — so a delete-then-read pattern returns the
        // stale pre-delete categories. setValue writes through both cache
        // and storage; the subsequent delete cleans storage. If the delete
        // fails silently, the doc has DEFAULT_CONFIG anyway — functionally
        // reset for callers.
        await setTeamConfig(state.teamId, { ...DEFAULT_CONFIG });
        await deleteTeamConfig(state.teamId);
        if (!state || state.mode !== "configured") return;
        // Reload config — guaranteed to return DEFAULT_CONFIG now
        const teamConfig = await getTeamConfig(state.teamId);
        if (!state || state.mode !== "configured") return;
        state.teamConfig = teamConfig;
        // Trigger a fresh data fetch — categories changed, hero/metrics may shift
        const nextFetchToken = state.fetchToken + 1;
        state.fetchToken = nextFetchToken;
        state.data = { kind: "loading" };
        render();
        void loadBlockerData(nextFetchToken);
    } catch (err) {
        console.error("[BlockerBuddy] reset team config failed:", err);
        window.alert(`Reset failed: ${(err as Error)?.message ?? String(err)}`);
    }
}

function onRefetchData(): void {
    if (!state || state.mode !== "configured") return;
    const nextFetchToken = state.fetchToken + 1;
    state.fetchToken = nextFetchToken;
    state.data = { kind: "loading" };
    render();
    void loadBlockerData(nextFetchToken);
}

function renderNeedsConfig(): string {
    const name = state?.widgetName ?? DEFAULT_WIDGET_NAME;
    return `
        <div class="bb-widget">
            <h2 class="bb-widget-title">${escapeText(name)}</h2>
            <div class="bb-data-block bb-data-block--needs-config">
                <p class="bb-empty-headline">Configure this widget</p>
                <p class="bb-empty-explainer">
                    This dashboard isn't team-scoped, so Blocker Buddy doesn't
                    know which team's work to count. Open the widget
                    configuration and pick a team to see blocker activity here.
                </p>
            </div>
        </div>
    `;
}

// ─── Data block (hero + secondary metrics) ───────────────────────────────

function renderDataBlock(): string {
    if (!state || state.mode !== "configured") return "";
    const data = state.data;

    if (data.kind === "loading") {
        return `
            <div class="bb-data-block bb-data-block--loading" aria-busy="true">
                <p class="bb-data-loading">Loading blocker data…</p>
            </div>
        `;
    }

    if (data.kind === "error") {
        return `
            <div class="bb-data-block bb-data-block--error">
                <p class="bb-data-error">⚠ Could not load blocker data: ${escapeText(data.message)}</p>
            </div>
        `;
    }

    const { currentlyBlocked, inWindow, untimedCount } = data.aggregate;
    const hasInWindowActivity = inWindow.blockerCount > 0;
    const teamCategories = state.teamConfig.categories;
    const rows = buildCategoryRows(teamCategories, data.aggregate.categories);
    const canEdit = canEditCategories(state);

    // Starter-chip offer: visible whenever the team has no curated
    // categories (regardless of whether deleted-with-history rows exist
    // from prior markers). Predicate is hoisted so all three render
    // branches (empty / day-zero / mixed) reference the same condition.
    const used = new Set(teamCategories.map(c => c.toLowerCase()));
    const suggestions = STARTER_CATEGORIES.filter(s => !used.has(s.toLowerCase()));
    const shouldOfferStarterChips = teamCategories.length === 0 && canEdit && suggestions.length > 0;

    // Configuration issue: team owns no area paths. Show explicitly so the
    // user knows this is "the team has no work items by ADO definition,"
    // not "no blockers happen to exist."
    if (data.teamHasNoAreaPaths) {
        return `
            <div class="bb-data-block bb-data-block--no-area-paths">
                <p class="bb-empty-headline">No team area paths configured.</p>
                <p class="bb-empty-explainer">
                    This team owns no area paths in ADO, so it has no work items
                    to scope blockers to. Configure team area paths in
                    <em>Project Settings → Teams → Areas</em>, or open the widget
                    config to point this widget at a different team.
                </p>
            </div>
        `;
    }

    // Empty state: no current blockers AND no activity in window. If the
    // team also has no curated categories, show suggestion chips so they
    // can bootstrap their vocabulary while waiting for real data.
    if (currentlyBlocked === 0 && !hasInWindowActivity) {
        return `
            <div class="bb-data-block bb-data-block--empty">
                <p class="bb-empty-headline">No items currently blocked.</p>
                <p class="bb-empty-explainer">
                    When your team marks items as blocked, you'll see counts and
                    trends here. Open the actions menu (⋯) on a board card or
                    backlog row and pick Blocker Buddy to capture the
                    "${escapeText(state.teamConfig.tagName)}" tag with a reason.
                </p>
                ${rows.length > 0 ? renderCategoryBreakdown(rows, 0, canEdit) : ""}
                ${shouldOfferStarterChips ? renderSuggestionChips(suggestions) : ""}
            </div>
        `;
    }

    // Day-zero state: items currently blocked but no categorized history
    // (typically: tag was on items before Blocker Buddy was installed).
    // Note: hero renders above the data block in renderHeroRow, not here.
    if (currentlyBlocked > 0 && !hasInWindowActivity) {
        return `
            <div class="bb-data-block bb-data-block--day-zero">
                <p class="bb-empty-explainer">
                    All items were tagged outside Blocker Buddy — no category
                    or timing data. New blockers added via the actions menu (⋯)
                    appear below with full data.
                </p>
                ${rows.length > 0 ? renderCategoryBreakdown(rows, untimedCount, canEdit) : ""}
                ${shouldOfferStarterChips ? renderSuggestionChips(suggestions) : ""}
            </div>
        `;
    }

    // Mixed state: real categorized history exists. Hero renders above
    // the data block in renderHeroRow.
    return `
        <div class="bb-data-block bb-data-block--mixed">
            ${data.wiqlPossiblyTruncated ? renderTruncationBanner() : ""}
            <div class="bb-secondary-metrics-row">
                <p class="bb-secondary-metrics">
                    ${escapeText(formatWindowLabel(data.windowDays))} · ${inWindow.blockerCount} blocked period${inWindow.blockerCount === 1 ? "" : "s"}
                    · ${escapeText(formatDurationDays(inWindow.totalDurationMs))} total
                </p>
                <span class="bb-cat-actions bb-cat-actions--secondary">
                    <button
                        class="bb-cat-action bb-cat-action--copy-all"
                        type="button"
                        aria-label="Copy all in-window blocked periods as TSV"
                        title="Copy all in-window blocked periods as TSV (paste into Excel)"
                    >⧉</button>
                    <button
                        class="bb-cat-action bb-cat-action--query-all"
                        type="button"
                        aria-label="Open ADO query for all in-window blocked periods"
                        title="Open ADO query for items with any in-window blocked period"
                    >↗</button>
                </span>
            </div>
            ${renderCumulativeChart(data.aggregate.cumulativeDurationByDay)}
            ${renderCategoryBreakdown(rows, untimedCount, canEdit)}
            ${shouldOfferStarterChips ? renderSuggestionChips(suggestions) : ""}
        </div>
    `;
}

/**
 * Top aggregate-duration chart — cumulative blocker-hours-blocked over the
 * window. Slopes show busy periods, plateaus show calm. No axes, no labels:
 * the secondary metrics line above already carries the absolute totals.
 *
 * Inline SVG area path with a stroke on top — theme-aware via currentColor
 * variants. The Y axis is normalized to the series max (the final value =
 * total in-window duration), so the visual shape always uses the full
 * height regardless of how big or small the absolute totals are.
 */
function renderCumulativeChart(cumulative: ReadonlyArray<number>): string {
    if (cumulative.length < 2) return "";  // need at least 2 points to draw
    const maxValue = cumulative[cumulative.length - 1];
    if (maxValue <= 0) return "";  // no data → don't render an empty rectangle

    const width = 200;
    const height = 32;
    const stepX = width / (cumulative.length - 1);

    let pathD = "";
    let strokeD = "";
    for (let i = 0; i < cumulative.length; i++) {
        const x = (i * stepX).toFixed(2);
        const y = (height - (cumulative[i] / maxValue) * height).toFixed(2);
        if (i === 0) {
            pathD += `M 0 ${height} L ${x} ${y}`;
            strokeD += `M ${x} ${y}`;
        } else {
            pathD += ` L ${x} ${y}`;
            strokeD += ` L ${x} ${y}`;
        }
    }
    pathD += ` L ${width} ${height} Z`;

    const titleText = `Cumulative blocked-time over the last ${cumulative.length} days. Steep slopes show busy periods, plateaus show calm. Final value: ${formatDurationDays(maxValue)} total.`;
    return `
        <svg class="bb-cum-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
            <title>${escapeText(titleText)}</title>
            <path class="bb-cum-chart-fill" d="${pathD}"/>
            <path class="bb-cum-chart-stroke" d="${strokeD}" fill="none"/>
        </svg>
    `;
}

/**
 * Banner shown when the WIQL query likely hit ADO's 20K row cap. Without
 * this, the widget would silently report incomplete totals and the user
 * would have no way to know they're missing data. Triggered for very
 * mature multi-year projects with thousands of blocker history entries.
 */
function renderTruncationBanner(): string {
    return `
        <p class="bb-truncation-banner">
            ⚠ Showing the first ${"20,000"} matching items (ADO's per-query limit). Narrow the time window for fuller coverage.
        </p>
    `;
}

function renderSuggestionChips(suggestions: readonly string[]): string {
    // Single-action design (refined 2026-05-01): show the suggested
    // categories as preview text + one bulk-add button + a reversibility
    // hint. Earlier per-chip "click to add this one" UX was a fake
    // choice — clicking ANY chip flipped the empty-state condition
    // false and made the rest disappear. Now: show what's in the bag,
    // one click adds it, helper text confirms it's editable afterward.
    const previewText = suggestions.join(" · ");
    return `
        <div class="bb-suggestion-block">
            <p class="bb-suggestion-label">Suggested categories</p>
            <p class="bb-suggestion-preview">${escapeText(previewText)}</p>
            <button
                class="bb-chip bb-chip--primary"
                type="button"
                data-add-all="true"
            >+ Add all ${suggestions.length}</button>
            <p class="bb-suggestion-helper">Delete or add your own afterward.</p>
        </div>
    `;
}

function renderHero(count: number): string {
    // Structure matches Throughput's .tp-chart-headline pattern: number
    // is the bare text content of an outer span, unit/descriptor is a
    // nested span with a LITERAL TEXT SPACE between them. The text space
    // renders at the parent's font-size (32px), so it's ~8-10px wide —
    // proportional to the number itself. Plus a 4px margin-left on the
    // label adds a touch more separation. Total gap ~12-14px, which
    // scales naturally if hero size ever changes.
    //
    // NOT a flex container with `gap`: gap is fixed-width regardless of
    // font-size, so it would feel cramped at larger hero sizes and lonely
    // at smaller ones.
    return `<span class="bb-hero">${count} <span class="bb-hero-label">blocked now</span></span>`;
}

// ─── Category breakdown rows + sparklines ────────────────────────────────
//
// Categorized rows render with a filled bullet (●), name, count·duration
// metrics, and a per-row sparkline of daily block-START events over the
// window. Sort is descending by total duration (set in aggregateForWidget).
//
// The "Not timed or categorized" structural row uses an outline bullet (○)
// to signal it's not a curated category — it's a count of items currently
// tagged but with no marker history. No metrics beyond count, no sparkline:
// we don't have timing data to chart.

// buildCategoryRows + CategoryRow types moved to ../../Library/widgetView.ts

function renderCategoryBreakdown(
    rows: ReadonlyArray<CategoryRow>,
    untimedCount: number,
    canEdit: boolean
): string {
    // Shared y-axis: max event count on any single day across all categorized
    // rows in the window. Per-row normalization made magnitude across rows
    // visually identical (4 events looked the same as 2); a shared scale keeps
    // bar heights directly comparable, in line with the row sort by total
    // duration.
    let sharedMax = 0;
    for (const row of rows) {
        if (!row.metrics) continue;
        for (const c of row.metrics.dailyEventCounts) {
            if (c > sharedMax) sharedMax = c;
        }
    }

    const rowsHtml = rows.map(row => {
        const stateClass = `bb-cat-row--${row.state}`;
        // Edit affordance shows when (a) the row is editable in shape (active
        // or in-config-no-data; deleted-with-history rows already have no ×)
        // AND (b) the current user has edit permission per allowMemberEdit /
        // admin gating.
        const isEditableShape = row.state !== "deleted-with-history";
        const showDelete = isEditableShape && canEdit;

        const metricsTitle = row.metrics
            ? `${row.metrics.count} blocked period${row.metrics.count === 1 ? "" : "s"}, ${formatDurationDays(row.metrics.totalDurationMs)} total`
            : "No blocked periods in the current window";
        const metricsHtml = row.metrics
            ? `<span class="bb-cat-metrics" title="${escapeAttr(metricsTitle)}">${row.metrics.count} · ${escapeText(formatDurationDays(row.metrics.totalDurationMs))}</span>`
            : `<span class="bb-cat-metrics bb-cat-metrics--quiet" title="${escapeAttr(metricsTitle)}">0 · 0 days</span>`;

        const sparklineHtml = row.metrics ? renderSparkline(row.metrics.dailyEventCounts, row.name, sharedMax) : renderEmptySparkline();

        const deleteBtn = showDelete
            ? `<button
                    class="bb-cat-delete"
                    type="button"
                    data-category="${escapeAttr(row.name)}"
                    aria-label="Remove ${escapeAttr(row.name)} from curated categories"
                    title="Remove from curated categories"
                >×</button>`
            : "";

        // Hover-revealed power affordances. ✏ rename gates on canEdit (it
        // mutates curated state); ⧉ copy and ↗ query are read-only and
        // available to anyone, BUT both gate on row.metrics — i.e., they
        // only show when the category has in-window blocked periods. The
        // earlier "always show ↗ since the query may reach data outside
        // the window" rationale didn't survive empirical use: clicking ↗
        // on an empty category produced a red-error dead-end, which
        // signaled "this affordance is broken" more than "you can still
        // try." Gating the icon away matches the copy gating and removes
        // the dead-end interaction.
        const renameBtn = canEdit && isEditableShape
            ? `<button
                    class="bb-cat-action bb-cat-action--rename"
                    type="button"
                    data-category="${escapeAttr(row.name)}"
                    aria-label="Rename ${escapeAttr(row.name)}"
                    title="Rename category"
                >✎</button>`
            : "";
        const copyBtn = row.metrics
            ? `<button
                    class="bb-cat-action bb-cat-action--copy"
                    type="button"
                    data-category="${escapeAttr(row.name)}"
                    aria-label="Copy ${escapeAttr(row.name)} blocked periods as TSV"
                    title="Copy blocked periods as TSV (paste into Excel)"
                >⧉</button>`
            : "";
        const queryBtn = row.metrics
            ? `<button
                    class="bb-cat-action bb-cat-action--query"
                    type="button"
                    data-category="${escapeAttr(row.name)}"
                    aria-label="Open ADO query for items blocked under ${escapeAttr(row.name)}"
                    title="Open ADO query for items with a blocked period in this category"
                >↗</button>`
            : "";

        const actionsGroup = renameBtn || copyBtn || queryBtn
            ? `<span class="bb-cat-actions">${renameBtn}${copyBtn}${queryBtn}</span>`
            : "";

        const titleAttr = row.state === "deleted-with-history"
            ? `${escapeAttr(row.name)} — removed from curated categories; blocked periods from before removal still show until they age out of the window`
            : escapeAttr(row.name);

        return `
            <li class="bb-cat-row ${stateClass}">
                <span class="bb-cat-bullet" aria-hidden="true">●</span>
                <div class="bb-cat-content">
                    <div class="bb-cat-header">
                        <span class="bb-cat-name" title="${titleAttr}">${escapeText(row.name)}</span>
                        ${metricsHtml}
                        ${actionsGroup}
                        ${deleteBtn}
                    </div>
                    ${sparklineHtml}
                </div>
            </li>
        `;
    }).join("");

    const untimedTitle = "Items currently tagged but with no Blocker Buddy markers. Duration isn't tracked because their start time wasn't recorded.";
    const untimedRow = untimedCount > 0 ? `
        <li class="bb-cat-row bb-cat-row--untimed">
            <span class="bb-cat-bullet bb-cat-bullet--outline" aria-hidden="true">○</span>
            <div class="bb-cat-content">
                <div class="bb-cat-header">
                    <span class="bb-cat-name" title="${escapeAttr(untimedTitle)}">Not timed or categorized</span>
                    <span class="bb-cat-metrics" title="${escapeAttr(untimedTitle)}">${untimedCount} · — days</span>
                    <span class="bb-cat-delete bb-cat-delete--placeholder" aria-hidden="true">×</span>
                </div>
            </div>
        </li>
    ` : "";

    if (!rowsHtml && !untimedRow) return "";
    return `<ul class="bb-cat-breakdown">${rowsHtml}${untimedRow}</ul>`;
}

/**
 * Tiny inline-SVG bar chart for a single category's daily block-start counts.
 * Bars are normalized to the SHARED max passed in (computed across all
 * categorized rows in the breakdown), so heights are directly comparable
 * row-to-row — a row with 4 events on its peak day visibly outranks a row
 * whose peak was 2.
 *
 * A small minimum-bar-height floor keeps single-event days visible on quiet
 * categories where the proportional height would otherwise render as an
 * imperceptible sliver against a busy peer's max.
 *
 * Renders nothing for all-zero rows (preserves the "category curated, nothing
 * happened" signal — the metrics line carries "0 · 0 days") or when the
 * shared max is zero (whole window has no in-window events).
 *
 * The SVG <title> element provides BOTH the native browser tooltip AND the
 * accessibility name for screen readers, so we drop the aria-hidden flag.
 */
function renderSparkline(counts: ReadonlyArray<number>, categoryName: string, sharedMax: number): string {
    if (counts.length === 0) return renderEmptySparkline();
    if (sharedMax <= 0) return renderEmptySparkline();
    const rowMax = Math.max(...counts);
    if (rowMax <= 0) return renderEmptySparkline();

    const width = 90;
    const height = 14;
    const barWidth = width / counts.length;
    const barGap = barWidth > 2 ? 0.5 : 0;
    // Floor in viewBox units (chart is 14 tall → ~1.5px on screen). Just enough
    // for a single-event day to register as "something happened" when a peer
    // category's peak is much taller; small enough not to compress the
    // dynamic range that makes the busy peer's shape readable.
    const minBarHeight = 1.5;
    const bars = counts.map((c, i) => {
        if (c <= 0) return "";
        const rawH = (c / sharedMax) * height;
        const h = Math.max(rawH, minBarHeight);
        const y = height - h;
        const w = Math.max(barWidth - barGap, 0.5);
        return `<rect x="${(i * barWidth).toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"/>`;
    }).join("");
    const titleText = `Daily new blocked periods in "${categoryName}" over the last ${counts.length} days. Bar heights use a shared scale across categories so they're directly comparable row-to-row.`;
    return `<svg class="bb-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"><title>${escapeText(titleText)}</title>${bars}</svg>`;
}

// Reserve the 14px sparkline slot for rows with no in-window activity so the
// breakdown's row heights stay consistent regardless of data presence. Empty
// SVG inherits its height from the .bb-sparkline CSS rule and renders nothing.
function renderEmptySparkline(): string {
    return `<svg class="bb-sparkline bb-sparkline--empty" viewBox="0 0 90 14" preserveAspectRatio="none" aria-hidden="true"></svg>`;
}

function renderStatus(): string {
    if (!state || state.mode !== "configured") return "";
    if (state.status.kind === "saving") {
        return `<div class="bb-status">Saving…</div>`;
    }
    if (state.status.kind === "error") {
        return `<div class="bb-status bb-status--error">${escapeText(state.status.message)}</div>`;
    }
    if (state.status.kind === "info") {
        return `<div class="bb-status bb-status--info">${escapeText(state.status.message)}</div>`;
    }
    return "";
}

function renderError(err: unknown): void {
    const root = document.getElementById("root");
    if (!root) return;
    const msg = (err as Error)?.message ?? String(err);
    root.innerHTML = `
        <div class="bb-widget">
            <h2 class="bb-widget-title">Blocker Buddy</h2>
            <div class="bb-status bb-status--error">${escapeText(msg)}</div>
        </div>
    `;
}

// ─── Event handlers ──────────────────────────────────────────────────────

function wireUpHandlers(): void {
    const addBtn = document.getElementById("bb-add-button");
    const addInput = document.getElementById("bb-add-input") as HTMLInputElement | null;
    addBtn?.addEventListener("click", () => onAddCustom());
    addInput?.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            onAddCustom();
        }
    });
    addInput?.addEventListener("input", () => clearAddError());

    document.querySelector<HTMLButtonElement>(".bb-chip[data-add-all]")
        ?.addEventListener("click", () => { void onAddAllSuggestions(); });

    document.querySelectorAll<HTMLButtonElement>(".bb-cat-delete[data-category]").forEach(btn => {
        btn.addEventListener("click", () => onRemoveCategory(btn.dataset.category ?? ""));
    });

    document.querySelectorAll<HTMLButtonElement>(".bb-cat-action--rename[data-category]").forEach(btn => {
        btn.addEventListener("click", () => onStartRenameCategory(btn.dataset.category ?? ""));
    });
    document.querySelectorAll<HTMLButtonElement>(".bb-cat-action--copy[data-category]").forEach(btn => {
        btn.addEventListener("click", () => { void onCopyCategoryTsv(btn.dataset.category ?? ""); });
    });
    document.querySelectorAll<HTMLButtonElement>(".bb-cat-action--query[data-category]").forEach(btn => {
        btn.addEventListener("click", () => onOpenCategoryQuery(btn.dataset.category ?? ""));
    });

    // Secondary metrics line: copy/query for all in-window blockers
    document.querySelector<HTMLButtonElement>(".bb-cat-action--copy-all")
        ?.addEventListener("click", () => { void onCopyAllInWindowTsv(); });
    document.querySelector<HTMLButtonElement>(".bb-cat-action--query-all")
        ?.addEventListener("click", () => onOpenAllInWindowQuery());

    // Dev-tools handlers (no-op when the elements aren't rendered)
    document.getElementById("bb-dev-reset")?.addEventListener("click", () => { void onResetTeamConfig(); });
    document.getElementById("bb-dev-refetch")?.addEventListener("click", () => onRefetchData());

    // Time-window selector
    const windowSelect = document.getElementById("bb-window-select") as HTMLSelectElement | null;
    windowSelect?.addEventListener("change", () => {
        const newDays = parseInt(windowSelect.value, 10);
        if (Number.isFinite(newDays)) void onChangeWindow(newDays);
    });
}

async function onChangeWindow(days: number): Promise<void> {
    if (!state || state.mode !== "configured") return;
    const previous = state.teamConfig;
    if (previous.selectedWindowDays === days) return;  // no-op

    // Optimistic update — write through team config so the change persists,
    // then trigger a fresh data fetch with the new window. If the persist
    // fails, roll back the state and tell the user.
    state.teamConfig = { ...previous, selectedWindowDays: days };
    const nextFetchToken = state.fetchToken + 1;
    state.fetchToken = nextFetchToken;
    state.data = { kind: "loading" };
    render();

    try {
        await setTeamConfig(state.teamId, state.teamConfig);
        if (!state || state.mode !== "configured") return;
        void loadBlockerData(nextFetchToken);
    } catch (err) {
        console.error("[BlockerBuddy] window persist failed:", err);
        if (!state || state.mode !== "configured") return;
        state.teamConfig = previous;
        state.data = {
            kind: "error",
            message: `Could not save window selection: ${(err as Error)?.message ?? String(err)}`
        };
        render();
    }
}

function onAddCustom(): void {
    const input = document.getElementById("bb-add-input") as HTMLInputElement | null;
    if (!input) return;
    const raw = input.value;
    onAddCategory(raw, /* fromInput */ true);
}

/**
 * Bulk-add all unused starter suggestions in a single persist call.
 * Filters out names that already exist in the team's list (case-
 * insensitive) so this is idempotent — clicking "Add all" twice in
 * a row doesn't double-add. Defense-in-depth: same admin gate as
 * onAddCategory so a stale DOM element can't bypass permissions.
 */
async function onAddAllSuggestions(): Promise<void> {
    if (!state || state.mode !== "configured") return;
    if (!canEditCategories(state)) return;
    const used = new Set(state.teamConfig.categories.map(c => c.toLowerCase()));
    const toAdd = STARTER_CATEGORIES.filter(s => !used.has(s.toLowerCase()));
    if (toAdd.length === 0) return;
    const next: TeamConfig = {
        ...state.teamConfig,
        categories: [...state.teamConfig.categories, ...toAdd]
    };
    await persist(next);
}

async function onAddCategory(name: string, fromInput = false): Promise<void> {
    if (!state || state.mode !== "configured") return;
    // Defense-in-depth: even if the add row was somehow surfaced for a
    // non-admin without allowMemberEdit, refuse the write at the handler
    // level so the only way to mutate is through a real authorized path.
    if (!canEditCategories(state)) return;
    const validation = validateCategoryName(name, state.teamConfig.categories);
    if (!validation.ok) {
        if (fromInput) showAddError(validation.error ?? "Invalid category name.");
        return;
    }
    const trimmed = name.trim();
    const next: TeamConfig = {
        ...state.teamConfig,
        categories: [...state.teamConfig.categories, trimmed]
    };
    await persist(next, () => {
        const input = document.getElementById("bb-add-input") as HTMLInputElement | null;
        if (input) input.value = "";
    });
}

// ─── Per-row affordances: rename / copy TSV / open WIQL ─────────────────

/**
 * 🔍 Open ADO query editor with a WIQL query for the matching work items.
 * Uses `[System.Id] IN (...)` with the explicit IDs we already know from
 * fetched histories — more accurate than text-search WIQL (which would miss
 * unblocked items that have lost the tag) and doesn't depend on the query
 * editor's UI exposing a "Was Ever Blocked" predicate, which it doesn't.
 *
 * URL length cap: ADO/browser URL limits land around 2000 chars. Each ID
 * costs ~7 chars in the IN-list + the base URL is ~250 chars + WIQL
 * skeleton is ~200 chars. Cap at QUERY_MAX_IDS so we stay safely under.
 * On overflow, truncate to the most-recent IDs (which are usually what
 * the user wants when investigating "why was this blocked") and surface a
 * truncation notice via the transient status footer.
 */
const QUERY_MAX_IDS = 200;

function openIdsQuery(ids: number[], headlineForTitle: string): void {
    if (!state || state.mode !== "configured") return;
    if (ids.length === 0) {
        showTransientStatus(`No items to query for ${headlineForTitle}`, "error");
        return;
    }

    const orgName = SDK.getHost().name;
    const projectName = SDK.getWebContext().project?.name ?? "";
    if (!orgName || !projectName) {
        console.warn("[BlockerBuddy] cannot build query URL — missing org or project name");
        return;
    }

    let queryIds = ids;
    let truncated = false;
    if (ids.length > QUERY_MAX_IDS) {
        // Take the LAST N items — the histories array order is whatever the
        // WIQL returned, which roughly correlates with recent activity. For
        // analyst use ("which were blocked recently?") the recent items are
        // more interesting than the oldest.
        queryIds = ids.slice(-QUERY_MAX_IDS);
        truncated = true;
    }

    const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.Tags] `
        + `FROM WorkItems `
        + `WHERE [System.TeamProject] = @project `
        + `AND [System.Id] IN (${queryIds.join(",")})`;

    const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName)}/_queries/query/?wiql=${encodeURIComponent(wiql)}`;
    window.open(url, "_blank", "noopener,noreferrer");

    if (truncated) {
        showTransientStatus(
            `Showing the most recent ${QUERY_MAX_IDS} of ${ids.length} items. Narrow the window for fuller coverage.`,
            "info"
        );
    }
}

function onOpenCategoryQuery(category: string): void {
    if (!state || state.mode !== "configured" || !category) return;
    if (state.data.kind !== "ready") return;
    const ids = collectMatchingIds(state.data.histories, category.toLowerCase(), null, null);
    openIdsQuery(ids, category);
}

/**
 * Open a query for ALL items that had any in-window blocker activity.
 * Triggered from the secondary-metrics-line ↗ affordance.
 */
function onOpenAllInWindowQuery(): void {
    if (!state || state.mode !== "configured") return;
    if (state.data.kind !== "ready") return;
    const days = resolveWindowDays(state.teamConfig.selectedWindowDays);
    const { windowStart, windowEnd } = buildRollingWindow(days);
    const ids = collectMatchingIds(state.data.histories, null, windowStart, windowEnd);
    openIdsQuery(ids, "all in-window blockers");
}

/**
 * 📋 Copy this category's in-window blockers to the clipboard as TSV.
 * Throughput-pattern textarea + execCommand('copy') because navigator
 * .clipboard is sometimes blocked in ADO iframes.
 */
async function onCopyCategoryTsv(category: string): Promise<void> {
    if (!state || state.mode !== "configured" || !category) return;
    if (state.data.kind !== "ready") return;

    const days = resolveWindowDays(state.teamConfig.selectedWindowDays);
    const { windowStart, windowEnd } = buildRollingWindow(days);
    const tsv = buildBlockerTsv(state.data.histories, category.toLowerCase(), windowStart, windowEnd, getUrlPrefix());

    if (tsv === "") {
        showTransientStatus(`No blocked periods in ${category}`, "error");
        return;
    }
    if (copyToClipboard(tsv)) {
        showTransientStatus(`Copied ${category} blocked periods to clipboard`);
    } else {
        showTransientStatus("Could not copy to clipboard", "error");
    }
}

/**
 * Copy ALL in-window blockers (across all categories) to the clipboard.
 * Triggered from the secondary-metrics-line ⧉ affordance.
 */
async function onCopyAllInWindowTsv(): Promise<void> {
    if (!state || state.mode !== "configured") return;
    if (state.data.kind !== "ready") return;

    const days = resolveWindowDays(state.teamConfig.selectedWindowDays);
    const { windowStart, windowEnd } = buildRollingWindow(days);
    const tsv = buildBlockerTsv(state.data.histories, null, windowStart, windowEnd, getUrlPrefix());

    if (tsv === "") {
        showTransientStatus("No blocked periods in window to copy", "error");
        return;
    }
    if (copyToClipboard(tsv)) {
        showTransientStatus("Copied all in-window blocked periods to clipboard");
    } else {
        showTransientStatus("Could not copy to clipboard", "error");
    }
}

function getUrlPrefix(): string {
    return buildWorkItemUrlPrefix(SDK.getHost().name, SDK.getWebContext().project?.name ?? "");
}

// TSV builder + ID collector + sanitizers moved to ../../Library/widgetView.ts

function copyToClipboard(text: string): boolean {
    // Use a hidden textarea + execCommand('copy') — works inside ADO iframes
    // where navigator.clipboard is sometimes blocked. Pattern carried from
    // Throughput's TSV export (project_throughput_v1_spec.md).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    // No initializer: both the try and the catch assign, so seeding `false`
    // here is dead (ESLint 9's no-useless-assignment flags it).
    let ok: boolean;
    try {
        ok = document.execCommand("copy");
    } catch {
        ok = false;
    }
    document.body.removeChild(ta);
    return ok;
}

let transientStatusTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Show a brief status message in the footer (e.g., "Copied to clipboard")
 * that auto-clears after a few seconds. Uses the dedicated 'info' status
 * kind so it's distinguishable from 'saving' / 'error' both for testing and
 * visual treatment.
 */
function showTransientStatus(message: string, kind: "info" | "error" = "info"): void {
    if (!state || state.mode !== "configured") return;
    state.status = { kind, message };
    render();
    if (transientStatusTimer) clearTimeout(transientStatusTimer);
    transientStatusTimer = setTimeout(() => {
        if (!state || state.mode !== "configured") return;
        // Only clear if our status is still owned by us (a save-driven status
        // change in the meantime should not be wiped by our timer).
        if (state.status.kind === kind && (state.status.kind === "info" || state.status.kind === "error") && state.status.message === message) {
            state.status = { kind: "idle" };
            render();
        }
    }, 2400);
}

/**
 * ✏ Inline-rename: turn the category name span into an editable input.
 * Enter saves (validates + persists + re-renders); Esc cancels. Gates on
 * canEditCategories. Historical markers keep the OLD name — the rename
 * affects only the curated list, so old-name markers will appear as
 * "deleted-with-history" rows until they age out of the window. For
 * case-only renames, buildCategoryRows' case-insensitive match unifies
 * them automatically.
 */
function onStartRenameCategory(name: string): void {
    if (!state || state.mode !== "configured") return;
    if (!canEditCategories(state)) return;
    if (!name) return;

    const nameSpan = findCategoryNameSpan(name);
    if (!nameSpan) return;

    // Replace the name span's contents with an inline input. Keep the rest
    // of the row intact so the layout doesn't jump.
    const input = document.createElement("input");
    input.type = "text";
    input.className = "bb-cat-rename-input";
    input.value = name;
    input.maxLength = 50;
    input.setAttribute("aria-label", `Rename ${name}`);
    nameSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
        if (!commit) {
            // Rollback by re-rendering — the row reverts to its original name.
            render();
            return;
        }
        const newName = input.value.trim();
        if (newName === name) { render(); return; }
        void commitRename(name, newName);
    };

    input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
}

function findCategoryNameSpan(name: string): HTMLElement | null {
    // Locate the .bb-cat-name span whose nearest .bb-cat-row owns a button
    // with data-category matching the source name. Defensive — if the row
    // isn't on screen (filter changed mid-flight) returns null.
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".bb-cat-action--rename[data-category]"));
    for (const btn of buttons) {
        if (btn.dataset.category === name) {
            const row = btn.closest(".bb-cat-row") as HTMLElement | null;
            const span = row ? (row.querySelector(".bb-cat-name") as HTMLElement | null) : null;
            return span;
        }
    }
    return null;
}

async function commitRename(oldName: string, newName: string): Promise<void> {
    if (!state || state.mode !== "configured") return;
    const validation = validateCategoryName(newName, state.teamConfig.categories.filter(c => c.toLowerCase() !== oldName.toLowerCase()));
    if (!validation.ok) {
        showTransientStatus(validation.error ?? "Invalid category name.", "error");
        return;
    }

    const previous = state.teamConfig;
    const nextCategories = state.teamConfig.categories.map(c => c.toLowerCase() === oldName.toLowerCase() ? newName : c);
    const next: TeamConfig = { ...previous, categories: nextCategories };

    state.teamConfig = next;
    state.status = { kind: "saving" };
    render();
    try {
        await setTeamConfig(state.teamId, next);
        if (!state || state.mode !== "configured") return;
        state.status = { kind: "idle" };
        render();
    } catch (err) {
        console.error("[BlockerBuddy] rename failed:", err);
        if (!state || state.mode !== "configured") return;
        state.teamConfig = previous;
        state.status = {
            kind: "error",
            message: `Could not rename: ${(err as Error)?.message ?? String(err)}`
        };
        render();
    }
}

async function onRemoveCategory(name: string): Promise<void> {
    if (!state || state.mode !== "configured" || !name) return;
    if (!canEditCategories(state)) return;  // defense-in-depth (see onAddCategory)
    const lower = name.toLowerCase();
    const next: TeamConfig = {
        ...state.teamConfig,
        categories: state.teamConfig.categories.filter(c => c.toLowerCase() !== lower)
    };
    await persist(next);
}

async function persist(next: TeamConfig, onSuccess?: () => void): Promise<void> {
    if (!state || state.mode !== "configured") return;
    const previous = state.teamConfig;
    state.teamConfig = next;
    state.status = { kind: "saving" };
    render();
    try {
        await setTeamConfig(state.teamId, next);
        // Re-narrow after the await — state could have transitioned during the I/O round-trip.
        if (!state || state.mode !== "configured") return;
        state.status = { kind: "idle" };
        onSuccess?.();
        render();
    } catch (err) {
        console.error("[BlockerBuddy] persist failed:", err);
        if (!state || state.mode !== "configured") return;
        state.teamConfig = previous;
        state.status = {
            kind: "error",
            message: `Could not save: ${(err as Error)?.message ?? String(err)}`
        };
        render();
    }
}

function showAddError(message: string): void {
    const errEl = document.getElementById("bb-add-error");
    const input = document.getElementById("bb-add-input");
    if (errEl) errEl.textContent = message;
    input?.classList.add("bb-input-error");
}

function clearAddError(): void {
    const errEl = document.getElementById("bb-add-error");
    const input = document.getElementById("bb-add-input");
    if (errEl) errEl.textContent = "";
    input?.classList.remove("bb-input-error");
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function escapeText(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
}
