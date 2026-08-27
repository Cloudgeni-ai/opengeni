# OpenGeni Timeline Hardening Implementation Report

Status: merge-ready implementation; pull-request review pending

Prepared: August 27, 2026

Target repository: `Cloudgeni-ai/opengeni`

Working branch: `fix/timeline-scroll-hardening`

Baseline source: `1135a6b24e125bd65b1db6e1b19bbe54e29161f2`

## 1. One-sentence goal

Make the published OpenGeni React message timeline measurably stable under real-time streaming, backward and forward history paging, reader-driven navigation, dynamic layout, and responsive viewport changes by reproducing and root-causing important defects, fixing only validated defects, and retaining deterministic regression evidence strong enough for an autonomous merge decision.

## 2. Reconstructed intent

### Outcome actually wanted

The user does not want a cosmetic pass or a handful of guessed scroll tweaks. The requested outcome is an unusually deep, adversarial engineering audit of the timeline, followed by implementation-quality fixes for every important defect that can be independently reproduced and validated.

The audit must exercise the timeline as users actually stress it:

- live text and activity arriving slowly, quickly, irregularly, and in bursts;
- large tool/result walls and tiny token deltas;
- reader scroll-up, scroll-down, return-to-tip, and jump controls;
- older-history prepend, newer-history append, start/latest window replacement, overlap, filtering, empty pages, failure, retry, and bounded eviction;
- folds, disclosures, late image/font/tool measurement, composer growth, session chrome, and other layout changes;
- desktop, tablet, narrow mobile, coarse-pointer-like interaction, reduced motion, browser scroll quantization, zoom/DPR variation, and runtime resize;
- repeated and alternating operations that expose races hidden by one-shot tests.

The final result should contain few findings if few defects survive scrutiny. Quantity is not success. Every retained finding must have objective evidence, a defensible root cause, a focused fix, and a regression that fails for the old behavior and passes for the new behavior.

### System that should exist when finished

The published `MessageTimeline` and its `useSessionEvents` integration should behave as one coherent scroll/navigation state machine:

1. A pinned live reader sees newly rendered content immediately and remains at the truthful tip.
2. A reader who intentionally leaves the tip is not pulled back by stream, fold, resize, observer, or programmatic-scroll echoes.
3. Returning to the tip re-pins predictably without surprise page crawling or stale latches.
4. Prepending older history preserves the reader's durable row and pixel anchor through every commit and delayed layout change.
5. Forward paging preserves the history reader's place until the live tip is actually reached.
6. Underfilled or collapsed windows request bounded additional history without loops, duplicate ownership, stale retries, or dead ends.
7. Fold/disclosure/composer/chrome/viewport changes conserve the correct visual anchor for pinned and unpinned readers.
8. The behavior remains correct across representative viewport sizes, reduced motion, and device-pixel quantization.
9. Performance remains bounded: no per-token full-history work, observer storms, unbounded buffers, avoidable forced-layout loops, or material frame regressions.
10. Failures are diagnosable through deterministic test metrics and artifacts rather than subjective video review.

## 3. Decisions already made

- `MessageTimeline` mounts the complete bounded in-memory timeline window. Reintroducing progressive row reveal or a second virtualized timeline is not the default direction.
- Durable event paging and browser-window bounds remain owned by `useSessionEvents`; the styled timeline consumes host-provided paging state and callbacks.
- While pinned, rendered DOM growth must not be hidden behind an eased camera. PR #1879 established the invariant that same-frame growth advances the camera by the same amount while pre-existing debt may still ease.
- Native scroll anchoring is disabled while pinned and enabled while unpinned.
- Reader intent, not incidental layout, is what releases the pin.
- Older-page request ownership is fenced by the exact oldest source item and, for first-party loaders, a synchronous committed receipt.
- Real Chromium behavior is required for browser scroll conclusions; happy-dom alone cannot represent layout, quantization, scroll anchoring, `ResizeObserver`, `IntersectionObserver`, or real scroll-event timing.
- Existing harnesses are the starting point. Extend them instead of creating a parallel fake timeline implementation.
- Public API compatibility matters because `@opengeni/react` is published and consumed by OpenGeni's app, examples, and CloudGeni.
- No merge, package release, staging deployment, production mutation, or broad host rewrite is authorized by this task.

## 4. Constraints

- Do not retain speculative findings.
- Attempt to falsify each candidate defect before changing production code.
- Prefer pure state/math helpers and explicit ownership invariants over additional timers or magic thresholds.
- Do not let a test-only simplification become a forked implementation of the timeline.
- Preserve user control: wheel, keyboard, pointer/touch, nested scrollables, disclosures, and assistive interaction must remain truthful.
- Preserve public package exports and host compatibility unless a breaking change is separately justified and approved.
- Use the repository-pinned Bun 1.4.0 for authoritative commands.
- Follow `AGENTS.md`; update `docs/architecture.md` only if an architectural invariant, canonical boundary, or component responsibility changes.
- Work is GitOps work on `fix/timeline-scroll-hardening`; produce focused commits and a reviewable PR, but do not merge it.

## 5. Non-goals

- A visual redesign of timeline rows, colors, typography, or product information architecture.
- Replacing the event projection, session protocol, SSE transport, or database model without evidence that a validated timeline defect originates there.
- Loading the entire durable session history into the browser.
- Hiding jumps with blanket smooth scrolling, CSS transitions, arbitrary delays, or larger pin thresholds.
- Declaring browser behavior correct because screenshots look acceptable at one viewport.
- Tuning animation purely by taste without invariant-based measurements.
- Host-specific CloudGeni changes unless the package is correct and a separately reproduced integration defect remains.
- Publishing, merging, or deploying.

## 6. Likely edge cases

