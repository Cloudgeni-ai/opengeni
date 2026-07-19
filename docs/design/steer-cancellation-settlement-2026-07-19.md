<!-- docs-refs: record -->

> **Point-in-time OPE-75 landing record.** The additive PR branch is based on
> `3dadb5555f1612a7bf9e2568f74168a64f652ed0`; the independently reconciled
> `origin/main` was `77986e28331519bd9f224c9033ee62930465b01a`. The open
> draft dependency heads were OPE-59 PR #459
> `1540bc659170c7747d7366c214493ca70b89c9bf`, OPE-63 draft head
> PR #467 `80de16cae51216c314c29f3721894e41186b5401`, and OPE-73
> PR #475
> `19cb1d4c84e4bd19c1fa56553b0efba7d1c48cb3`. These branches are not merged
> dependencies. Paths and symbols may move. Shipped code and current-tier docs
> win after landing.

# Steer cancellation settlement — bounded landing contract

## Status

OPE-75 has a deterministic real-service pre-fix control on draft PR #490, branch
`fix/ope-75-bounded-cancellation-settlement`:

```text
test/integration/steer-cancellation-deadlock.fixture.test.ts
```

The fixture passes as a reproduction against real PostgreSQL 17, NATS, and
Temporal. It first reproduces the blocked materialization state while the exact
activity remains `CANCEL_REQUESTED` and heartbeating, then terminalizes that
activity by exact ID and proves a second current defect: Temporal terminalization
is mistaken for physical quiescence and a replacement runs while the zombie is
still executing. The control passes by asserting those broken pre-fix states; it
does not claim cancellation settlement is implemented.

Implementation is intentionally blocked from the overlapping runtime and
database files until the OPE-63 and OPE-73 final reviewed heads land and root
serializes the OPE-59 integration. Their owners supplied the typed boundaries
listed below, but all three PRs remain draft/nonfinal. Racing those owners would
be less safe than preserving this fixture and exact landing plan.

## Exact production fixture

```text
Workspace:       c77bf2b8-3d09-4963-a40d-30588f5139f7
Session:         b4827af4-c042-4e05-bf5a-0b531f6dccef
Superseded turn: 43d6772c-1580-4bb5-a074-07b4ccbe18eb
Attempt:         49307539-468b-4725-bcb9-01b88299695b
Workflow:        session-b4827af4-c042-4e05-bf5a-0b531f6dccef
Run:             e72e54fe-d36b-4b16-be16-58fe1a3cc7d5
```

Durable state at diagnosis:

```text
session.status                 queued
session.active_turn_id         NULL
queue head / tail              0 / 1
target turn                    superseded
target attempt                 closed, outcome=superseded, quiesced_at=NULL
attempt interruption           settled
pending internal updates       7
agent_steer_instruction        exactly 1 of those 7
replacement turn              absent
wake_revision/delivered        4 / 4
Temporal runAgentTurn          CANCEL_REQUESTED and heartbeating
```

The public queue currently reports `items=[]` and
`stoppingPreviousAttempt=false`. That projection is not truthful for an Agent
Steer because it derives the stop flag only when a visible queued user/API turn
exists. Agent Steer is an internal update and creates no such row.

### Failed-workflow and exhausted-wake fixture

A later mutation-free recovery inspection proved the same split-brain can
survive Temporal workflow failure rather than only an indefinitely open run:

```text
Session:             94488075-bc13-4d03-b38a-cf9529d1bfca
Attempt:             c2466b48-a615-4251-9f3f-168baaa2dc42
Interruption:        d81b9ac6-f11e-42b5-89ed-ba2a6cc3d092
Workflow:            session-94488075-bc13-4d03-b38a-cf9529d1bfca
Run:                 a8c81b2e-db68-469c-a667-1b9879321db4
Workflow disposition FAILED after unacknowledged cancellation + heartbeat timeout
Attempt disposition  closed/superseded, quiesced_at=NULL
Interruption         settled
Wake revision        4 / 4 delivered, no retry remaining
Public state         queued, active, activeTurnId=NULL, queue 0/1
Pending direction    exact Steer update remains unassigned
Next claim           rejected by the unquiesced-predecessor fence
```

The recovery operator returned `INCOMPLETE_FAIL_CLOSED` with zero mutation. A
failed workflow and a fully delivered old wake revision are therefore durable
dead-end states in the current implementation: the outbox has nothing to
redeliver, while `claimSessionWorkForAttempt` correctly refuses to run past the
unquiesced predecessor. Failure of the orchestration run neither proves that
the activity/process stopped nor authorizes replay of its effects.

Separate production timing evidence showed the bounded-but-pathological case:
Temporal cancellation of a turn blocked in `exec_command sleep 300` took
119.893 seconds from `ActivityTaskCancelRequested` to
`ActivityTaskCanceled`; delivery to the activity abort path accounted for
roughly 57 seconds and physical cancellation/finalization another 62.64
seconds. The replacement eventually ran, but a session-wide projection join
continued to treat unrelated historical settled interruptions with
`quiesced_at=NULL` as the current predecessor. The contract must cover both
active cancellation latency and episode-scoped projection truth; a historical
receipt may not keep `stoppingPreviousAttempt` true forever.

### Correlated production states

Read-only reconciliation found two related but distinct production classes.
They require one convergent contract, not one guessed recovery operation:

- **Null-active-turn admission hole:** sessions
  `95de2cfb-136e-4f38-9f00-b0af98007d8d` (OPE-20),
  `27c5cb1a-a2e6-45f0-8a1a-a2cc1cc01f90` (OPE-16), and
  `04fa0eb1-fc06-4187-b50c-6ddd7a44f683` (OPE-61) all durably superseded
  their prior turn, rejected late events, and reached `queued` with
  `active_turn_id=NULL`, queue head/tail `0/1`, active control, and an
  unassigned Steer direction. Resume/wake signals did not admit replacement
  work. OPE-13 correction leaf `02f8cef1-6c96-4987-bf00-4cb03b871bb0`
  reached the same `queued`, null-active-turn, queue `0/1`, active-control
  projection after superseding turn `e6d22129-70c9-44d5-a309-07a93fe231c4`;
  its late event was rejected at sequence 1491, two internal updates remained
  pending, Resume at sequence 1496 admitted nothing, and its sandbox was later
  reaped at sequence 1497. OPE-16 additionally accumulated newer Steer
  directions after the first settlement, proving that an immutable single
  `replacementUpdateId` can orphan the newest instruction.
- **Post-tool stall contrast:** session
  `ec2049d9-32c7-490c-8760-5b3300035fc0` completed model usage at event 28540
  and an `apply_patch` at event 28541, then stalled before its next canonical
  event. It eventually admitted a later turn at events 30584-30586 and
  cold-rematerialized its sandbox. It is evidence for durable
  computer/file-operation receipts, but it was not the same indefinitely
  `CANCEL_REQUESTED` activity state.
- **Closed-attempt stale holders:** OPE-25 session
  `7b955a73-f74c-4565-9437-9278cc31bf26`, attempt
  `9697dd1a-f592-4411-b596-659096f31cf4`, holder
  `9efcc061-7e8a-4441-b5a4-82fffc2e0228`; and OPE-27 session
  `4fc324f3-5b4c-46e5-8d89-8e2f9cab00e9`, attempt
  `f691b598-ce9a-480e-8100-fd7bf58f4dd1`, holder
  `99579fa1-460c-4ab1-845d-d63d44e85b8c`, are closed/recoverable yet retain
  heartbeating exact sandbox holders. Cleanup must fence the exact
  attempt/holder/lease epoch, preserve the sandbox and unpushed filesystem, and
  never release a successor holder.

The first class may remain after the original Temporal activity is gone; a
queue wake alone is therefore insufficient. The second stale-holder class may
still have an active physical resource; setting `active_turn_id=NULL` alone is
therefore insufficient.

## Proven failure mechanism

`sessionWorkflow.runTurn` currently:

1. starts `runAgentTurn` with
   `ActivityCancellationType.WAIT_CANCELLATION_COMPLETED`;
2. races the activity with the interruption signal;
3. on Steer, requests cancellation and durably settles/fences the old attempt;
4. unconditionally awaits the activity promise;
5. records fallback quiescence only after a confirmed activity terminal state;
6. returns to the admission loop only after that wait.

The activity normally reaches its finalizer, invokes the in-memory
`TurnToolCancellationFence`, and writes `attempt_quiesced`. A heartbeating
activity that ignores or never reaches cancellation remains
`CANCEL_REQUESTED`; `WAIT_CANCELLATION_COMPLETED` never resolves, so the workflow
never executes steps 5-6.

There is a second unsafe edge in the current fallback: an exact server-side
`reportCancellation` produces the same workflow cancellation shape used as
physical-stop proof. The workflow then writes `attempt_quiesced` even though the
local activity body may still be executing. The bounded contract must replace
that inference with an authoritative exact operation/holder quiescence receipt.

There is a third liveness edge after cancellation delivery stops. When the
activity ceases heartbeating without acknowledging cancellation, Temporal
eventually returns a typed heartbeat-timeout failure to the control path. That
path deliberately refuses to write false quiescence and throws the activity
failure, so the session workflow becomes `FAILED`. PostgreSQL remains fenced
and truthful—superseded attempt, settled interruption, null `quiesced_at`,
pending direction—but the already-delivered wake revision cannot start another
run. A correct fence has become a permanent liveness failure. Recovery needs a
new, idempotent, exact-run workflow-restart obligation after it classifies
physical and effect truth; it must not weaken the claim fence.

The real-service fixture additionally proves:

- `AsyncCompletionClient.reportCancellation` can terminalize the exact Temporal
  activity: the matching entry disappears from `pendingActivities`, a by-ID
  heartbeat receives `ActivityNotFoundError`, and the workflow promise then
  progresses without workflow termination;
- that server-side terminalization does **not** stop the physical activity;
- the physical activity loop can keep invoking the worker heartbeat helper
  after Temporal no longer recognizes the activity (that local helper has no
  per-heartbeat response promise); and
- the current workflow nevertheless writes `quiesced_at` after that Temporal
  cancellation result, exposing the false-quiescence bug; therefore the fixed
  contract must never set it from Temporal terminalization alone.

## Non-negotiable invariants

1. **Logical supersession is the canonical write fence.** After the Steer
   transaction commits, the old attempt can never append canonical events,
   history, usage, run state, tool receipts, queue state, or workspace capture.
   A late callback is retained only as bounded `turn.event.rejected_late`
   evidence.
2. **Temporal terminalization is not physical quiescence.** The data model and
   public projection must represent them separately.
3. **No full-turn retry.** Provider inference, MCP calls, function tools,
   sandbox commands, computer operations, and other external effects never
   enter a Temporal or database retry closure.
4. **PostgreSQL is truth.** Temporal signals, activity cancellation, NATS
   publication, and wake delivery are idempotent nudges around committed state.
5. **Every effect has a pre-effect fence or a typed unknown outcome.** A force
   settlement may admit the replacement automatically only when PostgreSQL
   proves that no old effect can start or remain ambiguous.
