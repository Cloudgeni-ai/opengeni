# Portable merge batcher

## Active child diagnostics

The active CLI emits `batcher-child-failure/v1` on stderr, retaining bounded,
credential-redacted error name, message, stack, phase, operation and HTTP status.
The complete JSON record fits within 6144 bytes; truncation is explicit. Atomic
push errors retain their unsafe phase through outer controller handling. This is
diagnostic evidence, never permission to replay a transaction: existing CAS,
unknown-effect reconciliation, admission and candidate-CI retry rules remain
authoritative. Supervisors must preserve unsafe holds rather than interpreting
every nonzero child exit as an ordinary retry.

The supervised active child must emit a valid structured failure record. Missing,
malformed or signal-terminated output is an unknown outcome and stops the writer;
a valid unclassified record uses backoff and stops after three consecutive failures.
Success or a classified provider failure resets that streak, not other local errors.
Known pre-spawn rejections may back off; ambiguous starts and CAS outcomes stop.

The deployment supervisor's local checkpoint retains counts, backoff and stop
latches. A surviving in-flight or outcome-unknown checkpoint holds without spawning
a writer. Complete checkpoint loss loses this local policy state; cold-start remote
reconciliation is mandatory but does not recreate failure history. A supervisor
STOP is not a GitHub Manual-rules restoration. The reviewed operator OFF procedure
and rules restoration are separately required for a durable operational stop.

An explicitly authorized operator START creates a new control generation and resets
the **settled** failure streak, backoff and local stop latch from the preceding
generation. This is an operator reset, not an automatic retry. Surviving in-flight
or outcome-unknown checkpoint phases remain fail-closed across generations; START
does not authorize clearing them or replaying an unknown write.

### Evidenced operator OFF time in latency accounting

`BATCHER_OPERATOR_OFF_EVIDENCE` optionally supplies bounded noncredential JSON with
schema `batcher-operator-off/v1`, repository/branchPrefix/mode/serviceUid, consecutive
provider control versions (`version`, `at`, `state`, `generation`) and proven drain
receipts (`at`, `controlVersion`, `controlGeneration`, `serviceUid`, `manualZero`,
`writerExited`, `stateStable`, `forced`). This is trusted operator input, not an
authentication mechanism: retain the provider version responses and actual drained
STOP receipts, verify the service identity, then approve the configuration change.
Untrusted PR/comment content must never populate it.

Credit begins only at successful non-forced drain completion and ends at the first
subsequent START control version. Gaps, invalid scope, future/reversed timestamps,
unproven exits and intervals longer than seven days are refused; open STOP intervals
earn no credit. No duration is inferred from missing observations. The journal adds
evidence-digest-bound intervals to stage records without altering raw timestamps.
Intervals are clipped to each exact ready-binding/first-CI-start window and unioned
with evidenced main-capacity waits, avoiding overlap or duplicate credit. Raw p95 is
still reported and genuine residual slowness still triggers the breaker. Credits
survive ordinary journal/ledger reconstruction; no state file is edited by hand.

No historical OFF duration is assumed merely because the service is stopped now.
Without configured evidence or retained credits, the original conservative raw
latency remains. Supervisors must explicitly forward the optional setting to the
active child; adding evidence requires a separately reviewed runtime configuration
update, not an implicit history reset.

## Explicit first activation initialization

Active mode requires a present, operator-initialized `refs/heads/batcher-state`.
It never bootstraps an empty ledger when that ref is absent. Missing or unstamped
state raises `ActiveStateInitializationError` and holds all effects; subsequent
state loss is an anomaly, not permission to initialize again.

The operator-only `initializeActiveState` function in
`scripts/merge-batcher/initialize.ts` is invoked by a separately reviewed deployment
adapter, not by the runtime loop. It requires fresh persisted OFF, reconciled
manual0, writer-exit evidence, complete zero-instance observations and no pending
effects. The adapter must obtain these facts from current provider reads and the
matching deployment receipt, not user-supplied boolean assertions.

Initialization creates a generation-stamped empty ledger through one create-only
Git transaction. Before submission the operator exclusively creates and syncs a
permanent intent journal in its canonical deployment directory. Preserve that
journal through cleanup, upgrades and rollback: an existing intent, an existing
state ref or an unknown submission is never replayed. Lost responses require
read-only reconciliation of the exact intended SHA; they never trigger another
initialization attempt. Do not delete an intent to recover missing state.

The supported scope is `batcher-state` plus `queue/live/`. All other `queue/`
refs also refuse initialization except historical `queue/shadow-traffic/`, which
belongs to its separate shadow state fence and is retained unchanged. Thus live
candidate, diagnostic, malformed and no-run reservation refs block initialization;
historical shadow CI still counts in ordinary global capacity observations.
The deployment adapter must also reject unresolved effects in the stopped
controller's existing ledger. Do not delete historical refs to pass these checks.

The existing present-state STOP proof is unchanged. Initialization is a separate
explicit operational mutation, not an OFF fallback or an empty-state proof.
No init, rules change or start is authorized by installation of this code.

## Core

This is the in-house batcher core. It uses Bun 1.4.4, built-in APIs and
Git (2.38 or newer for `merge-tree --write-tree`). No database, checkout, native
`merge_group`, vendor queue, cloud SDK or cloud-specific state service is used.
The default mode is **read-only shadow**. Opt-in `shadow-ci` publishes candidates
without landing them, using a dedicated configured state ref.
No live writer was exercised by this implementation task.

## Activation boundary

The pure planner, candidate builder, inspector, durable state model, controller,
Git CAS adapter and GitHub read/write surfaces are implemented and locally
testable. `main.ts` wires the real `GitHubActiveExecutor` only with explicit
`BATCHER_MODE=active`. **It has not been activated or remotely exercised.**
For this rollout, main activation remains prohibited until the parent's release
has finished and the parent explicitly gives the go-ahead.

The accepted GitHub contract is **only the exact tested tree lands**, not
“no PR head can change after the final HTTP read.” The adapter rechecks every
head/readiness/evidence binding, source branch head, exact workflow result and
main-CI headroom immediately before its atomic Git transaction. A last-moment
PR update remains possible; no local lock or single replica eliminates it.

One narrow head-refresh exception preserves a candidate when a queued PR only
merges main into its tested head. The verifier requires an unbroken first-parent
chain of at most eight two-parent merges back to that head; every second parent
must be an ancestor of the unchanged candidate base, and every merge tree must
reproduce exactly. The PR contribution on that base and the entire rebuilt batch
tree must both remain identical. Readiness event/source and branch identity must
remain unchanged; current-head hosted checks must independently pass. Linear or
squashed updates, conflict-resolution edits, side-branch merges, changed readiness,
main movement and substantive changes rebuild normally. Patch-id equality alone
is never sufficient. This exception applies only to root candidates.

The original tested manifest, queue ref and run/attempt remain immutable. Landing
may append ancestry-only merges of refreshed heads to the tested tip, each with
the same tested tree and an explicit `Batch-Head-Refresh` old/new-head trailer.
This preserves native GitHub merged-head ancestry rather than pretending the old
head is the new one. The ledger retains `testedSnapshot` alongside the actual
landed head/tip. The final GitHub executor recomputes the proof after fresh
readiness reads and still requires the original exact trusted green workflow
attempt and atomic FF-only main/state CAS. Other adapters reject this extension
unless they implement it. GitHub metadata can still race after the final read;
post-land reconciliation remains necessary. No remote cancellation or rerun is
used to grant equivalence.

GitHub advertises atomic receive-pack. The changing lease and FF-only main tip
(or create-only candidate) are updated together; there is no fallback to
separate pushes. GitHub does not offer atomic PR-metadata or REST-effect fences.
`githubCapabilities` continues to report those limitations honestly. The strict
`AdmissionCoordinator`/`FencedGitExecutor` interface remains available for other
providers; the real GitHub executor explicitly selects the weaker accepted
contract rather than falsely advertising stronger capabilities.

