// Unit tests for teamConfig.ts pure helpers (sanitization, tag validation,
// marker construction, and marker parsing). The SDK-dependent functions
// (getTeamConfig, setTeamConfig) are not tested here — the AMD stub keeps
// them silent at module load and they're integration-tested via dev install.

import {
    sanitizeReasonText,
    validateTagName,
    validateCategoryName,
    buildBlockMarker,
    buildUnblockMarker,
    parseMarker,
    DEFAULT_CONFIG,
    STARTER_CATEGORIES,
    WINDOW_OPTIONS,
    ALL_TIME_DAYS,
    DEFAULT_WINDOW_DAYS,
    resolveWindowDays,
    formatWindowLabel
} from "../teamConfig";

describe("DEFAULT_CONFIG", () => {
    test("has the locked default values", () => {
        expect(DEFAULT_CONFIG).toEqual({
            tagName: "Blocked",
            categories: [],
            allowMemberEdit: false,
            selectedWindowDays: 14
        });
    });
});

describe("WINDOW_OPTIONS", () => {
    test("contains the locked six window options (14 first, sprint-aligned default)", () => {
        expect(WINDOW_OPTIONS.map(o => o.days)).toEqual([14, 30, 60, 90, 120, ALL_TIME_DAYS]);
    });

    test("All time option uses ALL_TIME_DAYS sentinel and 'All time' label", () => {
        const allTime = WINDOW_OPTIONS.find(o => o.days === ALL_TIME_DAYS);
        expect(allTime).toBeDefined();
        expect(allTime!.label).toBe("All time");
    });

    test("DEFAULT_WINDOW_DAYS appears in WINDOW_OPTIONS", () => {
        expect(WINDOW_OPTIONS.some(o => o.days === DEFAULT_WINDOW_DAYS)).toBe(true);
    });

    test("DEFAULT_WINDOW_DAYS is 14 (one 2-week sprint)", () => {
        expect(DEFAULT_WINDOW_DAYS).toBe(14);
    });
});

