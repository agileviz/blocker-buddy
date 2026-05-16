// Pure transforms over the aggregate + team config + histories shape that
// produce render-ready data for the widget body. No DOM, no SDK — fully
// unit-testable in Jest under the AMD-stub setup.
//
// Mirrors the throughputView.ts pattern: orchestrator + DOM-driven
// renderers stay in the contribution entry point (Widget.ts); pure
// view-layer logic that can fail in interesting ways lives here.

import { CategoryAggregate } from "./blockerAggregation";
import { WorkItemBlockerHistory, BlockerInterval } from "./blockerEventTimeline";

// ─── Category rows: merge team config + aggregate data ──────────────────

export type CategoryRowState = "active" | "in-config-no-data" | "deleted-with-history";

export interface CategoryRow {
    name: string;
    state: CategoryRowState;
    metrics?: { count: number; totalDurationMs: number; dailyEventCounts: ReadonlyArray<number> };
}

/**
 * Merge the team's curated categories with whatever appears in the aggregate
 * data window. Three states surface:
 *   - active: name in BOTH team config and aggregate.categories (case-insensitive)
 *   - in-config-no-data: in team config but NOT in aggregate (curated, quiet)
 *   - deleted-with-history: in aggregate but NOT in team config (removed but
 *     markers still in window)
 *
 * Sort: active first (in aggregate's existing duration-desc order), then
 * in-config-no-data (in team config order), then deleted-with-history
 * (aggregate's order). Active rows use canonical name from team config
 * (preserves user-typed casing) but data from aggregate.
 */
export function buildCategoryRows(
    teamCategories: readonly string[],
    aggregateCategories: readonly CategoryAggregate[]
): CategoryRow[] {
    const teamLowerToCanonical = new Map<string, string>();
    for (const c of teamCategories) teamLowerToCanonical.set(c.toLowerCase(), c);

    const seenInAggregate = new Set<string>();
    const rows: CategoryRow[] = [];

    for (const a of aggregateCategories) {
        const lower = a.name.toLowerCase();
        const canonical = teamLowerToCanonical.get(lower);
        if (canonical) {
            rows.push({
                name: canonical,
                state: "active",
                metrics: { count: a.count, totalDurationMs: a.totalDurationMs, dailyEventCounts: a.dailyEventCounts }
            });
        }
        seenInAggregate.add(lower);
    }

    for (const c of teamCategories) {
        if (!seenInAggregate.has(c.toLowerCase())) {
            rows.push({ name: c, state: "in-config-no-data" });
        }
    }

    for (const a of aggregateCategories) {
        const lower = a.name.toLowerCase();
        if (!teamLowerToCanonical.has(lower)) {
            rows.push({
                name: a.name,
                state: "deleted-with-history",
                metrics: { count: a.count, totalDurationMs: a.totalDurationMs, dailyEventCounts: a.dailyEventCounts }
            });
        }
    }

    return rows;
}

// ─── Permission gate ────────────────────────────────────────────────────

/**
 * Truth table for whether the current user can edit the team's curated
 * categories. Trivial logic, exposed as a function so call sites can
 * compose it with their state shape and tests can assert behavior in
 * isolation.
 */
export function canEdit(isAdmin: boolean, allowMemberEdit: boolean): boolean {
    return isAdmin || allowMemberEdit;
}

// ─── Window overlap + ID collection ─────────────────────────────────────

/**
 * True when [interval.startDate, interval.endDate ?? now] overlaps the
 * half-open [windowStart, windowEnd) range.
 */
export function intervalOverlaps(
    interval: BlockerInterval,
    windowStart: Date,
    windowEnd: Date,
    now: Date
): boolean {
    const effectiveEnd = (interval.endDate ?? now).getTime();
    return interval.startDate.getTime() < windowEnd.getTime() && effectiveEnd > windowStart.getTime();
}

/**
 * Collect unique work item IDs whose histories have any interval matching
 * the filters. categoryFilter null = no category filter; window null/null =
 * no window filter. Used by both the per-category and "all in window" query
 * builders. Explicit ID lists are more accurate than text-search WIQL since
 * unblocked items have lost the tag and the query editor UI doesn't expose
 * a "Was Ever" predicate.
 */
export function collectMatchingIds(
    histories: ReadonlyArray<WorkItemBlockerHistory>,
    /** Lowercase category name to match, or null for "any category". */
    categoryFilter: string | null,
    windowStart: Date | null,
    windowEnd: Date | null,
    now: Date = new Date()
): number[] {
    const ids = new Set<number>();
    for (const h of histories) {
        for (const interval of h.intervals) {
            if (categoryFilter !== null && interval.category.toLowerCase() !== categoryFilter) continue;
            if (windowStart && windowEnd && !intervalOverlaps(interval, windowStart, windowEnd, now)) continue;
            ids.add(h.workItemId);
            break;
        }
    }
    return Array.from(ids);
}

// ─── TSV export ─────────────────────────────────────────────────────────

export const TSV_HEADER = ["ID", "Title", "Category", "BlockDate", "UnblockDate", "DurationDays", "URL"].join("\t");

/**
 * Build TSV from histories filtered by category and window. Returns empty
 * string when there are no matching rows so the caller can skip the copy.
 */
export function buildBlockerTsv(
    histories: ReadonlyArray<WorkItemBlockerHistory>,
    categoryFilter: string | null,
    windowStart: Date | null,
    windowEnd: Date | null,
    urlPrefix: string,
    now: Date = new Date()
): string {
    const rows: string[] = [TSV_HEADER];
    for (const h of histories) {
        for (const interval of h.intervals) {
            if (categoryFilter !== null && interval.category.toLowerCase() !== categoryFilter) continue;
            if (windowStart && windowEnd && !intervalOverlaps(interval, windowStart, windowEnd, now)) continue;
            rows.push(buildTsvRow(h, interval, urlPrefix, now));
        }
    }
    if (rows.length === 1) return "";  // header only — no data
    return rows.join("\n");
}

export function buildTsvRow(
    history: WorkItemBlockerHistory,
    interval: BlockerInterval,
    urlPrefix: string,
    now: Date = new Date()
): string {
    const blockDate = interval.startDate.toISOString().slice(0, 10);
    const unblockDate = interval.endDate ? interval.endDate.toISOString().slice(0, 10) : "(open)";
    const endForDuration = interval.endDate ?? now;
    const durationDays = ((endForDuration.getTime() - interval.startDate.getTime()) / (24 * 60 * 60 * 1000)).toFixed(2);
    const url = urlPrefix ? urlPrefix + history.workItemId : "";
    const cells = [
        String(history.workItemId),
        sanitizeForTsv(history.title ?? ""),
        sanitizeForTsv(interval.category),
        blockDate,
        unblockDate,
        durationDays,
        url
    ];
    return cells.join("\t");
}

/** Strip tabs + newlines so cell values can't break TSV row boundaries. */
export function sanitizeForTsv(s: string): string {
    return s.replace(/[\t\r\n]+/g, " ").trim();
}

// ─── URL prefix for work-item links ─────────────────────────────────────

/**
 * Build the prefix for an ADO work-item edit URL: `https://dev.azure.com/
 * {org}/{project}/_workitems/edit/`. Caller appends the work item ID.
 *
 * Returns empty string when org or project is missing — the TSV builder
 * tolerates that and just leaves the URL cell empty rather than producing
 * a half-formed URL.
 */
export function buildWorkItemUrlPrefix(orgName: string, projectName: string): string {
    if (!orgName || !projectName) return "";
    return `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName)}/_workitems/edit/`;
}
