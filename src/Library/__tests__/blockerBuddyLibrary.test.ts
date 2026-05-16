// Tests for the pure helpers in blockerBuddyLibrary.ts. SDK-dependent
// functions (queryBlockerWorkItemIds, getWorkItemSummaries, getAllCommentsAsc,
// getTeamAreaPaths, tag/comment ops, identity, admin checks) are integration-
// tested via dev install — they're skipped here.

import { buildBlockerWiql, TeamAreaPath } from "../blockerBuddyLibrary";

const SUBTREE: TeamAreaPath[] = [{ path: "Proj\\Team A", includeChildren: true }];
const EXACT_ONLY: TeamAreaPath[] = [{ path: "Proj\\Team A\\Sub", includeChildren: false }];
const MIXED: TeamAreaPath[] = [
    { path: "Proj\\Team A", includeChildren: true },
    { path: "Proj\\Special\\Bucket", includeChildren: false }
];

describe("buildBlockerWiql", () => {
    test("returns a SELECT statement scoped to current project", () => {
        const wiql = buildBlockerWiql("Blocked", SUBTREE);
        expect(wiql).toMatch(/SELECT\s+\[System\.Id\]/);
        expect(wiql).toMatch(/FROM\s+WorkItems/);
        expect(wiql).toMatch(/\[System\.TeamProject\]\s*=\s*@project/);
    });

    test("OR-joins tag and history predicates", () => {
        const wiql = buildBlockerWiql("Blocked", SUBTREE);
        expect(wiql).toMatch(/\[System\.Tags\]\s+CONTAINS\s+'Blocked'/);
        expect(wiql).toMatch(/\[System\.History\]\s+CONTAINS\s+WORDS\s+'BlockerBuddy'/);
        expect(wiql).toMatch(/OR/);
    });

    test("escapes single quotes in tag name (WIQL string literal safety)", () => {
        const wiql = buildBlockerWiql("Bob's Block", SUBTREE);
        expect(wiql).toContain("'Bob''s Block'");
    });

    test("custom tag names propagate to the tag predicate", () => {
        expect(buildBlockerWiql("Impediment", SUBTREE)).toContain("'Impediment'");
        expect(buildBlockerWiql("WaitingOnSomeone", SUBTREE)).toContain("'WaitingOnSomeone'");
    });

    test("BlockerBuddy literal is hardcoded (not user-supplied) — safe from injection in the history predicate", () => {
        const wiql = buildBlockerWiql("' OR 1=1 --", SUBTREE);
        expect(wiql).toContain("'' OR 1=1 --'");
        expect(wiql).toMatch(/CONTAINS\s+WORDS\s+'BlockerBuddy'/);
    });

    test("subtree area path emits UNDER clause", () => {
        const wiql = buildBlockerWiql("Blocked", SUBTREE);
        expect(wiql).toMatch(/\[System\.AreaPath\]\s+UNDER\s+'Proj\\Team A'/);
        expect(wiql).not.toMatch(/\[System\.AreaPath\]\s*=\s*'Proj\\Team A'/);
    });

    test("exact-only area path emits = clause", () => {
        const wiql = buildBlockerWiql("Blocked", EXACT_ONLY);
        expect(wiql).toMatch(/\[System\.AreaPath\]\s*=\s*'Proj\\Team A\\Sub'/);
        expect(wiql).not.toMatch(/UNDER/);
    });

    test("mixed area paths OR each clause inside parens", () => {
        const wiql = buildBlockerWiql("Blocked", MIXED);
        expect(wiql).toMatch(/UNDER\s+'Proj\\Team A'/);
        expect(wiql).toMatch(/=\s+'Proj\\Special\\Bucket'/);
        expect(wiql).toMatch(/\(\[System\.AreaPath\][^)]+OR[^)]+\)/);
    });

    test("escapes single quotes in area path", () => {
        const wiql = buildBlockerWiql("Blocked", [{ path: "Proj\\O'Brien", includeChildren: true }]);
        expect(wiql).toContain("'Proj\\O''Brien'");
    });

    test("empty area paths emits 1=0 — team owns no work items, query returns nothing", () => {
        const wiql = buildBlockerWiql("Blocked", []);
        expect(wiql).toMatch(/\bAND\s+1=0\b/);
        // Crucially, no AreaPath clause that would default to project-wide
        expect(wiql).not.toMatch(/\[System\.AreaPath\]/);
    });

    test("area path filter is ANDed with the tag/history disjunction (not OR'd)", () => {
        // Confirms the structural shape: (tag OR history) AND project AND (areaPaths)
        // — so a Blocker on a sibling team's item won't bleed in.
        const wiql = buildBlockerWiql("Blocked", SUBTREE);
        expect(wiql).toMatch(/\bAND\s+\[System\.TeamProject\]/);
        // The area-path clause is paren-wrapped (to preserve OR scoping when multiple paths)
        expect(wiql).toMatch(/\bAND\s+\(\[System\.AreaPath\]\s+UNDER/);
    });
});