describe("resolveWindowDays", () => {
    test("returns DEFAULT_WINDOW_DAYS for undefined", () => {
        expect(resolveWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    });

    test("returns the value when it matches a known option", () => {
        expect(resolveWindowDays(14)).toBe(14);
        expect(resolveWindowDays(30)).toBe(30);
        expect(resolveWindowDays(60)).toBe(60);
        expect(resolveWindowDays(90)).toBe(90);
        expect(resolveWindowDays(120)).toBe(120);
        expect(resolveWindowDays(ALL_TIME_DAYS)).toBe(ALL_TIME_DAYS);
    });

    test("falls back to default for unrecognized values (e.g., schema drift, manual config edit)", () => {
        expect(resolveWindowDays(45)).toBe(DEFAULT_WINDOW_DAYS);
        expect(resolveWindowDays(-1)).toBe(DEFAULT_WINDOW_DAYS);
        expect(resolveWindowDays(0)).toBe(DEFAULT_WINDOW_DAYS);
    });
});

describe("formatWindowLabel", () => {
    test("standard windows render as 'Last N days'", () => {
        expect(formatWindowLabel(14)).toBe("Last 14 days");
        expect(formatWindowLabel(30)).toBe("Last 30 days");
        expect(formatWindowLabel(120)).toBe("Last 120 days");
    });

    test("ALL_TIME_DAYS renders as 'All time'", () => {
        expect(formatWindowLabel(ALL_TIME_DAYS)).toBe("All time");
    });
});

describe("STARTER_CATEGORIES", () => {
    test("contains the locked v7 starter set", () => {
        expect(STARTER_CATEGORIES).toEqual([
            "Product decision",
            "Technical decision",
            "External dependency",
            "Stakeholder decision",
            "Review or approval",
            "Tooling or environment"
        ]);
    });

    test("is non-empty", () => {
        expect(STARTER_CATEGORIES.length).toBeGreaterThan(0);
    });
});

describe("sanitizeReasonText", () => {
    test("returns empty string for empty/null/undefined input", () => {
        expect(sanitizeReasonText("")).toBe("");
        expect(sanitizeReasonText(null)).toBe("");
        expect(sanitizeReasonText(undefined)).toBe("");
    });

    test("preserves normal text unchanged", () => {
        expect(sanitizeReasonText("PM decision")).toBe("PM decision");
        expect(sanitizeReasonText("Waiting on Greg")).toBe("Waiting on Greg");
    });

    test("strips parens (collide with unblock marker wrapping)", () => {
        expect(sanitizeReasonText("(API team) unavailable")).toBe("API team unavailable");
        expect(sanitizeReasonText("Need approval (urgent)")).toBe("Need approval urgent");
    });

    test("strips pipes (collide with category-context separator)", () => {
        expect(sanitizeReasonText("PM | decision")).toBe("PM decision");
        expect(sanitizeReasonText("a|b|c")).toBe("a b c");
    });

    test("strips newlines and tabs", () => {
        expect(sanitizeReasonText("line one\nline two")).toBe("line one line two");
        expect(sanitizeReasonText("col1\tcol2")).toBe("col1 col2");
        expect(sanitizeReasonText("a\r\nb")).toBe("a b");
    });

    test("collapses multiple spaces to single space", () => {
        expect(sanitizeReasonText("a    b   c")).toBe("a b c");
    });

    test("trims leading/trailing whitespace", () => {
        expect(sanitizeReasonText("  spaced  ")).toBe("spaced");
        expect(sanitizeReasonText("\t\nleading\n\t")).toBe("leading");
    });

    test("caps at 300 characters", () => {
        const long = "x".repeat(500);
        const out = sanitizeReasonText(long);
        expect(out.length).toBe(300);
    });

    test("handles input that becomes empty after stripping", () => {
        expect(sanitizeReasonText("()|")).toBe("");
        expect(sanitizeReasonText("  ()  ")).toBe("");
    });
});

describe("validateTagName", () => {
    test("accepts default 'Blocked'", () => {
        expect(validateTagName("Blocked")).toEqual({ ok: true });
    });

    test("accepts other valid tag names", () => {
        expect(validateTagName("Impediment")).toEqual({ ok: true });
        expect(validateTagName("blocker-buddy")).toEqual({ ok: true });
        expect(validateTagName("Waiting On Approval")).toEqual({ ok: true });
    });

    test("rejects empty/whitespace-only input", () => {
        expect(validateTagName("").ok).toBe(false);
        expect(validateTagName("   ").ok).toBe(false);
        expect(validateTagName(undefined).ok).toBe(false);
        expect(validateTagName(null).ok).toBe(false);
    });

    test("rejects commas (ADO tag rule)", () => {
        const result = validateTagName("Block,ed");
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/comma/i);
    });

    test("rejects semicolons (ADO tag rule)", () => {
        const result = validateTagName("Block;ed");
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/semicolon/i);
    });

    test("rejects names starting with @ (ADO tag rule)", () => {
        const result = validateTagName("@Blocked");
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/@/);
    });

    test("accepts @ that's not at the start", () => {
        expect(validateTagName("blocked@ext").ok).toBe(true);
    });

    test("rejects names longer than 50 characters", () => {
        const long = "x".repeat(51);
        const result = validateTagName(long);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/50/);
    });

    test("accepts names exactly 50 characters", () => {
        const exact = "x".repeat(50);
        expect(validateTagName(exact)).toEqual({ ok: true });
    });

    test("trims before validating length and emptiness", () => {
        expect(validateTagName("  Blocked  ")).toEqual({ ok: true });
        // 50 chars + leading/trailing whitespace is still valid because trim happens first
        expect(validateTagName("  " + "x".repeat(50) + "  ")).toEqual({ ok: true });
    });

    test("preserves case (no normalization)", () => {
        // Validation doesn't transform — caller responsible for storing as-typed
        expect(validateTagName("BLOCKED")).toEqual({ ok: true });
        expect(validateTagName("blocked")).toEqual({ ok: true });
        expect(validateTagName("BlOcKeD")).toEqual({ ok: true });
    });
});

describe("validateCategoryName", () => {
    test("accepts a normal category", () => {
        expect(validateCategoryName("Waiting on PM decision")).toEqual({ ok: true });
    });

    test("accepts categories that include the starter set", () => {
        for (const c of STARTER_CATEGORIES) {
            expect(validateCategoryName(c)).toEqual({ ok: true });
        }
    });

    test("rejects empty/whitespace-only input", () => {
        expect(validateCategoryName("").ok).toBe(false);
        expect(validateCategoryName("   ").ok).toBe(false);
        expect(validateCategoryName(null).ok).toBe(false);
        expect(validateCategoryName(undefined).ok).toBe(false);
    });

    test("trims before validating", () => {
        expect(validateCategoryName("  Waiting  ")).toEqual({ ok: true });
    });

    test("rejects names longer than 50 characters", () => {
        const long = "x".repeat(51);
        const result = validateCategoryName(long);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/50/);
    });

    test("accepts names exactly 50 characters", () => {
        expect(validateCategoryName("x".repeat(50))).toEqual({ ok: true });
    });

    // The marker format uses '(', ')', and '|' as structural characters; if a
    // category contained any of them, sanitizeReasonText would silently strip
    // them at marker-write time, producing markers whose category text differs
    // from the canonical category. Reject at create time so the two stay aligned.
    test("rejects parens (collide with unblock marker wrapping)", () => {
        const r1 = validateCategoryName("(API team)");
        expect(r1.ok).toBe(false);
        expect(r1.error).toMatch(/[()|]/);
        expect(validateCategoryName("Need approval (urgent)").ok).toBe(false);
    });

    test("rejects pipes (collide with category-context separator)", () => {
        const r = validateCategoryName("PM | decision");
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/[()|]/);
    });

    test("rejects line breaks and tabs", () => {
        expect(validateCategoryName("a\nb").ok).toBe(false);
        expect(validateCategoryName("a\tb").ok).toBe(false);
        expect(validateCategoryName("a\r\nb").ok).toBe(false);
    });

    test("rejects case-insensitive duplicates of an existing category", () => {
        const existing = ["Waiting on PM decision", "External team dependency"];
        const r = validateCategoryName("waiting on pm decision", existing);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/already exists/i);
    });

    test("ignores trim/whitespace differences when checking duplicates", () => {
        expect(validateCategoryName("  Product decision  ", ["Product decision"]).ok).toBe(false);
    });

    test("treats undefined existingCategories as empty list", () => {
        expect(validateCategoryName("Anything")).toEqual({ ok: true });
    });

    test("accepts a name that happens to be a substring of an existing one", () => {
        // "PM" is a substring of "PM decision" but isn't a duplicate.
        expect(validateCategoryName("PM", ["PM decision"])).toEqual({ ok: true });
    });
});

