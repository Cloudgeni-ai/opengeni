# Turn startup latency investigation

Status: active second-phase performance lab; no ship/merge decision implied.

The first experiment below established instrumentation and several safe local
improvements. It did **not** close the broader investigation. The 2026-08-14
continuation must reproduce every remaining suspect before proposing another
production change. Experimental changes stay on the local
`codex/turn-performance-lab` branch unless a later, separate review authorizes a
focused PR.

## Plain-language verdict on 2026-08-15

- Current `main` is materially better than the incident build: chat-only turns
  no longer create a sandbox merely because run credentials exist; NATS expiry
  reconnects immediately; external history ownership and the validator cache
  remove two previously repeated costs.
- Current `main` is **not** the complete result of this lab. The compact rig
  picker, huge-rig setup transport bound, exact-image marker skip, bounded rig
  defaults, duplicate-hook defense, unchanged-credential no-op, Connected
  Machine file batching, queue action UX, huge-queue render containment, and
  queue delta are local or experimental only.
- A phone does not provision the sandbox itself. The local picker can select all
  50 pathological rigs from a 3.9-KiB gzip summary and sends only a 378-byte
  create body containing `rigId`; the server then owns provisioning. With a
  verified Modal image, a fresh huge-rig box took 0.83--0.97 seconds locally.
  Without one, the final correctness-safe Docker control took 5.99--6.10
  seconds cold and 0.762--0.783 seconds warm. First image preparation normally
  took 15--19 seconds asynchronously, with one 26-second outlier.
- A maximum environment is a correctness problem, not merely a slow case. The
  schema allows far more data than Docker/process argument limits accept; the
  observed hard failure began at roughly 1 MiB. No benchmark truncates or drops
  those values. Product-level admission or a file-backed configuration contract
  is still required.
- Ordinary queues are fine. A pathological 5,000-row queue is not: the current
  full mutation response took about 2.11 seconds on the weak-mobile profile.
  The benchmark-only revision-fenced delta reconstructed the same complete
  5,000-row UI in about 112 ms and fell back to a full read on a stale version.
  This is the right direction, but not yet safe enough to merge.

## Second-phase acceptance rules

1. Preserve complete durable history and the complete user-visible timeline.
   History experiments may change internal loading, projection, caching, or
   pagination mechanics, but must not omit, summarize, trim, or hide accepted
   UI content as a performance shortcut.
2. Keep model/provider latency separate. Use deterministic scripted models for
   the benchmark matrix; use Luna only for a small bounded end-to-end control.
3. Establish a reproducible before/after distribution and call-count trace for
   every proposed optimization. A plausible code shape is not a finding.
4. Keep same-session ordering, authorization, durable-before-live events,
   exact attempt catalogs, file hashes/atomic replacement, and sandbox/rig
   identity fences unchanged unless an experiment proves a distinct defect and
   the replacement preserves the invariant explicitly.
5. Do not open, push, or merge a PR from this lab. Record negative results and
   "leave it alone" decisions as carefully as successful experiments.

### Required second-phase matrix

| Track | Cases that must be measured | Decision sought |
| --- | --- | --- |
| Connected Machine files | 0/1/5/20 files; present/missing/mutated; one/many sizes; injected latency | Whether serial verification is materially multiplicative and whether one bounded batch or bounded parallelism preserves per-file truth. |
| Complete history | 0/10/100/1,000/10,000 items; small/large text; attachments/tool results; cold/warm | Which DB, decode, projection, attachment, SDK, memory, or UI step scales; never reduce visible history. |
| MCP/tools | 0/1/5/20 servers; 0/20/80/large tool catalogs; stable/changing permissions; slow/unavailable servers | Whether connection reuse, list/catalog reuse, or attempt-local projection can help without stale authority. |
| Credentials | 1/5/20 accounts; active/expired/refresh-required; concurrent turns | Whether any lock, fairness, write, refresh, or event path—not the broad UI label—actually scales badly. |
| NATS auth | before/near/after five-minute user-JWT expiry; idle/streaming; forced transport break | Whether reconnect renewal is proactive and outside the turn critical path. |
| Queue/Steer UX | second prompt while running; Steer/Pause/Resume; cancellation fence; conflict/error; slow network | Whether authoritative pessimism causes avoidable dead time or visual rollback, and which optimistic projections are safe. |
| Worker/cold start | cold/warm process; one/two workers; balanced/skewed work; memory pressure | Whether placement or process warmth materially affects startup after application work is isolated. |
| Validator LRU | below/at/above 512 unique schemas; repeated hot subset; active references | Whether eviction causes harmful CPU/GC churn; functionality must remain identical. |
| Modal rigs | small/medium/large setup and resulting image; logical/provider-immutable; cold/warm; eager/lazy | Whether verified provider images make large rigs consistently fast and where fallback/setup costs remain. |

### Current-main reconciliation (2026-08-14)

The clean lab starts from `origin/main` at
`2df4577b3e6d39606aa3810a0d1b6eee34f66e68`. Several recommendations in the
original incident note predate merged fixes and are not open implementation
tasks anymore:

| Earlier concern | Current-main state | Remaining proof / work |
| --- | --- | --- |
| Blank, unattributed warm startup | Phase diagnostics and honest worker-only aggregation merged in #1422 (`944be7f84`). | Reproduce the full matrix and decide which phases deserve user-visible progress. |
| Chat-only turns eagerly create a local Docker sandbox | Exact local lazy-provision key and policy-reason diagnostics merged in #1422. Credentials, generated videos, signed files, and Connected Machines intentionally remain eager. | Measure small/large rigs, signed resources, and Connected Machines; do not remove eager correctness fences. |
| Full SDK history cloned into a portable snapshot | Runtime now uses `historyOwnership: "external"`. At 8,000 × 1 KiB synthetic items the exact same 8,000 wire items took 131 ms / 15.8 MiB peak delta versus 1,862 ms / 238.7 MiB under SDK-owned history. | Benchmark DB load, shape guards, canonical/provider projection, attachments, and UI rendering. Preserve the complete UI timeline. |
| History and sandbox-envelope reads serialized | They run concurrently in `run-input.ts` since #1422. | Measure each independently; history still pages and projects the complete admitted active model set. |
| Identical AJV schemas recompiled every turn | Bounded exact content-addressed 512-entry LRU merged in #1422. Attempt catalog, executor, permissions, and persistence are still rebuilt per attempt. | Stress below/at/above 512 to measure eviction CPU/GC; do not weaken attempt authority. |
| Five-minute NATS credential causes outage backoff | #1173 (`00a17ba51`) classifies `User Authentication Expired` as scheduled rotation and reconnects immediately with the 30-day enrollment bearer. A real auth-callout/broker proof now confirms the complete expiry seam. | Keep the regression proof; do not change the production TTL or reconnect policy. This is not a remaining startup defect. |
| New prompt looks absent while admission is pending | #1334 (`ded5ec897`) added an immediate optimistic composer/timeline projection and durable reconciliation. | Already-queued row actions remain pessimistic and need slow-network UX experiments. |
| Queue/Steer semantics | Same-session FIFO, exact versions, cancellation fences, and durable queue snapshots are heavily tested. Composer Steer is optimistic; row move/edit/Steer/delete wait for the server response. | Measure click-to-feedback, accept, physical quiescence, next-turn start, conflict, and retry separately; improve projection/explanation without pretending a mutation committed. |
| Serial Connected Machine file verification | Confirmed multiplicative on current main. Durable cache remains intentionally disabled because users may mutate ambient files. | The local candidate now uses byte-and-item-bounded in-sandbox chunks only for Connected Machines, keeps the one-file path unchanged, and preserves every file/event. Real remote-machine acceptance remains. |
| Unchanged Codex credential session write | `recordSessionActiveCodexCredential` still updates `codex_last_credential_id` and `updated_at` every Codex turn, although the switch event is conditional. | Measure one/many-account lock/write/event cost before considering a guarded write. |

### Latest-main recheck (2026-08-15)

`origin/main` advanced to `6598eefe4363faf83c20bec9fc646c182e1057b4`
while this deliberately uncommitted lab remained on its frozen control base.
The relevant source paths were compared directly before continuing:

- #1473 (`90a03e5c6`) fixed one real earlier concern: merely resolving host
  run credentials no longer forces an eager sandbox. Credential authority and
  auth-needed model context are still resolved before the model boundary, while
  sandbox materialization and renewal now enter the first-operation lazy
  provisioner. Generated-video files, signed file resources, and an explicit
  Connected Machine correctly remain eager.
- The default 16-row active-history page, complete-history disclosure render,
  rig full-definition list path, serial Connected Machine file command path,
  and attempt-wrapper opt-in to the Agents SDK global MCP tool-list cache are
  unchanged on latest main. Their local measurements and candidates remain
  relevant.
- The only upstream `SessionChrome` overlap changes goal-state wording and
  elapsed-time behavior. It does not implement the local Queue/Steer receipt,
  render-plane, action-feedback, or reason-copy candidates.
- #1485 improves sandbox/browser/computer interaction reliability, but does not
  add the Connected Machine file batching or rig summary route measured here.
- #1483 adds standalone-runner containment policy. It does not change the turn
  startup, rig selection, history, queue-row, Connected Machine file, or MCP
  catalog paths measured here.
- #1482 adds scheduled personal-resource delegation snapshots. Its only overlap
  with the lab is shared contract/database/demo files; it does not change rig
  summary transport, rig-default resolution, queue rendering, Connected Machine
  file materialization, complete-history rendering, or attempt-scoped MCP tool
  projection.
- The richer startup timeline is **not** on main. PR #1475 is still open at
  `313f4afa3`, has no submitted review, and now conflicts with current main in
  the worker activity and deployment documentation. Current main already owns
  the complete low-cardinality startup phase metric family from #1422. The PR
  adds four durable UI events for only two gaps (`tools` and
  `model_preparation`), which require three additional append transactions on
  the successful first-request critical path; the fourth event is co-batched
  with the existing model-request audit. The local clean-append median implies
  roughly 30 ms of ordinary added persistence before contention, while the
  measured lock and pool cases show why extra startup transactions are not
  free. Treat that branch as a design input, not a ready or costless fix.

This recheck prevents an obsolete recommendation: eager sandbox creation for
the mere presence of resolved run credentials is no longer an open problem on
main. The lab does not transplant or duplicate that upstream fix.

Two later controls sharpened this reconciliation:

- The exact SDK cache seam reproduced the authority leak without a provider or
  model call. With the current-main wrapper setting (`cacheToolsList=true`), a
  broad attempt exposed `read` and `delete`, then a new narrow attempt with the
  same registry identity incorrectly exposed both from the process-global
  cache. With only the outer attempt-frozen wrapper cache disabled, the narrow
  attempt exposed `read` alone. The wrapper's own frozen `listTools` promise and
  the inner connection-local cache remain, so this removes no authorized tool
  and adds no repeated remote list call.
- Connected Machines officially support Linux, macOS, and Windows, but the
  current-main signed-file materializer emits a POSIX shell program (`set -eu`,
  shell functions, `mktemp`, `wc`, `awk`, `chmod`, and `curl`). Windows executes
  shell requests through `cmd.exe`, so attachment delivery is already broken
  there. The local batching candidate is consequently enabled only for a live
  Linux/macOS enrollment. A real Windows repair needs a structured native agent
  download/verify/atomic-replace operation (or another separately proved
  transport); an ad-hoc PowerShell string is not accepted as a cross-platform
  fix.

### Second-phase finding: zero-step truth does not require a new event protocol

The screenshot's blank card is a real product defect, but its first safe repair
does not require the conflicted startup-phase branch. Before any timeline item
exists, the browser already has the durable session lifecycle and effective
Pause state. The local copy-only candidate maps those facts to `Queued to
start`, `Starting the agent`, `Restoring this session`, `Waiting for capacity`,
`Waiting for your response`, or `Workstream paused`; running and recovering
states use the existing reduced-motion-safe spinner. It never invents which
internal subphase is active, drops timeline content, or changes persistence.

Two focused web regressions cover every active lifecycle family and prove that
an effective Pause wins over a stale running status. Web typecheck passes. This
is a small, independently reviewable UX candidate. PR #1475's two exact phase
families may later add useful detail if they are rebased, reviewed, and shown to
justify their three extra critical-path append transactions; they are not a
prerequisite for replacing the false inert-state message.

### Second-phase finding: complete active-history paging

`getActiveSessionHistoryItemsPaged` preserves the complete admitted active model
history, but current main defaults to 16-row keyset pages. The value arrived with
the OPE-52 memory-admission work; neither the commit, PR body, nor review evidence
records a measurement that specifically requires 16. It appears to have been a
conservative implementation choice, not a semantic limit. The independent
8,192-row, 15 MiB, node, and property guards remain the actual admission
envelope.

A real disposable-Postgres benchmark now lives at
`scripts/bench-turn-history-read.ts`. It verifies the exact row count and exact
position order for every case and never calls a model. It does not read or
change `session_events`, so it cannot reduce the user-visible timeline.

For 8,192 ordinary 512-byte rows, increasing the page size from 16 to 100 kept
all 8,192 rows and changed:

| Default candidate | Page queries | Total SQL statements | Median | p95 |
| --- | ---: | ---: | ---: | ---: |
| 16 rows | 513 | 516 | 758 ms | 836 ms |
| 100 rows | 82 | 85 | 143 ms | 211 ms |

This is a 5.3× median improvement before adding any network round-trip cost.
The 431 avoided sequential statements save another ~431 ms at 1 ms database
RTT, ~2.16 seconds at 5 ms, or ~8.62 seconds at 20 ms.

The byte-boundary control used 480 rows with about 15 MiB total JSON and rotated
the first-tested page size across four samples to avoid cold/warm ordering bias.
Page 100 remained fastest (101 ms median versus 143 ms for page 16) and did not
increase the measured peak or retained RSS delta. The local experiment therefore
changes only the default from 16 to the already-enforced maximum of 100; all
limits, repeatable-read semantics, lossless decoding, ordering, and explicit
small-page test seams remain unchanged.

Focused evidence: DB and worker typechecks pass; formatter and lint pass; 35 of
37 combined database/worker tests passed. The two failures were five-second
wall-clock timeouts with no assertion failure. In isolation under a diagnostic
15-second harness timeout, both passed (3.93 seconds for the unrelated oversized
approval `RunState` property guard and 0.62 seconds for idle compaction). The
existing timeout sensitivity is recorded separately and is not being hidden by
raising a repository threshold.

### Second-phase finding: queued-row feedback can be immediate and truthful

Current main already projects a newly submitted prompt and composer Steer
optimistically. The remaining bad interaction is narrower: move, edit, Steer,
and delete actions on an already queued row give no visible acknowledgement
until the mutation returns. Move is worse because drag-and-drop first renders
the desired order, then snaps back to the server order for the whole request.

The local prototype keeps the server, version conflict, and retry semantics
unchanged. A move records a version-bound local order immediately and renders
the existing authoritative rows in that order only while the exact queue
version still matches. Membership mismatch or a newer server version discards
the projection. Edit, Steer, and delete keep every row visible but immediately
show truthful states: `Moving to composer`, `Changing direction`, or `Deleting`.
No action is presented as committed before acknowledgement.

Slow-response component tests prove that all rows and content remain present,
the projected order remains stable until acknowledgement, the server order
wins afterward, and each mutation kind has visible status. The full React suite
reports 113 passes, 0 failures, and 1,560 expectations; React typecheck, lint,
format, and diff checks pass.

A production-built mobile-width browser harness then held every mutation open
for 1.5 seconds and changed canonical state only when that delay completed:

- Steer kept all five rows in their canonical order and showed `Changing
  direction…`; after acknowledgement the exact target moved to the head.
- Keyboard reorder kept all five rows visible, projected the requested order
  while the harness still exposed the old canonical order, and committed with
  no snapback.
