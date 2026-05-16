// Widget body data orchestrator. Wires WIQL + batched fetches against the
// pure timeline + aggregator helpers, returning a single widget-ready blob.
// All SDK touchpoints are confined here; the pure modules stay testable in
// isolation under the AMD-stubbed Jest runtime.
//
// The fetch shape is deliberately conservative for V1.5:
//   1) one WIQL → ids
//   2) one batched work-items fetch → titles + current tag state
//   3) per-item getComments calls — sequential because ADO has no batched
//      comment API. For typical teams (tens of items in window) this is
//      under a second; for very large teams the time window selector caps
//      blast radius. We can revisit with parallel fetches if profiling shows
//      it matters.

import {
    queryBlockerWorkItemIds,
    getWorkItemSummaries,
    getAllCommentsAsc,
    getTeamAreaPaths,
    WorkItemSummary
} from "./blockerBuddyLibrary";
import {
    buildWorkItemBlockerHistory,
    WorkItemBlockerHistory,
    CommentInput
} from "./blockerEventTimeline";
import {
    aggregateForWidget,
    WidgetAggregateData
} from "./blockerAggregation";

export interface FetchWidgetDataInput {
    /** Team to scope the data to. Drives area-path filter on the WIQL. */
    teamId: string;
    /** Team's blocker tag, used both for the WIQL filter and the currentlyTagged check. */
    tagName: string;
    /** Inclusive lower bound of the analysis window. */
    windowStart: Date;
    /** Exclusive upper bound. Typically `now` rounded up to UTC midnight. */
    windowEnd: Date;
    /** Optional override for current time (test injection). */
    now?: Date;
    /**
     * Cap on per-item comment fetch. ADO's getComments defaults are tiny;
     * 200 covers any realistic Blocker Buddy history without paging.
     */
    commentTopPerItem?: number;
}

export interface FetchWidgetDataResult {
    aggregate: WidgetAggregateData;
    /** Raw histories — exposed so the widget body can drill into specific items for the edit affordances. */
    histories: WorkItemBlockerHistory[];
    /** Total work items the WIQL query returned (before history filtering). Useful for "narrow the window" hint. */
    queriedItemCount: number;
    /**
     * True when the team owns no area paths — the WIQL was skipped because
     * a team that owns no work items has no blockers by definition. The
     * widget body surfaces this as a configuration-issue message, not as
     * "no blockers."
     */
    teamHasNoAreaPaths: boolean;
    /**
     * True when the WIQL likely hit the 20K result cap (ADO's hard limit
     * per query). Caller should surface a "narrow the window for fuller
     * coverage" message — without this, the widget would silently report
     * incomplete data. Realistic for very-large multi-year projects.
     */
    wiqlPossiblyTruncated: boolean;
}

// 200 is ADO's v3 Comments API hard cap (verified empirically: requesting
// $top=500 returns 400 with "Acceptable Range: 1 to 200"). Most work items
// have well under 200 comments so this captures full BB history; for very
// chatty items (>200 comments), the oldest markers may be missed under
// order=asc + top=200. Future enhancement: paginate via continuation token
// (or switch to order=desc + reverse to prioritize recent BB markers over
// the very-oldest comments).
const DEFAULT_COMMENT_TOP = 200;

/**
 * Fetch + classify + aggregate. The orchestrator stays small because each
 * step is a single named call; the heavy logic lives in the pure helpers.
 */
export async function fetchWidgetData(input: FetchWidgetDataInput): Promise<FetchWidgetDataResult> {
    const areaPaths = await getTeamAreaPaths(input.teamId);
    if (areaPaths.length === 0) {
        return {
            aggregate: aggregateForWidget({
                histories: [],
                windowStart: input.windowStart,
                windowEnd: input.windowEnd,
                now: input.now
            }),
            histories: [],
            queriedItemCount: 0,
            teamHasNoAreaPaths: true,
            wiqlPossiblyTruncated: false
        };
    }

    const queryResult = await queryBlockerWorkItemIds(input.tagName, areaPaths);
    const ids = queryResult.ids;
    if (ids.length === 0) {
        return {
            aggregate: aggregateForWidget({
                histories: [],
                windowStart: input.windowStart,
                windowEnd: input.windowEnd,
                now: input.now
            }),
            histories: [],
            queriedItemCount: 0,
            teamHasNoAreaPaths: false,
            wiqlPossiblyTruncated: queryResult.possiblyTruncated
        };
    }

    const summaries = await getWorkItemSummaries(ids, input.tagName);
    const summaryById = new Map<number, WorkItemSummary>();
    for (const s of summaries) summaryById.set(s.id, s);

    const top = input.commentTopPerItem ?? DEFAULT_COMMENT_TOP;
    const histories: WorkItemBlockerHistory[] = [];
    for (const id of ids) {
        const summary = summaryById.get(id);
        if (!summary) continue;
        const comments = await getAllCommentsAsc(id, top);
        // v3 Comments API returns the actual post date as `createdDate` —
        // semantically correct for the timeline (edits go to `modifiedDate`,
        // which we don't read; the original block/unblock event time is what
        // we want for duration calculations).
        const commentInputs: CommentInput[] = comments.map(c => ({
            text: c.text,
            createdDate: c.createdDate
        }));
        const history = buildWorkItemBlockerHistory({
            workItemId: id,
            title: summary.title,
            comments: commentInputs,
            currentlyTagged: summary.currentlyTagged,
            now: input.now
        });
        histories.push(history);
    }

    const aggregate = aggregateForWidget({
        histories,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        now: input.now
    });

    return {
        aggregate,
        histories,
        queriedItemCount: ids.length,
        teamHasNoAreaPaths: false,
        wiqlPossiblyTruncated: queryResult.possiblyTruncated
    };
}

/**
 * Convenience: build the standard [windowStart, windowEnd) range for a "last
 * N days" rolling window. windowEnd = next UTC midnight (so today's events
 * are included); windowStart = N days before windowEnd. Used by widget body
 * when the user picks "Last 14 days," etc.
 */
export function buildRollingWindow(days: number, now: Date = new Date()): { windowStart: Date; windowEnd: Date } {
    const utcMidnightTomorrow = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1
    ));
    const start = new Date(utcMidnightTomorrow.getTime() - days * 24 * 60 * 60 * 1000);
    return { windowStart: start, windowEnd: utcMidnightTomorrow };
}
