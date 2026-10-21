# Portable merge batcher

This is the OPE-834 in-house batcher core. It uses Bun 1.4.3, built-in APIs and
Git (2.38 or newer for `merge-tree --write-tree`). No database, checkout, native
`merge_group`, vendor queue, cloud SDK or cloud-specific state service is used.
The default and currently supported GitHub operating mode is **read-only shadow**.

## Activation boundary

The pure planner, candidate builder, inspector, durable state model, controller,
Git CAS adapter and GitHub read/write surfaces are implemented and locally
testable. **The shipped GitHub executable refuses active mode before any remote
write.** This is intentional, not a permissions retry or a simulated active run.

The provider contract requires all of:

- Atomic multi-ref compare-and-swap for a changing state/lease ref and the exact
  tested main tip (or new immutable candidate ref).
- A provider-side fence that binds each PR's exact head, ready event and evidence
  revision to the landing transaction. A fresh HTTP read followed by a Git push
  still has a race; a local leader lock or “one replica” does not close it.
- Fenced/idempotent rerun and ejection-comment effects, including uncertain
  outcomes and lease transfer. GitHub REST side effects are not transactions
  with a Git ref update.

`githubCapabilities` declares these unsupported/unverified. Setting an
environment variable cannot override them. `AdmissionCoordinator` and
`FencedGitExecutor` are the typed integration point for a provider that can
actually supply the contract. Do not implement that contract as read-then-write
or turn capability booleans on without establishing its semantics. GitHub
atomic receive-pack availability must be established by the rollout owner;
this implementation never falls back from `git push --atomic` to separate pushes.
Repository rulesets, App permissions and bypass policy are separate activation
dependencies, not evidence that these transaction guarantees exist.

The parent workflow integration and production deployment are separate work.
No branch/ruleset/permission/cloud activation is performed by this code change.

## Commands

```sh
# Run one read-only observation; explicitly overrides BATCHER_MODE=active.
bun scripts/merge-batcher/main.ts shadow --once

# Poll; still shadow unless explicitly configured otherwise.
bun scripts/merge-batcher/main.ts run

# CI interface: stdout contains only the inspected JSON manifest.
bun scripts/merge-batcher/main.ts inspect --tip "$TIP_SHA" --git-dir "$BARE_GIT_DIR"

# Focused verification (two test workers maximum).
bun test --max-concurrency 2 scripts/merge-batcher/core.test.ts
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
| `BATCHER_BRANCH_PREFIX` | `queue/` |
| `BATCHER_MODE` | `shadow`; `active` requires a supported fenced adapter |
| `BATCHER_MAX_BATCH_SIZE` | `16` |
| `BATCHER_MAX_INFLIGHT` | `1` hosted candidate CI |
| `BATCHER_SPECULATION_DEPTH` | `2`, including current candidate |
| `BATCHER_GIT_DIR` | `/data/objects.git`, disposable bare object cache |
| `BATCHER_OUTPUT_DIR` | `/data/shadow`, local stage/manifest evidence |
| `BATCHER_POLL_SECONDS` | `30` |
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

Each member is one two-parent merge commit built with `git merge-tree --write-tree`
and `git commit-tree`. Parent 1 is the preceding tested/base tip; parent 2 is the
exact PR head. No checkout or merge-script execution occurs. The commit timestamp
is deterministic from readiness timestamps. Candidate refs are
`queue/<64-character batchId>` and are create-only.

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
`Batch ready` alone as proof. The workflow must upload an artifact named
`batch-result` containing exactly one `batch-result.json` (or `result.json`):

```json
{
  "schemaVersion": 1,
  "batchId": "<64hex>",
  "headSha": "<40sha>",
  "outcome": "success",
  "runId": 123,
  "runAttempt": 1
}
```

`outcome` is `success`, `code_failure`, `infrastructure` or `cancelled`.
`runId`/`runAttempt` must be JSON numbers (convert GitHub expression strings).
Success additionally needs the matching workflow run conclusion `success`;
code failure needs `failure`. Missing/expired/ambiguous/malformed artifacts,
wrong attempts/branches/workflows and other conclusions are unknown, never
evidence against a PR. Archive reading is bounded and never extracts paths.

GitHub reruns may replace an artifact of the same name. Before requesting its
whole-candidate retry, the controller durably records the trusted exact run/attempt
code-failure receipt in Git-backed state. That receipt survives artifact replacement
and process restart. For historical runs not observed before their artifacts
expired, the controller does not invent failure evidence. The parent may extend
the adapter to attempt-qualified artifact names while retaining the binding fields.
Unknown result evidence can exhaust its bounded retry budget and require
operator investigation rather than endlessly rerunning or ejecting a PR.

## State machine and recovery

With one hosted candidate running, the planner constructs one speculative
successor **locally**, based on the predecessor tip, without publishing it and
starting another CI run. A speculative candidate is deterministic and can be
rebuilt after cache loss. Configured additional in-flight capacity is explicit.
Invalidated descendants still occupy CI slots while running: no cancellation
operation exists in the adapter.

A trusted code-red result gets one whole-candidate retry. Two trusted code-red
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

Before landing, the controller inspects the exact tested commit, verifies
fast-forward ancestry separately, re-observes heads/readiness/evidence/run state,
then asks the provider to atomically fence those bindings and the durable lease
with main's exact old SHA. Main moves to the **already-tested tip**, never a
freshly rebuilt commit after testing. The Git adapter uses exact
`--force-with-lease=<ref>:<expected>` as the CAS mechanism, never `--force` or
`+main`; independent ancestry validation forbids non-fast-forward main updates.
It also checks snapshots explicitly because Git omits already-up-to-date refs
before wire-level lease checks. The lease ref must change in every transaction.

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

## Shadow evidence and operations

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
HTTP calls have 30-second bounds and Git subprocesses have a 60-second bound.
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
restart/revision replacement. The current executable is already shadow-only on
GitHub. A future active rollout must ensure old active instances have stopped or
their provider authority is fenced before declaring rollback complete. Leave
running CI untouched, retain state/queue/result evidence, and inspect main's
exact landed SHA. Do not delete refs, force-reset main or rotate credentials.

Full VM/monorepo testing, exact-head independent agent review and the repository's
evidence comment remain required before this batcher itself lands. Focused core
tests do not replace that parent-owned admission requirement.