- Delete and edit kept the target row visible with `Deleting…` or `Moving to
  composer…`, then removed it exactly once after acknowledgement.
- A rejected reorder first showed the same complete optimistic projection,
  then restored all three rows to unchanged canonical order and displayed the
  exact server error after the 1.5-second rejection.

This is intentionally optimistic only where the client can be truthful. A
reorder can safely project an order over the same version-bound membership.
Steer, delete, and edit must not visually claim completion before the server
accepts the control or data transition. Deterministic slow and rejected modes
remain in the browser fixture so this contract can be regression-tested without
a real backend race.

A later production-route audit found that this first browser fixture exercised
the exported `QueueSurface`, while `apps/web/src/routes/session.tsx` deliberately
uses the separate compact `SessionChrome` queue panel. The repository even has
a source contract rejecting `QueueSurface` on that route. The first result was
therefore valid for SDK consumers but incomplete for the OpenGeni web app.

The production panel had three concrete gaps: it showed only a tiny icon for a
pending row mutation, never rendered `queue.error` or `queue.mutationError`, and
discarded the `ComposerDraft` returned by a successful queue checkout. The last
case eventually reconciled through the durable `session.queue.changed` event,
but needlessly left the composer stale between acknowledgement and that extra
read. A failed mutation could simply snap back with no visible explanation.

The local production-panel prototype now applies the returned draft immediately
through `composer.applyDraft`, displays explicit pending labels, surfaces the
exact server error with canonical refresh/dismiss controls, and projects a
pending move only across identical version-bound membership. It never removes
a delete or edit row before acknowledgement, and a rejected move restores the
server order.

The actual production `SessionChrome` component was then exercised at 390×844
with a deterministic 1.5-second mutation delay. Pending and accepted reorder
kept all three rows visible and projected `[2,1,3]`; rejection restored
`[1,2,3]` with the exact server error. Delete and Edit retained all three rows
with `Deleting…` / `Moving to composer…` until acknowledgement; rejected
actions restored the exact rows, while accepted Edit put the exact prompt in
the textarea and focused it. Pending Steer represented the target in the
`Changing direction…` chip while the other two rows remained in the queue;
acceptance preserved that representation and rejection restored all three rows
with an error. No prompt was hidden or discarded to make the UI faster.

Focused production-component tests now also pin rejected-reorder rollback in
addition to accepted projection, draft checkout, and failure actions. The real
API still owns OCC and durable queue correctness; the dev harness proves the
phone interaction states without needing to manufacture a backend race.

The real Postgres path is not the source of the awful feel at ordinary queue
sizes. With 200 queued turns and 20 alternating samples, the exact
move/delete/edit/Steer operations were 70/58/69/75 ms p50
(113/83/107/138 ms p95). The earlier 5,000-row `2.59 MiB` figure counted prompt
bytes only, however. It was not the complete wire response and must not be used
as one.

A later cost breakdown used the unchanged current-main database/core queue
implementation and measured the canonical snapshot, its real gzip transport,
and the current normalize-every-position primitive independently. Prompts were
complete and roughly 488 characters each:

| Rows | Canonical JSON / gzip | Snapshot p50 | Rewrite every position p50 | Experimental one-row head move / delete p50 |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 137 KB / 9 KB | 10 ms | 8 ms | 5 / 4 ms |
| 1,000 | 1.37 MB / 84 KB | 15 ms | 32 ms | 6 / 5 ms |
| 5,000 | 6.85 MB / 413 KB | 41 ms | 150 ms | 14 / 13 ms |
| 10,000 | 13.71 MB / 827 KB | 75 ms | 296 ms | 13 / 10 ms |

The sparse experiment used the same negative-head convention as existing
queue admission, incremented the exact turn/queue versions, and proved that all
nondeleted ids remained unique and strictly ordered with the last moved row at
the head. It deliberately omitted command authorization, locks, receipts,
events, interruption, and the final response; it is algorithm evidence, not a
production patch. Delete/Edit and move-to-head/Steer have credible constant-row
position updates. Arbitrary drag-to-position still needs a safe range-shift or
bounded rebalance design, and eventual numeric rebasing needs an explicit
policy. Do not replace the current algorithm from this microbenchmark alone.

The API does gzip JSON. A real Chrome 4x-CPU fetch of the exact synthetic
5,000-row payload then separated HTTP transfer, decompression/text creation, and
JSON parsing. The canonical response completed in 55 ms on loopback, 399 ms at
10 Mbps/40-ms latency, and 2.114 seconds at 1.6 Mbps/100-ms latency. Parse itself
was only 13--17 ms; transfer and decoded-string creation dominated. An additive
projection retaining all 5,000 rows plus every field used by the current queue
UIs--exact prompt, annotations, resources, tools, model, reasoning, metadata,
versions, and timestamps--was still 4.00 MB / 276 KB and took 28 / 274 / 1,448
ms under the same profiles. Removing server-only tenant/execution fields helps,
but does not make repeated huge-queue responses cheap.

A measurement-only revision-fenced delta then moved the exact last row to the
head without sending the other 4,999 rows again. The client began with the
complete queue already in memory, required an exact base-version match, applied
one complete replacement row, resorted locally, and retained all 5,000 exact
prompts. The delta was 1,279 bytes / 522 bytes gzip. Across five Chrome samples
at 4x CPU, fetch + parse + complete local reconstruction took 2.7 ms p50 on
loopback, 49.1 ms at 10 Mbps/40-ms latency, and 112.3 ms at 1.6 Mbps/100-ms
latency; local application itself was 1.4/1.9/2.5 ms p50. An injected stale
base version left all existing rows untouched and selected a complete-snapshot
refetch. This proves the likely payoff without reducing the UI data. It does
not yet prove an API/SDK contract, arbitrary reorder deltas, multi-client event
ordering, or exact SSE suppression, so it remains benchmark code only.

The full command benchmark remains the end-to-end server result: at 5,000
rows, move/delete/edit/Steer were 270/231/219/253 ms p50 before mobile transfer
and final rendering. Thus huge-queue settlement is a real problem even though
ordinary queues are fine. The promising protocol direction is a
version-fenced mutation delta that retains the complete local queue, applies
only when its base version matches, and falls back to a full canonical read on
any mismatch. It must also suppress only the matching redundant live refresh,
preserve public SDK compatibility through an additive contract, and prove
multi-client/out-of-order behavior before product code changes. Immediate
truthful feedback remains independently valuable; it must not pretend this
settlement already occurred.

### Second-phase finding: the collapsed queue is cheap; per-action tooltip state is not

The production surface is `SessionChrome`, not the standalone SDK
`QueueSurface`. A first 5,000-row browser measurement of `QueueSurface` was
therefore rejected as product evidence. The corrected benchmark,
`scripts/bench-session-chrome-queue-browser.ts`, builds the actual web bundle in
an isolated performance mode, mounts the production `SessionChrome` at 390×844,
and verifies every exact row id and every full 512-character prompt. No row is
paginated, virtualized, summarized, or omitted.

The production component normally starts collapsed. Separating navigation from
the explicit queue-panel click showed that 1, 100, 1,000, and 5,000 queued
prompts all reached the collapsed surface in about 0.95–0.99 seconds. Even the
5,000-row case retained only about 13.5 MiB of JS heap and 300 DOM nodes while
collapsed. A huge queue therefore does not explain a blank normal session
startup.

Opening the panel exposed a distinct multiplicative defect. The original
implementation mounted five Radix tooltip roots per interactive row. Three
fresh optimized-browser samples produced:

| Rows | Open p50 | Long-task total p50 | JS heap p50 | DOM nodes |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 271 ms | 210 ms | 28.1 MiB | 3,203 |
| 1,000 | 2,231 ms | 2,196 ms | 247.9 MiB | 29,303 |
| 5,000 | 26,855 ms | 26,807 ms | 1.04 GiB | 145,303 |

A read-only control kept the same complete prompt text but omitted actions. It
opened 5,000 rows in 302 ms with 28.7 MiB heap. That isolated the prompt rows
and data from the action machinery. Replacing styled tooltips with native
`title` attributes proved the same cause (5,000 rows in 1,216 ms), but was
rejected because the component deliberately guarantees no native-title hints
and the Steer action needs focus-visible explanatory copy.

An intermediate local candidate kept all five buttons on every row but replaced
the per-button framework state with one event-delegated tooltip layer. It
preserved the styled focus explanation and all prompt/action semantics while
removing the catastrophic tooltip multiplier:

| Rows | Shared-tooltip open p50 | Long-task total p50 | JS heap p50 |
| ---: | ---: | ---: | ---: |
| 100 | 96 ms | 0 ms | 15.8 MiB |
| 1,000 | 323 ms | 210 ms | 29.0 MiB |
| 5,000 | 1,291 ms | 1,240 ms | 129.1 MiB |

The shared-tooltip implementation was also rerun for three fresh samples
at a 4× CPU throttle, representative of a materially slower phone. Collapsed
startup remained effectively independent of queue size: the 5,000-row case was
ready in 1.31 seconds p50 with about 13.4 MiB heap and roughly 300 nodes. The
explicit open cost was 307 ms for 100 rows, 1.50 seconds for 1,000, and 6.40
seconds for 5,000. The last case retained all 2,560,000 prompt characters,
passed the styled keyboard-tooltip contract, used 136.8 MiB heap, and mounted
145,306 DOM nodes.

This was not accepted as the final interaction. A phone audit exposed a more
important UX defect: five tiny unlabeled icons per row are difficult to
understand on touch, and a tooltip cannot teach the action before the first tap.
Keeping every full prompt visible does not require keeping every secondary
control expanded at rest.

A later lossless pass first removed two implementation multipliers. Queue-chip
state no longer allocates a presentation object for every turn when it needs
only the first prompt plus an early-exit voice-only verdict. The action list
also moved to one delegated click listener. CSS-mask icons were an intermediate
rendering experiment, not the retained product direction.

The retained touch prototype now shows two visible text actions on every row:
`Steer` and `More`. `More` discloses `Move up`, `Move down`, `Edit`, and
`Delete` for only that row. All five original operations remain available and
call the same queue APIs; only dormant secondary controls are collapsed. The
complete prompt remains mounted and searchable, the list still uses one
delegated listener, and the expanded row is linked with `aria-expanded` and
`aria-controls`. Accepted, rejected, pending, keyboard, and focus behavior are
covered by production-component tests.

The production 390×844 touch benchmark at 4× CPU verifies every exact id,
every full 512-character prompt, visible `Steer`/`More` controls on every row,
the complete four-action disclosure, zero horizontal overflow, and truthful
settlement. Compared with the best five-icon delegated implementation:

| Rows | Five-icon open p50 | Text-action open p50 | DOM nodes before / after |
| ---: | ---: | ---: | ---: |
| 1 | 101 ms | 90 ms | 350 / 322 |
| 100 | 155 ms | 127 ms | 2,053 / 1,411 |
| 1,000 | 594 ms | 362 ms | 17,329 / 11,311 |
| 5,000 | 2,636 ms | 1,474 ms | 85,333 / 55,311 |

At 5,000 rows, aggregate long-task time fell from 2,519 to 1,411 ms and
measured heap from about 40.1 to 33.1 MiB. This is a UX improvement and a 44%
open-time improvement at the extreme size, not a content-reduction trick.

The same fixture exercised each operation after disclosure. The best comparable
five-icon implementation versus the retained text-action implementation was:

| Queue rows | Steer feedback before / after | Delete feedback before / after | Move feedback before / after |
| ---: | ---: | ---: | ---: |
| 1,000 | 146 / 88 ms | 44 / 30 ms | 48 / 35 ms |
| 5,000 | 602 / 345 ms | 206 / 101 ms | 274 / 121 ms |

One-row Delete feedback is 13--14 ms. Rejected Delete remains visually
unchanged and reports its exact error; a 5,000-row Delete touches one row and
six DOM mutations, while Move touches two rows and 19 mutations. Steer is
different: removing an early item truthfully renumbers every later visible row.

The retained Steer prototype uses React's deferred rendering only for that
submitting state. The urgent render immediately shows `Changing direction…`,
keeps the complete old queue mounted, disables and labels the target row
`Changing…`, and does not imply that the server committed. The deferred render
then removes the acknowledged target and renumbers the complete queue. At 4×
CPU, the visible truthful receipt / fully consistent queue p50 was 15.5 / 21.7
ms for 100 rows, 25.2 / 70.8 ms for 1,000, and 59.5 / 277.1 ms for 5,000. Every
sample observed the truthful intermediate state and exact final content.

Do not hide prompts, virtualize rows, truncate actions, or weaken exact
ordinals merely to improve the pathological case. The improvement comes from
clearer action presentation, fewer dormant controls, structural sharing, and
scheduling truthful feedback ahead of unavoidable complete-list reconciliation.
Further work needs real queue-size telemetry, not another invisible rendering
shortcut.

A 2026-08-15 production-mode recheck kept the 390x844 touch surface at 4x CPU,
injected a 1.2-second mutation response, and repeated every action at 100 and
5,000 complete rows. At 100 rows the panel opened in 64--70 ms,
move/delete feedback appeared in 14--18 ms, and Steer's truthful receipt in 14
ms. At 5,000 rows every id and all 2.56 million prompt characters remained
mounted and exact; panel open was 1.29--1.33 seconds, move/delete feedback
89--115 ms, and the Steer receipt 55--62 ms. The complete 5,000-row Steer
reconciliation was 258--273 ms. Rejected deletes restored exact state and every
parity/truth assertion passed. A separate dev-server control was slower and is
not used as production performance evidence.

The no-omission `content-visibility:auto` follow-up is now an accepted local
candidate after correcting an initially stale intrinsic estimate. The CSS
intrinsic size describes the content box, not the outer padded row. The final
responsive values are therefore 28 px on desktop and 44 px on coarse pointers,
producing exact measured outer rows of 36 and 52 px. Using 52 px as the content
estimate would have produced 60 px skipped rows and drifting scroll geometry.

The final 5,000-row depth proof kept all 2.56 million prompt characters and all
rows mounted on both 390x844 touch and 1280x900 desktop surfaces. Initial,
native-find, deep-focus, and three complete top/bottom cycles had zero-pixel
scroll-height spread: 270,042 px mobile and 190,042 px desktop. Browser find
selected the exact last prompt, the full accessibility tree contained its text
and action, and direct keyboard focus reached the final `More` control. Native
find across 2.56 million characters itself took about 2.14--2.17 seconds; that
is a real deep-search cost but is separate from opening or mutating the queue.

The final production action matrix used a 390x844 touch viewport, 4x CPU, three
samples, and a 1.2-second delayed fake server. All 1/100/1,000/5,000 cases kept
complete content, action, containment, rollback, and truthful-state parity. At
5,000 rows, panel-open p50 was 531--547 ms depending on action. Steer showed its
truthful receipt in 69 ms and reached the complete consistent queue in 319 ms;
Delete, rejected Delete, and adjacent Move feedback were 124, 108, and 143 ms.
The visible `Steer`/`More` controls and all disclosed actions met the 44-px
coarse-pointer target and real center taps hit the intended button. Unsupported
browsers ignore the paint optimization and keep the complete existing
behavior.

The same local prototype also accepts the host's durable session status and
shows one explicit explanation above the complete queue: after the current
turn, waiting for a response, restoring, waiting for available capacity,
paused by the authoritative control blocker, or waiting for an interrupted
attempt to become physically quiescent. It does not infer global capacity or a
provider problem from a generic queued row. The first queued row's durable
timestamp supplies elapsed wait without rerendering the row list. This is a UX
experiment, not a protocol change or merge decision.

### Second-phase finding: Connected Machine file checks multiply remote RTT

`materializeSandboxFileDownloads` currently performs one complete sandbox
command per signed file, serially. Each command safely rejects symlink paths,
checks size and SHA-256, downloads only a missing or changed file to a temporary
path, verifies it, atomically renames it, and applies read-only mode. Checking
again every turn is intentional for Connected Machines: the user can mutate the
ambient filesystem between turns, so a durable `already downloaded` receipt is
not sufficient truth.

