// Per-work-item event timeline: turns a chronological comment stream + current
// tag state into a typed history of block intervals (closed pairs + an open
// interval if currently blocked). Pure: no SDK dependency, fully unit-tested.
//
// Shape rationale: a single WorkItemBlockerHistory feeds three widget surfaces
// — hero count, per-category breakdown, "Not timed or categorized" row — so
// the consumer doesn't re-walk comments per surface. Returning intervals
// chronologically (oldest first) lets the aggregator clip-to-window without
// re-sorting.

import { parseMarker, ParsedMarker } from "./teamConfig";

export interface CommentInput {
    text: string;
    createdDate: Date;
}

export interface BlockerInterval {
    /** Block start timestamp (the BlockerBuddy: Blocked marker comment time). */
    startDate: Date;
    /** Block end timestamp; null if still blocked. */
    endDate: Date | null;
    /** Category from the block marker. Empty string if marker had no category text (defensive). */
    category: string;
    /** Optional context from the block marker (after pipe). */
    context?: string;
    /** Optional resolution captured at unblock time. */
    resolution?: string;
}

export interface WorkItemBlockerHistory {
    workItemId: number;
    title?: string;
    /** Chronological closed-and-open intervals, oldest first. Empty if no markers. */
    intervals: BlockerInterval[];
    /**
     * True when the team's tag is on the item but no BlockerBuddy markers
     * exist in its comment history. Surfaces in the "Not timed or
     * categorized" widget row.
     */
    untimedTagPresent: boolean;
    /**
     * True when the item should count toward the hero "X blocked now" number:
     * either an open interval exists OR the tag is present without markers.
     */
    isCurrentlyBlocked: boolean;
}

export interface BuildHistoryInput {
    workItemId: number;
    title?: string;
    comments: ReadonlyArray<CommentInput>;
    /** Whether the team's blocker tag is currently on the work item. */
    currentlyTagged: boolean;
    /** Injectable for tests; defaults to new Date(). */
    now?: Date;
}

/**
 * Build a per-work-item blocker history from its comment stream + current tag
 * state. Defensive against data correction cases: orphan markers (Block without
 * Unblock, or Unblock without Block) are dropped rather than synthesized with
 * invented timestamps. Better no data than wrong data.
 */
export function buildWorkItemBlockerHistory(input: BuildHistoryInput): WorkItemBlockerHistory {
    const sorted = [...input.comments].sort(
        (a, b) => a.createdDate.getTime() - b.createdDate.getTime()
    );

    const intervals: BlockerInterval[] = [];
    let openInterval: BlockerInterval | null = null;

    for (const comment of sorted) {
        const marker = parseMarker(comment.text);
        if (!marker) continue;

        if (marker.event === "Blocked") {
            if (openInterval) {
                // Two consecutive Block markers without an intervening Unblock:
                // drop the prior interval rather than guess at its end. Cause
                // is usually a deleted Unblock comment (in which case an
                // invented end inflates the period) or an unusual double-Block
                // from error recovery (in which case the brief first period is
                // small enough to lose). Either way, "better no data than
                // wrong data" — same principle as the orphan-unblock handling
                // below. Symmetric treatment of the two missing-marker cases.
            }
            openInterval = {
                startDate: comment.createdDate,
                endDate: null,
                category: marker.category ?? "",
                ...(marker.context ? { context: marker.context } : {})
            };
        } else {
            // Unblocked
            if (!openInterval) continue;  // orphan unblock — no marker to close; skip
            openInterval.endDate = comment.createdDate;
            if (marker.resolution) openInterval.resolution = marker.resolution;
            intervals.push(openInterval);
            openInterval = null;
        }
    }

    if (openInterval) intervals.push(openInterval);

    const hasOpenInterval = intervals.length > 0 && intervals[intervals.length - 1].endDate === null;
    const untimedTagPresent = input.currentlyTagged && intervals.length === 0;
    const isCurrentlyBlocked = hasOpenInterval || untimedTagPresent;

    return {
        workItemId: input.workItemId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        intervals,
        untimedTagPresent,
        isCurrentlyBlocked
    };
}

/**
 * Convenience: filter intervals to those that overlap the [windowStart, windowEnd)
 * range. An open interval (endDate=null) is treated as ending at `now`. Used by
 * the aggregator and exported for any caller that needs a one-off "is this
 * interval relevant in the window?" check.
 */
export function intervalOverlapsWindow(
    interval: BlockerInterval,
    windowStart: Date,
    windowEnd: Date,
    now: Date = new Date()
): boolean {
    const effectiveEnd = interval.endDate ?? now;
    return interval.startDate < windowEnd && effectiveEnd > windowStart;
}

/** Re-export ParsedMarker type for callers that already imported from this module. */
export type { ParsedMarker };
