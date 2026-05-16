// Unit tests for the widget aggregator: histories + window → widget-ready data.
// All tests use injected `now` for determinism.

import { aggregateForWidget, formatDurationDays } from "../blockerAggregation";
import { WorkItemBlockerHistory, BlockerInterval } from "../blockerEventTimeline";

const NOW = new Date("2026-04-29T12:00:00Z");
const WINDOW_START = new Date("2026-04-01T00:00:00Z");
const WINDOW_END = new Date("2026-05-01T00:00:00Z");
const WINDOW_DAYS = 30;

const MS_DAY = 24 * 60 * 60 * 1000;

function interval(startIso: string, endIso: string | null, category: string, extras: Partial<BlockerInterval> = {}): BlockerInterval {
    return {
        startDate: new Date(startIso),
        endDate: endIso === null ? null : new Date(endIso),
        category,
        ...extras
    };
}

function history(id: number, intervals: BlockerInterval[], options: Partial<Pick<WorkItemBlockerHistory, "untimedTagPresent" | "isCurrentlyBlocked" | "title">> = {}): WorkItemBlockerHistory {
    const lastOpen = intervals.length > 0 && intervals[intervals.length - 1].endDate === null;
    return {
        workItemId: id,
        intervals,
        untimedTagPresent: options.untimedTagPresent ?? false,
        isCurrentlyBlocked: options.isCurrentlyBlocked ?? (lastOpen || (options.untimedTagPresent ?? false)),
        ...(options.title !== undefined ? { title: options.title } : {})
    };
}

describe("aggregateForWidget — empty cases", () => {
    test("no histories → all zeros", () => {
        const result = aggregateForWidget({
            histories: [],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.currentlyBlocked).toBe(0);
        expect(result.inWindow.blockerCount).toBe(0);
        expect(result.inWindow.totalDurationMs).toBe(0);
        expect(result.categories).toEqual([]);
        expect(result.untimedCount).toBe(0);
        expect(result.windowDays).toBe(WINDOW_DAYS);
    });

    test("histories with no intervals contribute nothing", () => {
        const result = aggregateForWidget({
            histories: [history(1, []), history(2, [])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.currentlyBlocked).toBe(0);
        expect(result.categories).toEqual([]);
    });
});

describe("aggregateForWidget — currently blocked count (hero)", () => {
    test("counts items with open interval", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-25T00:00:00Z", null, "PM decision")]),
                history(2, [interval("2026-04-26T00:00:00Z", null, "External team dependency")]),
                history(3, [interval("2026-04-10T00:00:00Z", "2026-04-15T00:00:00Z", "PM decision")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.currentlyBlocked).toBe(2);
    });

    test("counts items with untimed tag", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [], { untimedTagPresent: true, isCurrentlyBlocked: true }),
                history(2, [], { untimedTagPresent: true, isCurrentlyBlocked: true }),
                history(3, [interval("2026-04-25T00:00:00Z", null, "PM decision")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.currentlyBlocked).toBe(3);
        expect(result.untimedCount).toBe(2);
    });
});

describe("aggregateForWidget — in-window totals", () => {
    test("sums clipped duration of intervals overlapping the window", () => {
        // Two intervals, each exactly 2 days long, both fully inside window
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-10T00:00:00Z", "2026-04-12T00:00:00Z", "A")]),
                history(2, [interval("2026-04-15T00:00:00Z", "2026-04-17T00:00:00Z", "A")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.inWindow.blockerCount).toBe(2);
        expect(result.inWindow.totalDurationMs).toBe(4 * MS_DAY);
    });

    test("clips intervals that start before the window", () => {
        // Started March 30 → 2 days before window; ended April 5 → 4 days after window start
        // Window contribution: April 1 → April 5 = 4 days
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-03-30T00:00:00Z", "2026-04-05T00:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.inWindow.totalDurationMs).toBe(4 * MS_DAY);
    });

    test("clips intervals that end after the window", () => {
        // April 28 → May 5 → contribution is April 28 to May 1 = 3 days
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-28T00:00:00Z", "2026-05-05T00:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.inWindow.totalDurationMs).toBe(3 * MS_DAY);
    });

    test("excludes intervals entirely before or after the window", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-02-01T00:00:00Z", "2026-02-10T00:00:00Z", "A")]),
                history(2, [interval("2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z", "A")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.inWindow.blockerCount).toBe(0);
        expect(result.inWindow.totalDurationMs).toBe(0);
        expect(result.categories).toEqual([]);
    });

    test("open intervals contribute clipped duration ending at now", () => {
        // Open interval started April 25, now is April 29 12:00 → 4.5 days
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-25T00:00:00Z", null, "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.inWindow.totalDurationMs).toBe(4.5 * MS_DAY);
    });
});

