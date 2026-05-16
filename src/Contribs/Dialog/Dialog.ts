// Blocker Buddy dialog content. Loaded via openCustomDialog from Action.ts.
//
// Renders one of these states based on the work item + team config:
//   - Block flow: item not currently tagged → form with Category + Context
//   - Unblock flow (with marker): item tagged + recent BlockerBuddy block marker
//     → unblock confirmation with original-blocker context + optional resolution
//   - Tagged-but-uncategorized flow: item tagged but no marker → unblock-only,
//     no-marker-write flow (per project_blocker_buddy_design.md)
//   - Empty config: no team categories yet → setup-instructions screen
//     (role-differentiated for admin vs non-admin)
//
// V1 first iteration scope: Block flow fully wired (build marker, post comment,
// add tag, success state). Unblock + tagged-but-uncategorized currently render
// placeholder messages — full implementations follow.

import "./Dialog.scss";
import * as SDK from "azure-devops-extension-sdk";
import {
    getTeamConfig,
    buildBlockMarker,
    buildUnblockMarker,
    parseMarker,
    TeamConfig
} from "../../Library/teamConfig";
import {
    ensureProjectContext,
    getCurrentTeamId,
    getWorkItemTagsAndTitle,
    addWorkItemTag,
    removeWorkItemTag,
    postComment,
    getRecentComments
} from "../../Library/blockerBuddyLibrary";

// ADO's host injects a control object into the configuration alongside our
// own configuration props. The injected object exposes methods for the
// iframe to control the host frame (e.g., close it). The exact shape and
// key name aren't in the public TypeScript types — discovered empirically.
//
// openCustomDialog injects under the key `dialog`. openPanel may inject
// under `panel`. We look for either so the same dialog content code works
// when invoked from either host. (Currently only invoked via openPanel,
// but checking both costs nothing and prevents a regression if the action
// is ever wired to openCustomDialog again.)
interface DialogHostHandle {
    close?: (result?: unknown) => void;
    setTitle?: (title: string) => void;
    updateOkButton?: (enabled: boolean) => void;
}

interface DialogConfig {
    workItemId: number;
    /**
     * Forwarded from Action.ts when the action fired from a work item form
     * with unsaved edits. The dialog short-circuits to renderDirtyFormWarning
     * in that case — no API calls, no state load, just a single-button
     * "save the form first" surface.
     */
    workItemDirty?: boolean;
    dialog?: DialogHostHandle;
    panel?: DialogHostHandle;
}

let dialogHandle: DialogHostHandle | undefined;

interface DialogStage {
    label: string;
    status: "pending" | "running" | "done" | "error";
    /** Set when the stage hits status "error" — surfaces under the stage list. */
    errorMessage?: string;
}

interface DialogStagesView {
    kind: "stages";
    stages: DialogStage[];
    /** Final summary line shown after all stages complete. */
    summary?: string;
    /** True once the last stage has reached "done" or "error" — controls auto-close. */
    finished: boolean;
    /** True when any stage errored — keeps the modal open so the user can read the message. */
    failed: boolean;
}

interface DialogState {
    workItemId: number;
    workItemTitle: string;
    teamId: string;
    config: TeamConfig;
    currentTags: string[];
    isCurrentlyBlocked: boolean;
    hasMarker: boolean;
    /** createdDate captured so the unblock success summary can show duration. */
    latestBlockMarker?: { category?: string; context?: string; createdDate?: Date };
    /** Optional stages overlay — when present, takes over the dialog body during op. */
    view?: DialogStagesView;
}
// Note: admin status is NOT loaded in the dialog — the action modal doesn't
// need it. Admin gating lives on the widget surface (edit affordances on
// categories, tag override + permissions toggle in widget config pane).

let state: DialogState | undefined;

console.log("[BlockerBuddy] Dialog.js loaded");

SDK.init({ loaded: false });