- Growth and viewport shrink in the same animation frame.
- Height shrink and live append in the same commit.
- Multiple programmatic `scrollTop` writes coalesced into one event, or one write producing multiple events.
- Browser flooring/rounding sub-pixel `scrollTop` writes at different DPR values.
- Scrollbar drag or touch pan without wheel events.
- Keyboard navigation when focus is on the scroller versus inside an interactive descendant.
- A nested overflow element at its top/bottom handing wheel ownership back to the timeline.
- `scrollend` support present, absent, or present with unusual ordering.
- ResizeObserver callbacks after unpin, unmount, window swap, or a newer React commit.
- IntersectionObserver callbacks retained after sentinel replacement.
- StrictMode effect replay and stale callback closure ownership.
- Prepend that merges into the first existing timeline group.
- Older fetch that commits no visible projected row because the page is filtered.
- Older fetch that commits a projection-empty or same-first-id source window.
- Zero-overlap page replacement.
- Live-tail append evicting the oldest source item while an older request is pending.
- Older request promise settling before or after the committed page.
- Retry control retained briefly by exit animation after its loader/owner changed.
- Forward paging that evicts the start and re-arms older history.
- Jump-to-latest promise rejection or resolution without a window change.
- Jump-to-start promise resolution before, after, or without the oldest-window commit.
- Fold/disclosure nodes mounting, unmounting, or animating above the reader anchor.
- Long markdown structure changes: fences, lists, tables, task lists, code blocks, images, and link previews.
- Composer growth/shrink in many sub-epsilon frames.
- Very short windows, exactly one-pixel scroll ranges, and very tall windows.
- Width changes that reflow many rows and alter height without new events.
- Background/hidden tab rAF throttling and return to foreground.
- Reduced-motion changes while a follow loop or reveal is active.

## 7. Ambiguities and assumptions

### Ambiguities

- “Absolutely all bugs” is interpreted as exhaustive coverage of the defined timeline boundaries, not a proof over every future browser, host CSS override, or arbitrary third-party renderer.
- “Different screen sizes” is interpreted as responsive width/height and DPR/reflow behavior, not separate product layouts beyond the published component contract.
- “Lazy loading” includes `useSessionEvents` window navigation and `MessageTimeline` pagination ownership; unrelated lazy-loaded application bundles are excluded.

### Assumptions

- The existing public API and comments express intended behavior unless contradicted by user intent, architecture rules, or objective browser evidence.
- The demo harness can represent package-level scroll behavior because it renders the real `MessageTimeline`, real grouping/projection where applicable, and real browser layout.
- Chromium is the primary deterministic engine available now. Additional engines are useful falsification lanes, not substitutes for Chromium evidence.
- Package-level correctness can be achieved and verified locally without staging credentials.
- Host integration will be inspected and compile-tested, but host deployment is not required for merge readiness.

## 8. Codebase research summary

### Canonical production paths

- `packages/react/src/components/message-timeline.tsx`
  - styled timeline and scroll owner;
  - pin/unpin state;
  - reader-intent handling;
  - post-commit anchor restoration;
  - `ResizeObserver` and sentinel integration;
  - older/newer/start/latest affordances;
  - disclosure anchor preservation.
- `packages/react/src/components/tip-follow.ts`
  - pure pinned camera state;
  - growth and viewport-shrink accounting;
  - quantization-safe fractional camera;
  - shrink compensation and convergence.
- `packages/react/src/hooks/use-session-events.ts`
  - bounded browser event window;
  - initial tip fetch and live SSE;
  - older/newer/oldest/latest navigation;
  - direction-aware eviction and high-water tracking.
- `packages/react/src/older-history.ts`
  - synchronous committed receipt used to fence older-page ownership through wrappers.
- `packages/react/src/timeline/projection.ts`
  - durable events to renderable timeline items and groups.
- `packages/react/src/components/markdown.tsx`
  - streaming markdown parsing, reveal lifecycle, and structure changes.
- `packages/react/src/components/stream-reveal.ts`
  - paint-only streaming ink; should not delay DOM truth.
- `packages/react/src/components/soften-streaming-markdown.ts`
  - display-only closure of unfinished markdown structures.
- `packages/react/src/components/user-message-body.tsx`
  - disclosure height and anchor interactions.
- `packages/react/src/timeline/entrance.tsx`
  - mount-time versus live entrance-animation ownership.
- `packages/react/src/components/tooltip.tsx`
  - copy-control portal source publication and closed-row mount cost.
- `packages/react/src/lib/format.ts`
  - message-footer date formatting on every newly mounted chat row.
- `packages/react/demo/vite.config.ts`
  - isolated production build boundary for the timeline performance harness.
- `packages/react/src/timeline/turn-summary.tsx` and `fold-memory.ts`
  - live-to-settled fold transitions and durable fold resting state.

### Host paths

- `apps/web/src/routes/session.tsx`
  - first-party composition of `useSessionEvents` and `MessageTimeline`.
- `packages/react/src/index.ts`, `session.ts`, and `session-ui.ts`
  - public exports and compatibility boundaries.
- `examples/northstar-support/src/support-agent-panel.tsx`
  - external-style package consumer.
- The external CloudGeni host integration was inspected separately for its use of the
  published component with `autoFollow`; its repository-local path is intentionally not
  treated as an OpenGeni documentation reference.

### Existing deterministic harnesses

- `packages/react/demo/timeline-scroll-test-harness.tsx`
  - large mounted window, prepend, append, stream growth, delayed rows above reader.
- `packages/react/demo/timeline-collapsed-history-test-harness.tsx`
  - underfill, overlapping loads, filtered/empty pages, retries, bounded live eviction, StrictMode.
