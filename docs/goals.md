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
The standing objective has a separate monotonic `objective_revision`; the
existing `version` remains the continuation/lifecycle fence. Every logical
turn freezes either the exact goal projection or an explicit no-goal projection
in `session_turns.goal_snapshot` when the turn is accepted. Ordinary turns,
goal continuations, recovery, and both compaction modes use only that snapshot,
never a later mutable goal head. The snapshot is rendered on the turn's newest
durable model-input item: a leading part of a human/API user message, or the
canonical user-role continuation message for a goal-owned turn. Other machine
updates coalesced into that turn are attached as ordinary message context. It never mutates the persistent
agent-instruction prefix or exists only in activity memory, so later requests
extend the same prompt-cache prefix and recovery replays identical authority.

## Migration 0257 deployment boundary

Migration `0257_goal_revision_decisions_and_root_constraints.sql` is a one-way
maintenance cutover, not a rolling application change. Stop every API,
control-worker, and turn-worker process before applying it. Set
`OPENGENI_MIGRATION_APPLICATION_DATABASE_ROLES` to the comma-separated exact
database logins used by every old and new API/worker identity, then run the
migration. The programmatic equivalent is
`runMigrations(adminUrl, schema, { applicationDatabaseRoles: [...] })`;
dedicated-schema/scoped deployments must use that explicit option. Only the
canonical standalone `opengeni_app` topology has a default. Migration 0257
checks the supplied roles both before and after taking exclusive locks and
aborts with SQLSTATE `55000` when any listed identity remains connected. Do not
derive the list from the migration-owner URL or omit a retired identity during
a role rotation.
After commit, never restart a pre-0257 image: an old worker does not understand
the accepted-turn `rootConstraints` snapshot and would execute without that
frozen authority. Application rollback is valid only before migration
activation; afterward, recovery is forward-only with a 0257-compatible image.

## Lifecycle

A goal is `active`, `paused`, or `completed`.

- `goal_set` (agent tool), `CreateSessionRequest.goal`, or
  `ScheduledTaskAgentConfig.goal` create it. Setting a goal on a session that
  already has one remains a supported low-level/API/scheduler redirect: it
  re-activates the goal, resets continuation counters, and arms a wake. The
  agent-facing `goal_set` creates when no goal exists or replaces a completed
  goal, and accepts only `text` and `successCriteria`: `maxAutoContinuations`
  is API/scheduled-task configuration (an agent that capped its own goal used
  to silence its orchestration for hours). Active and paused goals are changed
  through the policy-fenced `goal_update`, so an incidental set cannot silently
  redirect live intent.
- `goal_update` declares `refinement`, `adaptation`, or `replacement`, a
  rationale, and the expected objective revision. `review_changes` always
  records an immutable proposal; `preserve_intent` directly applies only a
  refinement; `autonomous_adaptation` may apply every declared kind. API/user
  redirects apply directly. An applied semantic change advances both objective
  and lifecycle revisions but is not execution progress. Proposed content is
  not composed into model instructions until a user applies it.
- Root constraints are bounded, normalized standing constraints that may be
  changed only through the direct human/API path. Every accepted turn freezes
  them with its goal snapshot. A goal-bearing child inherits the calling
  turn's exact frozen set when the field is omitted, while an explicit array
  may only narrow that set. Explicit `[]` delegates no root constraints.
- `goal_progress` optionally records a concrete, attempt-fenced audit fact without
  changing text, criteria, policy, objective revision, or lifecycle version.
  Legacy `goal_update.progressNote` calls route through this separate operation.
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
- `goal_wait { reason, untilSeconds, idempotencyKey? }` declares a
  continuation hold: the active goal's next automatic continuation waits for
  child results, an agent message, a human prompt, or the deadline instead of
  materializing as soon as the declaring turn ends. It is for progress that
  depends on child sessions or an external event, never a substitute for
  `goal_pause` when a human decision is required, and the agent must end its
  turn right after calling it. `untilSeconds` is mandatory (30 s to 7 days),
  the reason is bounded to 2 KiB, and the hold, its `goal.held` timeline fact,
  and the target-scoped operation receipt commit together under the canonical
  goal event-write prefix. See "The continuation loop" for what honors and
  clears a hold.

