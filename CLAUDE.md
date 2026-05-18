# CLAUDE.md — Blocker Buddy

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

**Blocker Buddy** turns "we have a lot of blockers" into measured data. It captures *when* an item was blocked, *what category* of blocker, and *how long* it stayed blocked — with a one-click toggle from any work-item context menu and a dashboard widget that summarizes the result.

Published to the Visual Studio Marketplace as **`AgileViz.BlockerBuddy`**.

Pure TypeScript + DOM — no React, no chart library. Sparklines are inline SVG; the breakdown table is HTML.

## Commands

```bash
npm install                    # one-time dependency install
npm test                       # Jest with coverage (191 tests as of 0.9.5)
npm run test-watch             # Jest --watchAll with coverage
npm run lint                   # ESLint over src/**/*.{ts,tsx}
npm run serve                  # webpack-dev-server on https://localhost:3000 (install the dev VSIX in ADO to test)
npm run build                  # production webpack + tfx VSIX package
npm run build:dev              # dev VSIX (side-by-side install during development)
npm run publish-extension      # publish to ADO Marketplace (needs $ADO_PUBLISH_TOKEN)
npm run publish-extension-dev  # publish the private dev extension
./build-icon.sh                # rsvg-convert imagesrc/icon.svg → static/icon.png
./build-marketplace-hero.sh    # ImageMagick: composite hero from support-page screenshots
```

`tfx --rev-version` bumps the version on each publish; `npm run sync-version` (called from `postbuild`) keeps `extension.json` and `package.json` in lockstep.

## Repository layout

```
src/
├── Contribs/
│   ├── Action/   # Context-menu "Block / Unblock…" action (Action.html / Action.ts / Action.json)
│   ├── Config/   # Widget configuration pane (categories CRUD + curated 6-suggestion bootstrap)
│   ├── Dialog/   # Modal dialog for Block (category + optional note) and Unblock
│   └── Widget/   # Dashboard widget showing current blocked, total time, per-category breakdown + sparklines
├── ContribsDev/  # DEV-only contributions used by the dev extension
└── Library/      # adoLibrary, blockerAggregation, blockerBuddyLibrary, blockerEventTimeline,
                  # teamConfig, widgetData, widgetView
```

Four contributions (vs. typical two for widget-only plugins). The Action is what makes this a "data-source plugin" — it writes structured data into ADO that the Widget reads back.

## Data model — comment-as-storage

Blocker Buddy does **not** use custom fields, extension storage, or external infrastructure. Each block/unblock event is written as a structured Discussion comment on the work item. The widget reads the comments back via the v3 Comments API and parses them.

### Marker format (locked 2026-04-28; format is now load-bearing — don't break compat)

```
BlockerBuddy: Blocked - <category>
BlockerBuddy: Unblocked (<original category>)
```

Built by `teamConfig.ts::buildBlockMarker` / `buildUnblockMarker`. Parsed by `parseMarker` in `blockerEventTimeline.ts`.

The plain-text shape is **deliberate** — see "HTML-wrap-as-auth" below.

### Pairing logic (`blockerEventTimeline.ts`)

Block + Unblock markers on the same item are paired into closed `BlockerInterval` periods. Pairing is **symmetric**: an orphan Block is dropped (no synthesized end timestamp), an orphan Unblock is skipped. The original "implicit-transition closure" that synthesized end timestamps was removed — better no data than wrong data, especially since the bug surfaced when Unblock comments were deleted and intervals were inflated. **Invariant**: numbers should only go down on corruption, never up.

A separate `symmetric-orphan-markers` rule applies: if you ever consider re-adding a "for completeness, let's synthesize…" branch, the answer is no.

### Currently-blocked predicate

`isCurrentlyBlocked` in `blockerBuddyLibrary.ts`:

```
untimedTagPresent = input.currentlyTagged && !hasOpenInterval
```

NOT `&& intervals.length === 0`. That earlier shape silently excluded items with at least one closed interval that were re-tagged manually (or had their open BB comment edited and become invisible to the parser). Test locks this fix.

## Architecture

