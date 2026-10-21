# Portable merge batcher

This is the in-house batcher core. It uses Bun 1.4.3, built-in APIs and
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

The accepted GitHub contract is **only the exact tested snapshot lands**, not
“no PR head can change after the final HTTP read.” The adapter rechecks every
head/readiness/evidence binding, source branch head, exact workflow result and
main-CI headroom immediately before its atomic Git transaction. A last-moment
PR update remains possible; no local lock or single replica eliminates it.

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
their **own** exact-head VM/review evidence, and the next merge against main
contains only the remaining delta. Old evidence is never inherited. Divergent
history is held with a rebase explanation. The adapter never closes/reopens PRs.
**GitHub may auto-close a PR when its old head reaches main, before a newer push
is observed.** For an original marked merged and associated with the batcher's
landed snapshot, the adapter durably creates or reuses a follow-up PR on the exact
observed source repository/branch. It never does this for an externally closed,
unmerged PR. New work must retain landed ancestry and still needs normal fresh
exact-head VM/review evidence and readiness; neither is fabricated or copied.
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

An open, non-draft PR needs auto-merge enabled **or** `queue-ready`, plus a
repository collaborator's human-readable evidence comment identifying:

- The full exact PR head SHA.
- VM/virtual-machine/Connected Machine test commands/results with a successful
  test/suite/typecheck result.
- Independent agent review and a reviewer session UUID.

For example: `Exact head <40sha>. VM tests passed: bun test …; typecheck passed.
Independent agent review passed, reviewer session <uuid>. Limitations: …`.
Recognition is deliberately prose-tolerant; it is an attestation, not a formal
GitHub approval requirement or an independent proof that commands ran. It
rejects missing/malformed/oversized/untrusted comments and explicit pending or
failed evidence, recording a human-readable exclusion reason. Instructions in
comments are never evaluated. Evidence author association, body and update time
are hashed into the exact readiness binding; an edit invalidates an old batch.
The newest collaborator comment naming the exact head decides (ordered by update
time, not list position). A newer failing or incomplete statement revokes an
older pass; the reader does not search backward for more convenient evidence.
The batcher's own marked landing/ejection/reconciliation receipts are bookkeeping,
not VM/review attestations; they neither satisfy nor revoke the human evidence.

FIFO uses actual GraphQL ready timeline events, never PR creation time or the
time a controller first saw it. Turning readiness off then on creates a new
event. When both signals are active the earliest still-active signal wins.
Missing/partial event history prevents admission with an explicit reason.
`changeset-release/main` is a barrier: earlier PRs batch first, Version is a
singleton, and later work does not speculate across it.

Auto-merge is only an admission signal. Before enabling a real writer, protections
must prevent native/direct auto-merge from bypassing this batcher. Prefer the
label during rollout if auto-merge cannot safely remain enabled. Only the
authorized batcher principal may update queue/state refs; PR authors must not
be able to forge those refs or the trusted candidate workflow/result artifact.
The batch CI workflow must be trusted policy, not replaced by PR-controlled
workflow changes. The parent owns that workflow/ruleset enforcement.

## Immutable candidates and CI result contract

Version commit subjects retain literal `changeset-release/main` for the existing
non-coalescing main-CI lane. PRs touching `.github/workflows/batch-ci.yml`,
`scripts/ci/batch-*` or `scripts/merge-batcher/**` are also singleton barriers.
The same rule covers `scripts/ci/impact*`, `run-unit-shard*`, `profile-command*`,
`shared-pg*`, `packages/testing/src/shared-pg.ts` and `.bun-version`, including
renamed previous paths.
Their normal exact-head VM/independent-review comment must explicitly mention
**control-plane** review; generic review alone does not admit these changes.

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

Retries rerun the **entire workflow**, never only failed jobs. Before requesting its
whole-candidate retry, the controller durably records the trusted exact run/attempt
code-failure receipt in Git-backed state. That receipt survives artifact replacement
and process restart. For historical runs not observed before their artifacts
expired, the controller does not invent failure evidence. Attempt-specific names
retain history without weakening the identity bindings.
Unknown result evidence can exhaust its bounded retry budget and require
operator investigation rather than endlessly rerunning or ejecting a PR.