After landing, the adapter records and comments the exact tested head and landed
tip, then rereads the actual source branch (including forks). Open newer heads
retaining landed ancestry automatically re-enter normal admission: they need
their **own** required exact-head GitHub-hosted checks, and the next merge against main
contains only the remaining delta. Old evidence is never inherited. Divergent
history is held with a rebase explanation. The adapter never closes/reopens PRs.
**GitHub may auto-close a PR when its old head reaches main, before a newer push
is observed.** For an original marked merged and associated with the batcher's
landed snapshot, the adapter durably creates or reuses a follow-up PR on the exact
observed source repository/branch. It never does this for an externally closed,
unmerged PR. New work must retain landed ancestry and still needs normal fresh
exact-head GitHub-hosted checks and readiness; neither is fabricated or copied.
The follow-up intent is keyed by source repository/branch/head, reconciled by its
marker or an existing open PR for that exact source/head, and never blindly
replayed after an ambiguous POST. Permission/source-access/provider failures
remain `followup-blocked` or `provider-unavailable` with a specific reason. Closed follow-up PRs are not
reopened or duplicated for the same snapshot.

GitHub creation addresses a mutable branch, not an atomic expected-head SHA.
The source head is reread immediately before POST, but a later race can make the
new PR contain an even newer head. Reconciliation reports that actual head as
untested; only normal fresh admission and candidate CI can qualify it. An
uncertain earlier creation holds later intents for that source branch until its
outcome is resolved, preventing duplicate PRs across head changes.

Keep non-FF/deletion guards in a separate ruleset the batcher cannot bypass;
bypass of a combined PR-admission rule also bypasses its non-FF/deletion guards.
Repository rulesets, trusted workflow policy and App permissions remain rollout
dependencies, not substitutes for missing provider transaction guarantees.

The parent workflow integration and production deployment are separate work.
No branch/ruleset/permission/cloud activation is performed by this code change.

The [administration bundle](merge-batcher-admin/README.md) prepares the dedicated
App and reversible split rulesets offline. It is not an activation mechanism.
Main control requires the rollout owner's explicit authorization; candidate-only
CI shadow does not authorize it. Preserve the existing manual squash and full-main
release proof paths until the coordinated controller/rules activation.
The version 3 admin plan makes the App the only normal main writer while active,
including PR merges; organization administrators have emergency writer/admission
bypass, but no bypass on the separate non-FF/deletion guard. GitHub enforces the
grant, not emergency intent; routine administrator queue bypass is prohibited. The same
verified activation receipt selects AGENTS' queue-only instructions. Partial
transitions hold merges. Emergency OFF must prove runtime stop **and** exact
original ruleset restoration before instructions return to normal manual squash.

## Commands

```sh
# Run one read-only observation; explicitly overrides BATCHER_MODE=active.
bun scripts/merge-batcher/main.ts shadow --once

# Poll; still shadow unless explicitly configured otherwise.
bun scripts/merge-batcher/main.ts run

# Opt-in CI shadow; the dedicated state ref is routine controller state:
BATCHER_MODE=shadow-ci \
BATCHER_SHADOW_CI_STATE_REF=refs/heads/batcher-shadow-ci-state \
bun scripts/merge-batcher/main.ts run

# CI interface: stdout contains only the inspected JSON manifest.
bun scripts/merge-batcher/main.ts inspect --tip "$TIP_SHA" --git-dir "$BARE_GIT_DIR"

# Focused verification (two test workers maximum).
bun test --max-concurrency 2 scripts/merge-batcher/*.test.ts
node node_modules/typescript/bin/tsc -p scripts/merge-batcher/tsconfig.json

docker build -f docker/merge-batcher.Dockerfile -t opengeni-merge-batcher .
```

The inspector needs full commit objects and merge bases, not only a shallow tip.
Fetch the exact tip with enough history before inspection. It validates every
member's exact two parents, ordered first-parent chain, recomputed merge tree,
manifest digest and deterministic commit bytes. A check name or arbitrary
JSON trailer alone is not sufficient. Git conflicts and malformed manifests
fail inspection with a nonzero exit code.
Use the same Git version/configuration for controller and CI inspection: merge
algorithm changes between Git versions may change complex rename/conflict
results. Global/system Git configuration is ignored and merge normalization
settings are explicit; the cache should remain a batcher-owned bare repository.

### Configuration

| Environment | Default / meaning |
| --- | --- |
| `BATCHER_REPOSITORY` | `Cloudgeni-ai/opengeni` |
| `BATCHER_BASE_BRANCH` | `main` |
| `BATCHER_BRANCH_PREFIX` | `queue/live/` in active, otherwise `queue/`; keep diagnostics in a separate namespace |
| `BATCHER_MODE` | `shadow` by default; explicit `shadow-ci` or `active` |
| `BATCHER_SHADOW_CI_STATE_REF` | No default; explicitly configure `refs/heads/batcher-shadow-ci-state` |
| `BATCHER_MAX_BATCH_SIZE` | `16` |
| `BATCHER_MAX_INFLIGHT` | `1` hosted candidate CI |
| `BATCHER_RUNNER_BUDGET` | No default; explicitly allocated repository runner/job budget, not an assumed organization quota |
| `BATCHER_MAIN_RESERVE` | No default; conservative slots reserved for full-main CI |
| `BATCHER_PROVIDER_JOB_LIMIT` | `60`, GitHub's documented Team concurrent-job default for the whole organization's hosted pool |
| `BATCHER_OTHER_REPOSITORY_ALLOWANCE` | `28`, assumed runner-holding jobs in other organization repositories (measured maximum; see headroom) |
| `BATCHER_SPECULATION_DEPTH` | `2`, including current candidate |
| `BATCHER_GIT_DIR` | `/data/objects.git`, disposable bare object cache |
| `BATCHER_OUTPUT_DIR` | `/data/shadow`, local stage/manifest evidence |
| `BATCHER_POLL_SECONDS` | `120` in shadow modes, `30` in active; failures back off |
| `BATCHER_FETCH_TIMEOUT_SECONDS` | `600` for cold/large Git fetches; other Git commands retain a 60-second bound |
| `BATCHER_MISSING_RUN_SECONDS` | `900` before a never-started workflow becomes an abandoned infrastructure hold |
| `BATCHER_LEASE_SECONDS` | `120`, durable provider lease, not local leadership |
| `PORT` | `8080` |
| `GH_TOKEN` or `GITHUB_TOKEN` | Existing repository token; never baked into the image |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | Alternative App authentication; private key PEM supplied at runtime |

An existing token is preferred over App authentication when both are configured.
App authentication mints a short-lived installation token; in shadow it requests
only contents/actions/pull_requests/issues **read** permissions. That auth exchange
does not mutate repository refs, comments, labels, workflows or checks. The
existing-token live-shadow path uses no token-creation API. Credentials are
passed to Git through environment-based configuration, never command arguments,
remote URLs, files, stage output or logs. Provider response bodies and Git stderr
are suppressed on errors to avoid credential leakage.
Shadow-ci App authentication requests contents/workflows write and
actions/pull_requests/issues read, not comment/label or Actions rerun writes.
Active App authentication requests contents/workflows/actions/pull_requests/issues
write for atomic Git updates, whole-workflow reruns, exact-head comments and
remaining-delta follow-up PR creation.
It never uses labels/readiness changes or PR close/merge endpoints.

Public repository reads can work without credentials, but private repository
access and GraphQL ready-event discovery require suitable read permissions.
Authentication/rate-limit failures are explicit observation failures; the
service does not interpret an incomplete observation as an empty queue.

## Admission and FIFO