`scripts/bench-connected-machine-files.ts` runs the exact production one-file
operation with 0/1/5/20 4-KiB files and injected command RTT, comparing current
serial orchestration with a four-wide lab orchestration. Every output byte is
compared, and a separate missing-plus-mutated case must be repaired. Two-sample
cold/warm medians were:

| 20 files | Serial cold | Four-wide cold | Serial present | Four-wide present |
| --- | ---: | ---: | ---: | ---: |
| 0 ms injected RTT | 664 ms | 205 ms | 307 ms | 110 ms |
| 20 ms injected RTT | 1,209 ms | 354 ms | 795 ms | 232 ms |
| 100 ms injected RTT | 2,748 ms | 802 ms | 2,510 ms | 685 ms |

The product-path prototype now makes this opt-in at the primitive and enables it
only for `backendId === "selfhosted"`. Serial remains the default for every
other caller and managed providers retain their existing durable cache. The
primitive rejects concurrency outside 1–8, caps itself at the existing
eight-command admission ceiling, and automatically falls back to serial when
two normalized downloads target the same path. Results stay in input order even
when remote commands complete out of order. A cancellation or fatal event stops
scheduling new files, drains the bounded in-flight commands, and only then
propagates the original error.

A three-sample rerun through that exact primitive—not a hand-written parallel
loop—produced these medians:

| 20 files | Serial cold | Four-wide cold | Serial present | Four-wide present |
| --- | ---: | ---: | ---: | ---: |
| 0 ms injected RTT | 787 ms | 200 ms | 411 ms | 115 ms |
| 20 ms injected RTT | 1,319 ms | 317 ms | 895 ms | 221 ms |
| 100 ms injected RTT | 2,863 ms | 788 ms | 2,481 ms | 643 ms |

Five-file cases improved about 2.4–3.2×; one-file behavior was unchanged. Every
sample retained every selected file. The repair control again proved missing
and mutated targets were restored byte-for-byte with zero reported failures.
Adversarial runtime tests additionally prove the four-wide bound, stable failure
ordering, duplicate-target serialization, signed-URL redaction, and cancellation
drain. The latest complete runtime file reports 282 passes; runtime and worker
typechecks pass.

The first matrix intentionally isolated remote commands. A second control
serialized a synthetic 5-ms durable event append for every per-file started and
terminal event—the real worker emits 40 such events for 20 successful files.
At 20-ms command RTT, serial/four-wide cold medians were 1,841/474 ms; at
100-ms RTT they were 3,090/864 ms. Thus event persistence is another measurable
linear cost, but it does not erase bounded-command parallelism. A real worker
run must measure the actual append distribution before considering event
batching; it established the cost model before the later bounded-batch
experiment altered any event grouping.

This remains a local experiment, not a ship decision. The remaining acceptance
gate is the same matrix against a real remote Connected Machine, including
several files sharing a parent directory, a real Steer during materialization,
and observation of host CPU/I/O pressure. Hash checks, symlink rejection,
temporary-file verification, atomic rename, read-only mode, and per-file runtime
events remain unchanged.

#### A single unbounded batch is not the answer

`scripts/bench-connected-machine-batching.ts` compares the exact host-serial and
host-parallel primitive with two one-exec shell prototypes: sequential work in
the sandbox and four-wide work in the sandbox. The latter shares verification
code once, reports one bounded success/failure marker per input, and retains the
same exact-byte, SHA-256, regular-file, symlink-parent, temporary-file,
atomic-rename, read-only, repair, and signed-URL-output invariants. Three-sample
medians with realistic 384-character signed-URL padding were:

| Files / injected command RTT | Four host commands wide, cold / present | One in-sandbox command, four downloads wide, cold / present |
| --- | ---: | ---: |
| 20 / 0 ms | 187 / 96 ms | 250 / 191 ms |
| 20 / 20 ms | 326 / 227 ms | 296 / 206 ms |
| 20 / 100 ms | 713 / 623 ms | 416 / 313 ms |
| 100 / 0 ms | 909 / 502 ms | 1,339 / 865 ms |
| 100 / 20 ms | 1,414 / 1,065 ms | 1,419 / 1,025 ms |
| 100 / 100 ms | 3,705 / 3,094 ms | 1,508 / 1,079 ms |

That is a genuine RTT/file-count crossover, not a universal batch win. At low
latency the existing host-parallel path is faster; at high remote latency the
batch removes enough control trips to win materially. Correctness controls for
all four strategies repaired one mutated and one missing target, kept every
target byte-exact and read-only, rejected a symlinked parent without following
it, and emitted no signed URL in captured command output.

Command size forbids an unbounded implementation. With the same URL padding,
the parallel prototype is about 24.6 KiB for 20 files, 58.9 KiB for 50, 116.3
KiB for 100, and 1.16 MiB for 1,000. The resource contract does not currently
cap the array. A viable product candidate must therefore chunk by encoded bytes
as well as item count, retain four-download sandbox concurrency, fall back to
the one-file primitive when even one item exceeds the chunk budget, and keep
failure attribution plus cancellation truthful. Do not switch based only on
file count or issue one giant manifest command. Real provider command-size and
cancellation behavior are still admission gates.

The local product-path experiment now implements that bounded shape rather than
the earlier prototype: at most 20 files and 48 KiB of encoded shell per command,
four downloads inside the machine, sequential chunks, a one-file fallback for
an individually oversized URL, 2-KiB single-line diagnostics per file, and
input-ordered result parsing. It is enabled only when the active backend is
`selfhosted`; one file and every managed provider retain the old primitive.
Started events are persisted as one complete array per chunk and terminal
events as a second complete array. No file or event is omitted.

`scripts/bench-connected-machine-files.ts` now calls that exact helper and
simulates both remote command RTT and a conservative 15-ms durable event
transaction. A fresh three-sample rerun on 2026-08-15 measured:

| Exact product helper | 20 cold / present | 45 cold / present |
| --- | ---: | ---: |
| Four host commands wide, 0-ms RTT | 677 / 660 ms | 1,536 / 1,493 ms |
| Bounded chunks, 0-ms RTT | 185 / 135 ms | 462 / 340 ms |
| Four host commands wide, 100-ms RTT | 933 / 896 ms | 1,924 / 1,949 ms |
| Bounded chunks, 100-ms RTT | 319 / 252 ms | 802 / 678 ms |

The improvement is not attributed solely to shell batching: the exact event
benchmark below proves that replacing 40 same-session transactions with two
complete event arrays is material. A five-sample zero-event/zero-RTT control
kept the crossover honest: four host commands were faster than one shell chunk
for 20 files (201/105 ms versus 238/158 ms) and 45 files (470/271 ms versus
567/401 ms). The candidate is justified for a remote Connected Machine with
durable events, not as a universal local-shell optimization.

Actual-shell tests verify exact bytes, SHA/size repair, atomic replacement,
read-only mode, symlink-parent rejection, duplicate file-id attribution, stable
failure order, 20/20/5 chunking for 45 inputs, output bounds, signed-URL
redaction, and cancellation without invented terminal events. The latest
complete runtime suite reports 282 passes; the worker activity suite reports 176 passes;
both package typechecks pass. A real remote Steer/cancellation test and real
NATS command-size/host-pressure observation remain required before any ship
decision.

A harder three-sample rerun on 2026-08-15 used 8-KiB files, 20-ms durable-event
transactions, 20/100-ms command RTT, and 1/5/20/100 complete file sets. At 100
files and 100-ms RTT, serial was 16.87 seconds cold / 15.87 seconds present,
four host commands wide was 4.37 / 4.36 seconds, and the bounded product helper
was 1.55 / 1.28 seconds using five 20-file commands. At 20 files it was 3.36 /
3.19 seconds serial versus 0.329 / 0.255 seconds bounded. All runs had zero
failures; the 100-file repair control restored both a mutated and a missing
target exactly.

The repository's disposable Rust-agent harness then exercised the real
protobuf/NATS and op-stream boundaries without touching enrollment state. Agent
0.1.15 completed 1,300 baseline operations with zero errors (small exec p50
3.05 ms; ping p99 0.27 ms), proved the exact 1,048,576-byte NATS payload wall is
typed rather than a timeout, and killed a complete cancelled process tree in
37.8 ms. The candidate's 48-KiB command chunks are therefore comfortably below
the observed transport wall, and its existing cancellation runner reaches a
real agent path with bounded tree teardown. This still is not a real remote
file-batch acceptance: network loss during the exact compound command, remote
host pressure, and Steer during real file delivery remain gates.

#### Durable event cost is per same-session transaction, not a global stall

`scripts/bench-session-event-persistence.ts` uses fresh real PostgreSQL state,
the human-prompt admission transaction, a claimed attempt, workspace/session
RLS, the exact execution-generation/attempt fence, and the production
append-before-publish helper. It never calls a model. In two fresh reruns, forty
sequential one-event appends measured 12.3--13.3 ms p50 and 15.6--16.3 ms p95.
One transaction containing the same 40 complete events took 14.5--15.5 ms
total. This is transaction overhead, not evidence that any event should be
omitted.

Contention is correctly scoped to the session row. Four/sixteen/thirty-two
simultaneous appends to one claimed session completed in 47/151--163/218--234
ms wall time. The same waves across independent sessions completed in
20--21/47--50/91--96 ms. The single-session serialization preserves sequence
and attempt truth; removing that lock would be a correctness regression. It
also cannot explain a clean 85-second startup.

Neither content nor history depth caused growth. Interleaved 0/512/16,384-byte
payloads were all about 10--15 ms p50, and appending after 0/1,000/10,000 prior
events stayed about 9--12 ms p50. Every byte and every prior event remained
durable; there is no payload/history truncation opportunity here.

Controlled lock experiments do reproduce seconds exactly. Holding the same
session, turn, attempt, or workspace row for 250 ms made the append wait on a
PostgreSQL `transactionid` lock and complete in 274--315 ms. Holding it for one
second produced 1.03--1.04-second appends. A lock on an unrelated session
produced no lock wait and completed in 20--33 ms. Separately, occupying all ten
connections in the worker's default postgres-js pool for one second delayed an
append to 1.06 seconds before it could even appear as a PostgreSQL lock waiter;
nine occupied connections left a path that completed in 49 ms.

The observer seam independently attributed injected best-effort publish delay.
An interleaved 0/5/100-ms fake fan-out produced publish medians of about
0.009/6.3/104 ms. Append medians varied together at 33--39 ms under that
sleep-heavy matrix rather than scaling with the selected publish delay. A slow
NATS flush is therefore visible separately and does not become a false database
diagnosis.

Conclusion: do not make the insert weaker or remove locks. A seconds-scale
`opengeni_session_event_append_seconds` sample now has two concrete suspects:
an exact row lock held by another lifecycle transaction, or exhaustion before a
pool slot is acquired. A local diagnostic candidate now splits the existing
total into five bounded, identifier-free phases: `transaction_ready` (workspace
lookup, pool admission, transaction/RLS/activity-gate setup), `mutation`,
`attempt_fence`, `event_write`, and `commit`. It adds no query and its callback
is explicitly unable to fail persistence.

The controlled one-second matrix attributed the waits exactly:

| Condition | Total append | Transaction ready | Attempt fence | Event write | Commit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clean, 10-sample p50 | 10.3 ms | 1.3 ms | 4.2 ms | 1.2 ms | 2.9 ms |
| Same session row held | 1,049 ms | 1.2 ms | 1,025 ms | 9.7 ms | 12.9 ms |
| Same turn row held | 1,052 ms | 11.2 ms | 1,024 ms | 4.4 ms | 11.5 ms |
| Same attempt row held | 1,041 ms | 3.8 ms | 1,020 ms | 8.0 ms | 9.4 ms |
| All 10 pool slots occupied | 1,077 ms | 1,006 ms | 38.1 ms | 16.4 ms | 15.8 ms |

An unrelated-session row lock had no PostgreSQL wait and completed in 47 ms.
The full production activity also emitted the new phase family through its real
event observer, proving the DB-to-events-to-worker metric wiring rather than
only a benchmark hook. This is enough local evidence to keep the diagnostic
candidate for later review; an insert/query rewrite remains unjustified until
production identifies which phase and holder is actually slow.

Do not batch arbitrary timeline events. The narrow Connected Machine candidate
has different semantics: all selected files logically begin one setup phase,
then all results become known after one bounded command chunk. Persisting every
per-file started event in one transaction and every per-file terminal event in
one later transaction can preserve complete content, input order,
durable-before-live fan-out, and truthful phase boundaries while replacing up
to two transactions per file with two per chunk. Cancellation must still leave
started-without-terminal evidence exactly as it does today.

### Second-phase finding: unchanged Codex pin writes are avoidable churn

The worker already reads the session's prior Codex credential id. Current main
nevertheless calls `recordSessionActiveCodexCredential` on every Codex turn,
which enters workspace/session RLS, updates `updated_at`, and advances workspace
activity even when the id is unchanged.

`scripts/bench-codex-session-credential-write.ts` first measured current-main
behavior over 30 unchanged local Postgres calls at 21.39 ms median / 29.66 ms
p95 and exactly 30 activity-revision increments for zero semantic changes.
Thirty-two concurrent distinct sessions took 253.68 ms and created 32
unnecessary revisions. The local candidate calls the accessor only when the
worker-observed id differs and adds an `IS DISTINCT FROM` update predicate as a
defensive database fence. A fresh 50-sample candidate rerun on 2026-08-15 made
the normal unchanged path 0.0007 ms median with zero database calls. Direct
duplicate calls still paid 2.37 ms median / 3.50 ms p95 for the defensive
transaction, but advanced zero activity revisions; 32 parallel duplicates took
26.77 ms and also advanced zero revisions. A real changed id was stored in 4.15
ms and still produces the existing switch event.

Nine real-Postgres tests, including an exact no-op revision/timestamp assertion,
pass; database and worker typechecks, lint, format, and diff checks pass. This is
a clean small fix, not an explanation for an 85-second startup.

### Second-phase finding: Codex selection and OAuth refresh are different costs

The worker's broad `credential_selection` phase chooses and leases an account,
updates session/account state, and publishes selection evidence. It does not
refresh the OAuth token. The bearer is resolved later, immediately before the
first Codex request. A fresh token therefore pays only the encrypted row read
and decrypt measured above; a token within five minutes of expiry enters a
separate provider refresh, cross-process lock, encryption, and compare-and-set
write.

`scripts/bench-codex-token-refresh.ts` uses the real encrypted credential row,
RLS accessors, ten-connection database pool, transaction advisory lock, status
transition, and CAS persistence. Only OAuth is replaced with deterministic
delay/failure functions. Seven samples per ordinary delay (three at 2 seconds)
showed 17--24 ms median host overhead: 0/20/100/500/2,000 ms provider delays
completed in 17/39/121/524/2,023 ms median. The path therefore adds provider
time almost one-for-one; it does not contain another hidden seconds-scale local
step.

Thirty-two same-process callers for one expired credential completed in 585 ms
with a 500-ms provider and issued exactly one refresh. Eight fresh Bun processes
against that same credential also issued exactly one refresh; their internal
calls completed in 520--675 ms. The process-local single-flight and Postgres
lock/CAS fences are both working. A deliberately adverse case of 32 *different*
expired credentials with 100-ms providers completed in 524 ms: the ten DB
connections run safe refresh waves because each rotating token owns a
connection while its advisory transaction lock is held.

A permanent rejection took 19 ms and stored `needs_relogin`; a 100-ms transient
failure returned in 113 ms and left the credential active. An injected hung
provider hit the outer deadline in 6.013 seconds and also left the credential
active for a later retry. That timeout can be visible on the rare first request
after expiry, but it is bounded and cannot explain an 85-second blank startup.