Data flow inside the widget: load team config (categories) → resolve project/team via SDK → fetch work items matching the team's area paths (with `includeChildren`) → fetch v3 Comments for each → parse markers → aggregate into closed intervals + currently-open → render hero (current blocked count) + cumulative-time chart + per-category breakdown rows with sparklines.

Key files in `src/Library/`:

- **`teamConfig.ts`** — categories CRUD, marker-format builders. Categories are stored in `IExtensionDataManager` keyed by team. Six curated starter categories ("Code review", "External dependency", "Stakeholder decision", "Tooling / environment", "Knowledge gap", "Other").
- **`blockerEventTimeline.ts`** — marker parser + pairing into intervals. Parser tolerates outer `<div>` wrapping (ADO sanitizes user-edited comments to HTML; see HTML-wrap rule below). S5852 defense: `parseMarker` skips lines longer than 1000 chars.
- **`blockerAggregation.ts`** — rolls intervals into per-category summary rows (count, total duration, sparkline data).
- **`blockerBuddyLibrary.ts`** — high-level orchestration; `isCurrentlyBlocked` predicate.
- **`adoLibrary.ts`** — REST wrappers (`IProjectPageService`, `IProjectInfo`, `WorkItemTrackingRestClient`). Strongly typed — no `any`.
- **`widgetView.ts`** — render helpers split out of `Widget.ts` for unit-testing without DOM.
- **`widgetData.ts`** — pre-render data shaping (sparkline scale, sort order, etc.).

Key files in `src/Contribs/`:

- **`Action/Action.ts`** — context-menu "Block / Unblock…" entry. Forwards `workItemDirty` into the dialog's config so the dialog can short-circuit to the dirty-form warning BEFORE `loadState()` — no API calls on the warning path. Dirty-form warning is cancel-only (the original "proceed anyway" path was a footgun because `workItemDirty` is binary and any pending tag edit conflicts with BB's tag write on save via TF26071).
- **`Dialog/Dialog.ts`** — Block dialog (category buttons + optional note) and Unblock dialog (pre-click duration sub-line "Blocked for X so far" because the common usage pattern is "open dialog to check duration, then Cancel"). Calls `dialog.close()` injected by `openCustomDialog` — note this method is NOT in the TS types but works at runtime.
- **`Widget/Widget.ts`** — render loop. Sparklines use a **shared y-axis** across all categorized rows (`sharedMax` computed once and passed into each `renderSparkline` call), with a 1.5px viewBox-unit minimum-bar-height floor for non-zero days so single-event days on quiet categories stay visible against busy peers' peaks. Hover scope: action icons reveal on `.bb-cat-header:hover`, not `.bb-cat-row:hover` — keeps the sparkline a "read-only zone" where the SVG `<title>` tooltip can surface without competing intent signals.

## Testing — AMD stub pattern (important)

`azure-devops-extension-sdk` and `azure-devops-extension-api/*` are AMD-only and crash under Jest's Node runtime. Workaround is an empty stub mapped in via `jest.config.js`:

```js
moduleNameMapper: {
  '^azure-devops-extension-sdk$': '<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts',
  '^azure-devops-extension-api(/.*)?$': '<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts',
}
```

Per-file coverage thresholds in `jest.config.js` are a regression gate. When you add tests, raise the floor; don't lower it.

## ADO platform quirks that affect this plugin