describe("aggregateForWidget — per-category breakdown", () => {
    test("groups intervals by category, sums duration, counts entries", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-10T00:00:00Z", "2026-04-12T00:00:00Z", "PM decision")]),
                history(2, [interval("2026-04-15T00:00:00Z", "2026-04-16T00:00:00Z", "PM decision")]),
                history(3, [interval("2026-04-20T00:00:00Z", "2026-04-25T00:00:00Z", "External team dependency")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        // Sorted by totalDurationMs desc: External (5d) > PM (2+1=3d)
        expect(result.categories.map(c => c.name)).toEqual(["External team dependency", "PM decision"]);
        expect(result.categories[0].count).toBe(1);
        expect(result.categories[0].totalDurationMs).toBe(5 * MS_DAY);
        expect(result.categories[1].count).toBe(2);
        expect(result.categories[1].totalDurationMs).toBe(3 * MS_DAY);
    });

    test("sort by duration desc, then count desc, then name asc as tiebreakers", () => {
        const result = aggregateForWidget({
            histories: [
                // Two categories with the same total duration (1 day each), different counts
                history(1, [interval("2026-04-10T00:00:00Z", "2026-04-11T00:00:00Z", "A")]),
                history(2, [interval("2026-04-12T00:00:00Z", "2026-04-12T12:00:00Z", "B")]),
                history(3, [interval("2026-04-13T00:00:00Z", "2026-04-13T12:00:00Z", "B")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        // A and B tied on duration → B has higher count (2 vs 1) → B first
        expect(result.categories.map(c => c.name)).toEqual(["B", "A"]);
    });

    test("missing category text becomes '(uncategorized)' bucket", () => {
        // Defensive: if a marker had no category text, the timeline produces
        // category="" — aggregator buckets it under (uncategorized) so it
        // doesn't get silently merged into a real category.
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-10T00:00:00Z", "2026-04-11T00:00:00Z", "")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.categories[0].name).toBe("(uncategorized)");
    });

    test("only intervals overlapping the window contribute", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [
                    interval("2026-02-01T00:00:00Z", "2026-02-05T00:00:00Z", "Old category"),
                    interval("2026-04-10T00:00:00Z", "2026-04-12T00:00:00Z", "PM decision")
                ])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.categories.map(c => c.name)).toEqual(["PM decision"]);
    });
});

describe("aggregateForWidget — sparkline (dailyEventCounts)", () => {
    test("array length equals window day count", () => {
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-10T00:00:00Z", "2026-04-11T00:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.categories[0].dailyEventCounts).toHaveLength(WINDOW_DAYS);
    });

    test("block-start events count by day index from window start", () => {
        // April 1 = day 0, April 10 = day 9, April 15 = day 14
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-10T08:00:00Z", "2026-04-11T00:00:00Z", "A")]),
                history(2, [interval("2026-04-10T15:00:00Z", "2026-04-11T00:00:00Z", "A")]),
                history(3, [interval("2026-04-15T11:00:00Z", "2026-04-16T00:00:00Z", "A")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const counts = result.categories[0].dailyEventCounts;
        expect(counts[9]).toBe(2);
        expect(counts[14]).toBe(1);
        const sumElsewhere = counts.reduce((s, n, i) => i === 9 || i === 14 ? s : s + n, 0);
        expect(sumElsewhere).toBe(0);
    });

    test("intervals starting BEFORE the window contribute duration but no sparkline tick", () => {
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-03-25T00:00:00Z", "2026-04-05T00:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.categories[0].totalDurationMs).toBeGreaterThan(0);
        // No tick because start was before window
        expect(result.categories[0].dailyEventCounts.every(n => n === 0)).toBe(true);
    });
});

describe("aggregateForWidget — cumulativeDurationByDay", () => {
    test("array length equals window day count", () => {
        const result = aggregateForWidget({
            histories: [],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.cumulativeDurationByDay).toHaveLength(WINDOW_DAYS);
    });

    test("all-zero series for empty input", () => {
        const result = aggregateForWidget({
            histories: [],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        expect(result.cumulativeDurationByDay.every(v => v === 0)).toBe(true);
    });

    test("monotonically non-decreasing", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-05T00:00:00Z", "2026-04-08T00:00:00Z", "A")]),
                history(2, [interval("2026-04-15T00:00:00Z", "2026-04-20T00:00:00Z", "B")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        for (let i = 1; i < series.length; i++) {
            expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
        }
    });

    test("final element equals inWindow.totalDurationMs", () => {
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-05T00:00:00Z", "2026-04-08T00:00:00Z", "A")]),
                history(2, [interval("2026-04-15T00:00:00Z", "2026-04-20T00:00:00Z", "B")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        expect(series[series.length - 1]).toBe(result.inWindow.totalDurationMs);
    });

    test("interval fully inside one day adds whole duration to that day, plateaus afterward", () => {
        // 2026-04-10 8am → 2pm = 6 hours = day index 9 (April 1 = day 0)
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-10T08:00:00Z", "2026-04-10T14:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        const sixHoursMs = 6 * 60 * 60 * 1000;
        // Days 0-8: zero
        for (let i = 0; i <= 8; i++) expect(series[i]).toBe(0);
        // Day 9 onward: 6 hours
        for (let i = 9; i < WINDOW_DAYS; i++) expect(series[i]).toBe(sixHoursMs);
    });

    test("interval spanning multiple days splits duration by day", () => {
        // April 10 12:00 → April 13 12:00 = 3 days total, distributed across:
        //  - day 9 (April 10): 12 hours (12:00 → midnight)
        //  - day 10 (April 11): 24 hours
        //  - day 11 (April 12): 24 hours
        //  - day 12 (April 13): 12 hours (midnight → 12:00)
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-10T12:00:00Z", "2026-04-13T12:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        const halfDay = 12 * 60 * 60 * 1000;
        const oneDay = 24 * 60 * 60 * 1000;
        expect(series[8]).toBe(0);
        expect(series[9]).toBe(halfDay);
        expect(series[10]).toBe(halfDay + oneDay);
        expect(series[11]).toBe(halfDay + 2 * oneDay);
        expect(series[12]).toBe(halfDay + 2 * oneDay + halfDay);
        // Plateaus from day 12 onward
        for (let i = 13; i < WINDOW_DAYS; i++) expect(series[i]).toBe(series[12]);
    });

    test("intervals starting before window contribute only their in-window portion", () => {
        // March 25 → April 5 → only April 1-5 contributes (4 days)
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-03-25T00:00:00Z", "2026-04-05T00:00:00Z", "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        const oneDay = 24 * 60 * 60 * 1000;
        // Window starts April 1 (day 0); interval covers days 0-3 fully
        expect(series[0]).toBe(oneDay);   // through end of day 0
        expect(series[3]).toBe(4 * oneDay); // through end of day 3 (April 4)
        expect(series[4]).toBe(4 * oneDay); // April 5 contributes 0 — interval ended at midnight April 5
    });

    test("open intervals contribute up to `now`", () => {
        // Open interval started April 25, now is April 29 12:00 → contributes 4.5 days
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-25T00:00:00Z", null, "A")])],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        const oneDay = 24 * 60 * 60 * 1000;
        // April 25 = day 24. End at day 28 12:00 (now).
        expect(series[23]).toBe(0);
        expect(series[24]).toBe(oneDay);    // April 25 fully
        expect(series[27]).toBe(4 * oneDay); // April 28 fully
        expect(series[28]).toBe(4.5 * oneDay); // half of April 29
    });

    test("zero-length window yields empty cumulative series", () => {
        const sameDate = new Date("2026-04-01T00:00:00Z");
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-01T00:00:00Z", null, "A")])],
            windowStart: sameDate,
            windowEnd: sameDate,
            now: NOW
        });
        expect(result.cumulativeDurationByDay).toEqual([]);
    });

    test("multiple overlapping intervals on the same day are summed", () => {
        // Two simultaneous blockers each lasting 3 hours on April 5 → 6 hours total that day
        const result = aggregateForWidget({
            histories: [
                history(1, [interval("2026-04-05T08:00:00Z", "2026-04-05T11:00:00Z", "A")]),
                history(2, [interval("2026-04-05T09:00:00Z", "2026-04-05T12:00:00Z", "B")])
            ],
            windowStart: WINDOW_START,
            windowEnd: WINDOW_END,
            now: NOW
        });
        const series = result.cumulativeDurationByDay;
        const sixHoursMs = 6 * 60 * 60 * 1000;
        expect(series[4]).toBe(sixHoursMs);
    });
});

describe("aggregateForWidget — windowDays", () => {
    test("zero-length window yields zero days and empty sparklines", () => {
        const sameDate = new Date("2026-04-01T00:00:00Z");
        const result = aggregateForWidget({
            histories: [history(1, [interval("2026-04-01T00:00:00Z", null, "A")])],
            windowStart: sameDate,
            windowEnd: sameDate,
            now: NOW
        });
        expect(result.windowDays).toBe(0);
        // Even though the interval is "currently open", a zero-width window
        // means it doesn't overlap — nothing in window
        expect(result.inWindow.blockerCount).toBe(0);
    });

    test("inverted window (end before start) treated as zero days", () => {
        const result = aggregateForWidget({
            histories: [history(1, [])],
            windowStart: new Date("2026-04-15T00:00:00Z"),
            windowEnd: new Date("2026-04-10T00:00:00Z"),
            now: NOW
        });
        expect(result.windowDays).toBe(0);
    });
});

describe("formatDurationDays", () => {
    test("formats round day counts (plural)", () => {
        expect(formatDurationDays(3 * MS_DAY)).toBe("3.0 days");
    });

    test("formats fractional days (plural)", () => {
        expect(formatDurationDays(0.5 * MS_DAY)).toBe("0.5 days");
    });

    test("singular when value rounds to 1.0", () => {
        // 1.0 is in the 0.95-1.04 singular band
        expect(formatDurationDays(1 * MS_DAY)).toBe("1.0 day");
    });

    test("zero or near-zero → '0 days'", () => {
        expect(formatDurationDays(0)).toBe("0 days");
        expect(formatDurationDays(60 * 1000)).toBe("0 days");
    });

    test("respects decimals parameter (plural for 1.23)", () => {
        // 1.23 rounds outside the 0.95-1.04 band → plural
        expect(formatDurationDays(1.234567 * MS_DAY, 2)).toBe("1.23 days");
    });
});
