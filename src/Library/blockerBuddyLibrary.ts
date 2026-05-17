// ADO REST helpers + identity utilities for Blocker Buddy.
// SDK-dependent throughout; not unit-testable in Jest. Integration-tested
// via dev install. Kept narrow — only the operations Blocker Buddy actually
// performs (read tags, write tags, post comment, list comments, identity,
// admin check).

import * as SDK from "azure-devops-extension-sdk";
import {
    CommonServiceIds,
    IProjectPageService,
    getClient
} from "azure-devops-extension-api";
import {
    WorkItemTrackingRestClient,
    WorkItemExpand
} from "azure-devops-extension-api/WorkItemTracking";
import { JsonPatchOperation } from "azure-devops-extension-api/WebApi";
import { CoreRestClient, TeamContext } from "azure-devops-extension-api/Core";
import { WorkRestClient } from "azure-devops-extension-api/Work";

// ─── Project + REST client init (lazy) ────────────────────────────────────
//
// Lazy because module-load-time initialization fails under Jest's AMD-stub
// (the SDK calls would no-op). All public functions await ensureProjectContext
// before performing any REST work.

let _projectId: string | undefined;
let _projectName: string | undefined;
let _witClient: WorkItemTrackingRestClient | undefined;
let _coreClient: CoreRestClient | undefined;

export async function ensureProjectContext(): Promise<void> {
    if (_projectId) return;
    const projectSvc = await SDK.getService<IProjectPageService>(
        CommonServiceIds.ProjectPageService
    );
    const project = await projectSvc.getProject();
    if (!project) throw new Error("Could not resolve current ADO project context.");
    _projectId = project.id;
    _projectName = project.name;
    _witClient = getClient(WorkItemTrackingRestClient);
    _coreClient = getClient(CoreRestClient);
}

function wit(): WorkItemTrackingRestClient {
    if (!_witClient) throw new Error("ensureProjectContext() must be awaited before WIT calls.");
    return _witClient;
}

function core(): CoreRestClient {
    if (!_coreClient) throw new Error("ensureProjectContext() must be awaited before Core calls.");
    return _coreClient;
}

function projectId(): string {
    if (!_projectId) throw new Error("ensureProjectContext() must be awaited before project access.");
    return _projectId;
}

function projectName(): string {
    if (!_projectName) throw new Error("ensureProjectContext() must be awaited before project access.");
    return _projectName;
}

// ─── Identity helpers ─────────────────────────────────────────────────────

/**
 * Resolve the dashboard team from web context. Falls back to the first team
 * in the project if no team context is available (e.g., user is on a
 * project-level dashboard, not a team-scoped one).
 *
 * NOTE: this fallback is appropriate for the action modal (which always
 * needs *some* team to write a config blob to), but is dangerous for the
 * widget body (which would silently scope its data to an arbitrary team).
 * Widgets should use getDashboardTeamIdOrNull() instead and surface a
 * "needs config" state when null.
 */
export async function getCurrentTeamId(): Promise<string> {
    await ensureProjectContext();
    const ctx = SDK.getWebContext();
    if (ctx.team?.id) return ctx.team.id;
    // Fallback: use the first team in the project
    const teams = await core().getTeams(projectId());
    if (!teams || teams.length === 0) throw new Error("No teams available in this project.");
    return teams[0].id;
}

/**
 * Strict variant for surfaces (like the widget body) that must NOT silently
 * fall back to an arbitrary team when the dashboard isn't team-scoped. Returns
 * null on project-level dashboards; callers should render a "configure team"
 * state instead of querying data.
 */
export function getDashboardTeamIdOrNull(): string | null {
    try {
        const ctx = SDK.getWebContext();
        return ctx?.team?.id ?? null;
    } catch {
        return null;
    }
}

/**
 * True when this VSIX is the dev variant (extension id ends with "-dev",
 * applied at package time via extension-DEV.json). Dev-only UI like the
 * Reset Team Config tool should gate on this.
 */