- `packages/react/demo/timeline-scroll-merge-test-harness.tsx`
  - prepend merging into the first group.
- `packages/react/demo/timeline-tip-follow-test-harness.tsx`
  - live nested growth, chrome/composer height changes, exact tip metrics.
- `test/e2e/timeline-scroll.browser.e2e.ts`
  - 32 Chromium pagination/anchor regressions at baseline.
- `test/e2e/timeline-tip-follow.browser.e2e.ts`
  - 4 Chromium tip-follow regressions at baseline.
- `test/e2e/seed/stream-scenarios.ts`, `stream-session-events.ts`, and `scripts/ui-work-stream-loop.sh`
  - production-shaped long-running stream generator with fast, slow, crawl, laggy, burst, and yank pacing.

### Baseline verification completed before implementation

- Bun runtime: exact 1.4.0 through `bunx --bun bun@1.4.0`.
- Targeted unit/component suite: 370 passed, 0 failed.
- Timeline scroll Chromium suite: 32 passed, 0 failed.
- Timeline tip-follow Chromium suite: 4 passed, 0 failed.

These passes establish a clean starting point, not completeness.

## 9. Relevant system map and call paths

### Live tip path

`SSE event` → `useSessionEvents` pending bounded batch → browser event window → `buildTimeline` → `groupTimeline` → `MessageTimeline` React commit → DOM height/reflow → layout effect and/or `ResizeObserver` → `driveFollow` → `tipFollowStep` → tagged `scrollTop` write → scroll echo consumed by `onScroll`.

### Reader leave path

Wheel/keyboard/pointer or unarmed scroll → nested-scroll ownership check → explicit release or pending `scrollend`/rAF settle → stop camera → set unpinned → native anchoring enabled → top history prefetch armed.

### Older history path

Top sentinel/underfill → exact older boundary owner → `onLoadOlder` → first-party committed receipt or compatibility promise → `useSessionEvents.loadOlder` fetches/validates/prepends/bounds → commit marks receipt → `MessageTimeline` post-commit detects source/window change → restore retained group/item anchor or seam → release/rebase owner → sentinel may re-arm only after leaving top band.

### Newer history path

History window `hasNewer=true` → bottom sentinel or explicit control → `loadNewer` appends and newest-bounds → timeline must stay unpinned while history remains → when `hasNewer=false`, resume live stream and re-pin only if the reader was at the history-window bottom or explicitly requested latest.

### Dynamic layout path

Fold/disclosure/markdown/reflow/composer/chrome/viewport mutation → DOM geometry changes without necessarily changing source items → pinned path conserves tip distance and growth truth; unpinned path conserves reader anchor through native anchoring or explicit disclosure correction; neither may synthesize reader intent.

## 10. Critical evaluation of existing patterns

### Clearly intentional and worth following

- One scroll owner in `MessageTimeline`.
- Pure camera math in `tip-follow.ts`.
- Exact source-item boundary rather than projected-group identity for pagination ownership.
- Committed receipt for non-visible or zero-overlap older pages.
- Direction-aware browser-window bounding in `useSessionEvents`.
- Ref mirrors for behavior that rAF/observers must read synchronously.
- Real Chromium tests for layout and quantization.
- Test harnesses rendering the production component rather than copied markup.

### Good but needing extension

- The scroll browser suite is deep on pagination but narrow on DPR, reduced motion, keyboard/touch sequences, width reflow, background throttling, and randomized alternating operations.
- The tip-follow suite validates convergence and immediate growth but not a broad responsive/DPR/cadence matrix.
- The live seed scenarios are rich but are mainly observational; they need a deterministic metric probe or a smaller local equivalent for CI-quality assertions.
- Existing performance evidence is captured only for one prepend scenario and only when an artifact directory is supplied.

### Questionable but not yet proven defective

- The volume of mutable refs and effect-order coupling in `MessageTimeline` makes correctness hard to reason about and easy to regress.
- Programmatic scroll echo accounting is count-based but browser event coalescing may not be one-to-one across all sequences.
- Pointer arming has no explicit pointer-up/cancel lifecycle in the visible state map; this may be harmless because geometric direction and settle checks fence release, but it needs stress evidence.
- The one-rAF no-`scrollend` fallback may be too early for some programmatic or momentum sequences; this is a hypothesis until reproduced.
- Native anchoring and explicit correction coexist in the unpinned path; non-commutative corrections need frame-by-frame tests.
- Width-driven reflow is not named as a first-class event even though it can alter many row heights at once.

### Likely legacy or inferior patterns to remove only if safe

- Deprecated tip-follow soft-rise exports and constants are compatibility surface. They should not drive new behavior; removal requires public API review and is not part of defect fixing by default.
- Compatibility handling for arbitrary void/promise older loaders is necessary for published API stability, but new first-party logic should use committed receipts.
- Tests using fragile structural selectors such as `.og-root > div` should migrate toward existing `data-og-timeline-scroller` where touched.

### Worth improving as part of this work

- A reusable adversarial scenario runner with deterministic operations and metrics.
- Explicit metric definitions for anchor drift, tip debt, pin truth, unexpected scroll velocity, request duplication, and frame quality.
- Seeded randomized/property-like operation traces that emit a replayable seed on failure.
- A concise invariant ledger near the scroll state machine and in this report.

## 11. Proposed architecture and implementation strategy

### Principle: diagnostics before algorithm changes

1. Extend the real demo harness with a deterministic scenario API.
2. Add browser tests that reproduce user-described stress dimensions.
3. Run each candidate failure repeatedly and capture its operation trace.
4. Minimize the trace until the defect remains.
5. Map the trace to a violated invariant and exact production state transition.
6. Add the smallest production fix, preferably in a pure helper or one ownership boundary.
7. Re-run the minimized regression, the full adversarial matrix, and existing suites.
8. Attempt to make the test pass on the old implementation by changing timing/viewport; if it is not robust, improve the test before retaining the finding.