SDK.ready().then(async () => {
    console.log("[BlockerBuddy] Dialog SDK.ready resolved");

    const fullConfig = SDK.getConfiguration();
    console.log("[BlockerBuddy] Dialog full configuration object:", fullConfig);
    console.log("[BlockerBuddy] Dialog configuration keys:", Object.keys(fullConfig ?? {}));

    // Register an instance with methods the parent dialog host can call.
    // Common ADO pattern: parent calls these methods via the contribution ID.
    SDK.register(SDK.getContributionId(), () => ({
        // Called by the host if it wants to retrieve a value when the dialog
        // closes (e.g., via the chrome's OK button — though we don't have one)
        getValue: () => undefined,
        // Called if the host wants to know whether the dialog can be dismissed
        canDismiss: () => true
    }));

    SDK.notifyLoadSucceeded();

    try {
        const config = fullConfig as DialogConfig | undefined;
        if (!config?.workItemId) {
            renderError(new Error("No work item ID was passed to the dialog."));
            return;
        }
        // Capture the host-injected handle for closing from inside. Prefer
        // panel (current invocation path) but fall back to dialog (legacy
        // openCustomDialog path).
        dialogHandle = config.panel ?? config.dialog;
        if (!dialogHandle?.close) {
            console.warn("[BlockerBuddy] No panel/dialog close handle in configuration; close-from-iframe will fall back to dim-only.");
        }

        // Dirty-form short-circuit: if the action fired from a work item
        // form with unsaved edits, render the warning and stop. No state
        // load, no API calls — the user needs to save and re-invoke before
        // any meaningful BB work can happen anyway.
        if (config.workItemDirty === true) {
            renderDirtyFormWarning();
            setupAutoResize();
            return;
        }

        await loadState(config.workItemId);
        render();
        setupAutoResize();
    } catch (err) {
        console.error("[BlockerBuddy] dialog state load failed:", err);
        renderError(err);
    }
}).catch((err: unknown) => {
    console.error("[BlockerBuddy] Dialog SDK.ready() rejected:", err);
    renderError(err);
});

/**
 * Tells ADO to size the dialog iframe to fit the content, which makes the
 * modal chrome grow with it. The custom-dialog host (openCustomDialog) honors
 * SDK.resize and reflows the chrome to match — so without this, the iframe
 * stays at host default size and content overflows with a vertical scrollbar.
 *
 * The ResizeObserver re-fires on every render() because state transitions
 * rewrite #root's content (block → success on submit, etc.), and we want the
 * modal to fit the new content rather than stay at the previous flow's size.
 *
 * Width 360px matches our centered-card max-width exactly — no extra empty
 * bands inside the iframe (the dialog chrome already pads around the iframe;
 * that's the only modal-margin we need). Wider values cause horizontal scroll
 * on the chrome when the iframe exceeds the chrome's content area.
 * Height tracks content + 24px buffer for the card's top margin to feel
 * intentional rather than pinned.
 *
 * NB: SDK.resize behaves differently per host. openCustomDialog reflows
 * chrome around the iframe (this is what we want); openPanel resizes the
 * iframe but leaves the chrome at PanelSize, which causes overflow on the
 * chrome. If the action ever switches back to openPanel, this needs to go.
 */
function setupAutoResize(): void {
    const root = document.getElementById("root");
    if (!root) return;
    const updateSize = () => SDK.resize(360, root.offsetHeight + 24);
    new ResizeObserver(updateSize).observe(root);
    updateSize();
}

// ─── State loading ────────────────────────────────────────────────────────

async function loadState(workItemId: number): Promise<void> {
    await ensureProjectContext();
    const teamId = await getCurrentTeamId();
    const config = await getTeamConfig(teamId);

    // Always fetch tags + title — even with zero categories configured, an
    // already-tagged item must be unblockable (otherwise resetting categories
    // or installing BB after manual tagging would strand the item). The
    // empty-config welcome screen is reserved for "trying to block a fresh
    // item without categories" — see render() for the prioritization.
    const { tags: currentTags, title: workItemTitle } = await getWorkItemTagsAndTitle(workItemId);
    const tagLower = config.tagName.toLowerCase();
    const isCurrentlyBlocked = currentTags.some(t => t.toLowerCase() === tagLower);

    let hasMarker = false;
    let latestBlockMarker: { category?: string; context?: string; createdDate?: Date } | undefined;

    if (isCurrentlyBlocked) {
        // Look at recent comments for the latest BlockerBuddy block marker.
        // If we hit an Unblocked marker first, the active block isn't tracked.
        const comments = await getRecentComments(workItemId, 50);
        for (const c of comments) {
            const parsed = parseMarker(c.text);
            if (!parsed) continue;
            if (parsed.event === "Unblocked") break;
            if (parsed.event === "Blocked") {
                hasMarker = true;
                latestBlockMarker = {
                    category: parsed.category,
                    context: parsed.context,
                    createdDate: c.createdDate
                };
                break;
            }
        }
    }

    state = {
        workItemId,
        workItemTitle,
        teamId,
        config,
        currentTags,
        isCurrentlyBlocked,
        hasMarker,
        latestBlockMarker
    };
}