Keep the one-time-token lock, re-read, CAS, and failure states. Removing the held
connection or weakening serialization would exchange a rare bounded delay for
refresh-token double-spend and false reconnect failures. A future experiment may
start stale-token refresh concurrently with already-required runtime work, but
only after measuring real refresh frequency; rotating a token before a turn is
known to reach its model boundary is a behavior change, not a free optimization.

### Second-phase finding: the workspace activity counter matters only under burst contention

`scripts/bench-session-activity-counter.ts` uses real Postgres and the complete
`withWorkspaceSessionActivityRls` commit gate. It compares independent
transactions mutating distinct sessions in one workspace with the same number
of independent workspaces. Every independent transaction must retain its own
monotonic revision; a separate control updates all sessions legitimately inside
one transaction and proves the existing gate stamps them with one revision.

| Concurrent independent mutations | Same workspace wall p50 | Separate workspaces wall p50 | Same/separate ratio | One legitimate coalesced transaction p50 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 10.7 ms | 9.2 ms | 1.17× | 11.0 ms |
| 4 | 22.2 ms | 20.8 ms | 1.07× | 14.8 ms |
| 16 | 65.0 ms | 27.2 ms | 2.39× | 18.2 ms |
| 32 | 155.9 ms | 59.8 ms | 2.61× | 21.7 ms |

All 770 independent and coalesced transaction revisions matched their exact
expected deltas, with no deadlock or retry. The shared counter is therefore a
real serialization point at unusually high same-workspace write bursts, but
one ordinary mutation costs roughly ten milliseconds and four concurrent
mutations show almost no shared-counter penalty. It cannot explain the observed
85-second startup.

Do not shard, weaken, or asynchronously approximate this ordering fact from the
local burst result. Independent operations cannot be fused without changing
their durability semantics. Keep the current counter and measure production
lock-wait p95/p99 by workspace; revisit only if real same-workspace bursts make
the tail material.

### Second-phase finding: RLS setup had avoidable protocol round trips

Every account/workspace-scoped helper pins a transaction, installs tenant and
writer/protocol GUCs, then independently reads the tenant values back before
running application SQL. Current main installs those GUCs with four sequential
statements. A session-actor scope additionally installs subject and initiating
human values and reads them back. The independent readbacks are intentional:
they fail loud if a transaction pooler ever moves the operation to a backend
that did not receive its authority context.

The local candidate combines only the transaction-local `set_config` calls into
one SQL statement. It does not remove or combine either backend readback.
`scripts/bench-rls-context-round-trips.ts` alternated 200 real-Postgres samples
of each shape on one pooled connection. Ordinary setup fell from 2.25 to 1.25
ms p50 and the actor-bearing path fell from 3.44 to 1.91 ms p50; statement counts
fell from 5 to 2 for the complete ordinary measurement. The actor benchmark
compared 8 old statements with 4 candidate statements because it performs one
extra independent actor assertion; the production candidate uses 3.

The same benchmark proved exact subject and initiating-human values, an empty
initiating human when omitted, and no actor value in the next transaction. The
actor-sensitive task-notes authority suite plus the input guards report 9 passes
and 0 failures, and the database typecheck passes. This is a small broad
improvement, not an explanation for the incident. Keep the separate authority
readbacks even though deleting them would benchmark faster.

### Second-phase finding: NATS expiry is brief renewal, not turn startup

An opt-in real-broker integration now shortens only the test-issued user JWT
when requested, performs request/reply before expiry, observes a second real
auth-callout request, and performs request/reply after reconnect. Production
still issues the same capped five-minute user JWT; the 30-day enrollment bearer,
server permissions, subject isolation, and Rust agent behavior are unchanged.

Both a three-second seam and a real five-minute run observed
`AUTHENTICATION_EXPIRED`, stale connection, disconnect, immediate reconnecting,
credential update, and reconnect. In the five-minute run, reconnect completed in
22 ms and post-renewal request/reply succeeded. An earlier run revealed a test
cleanup deadlock between graceful drain and active async status/subscription
consumers. Ending status collection at the terminal reconnect observation and
draining the responder subscription before closing clients fixes the harness.
The corrected production-duration proof exits cleanly: one pass, zero failures,
301.60 seconds end to end. This wire-level proof complements, rather than
replaces, the existing Rust state-machine tests.

### Second-phase finding: the 512 validator cap is reuse capacity, not functionality

The cap retains at most 512 exact content-addressed compiled JSON-schema
validator functions per worker process. It does not cap tools, rigs, history,
catalog entries, or active attempts. Every attempt holds direct references to
the validators it already resolved; eviction means only that a future attempt
may have to compile the same schema again.

`scripts/bench-validator-cache-eviction.ts` creates fresh processes with simple
and nested schemas, proves valid and invalid calls before and after churn, and
measures cold catalog construction, an 80-schema hot subset, distinct churn,
and full replay. Five fresh-process samples per 256/512/1,024 case and seven
normal 80-schema controls all preserved validation behavior.

| Distinct nested schemas | Cold catalog p50 | Immediate hot subset p50 | Hot subset after equal-size distinct churn p50 | Full original replay p50 |
| ---: | ---: | ---: | ---: | ---: |
| 80 | 84 ms | 6 ms | 5 ms | 3 ms |
| 256 | 318 ms | 8 ms | 6 ms | 13 ms |
| 512 | 425 ms | 7 ms | 55 ms | 268 ms |
| 1,024 | 748 ms | 6 ms | 58 ms | 564 ms |

Below capacity, both working sets coexist and replay stays warm. At or above
capacity, an equally large distinct catalog evicts the old validators. A stable
1,024-schema catalog replayed in the same order is a pathological LRU scan and
recompiles heavily, but it still behaves correctly. The corresponding simple
1,024-schema replay was 120 ms median, showing schema complexity matters more
than the count alone.

Do not raise 512 from this evidence. The measured RSS includes definitions,
catalogs, active environment references, AJV instances, and compiled functions,
so it does not justify a larger per-worker retention budget. A real huge rig is
also not automatically a huge tool catalog. First measure production catalog
schema counts and real worker heap. If stable catalogs genuinely exceed the
cap, compare batch-aware lookup (capture existing hits before inserting misses)
or upfront schema validation plus compile-on-first-call. Either option must keep
invalid schemas fail-closed and exact attempt authority; a larger cap is only a
measured memory-budget alternative.

### Second-phase finding: verified large rigs are fast; cold fallback multiplies RTT

`scripts/bench-rig-setup.ts` drives the production `runRigSetupHook` with the
same inline threshold, base64 chunking, runtime marker, trusted immutable-image
marker, timeout, and failure behavior as a real turn. Each sample proves the
setup body executes exactly once on a cold fallback and is not transferred or
executed again after its exact marker exists.

| Setup body | Correctness-safe fallback commands | Cold at 0 / 20 / 100 ms command RTT | Warm at 0 / 20 / 100 ms command RTT |
| --- | ---: | ---: | ---: |
| 512 B | 1 | 22 / 46 / 161 ms | 8 / 30 / 126 ms |
| 32,768 B | 13 | 93 / 454 / 1,710 ms | 5 / 30 / 129 ms |
| 131,072 B ASCII | 31 | 200 / 1,073 / 4,018 ms | 5 / 31 / 126 ms |
| 131,072 characters / 392,946 B Unicode | 80 | 523 / 2,774 / 10,316 ms | 6 / 31 / 130 ms |

These latest three-sample numbers use the local seven-KiB transport chunk,
which is slower than the earlier table but fits the _real_ final command
envelope. Five real Docker samples on the earlier path measured fresh-container
creation at 243--320 ms, maximum ASCII setup at 463 ms, maximum Unicode setup at
1,001 ms, and the same-box marker path at 29--33 ms. No setup body was omitted
or executed twice.

The expensive numbers are the correctness fallback when a matching verified
provider image is absent, stale, or unsupported. A ready Modal rig image is
selected only when its setup-content hash, source image, provider binding, and
cold-boot proof match. Its image contains the trusted content marker, so a fresh
box takes the constant-size warm probe and skips live setup. Fifty-one focused
runtime/core/worker tests prove build-once reuse across fresh boxes, exact
invalidation, checks-before-publication, independent cold-boot validation, and
fail-closed fallback.

Therefore a huge rig does not normally make mobile send or execute a huge setup
script per turn. The client selects a frozen server-side rig identity/version;
the worker resolves the verified image. We should not weaken setup, checks, or
hash fencing to improve the rare fallback. The remaining useful measurements
are provider-image availability/build latency, first-ever build UX, and real
provider marker-probe RTT. A separate list-payload experiment below found that
the UI did still receive complete setup definitions before it selected a rig.

The first true maximum-size Modal first-use run found a correctness bug before
it found a performance result. Current main `6598eefe4` uses 24-KiB base64
chunks. OpenGeni's cancellation wrapper embeds each lifecycle command twice and
the pinned Agents Extensions `runAs` wrapper embeds that result in three shell
branches. Modal applies its 65,536-byte aggregate argument ceiling afterward.
Even the prior local 20-KiB chunk became a 142,230-byte provider command and was
rejected before setup. The old unit test modeled only the latter three-way
wrapper. Exact combined-envelope tests show 7,168-byte chunks remain below the
ceiling while 8,192 bytes do not. The local generic fallback therefore uses
seven KiB and successfully reconstructs and verifies the complete 390,000-byte
Unicode tail. Current main's 24-KiB path is not fixed.

Modal also exposes a public byte-exact sandbox filesystem write. The local
experiment sends the maximum 392,504-byte script in one write, then retains the
same command-owned marker lock, timeout, root execution, failure, and cleanup
path. A real Modal run measured that write at 276 ms and the complete fallback
setup at 1.80 seconds; the resulting image cold-booted twice in 0.85--0.92
seconds, matched its exact immutable id, and skipped setup in 0.03--0.05 ms.
This removes 79 transport calls without omitting a byte.

It is promising but not yet a merge recommendation. The pinned Modal
`writeBytes` implementation starts its own internal process and streams stdin;
the method exposes no abort signal or timeout, and OpenGeni's turn command fence
does not own that internal operation. The normal 276-ms result is good, but a
hung provider stream could still delay Pause/Steer. Keep the seven-KiB fallback
as the proven correctness repair. The one-write fast path needs either a
command-runner-owned stdin/file operation or a provider cancellation contract
before shipping; do not bypass the physical-operation fence for a benchmark
win.

The live Modal proof exposed a larger and safer ordinary-path opportunity. A
ready provider image had already passed exact content/source hashes, provider
binding, checks, and an independent cold boot, yet every fresh box still spent
1.08--1.22 seconds executing one in-box trusted-marker probe. The local
candidate now carries the selected immutable image id into the private rig
setup descriptor and skips the command only when the live Modal session state
reports that exact id. A missing/mismatched id still executes the old marker
path byte-for-byte. Two new live runs for both a 512-byte and a 392,504-byte
setup produced independently cold-created boxes in 831--967 ms and settled the
setup proof in 0.04--0.19 ms. The maximum fallback remained 9.61 seconds, so no
correctness escape was introduced. All six temporary boxes and both temporary
provider images were deleted. Thirty-two focused tests and runtime/core/worker
typechecks pass. This candidate is local, not merged.

`scripts/bench-rig-first-use-modal.ts` then measured the complete asynchronous
first-image workflow: maximum setup execution, declared checks, immutable image
publication, and an independent cold boot. Three exact-payload zero-check runs
became ready in 15.24, 18.69, and 18.86 seconds; one separate byte-exact run was
a 26.08-second outlier. Ten ordered checks increased the observed workflow to
20.82 seconds. The provider build/publication/cold-boot portion was 5.15--6.30
seconds in the repeated zero-check samples. Rig creation already starts this
workflow asynchronously, so creation does not wait 15--19 seconds; an immediate
first session truthfully uses the complete fallback if the image is not ready.
That behavior is correct, but the prior picker made it invisible.

### Second-phase finding: huge rig defaults expose both latency and a hard environment limit

A rig version may reference all 25 workspace variable sets. Each set may hold
100 variables and each value may contain 32,768 characters. Current main loads
those defaults serially in the turn worker. The deterministic
`scripts/bench-rig-variable-set-loading.ts` matrix preserves listed-set order
and session-variable precedence while comparing that path with the repository's
existing bounded stable-order mapper:

| 25 default sets | Serial p50 | Four-wide p50 |
| --- | ---: | ---: |
| 10 ms/set | 290 ms | 82 ms |
| 50 ms/set | 1,298 ms | 364 ms |
| 100 ms/set | 2,546 ms | 714 ms |

The local candidate therefore loads at most four sets concurrently, drains
already-active reads after a failure/cancellation, then merges in original
listed order so later defaults and finally the session set still win exactly.
The API viewer and Channel-A creation paths now use the same shared resolver.
That also repairs a separate fresh-main correctness bug: if a viewer or
terminal won the first cold-create race, it previously supplied only the
session variable set, so the later worker could not add the frozen rig defaults
to an already-created provider manifest. A real encrypted-database integration
test proves default ordering and session precedence. The bug was rechecked on
`origin/main` `6598eefe4363faf83c20bec9fc646c182e1057b4`; both fixes remain local.

An end-to-end control then exercised the production turn activity, real
PostgreSQL/NATS/Temporal, a real Docker sandbox, all 25 default variable sets,
and a maximum 131,072-character / 393,126-byte setup definition. A deterministic
model forced an actual shell tool call that asserted both the setup output and
the final listed-set precedence (`ORDER=24`) inside the box. No external model
was called. At an injected 20-ms secret-provider delay, reads peaked at the
intended four-way bound and all 25 sets were read on both turns.

The first run on an earlier transport path was 3.66 seconds cold and 0.78
seconds warm. A later three-run repetition on the final correctness-safe
seven-KiB fallback supersedes that favorable cold number: complete cold turns
were 5.99, 6.02, and 6.10 seconds, including 4.18--4.21 seconds in setup. The
same-box turns were 0.762--0.783 seconds and skipped setup in 66--71 ms. Every
run read all 25 sets at exactly four-wide concurrency and proved `ORDER=24`
plus the setup marker inside the real tool process. This proves the complete
huge-rig path, while also showing that "mobile selection is compact" and
"every first sandbox is instant" are different claims.

Parallel reads do not solve the larger contract mismatch. Exact Docker-provider
tests show that environment values are passed in both `docker run -e` and every
`docker exec -e`. On this host 30 maximum ASCII values (983,520 bytes) pass,
31 (1,016,304 bytes) pass, and 32 (1,049,088 bytes) fail before Docker starts
with `E2BIG`. An `--env-file` control is not a general escape: Docker rejects a
single 32-KiB Unicode line because its scanner token is too long, while a Linux
child process still has a roughly 2-MiB total argument/environment envelope.
The schema can currently describe about 78 MiB of values across 2,500
variables, so some valid huge rigs can never become a process environment.

Do not truncate, silently drop, or arbitrarily cap this data. The next gate is
to establish a portable managed-provider envelope and decide explicitly
between an early aggregate environment budget (clear validation error) and a
new file-backed secret/config contract for genuinely large values. That is a
correctness/product decision, not a startup micro-optimization.

The mobile composer's separate variable-set list was also tested at the full
25-set limit rather than assumed guilty. With 2,305 variable-name metadata
entries it was 313,743 bytes raw / 8,879 bytes gzip and returned in 11--14 ms.
The generic endpoint contained no plaintext values. At 390x844 and 4x CPU, all
25 set choices were usable in 1.41--1.57 seconds with no horizontal overflow.
The benchmark removed its 23 temporary sets afterward. A second summary
contract for this endpoint is not justified by the measured transfer or UI
cost; keep the complete name/version metadata list.

### Second-phase finding: huge rig definitions do not belong in list payloads