The GitHub-only admission contract is an open, non-draft PR with `queue-ready` or a current native auto-merge request,
and successful configured required GitHub-hosted checks on its exact current head.
The admission workflow is fast lint, types and selected units, not the full PR
suite; full main CI remains the post-merge backstop. A main push may reuse unit
coverage only from a successful Batch attempt on the identical Git tree whose
unit inventory exactly equals the complete current main unit inventory. Selected
subsets are insufficient, even when their Batch is green. The proof binds the
canonical per-PR Git manifest, run and attempt, archive SHA-256 digests and full
shard receipts; same-tree/different-commit reuse preserves both commit identities.
Missing, expired, ambiguous, partial or unavailable evidence runs the normal main
unit suite. Discovery is bounded and can miss old proofs without weakening tests.
One main unit verification job checks the retained proof instead of allocating
twelve unit runners. It skips history hydration and dependency installation;
service, e2e, image and release/full-green gates remain unchanged. A failed-job
rerun can consume the same main run's earlier successful plan attempt, never a
different run or a future attempt. Coverage is compared with main's full impact
plan, including its original unit count.
`ci-impact-plan/unit-reuse.json` records the proof (or null for a normal run).
These instructions
apply to coding agents in Cursor and other workspaces without an owner-specific
comment format or human-only intake step.
Agent evidence comments, VM attestations and reviewer session UUIDs are not intake
gates. Approval requirements remain those of existing repository protection;
the batcher adds no separate approval requirement. Required checks must be trusted
workflow results, not copied comments or old-head success. Changed heads need fresh
checks and candidate CI. This documentation/admin change must be deployed together
with the matching reviewed core/workflow implementation; it does not change an
already running controller or authorize activation.

Mark a draft PR ready for review before expecting admission. A `queue-ready`
label on a draft does not make it eligible; check the current draft flag and
exact-head check results rather than toggling the label to troubleshoot a wait.

For a parked singleton, open the failed GitHub check and its logs, fix the cause,
push a new head and let required checks finish before signalling readiness. A
label toggle alone does not retry the same parked head. Parking comments identify
the failed check without assigning blame; do not rerun/cancel Batch CI manually.
Parking also durably requests disabling native auto-merge. Explicitly re-enabling
auto-merge after parking creates a new retry request for the unchanged head.
Changed heads still require fresh exact-head checks. Disable observes current
head and enable time before submission; GitHub provides no atomic expected-head
condition for that mutation. Ambiguous submissions are held, never blindly replayed.

FIFO uses actual GraphQL label timeline events or the current native
`autoMergeRequest.enabledAt`, never PR creation or observation time. GitHub may
return a current native request without a timeline event. Native readiness uses
the PR node ID plus enabledAt as its stable request identity, after checking the
observed head matches the open-PR inventory. Disabling or changing the head during
observation excludes that candidate. Re-enabling creates a new timestamp identity;
label churn does not release a parked unchanged head. Native requests take
precedence over labels. Missing/malformed current request evidence or incomplete
label history is not permission to admit. Historical bindings remain immutable.
`changeset-release/main` is a barrier: earlier PRs batch first, Version is a
singleton, and later work does not speculate across it.

Use native auto-merge (for example `gh pr merge --auto`) or `queue-ready`. While
batcher admission is ON, protections must prevent native/direct auto-merge from
bypassing this batcher. Only the
authorized batcher principal may normally update queue/state refs; PR authors must not
be able to forge those refs or the trusted candidate workflow/result artifact.
The batch CI workflow must be trusted policy, not replaced by PR-controlled
workflow changes. The parent owns that workflow/ruleset enforcement.
Repository auto-merge enablement and the guiding required check must be coordinated
with that policy; this source change alone does not enable them or waive any check.
Batch merge commits retain each admitted head as a parent. Native GitHub `merged`
readback is recorded separately from main-tip landing; `closed` alone is not merge
proof and no close-PR write substitutes for native MERGED recognition.

Manual fallback restores the saved repository policy, not the batcher's full-Batch
landing requirement. If repository auto-merge remains enabled, an outstanding
native auto-merge request can merge once that restored policy's checks pass,
including during the OFF transition. Such a merge is native GitHub behavior, not
evidence of batcher admission or successful Batch CI. For an end-to-end batcher
proof, enable the request only after stable ON is verified and keep ON throughout
the proof; retain the exact candidate, run/attempt, tested tree and native MERGED
readback separately from any Manual-fallback merge.

### Main-push Batch CI attestation