### Harness design

Extend or add one focused timeline stress harness that still renders the real component. It should expose operations such as:

- append token/text/tool/message;
- mutate nested late-layout height;
- prepend page with selectable overlap and visibility;
- append newer page and replace start/latest windows;
- settle/fail/reject/reorder only through supported host contracts;
- fold/unfold and long-message disclose/collapse;
- set composer/chrome height;
- set container width/height;
- scroll by wheel, key, pointer/touch-like drag, exact `scrollTop`, and jump controls;
- toggle reduced motion before mount and, if supported, during a scenario;
- pause/resume rAF visibility simulation where deterministic.

The harness must expose:

- current scroll metrics;
- durable visible anchor id and top offset;
- pin attribute and jump-control state;
- request counters and owner/commit facts visible through host callbacks, not private component refs;
- a bounded operation log and scenario seed.

### Production change preferences

- Keep numeric conservation math pure and unit-tested.
- Keep DOM measurement/write ordering in one layout/observer authority.
- Prefer monotonic ownership tokens/generations to timeout-based invalidation.
- Do not add state that can disagree between refs and React rendering.
- Do not add per-row observers or per-token timers.
- Avoid reading layout repeatedly inside loops; batch reads before writes.
- Preserve stable callbacks and primitive effect dependencies where practical.

## 12. Milestone plan

### Milestone 0 — report and baseline

- Freeze this report.
- Record exact source SHA, branch, runtime, commands, and baseline results.
- Complete independent read-only audits.

### Milestone 1 — adversarial harness and metric vocabulary

- Add deterministic operation DSL/API to the existing demo harness family.
- Add replayable seeded traces and objective metrics.
- Cover responsive widths/heights, DPR, reduced motion, and multiple input modes.
- No production algorithm changes unless a pre-existing test already exposes a defect.

### Milestone 2 — reproduce and triage

- Run exhaustive fixed matrix plus randomized traces repeatedly.
- Build a finding ledger containing reproduced, falsified, duplicate, expected, and harness-defect outcomes.
- Retain only important, user-visible, reproducible defects.

### Milestone 3 — focused fixes

- Implement one root-cause fix per validated behavior class.
- Add unit/property/browser regression for each.
- Re-run all previous scenarios after every fix batch.

### Milestone 4 — falsification and hardening

- Independent review of each finding and fix.
- Revert/disable the fix locally to prove the regression catches it where practical.
- Vary cadence, viewport, DPR, and event ordering to prove the test is not timing theatre.
- Check performance and memory bounds.

### Milestone 5 — merge-ready handoff

- Format, lint, typecheck, package build, demo build, targeted tests, impact-selected tests, and repeated browser matrix.
- Add a changeset if published package behavior changes.
- Commit focused logical units and open a PR.
- Do not merge or deploy.

## 13. Acceptance criteria

### AC1 — current intentional behavior remains green

Expected: all pre-existing targeted timeline tests pass without weakened assertions.

Verification:

```bash
bunx --bun bun@1.4.0 test --max-concurrency=1 --timeout=60000 \
  packages/react/test/tip-follow.test.ts \
  packages/react/test/message-timeline-pagination.test.tsx \
  packages/react/test/timeline.test.ts \
  packages/react/test/timeline-disclosure.test.tsx \
  packages/react/test/settle-fold.test.tsx \
  packages/react/test/stream-reveal.test.tsx \
  packages/react/test/soften-streaming-markdown.test.ts \
  packages/react/test/timeline-renderers.test.tsx \
  packages/react/test/user-message-body.test.tsx
bunx --bun bun@1.4.0 run scripts/run-browser-e2e.ts \
  ./test/e2e/timeline-scroll.browser.e2e.ts \
  ./test/e2e/timeline-tip-follow.browser.e2e.ts
```

Pass signal: zero failures. Evidence: command logs and test counts.

### AC2 — pinned live growth never accumulates artificial debt

Expected: for every live-growth frame, newly added height does not increase distance from tip; after pause, debt converges to <= 1 CSS pixel.

Verification: fixed and randomized browser scenarios across fast/yank/burst/laggy cadence, nested late layout, tool rows, and markdown structure changes.

Pass signal: `afterDebt <= beforeDebt + 1`, no hidden new-content interval longer than one paint, final debt <= 1.

Evidence: per-frame JSON metrics and failure trace seed.

### AC3 — explicit reader leave always wins

Expected: valid upward wheel, keyboard, pointer/touch-like drag, scrollbar drag, or settled external jump unpins; later growth does not increase `scrollTop` except browser clamp required by shrink.

Verification: browser input matrix, including nested scrollable ownership and camera mid-flight.

Pass signal: pin attribute false after intent; post-leave anchor drift <= 1 px through subsequent append/growth.

### AC4 — downward return and jump controls re-pin only at the real tip

Expected: ordinary navigation re-pins near the live tip; history-page bottoms remain unpinned while `hasNewer`; Jump to latest pins only when the tip window lands.

Verification: browser traces with multi-page newer navigation, rejected/no-change/latest commits.

Pass signal: no intermediate page-bottom pin; final live tip pin true and debt <= 1.

### AC5 — older prepend preserves reader anchor frame-by-frame

Expected: the same durable row remains the visual anchor with <= 1 px drift during every progressive or batched prepend frame, delayed layout above it, and concurrent live append.

Verification: desktop/tablet/mobile widths, overlap/no-overlap, first-group merge, width reflow, delayed growth.

Pass signal: stable row id and <= 1 px top-offset drift unless the row is intentionally evicted; if evicted, the documented seam replacement is used.

