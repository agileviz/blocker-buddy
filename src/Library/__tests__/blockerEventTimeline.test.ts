// Unit tests for the blocker event timeline builder. All tests use injected
// `now` so they're deterministic across timezones.

import {
    buildWorkItemBlockerHistory,
    intervalOverlapsWindow,
    CommentInput
} from "../blockerEventTimeline";

const NOW = new Date("2026-04-29T12:00:00Z");

function comment(text: string, isoDate: string): CommentInput {
    return { text, createdDate: new Date(isoDate) };
}

describe("buildWorkItemBlockerHistory — empty cases", () => {
    test("no comments + not tagged → empty history, not blocked", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.intervals).toEqual([]);
        expect(h.untimedTagPresent).toBe(false);
        expect(h.isCurrentlyBlocked).toBe(false);
    });

    test("no comments + tagged → no intervals, untimed=true, currently blocked", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.intervals).toEqual([]);
        expect(h.untimedTagPresent).toBe(true);
        expect(h.isCurrentlyBlocked).toBe(true);
    });

    test("non-marker comments + tagged → still untimed", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("Just a regular comment", "2026-04-20T10:00:00Z"),
                comment("Another non-marker", "2026-04-25T10:00:00Z")
            ],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.intervals).toEqual([]);
        expect(h.untimedTagPresent).toBe(true);
        expect(h.isCurrentlyBlocked).toBe(true);
    });
});

describe("buildWorkItemBlockerHistory — single open block", () => {
    test("Block marker + tagged → one open interval, not untimed, currently blocked", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 42,
            title: "Build pipeline failing",
            comments: [comment("BlockerBuddy: Blocked - PM decision", "2026-04-25T10:00:00Z")],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.workItemId).toBe(42);
        expect(h.title).toBe("Build pipeline failing");
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0]).toEqual({
            startDate: new Date("2026-04-25T10:00:00Z"),
            endDate: null,
            category: "PM decision"
        });
        expect(h.untimedTagPresent).toBe(false);
        expect(h.isCurrentlyBlocked).toBe(true);
    });

});

describe("buildWorkItemBlockerHistory — closed block/unblock pairs", () => {
    test("simple block → unblock pair, no longer tagged", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Blocked - PM decision", "2026-04-20T10:00:00Z"),
                comment("BlockerBuddy: Unblocked (PM decision)", "2026-04-22T15:00:00Z")
            ],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0]).toEqual({
            startDate: new Date("2026-04-20T10:00:00Z"),
            endDate: new Date("2026-04-22T15:00:00Z"),
            category: "PM decision"
        });
        expect(h.isCurrentlyBlocked).toBe(false);
    });

    test("closed block/unblock pair + currently tagged → counts as currently blocked (untimed)", () => {
        // Real-world scenario this guards: item went through a BB cycle (closed
        // interval), then the Blocked tag was re-applied without a new BB block
        // — either a manual board edit, a bulk operation, or the current block
        // comment was edited and is now invisible to the parser. The board
        // counts the item as blocked (it has the tag); the BB widget should
        // agree (untimed since last unblock, but currently blocked). Earlier
        // logic required `intervals.length === 0` for untimedTagPresent, which
        // missed this case — the bug surfaced as "6 on board / 5 in BB widget"
        // discrepancies for items with history.
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Blocked - PM decision", "2026-04-20T10:00:00Z"),
                comment("BlockerBuddy: Unblocked (PM decision)", "2026-04-22T15:00:00Z")
            ],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0].endDate).not.toBeNull();  // closed interval
        expect(h.untimedTagPresent).toBe(true);  // tag present + no open BB tracking
        expect(h.isCurrentlyBlocked).toBe(true);  // counted in hero "blocked now"
    });

    test("multiple closed pairs in chronological order", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Blocked - External team dependency", "2026-04-10T09:00:00Z"),
                comment("BlockerBuddy: Unblocked (External team dependency)", "2026-04-12T09:00:00Z"),
                comment("BlockerBuddy: Blocked - Missing requirements", "2026-04-20T11:00:00Z"),
                comment("BlockerBuddy: Unblocked (Missing requirements)", "2026-04-23T11:00:00Z")
            ],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.intervals).toHaveLength(2);
        expect(h.intervals[0].category).toBe("External team dependency");
        expect(h.intervals[1].category).toBe("Missing requirements");
    });

    test("re-blocked after unblock — currently open", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Blocked - PM decision", "2026-04-10T09:00:00Z"),
                comment("BlockerBuddy: Unblocked (PM decision)", "2026-04-12T09:00:00Z"),
                comment("BlockerBuddy: Blocked - External team dependency", "2026-04-25T11:00:00Z")
            ],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.intervals).toHaveLength(2);
        expect(h.intervals[0].endDate).toEqual(new Date("2026-04-12T09:00:00Z"));
        expect(h.intervals[1].endDate).toBeNull();
        expect(h.isCurrentlyBlocked).toBe(true);
    });

    test("input comments in reverse order — sorted internally before building", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Unblocked (PM decision)", "2026-04-12T09:00:00Z"),
                comment("BlockerBuddy: Blocked - PM decision", "2026-04-10T09:00:00Z")
            ],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0].startDate).toEqual(new Date("2026-04-10T09:00:00Z"));
        expect(h.intervals[0].endDate).toEqual(new Date("2026-04-12T09:00:00Z"));
    });
});