A landing fast-forwards main to the exact `queue/live/<batchId>` tip that Batch CI
tested, so the push-to-main `ci.yml` run would otherwise re-run the whole suite on
a tree that already passed. Its `Batch CI attestation` job
(`scripts/ci/batch-attestation.ts`) looks for a trusted, completed, successful
latest attempt of `.github/workflows/batch-ci.yml` on a `queue/live/<64-hex>` ref
whose tested commit has exactly the main commit's Git tree. It reuses the
unit-reuse proof machinery and binds the run and attempt, the canonical per-PR
Git manifest (whose `batchId` must name the run's own live ref), the SHA-256
digests of the plan and result archives, and a complete successful Batch result
with every expected shard receipt. It also requires the tested tip to be the main
commit or an ancestor of it, so a tree-preserving refresh landing qualifies. A
batch containing a Version PR (`changeset-release/main`) or a control-plane PR
never attests: a release tip and a CI or batcher definition change keep the full
suite. Both flags are bound into the manifest digest. A
final read rejects an attempt that changed during discovery. The
`Reuse identical-tree Batch CI` step then re-verifies the persisted proof offline
and runs only for a verified proof. `plan` adopts the attested topology only when
the attestation job succeeded with well-formed identities and the tree matches
`GITHUB_SHA^{tree}`. Missing, expired, ambiguous, partial, inconsistent or
unreadable evidence, a proof error, or any other event runs the ordinary full
suite. Discovery never fails the workflow.

On an attested run:

- **Skipped (Batch verdict reused):** `Source and type contracts`, unit shards,
  real-service shards, impacted E2E shards, real-service and recovery tests,
  browser and visual acceptance, package and bundle contracts and the real
  Chromium browser controller.
- **Still run:** `plan` (impact plan and image inputs), `Deployment artifacts`,
  the artifact runtime (including its macOS and Windows native smoke receipts),
  release-image validation, every workload image, `Workload image builds` (and its
  canary image receipt), `Typecheck and unit tests`, `Verify landed merge content`
  and `Publish fully green main SHA`.

`scripts/ci/required-results.jq` has an explicit attested mode. It accepts only
a full-mode main push that builds images, where every skipped lane above is
`skipped` (none partially ran) and deployment, artifact runtime and images
succeeded. The aggregate job names, the `Full CI` commit status and the
`full-green-main-<sha>` receipt (`schemaVersion: 1`, `mode: "full"`) are
unchanged for release candidate selection, publish/canary admission,
Opengeni-ops `Deploy Staging Canary` and ordinary release. The receipt adds an
`attestation` object (Batch run ID, attempt, tested head and tree), and the
status description names the Batch run. The `batch-attestation-<sha>` artifact
keeps the full proof for 30 days.

**Coverage.** This is an explicit coverage reduction for batcher landings. Batch
CI covers impact-selected source contracts and impact-selected unit shards on the
exact tree. It does not cover the full unit inventory, real-service, E2E,
browser, package-contract, publish-closure, SDK-compatibility or example-build
lanes. Those lanes were never landing gates, because the batcher lands on Batch
success whatever main CI reports. They still run in full on direct pushes, the
weekly schedule and the `workflow_dispatch` run of every exact Version PR head
before a release. That dispatch is the release gate: queue-green and attested
main remain non-release evidence.

The merge batcher treats a run as attested only from its complete job listing.
It needs exactly one successful `Batch CI attestation` job whose
`Reuse identical-tree Batch CI` step succeeded, and no skipped-lane job in any
state but `skipped`. An attested run is never pre-fan-out, never counts as queued
main and is never `latestMain`; it has no test fan-out to protect. Its
runner-holding jobs remain `mainDemand` inside the main reserve and the provider
pool, because they really occupy runners. `stage.json` headroom lists them as
`attestedMainRuns`. An attested exact base reports green `source` and `units`
classes for failed-cohort comparison, because the same tree passed both in Batch
CI. Any lane that ran falls back to ordinary job-class evidence.

## Immutable candidates and CI result contract

Version commit subjects retain literal `changeset-release/main` for the existing
non-coalescing main-CI lane. PRs touching `.github/workflows/batch-ci.yml`,
`scripts/ci/batch-*` or `scripts/merge-batcher/**` are also singleton barriers.
The same rule covers `scripts/ci/impact*`, `run-unit-shard*`, `profile-command*`,
`shared-pg*`, `packages/testing/src/shared-pg.ts` and `.bun-version`, including
renamed previous paths.
Review these control-plane changes independently as development work; there is
no special comment phrase or reviewer UUID admission requirement.

Each member is one two-parent merge commit built with `git merge-tree --write-tree`
and `git commit-tree`. Parent 1 is the preceding tested/base tip; parent 2 is the
exact PR head. No checkout or merge-script execution occurs. The commit timestamp
is deterministic from readiness timestamps. Candidate refs are
`<configured-prefix><64-character batchId>` and are create-only. Active defaults
to `queue/live/` and rejects broad `queue/` and `queue/shadow-traffic/`, so the
separate historical diagnostic worker's refs are not ingested as active batches.

Every merge commit carries one canonical `Batch-Manifest` JSON trailer with the
batch specification, member index and SHA-256 batch ID. The specification contains
`schemaVersion: 1`, `baseSha`, ordered exact-head/readiness-bound `pulls`,
`predecessor`, `recoveryOf` and `createdAt`. **Neither `tipSha` nor `mergeSha` is
inside its own hashed trailer.** Inspection derives them from actual commits,
returning at least:

```json
{
  "schemaVersion": 1,
  "baseSha": "<40sha>",
  "tipSha": "<40sha>",
  "batchId": "<64hex>",
  "pulls": [{ "number": 123, "headSha": "<40sha>", "mergeSha": "<40sha>" }]
}
```

The parent supplies `.github/workflows/batch-ci.yml`, triggered by **push to
`queue/**` only**, with aggregate `Batch ready`. The reader binds the workflow
path, push event, exact branch, head SHA, run ID and attempt. It does not use
`Batch ready` alone as proof. The workflow uploads attempt-specific
`batch-result-${runAttempt}` containing one `batch-result.json` (or `result.json`).
Its aggregate identity fields are:

```json
{
  "schemaVersion": 1,
  "batchId": "<64hex>",
  "headSha": "<40sha>",
  "outcome": "success",
  "runId": "123",
  "runAttempt": 1,
  "retryable": false,
  "reason": "All selected checks passed",
  "expectedJobs": ["plan", "source"],
  "jobs": { "plan": "success", "source": "success", "units": "skipped" },
  "tasks": ["<complete plan receipt>", "<complete source receipt>"]
}
```

`outcome` is `success`, `code_failure`, `infrastructure` or `cancelled`.
The `tasks` placeholders must be replaced by objects, not strings. Every receipt
has schemaVersion, batchId, headSha, **string** runId, numeric runAttempt, job,
exitCode, outcome, retryable, startedAt and finishedAt. Expected jobs are `plan`,
`source`, then contiguous `unit-0` through `unit-N` (at most 16 shards).
Generic `batch-result` artifacts and numeric runId payloads are not this contract.
Every task identity, duplicate/missing job, timestamp and process-exit
classification is independently reverified. A verified red may coexist with
missing/infrastructure siblings, but partial evidence never becomes green.
Cancellation wins over code failure.
Success additionally needs the matching workflow run conclusion `success`;
code failure needs `failure`. Missing/expired/ambiguous/malformed artifacts,
wrong attempts/branches/workflows and other conclusions are unknown, never
evidence against a PR. Archive reading is bounded and never extracts paths.

Only the candidate's own first completed
Batch CI attempt with exact-attempt evidence classified as trusted code failure,
verified infrastructure failure, provider cancellation, no-job-logs, or positive
failed/timed-out job evidence may request one
whole-workflow retry; main, Version and release runs are excluded. The exact
run/attempt, request time and reason are durably recorded in Git and stage evidence.
Ambiguous or partial receipts hold rather than authorize a retry or blame a PR.
A trusted failed candidate waits for a conclusive exact-base comparison before
retry, splitting or parking. A complete verified Batch receipt identifies its
failed classes: `source` maps only to main's `Source and type contracts`, and
`unit-*` maps to the complete main `Unit tests (shard N/M)` set. A red or unknown
relevant class holds; an unrelated browser/image/release failure does not hold
when every relevant class is conclusively green. A still-running or approval-waiting
exact-base workflow may supply completed relevant job classes; unrelated image,
browser or release work need not finish first. This is `classes` evidence, not a
full-green workflow receipt. The reader traverses complete attempt-scoped job pages,
checks totals and duplicate/run/attempt identities, and rereads the latest run/attempt
before accepting those classes. Pending relevant jobs, unknown/error evidence,
missing failure classes, duplicate jobs and incomplete shard sets do not release
the hold. A verified full-green base also clears it. A Batch-attested exact base
reports green `source` and `units` classes from its identical-tree Batch verdict.
This is class relevance,
not a same-assertion fingerprint proof, requeue operation or green-test waiver.
Otherwise a trusted second code failure splits the cohort or parks a failing singleton;
a second infrastructure or unknown outcome holds. Invalidated, landed or obsolete-base
candidates cannot submit pending retries: the candidate must still be rooted in
current main or an exact live predecessor chain, checked before and after the
durable submission claim. An unknown POST outcome remains reconciliation-only,
never a blind replay; these observations do not make GitHub REST atomic with Git.

## State machine and recovery

The planner constructs speculative successors on the exact predecessor tip.
`BATCHER_MAX_INFLIGHT` bounds both planner reservations and the complete provider
inventory check before publication or the existing single trusted retry. The
default remains one hosted run; a qualified configuration of two permits a
successor to run while its predecessor is tested. `BATCHER_SPECULATION_DEPTH`
bounds the chain, including local unpublished candidates. Missing publication
outcomes retain their reservation; foreign, invalidated and waiting Batch runs
still consume provider slots. No running CI is cancelled. Only a tested root
whose base is current main may land, with exact tree/provenance/CAS checks;
landing consumes no additional hosted slot and does not wait for successor CI.
At publication/retry, the slot budget is the union of exact published-candidate
reservations and current provider runs, not two independent limits. A matching
visible push run is counted once; missing, mismatched or unresolved histories
remain reservations. Historical reads reuse conservative cached observations;
the normal bounded historical refresh retires those reservations only on evidence.
Final slot contention defers publication without a Git transaction or an unsafe
write-outcome classification.

Slot one treats valid capacity estimates as informational so recovery cannot
deadlock behind main demand. Additional speculative slots require a clear
capacity decision, including no queued or pre-fan-out main work. Complete
provider occupancy and unseen reservations reach the planner before building;
landing and bookkeeping remain independent of that publication-only gate.
Each occupied Batch reserves at least 18 jobs even before its fan-out is
visible; larger observed demand is retained, and unseen reservations also
reserve 18. Local speculative builds still run for early conflict detection,
but publication waits for both slot and capacity headroom. With the documented
52-job repository budget, 30-job main reserve and 60-job provider limit/28-job
foreign allowance, a second slot cannot fit even when main is currently idle.
Increasing cap to 8 with one slot is therefore the first deployment step;
additional slots require a genuinely larger available runner allocation.
Every landing starts a main workflow: the measured baseline is about 57 jobs
and 370 job-minutes on main, in addition to 149 Batch job-minutes. With a
60-job ceiling and 28-job foreign allowance, 1,920 available job-minutes/hour
supports about 3.70 batches/hour, or 29.6 PR/hour at full cap 8 (about 710/day).
This saturated model excludes failures, partial batches and downtime; two
slots alone do not increase that runner-budget ceiling. Main complete-unit
reuse, if independently qualified, would lower the modeled combined cost
from 519 to 369 job-minutes, not make runner capacity unlimited.
Main-push Batch CI attestation removes the attested landing's test lanes. Its
remaining artifact, image and receipt jobs are not re-measured here, so the
modeled main cost above is an upper bound for batcher landings.
Failed or changed predecessors invalidate descendants without cancelling their
runs. Version/control-plane barriers and sequential bisection remain unchanged.
Full-main capacity estimates remain observable rather than reserving runners.
Before publication, the existing single trusted retry, and landing, the reader scans current
repository runs and their latest jobs (100 entries per page, paginated through
the reported total; incomplete observations hold). Each of the five active run statuses
is listed twice, so a run whose status changes once during the listing (in either
direction, for example `in_progress` to `waiting` while other jobs still run) is
still listed; the latest active listing is used, and a run listed as `completed`
is skipped. Two passes do not rule out more changes during the listing or
provider snapshot lag or same-total substitutions. GitHub's status-filtered
listing can itself cap accessible results at 1000; an inaccessible remainder
holds as incomplete, so pagination does not promise unlimited inventory.
Every distinct relevant active run's complete latest-job
inventory is then read using at most four concurrent read workers. Pages within
each run remain sequential; results are reduced in the observed run order only
after the reads settle. API errors cannot admit partial evidence. This bounds
request concurrency, not inventory size or provider latency. There are no 64-run
or 32-run admission limits. A
120-second scan deadline is checked before each request and after the last
response; an overrun or provider error holds. Each listing requires a stable
reported total, correctly sized pages and unique identities across pages;
inconsistent pages and run identity drift hold rather than admitting partial
demand. A run is **approval-only** only when
the following complete-job proof establishes it. The live reader may reuse that
proof for at most 15 minutes only for main push CI whose sole waiting job is
`Build API workload image` and whose other jobs are completed or pending
descendants. Reuse requires matching run ID, attempt, head, workflow, branch and
provider update timestamp, with `waiting` in both current status passes. Any
observed status or timestamp transition, malformed/missing/expired cache, or
different approval gate requires fresh complete job pages. Active Batch detection
always precedes this optimization, including waiting Batch runs. A cold cache
also requires full verification. `cachedApprovalOnlyRuns` reports reused verified
zero-demand observations and is absent for incomplete scans; this does not claim
an atomic provider snapshot or rule out provider lag/changes after observation.
Without reusable proof, a run is approval-only only when
every listing in the observation reports the run as `waiting` and its complete
job page has at least one `waiting` job and otherwise only `pending` or
`completed` jobs. Such
runs have zero runner demand. Every other relevant run, including waiting runs
with any `queued`, `in_progress` or `requested` job and waiting runs without jobs,
remains in the observation. Demand counts runner-holding jobs: `queued`,
`in_progress` and `requested` (created but not yet queued; counted
conservatively). Jobs waiting for environment approval (`waiting`) or a job
concurrency group (`pending`), completed jobs, and runs without materialized jobs
(for example a run held by its concurrency group) are not demand; a run is a
placeholder, not a runner. Required
capacity is other job demand plus the larger of configured main reserve and
observed main demand, plus **18 candidate slots**. Extra speculative slots proceed
only when that fits BATCHER_RUNNER_BUDGET and the configured hosted slot budget
has room. The first slot keeps valid capacity observations advisory. Missing
budget/reserve or any unrecognized or missing job status holds
rather than inventing capacity. Waiting, pending and job-less runs can start
requesting runners after observation.

PR CI uses per-PR concurrency with cancellation enabled: a newer run supersedes
the same PR, not an unrelated PR, main or Batch run. Explicit dispatch uses its
PR-number input for the same group. Planning, one fast-check job and the final
aggregate run sequentially; the fast-check job has a hard 15-minute timeout and
covers lint, impacted types and at most
40 unit files from directly touched workspace packages, not transitive dependents.
Changed unit files are prioritized, then paths are ordered deterministically.
Broad workflow/root/toolchain impact explicitly selects no admission units and
defers full coverage to Batch CI. Release-note `.changeset/` files alone do not
trigger this deferral: the selector re-plans without them to confirm no other
broad fence is hidden, then selects the capped direct-package units. The original
impact planner and Batch plan remain unchanged. The retained PR plan records the selection
reason and original, direct, selected and deferred counts; intentional deferral
is not a claim that those tests passed. All selected tests must execute successfully
for the fast job and required aggregate to pass. A failed selected test is never
converted into an intentional skip. Type selection is unchanged. Full guards
and the full suite remain in Batch CI, whose impact plan is not capped.

PR CI has no priority wait: no provider demand read can hold or fail PR
admission. Only Version validation (`ci.yml` `automation-admission`) still runs
the bounded `github-pr-ci.ts priority pr` yield, so only that job keeps the
320-minute timeout exemption. The yield holds for queued or running main push CI
and Batch CI. A waiting run whose jobs are only completed or waiting for
approval does not hold it. Main push CI whose sole waiting job is
`Build API workload image` (public-release approval), with every other job
completed or `pending` and unique positive job IDs, also has zero runner demand.
This relies on the current `ci.yml` job order: when the approval waits, every
job not downstream of it already has its prerequisites completed, so it is
queued, running or finished (never `pending`); a queued or running job holds.
The yield never approves or cancels that release. Batch runs get no such
exemption.

Batch CI does not wait inside its planning job for main CI demand to clear. After
checkout and Bun setup it verifies the immutable candidate and plans the complete
combined tree, with a 20-minute planning-job timeout. GitHub schedules the resulting
jobs; this is not a fairness or capacity guarantee. Full tests, previous-binary
readiness, exact-attempt provenance and the final Batch ready gate are unchanged.
Already-created runs retain their original workflow: the controller's single
infrastructure retry reruns the same immutable candidate, not a new tree containing
a later workflow fix.

There is no global PR admission lock, permit system or synthetic runner reserve.
GitHub queues bursts under its hosted capacity limits. Keep the fast gate small;
add a global cap only if measured main/Batch starvation justifies it. The live
Batch policy below also delegates runner scheduling to GitHub. Already-created runs retain their scheduled
definition, so backlog recovery must use current exact-head checks, not a false
success or blanket cancellation of main, Batch, Version or unrelated work.

The following capacity observations remain visible but are **informational for
live Batch submission, the existing single trusted retry, and landing**. After a
complete valid inventory with a free configured Batch slot, one ready candidate
may enter GitHub's queue; a tested candidate need not wait for main capacity to
land. `capacityInformational`
marks this policy; `capacity.hold` retains the historical capacity heuristic for
diagnostics, not an admission rejection. Invalid capacity configuration and
incomplete/unknown evidence still hold. Traffic-shadow capacity comparisons
retain their existing conservative decisions.

The exact tested tree, lease/CAS, provenance, configured in-flight limit and unknown-outcome
checks still apply to those actions. Historical latency credit for a blocked
main-capacity wait no longer accrues when capacity is informational; latency
comparisons across this policy change are therefore not like-for-like.

- **Main before fan-out.** `ci.yml` first creates only automation-admission,
  batch-attestation, merge-content and plan; every other job needs plan and
  appears together (measured before batch-attestation existed: about 77–92
  seconds later), as a fan-out of up to 46 runner-holding jobs.
  An active full-main push run whose complete job list has at most those 4 jobs
  (any status, including a just-pushed run without jobs or a run held by its
  concurrency group) is pre-fan-out: its observed demand understates what it is
  about to request; this is reported without withholding a ready candidate.
  A drained run still lists its completed fan-out jobs, so it is not pre-fan-out.
  A run proven approval-only (an old rerun waiting for environment approval) is
  idle; once approved, a later observation sees its demand. A job-less waiting
  or pending main run is reported as pre-fan-out. A test checks the 4-job constant
  against `ci.yml`. A Batch-attested run (see "Main-push Batch CI attestation") is
  never pre-fan-out once its attestation step has succeeded: it has no test fan-out.
- **Main jobs waiting for runners.** If any active full-main push CI run, newest
  or an older rerun, has a `queued` or `requested` job, its count and oldest wait
  are retained. Main CI itself is never gated or cancelled. Batch-attested runs
  are excluded: their artifact and image jobs may wait without holding a candidate.
- **Provider pool fit.** Observed repository demand (main + other) plus
  `BATCHER_OTHER_REPOSITORY_ALLOWANCE` plus the 18 candidate slots is compared with
  `BATCHER_PROVIDER_JOB_LIMIT`. With the defaults, 60 - 28 - 18 = 14 observed
  repository jobs at most. Combined with 52/30/18 (other + max(30, main) + 18 <= 52,
  so other <= 4 while main <= 30), the historical estimate fits at other <= 4 and
  main + other <= 14. Exceeding these estimates no longer withholds live submission.

The per-PR fast workflow does not impose a global PR concurrency cap. Live Batch
admission excludes exact `pr-ci.yml` pull-request and workflow-dispatch runs from
PR demand, including legacy definitions, so five or more PR jobs do not withhold
submission. Non-PR demand remains measured and completeness safeguards still
apply. GitHub queues submitted work when provider capacity is busy; neither
capacity nor fairness is guaranteed. Preserve the configured max-inflight bound, exact tree/provenance,
CAS and unknown-effect holds. Measure actual Batch wait from run creation to the
first runner job start, separately from CI execution and landing; do not report
submission as execution or a landing.

The batcher's App is installed only on this repository, so it cannot read other
repositories' jobs and does not try. The allowance replaces that observation. It is
the maximum of one measured window (October 22, 2026, 02:00–08:40 UTC, every
organization repository pushed since October 21, 10-second samples: other-repository
runner-holding jobs p50 1, p95 10, p99 18, maximum 28, from cua 21 plus cloudgeni 7).
It is an assumption, not an observation: a larger burst elsewhere can still queue
jobs. The same window showed the org pool peaking at exactly 60 runner-holding jobs,
with multi-minute runner waits for CI jobs created while 40–59 runners were busy.
No reservation here can guarantee main CI never queues behind a running candidate:
one full main fan-out holds up to 46 jobs and a candidate up to 17, so a main landing
that starts after admission can exceed 60. The pre-fan-out and main-queued holds stop
a new candidate from adding to main's demand once a main run is observed; they do
not preempt a running candidate. Invalid limit or
allowance values reject configuration; allowance plus 18 above the limit never admits.

The live batcher excludes every `.github/workflows/pr-ci.yml` run triggered
by `pull_request` or `workflow_dispatch` from this demand and scan-slot accounting,
regardless of its definition, including older legacy runs and heavier PR or
dispatch-ref workflow edits. These bursts are queued by GitHub rather than withholding a ready Batch
solely because PR jobs occupy runners. This is not a provider capacity guarantee:
the Batch may wait for runners. Active Batch reservations, complete-inventory
checks, unknown workflow/status handling and non-PR/main capacity holds remain.
The traffic-shadow reader keeps its original all-workflow accounting. Observe
actual run/job creation and start timestamps to measure provider queue delay.

`stage.json` headroom now also records `capacity`: the configured limit and
allowance, `providerRequired`, the hold reason, `mainQueuedJobs` (queued or
requested jobs across all active main runs), `preFanoutMainRuns` (their run IDs),
`attestedMainRuns` (top-level headroom: active Batch-attested main runs, excluded
from both),
and `latestMain` (newest main run ID, jobs
waiting for runners, oldest current queue age, and the largest `started_at -
created_at` among started jobs, all measured from the job timestamps). These are
measured main queue waits, not predicted candidate latency.
stage.json exposes the measured occupied/reserved slots, configured budget and
decision. These are explicit repository allocations, not a claim that GitHub
granted a custom quota or that other repositories are idle. Jobs can expand or
external runs can start after observation; this is conservative admission from
observed demand, not an atomic GitHub scheduler or cancellation mechanism.
Invalidated descendants still occupy CI slots while running: no cancellation
operation exists in the adapter.

The required batch suite is the current plan/source/impact-selected unit/Batch
ready subset on the exact stacked candidate tree. Its trusted, completed, latest
run-attempt success permits landing even when full-main CI is red, missing,
running, cancelled or unknown. This is not full-CI equivalence or release evidence.
Full main CI remains an independent post-merge backstop. Capacity admission still
respects observed main runner demand; main advancing still invalidates obsolete
candidates and requires a new exact-tree test. Legacy `baseHold` records remain
audit history, not green-candidate admission gates.

A trusted candidate code failure is **not** proof that a member caused it. Until
the separate producer/consumer contract supplies comparable same-job base batch-suite
evidence, a failed candidate with red or unknown relevant exact-base classes stays held.
This observation is requested only for a terminal trusted failed root; ordinary
building and tested-green landing remain independent of main CI availability.
The hold can stall other ready work while that failed root remains live. It ends
when the latest exact-base comparison becomes conclusively green for the failed
classes, main advances (normal obsolete-candidate invalidation), or readiness is
withdrawn (normal binding invalidation). This patch adds no timer, regrouping,
label mutation or operator override. Unknown evidence during a base rerun or API
failure never releases the cohort into durable splitting/parking. Independent
admission backpressure, including latency policy, still applies to those exits.
Other failed cohorts split sequentially and failed singleton heads are durably
parked, never blamed or ejected. Each parking record binds the PR head, tested base,
batch, original cohort, run and attempt, with a durable non-blaming PR comment.
Other ready heads proceed. Label churn and main advancement do not retry a
parked head; a changed head or explicit native auto-merge enable may re-enter. Historical parking evidence
is retained. Legacy bisection groups use the same parking policy; pending legacy
code-blame comments remain held. No base-only workflow is invoked.

The requested all-singletons-same-way suspected-base landing hold is **not yet
supported**: existing trusted receipts bind task exit outcomes, not assertion-level
failure fingerprints. Matching job names, exit codes or free-text reasons cannot
establish the same failure. No attribution or landing hold is fabricated from them.
Failed speculative descendants may be invalidated, but running CI is never cancelled.
Main advancement or readiness changes still invalidate unparked candidates normally.
Marked-ready PRs with a confirmed exact-head conflict against main receive an
actionable comment even when fast checks have not passed. Unknown mergeability
does not imply conflict. Main and predecessor-conflict notices share the durable
comment-effect key for that PR head, so readiness toggles or controller restarts
do not repeat the notice; a new conflicting head can receive a new notice.
Merge-tree conflicts retain their distinct
conflict reason and comment path, not a fabricated CI failure. Legacy receipt
`retryable` flags do not override the controller's single exact-attempt retry policy.

Infrastructure/cancelled/unknown attempts never incriminate PRs. Eligible exact-attempt
evidence (trusted code failure, verified infrastructure failure, provider cancellation,
no-job-logs, or positive failed/timed-out job evidence) waits at least 60 seconds and for admission headroom
before the single allowed retry; unknown evidence cannot request it. Retry intent
is durable before effect submission. An uncertain effect uses bounded, backed-off
provider observations, not additional CI attempts, and is never blindly replayed
after restart. No running job is cancelled.
Exit 75 (setup), 124/126/127, negative exits and OOM/signal exits are
infrastructure; 130/143 are cancellation. Missing plan/batch identity or missing
or unverifiable result receipts are infrastructure, never code-red evidence.

Before landing, the controller inspects the exact tested commit, verifies
fast-forward ancestry separately, re-observes heads/readiness/evidence/run state,
then atomically advances the durable lease with main's ref update. PR metadata
is not part of GitHub's atomic transaction. Main moves to the **already-tested tip**, never a
freshly rebuilt commit after testing. Git uses
`--force-with-lease=<state-ref>:<expected>` on the changing state ref. Candidate
creation additionally uses `--force-with-lease=<candidate-ref>:` with an empty
expected value: this is an absence predicate, rejecting even an existing ancestor
ref rather than permitting a candidate rewrite.
Main uses ordinary FF-only semantics plus a separate local ancestry assertion:
no main-specific force-with-lease, `--force` or `+main`. A main-specific lease
would authorize non-FF on an unprotected server and is deliberately absent.
The explicit pre-push read catches observed base races, but ordinary FF push
does not independently assert original-base equality: an advance to another
ancestor of the tested tip may still be accepted. Receive-pack checks its
advertised old main value atomically with the changing lease.
It also checks snapshots explicitly because Git omits already-up-to-date refs
before wire-level lease checks. The lease ref must change in every transaction.
Each state commit also carries a fresh Transaction-ID nonce, so the same owner,
ledger and clock tick cannot generate identical next-state OIDs. This prevents
Git's already-up-to-date omission from reporting two successful concurrent CAS
writes. CLI owners remain unique per process; candidate commits stay deterministic.
Expiry is a client takeover policy; stale owners are fenced by a changed remote
lease generation, not wall-clock expiry alone.

Durable state is an ordinary Git commit tree containing `state.json`, reachable
from `refs/heads/batcher-state`. It stores owner/epoch/expiry, landed/invalidated
batches, exact-head ejections, recovery groups, trusted failure receipts and retry intents. Its first-parent
history advances; every publication/landing advances it atomically. Queue commit
trailers and provider run/attempt artifacts supply reconstruction evidence.
Deletion of state/queue refs or artifact history by another principal is not a
supported recovery strategy. Never prune them before preserving the history
needed to distinguish landed, invalidated, failed and still-running batches.
State retention/compaction is an operator-owned future extension; no automatic
remote ref deletion is performed by this implementation.

### Recoverable REST effects

Comment, whole-run retry and follow-up PR intents live in `state.json`, with deterministic
IDs, comment markers, exact run/attempt identity, attempts and next-check times.
An intent is durably marked `submitting` before POST; a final lease read reduces
stale-owner races but is **not** an atomic Git/REST fence. Restart reconciliation
checks the comment/PR marker, exact source PR or advanced attempt before any submission. Accepted
requests with lost responses are completed from provider evidence. An ambiguous
POST (including a crash between durable claim and POST) is never blindly retried.
It receives bounded read-only reconciliation, then becomes visibly `blocked`.
Definitive permission/validation rejection blocks immediately; throttling backs
off with a five-submission budget. Uncertain observation has an eight-check budget.
Blocked effects do not falsely mark an ejection announced or starve unrelated
queue work. All state is rebuildable from Git, not a local-only outbox.

After investigating a blocked/uncertain effect and confirming it was not applied,
an operator can explicitly reset only that effect using the observed state SHA:

```sh
BATCHER_MODE=active bun scripts/merge-batcher/main.ts recover-effect \
  --effect-id "$EFFECT_ID" --state-sha "$OBSERVED_STATE_SHA" --confirm-not-applied
```

Recovery refuses a changed state or another live owner's lease and checks the
provider again: if already applied it marks done rather than resubmitting.
It is a write operation, not permitted during the current local-only task.
Exactly-once arbitrary REST effects are not promised: external marker deletion,
manual reruns, or operator recovery based on incomplete evidence remain provider/
operator limitations. Git landing itself remains atomic and restart-reconcilable.

## Shadow evidence and operations

### Bounded observation and measured stages

Validated immutable manifests are cached by tip SHA. Verified completed results
are cached by tip/batch/run/attempt; current run metadata is still reread before
active landing/retry, so a rerun invalidates earlier green. Historical terminal
and empty run histories and baseline main outcomes are sampled at most once per
15 minutes. Landed/invalidated refs share an eight-ref-per-observation rotating
scan budget, with a persisted cursor; current candidates are observed separately.
Deferred observations retain cached runs, including queued/running reservations;
an unknown history stays unknown and reserves capacity unless explicitly released.
This bounds historical request fan-out without redownloading completed artifacts
each poll; it is not instantaneous detection of external/manual historical reruns.
Cache files are disposable and capped at 4,096 entries. Rate-limit headers defer
HTTP reads, while service failures back off exponentially to 3,600 seconds.
Malformed/unowned queue refs appear in observationWarnings and are excluded,
rather than making unrelated candidates unobservable.

The namespace-specific observations journal retains measured ready, build,
publication, provider CI-start/end and landing stages (up to 4,096 batches and
48 hours of observations). Build time is actual local instrumentation, **not**
the deterministic manifest.createdAt. Publication/landing records in Git state
use the successful atomic transaction's invocation timestamp; they are not an
exact server-side receipt time. Failed transactions do not invent these events.
Reconstructed main ancestry proves containment, not a historical landing time;
unmeasured stages remain null. Active writes checkpoint samples and missing-run
state in the durable Git ledger. Shadow-ci includes them in its next publication;
strict read-only shadow only retains local evidence and never writes remote state.

Telemetry reports the nearest-rank rolling two-hour p95 from each exact
head/ready-event's **first measured provider CI start**, deduplicating reruns and
bisection candidates. More than 1,800 seconds retains the legacy `stop` signal
as an informational alert only. It does not veto build, publication, invalidation,
dequeue, retry, split, parking or landing, including shadow publication and already
durable retry intents. Valid numeric capacity and main-demand estimates are also
informational. Complete evidence, active Batch/max-inflight limits, exact tested
tree, lease/CAS, provenance and unknown-outcome safeguards still block unsafe
actions. A completed eligible first attempt may request its single retry without
an additional initial elapsed-time wait; provider-error backoff and reconciliation
of uncertain submissions remain unchanged. No queue fairness or hard capacity
guarantee follows from this policy. The window is based on the first CI
start; an aged-out sample is unknown, not newly healthy. Historical stage data is
retained, not reset. stage.json reports raw and capacity/OFF-adjusted p95, windowSeconds,
sample count, coverageSince and completeWindow alongside the signal. This is a
sample of heads that reached CI, not a latency claim for unknown/unstarted work
or a completeness claim about all historical PRs. Small/partial samples are
explicit; missing history is unknown, never reset to healthy. Restart reloads the
retained journal or Git samples; cache loss cannot fabricate historical timings.
Observation gaps reset coverageSince rather than turning elapsed downtime into
a complete window; retained real latency samples can still trigger the stop signal.
Only bounded observed main-capacity holds are deducted. Both consecutive complete
observations must show main demand alone preventing admission, the same main run
and capacity configuration, and the same ready binding; the gap may not exceed
five minutes. The normal planner must also select that head for publication with
only the main-capacity gate removed; occupied batch slots, conflicts or other
admission holds do not earn credit. The intervals describe controller backpressure, not provider queue
time or proof of uninterrupted provider activity. Overlaps are unioned and clipped
to readiness through the first CI start. Unknown scans, changed bindings, other-work
capacity, and long observation gaps receive no credit. Credits persist with stage
samples; old samples without credits remain raw. There is no historical backfill
or hand-edited ledger recovery. The current slow sample therefore remains a hold
until it leaves the recent window unless genuine recorded credits already exist.
Use separate writable output directories for replicas; remote Git, not the local
journal, fences their mutations. External historical reruns can be observed after
the 15-minute cache window plus a rotating scan cycle (ceil(historical refs / 8)
polls); provider backoff adds delay. They may overlap independently started work.

### Missing workflow admission

A published candidate with no exact workflow initially reserves the hosted slot.
Head/evidence invalidation and abandonment do not release that reservation;
only terminal workflow evidence or explicit infrastructure recovery does.
This also applies to candidates already contained in main when retained provider
run history becomes unavailable (for example, after cache loss). Their missing-run
record is marked `historical-run-history` and ages from first observation of that
gap, not an old publication time. Main containment is not proof that CI is idle.
After BATCHER_MISSING_RUN_SECONDS from known publication or first observation it
becomes an **abandoned infrastructure hold**, not a PR failure or code-red retry.
The hold is persisted and visible, with explicit recovery instead of an opaque
permanent wait. After fixing workflow admission and confirming that this candidate
has no queued/running workflow that can start later, release its slot:

```sh
# Use the intended mode and namespace. Active additionally requires --state-sha.
bun scripts/merge-batcher/main.ts recover-missing-run \
  --batch-id "$BATCH_ID" --confirm-no-run
```

Active recovery CAS-updates the Git ledger under the lease and rereads provider
runs. Shadow recovery also bypasses cached run observations, but updates only its
local journal. Provider read failures or any observed run refuse recovery. The
release receipt records explicit no-run confirmation, timestamp, exact tip SHA,
previous state SHA, and (for active mode) the recovering controller identity; the
Git state commit history retains the active audit. This is not a verified human
identity or proof that GitHub cannot deliver a run after the read. No mode deletes
the candidate ref, cancels CI, comments blame or changes readiness. The exact
released snapshot is not automatically republished; a changed head/new ready
event can return. A late run is still observed and consumes capacity. GitHub
cannot prove that an absent run will never appear, so release is an explicit
operator decision, not an automatic unsafe inference from missing metadata.

### Shadow with real CI, never landing

`shadow-ci` uses a separate controller and a `QueueOnlyPublisher` that can express
only a create-only candidate plus a changing dedicated state ref. It cannot
express main updates, PR comments/ejections/labels/readiness, deletion or REST
reruns. It admits at most one controller-generated hosted candidate, regardless
of a larger configured max-inflight; published-but-not-started and stale running
candidates still occupy that slot. Concurrent controllers atomically compete
on the state ref. Uncoordinated external publishers/manual reruns are outside
this rate-limit guarantee: protect the writer namespace.

Set `BATCHER_SHADOW_CI_STATE_REF` to `refs/heads/batcher-shadow-ci-state` explicitly.
This is routine controller-state configuration within authorized CI-shadow work,
not an additional approval ceremony. Without the explicit configuration the
mode fails before authentication/writes. Keeping lease commits
outside `queue/**` avoids spurious second CI runs. Neither read-only shadow nor
this implementation task creates that control ref.

The same exact candidate is not automatically republished/rerun after completion.
New eligible snapshots can publish after a fresh head/evidence/base check and
atomic state update. `stage.json` compares candidate verdicts/timings with
main-CI runs on the exact original base SHA. These are baseline comparisons,
not equivalent-tree claims: shadow candidates contain unlanded PR heads.
Missing results remain observable infrastructure, never ejection/comment effects.
Both shadow modes catch merge conflicts, retain local exclusions keyed by exact
head and ready event, and rebuild the viable remainder. Restart reloads these
exclusions; a new head or ready event can return. Neither mode publishes ejection
comments or changes PR readiness. A lost disposable journal may require repeating
the local conflict calculation, but cannot mutate a PR or claim code-red CI.

### Strictly read-only shadow

`shadow --once` performs only reads plus local Git object construction. It never
instantiates the write executor, and even an accidentally supplied executor is
not called in shadow. It writes `stage.json` with readiness exclusions, observed
candidate outcomes, proposed action and capability limitations, and an individual
manifest file for each built candidate. Local-only `refs/batcher-local/*` pin
constructed objects. It does not synthesize eligibility when the live queue is
empty; that is a legitimate, observable no-candidate result. Existing real
candidate runs are compared using the same strict artifact binding as active.

`/healthz` reports process liveness; `/readyz` requires a recent successful complete
observation. A shadow process can be ready without having any eligible PR.
SIGTERM/SIGINT stop new polls, finish the current bounded observation, wake an idle
poll immediately and close the server. No CI cancellation occurs on shutdown.
HTTP calls have 30-second bounds. Git fetch has a separately configurable
600-second default for cold histories; other Git subprocesses have a 60-second bound.
Operators should allow termination grace for the current observation; forced
termination loses only local cache/proposed shadow evidence, not remote truth.

The disposable Git store fetches exact observed SHAs with no tags and retains
commit/tree history (not shallow history). One persistent primary source uses
`blob:none`; a distinct source, such as a fork, uses a complete exact-head
`--refetch --no-filter` fallback. This avoids mixed-source missing-blob requests
that neither promisor can satisfy. It deliberately gives up blobless savings for
fork fetches. A provider that ignores filtering may send full objects instead.
Merge content is retrieved lazily with the same authentication environment;
canonical merge-tree reconstruction and parent/provenance checks are unchanged.

Successful fetches retire surplus numbered local negotiation slots only; an
empty complete readiness result clears the candidate slots. Failed fetches keep
the old slots. Serialized active maintenance, at most once per hour including
process restarts, retires only local constructed pins for landed or parked
batches. Unreleased missing-run evidence (including abandoned runs), recovery
cohorts, unresolved native landings and unfinished/blocked rerun effects retain
their batch's constructed pins; unrelated terminal pins may retire. Rerun batch
identity comes from its retained run branch. Effects without a provable batch
identity still hold all maintenance rather than guessing. Other local refs,
remote refs, durable ledger, manifest JSON and operator/failure evidence are never
deleted. Foreground GC keeps Git's two-week grace period, disables partial-pack
bitmaps, and uses the ordinary subprocess timeout. Local maintenance failure is
reported and deferred, not treated as an ambiguous remote write. These rules are
not a lifetime disk bound: retained history, unresolved evidence and forks can
grow storage; operators still monitor actual volume usage.

Portable placement options, without deployment by this task:

- GCP VM: run the container under a service supervisor with `/data` on a writable
  persistent volume (or discard it and refetch), runtime secrets, liveness and
  readiness probes, and restart-on-failure.
- Cloud Run: a continuously polling service needs minimum instances 1 and CPU
  always allocated / instance-based billing, not request-only CPU. Use the
  platform `PORT`, sufficient ephemeral object-store capacity and termination
  grace. A single configured replica is still not a leadership fence during
  replacement or overlap.
- Azure: a VM/container service or Azure Container Apps with minimum replicas 1,
  continuous background CPU, runtime secrets and equivalent probes. Keep the
  same Git-backed state protocol; do not introduce Azure-only state authority.

With exclusive main policy enabled, changing `BATCHER_MODE=shadow` or stopping a
service alone is **not** complete rollback: it leaves normal manual merges blocked.
Use the administration bundle's reviewed one-command OFF, which first proves
runtime STOP and then restores the exact original policy and emits a verified
manual-mode receipt. Unknown or forced STOP and unresolved REST outcomes remain
explicit holds. Default configuration is still shadow; optional shadow image/
credential restoration and restart are separately owned deployment actions after
the active writer is proven stopped. Leave running CI untouched, retain state/
queue/result evidence, and inspect main's exact landed SHA. Do not delete refs,
force-reset main or rotate credentials.

Full VM/monorepo testing and exact-head independent review remain appropriate
development validation for the batcher, not comment-based intake gates. Focused core
tests do not replace that parent-owned admission requirement.