- **Two Comments APIs at the same URL.** Legacy 3.2 (returns plain Comments tab content) and v3 7.0 (full Discussion API). v3 writes are **invisible to legacy reads** in some hosts. BB uses v3 throughout for both write and read.
- **`getComments` defaults to `Asc`.** Pass `Desc` explicitly when looking for recent activity, otherwise pagination gives you the oldest comments first.
- **ADO sanitizes comments at write time.** Plain-text API writes are stored as-is; UI-edited comments are wrapped in `<div>` (plain edits) or `<span style="...">` (rich-text pastes). The parser tolerates the outer wrapper, but **WIQL `CONTAINS WORDS`** has its own behavior: hyphens split tokens, CamelCase doesn't.
- **HTML-wrap as auth signal — current policy:** plain text = "BB wrote this" trust signal, HTML-wrapped = user-edited. Parser tolerates the outer wrapper if the BB marker is the FIRST content inside the wrapper. The earlier strict-rejection policy was a footgun for typical users editing BB comments to fix typos — user-protection beats theoretical spoof-resistance for a free product. If you ever reconsider, the test cases in `blockerEventTimeline.test.ts` and `parseMarker.test.ts` cover both shapes.
- **`actionContext` shape differs per host** for context-menu actions. Read all three: `actionContext.workItemIds[0]`, `actionContext.id`, `actionContext.workItemId`. Any one of them may be undefined depending on which surface fired the action.
- **`icon: { light, dark }` works for `ms.vss-web.action`** in the manifest, but PNG theme-pair requires a refresh on theme toggle (ADO doesn't hot-swap).
- **`openCustomDialog` vs. `openPanel`.** Dialog for short prompts; Panel for major workspaces. Panels are full-viewport-height — don't use a Panel for what should be a dialog.
- **Cascading submenus aren't supported.** XDM `getMenuItems` silently ignores nested menus.
- **`IExtensionDataManager.getValue()` is cached** and `deleteDocument()` does NOT bust the cache. To reset, write `DEFAULT` via `setValue` then `deleteDocument`.
- **AMD modules everywhere.** See AMD-stub pattern above.
- **Dev-server PNA header.** Chrome blocks loopback iframes loaded into ADO unless the dev server sets `Access-Control-Allow-Private-Network: true`. Already wired in `webpack.config.js` — don't strip it.
- **Contribution IDs use dots, not slashes.** Slash form silently fails to register.
- **Manifest visibility has two axes.** `galleryFlags` controls maturity, top-level `"public": true` controls discoverability. Both need to be right at publish time.
- **`SDK.resize()` behaves differently per host** (dialog / panel / widget config drawer). Combine with a `ResizeObserver` on the relevant root.

## Defensive coding rules

- **Don't embed HTTP response body text into `throw new Error()`.** SonarCloud S5696 (stored XSS via DOM render path) flags it. Also don't fall back to `console.error(body)` — S5145 (log injection) flags that too. Drop the body; the status code is sufficient. Size-bounding (`body.slice(0, 300)`) is the wrong defense shape for XSS. Both `postComment` and `fetchCommentsV3` were fixed in BB 0.9.4 + 0.9.5 — apply the same shape to any new fetch wrapper.
- **`parseMarker` defense:** length cap of 1000 chars per line (S5852 ReDoS hardening).
- **`isCurrentlyBlocked`** is the predicate every "current state" surface should call — don't recompute from raw intervals + tag in render code.
- **Symmetric orphan handling** is non-negotiable. If you find yourself synthesizing an end timestamp because a pair is unbalanced, you're about to inflate someone's blocker time.

## Quality Gate workflow

SonarCloud at `sonarcloud.io/project/overview?id=agileviz_blocker-buddy`. Quality Gate badge in `README.md` reflects current `main` scan.

When publishing a new version:

1. Land change on `main`, wait for SonarCloud rescan, verify all four ratings stay A and Quality Gate is **Passed**.
2. Only then `npm run publish-extension`. The pre-publish-SonarCloud-check workflow shipped in BB 0.9.5 — gate publish on the rescan, don't publish-then-republish-if-finding. 10 min waiting beats 30 min re-publish cycle.
3. SonarCloud's **first scan on a fresh repo** can show "Quality Gate Not computed" because there's no baseline. A second small commit triggers the computation.

## Product stance

This plugin has **no roadmap**. It does one thing well: lightweight blocked/unblocked capture into structured Discussion comments that a future AgileViz **Blocker Analysis** app will read for counterfactual "you'd have shipped X more without these blockers" reporting. Feature requests get honest pushback if they expand scope (and especially if they propose moving storage off comments — comments-as-storage is the no-infrastructure, no-admin-consent promise that makes this plugin shippable).

For bugs or feature requests, open a [GitHub issue](https://github.com/agileviz/blocker-buddy/issues) using the appropriate template. Security issues: see `SECURITY.md`.
