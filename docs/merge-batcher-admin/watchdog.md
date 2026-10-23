# Independent watchdog: prepared contract, not deployed

The watchdog is a separate Cloud Run Job in the existing batcher project, using
the **same exact reviewed image digest**, invoked by Cloud Scheduler every five
minutes. It is not a child of the batcher process and needs no agent session or
connected VM. The prepared resource payloads are in `watchdog-deployment.json`;
placeholders and the explicit not-deployable status are intentional. This slice
implements portable policy only. Provider adapters, entrypoint/image closure,
credential bindings and the live kill drill require paired independent review
and explicit rollout-owner go before any resource creation or rules writes.

## Detection and restoration

`watchdog.ts` consumes a proposed authenticated durable health observation bound
to deployment UID/image, activation epoch and saved admin-plan digest. A completed
healthy cycle is distinct from a successful health poll. STOP, a durable crash
latch, or no healthy cycle for 900 seconds triggers the reviewed one-command OFF.
Before the first healthy cycle, age is measured from the durable activation time,
never from the watchdog's first poll. Unknown/malformed health or write outcomes
hold and alert; they do not establish safe restoration.

Before an action claim, uncertainty (including unavailable/stale health, unknown
writes or drift) leaves the record watching: emit an alert with the stable
activation incident key and re-observe next scheduled run. No OFF is executed
until a fresh observation qualifies. Deduplicate the issue surface, not the
per-run monitoring signal. After a claim, `held` means disarmed pending operator
reconciliation: never reset/re-arm it automatically or replay an unknown effect.
Each subsequent held run emits an alert even after its incident comment exists.

An action claim uses remote object-generation CAS in a dedicated state bucket.
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

The fixed 900-second threshold has **not** been qualified against the runtime
health producer. A 900-second cycle plus 120-second reconciliation and a
120-second poll can exceed it; configured cycles and classified provider backoff
can reach 3600 seconds. The runtime contract must supply reviewed liveness proof
compatible with this threshold, or the rollout owner must explicitly accept
automatic OFF during a legitimate long cycle/backoff. Do not relabel a poll as
a completed healthy cycle or silently widen the threshold. This remains an
integration gate, not an invented producer guarantee.

The watchdog writes separate started and finished heartbeats with run identity,
timestamps and outcome. A fresh started heartbeat cannot hide a hung action.
A second job on a separately scheduled tick reads the **finished** heartbeat and
Cloud Run execution state, posting a deterministic incident marker to the
existing configured GitHub issue/PR surface when no completion exists for
15 minutes, or when the watchdog reports a hold. A long legitimate drain is
reported as in-progress, not falsely called a dead process. The observer has no
STOP or rules-write authority. Notification retries reconcile the same marker;
a lost response never licenses a duplicate POST.

Neither job can detect itself while dead. Before enable, configure an independent
Cloud Monitoring absence alert for observer completions to an approved existing
notification channel, and test delivery. No channel ID is guessed here. This is
independent of both job processes, not independent of a total GCP outage. A missed
watchdog/observer alert is not a reason to automatically turn the batcher ON.

## Provider and image boundary required from runtime owner

The producer must supply a reviewed source pin and authoritative durable read:
activation/control epoch, activated-at, last completed healthy cycle with proof,
STOP/crash latch, in-flight/unknown write status, and version/CAS token. Specify
how it is read when the service is manual0 or unreachable; old logs and ephemeral
checkpoints are not that contract. The adapter validates a complete current
rules inventory against the saved plan before returning `applied` or `manual`.

The common image must package the policy entrypoint, a pinned provider adapter,
the reviewed OFF bundle and its five bound operator files plus required
`bun`, `bash`, `gh`, `jq` and Git tools. The current retained operator credential
helper requires a static credential file: it must gain reviewed workload-identity
support for this job, not mount a broad administrator key as a shortcut.
Saved plan/originals, operator hashes and receipts must be downloaded from an
immutable generation-bound configuration object to each job's temporary
directory. Durable action intents, reverse-stage receipts and notification
intents cannot live only on ephemeral container storage. The adapter must retain
them with generation CAS before/after effects. No live adapter is supplied or
implicitly trusted by these pure policy tests.

## Permissions and practical scope

- Scheduler identity: `run.jobs.run` on exactly the watchdog and observer jobs,
  not `run.jobs.runWithOverrides` or service mutation. Use OAuth for the Google
  Run API; neither job has a public HTTP endpoint.
- Watchdog identity: read the bound service/executions and health state, invoke
  the existing STOP control operation, update only the bound service to manual0,
  add versions only to its bound STOP control secret, read its dedicated App-key
  secret/config, and get/create/update objects only in its dedicated state bucket.
  No object deletion, runtime start path, unrelated service or project-wide
  administrator role is proposed. Exact IAM permissions must be derived from
  and tested against the final reviewed provider adapter.
- Watchdog GitHub installation token: selected repository only; administration
  write for exact saved rules restoration, contents/actions read for reconciliation,
  and issues write for the configured incident comment. GitHub cannot scope
  administration write to only those rules or only restoration. The pinned
  reviewed code enforces that narrower semantic boundary; do not falsely claim
  the permission system does. The existing batcher App lacks administration
  permission: a separately approved credential/grant is a deployment prerequisite,
  not authority to mint one or broaden the runtime writer in this task.
- Observer identity: heartbeat/config and execution reads plus the chosen
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
