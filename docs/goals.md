# Session goals

Agents stop prematurely. A session goal flips the default: while a goal is
`active`, settling the last non-terminal turn arms a durable obligation to
record one typed goal-continuation internal update ("your goal is not done —
keep working, or explicitly complete/pause it"). That update joins the next
eligible internal batch and never becomes a human queue row. Finishing or
pausing the goal is an explicit act: the agent calls `opengeni__goal_complete`
with evidence or `opengeni__goal_pause` with a rationale, or a user controls
the goal directly. Workstream Pause is separate: it holds inference without
changing goal state.

Goal state is one durable Postgres row per session (`session_goals`,
RLS-isolated like every other workspace table). Its monotonic
`continuation_wake_revision` and `continuation_observed_revision` are the
authoritative obligation ledger: `wake > observed` means an evaluation still
has to be materialized. The Temporal workflow never owns that state — it reads
and mutates it only through activities. Temporal signals, workflow runs, and
workflow history are replaceable delivery nudges over Postgres truth. Goal and
workflow-wake revisions are bounded to JavaScript's maximum safe integer in
Postgres, so corruption or theoretical exhaustion fails the producing
transaction instead of rounding one producer's revision into another's.

## Lifecycle

A goal is `active`, `paused`, or `completed`.

- `goal_set` (agent tool), `CreateSessionRequest.goal`, or
  `ScheduledTaskAgentConfig.goal` create it. Setting a goal on a session that
  already has one replaces it in place: text/criteria are overwritten, the goal
  is re-activated (even from `paused`/`completed`), the version bumps, progress
  counters reset, and a new monotonic continuation revision is armed. Revision
  numbers themselves never reset or move backward.
- `goal_update` revises text/criteria or records a progress note. The version
  bump counts as progress for the no-progress detector. Status is unchanged.
  Agent calls require a stable UUID `idempotencyKey`. That operation identity
  belongs to the target session across replacement attempts, while its durable
  receipt retains the attempt that first applied it for audit. The receipt,
  exact result snapshot, goal revision, session-sequenced `goal.updated` event,
  and mutation commit atomically. A recovered attempt can therefore reconcile
  a lost response without applying the update twice; replaying an older key
  returns its stored result and never overwrites a newer goal revision.
- `goal_complete { evidence }` is terminal. Only a new `goal_set` can replace a
  completed goal.
- `goal_pause { rationale }` stops the loop until the goal is resumed or
  replaced.

Every transition lands on the session timeline as `goal.set`, `goal.updated`,
`goal.completed`, `goal.paused`, `goal.resumed`, `goal.cleared`, or
`goal.continuation` events.

## The continuation loop

The continuation is a revisioned obligation, not a workflow polling loop:

1. Terminal settlement of the last active turn atomically advances the active
   goal's wake revision and the session workflow-wake outbox. A worker death or
   lost activity response after that commit cannot leave an admitted idle goal
   with no wake.
2. Direct delivery uses `signalWithStart`; the workflow-wake dispatcher retries
   an undelivered revision with bounded backoff. A completed workflow, worker
   restart, or `continueAsNew` therefore does not own or erase the obligation.
3. At an idle boundary `maybeContinueGoal` materializes the revision in one
   Postgres transaction. It locks and re-checks admission, session, goal,
   non-terminal turns, authoritative Steer work, existing continuation updates,
   and provider-capacity waiters before evaluating progress and limits.
4. A successful decision atomically commits the progress mutation, one
   `goal_continuation` system update, `system.update.pending` and
   `goal.continuation` events, one `agent_run.created` usage fact, the observed
   revision, session state/sequence, and another workflow-wake outbox revision.
   If any write fails, all of them roll back. The stable dedupe key is
   `goal-continuation:<goalId>:wake:<wakeRevision>`, so a retry after a lost
   commit response cannot spend the continuation count or create a second
   update, usage fact, event pair, or logical goal turn.

The locked decision applies these rules:

1. No goal, or goal not `active` → idle shutdown, exactly as before.
2. Any non-terminal turn exists (`queued`, `running`, `requires_action`,
   `recovering`, or `waiting_capacity`) →
   the queue wins. A pending human approval is never bypassed by a
   continuation.
   A pending human/API prompt and an authoritative Steer instruction also win
   even if they race materialization.
3. Otherwise progress since the previous continuation is scored: a continuation
   turn that produced zero tool calls and no goal revision increments a
   no-progress streak (a user/scheduled turn in between resets the streak and
   the budget — human re-engagement re-arms the loop).
4. Guards: `noProgressStreak >= OPENGENI_GOAL_NO_PROGRESS_LIMIT` (default 3)
   auto-pauses the goal with a visible `goal.paused` event
   (`reason: "no_progress"`). Goals are NOT capped by continuation count by
   default — runs legitimately span days, so length is governed by progress
   and budget guards, never by count. If a deployment sets
   `OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS` it becomes a hard ceiling
   (`min(goal.maxAutoContinuations, setting)`, pause reason
   `"max_auto_continuations"`); a per-goal `maxAutoContinuations` applies on
   its own even without the deployment setting.
5. Otherwise one deterministic goal-continuation internal update is recorded,
   referencing the goal text and success criteria, the session's tool surface
   plus the first-party `opengeni` MCP server (so the goal tools are always
   reachable), and the session's stored conversation — the agent keeps its full
   context. It may start one internal-update inference only after queued human
   prompts and approvals, and only while the effective workstream gate is active.
   Its model and reasoning effort come from the newest turn that durably emitted
   `turn.started`, falling back to the session default only when no turn has
   actually run. This preserves an explicit per-turn provider/billing selection;
   a newer turn rejected during admission cannot poison the continuation policy.
   That conversation comes from `session_history_items`, the one SDK-native
   model-memory store (see `docs/run-lifecycle.md`).

The resulting internal-update inference is an ordinary billed run: it meters
`agent_run.created` with source `session_system_update` and streams like a
user-triggered inference without appearing in the prompt queue. If billing or
usage limits would block another run, the goal pauses visibly
(`goal.paused`, `reason: "limits"`) instead of failing the session; the limits
gate is applied inside the same locked decision, before the counter bump, so a
budget pause never consumes continuation budget. Re-arming a goal (resume or
replace) starts a fresh continuation epoch: counters and the
previous-continuation pointers are cleared together. A worker can re-dispatch a
recovering logical goal turn under a new fenced attempt after death; that is
recovery of the same turn, not creation or charging of another continuation.

## Pauses and failures

- Workstream Pause preserves an active goal. Its recursive admission gate keeps
  the goal's internal continuation inert; Resume admits it again without
  inventing a prompt or silently changing goal status. Resume advances a
  revision and commits a repairable workflow wake, so it also works after the
  previous workflow run closed.
- If a turn fails and the session is marked `failed`, the goal row is left
  as-is. A new human prompt can revive the session; it does not silently resume
  a goal that the user paused.
- Provider backpressure persists a capacity waiter. It blocks goal
  materialization until authoritative allocator re-evaluation records recovery;
  no model polling or synthetic human message is used.
- If the `maybeContinueGoal` activity exhausts its short Temporal retry window,
  the workflow records a delayed durable retry wake and closes rather than
  failing the session or spinning. The outbox restarts the workflow with
  `signalWithStart` after the backoff. The same rule covers a lost workflow
  signal/start and survives `continueAsNew`.
- The materializer has one explicit invariant-repair path for an admitted idle
  active goal reached without a wake revision: it first persists a new
  monotonic obligation and then evaluates it. This is crash repair, not a scan
  or polling path. The API exposes the unarmed state as broken until repair
  commits.

## API

- `POST /v1/workspaces/:id/sessions` accepts `goal: { text, successCriteria?,
  maxAutoContinuations? }`. A `goal.set` event is appended right after
  `session.created`.
- `GET /v1/workspaces/:id/sessions/:sessionId/goal` returns the goal plus a
  `continuation` projection from one repeatable-read Postgres snapshot
  (`sessions:read`; 404 when the session has no goal). The projection reports
  `inactive`, `scheduled`, `running`, `blocked`, or `invariant_broken`, with a
  typed reason, wake/observed revisions, optional next-attempt time, and the
  latest workflow-wake error. Clients must not infer autonomy from goal/session
  status alone: `running` is reserved for a live goal-owned turn and alone
  means "Pursuing". A live human/API or system turn blocks autonomous
  continuation; recovering or queued work is scheduled. Pause, approval,
  provider backpressure, cancellation, pending wake/update, and a missing
  obligation are distinct truthful states.
- `PATCH /v1/workspaces/:id/sessions/:sessionId/goal` with
  `{ status: "paused" | "active", rationale? }` is the operator override
  (`sessions:control`). Pausing emits `goal.paused` (`actor: "api"`). Resuming
  is only valid from `paused`: it resets the counters, emits `goal.resumed`,
  and wakes the session workflow — resume works even on a fully idle session
  because `signalWithStart` restarts a completed workflow. Invalid transitions
  (e.g. resuming a completed goal) return 409.
- `DELETE /v1/workspaces/:id/sessions/:sessionId/goal` clears the session's
  active goal (`sessions:control`). It deletes the goal row, emits
  `goal.cleared` when a goal existed, and is idempotent when no goal exists.

## Scheduled tasks

`agentConfig.goal` arms a goal on dispatched sessions. New-session runs create
the goal with the session; reusable-session runs re-arm it on every fire
(replace text, reactivate, reset counters) — a recurring "maintain X" task
re-establishes its objective each time.

## Agent tool access

The goal tools are session-scoped first-party MCP tools. The worker signs the
session id into the delegated access token it uses for first-party MCP calls
(HMAC, worker-asserted — not agent-controlled), and the API registers
`goal_set`/`goal_update`/`goal_complete`/`goal_pause` only for grants carrying
that claim plus the `goals:manage` permission. Goal-bearing sessions, turns,
and scheduled dispatches force-merge the `opengeni` tool ref so these tools are
reachable even when the session was created with an empty tool list. The
worker also signs the exact turn, attempt, and execution generation used to
authorize a first application of `goal_update`; a replacement attempt may
reconcile the same target-scoped operation key, but a key reused with different
arguments is rejected as `IDEMPOTENCY_KEY_REUSED`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS` | _(unset — no cap)_ | Optional hard ceiling on synthesized continuation turns per goal arming. Unset by default: goals are bounded by the progress and budget guards, not by count, so a run can legitimately span days. When set, it is a ceiling that a per-goal `maxAutoContinuations` can only lower. |
| `OPENGENI_GOAL_NO_PROGRESS_LIMIT` | `3` | Consecutive zero-progress continuations tolerated before auto-pause. |