describe("buildBlockMarker", () => {
    test("category only — no context", () => {
        expect(buildBlockMarker("PM decision")).toBe("BlockerBuddy: Blocked - PM decision");
    });

    test("category + context joined by ' | '", () => {
        expect(buildBlockMarker("PM decision", "Greg specifically")).toBe(
            "BlockerBuddy: Blocked - PM decision | Greg specifically"
        );
    });

    test("Other category with required context", () => {
        expect(buildBlockMarker("Other", "legacy migration timing")).toBe(
            "BlockerBuddy: Blocked - Other | legacy migration timing"
        );
    });

    test("sanitizes parens in category and context", () => {
        expect(buildBlockMarker("(API team) issue", "(critical)")).toBe(
            "BlockerBuddy: Blocked - API team issue | critical"
        );
    });

    test("sanitizes pipes in inputs", () => {
        expect(buildBlockMarker("a|b", "c|d")).toBe("BlockerBuddy: Blocked - a b | c d");
    });

    test("treats undefined/empty context as no-context form", () => {
        expect(buildBlockMarker("PM decision", undefined)).toBe("BlockerBuddy: Blocked - PM decision");
        expect(buildBlockMarker("PM decision", "")).toBe("BlockerBuddy: Blocked - PM decision");
        expect(buildBlockMarker("PM decision", "   ")).toBe("BlockerBuddy: Blocked - PM decision");
    });
});

describe("buildUnblockMarker", () => {
    test("no original, no resolution", () => {
        expect(buildUnblockMarker()).toBe("BlockerBuddy: Unblocked");
        expect(buildUnblockMarker(undefined, undefined, undefined)).toBe("BlockerBuddy: Unblocked");
    });

    test("original category only", () => {
        expect(buildUnblockMarker("PM decision")).toBe("BlockerBuddy: Unblocked (PM decision)");
    });

    test("original category + context (pipe inserted structurally)", () => {
        expect(buildUnblockMarker("PM decision", "Greg specifically")).toBe(
            "BlockerBuddy: Unblocked (PM decision | Greg specifically)"
        );
    });

    test("original category + resolution", () => {
        expect(buildUnblockMarker("PM decision", undefined, "PM responded")).toBe(
            "BlockerBuddy: Unblocked (PM decision) - PM responded"
        );
    });

    test("full form: category + context + resolution", () => {
        expect(buildUnblockMarker("PM decision", "Greg specifically", "PM responded")).toBe(
            "BlockerBuddy: Unblocked (PM decision | Greg specifically) - PM responded"
        );
    });

    test("resolution only (no original — defensive shape, not a happy path)", () => {
        // Per design, tagged-but-uncategorized unblock writes no marker. But if
        // somehow called with resolution alone, we still produce a syntactically
        // valid marker. Defensive correctness.
        expect(buildUnblockMarker(undefined, undefined, "PM responded")).toBe("BlockerBuddy: Unblocked - PM responded");
    });

    test("sanitizes parens out of category", () => {
        expect(buildUnblockMarker("(weird)", undefined, "with\nnewlines")).toBe(
            "BlockerBuddy: Unblocked (weird) - with newlines"
        );
    });

    test("sanitizes pipes out of category and context (separator is structural)", () => {
        // User-typed pipes in either field get stripped; the | between cat/ctx
        // is inserted by buildUnblockMarker itself.
        expect(buildUnblockMarker("a|b", "c|d")).toBe("BlockerBuddy: Unblocked (a b | c d)");
    });

    test("empty context with non-empty category produces no-context form", () => {
        expect(buildUnblockMarker("PM decision", "")).toBe("BlockerBuddy: Unblocked (PM decision)");
        expect(buildUnblockMarker("PM decision", "   ")).toBe("BlockerBuddy: Unblocked (PM decision)");
    });
});

