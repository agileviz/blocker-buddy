// Blocker Buddy widget configuration pane.
//
// ADO's permission model gates dashboard widget editing to team-admin level
// at minimum, so anyone seeing this pane is already an admin — no in-pane
// admin check needed. All fields are unconditionally editable.
//
// Surfaces:
//   - Team selector: override the dashboard team context. Per-widget-instance,
//     stored in customSettings.teamId.
//   - Tag override: the work-item tag Blocker Buddy adds. Per-team, stored
//     in ExtensionDataService.
//   - Allow-member-edit toggle: gates whether non-admins can edit categories
//     on the widget body. Per-team, stored in ExtensionDataService.
//   - AgileViz pitch callout + support link.
//
// Save semantics: ADO calls onSave() when the user clicks the dashboard's
// Save button. We persist team-level config to ExtensionDataService and
// return per-widget customSettings (just teamId).

import "./Config.scss";
import * as SDK from "azure-devops-extension-sdk";
import {
    WidgetStatusHelper,
    WidgetConfigurationSave
} from "azure-devops-extension-api/Dashboard/WidgetHelpers";
import { ConfigurationEvent } from "azure-devops-extension-api/Dashboard/WidgetConfigHelpers";
import {
    getTeamConfig,
    setTeamConfig,
    validateTagName,
    TeamConfig
} from "../../Library/teamConfig";
import {
    ensureProjectContext,
    getCurrentTeamId,
    getProjectTeams
} from "../../Library/blockerBuddyLibrary";

interface WidgetCustomSettings {
    teamId?: string;
}

interface WidgetSettings {
    customSettings?: { data?: string };
    name?: string;
    size?: { rowSpan: number; columnSpan: number };
}

interface WidgetConfigurationContext {
    notify(eventName: string, eventArgs: unknown): Promise<unknown>;
}

interface ConfigState {
    selectedTeamId: string;
    teams: Array<{ id: string; name: string }>;
    teamConfig: TeamConfig;
    /** Snapshot at load time; used to detect changes that need writing back. */
    initialTeamConfig: TeamConfig;
    notifyDirty: () => void;
}

let state: ConfigState | undefined;

// Standard "opens in new tab" icon. Same SVG path used in Throughput's pitch
// callout — keeps the visual convention consistent across plugins.
const ICON_EXTERNAL = `<svg class="agv-icon-external" aria-hidden="true" viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M10 1h5v5h-1V2.7L7.4 9.3l-.7-.7L13.3 2H10V1zM2 3v11h11V8h1v7H1V2h7v1H2z"/></svg>`;

console.log("[BlockerBuddy] Config.js loaded");

SDK.init({ loaded: false });

SDK.ready().then(() => {
    SDK.register("blocker-buddy-configuration", () => ({
        async load(widgetSettings: WidgetSettings, widgetConfigurationContext: WidgetConfigurationContext) {
            try {
                await initializeConfig(widgetSettings, widgetConfigurationContext);
                return WidgetStatusHelper.Success();
            } catch (err) {
                console.error("[BlockerBuddy] Config load failed:", err);
                renderError(err);
                const msg = (err as Error)?.message ?? String(err);
                return WidgetStatusHelper.Failure(msg);
            }
        },
        async onSave() {
            return await handleSave();
        }
    }));
    SDK.notifyLoadSucceeded();
}).catch((err: unknown) => {
    console.error("[BlockerBuddy] Config SDK.ready() rejected:", err);
    renderError(err);
});

// ─── Initialization ───────────────────────────────────────────────────────

async function initializeConfig(
    widgetSettings: WidgetSettings,
    widgetConfigurationContext: WidgetConfigurationContext
): Promise<void> {
    await ensureProjectContext();

    const customSettings = parseCustomSettings(widgetSettings.customSettings?.data);
    const dashboardTeamId = await getCurrentTeamId();
    const selectedTeamId = customSettings.teamId ?? dashboardTeamId;

    const [teams, teamConfig] = await Promise.all([
        getProjectTeams(),
        getTeamConfig(selectedTeamId)
    ]);

    state = {
        selectedTeamId,
        teams,
        teamConfig: { ...teamConfig },
        initialTeamConfig: { ...teamConfig },
        notifyDirty: () => {
            widgetConfigurationContext.notify(
                ConfigurationEvent.ConfigurationChange,
                ConfigurationEvent.Args({ data: serializeCustomSettings({ teamId: state?.selectedTeamId }) })
            );
        }
    };

    render();
    setupAutoResize();
}

/**
 * Tells ADO the iframe height to use, sized to actual content. Without this
 * the iframe defaults to a tiny fixed height and our content scrolls. We
 * observe #root (not body — body is pinned to 100% viewport by
 * azure-devops-ui's _widgetsCommon override; #root auto-sizes to children).
 *
 * 500px minimum gives native <select> pickers room to open downward without
 * being clipped by the iframe edge. 16px padding gives the bottom of the
 * pitch link some breathing room.
 *
 * Pattern copied from plugin/throughput/src/Contribs/Config/Config.tsx.
 */
function setupAutoResize(): void {
    const root = document.getElementById("root");
    if (!root) return;
    const updateSize = () => SDK.resize(400, Math.max(root.offsetHeight + 16, 500));
    new ResizeObserver(updateSize).observe(root);
    updateSize();
}

function parseCustomSettings(data?: string): WidgetCustomSettings {
    if (!data) return {};
    try {
        return JSON.parse(data) as WidgetCustomSettings;
    } catch {
        return {};
    }
}

function serializeCustomSettings(s: WidgetCustomSettings): string {
    return JSON.stringify(s);
}

