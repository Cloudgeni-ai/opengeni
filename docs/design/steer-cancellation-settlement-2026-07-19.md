<!-- docs-refs: record -->

> **Point-in-time OPE-75 landing record.** Written against `origin/main`
> `3dadb5555f1612a7bf9e2568f74168a64f652ed0`, OPE-59 draft head
> `1540bc659170c7747d7366c214493ca70b89c9bf`, OPE-63 draft head
> `b5fa270b1f7df5c528bb9b48b82ecef37c1007dc`, and OPE-73 draft head
> `19cb1d4c84e4bd19c1fa56553b0efba7d1c48cb3`. These branches are not merged
> dependencies. Paths and symbols may move. Shipped code and current-tier docs
> win after landing.

# Steer cancellation settlement — bounded landing contract

## Status

OPE-75 has a deterministic failing fixture on branch
`fix/ope-75-bounded-cancellation-settlement`, commit
`6115caa84f5f9441fcd6beb1b6d454f213e39f48`:

```text
test/integration/steer-cancellation-deadlock.fixture.test.ts
```

The fixture passes as a reproduction against real PostgreSQL 17, NATS, and
Temporal. It deliberately demonstrates the broken end state; it does not claim
that cancellation settlement is implemented.

Implementation is intentionally blocked from the overlapping runtime and
database files until the OPE-63, OPE-73, and OPE-59 owners freeze the typed seams
listed below. OPE-63's current integration worktree was lost with an ephemeral
sandbox, and OPE-73 is actively changing the exact activity/persistence files.
Racing either owner would be less safe than preserving this fixture and landing
plan.

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

The real-service fixture additionally proves:

- `AsyncCompletionClient.reportCancellation` can terminalize the exact Temporal
  activity and release the workflow promise;
- that server-side terminalization does **not** stop the physical activity;
- the physical activity can keep heartbeating after Temporal rejects it as no
  longer pending; and
- therefore Temporal terminalization alone must never set `quiesced_at`.

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

OPE-75 consumes the final PostgreSQL-owned persistence receipt contract rather
than inspecting or rewriting its internals. The seam should expose one exact,
idempotent cancellation reconciliation operation:

```ts
type ReconcileAttemptPersistenceForCancellationInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

type ReconcileAttemptPersistenceForCancellationResult =
  | { action: "settled" }
  | {
      action: "effect_unknown";
      callIds: string[]; // bounded, stable IDs only; never arguments/output
      effectKinds: Array<"sandbox" | "mcp" | "function" | "computer" | "other">;
    }
  | { action: "quarantined"; reasonCode: string }
  | { action: "stale" };
```

The OPE-73 implementation remains the sole owner of receipt validation,
obligation digesting, model/history/usage settlement, tool-call registration,
receipt quarantine, and persistence-only retry. OPE-75 treats
`effect_unknown`/`quarantined` as an admission decision, not as permission to
rerun the old effect.

### OPE-59/OPE-50: revisioned workflow wake

Replacement materialization uses the final
`enqueueSessionWorkflowWakeInTransaction` contract in the same transaction as
turn/update assignment. It does not create a scanner, recurring model poll,
parallel outbox, or direct-signal-only correctness path. Direct delivery remains
a latency optimization, and the existing dispatcher repairs commit-to-signal
loss.

## Proposed durable cancellation receipt

Use a new additive table owned by OPE-75 (final name may follow the merged schema
convention), keyed uniquely by the exact attempt/interruption pair:

```ts
type SessionAttemptCancellationSettlement = {
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
  physicalDisposition: "not_confirmed" | "quiesced";
  effectDisposition:
    | "reconciling"
    | "safe"
    | "effect_unknown"
    | "quarantined";
  admissionDisposition: "blocked" | "admit_replacement" | "requires_action";

  replacementUpdateId: string;
  replacementTurnId: string | null;
  requestRevision: number;
  terminalizedAt: Date | null;
  quiescedAt: Date | null;
  materializedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
```

Required constraints:

- unique `(workspace_id, attempt_id, interruption_id)`;
- unique `(workspace_id, replacement_update_id)`;
- unique non-null `(workspace_id, replacement_turn_id)`;
- foreign keys retain account/workspace/session/turn/attempt/interruption truth;
- exact workflow/run/activity identity is immutable after insert;
- `physicalDisposition=quiesced` requires the existing attempt's
  `quiesced_at` to be non-null;