6. **Exact targeting only.** Recovery names the account, workspace, session,
   turn, attempt, workflow ID, workflow run ID, and deterministic activity ID.
   It never kills a shared worker process/pod and never discards a sandbox.
7. **One replacement materialization.** The Steer instruction and the bounded
   pending internal-update bundle are assigned to exactly one replacement turn,
   or that exact turn enters a typed approval/recovery state. They are not left
   indefinitely unassigned and are not copied into a human prompt row.
8. **No false queue clearance.** Public session/queue state exposes logical
   settlement, Temporal disposition, physical quiescence, effect disposition,
   replacement turn, and action requirement without inferring them from visible
   human queue rows.
9. **Replay-safe workflow logic.** Timer duration, activity identity, receipt
   identity, and transition decisions are deterministic across workflow replay
   and continue-as-new.
10. **Canonical lock order.** Every new receipt/materialization transaction uses
    OPE-63's control-aware workspace -> actual workspace -> session -> exact
    turn -> exact attempt prefix before receipt/update/event/wake rows.
11. **Workflow failure is recoverable orchestration truth, not quiescence.** An
    exact failed run is retained on the cancellation episode. A typed recovery
    transaction either establishes positive physical/effect safety or
    materializes `requires_action`, then commits one new wake revision for the
    same session workflow. It never clears the predecessor fence, consumes an
    old delivered revision, or synthesizes a new direction merely because the
    workflow failed.
12. **Projection is episode-scoped.** `stoppingPreviousAttempt` and recovery
    state derive from the exact current cancellation episode/replacement
    predecessor. Historical settled interruptions with null legacy quiescence
    do not contaminate a newer running or completed attempt.

## Required dependency seams

### OPE-63: canonical event/persistence prefix

OPE-75 consumes, but does not reimplement:

- `lockSessionEventWriteRows` (or its final successor) for the exact
  workspace/session/turn/attempt prefix;
- `runIdempotentPersistenceTransaction` for a database-only closure;
- nested SQLSTATE classification and `SessionEventPersistenceError`;
- the final migration number and export path.

The cancellation receipt, replacement materialization, queue event, and wake
outbox write must run under that prefix. No OPE-75 transaction may lock a receipt
or internal update first and then request a workspace/session lock.

### OPE-73: post-effect persistence truth

OPE-75 consumes the final PostgreSQL-owned persistence/model-call receipt
contract rather than inspecting or rewriting its internals. OPE-73 exclusively
owns `session_turn_model_call_admissions`,
`session_turn_persistence_receipts`, their migration and DB functions, provider
and pending-tool handoff, persistence-only recovery, and worker-death replay
decisions. OPE-75 first consumes its authoritative exact-attempt disposition:

| OPE-73 durable truth | OPE-75 cancellation decision |
| --- | --- |
| no model-call admission and no persistence receipt | no provider dispatch is evidenced; continue reconciliation of other effect classes |
| admitted but unlinked model call | `ambiguous_model_call`, `effect_unknown`, non-retryable; quarantine/fail closed |
| linked pending persistence receipt | run persistence-only recovery; never invoke provider/tool again |
| settled/confirmed receipt | consume settled truth and continue |
| stale, fenced, quarantined, missing, or contradictory | stop or enter typed `requires_action`; never infer replay permission |

The provider pre-effect lifecycle is therefore durable and attempt-fenced:

```text
prepared (no dispatch admission)
  -> dispatched (immutable model-call admission committed before invocation)
  -> response_observed (admission linked to the exact persistence receipt)
  -> persistence_settled
```

The `dispatched` admission records only stable provider/run/call identity,
attempt ownership, and supported idempotency/cancellation capabilities—never a
raw prompt, response, or credential. An admitted-but-unlinked call has an
unknown provider outcome even if cancellation was requested; automatic
replacement admission is forbidden until a positive provider outcome or
cancellation receipt resolves it. The old physical activity must pass the
attempt fence before creating/updating an admission or invoking a provider, so
a late activity cannot begin a new call.

OPE-73 remains sole owner of receipt validation, obligation digesting,
model/history/usage settlement, tool-call registration, quarantine, and
persistence-only retry. OPE-75 consumes its final typed result through a narrow
cancellation adapter; `accepted:false`, `fenced`, `missing`, or
`effect_unknown` is never permission to rerun an external effect.

### OPE-59/OPE-50: revisioned workflow wake

Replacement materialization uses OPE-59's
`enqueueSessionWorkflowWakeInTransaction` contract in the same transaction as
exact-attempt settlement, active-turn clearance, replacement/update exposure,
and canonical event append. Post-OPE-63, that transaction begins with
`lockSessionEventWriteRows(tx, { workspaceId, controlLock: "share",
sessionIds: [sessionId] })`, reuses the held workspace/control/session rows,
then locks the exact turn, attempt, receipt/episode, and updates. The wake UPSERT
is the final mutation and returns the exact monotonic committed `wakeRevision`.

It does not create a scanner, recurring model poll, parallel outbox,
independent goal revision, or direct-signal-only correctness path. Direct
delivery remains a latency optimization; OPE-59's revision-aware dispatcher
repairs commit-to-signal loss, and an older delivery cannot acknowledge a newer
revision.

## Proposed durable cancellation episode

Use a new additive table owned by OPE-75 (final name may follow the merged schema
convention), keyed uniquely by the exact attempt/interruption pair. It is a
stable replacement episode, not an immutable pointer to the first Steer update:

```ts
type SessionAttemptCancellationEpisode = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  interruptionId: string;
  executionGeneration: number;
  temporalWorkflowId: string;
  temporalRunId: string;
  temporalActivityId: string;

  temporalDisposition:
    | "cancel_requested"
    | "terminalized"
    | "terminalization_unknown";
  workflowDisposition: "running" | "failed" | "restart_pending" | "restarted";
  physicalDisposition: "not_confirmed" | "quiesced";
  effectDisposition:
    | "reconciling"
    | "safe"
    | "effect_unknown"
    | "quarantined";
  admissionDisposition: "blocked" | "admit_replacement" | "requires_action";

  canonicalDirectionUpdateId: string;
  directionRevision: number;
  replacementTurnId: string | null;
  settlementRevision: number;
  recoveryWakeRevision: number | null;
  recoveryWorkflowRunId: string | null;
  terminalizedAt: Date | null;
  quiescedAt: Date | null;
  materializedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

Required constraints:

- unique `(workspace_id, attempt_id, interruption_id)`;
- unique `(workspace_id, canonical_direction_update_id)` for the currently
  effective direction, with every older direction durably linked to the same
  episode/batch as `superseded` rather than left pending;
- unique non-null `(workspace_id, replacement_turn_id)`;
- foreign keys retain account/workspace/session/turn/attempt/interruption truth;
- exact workflow/run/activity identity is immutable after insert;
- `workflowDisposition=failed` retains that exact failed run and never implies
  Temporal activity terminalization or physical quiescence;
- `restart_pending` requires one committed `recoveryWakeRevision`, while
  `restarted` requires the newly observed `recoveryWorkflowRunId`; neither may
  overwrite the immutable failed predecessor run;
- `physicalDisposition=quiesced` requires the existing attempt's
  `quiesced_at` to be non-null;
- `admit_replacement` requires both `effectDisposition=safe` and
  `physicalDisposition=quiesced` from an authoritative exact operation/activity
  result;
- `requires_action` requires at least one unresolved gate:
  `physicalDisposition=not_confirmed`, `effectDisposition` is `effect_unknown`
  or `quarantined`, or `temporalDisposition=terminalization_unknown`;
- Temporal `terminalized` never implies physical `quiesced`.

Do not overload `session_turn_attempts.quiesced_at` with a grace timeout or a
successful Temporal RPC. When physical quiescence is unavailable, the additive
episode is the authority for a bounded truthful `requires_action` settlement;
it is not permission to auto-admit a runnable replacement.

### Atomic repeated-Steer rule

Every Steer participates in one canonical transaction under the shared
workspace/session lock prefix:

1. lock the exact old attempt/interruption and its replacement episode;
2. append or deduplicate the new `agent_steer_instruction` update;
3. select the newest committed Steer by monotonic `directionRevision` as the
   effective direction;
4. mark older direction updates superseded and assigned to the same bounded
   episode/batch, never orphaned;
5. if `replacementTurnId` exists but is still unclaimed, atomically retarget
   that turn's unconsumed instruction bundle to the new revision;
6. if the replacement was already claimed, never mutate consumed instructions:
   create a new bounded follow-up interruption/episode (and supersede its exact
   live attempt if any); and
7. enqueue one wake carrying the committed episode/direction revision in the
   same transaction.

A lost commit response re-reads the stable episode and revision. Concurrent
Steers serialize on the session/episode locks and choose one newest revision;
neither commit can leave a second pending direction outside the episode.
Repeated Resume, `queueChanged`, and wake signals are idempotent nudges and do
not create or retarget instructions.

## Deterministic workflow state machine

### 1. Establish exact identity before dispatch

The activity ID is deterministic and attempt-scoped, for example:

```text
run-agent-turn:<attempt UUID>
```

The claim persists the workflow ID, workflow run ID, and that activity ID on
the attempt before provider/tool work. An attempt UUID is already unique across
continue-as-new and prevents activity-ID reuse from confusing generations.

### 2. Logical Steer settlement

The existing atomic Agent Steer transaction remains authoritative. It:

- supersedes the old turn;
- closes and fences the exact attempt;
- settles the interruption;
- creates exactly one `agent_steer_instruction` update;
- creates/upserts the cancellation episode in `blocked` state and atomically
  advances its canonical direction revision; and
- commits the revisioned workflow wake.

Repeated Steer follows the atomic episode rule above. Resume/wake replays or
nudges the existing result; it never appends a direction. A Steer after the
replacement has been claimed creates a new follow-up episode instead of
rewriting instructions already consumed by a running attempt.

### 3. Cooperative grace

After the workflow observes the control it requests ordinary Temporal
cancellation and starts a workflow timer with a fixed configured duration
captured in workflow input/versioned state. It races:

- the existing `runAgentTurn` promise; and
- the deterministic grace timer.

If the activity terminates and the existing physical fence writes
`attempt_quiesced`, the normal path wins. The receipt records physical
quiescence, reconciles OPE-73 persistence truth, and materializes the
replacement.

### 4. Exact Temporal terminalization

If grace expires, the workflow calls one retryable control activity with only
the immutable exact identity and settlement revision:

```ts
type TerminalizeRunAgentTurnInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  interruptionId: string;
  temporalWorkflowId: string;
  temporalRunId: string;
  temporalActivityId: string;
  settlementRevision: number;
};

type TerminalizeRunAgentTurnResult =
  | { action: "terminalized" }
  | { action: "already_terminal" }
  | { action: "terminalization_unknown" }
  | { action: "stale" };
