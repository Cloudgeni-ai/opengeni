# Minimal provider watchdog — not deployed

This lane deliberately excludes the expanded watchdog, new App, rules split,
Git heartbeat refs, durable-core migration, sweep and generic hydration framework.
The runtime remains OFF/Manual until the rollout owner relays reviewed go.

## Small boundary

Cloud Scheduler invokes one Cloud Run Job every five minutes. Use the existing
OFF service-account/credential path and the exact retained `off.ts` package;
never substitute a new restoration implementation. A fresh authenticated
supervisor `/status` response supplies `controlObservedAt` plus the paired
`batcher-progress/v1` cycle measurements. Stopped/draining or
three consecutive unclassified failures triggers OFF at the next tick. A loop
observation at least 900 seconds old triggers OFF in every running/wait state.
Successful idle/no-work and Batch-wait cycles count as progress, not as landing
proof. A last successful cycle at least 900 seconds old requests OFF even with
fresh heartbeats, advancing completed-cycle counts or repeated read deferrals.
Missing, malformed, future or unreachable observations request proven OFF, never grant Manual.

This deliberately conservative source currently acts on one unavailable sample,
including a missing progress schema or any future observation timestamp. A transient error or clock skew
can therefore end an otherwise healthy activation. It does not wait fifteen
minutes on unavailable status. This reviewed Low finding remains a rollout risk
to acknowledge or address with a separately reviewed bounded sampling change.
It is not debounced. A valid null-success startup receives 120 seconds from the
immutable `runtimeStartedAt`. A cycle begun before the startup/progress deadline
may finish before its fixed `cycleDeadlineAt`; a cycle starting at or after that
deadline cannot renew grace. Expired active-cycle deadlines trigger OFF even if
the last success is recent. The outer cycle bound is at most the supported
one-hour execution plus 185 seconds of reconciliation/control/termination;
the default cycle bound is 1,085 seconds. Timing pairs must be consistent and
success/deferral timestamps cannot precede this process's start. Deployment must
pair the trigger with the reviewed supervisor supplying these immutable fields.

Deployment qualification must check the configured poll interval against the
900-second progress window, including cycle overhead; an interval of 900 seconds
or more is incompatible even for healthy idle work. Provider-read retry backoff
and a restored `nextAt` must also permit a cycle before the progress/startup
deadline. Do not widen watchdog grace to mask incompatible runtime scheduling.
Deploy the paired supervisor before this watchdog, and roll back the watchdog
before rolling back to a supervisor without these fields.

The trigger cannot declare safety from status flags. Only reviewed OFF may
declare Manual after its verified STOP/drain/reconciliation and exact saved-policy
restoration. Unknown effects, failed drain, rules drift or unavailable proof keep
protections and report held. No automatic ON, replay of a STOP, candidate
deletion, CI cancellation or readiness edits.

Explicit STOP/crash detection is next five-minute tick plus scheduler/dispatch
delay and OFF drain duration. Stale detection is 15 minutes plus up to one normal
tick, dispatch delay and drain. These are scheduling targets, not a 15-minute SLA.

## Provider packaging gate

`minimal-watchdog.ts` is the bounded trigger. `minimal-watchdog-provider.ts` binds
authenticated current service UID/image/URI to the retained OFF contract, checks
all five existing operator hashes, calls `/status` with a 15-second timeout and
invokes unchanged OFF. It uses the existing operator's cloud-auth module and
credentials, not the deferred workload-identity or separate-App framework.
The existing operator writes its deployment receipt and per-stage intents on disk.
A Cloud Run Job's ephemeral disk is therefore **not** sufficient to reuse a VM
directory across executions. Before provider implementation/deployment, pin the
portable copy of the existing OFF bundle and its receipt retention. The wrapper
uses one Cloud Storage `ifGenerationMatch=0` claim object per explicitly assigned
activation ID and exact plan digest. Only a definitive 412 is treated as another
owner; timeout/other errors hold without OFF. One winner may invoke STOP. OFF first
retains its attempt path with exclusive creation. A subsequent tick may only
continue that attempt: read its original exited-writer witness, verify the same
stopped service generation/image/control twice around read-only durable-state
reconciliation, then use the existing exact reverse stages. It never expires,
deletes or replaces the claim, calls STOP again, or rewrites the original outcome.
The existing plan lock excludes concurrent reverse invocations. A missing STOP
receipt, live writer, changed generation/control, unresolved effect or abandoned
lock remains held; elapsed time alone is not proof. Thus a transient reconciliation
read failure can recover on the next five-minute tick without replaying controls.
The tracked settlement reader accepts completed current-schema effects and only
the exact obsolete rerun branch with zero attempts and its explicit pre-submit
reason. Other blocked effects, including attempted reruns, remain unresolved.
Preserve the originals and all resulting
receipts. This must be a small provider wrapper, not the deferred generic journal
or hydration implementation. No provider claim is qualified by the in-memory test.

