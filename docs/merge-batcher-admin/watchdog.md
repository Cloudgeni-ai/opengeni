# Independent watchdog: prepared contract, not deployed

The watchdog is a separate Cloud Run Job in the existing batcher project, using
the **same exact reviewed image digest**, invoked by Cloud Scheduler every five
minutes. It is not a child of the batcher process and needs no agent session or
connected VM. The prepared resource payloads are in `watchdog-deployment.json`;
placeholders and the explicit not-deployable status are intentional. This slice
contains portable policy, executable provider/storage adapters and entrypoint.
The authoritative core bridge is still pending; the adapters are not live-qualified.
Core bridge and entrypoint/image closure,
credential bindings and the live kill drill require paired independent review
and explicit rollout-owner go before any resource creation or rules writes.

## Detection and restoration

`watchdog.ts` consumes a proposed authenticated durable health observation bound
to deployment UID/image/config digest/generation/revision, repository/state ref,
phase caps, activation epoch and saved admin-plan digest. A completed
healthy cycle is distinct from a successful health poll. STOP, a durable crash
latch, a heartbeat stale for 900 seconds in any state, or an expired fixed phase
deadline triggers the reviewed one-command OFF. A trigger is not restoration proof.
Before the first heartbeat, age is measured from the durable activation time,
never from the watchdog's first poll. Unknown/malformed health or write outcomes
hold and alert; they do not establish safe restoration. A stale heartbeat or
expired phase may still request fencing/draining while effects are unknown, but
Manual restoration remains blocked until complete no-unknown reconciliation.

Before an action claim, uncertainty (including unavailable/stale health, unknown
writes or drift) leaves the record watching: emit an alert with the stable
activation incident key and re-observe next scheduled run. No OFF is executed
until a fresh observation qualifies. Deduplicate the issue surface, not the
per-run monitoring signal. After a claim, `held` means disarmed pending operator
reconciliation: never reset/re-arm it automatically or replay an unknown effect.
Each subsequent held run emits an alert even after its incident comment exists.

Job bookkeeping uses remote object-generation CAS in a dedicated state bucket.
Missing recovery journals or unverified claims become a sticky held incident
with notification, never seed reconstruction or another OFF attempt. The
temporary restoration credential is removed before core receipt verification;
normal and restart verification use the same core credential boundary.

Before OFF, the core bridge must also claim the incident and set the stop fence
in the **same Git state.json CAS** used by writers and operators. The object claim
is not a substitute for that authoritative fence.
Cloud Run taskCount/parallelism do not serialize separate executions; the CAS
claim does. A claim is never stolen because a timer expired. An existing action
first checks its actual Cloud Run execution: running means leave it alone;
unknown means alert/hold; terminal permits **read-only** outcome reconciliation.
Only a verified exact OFF receipt plus current Manual policy completes it.
An incomplete/unknown action is never blindly replayed. A later deliberate ON
uses a new activation binding and fresh plan, not a reset of old intents.

In-flight writes must drain through the reviewed OFF verifier. The watchdog has
no alternate rule-restoration code, and a string saying `stopped` or `manual`
is not proof. OFF must preserve the saved originals, candidate/state history,
CI and readiness. It must reject unknown effects, identity changes and rules
drift. The fresh read after claiming is not a remote atomic fence: the provider
adapter must fence the exact activation through the reviewed STOP control
protocol before calling OFF. Concurrent deliberate ON is forbidden until the
exclusive restoration operation has settled.
The shared remote fence must cover **all** operator OFF and STOP/START operations,
not just concurrent watchdog jobs. STOP currently triggers on its first qualified
observation; there is no debounce or planned-maintenance exemption. Until that
shared fence is implemented and reviewed, planned operator STOP/START or OFF
requires disabling the watchdog schedule and proving all its executions settled
first. Pausing scheduling alone does not stop an already running job. A new ON
requires a fresh activation binding; do not erase a held action to resume it.

## Honest timing and independent observation

Nominal detection is 15 minutes plus up to the next five-minute scheduler tick,
plus dispatch/observation time. This is **not** a twenty-minute restoration SLA.
The existing operator can wait for a 900-second cycle, reconciliation and scale
operations. The prepared watchdog task has a 3600-second execution timeout and
no automatic task retries; timeout is an unknown outcome requiring readback,
not proof that an effect did not happen. Scheduler acknowledgement only proves
execution submission, not watchdog completion. Provider outages, scheduler
delay and unavailable permissions have no finite bound promised here.