export function isDevExtension(): boolean {
    try {
        const ctx = SDK.getExtensionContext();
        return ctx?.extensionId?.endsWith("-dev") ?? false;
    } catch {
        return false;
    }
}

/**
 * Fetch all teams in the current project. Used by the widget config pane to
 * populate the team selector dropdown.
 */
export async function getProjectTeams(): Promise<Array<{ id: string; name: string }>> {
    await ensureProjectContext();
    const teams = await core().getTeams(projectId());
    return (teams ?? [])
        .map(t => ({ id: t.id, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCurrentUserId(): string {
    const user = SDK.getUser();
    return user?.id ?? "";
}

// ─── Permissions ──────────────────────────────────────────────────────────

// Per-session cache: avoid re-querying admin status on every modal open.
const _adminCache = new Map<string, boolean>();

/**
 * Returns true if the current user has admin authority over the team's
 * Blocker Buddy config. Cached per teamId for the session.
 *
 * The admin check is deliberately permissive (favors fail-open) because
 * locking out legitimate users is a worse failure mode than letting a
 * non-admin edit. Returns true in any of these cases:
 *  - User is explicitly flagged as a team admin (isTeamAdmin=true)
 *  - User is a member of the team AND no one is flagged as team admin
 *    (solo / small project with no explicit team-admin assignments —
 *    project owners implicitly have full authority)
 *  - The API call errors (transient failure shouldn't lock anyone out)
 *
 * The "no explicit admin" fallback specifically handles project-owner
 * cases where ADO doesn't auto-mark the owner as a team admin.
 *
 * V1.5 refinement: add explicit project-owner check via Core API to handle
 * the case where multiple users are on a team and only one is the project
 * owner (currently they'd all be treated as admin under fallback rule 2).
 */
export async function isCurrentUserAdmin(teamId: string): Promise<boolean> {
    if (_adminCache.has(teamId)) return _adminCache.get(teamId)!;
    try {
        await ensureProjectContext();
        const userId = getCurrentUserId();
        const members = await core().getTeamMembersWithExtendedProperties(
            projectId(),
            teamId
        );
        const explicitAdmin = members?.some(
            m => m.identity?.id === userId && m.isTeamAdmin === true
        ) ?? false;
        if (explicitAdmin) {
            _adminCache.set(teamId, true);
            return true;
        }
        // Fallback: if the team has no explicit admins, treat any member as
        // admin (the solo-developer / small-project case — project owner
        // isn't auto-flagged isTeamAdmin in ADO).
        const anyAdminFlagged = members?.some(m => m.isTeamAdmin === true) ?? false;
        if (!anyAdminFlagged) {
            const isMember = members?.some(m => m.identity?.id === userId) ?? false;
            if (isMember || !members?.length) {
                console.log("[BlockerBuddy] No explicit team admin found; treating user as admin (small-team fallback)");
                _adminCache.set(teamId, true);
                return true;
            }
        }
        _adminCache.set(teamId, false);
        return false;
    } catch (err) {
        console.error("[BlockerBuddy] isCurrentUserAdmin failed (returning true to fail-open):", err);
        return true;
    }
}

// ─── Work item tag operations ─────────────────────────────────────────────

/**
 * Fetch the current tags array for a work item. Tags in ADO are stored as a
 * single semicolon-separated string in System.Tags; we parse and normalize.
 */
export async function getWorkItemTags(workItemId: number): Promise<string[]> {
    await ensureProjectContext();
    const item = await wit().getWorkItem(workItemId, projectId(), ["System.Tags"]);
    const raw = (item.fields?.["System.Tags"] as string | undefined) ?? "";
    return raw.split(";").map(t => t.trim()).filter(Boolean);
}

/**
 * Fetch tags + title in one round trip. Used by the dialog so the work-item
 * reference can show both `#1234` and the title text on the same line, which
 * helps the user confirm they're acting on the item they expected.
 */
export async function getWorkItemTagsAndTitle(workItemId: number): Promise<{ tags: string[]; title: string }> {
    await ensureProjectContext();
    const item = await wit().getWorkItem(workItemId, projectId(), ["System.Tags", "System.Title"]);
    const rawTags = (item.fields?.["System.Tags"] as string | undefined) ?? "";
    const tags = rawTags.split(";").map(t => t.trim()).filter(Boolean);
    const title = (item.fields?.["System.Title"] as string | undefined) ?? "";
    return { tags, title };
}

/**
 * Replace the work item's tags with the given array. Use with caution — this
 * overwrites any existing tags. Most callers should fetch first, modify the
 * array, and then call this with the modified version.
 */
export async function setWorkItemTags(workItemId: number, tags: string[]): Promise<void> {
    await ensureProjectContext();
    const patch: JsonPatchOperation[] = [
        {
            op: "replace" as unknown as JsonPatchOperation["op"],
            path: "/fields/System.Tags",
            value: tags.join("; ")
        } as JsonPatchOperation
    ];
    await wit().updateWorkItem(patch, workItemId, projectId());
}

/**
 * Add a tag to a work item if not already present (case-insensitive match).
 */
export async function addWorkItemTag(workItemId: number, tag: string): Promise<string[]> {
    const tags = await getWorkItemTags(workItemId);
    const lower = tags.map(t => t.toLowerCase());
    if (!lower.includes(tag.toLowerCase())) {
        tags.push(tag);
        await setWorkItemTags(workItemId, tags);
    }
    return tags;
}

/**
 * Remove a tag from a work item if present (case-insensitive match).
 */
export async function removeWorkItemTag(workItemId: number, tag: string): Promise<string[]> {
    const tags = await getWorkItemTags(workItemId);
    const filtered = tags.filter(t => t.toLowerCase() !== tag.toLowerCase());
    if (filtered.length !== tags.length) {
        await setWorkItemTags(workItemId, filtered);
    }
    return filtered;
}

// ─── Comment operations ──────────────────────────────────────────────────
//
// IMPORTANT: ADO has two comment APIs at the same URL path, distinguished
// only by api-version:
//   - Legacy: api-version=3.2-preview (returned by SDK's wit().getComments)
//   - v3:     api-version=7.0-preview.3 (used here)
//
// Comments posted via v3 are NOT visible to the legacy read endpoint —
// `wit().getComments()` returns an empty array even when v3 comments exist.
// Since we POST via v3 (the only sane API for new work), we MUST also read
// via v3. The typed SDK doesn't expose v3 reads, so we use raw fetch.
// (Discovered on Blocker Buddy 2026-04-29 when the dialog couldn't find
// markers it had just written.)
//
// Returns a uniform BBComment shape so callers don't need to care which
// API shape they're getting.

export interface BBComment {
    id: number;
    text: string;
    createdDate: Date;
}

export interface PostedCommentResult {
    id: number;
    text: string;
    createdDate?: string;
}

export async function postComment(workItemId: number, text: string): Promise<PostedCommentResult> {
    await ensureProjectContext();
    const orgName = SDK.getHost().name;
    const accessToken = await SDK.getAccessToken();
    const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName())}/_apis/wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "Accept": "application/json;api-version=7.0-preview.3"
        },
        body: JSON.stringify({ text })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Failed to post comment (status ${res.status}): ${detail.slice(0, 300)}`);
    }
    return await res.json();
}

interface V3CommentRaw {
    id: number;
    text?: string;
    createdDate?: string;
}

interface V3CommentsResponse {
    comments?: V3CommentRaw[];
}

async function fetchCommentsV3(
    workItemId: number,
    top: number,
    order: "asc" | "desc"
): Promise<BBComment[]> {
    await ensureProjectContext();
    const orgName = SDK.getHost().name;
    const accessToken = await SDK.getAccessToken();
    const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName())}/_apis/wit/workItems/${workItemId}/comments?$top=${top}&order=${order}&api-version=7.0-preview.3`;
    const res = await fetch(url, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json;api-version=7.0-preview.3"
        }
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Failed to fetch comments (status ${res.status}): ${detail.slice(0, 300)}`);
    }
    const data: V3CommentsResponse = await res.json();
    return (data.comments ?? [])
        .filter((c): c is V3CommentRaw & { text: string; createdDate: string } =>
            typeof c.text === "string" && typeof c.createdDate === "string"
        )
        .map(c => ({
            id: c.id,
            text: c.text,
            createdDate: new Date(c.createdDate)
        }));
}

/**
 * Fetch the most recent comments on a work item, newest first. Uses the v3
 * Comments API (the typed SDK's getComments hits the legacy endpoint which
 * doesn't return v3-posted comments — see above).
 */
export async function getRecentComments(workItemId: number, top = 20): Promise<BBComment[]> {
    return fetchCommentsV3(workItemId, top, "desc");
}

// ─── Team area path scoping ──────────────────────────────────────────────
//
// ADO teams don't own work items directly; they own area-path ranges, and
// work items own area paths. The widget data layer must intersect "this
// team's area paths" with "items mentioning BlockerBuddy" — otherwise a
// team-scoped widget would show blockers from across the entire project.
// Pattern ported from Throughput's adoLibrary (same logic, same shape).

export interface TeamAreaPath {
    path: string;
    /** When true, [System.AreaPath] UNDER '<path>'; when false, exact equality. */
    includeChildren: boolean;
}

export async function getTeamAreaPaths(teamId: string): Promise<TeamAreaPath[]> {
    await ensureProjectContext();
    const workClient = getClient(WorkRestClient);
    const teamContext: TeamContext = {
        projectId: projectId(),
        project:   projectName(),
        teamId:    teamId,
        team:      ""
    };
    const fieldValues = await workClient.getTeamFieldValues(teamContext);
    return (fieldValues.values ?? []).map(v => ({
        path: v.value,
        includeChildren: !!v.includeChildren
    }));
}

// ─── Widget data fetching ────────────────────────────────────────────────

export interface WorkItemSummary {
    id: number;
    title: string;
    /** True if the supplied tagName is in the item's current tags (case-insensitive). */
    currentlyTagged: boolean;
}

/**
 * WIQL: find work items relevant to the team's Blocker Buddy widget. Two
 * disjoint sources contribute:
 *   1) currently tagged with the team's blocker tag (drives the "X blocked
 *      now" hero count, including items with no marker history yet)
 *   2) historically mentioned BlockerBuddy in their discussion stream (drives
 *      the per-category breakdown — items that were blocked-and-unblocked
 *      within the window won't have the tag now but should still count)
 *
 * Both sources are intersected with the team's area paths so a team-scoped
 * widget doesn't bleed in blockers from sibling teams. Tag/History match is
 * project-wide otherwise, which silently overcounts on multi-team projects.
 *
 * Single OR-joined query keeps WIQL roundtrips at one. The 20K WIQL row cap
 * is unlikely to bite for blocker history (would require thousands of items
 * in the project ever blocked); if it does, the caller surfaces a graceful
 * "narrow the window" message — see project_blocker_buddy_design.md.
 *
 * Note: WIQL's [System.History] CONTAINS WORDS predicate matches against the
 * History field — which IS the discussion comments. Hyphens in "BlockerBuddy"
 * would split the search term, but our marker uses CamelCase (no hyphens) so
 * it stays whole. See feedback_ado_comment_sanitizer.md.
 */
export function buildBlockerWiql(
    tagName: string,
    areaPaths: ReadonlyArray<TeamAreaPath>
): string {
    const safeTag = String(tagName).replace(/'/g, "''");
    const areaClause = buildAreaPathClause(areaPaths);
    return `
        SELECT [System.Id]
        FROM WorkItems
        WHERE
            ([System.Tags] CONTAINS '${safeTag}'
             OR [System.History] CONTAINS WORDS 'BlockerBuddy')
            AND [System.TeamProject] = @project
            AND ${areaClause}
    `.trim();
}

/**
 * Build the WHERE clause that scopes a query to a team's area paths. Each
 * TeamAreaPath emits either `UNDER 'X'` (subtree) or `= 'X'` (exact). Empty
 * input → returns "1=0" so callers can short-circuit at the WIQL boundary
 * (a team that owns no area paths owns no work items by definition; we
 * shouldn't fall back to project-wide scope for that case).
 */
function buildAreaPathClause(areaPaths: ReadonlyArray<TeamAreaPath>): string {
    if (areaPaths.length === 0) return "1=0";
    const clauses = areaPaths.map(ap => {
        const safe = ap.path.replace(/'/g, "''");
        return ap.includeChildren
            ? `[System.AreaPath] UNDER '${safe}'`
            : `[System.AreaPath] = '${safe}'`;
    });
    return `(${clauses.join(" OR ")})`;
}

/** ADO's WIQL hard cap. Returns this many results AT MOST per query — silently. */
export const WIQL_RESULT_CAP = 20000;

export interface QueryBlockerIdsResult {
    ids: number[];
    /**
     * True when the WIQL likely hit the 20K result cap. Detection: count of
     * returned IDs >= cap minus a small safety margin (some ADO instances
     * return slightly fewer than 20K when capped). Caller should surface a
     * "narrow the window for fuller coverage" message.
     */
    possiblyTruncated: boolean;
}

export async function queryBlockerWorkItemIds(
    tagName: string,
    areaPaths: ReadonlyArray<TeamAreaPath>
): Promise<QueryBlockerIdsResult> {
    await ensureProjectContext();
    if (areaPaths.length === 0) return { ids: [], possiblyTruncated: false };
    const wiql = buildBlockerWiql(tagName, areaPaths);
    const result = await wit().queryByWiql({ query: wiql }, projectId(), undefined, true);
    const ids = (result.workItems ?? []).map(w => w.id).filter((id): id is number => typeof id === "number");
    return {
        ids,
        possiblyTruncated: ids.length >= WIQL_RESULT_CAP - 100
    };
}

/**
 * Batched fetch of work item summaries (id, title, current tags) by id list.
 * Uses ADO's batched getWorkItems with a 200-item page size (ADO's documented
 * limit). Returns one WorkItemSummary per id; items the user can't read are
 * silently skipped.
 */
export async function getWorkItemSummaries(
    ids: number[],
    tagName: string
): Promise<WorkItemSummary[]> {
    await ensureProjectContext();
    if (ids.length === 0) return [];
    const PAGE = 200;
    const out: WorkItemSummary[] = [];
    const lowerTag = tagName.toLowerCase();
    for (let i = 0; i < ids.length; i += PAGE) {
        const slice = ids.slice(i, i + PAGE);
        const items = await wit().getWorkItems(
            slice,
            projectId(),
            ["System.Title", "System.Tags"],
            undefined,
            WorkItemExpand.None
        );
        for (const item of items ?? []) {
            if (typeof item?.id !== "number") continue;
            const title = (item.fields?.["System.Title"] as string | undefined) ?? "";
            const rawTags = (item.fields?.["System.Tags"] as string | undefined) ?? "";
            const tagList = rawTags.split(";").map(t => t.trim().toLowerCase()).filter(Boolean);
            out.push({
                id: item.id,
                title,
                currentlyTagged: tagList.includes(lowerTag)
            });
        }
    }
    return out;
}

/**
 * Fetch all comments for a work item, oldest first. Used by the widget data
 * layer: we need the full marker history to build the event timeline
 * correctly, not just recent comments. Sequential per-item fetches — ADO
 * has no batched-comment API. Uses v3 (see fetchCommentsV3 note above).
 */
export async function getAllCommentsAsc(workItemId: number, top = 200): Promise<BBComment[]> {
    return fetchCommentsV3(workItemId, top, "asc");
}