// ─── Rendering ────────────────────────────────────────────────────────────

const STAGE_DWELL_MIN_MS = 350;       // each stage runs at least this long before the next ticks (perceptible progression)
const FINAL_STATE_HOLD_MS = 1000;     // time the final ✓/summary or ✗/error stays visible before auto-close (success only)

function render(): void {
    if (!state) return;

    // If the dialog is currently mid-operation, the stages view takes over
    // the body. This swap happens IN-PLACE within the same modal — no
    // open/close flicker, just a content transition. Stages append top-down
    // as each completes; once finished, a brief hold then auto-close.
    if (state.view?.kind === "stages") {
        renderStagesView(state.view);
        return;
    }


    // Currently-tagged items take priority over the empty-config check —
    // otherwise resetting categories (or installing BB after items were
    // manually tagged) would strand them with no way to unblock through
    // the dialog. Tagged with marker → unblock flow; tagged without marker
    // → tagged-but-uncategorized (remove tag without writing a marker).
    if (state.isCurrentlyBlocked) {
        if (state.hasMarker) {
            renderUnblockState();
        } else {
            renderTaggedButUncategorizedState();
        }
        return;
    }

    // Not currently tagged. If the team has no categories curated yet,
    // there's nothing to block AS — show the welcome/setup message. This
    // is the only path that ever reaches renderEmptyConfigState now.
    if (state.config.categories.length === 0) {
        renderEmptyConfigState();
        return;
    }

    // Default: not tagged, has categories → block flow.
    renderBlockState();
}

function renderBlockState(): void {
    if (!state) return;
    const root = el("root");
    if (!root) return;

    // Button list — one button per category. Click any button to instant-block
    // with that category. No "Other"/free-text option (per "make it super simple"
    // — the team's curated category vocabulary IS the controlled choice).
    const categoryButtons = state.config.categories.map(cat => `
        <button class="bb-btn-category" data-category="${escapeAttr(cat)}" type="button">${escapeText(cat)}</button>
    `).join("");

    root.innerHTML = `
        <div class="bb-dialog">
            <p class="bb-item-ref"><span class="bb-item-ref-id">#${state.workItemId}</span><span class="bb-item-ref-title">${escapeText(state.workItemTitle)}</span></p>
            <p class="bb-prompt">Block as:</p>
            <div class="bb-category-buttons">${categoryButtons}</div>
            <div id="bb-error" class="bb-error"></div>
            <div class="bb-actions">
                <button id="bb-cancel" class="bb-btn bb-btn-secondary" type="button">Cancel</button>
            </div>
        </div>
    `;

    el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
    document.querySelectorAll<HTMLButtonElement>(".bb-btn-category[data-category]").forEach(btn => {
        btn.addEventListener("click", () => handleBlockSubmit(btn.dataset.category ?? ""));
    });
}

async function handleBlockSubmit(category: string): Promise<void> {
    if (!state || !category) return;
    const tagName = state.config.tagName;
    const workItemId = state.workItemId;
    const marker = buildBlockMarker(category);

    // Order: post comment first, then add tag. If comment fails, we haven't
    // changed the work item state. If tag-add fails after the comment, the
    // marker exists but the tag doesn't — surface that distinction in the
    // failure summary so the user can choose to add the tag manually.
    await runStages(
        [
            { label: "Recording reason and time", run: () => postComment(workItemId, marker).then(() => undefined) },
            { label: `Tagging item ${tagName}`, run: () => addWorkItemTag(workItemId, tagName).then(() => undefined) }
        ],
        (failedAt, errorMessage) => {
            if (failedAt === null) return `Blocked. Reason saved to discussion.`;
            if (failedAt === 0) return `Couldn't record the reason: ${errorMessage}. Nothing was changed.`;
            // failedAt === 1: comment posted but tag failed. The marker exists
            // in history but the tag doesn't, so the next right-click would
            // see "not blocked" and create a second marker. User SHOULD add
            // the tag manually to get the system back in sync — not optional.
            return `Reason saved, but couldn't add the "${tagName}" tag: ${errorMessage}. You should add the tag manually.`;
        }
    );
}