Health means liveness: the producer must persist a heartbeat on every loop,
including CI waits and backoff, with its activity/wait due information. A heartbeat
stale for 900 seconds triggers in **every** state; there are no 31/76/151-minute
exemptions. A separate durable phase has a fixed start/deadline and a timeout plus
small margin from the immutable `binding.phaseLimits` caps. The phase duration
may be shorter than its cap (notably backoff); its margin must match, and backoff
deadline must equal its durable wait-due time plus that margin. Fresh heartbeat never
extends that deadline. Last healthy completion remains truthful diagnostic data,
not a fabricated timestamp used to keep the controller alive. Exact production
phase caps must be published with the paired runtime configuration; test fixture
caps are not deployment policy. Missing/mismatched envelopes hold. This policy
still requires the actual producer contract and paired qualification.

Only deliberate operator START may reset a settled failure streak. Ordinary
restart/new generation must not reset it; unknown phase/outcome holds never reset.
The watchdog has no START or reset operation.

The entrypoint emits exactly one final `batcher_watchdog_completed` event with
schema `batcher-watchdog/v1`, execution/job/source identity, checked/completed time,
activation, state SHA, incident ID, result and optional receipt digest. Progress
events are not completion. The independent GitHub scheduled sweep (runtime-owner
implementation, nominally every ten minutes) requires both a terminal provider
execution and its matching bound final event. It alerts after twenty minutes
without a match, or for held/error outcomes, on a fixed configured incident
thread. Inaccessible logs/incomplete pagination are unknown, not healthy. The
watchdog creates no new thread; absent destination fails and retains logs.
The sweep has read-only provider access and comment-only GitHub access; it cannot
STOP or restore rules. Notification retries reconcile the same marker and never
blindly repeat POST. No agent or VM is a runtime dependency.

The watchdog cannot detect itself while dead. The sweep's job/log read binding
and configured thread must be qualified before enable. GitHub scheduling or
availability can delay that independent alert; no missing-heartbeat guarantee
is claimed during a GitHub outage. No channel or thread ID is guessed here.
Only incident markers authored through the configured watchdog App count as
receipts; arbitrary comments quoting the marker do not suppress notification.
A missed-watchdog alert is never a reason to automatically turn the batcher ON.

## Provider and image boundary required from runtime owner

The implemented entrypoint is `bun docs/merge-batcher-admin/watchdog-main.ts run`.
It reads `WATCHDOG_CONFIG_BUCKET`, `WATCHDOG_CONFIG_OBJECT` and the immutable
`WATCHDOG_CONFIG_GENERATION`, then verifies its actual Cloud Run execution/job/image
before running policy. `RuntimeConfig` in `watchdog-provider.ts` defines the
configuration; it is not generated from ambient credentials or an old activation.

The runtime-owned, source-digest-pinned bridge exports
`createWatchdogBridge(config, stateToken, providerEvidence)` and implements `CoreBridge`:
`observe`, `claimStop`, `verifyClaim`, `verifyBeforeRestore` and `verifyOffReceipt`. Its third argument is
`ProviderEvidencePort`: authenticated Cloud Run service data plus complete rules
classification and a real reviewed STOP-proof verifier. Missing reads throw;
they are never synthesized as Manual or stopped. The core validates provider
UID/image/config digest/generation/revision against the immutable binding, plus
repository/state-ref and incident evidence. `observe.revision`
is the full stable Git state SHA. `claimStop` must set the actual shared Git fence,
not return a synthetic token. The real OFF path calls
`verifyBeforeRestore(incidentId, drainedReceipt, action)` after verified drain and
before **each** reverse mutation, including reverse reissues, and before completion.
The callback must use `providerEvidence.verifyDrained` for authenticated service
data and real STOP verification, then reconcile the exact Git incident, activation,
current state and all unknown/in-flight effects. Rejection retains STOP and the
remaining protections; a prior successful callback is never cached. This callback
does not inherit the rules-administration credential. `verifyDrained` deliberately
does not require Manual policy: intermediate inventory is checked by the OFF
stages, and core must validate actual post-STOP identity/scaling rather than guess
a generation increment. Manual verification remains mandatory in `verifyStopped`.
The optional hook on the ordinary operator API preserves its existing invocation;
the watchdog bridge hook is required and missing implementations fail closed.
`verifyOffReceipt` must freshly bind current
reconciliation to that incident so an old same-image drain proof cannot qualify.
These are adapter interfaces for the proposed runtime-health/v1 contract, not a
claim that the runtime module already supplies these exports. Until its exact
implementation pin is paired and reviewed, startup must fail rather than use a
fake bridge. State objects are keyed by the complete activation binding.