## State machine and recovery

With one hosted candidate running, the planner constructs one speculative
successor **locally**, based on the predecessor tip, without publishing it and
starting another CI run. A speculative candidate is deterministic and can be
rebuilt after cache loss. The hosted runner guard permits only one Batch CI run,
even if a higher legacy max-inflight planner setting is present.
Full-main CI retains explicit reserved capacity, but its mere presence does not
block progress. Before publication/retry/landing, the reader scans current
repository runs and their latest jobs (at most 32 runs, 100 entries per response;
incomplete observations hold). Required capacity is other nonterminal job demand
plus the larger of configured main reserve and observed main demand, plus **18
candidate slots**. It proceeds only when that fits BATCHER_RUNNER_BUDGET and no
other Batch CI run occupies the single candidate slot. Missing budget/reserve or
unobservable other-workflow job demand holds rather than inventing capacity.
stage.json exposes the measured occupied/reserved slots, configured budget and
decision. These are explicit repository allocations, not a claim that GitHub
granted a custom quota or that other repositories are idle. Jobs can expand or
external runs can start after observation; this is conservative admission from
observed demand, not an atomic GitHub scheduler or cancellation mechanism.
Invalidated descendants still occupy CI slots while running: no cancellation
operation exists in the adapter.

A retryable trusted code-red result gets one whole-candidate retry. Exit 70 is
non-retryable process-leak evidence and goes directly to bisection/ejection.
Two trusted retryable code-red
attempts split the ordered candidate at `ceil(length / 2)`; halves are tested
sequentially against the actual landed base. Repeated singleton failure ejects
that exact head with an exact-head reason comment. Changed heads and new ready
events may return; merely editing evidence cannot re-enqueue the same known-bad
head/event. Merge-tree conflicts also eject their exact member with a distinct
conflict reason, not a fabricated CI failure. This isolation identifies failing
combinations against the then-current base; it does not claim a universally bad
PR independently of interactions.

Infrastructure/cancelled/unknown attempts never incriminate PRs. They back off
exponentially from 60 seconds to at most 3,600 seconds, with an eight-attempt
budget. Retry intent is durable before effect submission. An uncertain effect
does not get blindly replayed after restart; its observable intent waits for
provider reconciliation. No running job is cancelled.
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
candidates and baseline main outcomes are sampled at most once per 15 minutes.
This preserves bounded rerun detection without redownloading completed artifacts
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

Telemetry reports the nearest-rank rolling 24-hour p95 from each exact
head/ready-event's **first measured provider CI start**, deduplicating reruns and
bisection candidates. More than 1,800 seconds emits a stop signal and holds new
batch work/landing; reconciliation and observation continue. stage.json reports
sample count, coverageSince and completeWindow alongside the signal. This is a
sample of heads that reached CI, not a latency claim for unknown/unstarted work
or a completeness claim about all historical PRs. Small/partial samples are
explicit; missing history is unknown, never reset to healthy. Restart reloads the
retained journal or Git samples; cache loss cannot fabricate historical timings.
Observation gaps reset coverageSince rather than turning elapsed downtime into
a complete window; retained real latency samples can still trigger the stop signal.
Use separate writable output directories for replicas; remote Git, not the local
journal, fences their mutations. External historical reruns can be observed up
to 15 minutes late and may overlap independently started work.

### Missing workflow admission

A published candidate with no exact workflow initially reserves the hosted slot.
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
runs. Shadow modes update only their local observation journal. No mode deletes
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

One-step rollback is `BATCHER_MODE=shadow` followed by the platform's normal
restart/revision replacement. Default configuration is still shadow. An active
rollout must ensure old active instances have stopped or
their provider authority is fenced before declaring rollback complete. Leave
running CI untouched, retain state/queue/result evidence, and inspect main's
exact landed SHA. Do not delete refs, force-reset main or rotate credentials.

Full VM/monorepo testing, exact-head independent agent review and the repository's
evidence comment remain required before this batcher itself lands. Focused core
tests do not replace that parent-owned admission requirement.
