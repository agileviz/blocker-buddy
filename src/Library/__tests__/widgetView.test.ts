// Unit tests for widgetView.ts pure helpers — buildCategoryRows, canEdit,
// intervalOverlaps, collectMatchingIds, buildBlockerTsv, buildTsvRow,
// sanitizeForTsv. All deterministic via injected `now`.

import {
    buildCategoryRows,
    canEdit,
    intervalOverlaps,
    collectMatchingIds,
    buildBlockerTsv,
    buildTsvRow,
    sanitizeForTsv,
    buildWorkItemUrlPrefix,
    TSV_HEADER,
    CategoryRow
} from "../widgetView";
import { CategoryAggregate } from "../blockerAggregation";
import { WorkItemBlockerHistory, BlockerInterval } from "../blockerEventTimeline";

const NOW = new Date("2026-04-30T12:00:00Z");
const WINDOW_START = new Date("2026-04-01T00:00:00Z");
const WINDOW_END = new Date("2026-05-01T00:00:00Z");

const MS_DAY = 24 * 60 * 60 * 1000;

function aggCategory(name: string, count: number, totalDurationMs: number, dailyEventCounts: number[] = []): CategoryAggregate {
    return { name, count, totalDurationMs, dailyEventCounts };
}

function interval(startIso: string, endIso: string | null, category: string, extras: Partial<BlockerInterval> = {}): BlockerInterval {
    return {
        startDate: new Date(startIso),
        endDate: endIso === null ? null : new Date(endIso),
        category,
        ...extras
    };
}

function history(id: number, intervals: BlockerInterval[], title = `Item ${id}`): WorkItemBlockerHistory {
    const lastOpen = intervals.length > 0 && intervals[intervals.length - 1].endDate === null;
    return {
        workItemId: id,
        title,
        intervals,
        untimedTagPresent: false,
        isCurrentlyBlocked: lastOpen
    };
}

// ─── buildCategoryRows ───────────────────────────────────────────────────

describe("buildCategoryRows — empty inputs", () => {
    test("returns empty array when both inputs are empty", () => {
        expect(buildCategoryRows([], [])).toEqual([]);
    });

    test("only-team-config produces in-config-no-data rows in team order", () => {
        const rows = buildCategoryRows(["A", "B", "C"], []);
        expect(rows).toHaveLength(3);
        expect(rows.map(r => r.state)).toEqual(["in-config-no-data", "in-config-no-data", "in-config-no-data"]);
        expect(rows.map(r => r.name)).toEqual(["A", "B", "C"]);
    });

    test("only-aggregate produces deleted-with-history rows in aggregate order", () => {
        const rows = buildCategoryRows([], [aggCategory("X", 5, 5 * MS_DAY), aggCategory("Y", 2, 1 * MS_DAY)]);
        expect(rows).toHaveLength(2);
        expect(rows.map(r => r.state)).toEqual(["deleted-with-history", "deleted-with-history"]);
        expect(rows.map(r => r.name)).toEqual(["X", "Y"]);
    });
});