New goal text and success criteria are each limited to 8 KiB of UTF-8, rewrite
and pause rationales to 2 KiB, and progress notes to 4 KiB. Root constraints
are limited to 16 items, 512 UTF-8 bytes per item, and 4 KiB in aggregate.
Pre-0257 goals remain exact and lifecycle-mutable even when larger. Their immutable
accepted-turn prompt snapshot uses a deterministic UTF-8 prefix with an
explicit original-byte truncation fact, so ordinary turns, recovery, and
compaction stay bounded without rewriting canonical history.

Every transition lands on the session timeline as `goal.set`, `goal.updated`,
`goal.progress`, `goal.rewrite.proposed`,
`goal.completed`, `goal.paused`, `goal.resumed`, `goal.cleared`, `goal.held`,
or `goal.continuation` events.

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
   and provider-capacity waiters before evaluating limits.
4. A successful decision atomically commits the continuation counter, one
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
   even if they race materialization. Any other pending machine input
   (`session_system_updates` row such as a child result, agent message, or
   schedule) also wins with `queue`: it is delivered by the next claim rather
   than shadowed by a synthesized continuation, and because peek and
   materialization serialize on the session lock, input that lands between
   them cannot be missed. Against a CURRENT `goal_wait` hold (rule 3) only an
   `immediate`-class pending row wins; `deferred` child lifecycle notices
   (`child_requires_action_resolved`, `child_paused`,
   `child_waiting_capacity`, `child_progress`) leave the hold in place and are
   delivered when it ends or an immediate input arrives
   (`peekSessionWork` mirrors this and reports `idle`). See
   [`durable-agent-inputs.md`](durable-agent-inputs.md) for the wake classes.
3. An agent-declared `goal_wait` hold is honored only while its declaring turn
   is still the latest finished turn and `now < continuation_hold_until`. The
   materializer then returns `held`: it does not advance
   `continuation_observed_revision` (a crash cannot lose the obligation) and,
   in the same transaction, re-arms a delayed workflow wake
   (`goal_hold_deadline`, `notBefore = hold_until`) through the session
   workflow-wake outbox. Re-arming on every idle evaluation is required: an
   earlier immediate wake (for example a child result) delivered in between
   advances the outbox's delivered revision and would otherwise drop the
   deadline row; an undelivered earlier wake coalesces with
   `least(next_attempt_at, notBefore)`. A hold that belongs to an older turn or
   whose deadline has passed is cleared in that same transaction and
   evaluation continues as before. "Newest finished turn" is ordered by
   finish time everywhere (materializer, evaluator, backoff, and the API
   projection): a human prompt queued after internal turns takes a low
   normalized queue position, yet it is the newer truth that retires a hold.
   Every goal head mutation clears the hold
   inside its own transaction: human/API `PATCH` (pause, resume, redirect),
   `DELETE`, agent `goal_set`, `goal_complete`, `goal_pause`, and an applied
   `goal_update` revision (a `review_changes` proposal-only outcome records
   evidence but does not touch the head, so it leaves the hold in place). So a
   human redirect never sits behind an agent-declared wait. The scheduled-run
   re-arm (`upsertScheduledSessionGoalForRun`) replaces the goal through the
   same `upsertSessionGoal` path and therefore clears it as well. The API
   projects a current hold as `blocked` / `held_for_input` with
   `nextAttemptAt` at the deadline, and the deadline comparison uses the
   transaction's database clock, the same clock the wake-outbox dispatcher
   fires on.
4. Consecutive no-input continuations are paced, not capped. `auto_continuations`
   counts only consecutive synthesized continuations whose claimed batch
   contained no other machine input and that no human/API/Steer turn
   interrupted: the claim transaction that binds a goal turn to its exact batch
   resets the streak when any other member (child result, agent message,
   schedule) rides along, a human/API/scheduled turn finishing after the last
   continuation resets it, and a Steer supersession resets it. When the
   streak is `n >= 1` and the last continuation turn is still the newest
   finished turn, the materializer defers the next continuation until
   `finished_at + schedule[min(n - 1, last)]` (`OPENGENI_GOAL_IDLE_BACKOFF_MS`,
   default `3000,30000,120000,300000`, every delay bounded by
   `OPENGENI_GOAL_IDLE_BACKOFF_MAX_MS`, default 600000). It returns
   `deferred` without touching the wake/observed ledger, counters, updates, or
   usage, and re-arms a delayed workflow wake (`goal_idle_backoff`,
   `notBefore` at the deadline) through the session workflow-wake outbox on
   every idle evaluation, exactly like the hold; the deadline lives only in
   `session_workflow_wake_outbox.next_attempt_at`, never in a Temporal timer or
   a new column. Any new input (pending machine input, a human prompt, Steer)
   commits its own immediate wake, which pulls that row to now, and wins the
   next evaluation as ordinary input. A `goal_wait` hold whose deadline has
   just passed is due now: the evaluation that retires it skips the backoff
   once (the streak keeps counting afterwards), so pacing never extends the
   agent's own stated deadline. The API projects the wait as
   `scheduled` / `backoff_pending` with `nextAttemptAt` at the deadline.