function renderUnblockState(): void {
    if (!state) return;
    const root = el("root");
    if (!root) return;
    const orig = state.latestBlockMarker;
    const origText = orig?.category
        ? `${orig.category}${orig.context ? ` — ${orig.context}` : ""}`
        : "(unrecorded)";
    // Pre-click duration: answers "how long has this been blocked" without
    // committing to unblock. Common usage pattern is "check duration, then
    // Cancel." Hidden when the marker date wasn't captured (defensive — the
    // marker exists since hasMarker is true to reach this state, but its
    // createdDate could theoretically be missing from the comments API).
    const blockStart = orig?.createdDate;
    const durationSubLine = blockStart
        ? `<br><small class="bb-blocked-since">Blocked for ${formatBlockDuration(blockStart)} so far</small>`
        : "";

    // Single Unblock button — no resolution text input (per "make it super
    // simple"). The block marker already records the original category, which
    // is all the unblock event needs to pair structurally with the block.
    root.innerHTML = `
        <div class="bb-dialog">
            <p class="bb-item-ref"><span class="bb-item-ref-id">#${state.workItemId}</span><span class="bb-item-ref-title">${escapeText(state.workItemTitle)}</span></p>
            <p>Currently blocked: <em>${escapeText(origText)}</em>${durationSubLine}</p>
            <div id="bb-error" class="bb-error"></div>
            <div class="bb-actions">
                <button id="bb-cancel" class="bb-btn bb-btn-secondary" type="button">Cancel</button>
                <button id="bb-submit" class="bb-btn bb-btn-primary" type="button">Unblock</button>
            </div>
        </div>
    `;

    el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
    el<HTMLButtonElement>("bb-submit")?.addEventListener("click", () => handleUnblockSubmit());
}

async function handleUnblockSubmit(): Promise<void> {
    if (!state) return;
    const tagName = state.config.tagName;
    const workItemId = state.workItemId;
    const orig = state.latestBlockMarker;
    const marker = buildUnblockMarker(orig?.category, orig?.context);
    const blockStart = orig?.createdDate;

    await runStages(
        [
            { label: "Recording unblock time", run: () => postComment(workItemId, marker).then(() => undefined) },
            { label: `Removing ${tagName} tag`, run: () => removeWorkItemTag(workItemId, tagName).then(() => undefined) }
        ],
        (failedAt, errorMessage) => {
            if (failedAt === null) {
                // Educational duration line: shows the user the impact of the
                // block period they just closed. Falls back to a generic line
                // if the marker date wasn't captured (defensive).
                if (blockStart) return `Unblocked after ${formatBlockDuration(blockStart)}.`;
                return "Unblocked.";
            }
            if (failedAt === 0) return `Couldn't record unblock time: ${errorMessage}. Nothing was changed.`;
            // Unblock marker posted but tag-remove failed. The tag is now
            // orphaned — next right-click would see tagged-with-most-recent-
            // marker-being-Unblocked and surface the wrong "tag wasn't added
            // by Blocker Buddy" path. User SHOULD remove the tag manually.
            return `Unblock recorded, but couldn't remove the "${tagName}" tag: ${errorMessage}. You should remove the tag manually.`;
        }
    );
}

function renderTaggedButUncategorizedState(): void {
    if (!state) return;
    const root = el("root");
    if (!root) return;

    root.innerHTML = `
        <div class="bb-dialog">
            <p class="bb-item-ref"><span class="bb-item-ref-id">#${state.workItemId}</span><span class="bb-item-ref-title">${escapeText(state.workItemTitle)}</span></p>
            <p>This "${escapeText(state.config.tagName)}" tag either wasn't added by Blocker Buddy or its comment was edited after Blocker Buddy created it, so there's no readable record of why or when. The widget shows it under "Not timed or categorized." Click Remove tag to clear it.</p>
            <div id="bb-error" class="bb-error"></div>
            <div class="bb-actions">
                <button id="bb-cancel" class="bb-btn bb-btn-secondary" type="button">Cancel</button>
                <button id="bb-submit" class="bb-btn bb-btn-primary" type="button">Remove tag</button>
            </div>
        </div>
    `;

    el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
    el<HTMLButtonElement>("bb-submit")?.addEventListener("click", () => handleRemoveTagOnly());
}