- `admit_replacement` requires `effectDisposition=safe`;
- `requires_action` requires `effect_unknown` or `quarantined`;
- Temporal `terminalized` never implies physical `quiesced`.

Do not overload `session_turn_attempts.quiesced_at` with a grace timeout or a
successful Temporal RPC. The additive receipt is the authority for bounded
admission when physical quiescence is unavailable.

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
- creates/upserts the cancellation-settlement receipt in `blocked` state; and
- commits the revisioned workflow wake.

Repeated Steer/Resume/wake requests replay their existing receipt/result or
append a distinct new typed update; they do not create a second settlement for
the same interruption.

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

After ordinary termination or forced Temporal terminalization, call the OPE-73
cancellation reconciliation seam.

- `settled`, with no active durable sandbox operation, yields
  `effectDisposition=safe`.
- A durable sandbox operation with a reconstructable exact cancellation handle
  is cancelled through that handle. Only a positive process/op quiescence proof
  sets both the attempt and receipt `quiesced`.
- An MCP/function/computer call whose remote outcome is not provable becomes
  `effect_unknown`.
- Missing, malformed, or contradictory receipt evidence becomes `quarantined`.
- `terminalization_unknown` cannot auto-admit.

The old physical activity may continue executing in-process after Temporal
terminalization. Every later database write is fenced. Every later pre-effect
receipt establishment is fenced. Therefore it cannot start a new effect after
the fence; an effect already past its pre-effect fence is represented by the
reconciliation result above.

### 6. Materialize exactly one replacement

One canonical transaction:

1. locks the settlement receipt and exact still-unassigned Steer update after
   the canonical OPE-63 prefix;
2. creates one `source=system` replacement turn with stable identity derived
   from the Steer update/settlement receipt;
3. assigns the deterministic bounded pending internal-update batch to that turn
   exactly once;
4. stores `replacementTurnId` and `materializedAt` on the settlement receipt;
5. emits the queue/status/settlement events;
6. advances session status and active turn truth; and
7. enqueues one revisioned workflow wake in the same transaction.

Disposition:

- `admit_replacement`: replacement is claimable immediately.
- `requires_action`: replacement is materialized as a system turn in
  `requires_action`, with a bounded `cancellation_effect_unknown` approval
  payload. It remains outside the human prompt queue. Approve continues that
  exact turn; reject settles it without replaying the old effect.

The assignment transaction is idempotent by the unique update and replacement
keys. A lost commit response re-reads and returns the original turn.

## Durable sandbox-operation cancellation seam

The existing `TurnToolCancellationFence` keeps PTY session IDs, marker paths,
PID/PGID identities, connected-machine operation IDs, and in-flight operation
promises only in worker memory. That is sufficient for cooperative finalization
but insufficient for a separate settlement activity.

OPE-75 needs a bounded, attempt-fenced operation ledger established before each
sandbox operation starts:

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

Store no command text, tool arguments, output, provider credentials, marker
secret, or customer content. The out-of-band canceller re-establishes the exact
existing sandbox/session, validates epoch and process identity, sends the same
TERM/KILL or `OpCancel` sequence, and records a positive quiescence proof. If
identity cannot be reconstructed or verified, it returns `effect_unknown`; it
does not kill a box, worker, pod, or unrelated process.

Generic MCP/function/computer calls without a provider cancellation receipt do
not pretend to be cancellable. They enter the typed approval path.

## Truthful public projection

Extend the queue/session projection with an additive typed settlement object:

```ts
type SessionCancellationSettlementProjection = {
  turnId: string;
  attemptId: string;
  replacementTurnId: string | null;
  temporalDisposition:
    | "cancel_requested"
    | "terminalized"
    | "terminalization_unknown";
  physicalDisposition: "not_confirmed" | "quiesced";
  effectDisposition: "reconciling" | "safe" | "effect_unknown" | "quarantined";
  admissionDisposition: "blocked" | "admit_replacement" | "requires_action";
};
```

`stoppingPreviousAttempt` remains `true` whenever an unresolved cancellation
settlement blocks admission, even when `items=[]`. The new object explains the
reason and avoids collapsing these distinct truths:

- cancellation requested but activity still pending;
- activity terminalized but physical worker still running;
- exact process physically quiesced;
- external effect outcome unknown and human action required; or
- replacement already admitted.

Session status, `active_turn_id`, queue head/tail, attempt/interruption receipt,
replacement turn, assigned updates, outbox revision, and Temporal disposition
must be asserted from one repeatable-read snapshot in API tests.