### AC6 — pagination ownership is bounded and race-safe

Expected: at most one logical older request owns a boundary unless the harness intentionally enables distinct overlapping requests; stale settle/retry callbacks cannot replace a newer owner.

Verification: StrictMode, rejection, no-progress, filtered/empty/same-first-id/zero-overlap pages, live-tail eviction, loader removal, stale retry click.

Pass signal: request counts match scenario contract; no observer loop; forward progress after a committed page.

### AC7 — forward history paging preserves place

Expected: `loadNewer` appends do not yank the reader to each page bottom; start eviction correctly re-arms older history; catching up resumes live once.

Verification: multi-page forward scenarios with bounded eviction and live high-water changes.

Pass signal: anchor drift <= 1 px while history remains; no duplicate stream; correct `hasOlder`/`hasNewer` transitions.

### AC8 — fold/disclosure/layout changes conserve the intended anchor

Expected: pinned readers remain at the truthful tip; unpinned readers retain the visible message/control anchor; layout changes do not synthesize pin changes.

Verification: turn settle folds, manual folds, long user disclosure, nested tool disclosure, markdown fence/list/table transitions, chrome/composer animation.

Pass signal: pinned debt <= 1 or unpinned anchor drift <= 1; no oscillating pin state.

### AC9 — responsive width/height changes are stable

Expected: changing container width or viewport dimensions during stream/history reading does not cause unexplained jumps or horizontal document overflow.

Verification: representative 360x640, 390x844, 768x1024, 1024x768, 1280x900, and 1536x960 scenarios; resize during operations.

Pass signal: invariant-appropriate anchor/debt limits and document horizontal overflow <= 1 px.

### AC10 — reduced motion and quantization remain correct

Expected: reduced motion snaps without animation debt; DPR/quantization does not park the camera or misclassify reader movement.

Verification: reduced-motion contexts and deviceScaleFactor 1, 1.25/1.5 where supported, 2, and 3; unit simulation of floor/round behavior.

Pass signal: final debt <= 1, follow loop stops, user scroll beyond quantization window re-bases.

### AC11 — stress is repeatable and seed-replayable

Expected: randomized operation sequences emit a deterministic seed and bounded trace; every failure is replayable.

Verification: at least 100 traces per core viewport family or an equivalent bounded matrix justified by runtime.

Pass signal: zero invariant failures after fixes; any failure includes seed, operations, and metrics sufficient for one-command replay.

### AC12 — performance remains bounded

Expected: no material long-task/frame regression and no unbounded request/observer/timer growth.

Verification: rAF intervals, long-task observer, request counts, observer/listener instrumentation, large mounted window and burst scenarios.

Pass signal: no new long task attributable to scroll logic; p95 frame interval within an evidence-based threshold relative to baseline; listener/observer counts stable; memory/window bounds unchanged.

### AC13 — public API and host integration remain compatible

Expected: public exports compile, first-party app and example build, CloudGeni integration requires no unsanctioned API change.

Verification:

```bash
bunx --bun bun@1.4.0 run packages/react/typecheck
bunx --bun bun@1.4.0 run packages/react/build
bunx --bun bun@1.4.0 run packages/react/demo:build
bunx --bun bun@1.4.0 run test:publish-consumer
```

Plus targeted host typecheck/build where impact and time permit.

Pass signal: zero compile/build/consumer failures; no accidental export removal.

### AC14 — repository quality gates pass

Expected: changed files are formatted, lint-clean, type-safe, and impact-selected CI tests are green.

Verification: `format:check`, `lint`, `typecheck`, package build, relevant unit/browser lanes, and `git diff --check`.

Pass signal: zero errors and clean diff check.

### AC15 — each retained finding is independently defensible

Expected: every finding includes reproduction, evidence, root cause, rejected alternatives, fix, regression, and residual risk.

Verification: finding ledger reviewed by a separate agent and by a revert/old-behavior proof where practical.

Pass signal: no finding marked fixed without all fields and passing evidence.

## 14. Autonomous-first verification matrix

| Criterion | Best autonomous method | Evidence | Access now | Substitute / gap |
| --- | --- | --- | --- | --- |
| AC1 | Bun unit + Chromium suites | command logs | yes | none |
| AC2 | frame-sampled real-browser stress | JSON metrics, trace, screenshot on failure | yes | live server seed is supplementary |
| AC3 | Playwright input events + post-growth sampling | operation log, pin/anchor metrics | yes | touch is emulated where native touch is unavailable |
| AC4 | host-state harness for history windows | page-state timeline and metrics | yes | none |
| AC5 | per-rAF anchor samples | anchor id/top series | yes | none |
| AC6 | deterministic callback/receipt harness | request/owner event log | yes | private refs are not inspected; behavior is authoritative |
| AC7 | bounded forward-page harness | anchor and availability transitions | yes | none |
| AC8 | production folds/disclosures in demo | metrics + screenshots/traces | yes | host-only chrome can be modeled in-flow |
| AC9 | Playwright viewport/container matrix | metrics + overflow values | yes | physical-device browser UI not required |
| AC10 | reduced-motion contexts + DPR + pure simulations | metrics and unit results | yes | fractional DPR support depends on engine; unit model fills gap |
| AC11 | seeded scenario runner | seed + bounded trace | self-resolvable | implement harness |
| AC12 | PerformanceObserver/rAF/listener instrumentation | JSON benchmark deltas | yes | browser scheduling noise handled by repetition/baseline ratio |
| AC13 | package and host builds | build logs | yes | staging deploy not needed |
| AC14 | repo scripts | command logs | yes | none |
| AC15 | independent worker review + old-behavior proof | review report | yes | none |

No acceptance criterion requires subjective human verification.