5. Budget/admission policy can pause the goal visibly with reason `limits`.
   OpenGeni does not infer progress or blockage from tool/event shape; the
   model explicitly completes or pauses the goal under the continuation
   instructions, and a user can control it directly.
6. Goals are NOT capped by continuation count by default - runs legitimately
   span days. If a deployment sets
   `OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS` it becomes a hard ceiling
   (`min(goal.maxAutoContinuations, setting)`, pause reason
   `"max_auto_continuations"`); a per-goal `maxAutoContinuations` (API or
   scheduled-task configuration only) applies on its own even without the
   deployment setting. The ceiling bounds the same consecutive no-input streak
   as the backoff, so any consumed external input resets it. Reaching it is
   pacing, not user intent: every external input producer resumes the goal
   automatically in the same commit as that input: child results
   (`child_terminal_result`), scheduled occurrences (`scheduled_occurrence`),
   media results (`media_generation_result`), Agent messages
   (`agent_message`), Agent Steer (`agent_steer_instruction`), and human/API
   Send/Steer. Each emits `goal.resumed` (`actor: "system"`,
   `reason: "external_input"`, and the causing update or turn) at its next
   session sequence, starts a fresh continuation epoch, and arms the wake. A
   `user_pause`, `api`, `agent`, or `limits` pause is never auto-resumed.