describe("parseMarker", () => {
    test("returns null for empty/non-marker input", () => {
        expect(parseMarker("")).toBeNull();
        expect(parseMarker(null)).toBeNull();
        expect(parseMarker(undefined)).toBeNull();
        expect(parseMarker("just a regular comment")).toBeNull();
        expect(parseMarker("BlockerBuddy is great")).toBeNull(); // missing colon-and-event
    });

    test("parses Block, category only", () => {
        expect(parseMarker("BlockerBuddy: Blocked - PM decision")).toEqual({
            event: "Blocked",
            category: "PM decision"
        });
    });

    test("parses Block with context", () => {
        expect(parseMarker("BlockerBuddy: Blocked - PM decision | Greg specifically")).toEqual({
            event: "Blocked",
            category: "PM decision",
            context: "Greg specifically"
        });
    });

    test("parses Block with 'Other' category and context", () => {
        expect(parseMarker("BlockerBuddy: Blocked - Other | legacy migration")).toEqual({
            event: "Blocked",
            category: "Other",
            context: "legacy migration"
        });
    });

    test("parses Unblock, no original, no resolution", () => {
        expect(parseMarker("BlockerBuddy: Unblocked")).toEqual({ event: "Unblocked" });
    });

    test("parses Unblock with original (category only)", () => {
        expect(parseMarker("BlockerBuddy: Unblocked (PM decision)")).toEqual({
            event: "Unblocked",
            originalReason: "PM decision",
            originalCategory: "PM decision"
        });
    });

    test("parses Unblock with original (category + context)", () => {
        expect(parseMarker("BlockerBuddy: Unblocked (PM decision | Greg specifically)")).toEqual({
            event: "Unblocked",
            originalReason: "PM decision | Greg specifically",
            originalCategory: "PM decision",
            originalContext: "Greg specifically"
        });
    });

    test("parses Unblock with original + resolution", () => {
        expect(parseMarker("BlockerBuddy: Unblocked (PM decision) - PM responded")).toEqual({
            event: "Unblocked",
            originalReason: "PM decision",
            originalCategory: "PM decision",
            resolution: "PM responded"
        });
    });

    test("parses Unblock with original (cat+ctx) + resolution (the full form)", () => {
        expect(parseMarker("BlockerBuddy: Unblocked (PM decision | Greg specifically) - PM responded")).toEqual({
            event: "Unblocked",
            originalReason: "PM decision | Greg specifically",
            originalCategory: "PM decision",
            originalContext: "Greg specifically",
            resolution: "PM responded"
        });
    });

    test("is case-insensitive on the prefix and event word", () => {
        expect(parseMarker("blockerbuddy: blocked - test")?.event).toBe("Blocked");
        expect(parseMarker("BLOCKERBUDDY: UNBLOCKED")?.event).toBe("Unblocked");
        expect(parseMarker("BlockerBuddy: BLOCKED - test")?.event).toBe("Blocked");
    });

    test("finds marker on any line of multi-line comment", () => {
        const multiLine = "Some intro text\nBlockerBuddy: Blocked - PM decision\nMore text after";
        expect(parseMarker(multiLine)?.category).toBe("PM decision");
    });

    test("ignores lines that aren't valid markers", () => {
        expect(parseMarker("This mentions BlockerBuddy: but isn't a marker")).toBeNull();
    });

    test("round-trips: build then parse for Block", () => {
        const m = buildBlockMarker("PM decision", "Greg specifically");
        const p = parseMarker(m);
        expect(p?.event).toBe("Blocked");
        expect(p?.category).toBe("PM decision");
        expect(p?.context).toBe("Greg specifically");
    });

    test("round-trips: build then parse for Unblock with original + resolution", () => {
        const m = buildUnblockMarker("PM decision", "Greg", "PM finally responded");
        const p = parseMarker(m);
        expect(p?.event).toBe("Unblocked");
        expect(p?.originalCategory).toBe("PM decision");
        expect(p?.originalContext).toBe("Greg");
        expect(p?.resolution).toBe("PM finally responded");
    });

    test("round-trips: build then parse for bare Unblock", () => {
        const m = buildUnblockMarker();
        const p = parseMarker(m);
        expect(p?.event).toBe("Unblocked");
        expect(p?.originalReason).toBeUndefined();
        expect(p?.resolution).toBeUndefined();
    });
});
