// Aggregate per-work-item blocker histories into widget-ready data: hero
// count, in-window totals, per-category breakdown with sparkline data, and
// the untimed-but-tagged count. Pure: no SDK dependency, fully unit-tested.
//
// Window semantics: [windowStart, windowEnd) — half-open, UTC-day-aligned at
// the call site. An interval is "in window" if it overlaps the range. Duration
// in window = clipped duration of the overlap. Sparkline is daily count of
// block-START events that fell in the window (we count starts, not unblocks
// — a category trending up means it's getting flagged more often).

import { WorkItemBlockerHistory, BlockerInterval } from "./blockerEventTimeline";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CategoryAggregate {
    name: string;
    /** Number of blocker intervals overlapping the window for this category. */
    count: number;
    /** Total duration in ms, clipped to the window, summed across this category's intervals. */
    totalDurationMs: number;
    /**
     * Daily counts of block-start events within the window, oldest day first.
     * Length = ceil((windowEnd - windowStart) / day). Used for per-row sparklines.
     */
    dailyEventCounts: number[];
}

export interface WidgetAggregateData {
    /** Hero number — items currently blocked (open interval OR untimed tag). */
    currentlyBlocked: number;
    inWindow: {
        /** Number of blocker intervals overlapping the window across all categories. */
        blockerCount: number;
        /** Total clipped duration in ms summed across all in-window intervals. */
        totalDurationMs: number;
    };
    /**
     * Per-category breakdown. Sorted descending by totalDurationMs (the headline
     * impact metric per project_blocker_buddy_design.md — "10 × 2hr ≠ 1 × 5d").
     * Categories with zero in-window activity are omitted.
     */
    categories: ReadonlyArray<CategoryAggregate>;
    /**
     * Items currently tagged but with no marker history — surface as the
     * "Not timed or categorized" structural row.
     */
    untimedCount: number;
    /** Window length in days (ceil) — exposed for callers building axis labels. */
    windowDays: number;
    /**
     * Cumulative blocker-duration in ms by day index from window start.
     * Length = windowDays. cumulativeDurationByDay[i] = total ms of any
     * blocker interval overlapping the window from windowStart through the
     * END of day i. Monotonically non-decreasing. Final element equals
     * inWindow.totalDurationMs.
     *
     * Used by the widget's top aggregate-duration chart — slopes show
     * busy periods, plateaus show calm. The data-integrity-over-completeness
     * principle applies: untimed (tagged-but-uncategorized) items have no
     * timing data so they contribute nothing here.
     */
    cumulativeDurationByDay: ReadonlyArray<number>;
}

export interface AggregateInput {
    histories: ReadonlyArray<WorkItemBlockerHistory>;
    windowStart: Date;
    windowEnd: Date;
    /** Injectable for tests; defaults to new Date(). */
    now?: Date;
}

/**
 * Aggregate histories into widget-ready data. Pure given inputs.
 */
