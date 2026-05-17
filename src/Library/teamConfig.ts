// Team config schema, persistence (via ExtensionDataService), and the pure
// marker / sanitization / validation helpers used by both contributions.
//
// The pure helpers (sanitizeReasonText, validateTagName, build*Marker,
// parseMarker) have no SDK dependency and are unit-tested. The SDK-dependent
// helpers (getTeamConfig, setTeamConfig) are integration-tested via dev install.

import * as SDK from "azure-devops-extension-sdk";
import { CommonServiceIds, IExtensionDataService } from "azure-devops-extension-api";

// ─── Schema ───────────────────────────────────────────────────────────────

export interface TeamConfig {
    tagName: string;
    categories: string[];
    allowMemberEdit: boolean;
    /**
     * Number of days for the rolling analysis window. ALL_TIME_DAYS (1825,
     * 5 years) is the "All time" option — effectively unbounded for any
     * reasonable team's blocker history. Defaults to 14 (one 2-week sprint)
     * so the widget answers the typical retro question on first install.
     * Persisted at the team level so all team members see the same view by
     * default; can be changed from the widget body's top-right selector.
     */
    selectedWindowDays?: number;
}

/**
 * Sentinel value for the "All time" window option. 1825 = 5 years, which
 * exceeds any realistic team blocker history while keeping the type
 * consistent across the data flow (no separate "all" string variant to
 * special-case).
 */
export const ALL_TIME_DAYS = 1825;

// Default window: 14 days = one 2-week sprint, the most common cadence in
// agile orgs. Sprint-aligned default frames the widget's answer to "what
// blocked us this sprint?" on first install. 30 stays in the dropdown for
// teams that retro on a monthly cadence.
export const DEFAULT_WINDOW_DAYS = 14;

export interface WindowOption {
    days: number;
    label: string;
}

export const WINDOW_OPTIONS: ReadonlyArray<WindowOption> = [
    { days: 14, label: "Last 14 days" },
    { days: 30, label: "Last 30 days" },
    { days: 60, label: "Last 60 days" },
    { days: 90, label: "Last 90 days" },
    { days: 120, label: "Last 120 days" },
    { days: ALL_TIME_DAYS, label: "All time" }
];

/**
 * Resolve a stored selectedWindowDays value to a usable number. Snaps to a
 * known WINDOW_OPTIONS entry — if a stored value doesn't match any known
 * option (e.g., schema evolution or hand-edited config), falls back to
 * default. Keeps the selector + data fetcher consistent.
 */
export function resolveWindowDays(stored: number | undefined): number {
    if (stored === undefined) return DEFAULT_WINDOW_DAYS;
    const match = WINDOW_OPTIONS.find(o => o.days === stored);
    return match ? match.days : DEFAULT_WINDOW_DAYS;
}

export function formatWindowLabel(days: number): string {
    if (days === ALL_TIME_DAYS) return "All time";
    return `Last ${days} days`;
}

export const DEFAULT_CONFIG: TeamConfig = {
    tagName: "Blocked",
    categories: [],
    allowMemberEdit: false,
    selectedWindowDays: DEFAULT_WINDOW_DAYS
};

// Suggested starter categories shown as click-to-add buttons when categories
// list is empty. Six categories balanced across decision-shaped, external-
// shaped, and resource-shaped blockers — covers ~85% of typical software-
// team blocker patterns. Three categories share the "decision" shape
// (Product, Technical, Stakeholder) — surfaces the decision-as-gate pattern
// cleanly and reads as parallel options. The rare "customer feedback" case
// folds into External dependency for teams who need it. Locked v7
// (2026-05-01) after iteration; see project_blocker_buddy_design.md for
// the full design conversation.
//
// ⚠ MAINTENANCE: this list is the source of truth, but several other places
// hand-reference the category names. When you change STARTER_CATEGORIES,
// also update:
//   1. src/Library/__tests__/teamConfig.test.ts — the locked-v# test that
//      asserts exact contents (search for "contains the locked v")
//   2. site/content/plugins/blocker-buddy/index.md — the "On first install"
//      paragraph listing the categories (search for "starter set")
//   3. site/content/plugins/blocker-buddy/index.md — the alt text on the
//      block-dialog screenshot (search for "blocker-buddy-block-dialog.png")
//   4. The block-dialog screenshot itself (re-capture from dev install so
//      the visible buttons match this list)
//   5. project_blocker_buddy_design.md (in user memory) — the "Suggested
//      starter set" section
//   6. tools/bb-seeder/seed.config.example.json — the "categories" array and
//      the "_categoriesNote" version reference (must match this list, or
//      seeded markers won't roll up under the widget's curated rows)
// Also bump the version number in the comment above ("Locked v7" → "v8") and
// in the test name ("locked v7 starter set" → "v8") so reviewers see a
// changed-list at a glance.
export const STARTER_CATEGORIES: readonly string[] = [
    "Product decision",         // what to build, scope, priority, business rules
    "Technical decision",       // how to build it, architecture, library choice
    "External dependency",      // another team or vendor's work; also "customer-side" cases
    "Stakeholder decision",     // PM, leadership, business partner choosing direction
    "Review or approval",       // marketing, legal, compliance, security, privacy, etc.
    "Tooling or environment"    // access, permissions, test envs, build infra
];