## 15. Autonomy and access audit

### 1 — available now

- OpenGeni repository and clean main baseline.
- CloudGeni repository for read-only host inspection.
- Authenticated GitHub CLI for branch/PR operations.
- Exact Bun 1.4.0 via `bunx --bun bun@1.4.0`.
- Chromium and Google Chrome 151.
- Playwright, Vite, React demo harnesses, and browser runner.
- Existing unit, component, browser, seed, and performance utilities.
- Git and package build/release scripts.
- Independent child-agent sessions for audit and falsification.

### 2 — missing but self-resolved

- System Bun was 1.3.14; exact 1.4.0 was resolved through the versioned `bun` package invocation.

### 3 — replaceable with local substitutes

- Production streaming traffic: replaced by real-shaped deterministic event and layout harnesses plus the existing live seed scripts.
- Physical mobile devices: replaced by browser viewport, DPR, touch-enabled context, and coarse-pointer/reduced-motion emulation, with an explicitly stated device gap if browser emulation cannot express a behavior.
- Staging-authenticated sessions: not required for package algorithm correctness; local real component/browser harness is stronger for deterministic assertions.
- Firefox/WebKit if not already installed: install project-local Playwright engines if useful and safe; otherwise treat them as supplementary rather than block Chromium-rooted fixes.

### 4 — user-provided access or decision required

None for implementation, autonomous verification, commits, or opening a PR.

Separate authorization would be required to merge, publish, or deploy. Those actions are not part of this goal and do not block merge-ready completion.

### 5 — not needed after analysis

- Production database access.
- Cloud deployment credentials.
- Real model-provider API keys.
- Production user data.
- Manual visual acceptance as the primary correctness signal.

## 16. Human-minimized fallback verification

No human verification is currently unavoidable.

If an engine-specific physical touch bug remains impossible to reproduce in browser emulation, prepare one deterministic demo URL and operation script. The smallest human check would be:

1. Open the prepared local/preview URL on the named device/browser.
2. Run the displayed numbered gestures exactly once.
3. Export the on-page metrics JSON and a screen recording.
4. Failure is any displayed invariant violation, not subjective motion preference.

This fallback must not be requested until autonomous Chromium/touch emulation and code inspection have been exhausted.

## 17. Test strategy

### Unit and property-style tests

- Pure camera conservation and convergence.
- Reader intent versus clamp conservation.
- Scroll-echo ownership/token accounting.
- Pagination owner transitions and stale completion rejection.
- Direction-aware window merge/eviction invariants.
- Seeded operation-model tests where DOM is unnecessary.

### Component tests

- StrictMode lifecycle.
- Disclosure and fold state transitions.
- Ref/state synchronization and stale callback fencing.
- Host callback compatibility, including void/promise/receipt older loaders.

### Real-browser tests

- Fixed regression cases per validated defect.
- Responsive/DPR/reduced-motion matrix.
- Per-frame anchor and debt sampling.
- Real wheel/keyboard/pointer interaction.
- Randomized replayable stress.
- Trace/screenshot/metrics only on failure or explicit evidence runs to keep CI artifacts bounded.

### Live seed use

- Use `stream-session-events.ts` and pacing presets as an observational integration lane after deterministic package tests pass.
- Do not treat a long manual watch as proof by itself.

## 18. Infrastructure and deployment validation

The core change is a published React package and demo/browser tests; no infrastructure mutation is expected.

Required release-oriented checks:

- `@opengeni/react` typecheck/build/demo build.
- package consumer/closure checks if exports or bundle shape change.
- bundle budget if new production code materially affects chunks.
- changeset for user-visible package behavior.
- CI impact map includes every new browser test or renamed harness.

No deployment is required. A later separately authorized release should use the normal changeset and GitOps process.

## 19. Observability and hardening strategy

- Test-only metrics should be precise and low-level: debt, anchor, pin, request count, frame intervals, long tasks, observer/listener counts.
- Do not add production telemetry containing session text, event payloads, IDs, or user behavior solely for this task.
- If production diagnostics are necessary, expose only fixed-cardinality state/reason counters and no content or tenant labels; obtain explicit architecture/observability review first.
- Failure artifacts must be bounded and avoid secrets because harness data is synthetic.

## 20. Risks and likely failure modes

- Fixing one jump by stealing ownership from the reader in another path.
- A browser test passing because waits occur after the jump rather than sampling the bad frame.
- Overfitting to Chromium at DPR 1.
- Mistaking native anchoring behavior for component correction.
- Introducing duplicate correction when both native anchoring and explicit math run.
- Timer-based fixes becoming flaky under hidden-tab throttling.
- Wider pin thresholds masking debt rather than removing it.
- Stress harness bugs generating impossible host states.
- Private test hooks coupling tests to implementation instead of behavior.
- Performance regressions from per-frame queries over every timeline row.
- Public compatibility regressions hidden by monorepo source imports.
- Changes that pass package tests but fail in a narrow host flex/grid composition.

## 21. Plan falsification checklist

Before accepting any finding or fix:

- Reproduce at least three times with the same seed/trace.
- Change cadence without removing the failure.
- Change viewport/DPR without relying on one magic pixel value.
- Confirm the harness uses supported public props and real DOM structure.
- Check whether browser clamp/native anchoring fully explains the movement.
- Check whether the row was intentionally evicted or regrouped.
- Check whether the user input was actually consumed by a nested scroller.
- Check whether a stale promise/observer belongs to an older generation.
- Disable/revert the proposed fix and prove the regression returns.
- Run existing suites to detect behavior transfer.
- Review for additional forced layout, timer, listener, observer, and render cost.

## 22. Context-compaction strategy

Before each implementation phase, reread:

1. `AGENTS.md` and this report.
2. The current finding ledger and last verification summary.
3. `message-timeline.tsx` invariant comment and the exact changed region.
4. `tip-follow.ts` if camera math is involved.
5. `use-session-events.ts` and `older-history.ts` if paging/window ownership is involved.
6. The harness and regression for the active defect.
7. `git diff` and `git status` to avoid losing or overlapping work.

Durable progress notes must record:

- validated versus falsified findings;
- exact failing seed/trace;
- files changed;
- commands and results;
- remaining milestone and risks.

## 23. Conditions requiring implementation to stop

- The suspected defect cannot be reproduced independently.
- The proposed test depends on private implementation state rather than user-visible behavior.
- A fix requires a breaking public API or architectural direction not authorized here.
- A host-specific defect remains after the package invariant passes and needs a separate repository change.
- A production data/security/telemetry change becomes necessary.
- Existing user-intent behavior must be traded off rather than preserved.
- Required exact-runtime verification cannot be restored.
- The worktree contains unknown overlapping user changes in touched files.
- Merge, publish, or deployment would be the next action without explicit authorization.

## 24. Definition of ready to merge

The branch is ready to merge only when:

- every retained important finding has deterministic evidence and a regression;
- every production change is tied to at least one retained finding;
- all candidate findings that were rejected are recorded with the reason;
- fixed and randomized browser matrices pass repeatedly across the defined responsive/motion/DPR dimensions;
- performance evidence shows no material regression;
- public package and host compatibility checks pass;
- format, lint, typecheck, unit, browser, build, consumer, and diff checks pass under Bun 1.4.0;
- a changeset exists for published behavior changes;
- independent self-review has attempted to falsify findings, tests, and fixes;
- commits are focused and the PR explains behavior, root causes, evidence, commands, and residual gaps;
- no merge or deployment has been performed.

## 25. Validated finding ledger

### F1 — failed initial history request retained the loading gate

- Reproduction: reject the first compact-tail `listEvents` request.
- Root cause: the effect error path set the error and connection state but never cleared `initialLoading`.
- Fix: clear the initial loading gate in the current-generation catch path.
- Regression: `a failed initial tail request exits the loading gate with an error`.

### F2 — unmatched explicit tool output could settle an unrelated call

- Reproduction: project two running calls, then deliver an output with a non-null unknown call id.
- Root cause: explicit-id lookup fell through to the legacy newest-running-call fallback.
- Fix: an explicit unmatched id now returns no call; fallback remains only for legacy id-less output.
- Regression: `an unmatched explicit tool output id never completes another running call`.

### F3 — a full backward browser window immediately discarded requested history

- Reproduction: stream 10,051 events, retain the newest 10,000, then load older history.
- Root cause: oldest-directed bounding evicted the live tail, after which SSE reconnected from the retained cursor and newest-bounded the window again.
- Fix: when backward paging evicts the live tail, retain the requested oldest window, enter history mode, expose `hasNewer`, and page forward explicitly.
- Regressions: both bounded-live-suffix and full-window backward-paging hook tests.

### F4 — compact forward paging duplicated coalesced text

- Reproduction: return a compact event whose `sequence` is lower than `payload.coalescedUntil`, followed by another forward page.
- Root cause: the forward cursor advanced by the compact event's first raw sequence and treated short compact pages as end-of-history.
- Fix: advance and retain every newest-window boundary by the maximum compact resume sequence, compare catch-up against that boundary, and require an empty page to prove the end.
- Regression: `compact forward paging advances by coalescedUntil and does not infer completeness from length`.

### F5 — stock host wrappers erased navigation promise semantics

- Reproduction: reject a jump promise through the first-party session route wrapper.
- Root cause: `void` wrappers converted promise-returning callbacks into fire-and-forget functions, defeating pending-latch rejection handling.
- Fix: preserve the real promise for newer/latest navigation and await the start callback in an async wrapper.
- Verification: React and web application type/build gates.

### F6 — repeated one-pixel pointer scrolling never released the live pin

- Reproduction: pointerdown at the live tip, then eighty separate one-pixel upward scroll writes.
- Root cause: reader intent compared only each individual scroll event against the two-pixel epsilon.
- Fix: retain pointer-start `scrollTop` and `maxScroll`, then classify cumulative clamp-conserved movement.
- Regressions: pure reader geometry tests and Chromium `cumulative one-pixel pointer scrolling leaves the tip`.

### F7 — content-shrink compensation depended on animation cadence

- Reproduction: collapse the same 60 CSS pixels as twenty 3-pixel frames and ten 6-pixel frames.
- Root cause: sub-epsilon frames adopted each height/top independently, while supra-epsilon frames compensated from an already browser-clamped top.
- Fix: retain one paired pre-collapse height/top baseline through the deadband, compensate cumulative shrink once, and clear/rebase on reversal, unpin, snap, or session reset.
- Regressions: pure cadence-invariance test and Chromium 3px/6px cadence matrix.

### F8 — dense history pages could mount thousands of visible groups

- Reproduction: one 5,000-event compact API page containing 5,000 user-message turns.
- Root cause: the group target stopped additional fetches but never trimmed an already oversized response.
- Fix: trim backward/forward windows at clean turn boundaries to the nearest 32 complete projected groups and preserve availability truth for the omitted durable range.
- Regressions: density-bounded older load and exact 32-group jump-to-start assertions.

### F9 — large prepend commits produced browser long tasks