```

The activity:

1. verifies the exact immutable receipt under canonical locks;
2. calls Temporal's exact by-ID cancellation completion boundary (currently
   `AsyncCompletionClient.reportCancellation`);
3. treats a lost response as ambiguous until exact workflow history or an
   idempotent retry proves the target activity terminal;
4. updates only `temporalDisposition`; and
5. never writes `quiesced_at`.

This activity is safe to retry because it performs only an idempotent exact
activity cancellation and its attempt-fenced receipt transition. It does not
run provider, tool, sandbox, model, or customer code.

### 5. Reconcile effect truth and decide admission

After ordinary termination or forced Temporal terminalization, consume OPE-73's
exact model-call/persistence disposition, then reconcile every other operation
receipt owned by the old attempt.

- A settled/confirmed OPE-73 receipt, with no active durable operation, yields
  `effectDisposition=safe`.
- An admitted-but-unlinked provider call yields `effect_unknown`; it does not
  auto-admit or redispatch.
- A linked pending OPE-73 receipt runs persistence-only recovery before the
  admission decision.
- A durable sandbox operation with a reconstructable exact cancellation handle
  is cancelled through that handle. Only a positive process/op quiescence proof
  sets both the attempt and receipt `quiesced`.
- An MCP/function/computer/hosted-computer/`apply_patch` call whose remote or
  filesystem outcome is not provable becomes `effect_unknown`.
- Missing, malformed, or contradictory receipt evidence becomes `quarantined`.
- `terminalization_unknown` cannot auto-admit.

Physical and effect truth are independent gates. Only an authoritative positive
exact-attempt physical cancellation/quiescence result together with
`effectDisposition=safe` permits `admit_replacement`. Temporal terminalization
without that physical result still releases the workflow from its unbounded
promise, but deterministically materializes a blocked `requires_action` state;
timer expiry, activity absence, and receipt safety alone never authorize a
runnable replacement.

The old physical activity may continue executing in-process after Temporal
terminalization. Every later database write is fenced. Every later pre-effect
receipt establishment is fenced. Therefore it cannot start a new effect after
the fence; an effect already past its pre-effect fence is represented by the
reconciliation result above.

### 6. Recover an exact failed session workflow

Heartbeat timeout or worker loss can fail the session workflow after logical
Steer settlement but before the workflow returns to its admission loop. A
retryable control activity first reads the exact workflow history by immutable
workflow/run/activity identity and supplies only a bounded terminal
fingerprint—never history payloads, prompts, tool data, or credentials—to one
idempotent PostgreSQL command:

```ts
type RecoverFailedCancellationWorkflowInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  episodeId: string;
  attemptId: string;
  interruptionId: string;
  failedWorkflowId: string;
  failedWorkflowRunId: string;
  failedActivityId: string;
  settlementRevision: number;
  operationKey: string;
};

type RecoverFailedCancellationWorkflowResult =
  | {
      action: "restart_enqueued" | "already_enqueued";
      replacementTurnId: string;
      admissionDisposition: "admit_replacement" | "requires_action";
      workflowWakeRevision: number;
    }
  | { action: "not_failed" | "stale" | "blocked" };
```

The command uses the OPE-63 lock prefix, then locks the exact cancellation
episode, predecessor attempt/interruption, canonical direction batch, session,
and replacement row. It verifies all of the following:

1. the supplied workflow/run/activity identity matches the immutable episode;
2. that exact run is durably classified `FAILED`, not merely absent or still
   closing;
3. the old attempt remains logically fenced and cannot establish a new
   pre-effect receipt;
4. OPE-73 and every other operation class have reached either positive safe
   truth or a typed `effect_unknown`/`quarantined` disposition; and
5. physical disposition is either positively `quiesced` or explicitly
   `not_confirmed` for a `requires_action` replacement.

It then materializes or reuses the one stable replacement turn and assigns the
existing direction/update batch exactly once. As the final mutation in that
same transaction it calls OPE-59's
`enqueueSessionWorkflowWakeInTransaction(...)`, stores the returned new
`recoveryWakeRevision`, and marks `workflowDisposition=restart_pending`. This
new revision is required even when the failed run's prior wake is already fully
delivered. Replay with the same `operationKey` returns the original replacement
and revision; it does not increment the outbox again.

The existing OPE-59 dispatcher uses `signalWithStart` for the same stable
session workflow ID with `ALLOW_DUPLICATE`, allowing Temporal to create one new
run after the failed run. The new workflow re-peeks PostgreSQL and may claim the
replacement only when `admissionDisposition=admit_replacement`; a
`requires_action` replacement remains non-runnable but truthfully visible. An
attempt-fenced acknowledgement records the observed new run ID and
`workflowDisposition=restarted`. A direct signal, the delivered old wake, or a
raw workflow start without the committed recovery revision is never the
correctness path.

If the session is paused, the recovery command preserves the replacement and
update assignment but returns no new wake revision until canonical Resume
commits it. If failure truth, physical truth, or effect truth is contradictory,
the command returns `blocked` and retains the exact evidence. It never marks
`quiesced_at`, deletes the failed run, fabricates a human message, or retries a
provider/tool effect.

### 7. Materialize exactly one replacement

One canonical transaction:

1. locks the cancellation episode and all direction updates in its bounded
   batch after the canonical OPE-63 prefix;
2. creates one `source=system` replacement turn with stable identity derived
   from the episode, or reuses the exact existing unclaimed turn after a lost
   response;
3. assigns the deterministic bounded pending internal-update batch to that turn
   exactly once, including every superseded direction update and exactly one
   canonical effective direction revision;
4. stores `replacementTurnId` and `materializedAt` on the cancellation episode;
5. emits the queue/status/settlement events;
6. advances session status and active turn truth; and
7. enqueues one revisioned workflow wake in the same transaction.

Disposition:

- `admit_replacement`: replacement is claimable immediately only after both
  authoritative physical quiescence and safe effect disposition.
- `requires_action`: replacement is materialized as a system turn in
  `requires_action`, with a bounded `cancellation_effect_unknown` approval
  payload that distinguishes unresolved physical execution from unknown effect
  outcome. It remains outside the human prompt queue. Approval may continue
  that exact turn only after the unresolved physical/effect condition has a
  typed safe resolution; reject settles it without replaying the old effect.

The assignment transaction is idempotent by episode, revision, update-assignment,
and replacement keys. A lost commit response re-reads and returns the original
turn. If another Steer committed before the unclaimed turn was consumed, the
same transaction retargets its bundle to that newer revision. It never leaves
the newer Steer pending behind the older replacement.

## Durable sandbox-operation cancellation seam

The existing `TurnToolCancellationFence` keeps PTY session IDs, marker paths,
PID/PGID identities, connected-machine operation IDs, and in-flight operation
promises only in worker memory. That is sufficient for cooperative finalization
but insufficient for a separate settlement activity.

OPE-75 needs a bounded, attempt-fenced operation ledger established before each
sandbox/tool operation starts. Its state machine is explicit:

```text
starting -> identified -> cancelling -> quiesced
    |            |              \----> effect_unknown / quarantined
    \------------+--------------------> effect_unknown / quarantined