The producer must supply a reviewed source pin and authoritative durable read:
activation/control epoch, activated-at, heartbeat and fixed phase deadline envelope,
last completed healthy cycle with proof,
STOP/crash latch, in-flight/unknown write status, and version/CAS token. Specify
how it is read when the service is manual0 or unreachable; old logs and ephemeral
checkpoints are not that contract. The adapter validates a complete current
rules inventory against the saved plan before returning `applied` or `manual`.

The common image must package the entrypoint, pinned core bridge and provider adapters,
the reviewed OFF bundle and its five bound operator files plus required
`bun`, `bash`, `gh`, `jq` and Git tools. The current retained operator credential
helper requires a static credential file: `watchdog-operator-auth.ts` supplies a
metadata/workload-identity replacement for reviewed packaging as `cloud-auth.ts`.
Its dependency and new operator hashes must be bound and reviewed; do not mount
a broad administrator key as a shortcut.
Saved plan/originals, operator hashes and receipts must be downloaded from an
immutable generation-bound configuration object to each job's temporary
directory. Durable action intents, reverse-stage receipts and notification
intents cannot live only on ephemeral container storage. The adapter must retain
them with generation CAS before/after effects. The optional journal hook in the
reviewed OFF/stage path uploads exact intent/payload before each rule mutation and
response/verification after it; a failed CAS stops further writes. No unknown
upload is retried. Live acceptance and paired core integration remain unqualified.

## Permissions and practical scope

- Scheduler identity: `run.jobs.run` on exactly the watchdog job,
  not `run.jobs.runWithOverrides` or service mutation. Use OAuth for the Google
  Run API; neither job has a public HTTP endpoint.
- Watchdog identity: read the bound service/executions and health state, invoke
  the existing STOP control operation, update only the bound service to manual0,
  add versions only to its bound STOP control secret, read its dedicated App-key
  secret/config, and get/create/update objects only in its dedicated state bucket.
  No object deletion, runtime start path, unrelated service or project-wide
  administrator role is proposed. Exact IAM permissions must be derived from
  and tested against the final reviewed provider adapter.
- Watchdog restoration App token: selected repository only; administration
  write for exact saved rules restoration, contents/actions read for reconciliation,
  and issues write for the configured incident comment. A separate `stateApp`
  token requests only contents **write** from the existing reviewed state-writer
  capability and is passed only to the core CAS module. This avoids adding a new
  App to the combined main/queue/state bypass merely to obtain state access.
  Do not give the runtime App administration or pass the restoration token to
  the fence module. GitHub cannot scope
  contents-write to one ref, or administration write to only those rules or only restoration. The pinned
  reviewed code enforces that narrower semantic boundary; do not falsely claim
  the permission system does. The existing batcher App lacks administration
  permission: a separately approved credential/grant is a deployment prerequisite,
  not authority to mint one or broaden the runtime writer in this task.
  Access to an App signing key can mint permissions beyond a single reduced token;
  the runtime permission boundary of each issued token and the reviewed software
  boundary are distinct. E must authorize the state capability binding explicitly.
- Sweep identity: execution/log reads plus the configured
  notification permission only. No GitHub administration, control-secret write
  or runtime update access. Monitoring alert delivery uses the separately
  approved channel; it must not depend on either job running.

## Review and controlled kill qualification

Unit tests use fake providers and cannot prove live safety. Paired review must
exercise the real OFF verifier and durable provider adapters for STOP/crash/stale
health, in-flight writes, unknown outcomes, epoch/CAS races, restart after every
effect boundary, rules drift and notification reconciliation. Then an explicitly
authorized kill drill must kill the batcher and prove automatic exact saved
Manual restoration without cancelling CI, followed by a separate watchdog-path
failure proving the independent observer/absence alert. Retain exact receipts.
All resource ownership and eventual cleanup belong to the rollout owner; keep
durable audit/uncertain state when disabling the schedules and jobs. ON is always
deliberate, never a watchdog or observer action.