describe("buildWorkItemBlockerHistory — data correction edge cases", () => {
    test("two block markers without intervening unblock → first is dropped (no end can be inferred without inflating the period)", () => {
        // Symmetric with the orphan-unblock case below: when a marker can't be
        // paired with its counterpart, the unpaired interval is dropped rather
        // than synthesized with an invented timestamp. Better no data than
        // wrong data — see blockerEventTimeline.ts for rationale.
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Blocked - PM decision", "2026-04-20T09:00:00Z"),
                comment("BlockerBuddy: Blocked - External team dependency", "2026-04-22T09:00:00Z")
            ],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0].category).toBe("External team dependency");
        expect(h.intervals[0].endDate).toBeNull();
    });

    test("orphan unblock (no preceding block) is silently dropped", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("BlockerBuddy: Unblocked (PM decision)", "2026-04-10T09:00:00Z"),
                comment("BlockerBuddy: Blocked - Missing requirements", "2026-04-20T09:00:00Z")
            ],
            currentlyTagged: true,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0].category).toBe("Missing requirements");
        expect(h.intervals[0].endDate).toBeNull();
    });

    test("non-marker comments interleaved with markers are ignored", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [
                comment("Some manual note", "2026-04-09T09:00:00Z"),
                comment("BlockerBuddy: Blocked - PM decision", "2026-04-10T09:00:00Z"),
                comment("Another manual note", "2026-04-11T09:00:00Z"),
                comment("BlockerBuddy: Unblocked (PM decision)", "2026-04-12T09:00:00Z"),
                comment("Closing comment", "2026-04-13T09:00:00Z")
            ],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0].category).toBe("PM decision");
    });

    test("currently NOT tagged but has open marker → still reports the open interval as such (data corruption surfaces honestly)", () => {
        // User manually removed the tag without going through the unblock flow.
        // We don't synthesize an end timestamp — leaving endDate=null is the
        // honest signal that the marker history is inconsistent with tag state.
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [comment("BlockerBuddy: Blocked - PM decision", "2026-04-25T10:00:00Z")],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.intervals).toHaveLength(1);
        expect(h.intervals[0].endDate).toBeNull();
        expect(h.untimedTagPresent).toBe(false);
        // hasOpenInterval drives isCurrentlyBlocked — open marker still counts
        expect(h.isCurrentlyBlocked).toBe(true);
    });
});

describe("buildWorkItemBlockerHistory — workItemId / title preservation", () => {
    test("workItemId always present", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 7777,
            comments: [],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.workItemId).toBe(7777);
    });

    test("title omitted when not provided", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            comments: [],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.title).toBeUndefined();
    });

    test("title preserved when provided", () => {
        const h = buildWorkItemBlockerHistory({
            workItemId: 1,
            title: "Some PBI",
            comments: [],
            currentlyTagged: false,
            now: NOW
        });
        expect(h.title).toBe("Some PBI");
    });
});

describe("intervalOverlapsWindow", () => {
    const winStart = new Date("2026-04-01T00:00:00Z");
    const winEnd = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-04-29T12:00:00Z");

    test("interval entirely inside window → true", () => {
        expect(intervalOverlapsWindow(
            { startDate: new Date("2026-04-10T00:00:00Z"), endDate: new Date("2026-04-15T00:00:00Z"), category: "x" },
            winStart, winEnd, now
        )).toBe(true);
    });

    test("interval entirely before window → false", () => {
        expect(intervalOverlapsWindow(
            { startDate: new Date("2026-03-01T00:00:00Z"), endDate: new Date("2026-03-10T00:00:00Z"), category: "x" },
            winStart, winEnd, now
        )).toBe(false);
    });

    test("interval entirely after window → false", () => {
        expect(intervalOverlapsWindow(
            { startDate: new Date("2026-05-10T00:00:00Z"), endDate: new Date("2026-05-15T00:00:00Z"), category: "x" },
            winStart, winEnd, now
        )).toBe(false);
    });

    test("interval starts before, ends inside → overlaps", () => {
        expect(intervalOverlapsWindow(
            { startDate: new Date("2026-03-25T00:00:00Z"), endDate: new Date("2026-04-05T00:00:00Z"), category: "x" },
            winStart, winEnd, now
        )).toBe(true);
    });

    test("interval starts inside, ends after → overlaps", () => {
        expect(intervalOverlapsWindow(
            { startDate: new Date("2026-04-25T00:00:00Z"), endDate: new Date("2026-05-05T00:00:00Z"), category: "x" },
            winStart, winEnd, now
        )).toBe(true);
    });

    test("open interval (endDate=null) treated as ending at now", () => {
        // Open interval starting Apr 25, now is Apr 29 — overlaps window
        expect(intervalOverlapsWindow(
            { startDate: new Date("2026-04-25T00:00:00Z"), endDate: null, category: "x" },
            winStart, winEnd, now
        )).toBe(true);
    });
});