```

`starting` commits before invocation and proves that the attempt crossed the
pre-effect boundary. `identified` commits atomically as soon as the concrete
PID/PGID/PTY, connected-operation, hosted-tool, or provider identity exists.
The identity payload is bounded and reconstructable without command text or
secrets:

```ts
type TurnOperationCancellationHandle =
  | {
      kind: "pty_process_group";
      sandboxGroupId: string;
      leaseEpoch: number;
      sandboxSessionId: number;
      markerTokenDigest: string;
      pid: number;
      processGroupId: number;
    }
  | {
      kind: "connected_machine_op";
      sandboxId: string;
      activeEpoch: number;
      operationId: string;
      connectionGeneration: number;
    };
```

Required rules:

- If Steer terminalizes the Temporal activity while the durable row is still
  `starting`, the operation is in the discovery gap. Missing in-memory identity
  is not proof that no effect began. Settlement records `effect_unknown` and
  does not auto-admit, kill a worker, release a sandbox, or guess a process.
- The command launcher writes an attempt-owned marker before `exec`, then
  persists marker-token digest, PID, PGID, PTY/session ID, sandbox group/holder,
  and lease epoch as one `identified` transition. A recovery canceller must
  re-establish that exact lease, verify marker/process identity, send the
  existing TERM/KILL sequence, and record positive exit/quiescence evidence.
- A connected-machine operation uses exact sandbox ID, active epoch, operation
  ID, and connection generation. `OpCancel` for a different epoch/generation is
  fenced; no machine-wide stop is allowed.
- Function/MCP/provider tools require the existing durable pre-effect call
  receipt plus a positive terminal/cancellation outcome. A merely delivered
  request is `effect_unknown`, never a retry instruction.
- Hosted computer actions and `apply_patch` require durable pre-effect and
  terminal receipts too. The receipt records stable tool/operation ID,
  attempt/generation, sandbox holder/epoch, and before/after workspace or
  provider digest where supported—not coordinates, patch text, file contents,
  or credentials. Memory-only cancellation is insufficient. An unconfirmed
  click/keypress/drag or file mutation enters `requires_action`; it is neither
  replayed nor silently discarded.
- A terminal/closed attempt cannot renew its operation or sandbox holder.
  Heartbeat, marker-finalization, and holder-release writes all recheck exact
  attempt, holder ID, and lease epoch. Idempotent cleanup may release only that
  stale holder; a successor holder or preserved filesystem is never released or
  deleted.

Store no command text, tool arguments, output, provider credentials, marker
secret, coordinates, patch body, or customer content. If an exact identity or
positive outcome cannot be reconstructed and verified, return
`effect_unknown`; do not kill a box, worker, pod, connected machine, or
unrelated process.

## Truthful public projection

Extend the queue/session projection with an additive typed settlement object:

```ts
type SessionCancellationSettlementProjection = {
  episodeId: string;
  turnId: string;
  attemptId: string;
  replacementTurnId: string | null;
  directionRevision: number;
  temporalDisposition:
    | "cancel_requested"
    | "terminalized"
    | "terminalization_unknown";
  workflowDisposition: "running" | "failed" | "restart_pending" | "restarted";
  recoveryWakeRevision: number | null;
  physicalDisposition: "not_confirmed" | "quiesced";
  effectDisposition: "reconciling" | "safe" | "effect_unknown" | "quarantined";
  admissionDisposition: "blocked" | "admit_replacement" | "requires_action";
};
```

`stoppingPreviousAttempt` remains `true` whenever an unresolved cancellation
settlement blocks admission, even when `items=[]`. The new object explains the
reason and avoids collapsing these distinct truths:

- cancellation requested but activity still pending;
- predecessor workflow failed and needs an exact revisioned restart;
- activity terminalized but physical worker still running;
- exact process physically quiesced;
- external effect outcome unknown and human action required; or
- replacement already admitted.

Session status, `active_turn_id`, queue head/tail, attempt/interruption receipt,
canonical direction revision, replacement turn, assigned updates, exact sandbox
holder/lease state, outbox revision, failed/restarted Temporal run, and activity
disposition must be asserted from one repeatable-read snapshot in API tests. A
session cannot project idle or `stoppingPreviousAttempt=false` while the current
episode is blocked, an exact operation or holder is unresolved, a failed run
has no committed recovery revision, or a replacement is materialized but
unclaimed. Conversely, historical settled interruptions with null legacy
`quiesced_at` are not current episodes and cannot keep the flag true after a
newer attempt is running or complete.

## Required deterministic coverage

### Workflow and replay

- cancellation-ignoring activity heartbeats beyond grace;
- cooperative termination just before, at, and after the timer boundary;
- force-terminalization response loss and idempotent retry;
- unacknowledged cancellation followed by the real heartbeat timeout: exact
  workflow failure is retained, the already-delivered old wake stays exhausted,
  and one idempotent recovery command commits one new restart revision;
- worker death during grace and during the control activity;
- worker death after recovery-revision commit and before `signalWithStart`, plus
  signal success before acknowledgement, both converge on one new workflow run;
- workflow-task replay and continue-as-new on every state transition;
- repeated Resume, Steer, `queueChanged`, and wake signals;
- concurrent Steers, lost Steer commit responses, Steer before/after
  materialization, and Steer after replacement claim all preserve one canonical
  newest direction without mutating consumed instructions;
- bounded time from durable supersession to replacement materialization or
  `requires_action`.

### Effect boundaries

- Steer during an in-flight model call: late output/history/usage is rejected;
  `prepared`, admitted-unlinked, linked-pending, and settled provider states
  take their distinct paths and no provider call is replayed;
- Steer during PTY/local/cloud sandbox command: exact PID/PGID cancellation and
  positive quiescence proof, plus `starting` discovery-gap failure before and
  after identity persistence;
- Steer during connected-machine command: exact operation cancellation, no
  whole-machine or unrelated-operation kill;
- Steer during MCP/function/computer/hosted-computer/`apply_patch`: durable
  pre-effect and terminal receipt where supported, otherwise explicit
  unknown-effect approval and no retry;
- Steer during OPE-73 model/tool/compaction persistence settlement:
  persistence-only reconciliation, no inference/tool replay;
- settlement while the physical old activity later attempts a new effect:
  pre-effect receipt fence rejects it;
- closed attempt and worker-overlap races reject late holder heartbeats and
  release only the exact stale holder/lease epoch while preserving a successor
  holder and the sandbox filesystem;
- late event/history/run-state/usage/tool-receipt/workspace-capture writes become
  bounded rejected-late evidence only.

### Database, queue, and wake

- pending internal updates before, during, and after Steer are each assigned
  once to the exact replacement batch;
- the Steer update is materialized once after lost commit response;
- two concurrent Steers select one canonical newest revision and assign the
  older update as superseded in the same batch;
- Steer against an unclaimed replacement atomically retargets its bundle;
  Steer after claim creates a bounded follow-up episode;
- concurrent materializers create one replacement turn;
- approval approve/reject is idempotent and never makes a human queue row;
- queue positions and `stoppingPreviousAttempt` remain truthful with no visible
  human/API item;
- historical settled interruptions with null legacy quiescence do not keep the
  current episode's stop flag true after a newer attempt runs or completes;
- wake revision commit-to-signal loss is repaired by the existing dispatcher;
- older delivery cannot mark a newer revision delivered;
- a failed workflow with `wakeRevision=deliveredRevision` gets exactly one new
  recovery revision; replay of the recovery command returns that revision and
  never copies or redelivers the Steer direction;
- OPE-63 barrier tests race receipt/materialization writers against title,
  usage, streaming, goal, and child-lifecycle writers in both arrival orders.

### Real-service fixture

The PostgreSQL/NATS/Temporal fixture contains two pre-fix controls. The first
proves exact cancellation releases the workflow and exposes the current unsafe
auto-admission/false-quiescence fallback. The second stops heartbeats only after
the activity reaches `CANCEL_REQUESTED`, waits for the real two-minute runtime
heartbeat timeout, and proves the workflow fails with the predecessor still
closed-but-unquiesced, the Steer update pending, the wake fully delivered, and
the next claim rejected. The first retains its physical zombie until after it
asserts:

- the exact Temporal activity disappears from `pendingActivities` before any
  workflow termination;
- a by-ID post-terminal heartbeat is rejected with `ActivityNotFoundError` and
  the workflow promise progresses naturally;
- the pre-fix workflow falsely writes `quiesced_at` while the zombie still
  runs; the post-fix variant must instead require positive physical proof;
- the workflow materializes exactly one replacement or typed `requires_action`
  state within the deterministic bound, and does not make a replacement
  runnable before positive physical quiescence;
- the old local activity loop still calls its heartbeat helper physically,
  independent of the server-side rejection;
- a late canonical event is rejected;
- the replacement runs once;
- all seven internal updates are assigned once;
- public and database truth agree; and
- cleanup targets only the disposable workflow/activity and zombie gate.

The failed-workflow control separately retains its local activity loop until
after it asserts:

- the activity first reaches `CANCEL_REQUESTED` and then stops heartbeating
  without acknowledging cancellation;
- the real heartbeat timeout removes the exact pending activity, rejects a
  by-ID heartbeat, and leaves the workflow `FAILED`;
- the attempt stays `closed/superseded` with `quiesced_at=NULL` and the
  interruption stays settled;
- the one Steer update remains pending, the wake revision equals its delivered
  revision with no error/retry, and a direct claim returns `control-pending`;
- no replacement dispatch or model call occurs; and
- the in-process loop continues executing until exact disposable cleanup.

The failed-workflow post-fix variant must additionally assert that the typed
recovery command:

- validates the exact failed workflow/run/activity identity;
- classifies physical and effect truth without inferring either from timeout;
- materializes the existing direction as one runnable replacement or one
  `requires_action` turn;
- commits exactly one new `recoveryWakeRevision` after the exhausted delivered
  revision;
- survives commit-to-signal and signal-to-ack worker death;
- starts one new run for the stable session workflow ID; and
- never invokes the old model/tool/provider effect or creates a human prompt.

## Production-safe canary design

No canary runs merely because this code exists. OPE-25/root owns the release
lane and must explicitly authorize it.

### Default no-effects canary

1. Create a disposable, isolated canary account/workspace/session with no repos,
   variables, credentials, MCP servers, packs, file resources, or sandbox.
2. Run the real `sessionWorkflow` on a dedicated canary task queue.
3. Register only the canary queue's `runAgentTurn` override: first dispatch
   claims canonically, heartbeats, and ignores cancellation without calling a
   model/tool/sandbox; replacement dispatch returns a scripted terminal result.
4. Issue the canonical Agent Steer command through the normal command service.
5. Assert the exact activity disappears, a by-ID heartbeat is rejected, the
   physical zombie remains gated, and the workflow reaches one replacement or
   typed `requires_action` within the configured bound without workflow
   termination.
6. Assert exact receipt/turn/attempt/interruption/update/outbox/API convergence,
   one rejected late event, one canonical direction revision, and no provider,
   MCP, computer, patch, or sandbox operation receipt.
7. Release the physical zombie gate, terminate only the disposable canary
   workflow if it failed to converge, and archive the canary rows/evidence.

This exercises the production binary, real PostgreSQL, real Temporal, real NATS,
normal command service, exact force-terminalization path, and public projection
without provider inference or external effects. It uses no Azure model credits.

A separately authorized failure-path variant may stop only the disposable
activity's heartbeats after `CANCEL_REQUESTED` while leaving its local no-effect
loop gated. It waits for the normal heartbeat timeout, proves the exact workflow
is `FAILED` and the old wake exhausted, invokes only the supported typed
failed-run recovery command, and requires one new wake revision/run plus one
replacement or `requires_action`. It must not use raw SQL, `temporal workflow
start`, a human prompt, or any incident session. This slower variant is not a
routine deployment smoke test; root/OPE-25 must grant it explicitly.

### Optional sandbox canary

Only with a separate root-authorized disposable-sandbox grant, run a harmless
long `sleep` in a dedicated canary box and prove the durable cancellation handle
passes through `starting -> identified -> cancelling -> quiesced`, stops its
exact process group, rejects a stale holder heartbeat, and preserves the box and
filesystem. Never run this in a customer or unpushed-work sandbox. Never kill a
shared worker pod.

## Collision-free landing sequence

1. Keep the failing fixture and this record additive on the OPE-75 branch.
2. Freeze/land OPE-63's canonical lock and persistence-only retry exports.
3. Freeze/land OPE-73's model-call admissions and persistence receipts; consume
   the final typed dispositions through a narrow cancellation adapter. OPE-75
   does not cherry-pick partial owner internals or migrations.
4. Freeze/land OPE-59's wake export after OPE-63 lock integration; call it only
   as the final write in OPE-75's same transaction.
5. Root grants OPE-75 explicit ownership of the narrow overlapping call sites.
6. Implement new OPE-75 modules first, then the smallest integrations:
   - deterministic activity identity and bounded workflow race;
   - exact Temporal terminalization control activity;
   - cancellation-settlement DB module and migration;
   - exact failed-run classification, idempotent recovery revision, and
     workflow restart acknowledgement;
   - durable sandbox-operation cancellation handles;
   - replacement materialization/update assignment;
   - contracts/API projection and focused UI truth;
   - tests and canary harness.
7. Update `AGENTS.md`, `docs/architecture.md`, and `docs/run-lifecycle.md` in the
   implementation commit, not in the reproducer-only commit.
8. Run focused tests, real PostgreSQL/NATS/Temporal suites, full typecheck/lint/
   format/docs checks, exact-head CI, and independent Sol/xhigh review.
9. Open or update the OPE-75 PR. Do not merge, release, deploy, or run a canary;
   root and OPE-25 serialize those lanes.

## Rejected shortcuts

- changing cancellation type to `TRY_CANCEL`/`ABANDON` and immediately claiming
  replacement work;
- treating `reportCancellation`, missing pending activity, heartbeat failure,
  grace expiry, or workflow completion as physical quiescence;
- treating workflow `FAILED` as physical quiescence or clearing the predecessor
  claim fence so a queued turn can run;
- treating an admitted-but-unlinked provider call or a `starting` operation
  without exact identity as proof that no effect occurred;
- setting `quiesced_at` from a timer;
- retrying `runAgentTurn` or replaying provider/tool calls;
- killing a worker pod, sandbox, connected machine, or process without an exact
  validated attempt-owned identity;
- leaving the Steer update pending until unrelated user work wakes the session;
- pinning a replacement forever to the first Steer update while newer committed
  directions remain orphaned;
- materializing an Agent Steer as a visible human/API queue row;
- adding another wake scanner or recurring model poll;
- expecting a fully delivered old wake revision to restart a failed workflow,
  or starting one without a committed idempotent recovery revision;
- writing cancellation receipts outside OPE-63's canonical lock prefix; and
- placing raw model/tool payloads, command text, credentials, or sandbox output
  in Temporal payloads, cancellation receipts, heartbeats, errors, or logs.