7. Otherwise one deterministic goal-continuation internal update is recorded.
   At claim, its exact prompt becomes one canonical user-role model-memory item
   with the frozen goal snapshot; it is not duplicated into the generic
   internal-update envelope. Any unrelated machine updates coalesced with it
   are attached as ordinary message context. The turn uses the session's tool surface
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
  a goal that the user paused. Only a goal paused by the continuation ceiling
  (`max_auto_continuations`) is resumed by new input, because that pause is
  pacing rather than intent.
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
  rootConstraints?, maxAutoContinuations?, mutationPolicy? }`. A `goal.set`
  event is appended right after
  `session.created`.
- `GET /v1/workspaces/:id/sessions/:sessionId/goal` returns the goal plus a
  `continuation` projection from one repeatable-read Postgres snapshot
  (`sessions:read`; 404 when the session has no goal). The projection reports
  `inactive`, `scheduled`, `running`, `blocked`, or `invariant_broken`, with a
  typed reason, wake/observed revisions, optional next-attempt time, the
  latest workflow-wake error, and (for `held_for_input`) the agent's stated
  `holdReason` so a human sees why the goal is waiting and until when. Clients must not infer autonomy from goal/session
  status alone: `running` is reserved for a live goal-owned turn and alone
  means "Pursuing". A live human/API or system turn blocks autonomous
  continuation; recovering or queued work is scheduled. Pause, approval,
  provider backpressure, cancellation, pending wake/update, an agent-declared
  `goal_wait` hold (`blocked` / `held_for_input`, `nextAttemptAt` at the
  deadline), idle backoff between consecutive no-input continuations
  (`scheduled` / `backoff_pending`, `nextAttemptAt` at the pacing deadline),
  and a missing obligation are distinct truthful states.
- `PATCH /v1/workspaces/:id/sessions/:sessionId/goal` with
  `{ status: "paused" | "active", rationale? }` is the operator override
  (`sessions:control`). Pausing emits `goal.paused` (`actor: "api"`). Resuming
  is only valid from `paused`: it resets the counters, emits `goal.resumed`
  (`actor: "api"`, `reason: "api"`), and wakes the session workflow - resume
  works even on a fully idle session because `signalWithStart` restarts a
  completed workflow. Invalid transitions (e.g. resuming a completed goal)
  return 409. A `max_auto_continuations` pause additionally resumes itself on
  new external input (`goal.resumed`, `actor: "system"`,
  `reason: "external_input"`); no other pause reason does.
- The same `PATCH` accepts a direct semantic redirect with `{ text,
  successCriteria?, rootConstraints?, mutationPolicy?, rationale,
  expectedObjectiveRevision }`.
  This user-authoritative path may replace/re-activate a completed goal and
  wakes an otherwise idle session.
- `GET .../goal/revisions` preserves the original unbounded raw-array contract
  for existing clients. `GET .../goal/revisions/page?limit=...&before=...`
  exposes a separately named bounded keyset page of immutable applied,
  proposed, and rejected history.
  `POST .../goal/revisions/:revisionId/apply` applies a proposal under an exact
  objective-revision fence; the proposal row remains immutable and the new
  applied revision links it by `proposalId`. `POST .../reject` records an
  immutable rejection decision and supports safe replay. `POST .../rollback`
  restores an applied revision as a new applied revision under the same exact
  comparison-and-swap fence; history is never rewritten.
- `DELETE /v1/workspaces/:id/sessions/:sessionId/goal` clears the session's
  active goal (`sessions:control`). It deletes the goal row, emits
  `goal.cleared` when a goal existed, and is idempotent when no goal exists.

## Scheduled tasks

`agentConfig.goal` arms a goal on dispatched sessions. New-session runs create
the goal with the session; reusable-session runs re-arm it on every fire
(replace text, reactivate, reset counters) — a recurring "maintain X" task
re-establishes its objective each time.

## Agent tool access

The goal tools are session-scoped first-party MCP tools. Agent `goal_update`
requires an explicit `changeKind`, non-empty `rationale`, and
`expectedObjectiveRevision`; optional execution-progress audit facts use the
separate `goal_progress` tool but do not gate continuation. The worker signs the
session id into the delegated access token it uses for first-party MCP calls
(HMAC, worker-asserted — not agent-controlled), and the API registers
`goal_set`/`goal_update`/`goal_progress`/`goal_wait`/`goal_complete`/`goal_pause` only for grants carrying
that claim plus the `goals:manage` permission. `goal_wait` is in the default
first-party tool selection but is not one of the names a goal-bearing session
is required to select, so existing explicit selections keep working. A top-level session with no
first-party permission override uses the worker default. A child inherits its
creator's exact effective permissions, and an explicit set may only narrow
them; goal-bearing creation is rejected when that resulting set omits
`goals:manage` rather than silently broadening the child. Goal-bearing sessions
also require the goal lifecycle names in the separate effective
`firstPartyMcpTools` selection. The minimal default includes them; an explicit
or inherited selection that omits them is rejected rather than widened.
Goal-bearing sessions, turns, and scheduled dispatches force-merge the
`opengeni` tool ref so these
reachable even when the session was created with an empty tool list. The
worker also signs the exact turn, attempt, and execution generation used to
authorize a first application of `goal_update`; a replacement attempt may
reconcile the same target-scoped operation key, but a key reused with different
arguments is rejected as `IDEMPOTENCY_KEY_REUSED`.

## Settings

| Variable                               | Default            | Meaning                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS` | _(unset - no cap)_ | Optional hard ceiling on consecutive no-input continuation turns per goal arming. Unset by default, so a run can legitimately span days. When set, it is a ceiling that a per-goal `maxAutoContinuations` can only lower; reaching it pauses the goal until new external input resumes it. |
| `OPENGENI_GOAL_IDLE_BACKOFF_MS` | `3000,30000,120000,300000` | Comma-separated pacing delays (ms) before the n-th consecutive no-input continuation, measured from when the previous continuation turn finished; the last entry repeats. Not a cap: any new input wakes the session immediately. |
| `OPENGENI_GOAL_IDLE_BACKOFF_MAX_MS` | `600000` | Upper bound on every idle-backoff delay; schedule entries above it are rejected at boot. |
| `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` | `false` | Produce the child lifecycle notices (`child_requires_action`, its resolution, `child_paused`, `child_waiting_capacity`, `child_progress`) for parent sessions. Enable only after the whole fleet runs an image that understands the new kinds. The goal-continuation prompt teaches the orchestrator what each notice means and, when `session_human_input_respond` is in its effective first-party selection, that it may answer a worker's blocking question itself. |