The default rig list API intentionally remains a complete public definition
read, and MCP still uses it. The web/mobile picker, however, displays only rig
identity, description, active version/image/default variable sets/check count,
verification summary, version count, and timestamps. It never displays setup
script bytes, check commands, credential hooks, changelog, or provider artifact
identifiers from that list.

`scripts/bench-rig-list-payload.ts` now compares the real complete PostgreSQL
query with an additive `view=summary` query that selects only those displayed
fields. The benchmark seeds valid active versions with maximum-size 131,072
character high-entropy Unicode setup comments (393,214 UTF-8 bytes each), runs
five samples per count, and proves identical rig membership/order. The default
list and detail routes remain complete; the summary path does not contain a
`setupScript` property.

| Maximum-size rigs | Full raw / gzip | Summary raw / gzip | Full DB p50 | Summary DB p50 | Full / summary stringify p50 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 394.1 KB / 271.7 KB | 625 B / 394 B | 6.74 ms | 6.60 ms | 0.162 / 0.006 ms |
| 10 | 3.94 MB / 2.71 MB | 6.24 KB / 944 B | 8.71 ms | 7.49 ms | 1.308 / 0.014 ms |
| 50 | 19.70 MB / 13.54 MB | 31.28 KB / 3.32 KB | 35.28 ms | 17.19 ms | 6.075 / 0.048 ms |

At 50 pathological rigs the compressed transfer is about 4,000 times smaller,
while all 50 rigs and their selection-relevant state remain present. This is
not timeline pagination, rig omission, or a smaller domain definition. Opening
one rig still fetches the exact complete version, and `listRigs()` plus the
existing public `useRigs()` hook remain full compatibility surfaces. The web
list and picker screens opt into the additive `useRigSummaries()` hook and its
explicit SDK summary method.

The active-version provider-image ledger was also already present in the detail
response but invisible in the picker. The local summary now adds only the
deployment backend plus coarse `unprepared` / `building` / `ready` / `failed` /
`unsupported` state; it exposes no provider object identity, failure detail, or
definition content. The picker explains that Send remains available and an
immediate first sandbox may run complete setup. It polls every 2.5 seconds only
while the explicitly selected rig is pending, then stops. Unrelated unprepared
rigs no longer create a permanent polling loop, and an incapable backend is
terminal `unsupported` rather than falsely `unprepared`.

A real mobile-width browser run (390 × 844, touch, 4x CPU) then filled the
workspace's complete 50-rig limit with 46 maximum definitions. The legacy full
response was 18.13 MB raw / 12.46 MB gzip: about 10 seconds at 10 Mbps or 62
seconds at 1.6 Mbps. The complete summary was 29.7 KB / 3.9 KB: about 3 ms or 20
ms at those rates. All 50 rigs rendered with no horizontal overflow. Four to
50 rigs changed median usable time from 1.66 to 1.89 seconds on the rigs page
and 1.99 to 2.18 seconds in the session picker; bundle/dev bootstrap, not the
50 summary rows, dominated. As of remote main `6598eefe4` on 2026-08-15, this
summary route is **not merged**: main still returns full definitions. The
prototype remains local as requested.

A real 390 x 844 browser run at 4x CPU then exercised the readiness transition
using the real four-rig summary response. All four ids remained present; the
2.8-KiB response contained no setup script, provider ledger, or image id. The
selected rig visibly changed from “Preparing fast startup” to “Fast startup
ready” after the next poll, and no further request occurred across two
additional 3.2-second observation windows. The status fits the existing phone
composer without horizontal overflow.

The mobile session-create transport is already correctly compact. A real
390 x 844 touch-browser proof selected one of the maximum-size rigs, intercepted
the session POST before mutation, and observed a 378-byte raw / 295-byte gzip
body containing only the exact `rigId`. The browser fetched the complete
summary list twice, never fetched the selected rig detail, and sent no
`setupScript`, checks, credential hooks, or provider-image ledger. The create
API resolves the active version under workspace authority and freezes the rig
and version server-side. Therefore a huge rig does not enlarge the Send request;
the current-main mobile problem is the pre-selection full-list transfer, and the
post-Send risks are provider-image readiness, fallback setup, defaults, and the
environment contract described above.

A 2026-08-15 production rerun separated list/select performance from the chosen
rig's detail screen. With all 50 maximum definitions retained, the rigs page was
usable in 1.43 seconds p50 and the session picker in 1.59 seconds p50 at 390 x
844 and 4x CPU. Moving from four to 50 rigs added only 183/261 ms. Every rig
name and selection action remained present. Opening one maximum definition was
usable in 825 ms p50, but revealing its complete 393-KiB unbroken Unicode setup
body took 2.03 seconds and opening the complete editor took 2.13 seconds. A
native textarea experiment reduced the isolated large-text surface from about
1.90 to 1.34--1.38 seconds, while fixed sizing reduced the real editor by only
about 9%; neither trade was retained. This is a pathological detail/edit UX
edge, not sandbox launch latency, and does not justify hiding or truncating the
definition.

### Second-phase finding: duplicate rig credential hooks multiply startup RTT

The rig schema permits 50 credential-hook entries, while the runtime currently
has one valid built-in hook, `azure-cli-login`. Current main resolves the list
verbatim. Its `unionCredentialHooks` comment says hook ids are deduplicated, but
the implementation only removes ids already supplied by the deployment profile;
duplicates inside the rig remain and run serially on every owned-box turn.

`scripts/bench-rig-credential-hooks.ts` drives the exact hook resolver and
`beforeAgentStart` runner with the Azure command transport replaced by a timed
success. Fifty repeated valid ids executed 50 commands and took 1.13 seconds at
20-ms command RTT or 5.09 seconds at 100-ms RTT. The local candidate deduplicates
only after resolving every id, so an unknown id still fails closed. The same 50
entries then execute the exact hook once and take 24/102 ms. Runtime typecheck
and focused resolution/login tests pass. No capability or credential is omitted:
one id denotes one idempotent hook, and first-seen order is preserved.

The separate maximum of 100 rig checks is not an ordinary-turn multiplier.
Checks run while verifying a change/version and independently cold-booting a
provider image; a ready image or setup fallback does not rerun them for each
prompt. `scripts/bench-rig-check-verification.ts` confirms that the cold-boot
validator deliberately executes one marker probe plus every check in listed
order: 100 checks took 2.17/10.28 seconds at 20/100-ms command RTT. Arbitrary
parallelism is not a free fix because check commands may depend on order. A
future bounded command protocol could execute listed checks sequentially inside
the sandbox and return structured results in fewer transport round trips, but
this should be considered provider-image build UX, not mobile turn startup.

### Second-phase finding: worker placement is healthy; cold import is bounded

`scripts/bench-turn-worker-startup.ts` launches the real turn-worker entrypoint
against the live local Postgres, NATS, and Temporal services, polls its actual
readiness endpoint, and drains it after every sample. Seven fresh processes
reached full readiness in 1,024–1,395 ms (1,076 ms median), without a retry.
A second five-process phase run attributed about 1,004 ms median to importing
the worker module graph and 106 ms to loading the lazy turn-activity graph.
Direct live dependency probes measured database posture at 76 ms and Temporal
connection at 21 ms; the configured Modal image lookup was a no-op.

`scripts/bench-turn-worker-placement.ts` uses real separate worker processes and
a unique Temporal queue. With the production-like 16 activity slots, one
ordinary eligible activity reached its worker in 51–94 ms after the first cold
296-ms sample. A 16-activity burst had 76–197 ms median eligible wait; a 32-item
two-wave burst had 334–540 ms median and 454–707 ms maximum wait. In a 100-item
stress burst, a second replica registered in 522–689 ms, accepted its first work
26–200 ms after the observer saw it, and took 30–35% of the burst despite
joining late. Queue delay
then scaled with the deliberate 200-ms activity work and capacity waves rather
than a placement stall.

Conclusion: Temporal placement and normal hot-worker admission should stay as
implemented. The roughly one-second module import is relevant to pod
autoscaling efficiency, not the 85-second same-session incident, because turn
workers are long-lived. Profile the static import graph only alongside real pod
startup/image-pull data; do not split the worker or duplicate service graphs
solely to improve a local one-second process benchmark.

The experiment also reproduced a misleading startup failure: omitting the
development NATS control identity caused authorization retries, but both plain
and structured logs discarded the dependency label and timing. The local fix
keeps retry behavior identical while emitting `NATS (attempt 1/30, delay 1000
ms)`. The observability suite and package typecheck pass, and the real failed
launch now names NATS immediately.

### Second-phase finding: MCP preparation is fast locally, RTT-wave bound remotely

`scripts/bench-mcp-tool-preparation.ts` drives the exact `prepareAgentTools`
path through in-process MCP protocol adapters. It varies 0/1/5/20 servers,
0/20/80/400 tools, stable and alternating allowed-tool sets, connection/list
latency, persistence latency, and required/optional connection failures. Every
successful sample verifies the exact resulting catalog size.

With no injected transport latency, warm median end-to-end preparation was
0.61 ms for zero servers, 1.66 ms for one server/20 tools, 4.18 ms for five
servers/80 tools, 5.08 ms for 20 servers/80 tools, and 11.00 ms for 20
servers/400 tools. Cold first samples were visible in p95 (34–114 ms), mostly
validator/JIT work. Alternating a five-server catalog between 80 and 20 allowed
tools produced exactly those catalog sizes and stayed warm; no stale permission
projection appeared. An injected 20-ms catalog persistence delay added 21.39 ms
in the exact persistence phase rather than being misattributed to MCP.

The network shape is multiplicative in bounded **waves**, not in individual
servers. Server operations are capped at eight, and batches are sequential:

| Case | Required connect p50 | List/catalog p50 | Total p50 |
| --- | ---: | ---: | ---: |
| 5 servers / 80 tools / 20-ms connect + list | 22 ms | 26 ms | 48 ms |
| 20 servers / 80 tools / 20-ms connect + list | 65 ms | 69 ms | 134 ms |
| 20 servers / 80 tools / 100-ms connect + list | 306 ms | 309 ms | 614 ms |

Four unavailable optional servers among 20 at 20-ms connect latency completed in
71 ms median and produced exactly the remaining 64 tools. A required failure
stopped fail-closed in about 30 ms. Those semantics are correct and should not
be weakened.

Conclusion: current MCP preparation is not a general startup bottleneck after
validator reuse. Many slow servers can still consume six RTT waves (three
connect, three list). Before changing the eight-wide safety bound, measure real
session server counts, endpoint RTT, worker sockets, and provider rate limits.
If the case exists, compare a work-conserving bounded pipeline or exact
connection/list reuse fenced by server config, credential identity, permission
set, and catalog generation. Never reuse an executable attempt environment or
skip required-server freshness merely to improve a synthetic 20-server case.

### Second-phase finding: Agents SDK projection is cheap; its global cache was unsafe

`scripts/bench-agents-sdk-tool-projection.ts` drives the exact pinned Agents SDK
`Runner` preparation path and the exact OpenAI Responses request converter up to
entry into a fake `fetch`. It verifies tool count and request-body bytes rather
than invoking a model. Seven-sample warm medians were:

| Authorized surface | Request body | SDK preparation + local serialization | Responses conversion to `fetch` |
| --- | ---: | ---: | ---: |
| 80 ordinary tools | 73 KiB | 0.35 ms | 0.12 ms |
| 400 ordinary tools | 349 KiB | 0.96 ms | 0.32 ms |
| 400 oversized-schema tools | 1.64 MiB | 1.56 ms | 0.90 ms |
| 2,000 ordinary tools | 1.70 MiB | 6.68 ms | 1.38 ms |

The earlier 0.45--0.80-second warm phase labelled “SDK projection” therefore
was not core SDK projection or OpenAI request construction. It included work
outside this boundary and must not justify an attempt-local projection cache.
The complete authorized surface is still transmitted; provider upload and
context effects are separate network/model costs, not local projection time.

The exact alternating-permission experiment did expose a correctness defect.
The pinned SDK keeps a process-global MCP tool cache keyed by server name. A
fresh OpenGeni wrapper for a later attempt could therefore expose the previous
attempt's broader model-visible tool list even though OpenGeni's own frozen
catalog and execution authorization were narrower. Execution remained
fail-closed, but model-visible names, descriptions, and schemas were stale. The
local repair disables only that redundant SDK-global list cache on the wrapper;
the wrapper still freezes its exact attempt catalog, and an inner server may
retain its connection-local cache. Eight alternating 80/20-tool samples then
produced exactly 81/21 model tools (including `tool_search`) and repeated
projections caused zero additional server list calls.

### Second-phase finding: complete-history data projection is not the mobile bottleneck

The React surface currently loads a 1,000-event compact tail, can page 5,000
older/newer events at a time or jump to start/latest, and keeps one browser
window bounded at 10,000 events / 8 MiB. This does not delete or summarize
durable history: older and newer content remains explicitly navigable. Every
event retained in the current window is mounted; the former progressive reveal
that hid rows was intentionally removed.

`scripts/bench-timeline-projection.ts` raises the lab byte ceiling to 64 MiB and
fails if even one requested event is omitted. It separately times the browser
legacy safety guard, complete timeline projection, grouping, and a 256-event
append followed by complete reprojection. Seven samples produced:

| Complete input | Bound p50 | Project p50 | Group p50 | Append bound + reproject p50 |
| --- | ---: | ---: | ---: | ---: |
| 1,000 events × 128-byte text | 0.7 ms | 0.7 ms | 0.2 ms | 2.0 ms |
| 5,000 events × 128-byte text | 2.9 ms | 8.9 ms | 2.1 ms | 12.7 ms |
| 10,000 events × 128-byte text | 5.9 ms | 30.2 ms | 8.3 ms | 41.6 ms |
| 10,000 events × 1-KiB text (10.3 MiB) | 13.2 ms | 38.4 ms | 8.7 ms | 57.7 ms |
| 10,000 events × 4-KiB text (33.4 MiB) | 30.5 ms | 47.5 ms | 10.7 ms | 80.9 ms |

The largest append/reprojection p95 was 164 ms (55-ms bounding plus 109-ms
projection), but all 10,256 events remained present. That is worth watching on
a slower phone CPU, yet it cannot explain an 85-second blank startup.

### Second-phase finding: ordinary auto-compaction duplicated complete history work

`scripts/bench-turn-history-shapes.ts` drives the complete production
`runAgentTurn` activity with a scripted model and no provider request. It
asserts 1,001 model-input items for every 1,000-row case and checks first/last
seed markers (or the first/final tool-pair ids), so a faster result cannot come
from omitting history.

Before the experiment, every ordinary user turn loaded and model-projected the
complete transcript in `maybeCompactContext`, then loaded and projected it
again for the actual model input. That first pass could not affect the decision:
automatic compaction is intentionally gated only by the prior provider-reported
input token count. A local prototype now returns `below_threshold` before
touching durable history when that authoritative signal is below threshold.
Forced/operator compaction and at/above-threshold turns retain the complete old
path. An exact boundary regression test proves 244,799 tokens does not touch the
DB while 244,800 does.

Three before/after samples per shape produced:

| 1,000-row shape | Worker prep before | Worker prep after | Wall before | Wall after |
| --- | ---: | ---: | ---: | ---: |
| 768-byte messages | 138 ms | 112 ms | 338 ms | 295 ms |
| 8-KiB messages | 218 ms | 145 ms | 416 ms | 324 ms |
| 8-KiB tool call/result rows | 171 ms | 131 ms | 334 ms | 323 ms |
| Authorized file refs | 270 ms | 245 ms | 442 ms | 414 ms |
| Missing file refs | 134 ms | 107 ms | 301 ms | 279 ms |

The coarse `post_agent_preparation` slice fell to about 2.2 ms in every case.
For authorized file refs, most work correctly moved into the one real history
projection instead of disappearing: a 1,000-file authorization batch cost
about 144 ms. That distinction matters when reading phase charts.