export function aggregateForWidget(input: AggregateInput): WidgetAggregateData {
    const { histories, windowStart, windowEnd } = input;
    const now = input.now ?? new Date();

    const windowMs = Math.max(0, windowEnd.getTime() - windowStart.getTime());
    const windowDays = Math.max(0, Math.ceil(windowMs / MS_PER_DAY));

    let currentlyBlocked = 0;
    let untimedCount = 0;
    const byCategory = new Map<string, {
        count: number;
        totalDurationMs: number;
        dailyEventCounts: number[];
    }>();

    let totalInWindowCount = 0;
    let totalInWindowDurationMs = 0;
    const dailyDurationMs = new Array<number>(windowDays).fill(0);

    for (const history of histories) {
        if (history.isCurrentlyBlocked) currentlyBlocked++;
        if (history.untimedTagPresent) untimedCount++;

        for (const interval of history.intervals) {
            const clipped = clipIntervalToWindow(interval, windowStart, windowEnd, now);
            if (!clipped) continue;

            const categoryKey = interval.category || "(uncategorized)";
            let bucket = byCategory.get(categoryKey);
            if (!bucket) {
                bucket = {
                    count: 0,
                    totalDurationMs: 0,
                    dailyEventCounts: new Array(windowDays).fill(0)
                };
                byCategory.set(categoryKey, bucket);
            }

            bucket.count++;
            bucket.totalDurationMs += clipped.durationMs;
            totalInWindowCount++;
            totalInWindowDurationMs += clipped.durationMs;

            // Per-day overlap: split the clipped interval's duration across
            // the days it touches. Used to build the cumulative-duration
            // line for the widget's top chart.
            accumulatePerDayOverlap(
                interval, windowStart, windowEnd, now, dailyDurationMs, windowDays
            );

            // Sparkline: count one for the day the block started, only if the
            // start itself fell within the window. Intervals that started
            // before the window contribute duration but no sparkline tick.
            if (interval.startDate >= windowStart && interval.startDate < windowEnd) {
                const dayIndex = Math.floor(
                    (interval.startDate.getTime() - windowStart.getTime()) / MS_PER_DAY
                );
                if (dayIndex >= 0 && dayIndex < windowDays) {
                    bucket.dailyEventCounts[dayIndex]++;
                }
            }
        }
    }

    const categories: CategoryAggregate[] = Array.from(byCategory.entries())
        .map(([name, b]) => ({
            name,
            count: b.count,
            totalDurationMs: b.totalDurationMs,
            dailyEventCounts: b.dailyEventCounts
        }))
        .sort((a, b) => {
            if (b.totalDurationMs !== a.totalDurationMs) return b.totalDurationMs - a.totalDurationMs;
            if (b.count !== a.count) return b.count - a.count;
            return a.name.localeCompare(b.name);
        });

    // Convert daily duration into a monotonically non-decreasing cumulative
    // series. cumulative[i] = sum of dailyDurationMs[0..i].
    const cumulativeDurationByDay = new Array<number>(windowDays).fill(0);
    let runningTotal = 0;
    for (let i = 0; i < windowDays; i++) {
        runningTotal += dailyDurationMs[i];
        cumulativeDurationByDay[i] = runningTotal;
    }

    return {
        currentlyBlocked,
        inWindow: {
            blockerCount: totalInWindowCount,
            totalDurationMs: totalInWindowDurationMs
        },
        categories,
        untimedCount,
        windowDays,
        cumulativeDurationByDay
    };
}

/**
 * Add this interval's per-day overlap-with-window to dailyDurationMs[].
 * Pure helper; no allocation beyond the existing buffer. Open intervals
 * (endDate=null) treat their end as `now`, then clip to windowEnd.
 *
 * Off-by-one note: endDay uses (endMs - 1) so an interval ending exactly
 * at midnight doesn't bleed an empty day onto the next index. An interval
 * fully inside one day correctly produces startDay == endDay.
 */
function accumulatePerDayOverlap(
    interval: BlockerInterval,
    windowStart: Date,
    windowEnd: Date,
    now: Date,
    dailyDurationMs: number[],
    windowDays: number
): void {
    const winStartMs = windowStart.getTime();
    const effectiveEndMs = (interval.endDate ?? now).getTime();
    const startMs = Math.max(interval.startDate.getTime(), winStartMs);
    const endMs = Math.min(effectiveEndMs, windowEnd.getTime());
    if (startMs >= endMs) return;

    const startDay = Math.floor((startMs - winStartMs) / MS_PER_DAY);
    const endDay = Math.floor((endMs - 1 - winStartMs) / MS_PER_DAY);

    for (let d = Math.max(0, startDay); d <= Math.min(windowDays - 1, endDay); d++) {
        const dayStart = winStartMs + d * MS_PER_DAY;
        const dayEnd = dayStart + MS_PER_DAY;
        const overlapStart = Math.max(startMs, dayStart);
        const overlapEnd = Math.min(endMs, dayEnd);
        dailyDurationMs[d] += Math.max(0, overlapEnd - overlapStart);
    }
}

interface ClippedInterval {
    durationMs: number;
}

function clipIntervalToWindow(
    interval: BlockerInterval,
    windowStart: Date,
    windowEnd: Date,
    now: Date
): ClippedInterval | null {
    const effectiveEnd = interval.endDate ?? now;
    const startMs = interval.startDate.getTime();
    const endMs = effectiveEnd.getTime();
    const winStartMs = windowStart.getTime();
    const winEndMs = windowEnd.getTime();
    if (startMs >= winEndMs) return null;
    if (endMs <= winStartMs) return null;
    const clippedStart = Math.max(startMs, winStartMs);
    const clippedEnd = Math.min(endMs, winEndMs);
    return { durationMs: Math.max(0, clippedEnd - clippedStart) };
}

/** Convenience: format ms as a human-friendly day count for the secondary metrics line. */
export function formatDurationDays(ms: number, decimals = 1): string {
    const days = ms / MS_PER_DAY;
    if (days < 0.05) return "0 days";
    return `${days.toFixed(decimals)} day${days >= 1.05 || days < 0.95 ? "s" : ""}`;
}