- Reproduction: dedicated production bundle, 100-row prepend, PerformanceObserver and rAF sampling under 4× CPU throttling; reverting to an ordinary urgent state update produced 680 ms and 389 ms long tasks.
- Root cause: a large urgent React history update monopolized the main thread; replacing `flushSync` alone did not make the remaining state update interruptible.
- Fix: publish accepted older/newer/start/latest bulk navigation state in React transitions, with window, availability, mode, status, receipt/loading state scheduled together.
- Regression: Chromium `production-scheduled 100-row prepend avoids a browser long task`; the transition implementation passed three consecutive 4× CPU-throttled runs while the urgent-scheduling revert failed.

### F10 — the expanded browser gate left its retained workflow contract stale

- Reproduction: run `bun scripts/workflow-execution-graph.ts --git-tree 'HEAD^{tree}'` after adding the tip-follow suite to the interaction lane.
- Root cause: the CI step name and command changed, but the checked-in workflow graph manifest and the release-automation workflow expectation still described the pagination-only command.
- Fix: regenerate the workflow execution graph manifest from Bun 1.4.0 and update the release-automation contract to require the combined pagination/tip-follow command exactly.
- Regression: workflow graph verification plus the 113-test workflow graph/release-automation matrix.

### F11 — settled history and closed tooltip chrome still overworked a transition prepend

- Reproduction: after correcting the test to serve a dedicated production bundle, an unthrottled transition-scheduled 100-row prepend still produced repeated 54–83 ms long tasks. The stricter final fixture recreates every retained projected item, matching the live host's fresh projection identities.
- Root cause: every projection produced fresh group wrappers, so row memoization could not retain settled suffixes; the global bulk-animation context woke all consumers; and every newly mounted closed copy tooltip published its trigger through React state. A sampled production CPU profile attributed about 25 ms to per-row locale formatter construction and showed material garbage collection. The anchor fallback also retained offsets for the entire window although it reads only the first group.
- Fix: reuse prior group objects only when recursively render-equivalent, keep changed streaming/tool values invalidating immediately, memoize the complete keyed group shell, split mount-time and live entrance gates per durable group, retain only the first-group anchor offset, reuse one `Intl.DateTimeFormat`, and publish tooltip portal sources only when the tooltip opens (including controlled/default-open compatibility).
- Regressions: direct-item and raw-event prepends prove retained message render callbacks do not run again; same-key streaming still invalidates immediately; consumer-owned cyclic payloads fail closed instead of taking down the timeline; a closed copy tooltip stays at two profiler commits instead of the reverted three; the exact production fixture passed three unthrottled and three 4× CPU-throttled repetitions. Reintroducing mount-time tooltip publication made the same production-shaped gate fail with a 67 ms long task.

## 26. Falsified or harness-limited candidates

- Combined unpinned anchor loss was falsified after waiting for the real keyboard `scrollend`; PageUp had already released the pin before native movement began.
- A residual four-pixel debt after two frames was the documented sub-epsilon camera deadband; final convergence remained exact.
- CDP synthesized touch gestures hung in this headless rig; deterministic PointerEvent plus real scroll geometry was used. This is a harness limitation, not a retained product defect.
- Sending Runtime.evaluate after fully freezing a page hangs by design; queued work is installed before freeze and verified after resume.
- Removing `flushSync` alone did not fix prepend long tasks; ordinary urgent React state still produced 354 ms and 109 ms tasks. `startTransition` was the effective intervention.
- The first long-task regression served the Vite development graph while describing itself as production-scheduled. GitHub CI therefore measured 238 ms and 212 ms development tasks even with the transition fix. A dedicated production build plus static server replaced that invalid performance boundary; at 4× CPU throttling the fixed transition passed while the urgent revert failed with 680 ms and 389 ms tasks.
- `content-visibility` did not materially reduce the production-shaped task and would weaken exact `scrollHeight`/anchor truth, so it was rejected.
- Replacing per-key selectors with one all-group DOM scan left the measured task at 72 ms; the retained geometry improvement instead stores only the one first-group offset that restoration actually consumes.

## 27. Final verification evidence

- Repository-pinned Bun: 1.4.0 (`34cbb9a40`).
- Targeted timeline/unit/host/bundle-policy matrix: 521 tests across 13 files, zero failures.
- Tip-follow Chromium suite: 13/13 in the final strict console/page-error run; the cadence/responsive/stress matrix had also passed three prior repetitions.
- Timeline scroll/history Chromium suite: 33/33 in the final strict console/page-error run; the full matrix had also passed three prior repetitions before the final performance-source hardening.
- Responsive coverage: mobile DPR 3, tablet DPR 2 with reduced motion, desktop fractional DPR 1.25.
- Stress coverage: seeded 60-operation mixed trace with bounded operation log, frame/long-task/DOM/overflow assertions, frozen-page resume, keyboard, wheel, and coarse-pointer paths.
- Performance coverage: a dedicated production-bundle transition-scheduled 100-row prepend with fresh retained projection objects produced no Long Task entries and kept the maximum sampled frame interval below 50 ms in three consecutive unthrottled and three consecutive 4× CPU-throttled repetitions. The urgent-scheduling revert produced 680 ms and 389 ms long tasks; the closed-tooltip mount-publication revert produced a 67 ms long task in the final fixture.
- Bundle compatibility: after compacting the retained-group comparator and shared render props, repeated exact current-main Linux/x64 Bun 1.4 builds measured 2,201,665–2,201,700 raw / 617,112–617,126 gzip bytes across 31 direct-session files. Calibrating from the high observations leaves 1,948 raw bytes and 2,394 gzip bytes of policy headroom; initial, per-file, file-count, lazy-chunk, and CSS caps remain unchanged.
- Browser hygiene: zero uncaught page errors or unexpected console errors; the demo-only missing favicon request is the sole exact allowlisted resource miss.
- CI workflow ownership: the retained execution graph and exact browser-gate contract pass, including the combined pagination/tip-follow interaction command.
- No merge, publish, staging deployment, or production mutation was performed.