`scripts/bench-file-authorization.ts` then separated ordinary file metadata
from subject-bound Google Drive authority. For ordinary files with no Drive
provenance, subject-bound medians were 3.8 ms for one file, 4.3 ms for eight,
3.4 ms for 32, 8.5 ms for 128, 44 ms for 512, and 141 ms for 1,000. The
workspace-only comparison was 2.2, 2.4, 1.7, 2.6, 5.3, and 7.7 ms. This is not
a realistic small-attachment startup problem. Keep the fail-closed per-file
authority today; only consider a set-based security-definer batch after real
telemetry shows hundreds of distinct historical attachment ids on the active
model path, and separately benchmark protected Drive objects before changing
that security boundary.

Inline byte materialization is eight-wide and enforces the complete 20-MiB
aggregate ceiling before reads. With a deterministic 20-ms read, one/eight/32/
128 small files took 1.2/21.7/83.0/344.6 ms. Four local 4-MiB files took 13.7
ms. Six requested 4-MiB files read and emitted exactly five in 13.8 ms; the
sixth remained available by its sandbox path. This is correct bounded scaling,
not a reason to lower history or UI visibility.

### Second-phase finding: the complete local startup pipeline is subsecond at the serving envelope

`scripts/bench-turn-startup-pipeline.ts` exercises the real PostgreSQL, NATS,
Temporal, production worker activity, runtime, durable events, and exact phase
metrics with a `ScriptedModel`. It stops at the provider boundary and makes no
provider request. This is the closest deterministic reproduction of the
post-file/pre-model path; it is materially stronger evidence than adding
isolated phase estimates.

A fresh ordered run produced:

| Active history | Process state | Complete activity wall | History preparation | Durable load | Canonical projection | Provider dispatch |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 0 rows | cold | 617 ms | 12.8 ms | 6.8 ms | 0.2 ms | 4.9 ms |
| 1,000 × 768-byte rows | warm | 261 ms | 27.9 ms | 18.8 ms | 3.1 ms | 0.56 ms |
| 8,000 × 768-byte rows | warm | 403 ms | 133.3 ms | 106.0 ms | 16.4 ms | 0.59 ms |
| 8,000 × 1,800-byte rows | cold control | 868 ms | 205.3 ms | 173.6 ms | 17.0 ms | 5.3 ms |

Reversing the small/large order gave the same shape: a cold 8,000-row turn was
831 ms, while subsequent warm 0/100/1,000-row turns were 223--253 ms. The
8,000 × 1,800-byte case is roughly 15 MiB of history, near the serving worker's
explicit materialization ceiling. It still settled successfully without
removing a row. The provider-dispatch boundary was below 1 ms warm, so the old
roughly 18-second post-file attribution does not reproduce in this local
pipeline.

The failure control intentionally seeded 8,000 × 4,096-byte rows. Its exact
active-history JSON was 33,704,077 bytes and the worker failed loudly with
`active_history_too_large` against the 15,728,640-byte serving envelope before
calling the model. This bound protects inference-worker memory; it does not
truncate, summarize, hide, or delete durable/session UI history. Complete UI
history remains separately pageable and visible. Increasing this inference
materialization envelope is a capacity decision, not a UI-content shortcut.

Conclusion: complete admitted history has a real, bounded cost, dominated by
database load at large byte volumes and per-file authorization only at extreme
attachment-reference counts. It is not an explanation for an 18- or 85-second
blank startup on a healthy local stack. That incident now requires a production
phase trace; speculative history caching, compaction, or UI omission is not
justified.

### Second-phase finding: complete mobile rendering scales in the browser

The real production bundle was then measured at a 390 × 844 viewport with
synthetic sessions whose exact marker count was asserted in the rendered DOM.
Seven fresh navigations per size produced these medians:

| Fully mounted events | Initial render | DOM elements | Document height | Event API |
| ---: | ---: | ---: | ---: | ---: |
| 20 | 0.611 s | 698 | 4,616 px | 30.8 ms |
| 100 | 0.727 s | 2,295 | 24,228 px | 29.9 ms |
| 500 | 1.249 s | about 10,311 | 121,028 px | 41.6 ms |
| 1,000 | 1.775 s | about 20,311 | 242,028 px | 55.7 ms |

The API is small; rich DOM construction, markdown, layout, effects, and scroll
anchoring dominate. Ordinary short sessions are subsecond, while 500–1,000
events are visibly slower but nowhere near the 85-second incident.

The older-page path is the sharper problem. Loading another 1,000 events kept
all 2,000 exact markers visible and preserved the reader anchor, but took about
4.27 seconds in the baseline, doubled the document from roughly 20,324 to
40,328 elements, and one sample contained 100,571 DOM nodes. The older-events
API itself returned 1,001 rows in 159 ms. An earlier 30-second result was a test
mistake: focusing the scroll container with Home did not scroll it and fired no
request. A real wheel scroll produced the numbers above.

Three experiments narrowed the browser cost without reducing content:

1. `content-visibility: auto` was rejected. It changed initial scroll geometry
   and parked the reader around 9,130 px rather than at the tip. The regression
   test now rejects inline as well as class-based content-visibility shortcuts.
2. Removing a redundant empty-file state update and avoiding one window resize
   listener per message when `ResizeObserver` exists improved controlled
   initial/older medians by about 5%/2%. Hoisting the disclosure provider made
   no improvement and was discarded.
3. Scroll-anchor measurement previously ran 2,000 root-wide selector searches
   over the same large DOM. One traversal with the same 2,000 exact anchors
   reduced that read-only operation from 139–164 ms to 2–8 ms and improved the
   rich 2,000-event append median from about 3.88 to 3.44 seconds.

A diagnostic body matrix, never a proposed UI change, found that deleting rich
content entirely would still leave a 2.33-second append. Full rich rendering
was about 3.88 seconds; markdown-only was 3.17 seconds. Therefore row bodies
matter, especially when doubling the DOM, but are not the sole bottleneck. The
next safe direction is to profile retained-tree layout/effects and anchor work
at 2,000/5,000/10,000 events while preserving every accepted row and its full
content. Virtualization, hidden content, or a lower UI history limit remains
out of scope unless a design can prove identical accessibility, find/search,
anchor, and full-content behavior.

That production-bundle profile now exists in
`scripts/bench-timeline-browser.ts`. It asserts every seeded marker exactly
once and in order after each real upward wheel page, records DOM/heap/long-task
state, forces one final GC to distinguish allocation garbage from retained
heap, and rejects horizontal overflow. A first harness run that waited 60
seconds was invalid: the bundle had been built without an exported
`VITE_API_BASE_URL`, so the static SPA returned `index.html` to the client-config
request. The harness now fails immediately on that configuration panel rather
than charging the wait to the product.

With 384 source characters per rich user-message row, the production surface
kept every row and complete text mounted:

| Fully mounted rows | CPU | Initial 1,000 | Complete time | DOM nodes | Retained heap after GC | Maximum long task |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2,000 | 1x | 2.10 s p50 | 2.98 s p50 | 54,538 | 100–125 MiB before the post-GC metric was added | 482 ms p50 |
| 5,000 | 1x | 1.99–2.04 s | 6.04–6.09 s | 135,549 | 194–198 MiB | 501–505 ms |
| 10,000 | 1x | 2.34 s | 16.36 s | 270,542 | 372 MiB | 617 ms |
| 5,000 | 4x | 9.09–9.87 s | 29.68–30.09 s | 135,549 | 194–198 MiB | 3.06–4.04 s |

The 10,000-row case retained 4.59 million rendered text characters with no
overflow; this is a performance defect, not a content-loss defect. The raw
pre-GC heap can temporarily exceed 1.5 GiB, so retained heap alone also
understates allocation/collection pressure. On the slower-CPU profile, a
single prepend can freeze input for seconds even though the API and pure event
projection are fast.

Three additional A/B candidates were tested rather than kept on intuition:

1. Skipping attachment-hook state/effects for zero-file messages added
   component/bundle complexity and produced no DOM or retained-heap win. It was
   reverted.
2. Deduplicating equal nested tooltip providers did not consistently improve
   time or memory and was reverted.
3. One `ResizeObserver` per disclosure body was replaced locally by one shared
   observer per browser window with exact element callbacks. Two repeated 4x
   runs completed in 27.76–29.03 seconds versus the 29.68–30.09-second A/B
   baseline, and aggregate long-task time fell about 6%, with identical content
   and disclosure/shadow-control tests. This measured but partial candidate is
   retained for deeper validation. A follow-up attempt to skip apparently
   redundant geometry reads regressed to 36.40–39.42 seconds and was reverted;
   those reads appear to prevent a much larger deferred layout/observer batch.

The rich-message fixture above deliberately stresses every row. A second
fixture uses the production turn shape instead: 10,000 durable events across
2,500 turns, yielding 5,000 complete user/assistant timeline markers. It still
mounted every marker, 110,549 DOM nodes, and 2.18 million text characters. At
1x CPU it took 2.51 seconds to mount the first 500 markers and 14.19 seconds to
mount all 5,000. At 4x CPU it took 4.71 and 26.52 seconds, retained about 190
MiB after GC, and accumulated 20.13 seconds of long tasks. Six real older-page
prepends each took 2.39–4.84 seconds. Complete realistic history is therefore
a confirmed browser defect even though neither the event API nor pure timeline
projection is slow.

Several more lossless A/Bs were rejected:

1. Removing one structural wrapper per rendered row removed roughly 10,000 DOM
   nodes but did not improve total time or retained heap consistently.
2. Memoizing the timeline group shell did not improve a controlled queue update.
3. Incrementally preserving already grouped events was no faster than a full
   regroup in repeated runs and was less stable.
4. `contain: layout style` and skipping geometry reads both regressed the 4x
   profile by several seconds. They were reverted.
5. Moving the expanded Queue panel into a fixed body portal did not remove the
   large-tree layout invalidation and was reverted. On the realistic 4x
   fixture it was no faster than the inline panel and added focus, theme, and
   positioning machinery.
6. Browser `content-visibility: auto` made a later Queue-panel open much faster,
   but every safe variant lost on the whole interaction. A fixed 160/320 px
   intrinsic estimate produced wrong scroll geometry for heterogeneous rows.
   A measured-height variant preserved all 5,000 markers, the exact 1,700,028
   px scroll height, accessibility-tree discovery, search reveal, and exact
   return-to-tip; nevertheless complete-history readiness regressed from 19.0
   to 26.8 seconds and far-history find rose from 50 to 511 ms. It reduced one
   Queue-panel sample from 1.96 seconds to 358 ms by moving cost into startup
   and search. It was reverted, and the scroll-height regression test continues
   to reject inline and class-based shortcuts.
7. Skipping Motion's synchronous panel-height measurement for reduced-motion
   users changed the same Queue-panel sample only from 1.96 to 1.86 seconds.
   Layout still dominated (1.30 seconds), proving the viewport-height change
   across the retained tree—not the height read itself—is the narrow defect.
   The candidate was reverted.
8. An anchored absolute Queue panel kept the same local theme/focus tree and
   stopped resizing the timeline, but three complete-history samples still
   opened in 1.55--1.58 seconds with 1.12--1.13 seconds of layout. Inserting
   the panel subtree still invalidated the retained document. Adding
   `contain: layout` to the real timeline scroller was worse: complete-history
   readiness rose from 15.8 to 21.7 seconds median and panel open rose from
   1.64 to 1.95 seconds. Both candidates were reverted.
9. Pre-mounting the ordinary one-row Queue panel inside that anchored overlay
   proved the remaining mechanism: open fell to 156 ms median and layout to
   about 2 ms because the browser had already paid for the subtree. It was not
   a valid optimization. Complete-history readiness regressed from 15.8 to
   22.6 seconds median, and a large collapsed queue would retain its complete
   hidden action DOM. This merely moved latency earlier and was reverted.
10. A narrower `contain: paint` boundary on the existing timeline scrollport
    directly targeted the native rendering cost without changing layout or
    omitting descendants. With the complete 5,000-group fixture, three 4x
    samples reduced Queue feedback from 267--318 ms (289 ms median) to
    231--244 ms (235 ms median), Steer from 179--252 ms (206 ms median) to
    172--178 ms (175 ms median), and the median long task from about 145 to
    113 ms. All 5,000 markers, 2.18 million text characters, 110,000+ DOM
    nodes, and the exact 1,700,178 px scroll height remained present. Native
    find located the first marker, the accessibility tree contained it, and
    returning to the tip was exact. Accepted and rejected Send paths also
    retained their exact-once and Retry/Remove behavior. Unlike layout/style
    containment, paint containment did not move cost into a slower startup in
    the repeated samples. This candidate remains local pending broader browser
    and focus/overlay validation.

These failures matter: reducing grouping work or a modest number of wrappers
does not address the dominant retained React-tree and per-row render/effect
cost. A future candidate must beat the complete production surface repeatedly,
not merely look algorithmically cleaner.

### Second-phase finding: disclosure measurement caused a second React commit per rich user row

A fresh 4x-CPU mobile profile used the production turn shape at 5,000 durable
events / 2,500 complete timeline groups. Three baseline samples took 6.16
seconds median for the initial 500 markers and 21.32 seconds for all 2,500.
After GC the tree retained 143.35 MiB; aggregate long tasks were 18.46 seconds
and the longest single freeze was 4.05 seconds. Every real prepend cost
4.21--5.62 seconds.

Removing only `UserMessageBody` as a diagnostic—while keeping identical
Markdown and every accepted message—reduced complete time to 7.44 seconds and
retained heap to 94.43 MiB. That was never an admissible UI candidate, but it
isolated the disclosure boundary rather than vaguely blaming Markdown or the
whole timeline.

The concrete defect was a render/layout loop. The source-text heuristic often
mounted a row as non-collapsible; the layout effect then measured wrapped
Markdown, set React state, and committed the same complete subtree again as
collapsible. This work repeated for each newly loaded user row. The local
candidate keeps expansion itself in React state, but stores the measured
collapsibility decision in a ref and synchronizes only the owning clip, fade,
control, and inert descendants. The complete Markdown subtree remains mounted,
the literal `Show more` / `Show less` control remains a normal button, and
later resize measurement still updates the exact rendered-height decision.

Three fresh candidate samples produced:

| Complete-history metric | Baseline | Local candidate |
| --- | ---: | ---: |
| Initial 500 markers, p50 | 6.16 s | 3.60 s |
| All 2,500 groups, p50 | 21.32 s | 9.30 s |
| Retained heap after GC, p50 | 143.35 MiB | 99.32 MiB |
| Aggregate long tasks, p50 | 18.46 s | 6.90 s |
| Longest task, p50 | 4.05 s | 1.29 s |
| Individual prepend range | 4.21--5.62 s | 1.65--2.09 s |

The final candidate retained all 2,500 unique marker groups, the original
1,087,786 rendered text characters, the exact 850,028 px scroll height, zero
horizontal overflow, and roughly the same 55,500-node DOM. Native Find reached
the first prompt in 64 ms, the full accessibility tree contained it, and
returning to the tip was exact. At the same complete-history state, Queue and
Steer feedback were 163 ms and 92 ms; accepted Send appeared exactly once after
durable reconciliation, while rejected Send retained the prompt plus Retry and
Remove and removed the stale queue receipt. No mutation or model request reached
the API in those browser probes.

The focused regression proves that a short source with tall rendered content
becomes collapsible in one React commit. The disclosure, timeline pagination,
SessionChrome, and Queue suites pass 100 tests / 1,642 assertions, and React and
web typechecks pass. This remains a local candidate. It removes the largest
measured retained-tree multiplier but does not make a 9.3-second pathological
history acceptable or justify hiding, virtualizing, or loading less content.