async function handleRemoveTagOnly(): Promise<void> {
    if (!state) return;
    const tagName = state.config.tagName;
    const workItemId = state.workItemId;

    await runStages(
        [
            { label: `Removing ${tagName} tag`, run: () => removeWorkItemTag(workItemId, tagName).then(() => undefined) }
        ],
        (failedAt, errorMessage) => {
            if (failedAt === null) return "Tag removed. No timing was recorded.";
            return `Couldn't remove the "${tagName}" tag: ${errorMessage}.`;
        }
    );
}

function renderEmptyConfigState(): void {
    if (!state) return;
    const root = el("root");
    if (!root) return;

    // Single unified message regardless of admin status — works for both
    // audiences: admins understand they need to do it; non-admins know who
    // to ask. Drops a complexity layer (admin detection no longer affects
    // this surface).
    root.innerHTML = `
        <div class="bb-dialog">
            <p>Blocker Buddy isn't set up for your team yet.</p>
            <p>Ask a team admin or project admin to add the Blocker Buddy widget to your team's dashboard and configure your team's blocker categories.</p>
            <div class="bb-actions">
                <button id="bb-cancel" class="bb-btn bb-btn-primary" type="button">Got it</button>
            </div>
        </div>
    `;
    el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
}

// Rendered when the action fired from a work item form with unsaved edits.
// Replaces the older window.confirm() approach (which had host-supplied
// "An embedded page at … says" chrome and a poorly-mapping OK/Cancel
// pairing). Cancel-only by design — proceed-anyway was a footgun since
// we can't tell which fields are dirty (any tag edit conflicts; saving
// after BB would fail with TF26071 "changed by someone else").
function renderDirtyFormWarning(): void {
    const root = el("root");
    if (!root) return;
    root.innerHTML = `
        <div class="bb-dialog">
            <p><strong>This work item has unsaved changes.</strong></p>
            <p>Save the form first, then open Blocker Buddy again. (Otherwise saving the form afterward could conflict with Blocker Buddy's tag write — ADO's TF26071 "changed by someone else.")</p>
            <div class="bb-actions">
                <button id="bb-cancel" class="bb-btn bb-btn-primary" type="button">Got it</button>
            </div>
        </div>
    `;
    el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
}

// Briefly show the confirmation, then close ourselves. The user just clicked
// the primary action — they don't need to also click "Done" or hunt for an X.
// On the rare case the host close handle isn't available, closeDialog falls
// back to dimming, and the success message stays visible.
const SUCCESS_AUTOCLOSE_MS = 1500;

function renderSuccess(msg: string): void {
    const root = el("root");
    if (!root) return;
    root.innerHTML = `
        <div class="bb-dialog">
            <p class="bb-success">${escapeText(msg)}</p>
        </div>
    `;
    setTimeout(() => closeDialog(), SUCCESS_AUTOCLOSE_MS);
}

// ─── Stages view (in-modal progress) ────────────────────────────────────
//
// Renders during a block / unblock / remove-tag operation. Educational:
// each stage names the actual operation BB is performing (writing a
// comment, setting/removing a tag) so the user learns the data model.
// Minimalist visual — single column, icon + label per stage, summary
// line at the bottom once all stages complete.

function renderStagesView(view: DialogStagesView): void {
    if (!state) return;
    const root = el("root");
    if (!root) return;

    const stagesHtml = view.stages.map(s => {
        const iconClass = `bb-stage-icon bb-stage-icon--${s.status}`;
        const labelClass = `bb-stage-label bb-stage-label--${s.status}`;
        return `
            <li class="bb-stage">
                <span class="${iconClass}" aria-hidden="true"></span>
                <span class="${labelClass}">${escapeText(s.label)}</span>
            </li>
        `;
    }).join("");

    const summaryHtml = view.summary
        ? `<p class="bb-stage-summary ${view.failed ? "bb-stage-summary--error" : ""}">${escapeText(view.summary)}</p>`
        : "";

    root.innerHTML = `
        <div class="bb-dialog">
            <p class="bb-item-ref"><span class="bb-item-ref-id">#${state.workItemId}</span><span class="bb-item-ref-title">${escapeText(state.workItemTitle)}</span></p>
            <ul class="bb-stages">${stagesHtml}</ul>
            ${summaryHtml}
            ${view.failed ? `
                <div class="bb-actions">
                    <button id="bb-cancel" class="bb-btn bb-btn-secondary" type="button">Close</button>
                </div>
            ` : ""}
        </div>
    `;

    if (view.failed) {
        el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
    }
}