## Required deterministic coverage

### Workflow and replay

- cancellation-ignoring activity heartbeats beyond grace;
- cooperative termination just before, at, and after the timer boundary;
- force-terminalization response loss and idempotent retry;
- worker death during grace and during the control activity;
- workflow-task replay and continue-as-new on every state transition;
- repeated Resume, Steer, `queueChanged`, and wake signals;
- bounded time from durable supersession to replacement materialization or
  `requires_action`.

### Effect boundaries

- Steer during an in-flight model call: late output/history/usage is rejected;
  no provider call is replayed;
- Steer during PTY/local/cloud sandbox command: exact PID/PGID cancellation and
  positive quiescence proof;
- Steer during connected-machine command: exact operation cancellation, no
  whole-machine or unrelated-operation kill;
- Steer during MCP/function/computer call: explicit unknown-effect approval,
  no retry;
- Steer during OPE-73 model/tool/compaction persistence settlement:
  persistence-only reconciliation, no inference/tool replay;
- settlement while the physical old activity later attempts a new effect:
  pre-effect receipt fence rejects it;
- late event/history/run-state/usage/tool-receipt/workspace-capture writes become
  bounded rejected-late evidence only.

### Database, queue, and wake

- pending internal updates before, during, and after Steer are each assigned
  once to the exact replacement batch;
- the Steer update is materialized once after lost commit response;
- concurrent materializers create one replacement turn;
- approval approve/reject is idempotent and never makes a human queue row;
- queue positions and `stoppingPreviousAttempt` remain truthful with no visible
  human/API item;
- wake revision commit-to-signal loss is repaired by the existing dispatcher;
- older delivery cannot mark a newer revision delivered;
- OPE-63 barrier tests race receipt/materialization writers against title,
  usage, streaming, goal, and child-lifecycle writers in both arrival orders.

### Real-service fixture

The existing 21-assertion PostgreSQL/NATS/Temporal fixture remains the pre-fix
control. The post-fix variant must retain the physical zombie until after it
asserts:

- the exact Temporal activity is terminalized;
- the workflow admits/materializes the replacement within the deterministic
  bound;
- the old activity still heartbeats physically;
- a late canonical event is rejected;
- the replacement runs once;
- all seven internal updates are assigned once;
- public and database truth agree; and
- cleanup targets only the disposable workflow/activity and zombie gate.

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
5. Assert the exact receipt/turn/update/outbox/API/Temporal convergence and one
   rejected late event.
6. Release the physical zombie gate, terminate only the disposable canary
   workflow if still necessary, and archive the canary rows/evidence.

This exercises the production binary, real PostgreSQL, real Temporal, real NATS,
normal command service, exact force-terminalization path, and public projection
without provider inference or external effects. It uses no Azure model credits.

### Optional sandbox canary

Only with a separate root-authorized disposable-sandbox grant, run a harmless
long `sleep` in a dedicated canary box and prove the durable cancellation handle
stops its exact process group while preserving the box. Never run this in a
customer or unpushed-work sandbox. Never kill a shared worker pod.

## Collision-free landing sequence

1. Keep the failing fixture and this record additive on the OPE-75 branch.
2. Freeze/land OPE-63's canonical lock and persistence-only retry exports.
3. Freeze/land OPE-73's persistence receipts and provide the typed cancellation
   reconciliation seam. OPE-75 does not cherry-pick partial owner internals.
4. Identify/freeze OPE-59's final wake export and migration sequence.
5. Root grants OPE-75 explicit ownership of the narrow overlapping call sites.
6. Implement new OPE-75 modules first, then the smallest integrations:
   - deterministic activity identity and bounded workflow race;
   - exact Temporal terminalization control activity;
   - cancellation-settlement DB module and migration;
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
- setting `quiesced_at` from a timer;
- retrying `runAgentTurn` or replaying provider/tool calls;
- killing a worker pod, sandbox, connected machine, or process without an exact
  validated attempt-owned identity;
- leaving the Steer update pending until unrelated user work wakes the session;
- materializing an Agent Steer as a visible human/API queue row;
- adding another wake scanner or recurring model poll;
- writing cancellation receipts outside OPE-63's canonical lock prefix; and
- placing raw model/tool payloads, command text, credentials, or sandbox output
  in Temporal payloads, cancellation receipts, heartbeats, errors, or logs.