A later full-size rerun corrected an easy-to-miss benchmark comparison. The
9.30-second result above is the 5,000-event / 2,500-visible-marker fixture. The
current 10,000-event fixture contains 2,500 turns but 5,000 visible user/assistant
markers. Its browser harness now waits on the cheap structural group-anchor
count and stops the readiness clock before diagnostics, rather than repeatedly
scanning the complete page text while polling. Three 390 x 844, 4x-CPU samples
still took 3.05 seconds p50 for the first 500 markers and 15.32 seconds p50 for
all 5,000. They retained 110,513 DOM nodes, 177.42 MiB after GC, 2,177,786 exact
text characters, and the exact 1,700,028-pixel scroll height. Aggregate long
tasks were 10.35 seconds p50 and the longest task 1.17 seconds. The corrected
harness proves the remaining cost is real rather than polling overhead.

Pure projection is not the owner: 15-sample medians at 1,000/5,000/10,000 events
were 0.47/6.45/22.54 ms for projection and 0.11/1.60/6.28 ms for grouping.
Memoizing one additional timeline group-row shell produced 15.325 seconds p50,
statistically unchanged from 15.318 seconds, and was reverted. The dominant
remaining work is constructing and maintaining roughly 110,000 accessible DOM
nodes. Any further candidate must improve that complete surface without hiding,
truncating, virtualizing away, or making native Find/accessibility incomplete.

### Second-phase finding: ordinary Send needs a light, truthful receipt

The production 10,000-event fixture was also used to measure ordinary Send and
composer Steer while all 5,000 visible timeline markers remained mounted. The
browser harness intercepts the mutation at the network boundary, delays the
synthetic acknowledgement, and proves that no real model call or server
mutation occurs. It uses direct keyboard input; an earlier locator-based
version was invalid because Playwright's actionability search walked the huge
DOM before typing and charged test-driver work to the product.

With the corrected input path, the baseline ordinary-Send feedback was the
optimistic timeline row itself: 464–473 ms at 4x CPU and 121 ms at 1x. Composer
Steer was 174–217 ms at 4x and 49 ms at 1x. CDP metrics showed that the 4x Send
update spent about 165–174 ms in script and 31–34 ms in layout; Steer spent
about 25 ms in script, 2–3 ms in layout, and 9 ms recalculating style. This is
primarily JavaScript/React work over a large mounted tree, not an API delay.

The local candidate keeps the complete optimistic timeline row but defers that
large-tree reconciliation. `SessionChrome` immediately renders a small local
queue receipt from the same optimistic operation: `Sending prompt…`, then
`Reconciling…` after the server returns an exact `triggerEventId`. The local row
is deliberately noninteractive until a durable queue turn exists, and exact-id
deduplication prevents two rows when the durable snapshot arrives. The hook's
public optimistic projection also reuses its previous reference when only an
unsent draft shadow changes, so typing the next prompt does not wake the
timeline.

The complete row is not hidden until acknowledgement. A tested alternative
kept only the compact receipt visible while the synthetic network response was
pending; at 5,000 messages it saved about 35 ms of immediate work but delayed
the user's full prompt by roughly another 2.2 seconds. That violates the
complete-immediate-content goal and was reverted. Under a 1.2-second draft
write plus 1.2-second accepted event response, the retained implementation
showed the full optimistic prompt in 739--779 ms at 4x CPU, then reconciled to
exactly one durable transcript copy and one queue receipt without Retry/Remove
failure actions.

Four complete-history 4x runs showed the visible Send receipt in 267–297 ms
(median about 277 ms), while the complete optimistic timeline row followed in
830–961 ms. At normal CPU, the receipt appeared in 65.7 ms, the full row in
166.9 ms, and Steer in 37.4 ms. All 5,000 markers and their full text remained
mounted; no pagination, virtualization, hidden history, or reduced content was
introduced. The pathological 4x median remains 27 ms above the aggressive
250-ms target, so this is a material improvement rather than a finished
solution.

Two smaller realistic fixtures locate the knee instead of generalizing from
the maximum:

| Complete visible messages | CPU | Send receipt | Full optimistic row | Steer |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1x | 42.4 ms | 81.3 ms | 18.7 ms |
| 1,000 | 4x | 122.5 ms | 264.3 ms | 87.7 ms |
| 2,500 | 1x | 47.3 ms | 93.5 ms | 22.4 ms |
| 2,500 | 4x | 178.3 ms | 519.2 ms | 130.4 ms |
| 5,000 | 1x | 65.7 ms | 166.9 ms | 37.4 ms |
| 5,000 | 4x | 267–297 ms | 830–961 ms | 174–217 ms |

Every sample used the full production component tree and kept all corresponding
markers and text mounted with no horizontal overflow. Ordinary interaction is
healthy through large realistic histories at normal CPU; the lightweight
receipt increasingly matters on slower devices, and the broader history-load
cost remains a separate defect well before the 5,000-message extreme.

A later lossless render-plane experiment separated complete optimistic user
messages from the stable durable group list. Delivery-state updates then
re-render only the optimistic tail; a focused regression proves that all
durable rows remain mounted and their render callbacks are not revisited. With
that boundary plus the validated paint containment above, the three repeated
5,000-group 4x runs put the compact Queue receipt at 231--244 ms and Steer at
172--178 ms. The complete local prompt followed around 0.6 seconds, still
before the synthetic 1.2-second acknowledgement. Removing the defer mounted
the complete prompt in 418--463 ms but regressed the more important truthful
receipt to 391--433 ms and created two long tasks, so that alternative was
reverted. The benchmark was also corrected to avoid charging a later
2.18-million-character diagnostic `textContent` scan to full-row latency.

A fresh production-bundle run found an important lifecycle defect in the local
candidate before it could leave the lab. The stable Queue callbacks had been
declared below `SessionChrome`'s existing `signals.length === 0` early return.
Mounting with no signal and then receiving the first queued prompt therefore
changed the hook count and crashed React with `Rendered more hooks than during
the previous render`. The return now remains after every hook, and a regression
mounts the chrome empty before adding its first Queue signal. All 24 focused
chrome tests pass. This was a branch regression, not a current-main latency
cause, and is a useful example of why these candidates are not merge-ready on
microbenchmark evidence alone.

The production harness itself was then tightened again. It waits for and
focuses the exact composer textarea without a Playwright role/actionability
walk through the retained accessibility tree, and records browser page and
console errors. After that correction, one 2,500-group 4x profiled run showed
the truthful Queue receipt in 191 ms and Steer in 174 ms; event dispatch was the
largest trace slice (80 ms for Queue, 104 ms for Steer), while layout was only
10 ms and 3 ms respectively. Exact acknowledgement paths were also exercised:
Queue feedback was 208 ms for an accepted request and 193 ms for a rejected
request. The accepted prompt appeared exactly once and retained its queued
receipt; the rejected prompt remained visible, lost its stale queue receipt,
and exposed Retry and Remove. Both retained all 2,500 historical groups and
about 1.09 million rendered characters. One valid 5,000-group sample put Queue
feedback at 289 ms and Steer at 189 ms, but repeated full-size runs exhausted
the test host, so that extreme has no claimed distribution. The remaining
interaction cost is real React/event work, not network or a hidden layout
shortcut; more state-architecture change is not justified until repeatable
mobile-device profiling identifies a narrower owner.

The same full-history fixture was then used for a diagnostic render-cost split.
These variants intentionally removed visible behavior only to locate the cost;
none is a product proposal, and the production renderer was restored afterward.
At 4x CPU slowdown, loading all 5,000 markers measured:

| Diagnostic renderer | Total load | Initial 500 | DOM nodes | Retained heap after GC |
| --- | ---: | ---: | ---: | ---: |
| Plain user + plain assistant | 15.34 s | 3.50 s | 68,036 | 149 MiB |
| Production user disclosure + plain assistant | 19.85 s | 4.47 s | 98,049 | 172 MiB |
| Plain user + production assistant Markdown | 16.87 s | 3.59 s | 80,543 | 161 MiB |
| Full production renderer | 32.81 s | 5.82 s | 110,549 | 184 MiB |

The first full-production 800-marker prepend took 3.71 seconds, including
2.286 seconds of scripting and 0.404 seconds of layout, while adding 17,472
nodes. Later prepends remained 3.66--5.33 seconds. Therefore layout is not the
main complete-history cost: rich React construction, Markdown parsing, and the
per-user-message disclosure lifecycle dominate. The two rich layers together
also cross a nonlinear browser/React knee, so their isolated costs cannot be
simply added. This narrows the next experiments to lifecycle scheduling and
settled-content reuse while preserving exact Markdown, disclosure, controls,
attachments, browser Find, accessibility, and the complete mounted history.

Baseline audit: `origin/main` was
`478d7fe8feed740ae155fdc5cf7f253f2606bbb4` (2026-08-13). None of the
startup-phase metrics, the local lazy-provision defaults, or the stale-Docker
error repair in this experiment were present in that baseline. The sandbox
Dockerfile had both broad `COPY . .` build stages.

## Goal

Reduce non-model time from an observed roughly 85-second blank startup (about
74 seconds in the attributable pre-model path) to below 1.5 seconds
without weakening tenant isolation, same-session ordering, durable events,
credential fairness, file integrity, or exact per-attempt tool authority. Measure
model time separately.

## Confidence legend

- **Confirmed**: visible in current code or reproduced locally.
- **Strong hypothesis**: supported by incident timings and code shape, but missing a
  phase span.
- **Unproven**: plausible and worth an experiment; do not optimize yet.

## Complete suspect register

| Area | Confidence | Current finding | Experiment / likely improvement |
| --- | --- | --- | --- |
| Queue/admission | Strong hypothesis | A roughly 64-minute delay looks like same-session FIFO, not global capacity. | Record queue reason and eligible/admitted timestamps. Keep same-session serialization; make the reason visible. |
| Credential selection and refresh | Confirmed, normally small | Account selection is roughly 40--55 ms in the full synthetic worker matrix; fresh token read/decrypt is about 2 ms directly and 6--13 ms at the request boundary. Stale-token refresh adds OAuth latency plus only 17--24 ms local work, coalesces across processes, and fails closed at about 6 seconds. The broad UI label had conflated these paths. | Keep lock/CAS safety. Measure production refresh frequency and provider tail before considering overlap/prewarm; split selection subphases only if production traces show growth. |
| Event persistence | Clean insert fast; wait classes now attributable locally | One event is 10--13 ms p50, 10,000 prior events and 16-KiB payloads do not slow it, and same-session 32-way contention stays below 235 ms. A one-second exact lifecycle-row hold appears in `attempt_fence`; complete 10-connection saturation appears in `transaction_ready`. | Keep durable-before-publish and canonical locks. Retain the five-label diagnostic candidate for review, then use production phase evidence to identify the real holder/saturation source before changing SQL. |
| Connected-machine files | Confirmed and locally improved | Current main processes files serially. The local worker uses 20-item/48-KiB chunks with four in-machine downloads, complete batched events, one-file fallback, and no durable cache. | Run the same exact matrix on a real remote machine, including Steer, shared parents, host pressure, and command-payload observation. Do not merge from synthetic proof alone. |
| MCP/tool preparation | Confirmed historical hotspot and first improvement | Normal tools cost 927 ms average before the experiment; 630 ms was catalog build, dominated by recompiling JSON-schema validators. A bounded content-addressed validator cache reduced warm tool prep to 243–314 ms; the exact synthetic path is now 3–10 ms warm for 80–400 tools without injected remote/persistence latency. | Keep the validator cache if the full gauntlet and adversarial review pass. Continue real remote-MCP scaling. Retain the exact attempt catalog and fail-closed required servers. |
| Agents SDK tool projection | Rejected as a local bottleneck; correctness defect fixed locally | Exact `Runner` plus Responses conversion reaches fake `fetch` in 0.47 ms warm for 80 tools, 1.28 ms for 400, 2.46 ms for 400 oversized schemas, and 8.05 ms for 2,000. The pinned SDK's global server-name cache could expose a previous attempt's broader model-visible tool list. | Do not add a projection cache. Keep sending the complete authorized surface. Disable only the redundant SDK-global list cache at the attempt-frozen wrapper and retain exact alternating-permission regression coverage. |
| Conversation history | Confirmed and bounded locally | The real production activity preserved all seeded input through 8,000 rows / roughly 15 MiB. Warm 1,000-row history preparation was 28--57 ms for messages/tool pairs and 157 ms for the unrealistic 1,000-authorized-file case; warm 8,000-row preparation was 133 ms. Above the inference envelope the worker fails loudly; durable/UI history is unchanged. | Keep complete UI history. Measure the production DB/network tail and hundreds-of-files authorization only if real telemetry shows them; do not add speculative omission, compaction, or prepared-history state. |
| Post-file gap | Locally rejected; incident trace required | The complete real DB/NATS/Temporal/worker/runtime path reached scripted provider dispatch in 223--403 ms warm and below 0.9 s cold even near the 15-MiB history envelope. Warm provider dispatch itself was below 1 ms. The old roughly 18-second attribution did not reproduce. | Capture the exact production phase trace and correlate row-lock/pool/remote-file waits. Do not optimize a guessed local phase. |
| NATS credentials | Confirmed healthy | Enrollment bearer and relay token are 30 days on current main. Auth-callout user JWT is capped at 5 minutes and reminted on reconnect. A real three-second seam and a production-duration five-minute run both reauthenticated and preserved request/reply; reconnect took 13 ms and 22 ms respectively. The earlier “5-minute enrollment credential” description was wrong. | Keep the end-to-end expiry regression. Do not lengthen the scoped credential or add a runtime fix for behavior that already works. |
| Worker load balance | Locally rejected as an ordinary startup bottleneck | Real one- and two-worker Temporal tests put ordinary hot admission at 51--94 ms, capacity waves at the expected 200-ms work cadence, and routed 30--35% of a 100-item burst to a late-joining second worker. Fresh process readiness was 1.02--1.40 s, relevant to autoscaling rather than ordinary long-lived workers. | Keep the present placement model. Correlate production queue age, RSS, and image/pod startup only if a real imbalance recurs; do not split workers or duplicate imports from the old snapshot. |
| UI visibility | Confirmed | “Waiting for first step” hides queue reason and pre-model phase progress. | Surface queued/admitted/startup phase and elapsed time from durable low-cardinality milestones. |
| Local port discovery | Confirmed and reproduced | macOS `lsof` blocked about 20 seconds per probe on an unhealthy OrbStack NFS mount. | Prefer bounded loopback `nc`; retain fallbacks. |
| Host filesystem health | Confirmed symptom, broader cause unproven | The full repository gate later reported OrbStack NFS `resource temporarily unavailable` while the unchanged Channel-A real-local-box suite accumulated four 26–42 second filesystem/Git failures in a narrow rerun. The worktree itself is on APFS, so the exact cross-mount causal chain is not yet proven. | Keep this separate from turn latency. Add host/mount health to local diagnostics; do not weaken Channel-A confinement or inflate its timeouts to conceal an unhealthy machine. |
| Remote local-development endpoints | Confirmed and reproduced | Default local enrollment advertises loopback endpoints and binds the relay to loopback, so a remote Connected Machine cannot reach it. | Allow an explicit local relay bind, validate and briefly claim its exact address before startup, and advertise the Mac's Tailscale API/NATS/relay endpoints. |
| Cold sandbox image build | Confirmed, separate | The first local stack boot builds a large sandbox image and tool runtimes. | Treat as environment setup, cache it, and exclude it from per-turn latency. |
| Local image rebuild invalidation | Confirmed and reproduced | An ordinary worker/runtime edit invalidates two broad `COPY . .` stages. The latest restart spent about 63 seconds in Docker and about 94 seconds before the full stack was ready; dependency install, artifact-runtime preparation, and multi-gigabyte source copies reran. | Replace broad source dependencies with an exact image-input closure or a content-addressed local image admission receipt. Never skip a build on `HEAD` alone because dirty relevant source must invalidate it. |
| Exact-head artifact runtime | Confirmed, separate | No successful hosted artifact existed for this main SHA, so local standalone Office artifact operations are disabled. | Record as environment parity; it is not evidence of a turn-start bottleneck. |
| Provider timing semantics | Confirmed | The existing request `headers` duration begins before the durable `agent.model.request started` append, so it includes audit persistence and is not a pure provider-network measurement. | Keep the durable-before-fetch fence, but report request preparation, start audit, and post-audit provider wait separately. |
| Lazy sandbox policy | Fixed on current main after local reproduction | The first dev experiment used the plausible but wrong `_ENABLED` suffix; config reads `OPENGENI_SANDBOX_LAZY_PROVISION`. #1473 now keeps credential authority pre-model but moves credential-backed sandbox materialization and renewal behind first use. Generated-video inputs, signed file resources, explicit Connected Machines, and lazy-disabled deployments remain intentionally eager. | Keep the bounded policy-reason metric and the eager correctness exceptions. Do not duplicate #1473 or infer that every rig operation is now lazy. |
| Stale local Docker identity | Confirmed defect and fixed locally | A resumed session can retain a deleted container id. Docker emits `Error response from daemon: No such container`, but current main only recognizes `Error: No such container`, so the typed recovery path is skipped and the raw error reaches the user. | Accept only the exact container id with either known Docker prefix, then reuse the existing typed unavailable-instance recovery. |