// ─── Save ─────────────────────────────────────────────────────────────────

async function handleSave() {
    if (!state) {
        return WidgetConfigurationSave.Invalid();
    }

    // Validate tag name before persisting.
    const tagValidation = validateTagName(state.teamConfig.tagName);
    if (!tagValidation.ok) {
        // Surface inline error and refuse the save so user can fix.
        const errorEl = el<HTMLDivElement>("bb-tag-error");
        if (errorEl) {
            errorEl.style.display = "block";
            errorEl.textContent = tagValidation.error ?? "Invalid tag name.";
        }
        return WidgetConfigurationSave.Invalid();
    }

    // Persist team-level config IFF something changed.
    const teamFieldsChanged =
        state.teamConfig.tagName !== state.initialTeamConfig.tagName ||
        state.teamConfig.allowMemberEdit !== state.initialTeamConfig.allowMemberEdit;
    if (teamFieldsChanged) {
        try {
            await setTeamConfig(state.selectedTeamId, state.teamConfig);
        } catch (err) {
            console.error("[BlockerBuddy] failed to save team config:", err);
            // Continue with widget customSettings save anyway — team config
            // failure shouldn't block widget save.
        }
    }

    return WidgetConfigurationSave.Valid({
        data: serializeCustomSettings({ teamId: state.selectedTeamId })
    });
}

// ─── Rendering ────────────────────────────────────────────────────────────

function render(): void {
    if (!state) return;
    const root = el("root");
    if (!root) return;

    const teamOptions = state.teams
        .map(t => `<option value="${escapeAttr(t.id)}"${t.id === state!.selectedTeamId ? " selected" : ""}>${escapeText(t.name)}</option>`)
        .join("");

    root.innerHTML = `
        <div class="bb-config">
            <div class="bb-field-wrapper">
                <label class="bb-label" for="bb-team">Team</label>
                <select id="bb-team" class="bb-select">${teamOptions}</select>
            </div>

            <div class="bb-field-wrapper">
                <label class="bb-label" for="bb-tag">Blocker tag</label>
                <input
                    id="bb-tag"
                    type="text"
                    class="bb-input"
                    maxlength="50"
                    value="${escapeAttr(state.teamConfig.tagName)}"
                />
                <div id="bb-tag-error" class="bb-error" style="display: none"></div>
            </div>

            <div class="bb-checkbox-row">
                <input
                    id="bb-allow-member-edit"
                    type="checkbox"
                    ${state.teamConfig.allowMemberEdit ? "checked" : ""}
                />
                <label for="bb-allow-member-edit">Allow team members to edit categories</label>
            </div>

            <div class="agv-pitch">
                <p class="agv-pitch-headline">
                    <strong>Blocker Buddy captures the why.</strong><br>
                    <strong>AgileViz shows how to spend less time blocked.</strong>
                </p>
                <p class="agv-pitch-body">See where time gets lost in your flow, forecast completion dates, spot anomalies, and get AI-assisted coaching.</p>
                <p class="agv-pitch-link-primary"><a href="https://agileviz.com/" target="_blank" rel="noopener" class="agv-link">Where does your team's time go?${ICON_EXTERNAL}</a></p>
                <p class="agv-pitch-link-support"><a href="https://agileviz.com/plugins/blocker-buddy/" target="_blank" rel="noopener" class="agv-link">Learn how Blocker Buddy works or get support${ICON_EXTERNAL}</a></p>
            </div>
        </div>
    `;

    const teamSelect = el<HTMLSelectElement>("bb-team");
    const tagInput = el<HTMLInputElement>("bb-tag");
    const allowMemberEditCheckbox = el<HTMLInputElement>("bb-allow-member-edit");

    teamSelect?.addEventListener("change", () => onTeamChange(teamSelect.value));
    tagInput?.addEventListener("input", () => onTagChange(tagInput.value));
    allowMemberEditCheckbox?.addEventListener("change", () => onAllowMemberEditChange(allowMemberEditCheckbox.checked));
}

async function onTeamChange(newTeamId: string): Promise<void> {
    if (!state || newTeamId === state.selectedTeamId) return;
    state.selectedTeamId = newTeamId;
    try {
        const teamConfig = await getTeamConfig(newTeamId);
        state.teamConfig = { ...teamConfig };
        state.initialTeamConfig = { ...teamConfig };
        render();
        state.notifyDirty();
    } catch (err) {
        console.error("[BlockerBuddy] team change refetch failed:", err);
    }
}

function onTagChange(newTag: string): void {
    if (!state) return;
    state.teamConfig.tagName = newTag;
    const validation = validateTagName(newTag);
    const tagInput = el<HTMLInputElement>("bb-tag");
    const errorEl = el<HTMLDivElement>("bb-tag-error");
    if (tagInput) {
        tagInput.classList.toggle("bb-input-error", !validation.ok);
    }
    if (errorEl) {
        if (validation.ok) {
            errorEl.style.display = "none";
            errorEl.textContent = "";
        } else {
            errorEl.style.display = "block";
            errorEl.textContent = validation.error ?? "Invalid tag name.";
        }
    }
    state.notifyDirty();
}

function onAllowMemberEditChange(newValue: boolean): void {
    if (!state) return;
    state.teamConfig.allowMemberEdit = newValue;
    state.notifyDirty();
}

function renderError(err: unknown): void {
    const root = el("root");
    if (!root) return;
    const msg = (err as Error)?.message ?? String(err);
    root.innerHTML = `
        <div class="bb-config">
            <p class="bb-error" style="display: block">Failed to load Blocker Buddy configuration: ${escapeText(msg)}</p>
        </div>
    `;
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