interface StageOp {
    label: string;
    /** Async operation. Returns when complete; throws on failure. */
    run: () => Promise<void>;
}

/**
 * Orchestrate a sequence of stages with the educational tick-through visual.
 * - Each stage runs for at least STAGE_DWELL_MIN_MS before the next ticks
 *   (perceptible progression even when ops are fast).
 * - On error: marks the failing stage as error, fills in errorMessage,
 *   keeps the modal open with a Close button + helper guidance.
 * - On success: shows the summary + holds FINAL_STATE_HOLD_MS, then closes.
 *
 * The summary closure is invoked AFTER all stages complete and receives
 * `null` (success) or the error message (failure) so the caller can shape
 * a flow-specific summary (e.g., unblock duration, partial-failure helper).
 */
async function runStages(
    ops: StageOp[],
    summarize: (failedAt: number | null, errorMessage: string | null) => string
): Promise<void> {
    if (!state) return;

    // Initialize the view with all stages pending.
    state.view = {
        kind: "stages",
        stages: ops.map(o => ({ label: o.label, status: "pending" as const })),
        finished: false,
        failed: false
    };
    render();

    for (let i = 0; i < ops.length; i++) {
        if (!state || !state.view) return;
        // Tick the current stage to "running" before launching the async op.
        state.view.stages[i].status = "running";
        render();

        const startedAt = Date.now();
        try {
            await ops[i].run();
        } catch (err) {
            const errorMessage = (err as Error)?.message ?? String(err);
            console.error(`[BlockerBuddy] stage "${ops[i].label}" failed:`, err);
            if (!state || !state.view) return;
            state.view.stages[i].status = "error";
            state.view.stages[i].errorMessage = errorMessage;
            state.view.failed = true;
            state.view.finished = true;
            state.view.summary = summarize(i, errorMessage);
            render();
            return;  // do NOT auto-close on failure — let user read the message
        }

        // Hold the "running" tick at least STAGE_DWELL_MIN_MS so progression
        // is perceptible even when the underlying op was instant.
        const elapsed = Date.now() - startedAt;
        if (elapsed < STAGE_DWELL_MIN_MS) {
            await new Promise(r => setTimeout(r, STAGE_DWELL_MIN_MS - elapsed));
        }

        if (!state || !state.view) return;
        state.view.stages[i].status = "done";
        render();
    }

    // All stages succeeded.
    if (!state || !state.view) return;
    state.view.finished = true;
    state.view.summary = summarize(null, null);
    render();

    setTimeout(() => closeDialog(), FINAL_STATE_HOLD_MS);
}

/** Format the duration since a block marker timestamp into human prose. */
function formatBlockDuration(blockStart: Date, now: Date = new Date()): string {
    const ms = now.getTime() - blockStart.getTime();
    const minutes = ms / (60 * 1000);
    const hours = minutes / 60;
    const days = hours / 24;
    if (minutes < 60) {
        const m = Math.max(1, Math.round(minutes));
        return `${m} minute${m === 1 ? "" : "s"}`;
    }
    if (hours < 24) {
        const h = hours.toFixed(1);
        return `${h} hour${h === "1.0" ? "" : "s"}`;
    }
    const d = days.toFixed(1);
    return `${d} day${d === "1.0" ? "" : "s"}`;
}

function renderError(err: unknown): void {
    const root = el("root");
    if (!root) return;
    const msg = (err as Error)?.message ?? String(err);
    root.innerHTML = `
        <div class="bb-dialog">
            <p class="bb-error">Something went wrong: ${escapeText(msg)}</p>
            <div class="bb-actions">
                <button id="bb-cancel" class="bb-btn bb-btn-secondary" type="button">Close</button>
            </div>
        </div>
    `;
    el<HTMLButtonElement>("bb-cancel")?.addEventListener("click", () => closeDialog());
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

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

/**
 * Close the dialog from inside the iframe. Uses the host-injected `dialog`
 * object that ADO adds to the configuration object passed via openCustomDialog.
 * Falls back to dim-only if the handle isn't present (defensive — shouldn't
 * normally happen).
 */
function closeDialog(result?: unknown): void {
    if (dialogHandle?.close) {
        dialogHandle.close(result);
        return;
    }
    console.warn("[BlockerBuddy] closeDialog requested but no host close handle available; falling back to dim-only");
    const root = el("root");
    if (root) {
        root.style.opacity = "0.5";
    }
}