const COLLECTION = "BlockerBuddyConfig";

function configKey(teamId: string): string {
    return `team-${teamId}-config`;
}

// ─── ExtensionDataService access ──────────────────────────────────────────

async function getDataManager() {
    const dataSvc = await SDK.getService<IExtensionDataService>(
        CommonServiceIds.ExtensionDataService
    );
    const accessToken = await SDK.getAccessToken();
    const ctx = SDK.getExtensionContext();
    return dataSvc.getExtensionDataManager(
        `${ctx.publisherId}.${ctx.extensionId}`,
        accessToken
    );
}

/**
 * Read the team's config blob. Falls back to DEFAULT_CONFIG if not set or on
 * any read error (so a transient API failure doesn't lock the user out of
 * normal modal interactions).
 */
export async function getTeamConfig(teamId: string): Promise<TeamConfig> {
    try {
        const mgr = await getDataManager();
        const stored = await mgr.getValue<Partial<TeamConfig> | undefined>(
            configKey(teamId),
            { scopeType: "Default", defaultValue: undefined }
        );
        if (!stored) return { ...DEFAULT_CONFIG };
        // Additive evolution: merge stored with defaults so missing fields fall
        // back rather than producing undefined.
        return { ...DEFAULT_CONFIG, ...stored } as TeamConfig;
    } catch (err) {
        console.error("[BlockerBuddy] getTeamConfig failed:", err);
        return { ...DEFAULT_CONFIG };
    }
}

export async function setTeamConfig(teamId: string, config: TeamConfig): Promise<void> {
    const mgr = await getDataManager();
    await mgr.setValue<TeamConfig>(configKey(teamId), config, { scopeType: "Default" });
}

/**
 * Delete the team's config document outright. Idempotent: if the document
 * doesn't exist, the SDK's deleteDocument throws — we treat that as success
 * (the desired end state is "no document," whether it existed or not).
 *
 * Used by the dev-only Reset Team Config tool. NOT exposed in any
 * end-user UI — destructive operations behind end-user surfaces should
 * always be category-by-category, not nuke-everything.
 */
export async function deleteTeamConfig(teamId: string): Promise<void> {
    const mgr = await getDataManager();
    try {
        await mgr.deleteDocument(COLLECTION, configKey(teamId), { scopeType: "Default" });
    } catch (err) {
        console.log("[BlockerBuddy] deleteTeamConfig: ignoring error (likely 'no such document', which is the desired end state):", err);
    }
}

// ─── Pure helpers (no SDK dependency) ─────────────────────────────────────

const SANITIZE_REGEX = /[()|\r\n\t]+/g;
const MAX_FIELD_LENGTH = 300;

/**
 * Strip characters that would collide with the marker format: parens (used
 * to wrap the original-reason in unblock markers), pipes (used as the
 * category|context separator), and newlines/tabs (formatting hygiene).
 * Trims and caps at MAX_FIELD_LENGTH.
 */
export function sanitizeReasonText(s: string | undefined | null): string {
    if (!s) return "";
    return String(s).replace(SANITIZE_REGEX, " ").replace(/\s+/g, " ").trim().slice(0, MAX_FIELD_LENGTH);
}

export interface TagValidationResult {
    ok: boolean;
    error?: string;
}

const TAG_MAX_LENGTH = 50;

export function validateTagName(s: string | undefined | null): TagValidationResult {
    const trimmed = (s ?? "").trim();
    if (!trimmed) return { ok: false, error: "Tag name is required." };
    if (trimmed.length > TAG_MAX_LENGTH) return { ok: false, error: `Tag name must be ${TAG_MAX_LENGTH} characters or fewer.` };
    if (trimmed.includes(",")) return { ok: false, error: "Tag name cannot contain commas." };
    if (trimmed.includes(";")) return { ok: false, error: "Tag name cannot contain semicolons." };
    if (trimmed.startsWith("@")) return { ok: false, error: "Tag name cannot start with @." };
    return { ok: true };
}

const CATEGORY_MAX_LENGTH = 50;

