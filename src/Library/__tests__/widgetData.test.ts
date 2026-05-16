// Tests for the widgetData.ts pure helpers. The orchestrator fetchWidgetData
// is SDK-dependent and tested via dev install; only the pure window helper
// gets unit-tested here.

import { buildRollingWindow } from "../widgetData";

const MS_DAY = 24 * 60 * 60 * 1000;

describe("buildRollingWindow", () => {
    test("windowEnd is the next UTC midnight after `now`", () => {
        const now = new Date("2026-04-29T15:30:00Z");
        const { windowEnd } = buildRollingWindow(30, now);
        expect(windowEnd.toISOString()).toBe("2026-04-30T00:00:00.000Z");
    });

    test("windowStart is exactly `days` days before windowEnd", () => {
        const now = new Date("2026-04-29T15:30:00Z");
        const { windowStart, windowEnd } = buildRollingWindow(30, now);
        expect(windowEnd.getTime() - windowStart.getTime()).toBe(30 * MS_DAY);
    });

    test("works for 60 / 90 / 120 day windows", () => {
        const now = new Date("2026-04-29T15:30:00Z");
        for (const days of [60, 90, 120]) {
            const { windowStart, windowEnd } = buildRollingWindow(days, now);
            expect(windowEnd.getTime() - windowStart.getTime()).toBe(days * MS_DAY);
        }
    });

    test("when now is at exact UTC midnight, windowEnd is +1 day (today still included)", () => {
        const now = new Date("2026-04-29T00:00:00Z");
        const { windowEnd } = buildRollingWindow(30, now);
        expect(windowEnd.toISOString()).toBe("2026-04-30T00:00:00.000Z");
    });

    test("zero-day window has start === end", () => {
        const now = new Date("2026-04-29T15:30:00Z");
        const { windowStart, windowEnd } = buildRollingWindow(0, now);
        expect(windowStart.getTime()).toBe(windowEnd.getTime());
    });
});