No scheduler/job manifest is executable until that packaging boundary is reviewed.
Expected configuration: existing project `cloudgeni-gecko`, region `europe-west1`,
five-minute UTC schedule, one task, parallelism one, retries zero. Task parallelism
alone does not prevent overlapping executions. Scheduler API enabling, exact
existing identity binding and any storage access happen only under later rollout go.
No new App or runtime administration grant is required by this lane.

**Both credential paths must be explicit.** The existing operator `cloud-auth.ts`
covers GCP only. `stage.sh` also needs an authorized GitHub ruleset-write identity
inside the Job. The runtime App's administration-read token cannot restore rules.
Before packaging, the rollout owner must name the existing approved OFF identity,
its exact repository rights, secret version/storage and Job access binding. Do not
infer that VM authentication exists in the container, copy a personal admin token,
broaden the runtime App, or rotate the immutable workspace credential. No credential
placement is performed by these sources or their tests.

**Operator coordination is required.** The claim fences watchdog executions, not
an independent VM operator. Before manual OFF, pause the Scheduler and reconcile
all running Job executions, or acquire the same create-only activation claim as
the watchdog. An existing/uncertain claim is not permission to steal ownership.
Do not race two OFF operators or remove a claim after a timeout. After successful
OFF, pause the schedule: later ticks otherwise reverify the retained stopped proof.
Held outcomes need the rollout's alert destination and operator response; a stopped
watchdog cannot announce its own absence. A missed-run sweep remains out of scope.

## Qualification

Independent source review precedes provider deployment. Then prove real durable
claim exclusion, binding mismatch refusal, unknown-write/drain refusal, a clean
idle run and controlled mid-cycle kill using the actual OFF bundle. Capture exact
Manual readback twice and observed detection/drain timing. Report these receipts
to the rollout owner before ordinary ON. Existing unit tests are source-only,
not provider, complete VM CI, or kill-test evidence.

## Stopped configuration lineage

A stopped configuration update must not turn an old drain witness into a new
one. The pinned operator can retain a separate lineage: pass the prior receipt
as the sixth argument to `updateStoppedService` (the fifth is its clock). It
preserves the genuine root proof, exact provider before/after snapshots and the
completed etag-bound update. Without that input, no lineage proof is available.

OFF accepts `lineage-reconciled-disabled` only after authenticated audit readback
confirms each consecutive MANUAL0 update, every control version remains STOP,
the current service matches the retained endpoint, and the exact original
ledger and all candidate/effect records are settled. The old witness generation
is never rewritten. This path is active-mode only, at most 16 configuration
edges and 64 intervening control versions. Only the existing capacity settings
may change across its safety projection; image, command, identity and routing
changes do not qualify. Missing audit/history, gaps, START, drift, pending
candidates and unknown effects remain held without replay or a recovery START.

The operator identity needs authenticated Cloud Logging entry reads and access
to the existing control-secret versions. Delayed or unavailable audit evidence
holds; it does not permit inference from MANUAL0 or HTTP503 alone. Repeating OFF
can re-read evidence, but never reset its watchdog claim or replay unknown
writes. “Any generation” means a fully validated chain, not arbitrary unknown
lineage. New image/contract hashes and independent review are required before
using this updated operator; source tests do not qualify a live kill drill.