## Measured local results

All synthetic calls use `codex/gpt-5.6-luna`, low reasoning, a managed Docker
sandbox, no file resources, and the same `Reply with exactly ready.` prompt.
Model/provider time is excluded from the pre-network comparisons.

### Six interleaved samples per tool condition before the cache experiment

| Phase | Minimal tools | Normal 80-tool UI surface | Normal penalty |
| --- | ---: | ---: | ---: |
| Required MCP connect | 119 ms | 133 ms | 14 ms |
| Optional MCP connect | <1 ms | 70 ms | 70 ms |
| Attempt catalog build | 66 ms | 630 ms | 564 ms |
| Attempt catalog persist | 10 ms | 79 ms | 69 ms |
| Total tool preparation | 195 ms | 927 ms | 731 ms |
| Prior aggregate labelled SDK projection/serialization | 1,119 ms | 1,528 ms | 409 ms |
| Credential resolution at request time | 13 ms | 6 ms | none |
| Wire normalization | <1 ms | <1 ms | none |
| Durable model-request start audit | 44 ms | 31 ms | none |

Queue-to-worker handoff was 0.22–0.46 seconds. Warm minimal sessions reached the
request boundary in 0.94–1.68 seconds; normal sessions were usually 1.33–2.47
seconds, with one 5.97-second outlier. That outlier remains a required
per-sample investigation, not noise to discard. The later exact boundary
benchmark proves that the aggregate row labelled SDK projection included work
outside core SDK projection and OpenAI request construction.

### Bounded validator-cache experiment

`createAttemptToolEnvironment` was recompiling all JSON-schema validators with
AJV for every attempt. The experiment reuses only exact content-addressed
validator functions in a 512-entry process-local LRU. Attempt scope, digest,
executor closures, catalog persistence, and authorization remain newly created
for every attempt.

| Normal-tool run | Catalog build | Total tool preparation | Turn start → request |
| --- | ---: | ---: | ---: |
| First cold run | 576 ms | 981 ms | 2.19 s |
| Warm range (five runs) | 88–123 ms | 243–314 ms | 0.86–1.31 s |

The warm normal path, including queue handoff, is now roughly 1.1–1.6 seconds.
This meets the 50× target relative to the 85-second incident for this clean
Docker/no-file/small-history baseline. It does **not** yet prove the original
large-history, multi-file, same-session, or Connected Machine cases.

### Lazy-provision correction and repeated Luna proof

Every model call in this investigation is pinned to `codex/gpt-5.6-luna`.
Non-model probes use no model at all. A bounded policy-decision metric records
`eager`/`on-demand` and one closed reason without session, credential, file, or
sandbox identifiers.

Before correcting the local config key, zero-file/no-first-party-tool Luna turns
reported `eager/lazy_disabled` and paid:

- sandbox establish: 0.73–1.49 seconds;
- owned sandbox setup: 0.56–0.90 seconds;
- one Docker sandbox created before the model request.

After exporting the exact `OPENGENI_SANDBOX_LAZY_PROVISION=true` key:

- nine consecutive Luna turns all reported `on-demand/eligible`;
- average worker preparation before entering the runtime was 0.368 seconds
  (`3.313 / 9`); lazy SDK request preparation and the durable request-start
  audit were measured separately and are not included in that number;
- average sandbox-establish bookkeeping was 0.020 milliseconds
  (`0.000176 / 9`);
- zero Docker sandboxes were created by those chat-only turns;
- active history grew through the `21+` count bucket without leaving the target.

The first subsequent `exec_command` created exactly one Docker sandbox in
0.537 seconds. A second turn read and appended the marker from the same exact
instance
`fba61104cc50168d379f5c7e8ae4be5dc3720b7b4524a7e07fec71fd1010d3f8`.
This proves both halves of the contract: chat-only turns do not provision, and
the first real sandbox operation provisions single-flight without losing
same-session workspace continuity.

### Verification state

After the experiment branch was rebased onto the then-current `origin/main`, the
focused changed-path suites reported 716 passes and 0 failures. Worker, runtime,
Codex, and Codemode typechecks passed; the development-stack shell syntax,
formatting, and diff checks also passed.

The final 2026-08-15 focused pass, after the last measurement-only delta and
evidence updates, reported: 282 runtime tests, 9 Codex-pin database tests, 48
rig/API/core/worker tests, 24 production `SessionChrome` tests, 123 queue
database/React tests, and all 10 queue browser/accessibility cases passing.
Runtime, database, worker, React, and web typechecks passed. All 132 formatter-
eligible changed or new paths were format-checked; all changed/new
TypeScript/TSX paths linted cleanly; `git diff --check` passed. The first full
queue browser run had one accumulated-state timeout, but the exact case passed
in 1.03 seconds alone and the complete fresh rerun passed in 107 seconds. No
provider/model call was made during this final pass.

The pre-rebase full `bun prep` reached 9,152 passes and 5 failures across 1,006
test files. The observed failures were confined to the unchanged Channel-A
real-local-box suite during the host filesystem incident above. A narrow rerun
of that unchanged file reported 70 passes, 2 skips, and 4 failures, all in slow
filesystem/Git cases. This is not called green, and it is not attributed to this
branch without evidence. Hosted CI remains the clean-environment arbiter.

## Simple decision register

| Keep / fix | Item | Why |
| --- | --- | --- |
| Fix locally, review separately | Queue actions and off-screen paint for a complete huge queue | Visible `Steer`/`More` plus one-row disclosure is clearer on touch. Responsive content-box intrinsic sizes of 28 px desktop / 44 px coarse-pointer produce the exact 36 / 52 px padded rows. The final actual-source 5,000-row matrix opened in 0.53--0.55 seconds at mobile 4x CPU while preserving every prompt/action, zero-drift scroll geometry, browser find, accessibility discovery, and deep keyboard focus. A truthful Steer receipt appears in 69 ms before complete reconciliation. The candidate remains unmerged. |
| Continue experimenting; do not merge yet | Rewrite and resend the complete huge queue after every row mutation | Current main rewrites all positions and returns the complete canonical snapshot. At 5,000 rows the isolated rewrite is 150 ms p50, the full command is 219--270 ms p50, and the 413-KB gzip response takes 2.114 seconds at a measured 1.6-Mbps mobile profile. One-row head/delete mechanics are 13--14 ms and preserve exact order. A 522-byte gzip revision-fenced move delta reconstructed all 5,000 rows in 112 ms p50 on the same weak-mobile profile and rejected a stale base without touching local data. The payoff is now proved, but arbitrary moves, rebasing, multi-client delta application, SSE dedupe, and public SDK compatibility still need design/proof. Keep every prompt locally; do not merge the benchmark protocol. |
| Fix locally, review separately | Re-commit every rich user row after disclosure measurement | Exact A/B proof reduced a 2,500-group 4x mobile load from 21.32 to 9.30 seconds while preserving every message, control, search/accessibility result, and scroll dimension. The candidate remains unmerged. |
| Fix | Recompile identical tool validators every turn | Pure repeated CPU; bounded content-addressed reuse preserves authority. |
| Fix locally, review separately | Let the Agents SDK reuse a process-global model-visible MCP tool list across attempts | The SDK cache is keyed by stable server name rather than OpenGeni's attempt authority. Disabling only that wrapper cache preserves the exact frozen catalog and prevents stale broader schemas without extra remote list calls. |
| Fix locally, review separately | Re-run one rig credential hook id up to 50 times per turn | Current main's claimed dedupe misses duplicates inside a rig. Resolve every id fail-closed, then keep the first occurrence. Exact runtime A/B reduces 50 repeated entries from 50 commands to one without removing a distinct capability. |
| Fix separately | Maximum valid rig setup can exceed Modal's command argument ceiling | Current main's 24-KiB chunk is multiplied by both cancellation and `runAs` wrappers; a 20-KiB control reached 142,230 bytes against Modal's 65,536-byte limit. The local seven-KiB fallback is exact and safe but costs 80 calls / 10.3 seconds at 100-ms RTT. Ship the correctness bound independently of any fast-path experiment. |
| Continue experimenting; do not merge yet | One-write provider-native staging for a large rig setup | Real Modal moved 392,504 exact bytes in one 276-ms filesystem write and cut the complete fallback to 1.80 seconds, but the provider method has no abort/timeout seam and is outside the turn command fence. Require physical cancellation ownership before treating it as safe. |
| Fix locally, review separately | First-rig image readiness is invisible in the composer | Image preparation is asynchronous and usually took 15--19 seconds for the maximum setup. A compact coarse status plus selected-rig-only adaptive polling tells the truth, keeps Send available, stops polling at terminal state, and exposes no content or provider ids. |
| Keep for ordinary turns; investigate build protocol separately | Sequential rig verification checks | They do not run per prompt. One provider-image cold-boot proof deliberately runs the marker plus every declared check in order; 100 checks can cost 10.28 seconds at 100-ms RTT. Preserve ordered/fail-visible results; consider a sequential-in-sandbox structured batch only for provider-image build UX. |
| Fix as an explicit product contract | Valid rig environment can exceed provider/process limits | Docker failed around a 1-MiB host command envelope while the schema permits roughly 78 MiB. Never truncate values. Add clear provider-aware admission and decide whether large values require a separate file-backed secret/config contract. |
| Keep complete; improve only with measured rendering changes | Maximum rig setup text on the detail/edit screen | Complete 393-KiB pathological text takes about 2.0--2.1 seconds at mobile 4x CPU. Small CSS/native-textarea experiments were insufficient or changed UX, so they were reverted. The list/picker stays complete via summary and detail remains exact. |
| Fix | Keep local lazy provisioning disabled accidentally | Pure pre-model waste for chat-only turns. Use the exact config key, retain eager exceptions for credentials/video/signed files, and expose the bounded reason. |
| Fix | Let a deleted Docker id escape as a raw inspect error | It prevents the existing typed recovery path; the matcher can remain exact and fail closed. |
| Fix separately | Rebuild the full sandbox image after unrelated worker edits | It adds about a minute to every instrumentation restart and discourages rigorous testing. Use an exact content closure, not a stale image shortcut. |
| Keep; no cache | Re-project and serialize the complete authorized tool surface for every request | Exact local SDK plus Responses conversion is below 1 ms at 80 tools and about 8 ms even at 2,000. The complete surface is required functionality; optimize provider/network context separately if real evidence appears. |
| Keep | Complete durable/UI history and the inference serving envelope as separate contracts | All admitted active model history reached the scripted model exactly; the local full path stayed below 0.9 seconds near 15 MiB. Oversized inference history fails loudly while durable/UI history remains complete. Never make the UI faster by hiding or deleting content. |
| Fix visibility | Blank UI during queue and startup | The user cannot distinguish queueing, local setup, and model time. |
| Fix visibility, not persistence semantics | Seconds-scale durable event append | Clean inserts are fast. The local five-phase metric now distinguishes exact lifecycle-row waits from pool admission without IDs, queries, or behavioral changes. Review that instrumentation separately; never touch SQL or lock correctness from the aggregate alone. |
| Fix after remote acceptance | Serial Connected Machine file verification | Scaling is confirmed and the bounded local candidate is materially faster while preserving complete file/event truth; real remote cancellation and payload proof remain. |
| Fix if incident reproduces | Slow durable event appends | Clean local audit append is tens of milliseconds; incident evidence was seconds. Durable-before-publish stays. |
| Keep | Fresh credential resolution and refresh safety fences | Fresh resolution is 6--13 ms at request time. Refresh host work is ~17--24 ms over provider delay, and same-credential callers issue one refresh across processes. The 6-second hung-provider bound is deliberate. |
| Keep | Request wire normalization | Measured below 1 ms. |
| Keep | Required MCP fail-closed behavior | Security/correctness invariant; optimize implementation, not semantics. |
| Keep | Exact attempt catalog and durable start audit | Required fencing and forensic truth. Optimize their mechanics, never remove them. |
| Fixed on current main | Resolved run credentials forced eager provisioning | #1473 keeps pre-model authority/auth-needed resolution but defers box writes and renewal to first use. Do not duplicate this local work. |
| Keep | Eager provisioning for generated-video inputs and signed file resources | Those bytes must be materialized into one exact leased box before the first model boundary so failures are represented in model input. The reason metric makes this cost explicit. |
| Keep | 5-minute NATS auth-callout JWT | It is a scoped transport credential, not the 30-day enrollment identity. Test reconnect behavior; do not lengthen it merely to hide churn. |
| Separate | Provider/model response time | Variable and externally controlled; never charge it to local startup work. |

## Required instrumentation

One worker-preparation total plus a phase family with low-cardinality labels:

1. queue/admission and reason
2. turn claim
3. credential policy lock, selection, lease, session write, event append, token resolution
4. sandbox establish
5. file resolve, verify, download
6. MCP connect, list, catalog freeze, catalog persist
7. history read, deserialize, sanitize/project, attachment materialize
8. agent construction
9. provider dispatch

The worker-preparation total intentionally ends when control enters the runtime.
Lazy SDK request preparation, the durable model-request audit, and provider wait
remain separate phase observations; calling the worker-only slice an end-to-end
pre-model total would understate real non-model latency.

Implemented phase splits now cover tool server construction, required/optional
connect, catalog build/persist, detailed history preparation, SDK sandbox/client
preparation, request-time credential resolution, wire normalization, durable
request-start audit, provider lifecycle, event append, NATS publication, and the
bounded sandbox establish-policy reason. The local UI experiment now explains
durable queue wait states, but backend queue eligibility/admission timestamps,
per-file Connected Machine work, and credential-selection internals remain.

Labels: provider, sandbox backend, phase, outcome, count bucket, cache hit/miss.
Attempt/session identifiers belong only in logs and traces.

## Baseline matrix

Use the same prompt, history, attached files, MCP set, and tool policy:

1. One Codex subscription account, rotation off, Docker sandbox.
2. The same Codex account on one Connected Machine.

Grok/SuperGrok is explicitly out of scope. Only after the two Codex baselines:
multiple credentials/rotation, many files, many MCP
servers, long history, NATS expiry boundaries, and concurrent workers.

## Safety invariants to keep

- Same-session turns remain ordered.
- Required MCP servers fail closed.
- Startup diagnostics fail open: an observer or legacy manifest inventory failure
  is recorded as failed but can never block provider dispatch.
- Soft file-download failures keep their model-facing failure note and are also
  reported as failed startup materialization, never as a successful phase.
- The exact attempt tool catalog remains frozen and durable.
- Events remain durable before live publication.
- File writes remain hash-verified, atomic, and read-only.
- Connected Machines retain ambient user filesystem and credential authority;
OpenGeni does not clone a replacement repository or inject platform GitHub
credentials.
