# Minimal provider watchdog — not deployed

This lane deliberately excludes the expanded watchdog, new App, rules split,
Git heartbeat refs, durable-core migration, sweep and generic hydration framework.
The runtime remains OFF/Manual until the rollout owner relays reviewed go.

## Small boundary

Cloud Scheduler invokes one Cloud Run Job every five minutes. Use the existing
OFF service-account/credential path and the exact retained `off.ts` package;
never substitute a new restoration implementation. A fresh authenticated
supervisor `/status` response supplies `controlObservedAt`, the existing loop's
control observation, not successful CI or cycle completion. Stopped/draining or
three consecutive unclassified failures triggers OFF at the next tick. A loop
observation at least 900 seconds old triggers OFF in every running/wait state.
Missing, future or unreachable status also requests proven OFF, never grants Manual.

The trigger cannot declare safety from status flags. Only unchanged OFF may
declare Manual after its verified STOP/drain/reconciliation and exact saved-policy
restoration. Unknown effects, failed drain, rules drift or unavailable proof keep
protections and report held. No automatic ON, retry of an uncertain OFF, candidate
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
owner; timeout/other errors hold without OFF. One winner may invoke OFF; an unfinished claim must hold across restart,
not expire and replay an unknown write. Preserve the originals and all resulting
receipts. This must be a small provider wrapper, not the deferred generic journal
or hydration implementation. No provider claim is qualified by the in-memory test.

No scheduler/job manifest is executable until that packaging boundary is reviewed.
Expected configuration: existing project `cloudgeni-gecko`, region `europe-west1`,
five-minute UTC schedule, one task, parallelism one, retries zero. Task parallelism
alone does not prevent overlapping executions. Scheduler API enabling, exact
existing identity binding and any storage access happen only under later rollout go.
No new App or runtime administration grant is required by this lane.

## Qualification

Independent source review precedes provider deployment. Then prove real durable
claim exclusion, binding mismatch refusal, unknown-write/drain refusal, a clean
idle run and controlled mid-cycle kill using the actual OFF bundle. Capture exact
Manual readback twice and observed detection/drain timing. Report these receipts
to the rollout owner before ordinary ON. Existing unit tests are source-only,
not provider, complete VM CI, or kill-test evidence.