/**
 * Validate a category name in the context of the current category list.
 * Rejects empty/whitespace, over-length, marker-format-colliding characters
 * (parens and pipes — these would silently get sanitized out of every marker
 * and produce a category whose canonical form differs from what shows up on
 * the work item), and case-insensitive duplicates of an existing category.
 */
export function validateCategoryName(
    name: string | undefined | null,
    existingCategories: readonly string[] = []
): TagValidationResult {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return { ok: false, error: "Category name is required." };
    if (trimmed.length > CATEGORY_MAX_LENGTH) {
        return { ok: false, error: `Category name must be ${CATEGORY_MAX_LENGTH} characters or fewer.` };
    }
    if (/[()|]/.test(trimmed)) {
        return { ok: false, error: "Category name cannot contain ( ) or | characters." };
    }
    if (/[\r\n\t]/.test(trimmed)) {
        return { ok: false, error: "Category name cannot contain line breaks or tabs." };
    }
    const lower = trimmed.toLowerCase();
    if (existingCategories.some(c => c.toLowerCase() === lower)) {
        return { ok: false, error: "That category already exists." };
    }
    return { ok: true };
}

// ─── Marker construction ──────────────────────────────────────────────────

const MARKER_PREFIX = "BlockerBuddy";

export function buildBlockMarker(category: string): string {
    const cat = sanitizeReasonText(category);
    return `${MARKER_PREFIX}: Blocked - ${cat}`;
}

/**
 * Build an unblock marker. Caller passes the original category (typically
 * from a parseMarker result on the latest block comment) so the marker
 * structurally records what category was being unblocked.
 *
 * If `originalCategory` is empty/undefined, the marker omits the parenthetical
 * wrapper entirely. This is the defensive shape for the "tagged but
 * uncategorized" unblock path; that path doesn't actually write a marker per
 * design, but the bare-Unblocked form is still a syntactically valid marker.
 */
export function buildUnblockMarker(originalCategory?: string): string {
    const cat = sanitizeReasonText(originalCategory);
    let out = `${MARKER_PREFIX}: Unblocked`;
    if (cat) out += ` (${cat})`;
    return out;
}

// ─── Marker parsing ───────────────────────────────────────────────────────

const MARKER_REGEX = /^BlockerBuddy:\s*(Blocked|Unblocked)(?:\s*\(([^)]+)\))?(?:\s*-\s*(.+))?$/i;

export interface ParsedMarker {
    event: "Blocked" | "Unblocked";
    /** For Blocked: the category from the marker. */
    category?: string;
    /** For Unblocked: the original category captured at unblock time. */
    originalCategory?: string;
}

/**
 * Parse a comment text to extract a Blocker Buddy marker. Returns null if
 * none found. Tolerant of multi-line comments — searches each line for the
 * first match.
 */
export function parseMarker(commentText: string | undefined | null): ParsedMarker | null {
    if (!commentText) return null;
    // ADO wraps edited comments in <div> tags. To tolerate benign edits (typo
    // fixes, notes added on a new line below the marker), normalize </div><div>
    // boundaries to newlines so multi-line edits split cleanly, then strip
    // leading <div> and trailing </div> from each line before regex matching.
    // The marker survives as long as it remains the first content inside any
    // <div> wrapper. Edits that prepend text or interleave content correctly
    // fail to parse, since the marker is no longer at the start of its line.
    const normalized = String(commentText).replace(/<\/div>\s*<div\b[^>]*>/gi, "\n");
    const lines = normalized.split(/\r?\n/);
    for (const line of lines) {
        let trimmed = line.trim();
        // Defense in depth: cap line length before regex application. Real BB
        // markers are <300 chars; lines over 1000 chars cannot be valid markers,
        // and bypassing the regex on them eliminates any theoretical super-linear
        // backtracking concern (SonarCloud S5852).
        if (trimmed.length > 1000) continue;
        // Strip outer <div> wrapper if present.
        trimmed = trimmed.replace(/^<div\b[^>]*>/i, "").replace(/<\/div>\s*$/i, "");
        const m = trimmed.match(MARKER_REGEX);
        if (!m) continue;

        const eventRaw = m[1];
        const event = (eventRaw.charAt(0).toUpperCase() + eventRaw.slice(1).toLowerCase()) as "Blocked" | "Unblocked";
        const parenContent = m[2];
        const dashContent = m[3];

        const result: ParsedMarker = { event };

        if (event === "Blocked") {
            if (dashContent) {
                result.category = dashContent.trim();
            }
        } else {
            // Unblocked — the paren content holds the original category captured
            // at unblock time. The regex's dash-group is shared with the Block
            // path (where it captures category); for Unblock markers the shipping
            // format never produces dash content, so it's ignored here.
            if (parenContent) {
                result.originalCategory = parenContent.trim();
            }
        }

        return result;
    }
    return null;
}