describe("buildCategoryRows — three states grouped correctly", () => {
    test("active rows come first (aggregate's duration-desc order preserved)", () => {
        const rows = buildCategoryRows(
            ["A", "B"],
            [aggCategory("B", 5, 5 * MS_DAY), aggCategory("A", 3, 2 * MS_DAY)]
        );
        // Aggregate is sorted by duration desc, so B first then A
        expect(rows.map(r => r.name)).toEqual(["B", "A"]);
        expect(rows.map(r => r.state)).toEqual(["active", "active"]);
    });

    test("active rows use canonical name from team config (preserves casing)", () => {
        const rows = buildCategoryRows(
            ["PM Decision"],
            [aggCategory("pm decision", 1, MS_DAY)]
        );
        expect(rows[0].name).toBe("PM Decision");
        expect(rows[0].state).toBe("active");
    });

    test("active rows carry metrics from aggregate", () => {
        const rows = buildCategoryRows(
            ["A"],
            [aggCategory("A", 7, 12 * MS_DAY, [1, 2, 3])]
        );
        expect(rows[0].metrics).toEqual({
            count: 7,
            totalDurationMs: 12 * MS_DAY,
            dailyEventCounts: [1, 2, 3]
        });
    });

    test("in-config-no-data rows come after active rows, in team config order", () => {
        const rows = buildCategoryRows(
            ["A", "B", "C"],
            [aggCategory("B", 5, 5 * MS_DAY)]
        );
        expect(rows.map(r => r.state)).toEqual(["active", "in-config-no-data", "in-config-no-data"]);
        expect(rows.map(r => r.name)).toEqual(["B", "A", "C"]);
    });

    test("in-config-no-data rows have no metrics", () => {
        const rows = buildCategoryRows(["A"], []);
        expect(rows[0].metrics).toBeUndefined();
    });

    test("deleted-with-history rows come last (after in-config-no-data)", () => {
        const rows = buildCategoryRows(
            ["A", "B"],
            [aggCategory("A", 1, MS_DAY), aggCategory("X-deleted", 9, 9 * MS_DAY)]
        );
        const names = rows.map(r => r.name);
        const states = rows.map(r => r.state);
        expect(names).toEqual(["A", "B", "X-deleted"]);
        expect(states).toEqual(["active", "in-config-no-data", "deleted-with-history"]);
    });

    test("deleted-with-history rows carry metrics from aggregate", () => {
        const rows = buildCategoryRows(
            [],
            [aggCategory("Old category", 4, 3 * MS_DAY, [0, 1, 0])]
        );
        expect(rows[0].state).toBe("deleted-with-history");
        expect(rows[0].metrics).toEqual({
            count: 4,
            totalDurationMs: 3 * MS_DAY,
            dailyEventCounts: [0, 1, 0]
        });
    });

    test("matching is case-insensitive", () => {
        const rows = buildCategoryRows(
            ["pm decision"],
            [aggCategory("PM Decision", 1, MS_DAY)]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe("active");
    });
});

describe("buildCategoryRows — full integration", () => {
    test("active + in-config-no-data + deleted-with-history all in one run", () => {
        const rows = buildCategoryRows(
            ["PM decision", "External team", "New idea"],
            [
                aggCategory("External team", 4, 18 * MS_DAY),
                aggCategory("PM decision", 7, 12 * MS_DAY),
                aggCategory("Stale-removed", 2, 8 * MS_DAY)
            ]
        );
        expect(rows.map(r => ({ name: r.name, state: r.state }))).toEqual([
            { name: "External team", state: "active" },
            { name: "PM decision", state: "active" },
            { name: "New idea", state: "in-config-no-data" },
            { name: "Stale-removed", state: "deleted-with-history" }
        ]);
    });
});

// ─── canEdit ────────────────────────────────────────────────────────────

describe("canEdit", () => {
    test("admin always edits", () => {
        expect(canEdit(true, false)).toBe(true);
        expect(canEdit(true, true)).toBe(true);
    });

    test("non-admin gated by allowMemberEdit", () => {
        expect(canEdit(false, false)).toBe(false);
        expect(canEdit(false, true)).toBe(true);
    });
});

// ─── intervalOverlaps ───────────────────────────────────────────────────

describe("intervalOverlaps", () => {
    test("interval fully inside window → overlaps", () => {
        const i = interval("2026-04-10T00:00:00Z", "2026-04-15T00:00:00Z", "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(true);
    });

    test("interval entirely before window → no overlap", () => {
        const i = interval("2026-03-10T00:00:00Z", "2026-03-20T00:00:00Z", "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(false);
    });

    test("interval entirely after window → no overlap", () => {
        const i = interval("2026-05-10T00:00:00Z", "2026-05-15T00:00:00Z", "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(false);
    });

    test("interval straddles window start → overlaps", () => {
        const i = interval("2026-03-25T00:00:00Z", "2026-04-05T00:00:00Z", "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(true);
    });

    test("interval straddles window end → overlaps", () => {
        const i = interval("2026-04-25T00:00:00Z", "2026-05-05T00:00:00Z", "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(true);
    });

    test("open interval treats end as `now` and overlaps if now is in window", () => {
        const i = interval("2026-04-25T00:00:00Z", null, "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(true);
    });

    test("open interval starting after window end does not overlap", () => {
        const i = interval("2026-05-15T00:00:00Z", null, "x");
        const futureNow = new Date("2026-05-20T00:00:00Z");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, futureNow)).toBe(false);
    });

    test("interval ending exactly at window start → no overlap (half-open)", () => {
        const i = interval("2026-03-30T00:00:00Z", "2026-04-01T00:00:00Z", "x");
        expect(intervalOverlaps(i, WINDOW_START, WINDOW_END, NOW)).toBe(false);
    });
});

// ─── collectMatchingIds ─────────────────────────────────────────────────

describe("collectMatchingIds", () => {
    const histories: WorkItemBlockerHistory[] = [
        history(101, [interval("2026-04-10T00:00:00Z", "2026-04-12T00:00:00Z", "PM decision")]),
        history(102, [interval("2026-04-15T00:00:00Z", "2026-04-18T00:00:00Z", "External team")]),
        history(103, [
            interval("2026-04-05T00:00:00Z", "2026-04-07T00:00:00Z", "PM decision"),
            interval("2026-04-20T00:00:00Z", null, "External team")
        ]),
        history(104, [interval("2026-03-10T00:00:00Z", "2026-03-12T00:00:00Z", "PM decision")])  // outside window
    ];

    test("no filters → returns all unique IDs with intervals", () => {
        const ids = collectMatchingIds(histories, null, null, null, NOW);
        expect(new Set(ids)).toEqual(new Set([101, 102, 103, 104]));
    });

    test("category filter narrows by category (case-insensitive)", () => {
        const ids = collectMatchingIds(histories, "pm decision", null, null, NOW);
        expect(new Set(ids)).toEqual(new Set([101, 103, 104]));
    });

    test("window filter narrows by overlap with window", () => {
        const ids = collectMatchingIds(histories, null, WINDOW_START, WINDOW_END, NOW);
        expect(new Set(ids)).toEqual(new Set([101, 102, 103]));  // 104 is outside window
    });

    test("category + window filters compose", () => {
        const ids = collectMatchingIds(histories, "pm decision", WINDOW_START, WINDOW_END, NOW);
        expect(new Set(ids)).toEqual(new Set([101, 103]));  // 104 is outside window
    });

    test("each work item included at most once even with multiple matching intervals", () => {
        const id103WithDupes: WorkItemBlockerHistory = history(103, [
            interval("2026-04-05T00:00:00Z", "2026-04-07T00:00:00Z", "PM decision"),
            interval("2026-04-09T00:00:00Z", "2026-04-11T00:00:00Z", "PM decision"),
            interval("2026-04-15T00:00:00Z", "2026-04-17T00:00:00Z", "PM decision")
        ]);
        const ids = collectMatchingIds([id103WithDupes], "pm decision", null, null, NOW);
        expect(ids).toEqual([103]);
    });

    test("empty histories returns empty array", () => {
        expect(collectMatchingIds([], null, null, null, NOW)).toEqual([]);
    });

    test("category filter that matches nothing returns empty", () => {
        const ids = collectMatchingIds(histories, "doesnt exist", null, null, NOW);
        expect(ids).toEqual([]);
    });
});

// ─── sanitizeForTsv ─────────────────────────────────────────────────────

describe("sanitizeForTsv", () => {
    test("preserves normal text", () => {
        expect(sanitizeForTsv("PM decision: needs review")).toBe("PM decision: needs review");
    });

    test("strips tabs", () => {
        expect(sanitizeForTsv("a\tb\tc")).toBe("a b c");
    });

    test("strips newlines and carriage returns", () => {
        expect(sanitizeForTsv("line1\nline2")).toBe("line1 line2");
        expect(sanitizeForTsv("a\r\nb")).toBe("a b");
    });

    test("collapses multiple whitespace chars to single space", () => {
        expect(sanitizeForTsv("a\t\t\tb")).toBe("a b");
        expect(sanitizeForTsv("a\n\n\nb")).toBe("a b");
    });

    test("trims leading/trailing whitespace", () => {
        expect(sanitizeForTsv("  trimmed  ")).toBe("trimmed");
    });

    test("empty stays empty", () => {
        expect(sanitizeForTsv("")).toBe("");
    });
});

// ─── buildTsvRow ────────────────────────────────────────────────────────

describe("buildTsvRow", () => {
    test("emits 7 tab-separated cells in correct order", () => {
        const h = history(42, [], "Build pipeline failing");
        const i = interval("2026-04-10T08:00:00Z", "2026-04-12T16:00:00Z", "PM decision");
        const row = buildTsvRow(h, i, "https://example.com/", NOW);
        const cells = row.split("\t");
        expect(cells).toHaveLength(7);
        expect(cells[0]).toBe("42");
        expect(cells[1]).toBe("Build pipeline failing");
        expect(cells[2]).toBe("PM decision");
        expect(cells[3]).toBe("2026-04-10");
        expect(cells[4]).toBe("2026-04-12");
        // Duration: 2.33 days (2 days 8 hours)
        expect(parseFloat(cells[5])).toBeCloseTo(2.33, 1);
        expect(cells[6]).toBe("https://example.com/42");
    });

    test("open interval shows '(open)' as unblock date and uses now for duration", () => {
        const h = history(7, [], "Some item");
        const i = interval("2026-04-25T00:00:00Z", null, "External team");
        const row = buildTsvRow(h, i, "", NOW);
        const cells = row.split("\t");
        expect(cells[4]).toBe("(open)");
        expect(parseFloat(cells[5])).toBeCloseTo(5.5, 1);
    });

    test("empty url prefix produces empty URL cell", () => {
        const h = history(1, [], "x");
        const i = interval("2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", "A");
        const row = buildTsvRow(h, i, "", NOW);
        const cells = row.split("\t");
        expect(cells[6]).toBe("");
    });

    test("title and category with tab/newline are sanitized", () => {
        const h = history(1, [], "title\twith\ttabs");
        const i = interval("2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", "cat\nwith\nnewlines");
        const row = buildTsvRow(h, i, "", NOW);
        const cells = row.split("\t");
        expect(cells[1]).toBe("title with tabs");
        expect(cells[2]).toBe("cat with newlines");
    });

    test("undefined title becomes empty string", () => {
        const h: WorkItemBlockerHistory = {
            workItemId: 1,
            intervals: [],
            untimedTagPresent: false,
            isCurrentlyBlocked: false
        };
        const i = interval("2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", "A");
        const row = buildTsvRow(h, i, "", NOW);
        const cells = row.split("\t");
        expect(cells[1]).toBe("");
    });
});

// ─── buildBlockerTsv ────────────────────────────────────────────────────

describe("buildBlockerTsv", () => {
    const histories: WorkItemBlockerHistory[] = [
        history(101, [interval("2026-04-10T00:00:00Z", "2026-04-12T00:00:00Z", "PM decision")]),
        history(102, [interval("2026-04-15T00:00:00Z", "2026-04-18T00:00:00Z", "External team")]),
        history(103, [
            interval("2026-04-05T00:00:00Z", "2026-04-07T00:00:00Z", "PM decision"),
            interval("2026-04-20T00:00:00Z", null, "External team")
        ])
    ];

    test("returns empty string when no rows match", () => {
        expect(buildBlockerTsv([], null, null, null, "", NOW)).toBe("");
        expect(buildBlockerTsv(histories, "no-such-cat", null, null, "", NOW)).toBe("");
    });

    test("first line is the header", () => {
        const tsv = buildBlockerTsv(histories, null, null, null, "", NOW);
        expect(tsv.split("\n")[0]).toBe(TSV_HEADER);
    });

    test("header has the expected 7 columns", () => {
        expect(TSV_HEADER).toBe("ID\tTitle\tCategory\tBlockDate\tUnblockDate\tDurationDays\tURL");
    });

    test("no Context column in header", () => {
        expect(TSV_HEADER).not.toContain("Context");
    });

    test("category filter narrows rows", () => {
        const tsv = buildBlockerTsv(histories, "pm decision", null, null, "", NOW);
        const lines = tsv.split("\n");
        // Header + 2 PM-decision intervals (101 and 103's first interval)
        expect(lines).toHaveLength(3);
        expect(lines[1].split("\t")[0]).toBe("101");
        expect(lines[2].split("\t")[0]).toBe("103");
    });

    test("window filter narrows rows", () => {
        const tightWindow = { start: new Date("2026-04-10T00:00:00Z"), end: new Date("2026-04-13T00:00:00Z") };
        const tsv = buildBlockerTsv(histories, null, tightWindow.start, tightWindow.end, "", NOW);
        const lines = tsv.split("\n");
        // Only 101's interval (Apr 10–12) overlaps Apr 10–13
        expect(lines).toHaveLength(2);
        expect(lines[1].split("\t")[0]).toBe("101");
    });

    test("emits one row per matching interval (multi-interval items can repeat)", () => {
        const tsv = buildBlockerTsv(histories, null, null, null, "", NOW);
        const lines = tsv.split("\n").slice(1);  // skip header
        // 101: 1 interval, 102: 1, 103: 2 → 4 rows total
        expect(lines).toHaveLength(4);
    });

    test("URL column uses urlPrefix + workItemId", () => {
        const tsv = buildBlockerTsv(
            [history(7, [interval("2026-04-10T00:00:00Z", "2026-04-11T00:00:00Z", "x")])],
            null, null, null,
            "https://dev.azure.com/myorg/myproj/_workitems/edit/",
            NOW
        );
        const lines = tsv.split("\n");
        const urlCell = lines[1].split("\t")[6];
        expect(urlCell).toBe("https://dev.azure.com/myorg/myproj/_workitems/edit/7");
    });
});

// ─── buildWorkItemUrlPrefix ─────────────────────────────────────────────

describe("buildWorkItemUrlPrefix", () => {
    test("constructs the standard ADO work-item edit URL prefix", () => {
        expect(buildWorkItemUrlPrefix("myorg", "myproj")).toBe(
            "https://dev.azure.com/myorg/myproj/_workitems/edit/"
        );
    });

    test("URL-encodes org and project names with special characters", () => {
        expect(buildWorkItemUrlPrefix("my org", "my proj")).toBe(
            "https://dev.azure.com/my%20org/my%20proj/_workitems/edit/"
        );
    });

    test("returns empty string when org is missing", () => {
        expect(buildWorkItemUrlPrefix("", "myproj")).toBe("");
    });

    test("returns empty string when project is missing", () => {
        expect(buildWorkItemUrlPrefix("myorg", "")).toBe("");
    });

    test("returns empty string when both are missing", () => {
        expect(buildWorkItemUrlPrefix("", "")).toBe("");
    });
});
