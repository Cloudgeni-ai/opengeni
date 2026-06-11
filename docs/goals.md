# Session goals

Agents stop prematurely. A session goal flips the default: while a goal is
`active`, a session that finishes a turn with nothing queued does not idle out.
Instead the session workflow synthesizes a continuation turn ("your goal is not
done — keep working, or explicitly complete/pause it"). Stopping becomes an
explicit act: the agent calls `opengeni__goal_complete` with evidence or
`opengeni__goal_pause` with a rationale, or a user interrupts the session.

Goal state is one durable Postgres row per session (`session_goals`,
RLS-isolated like every other workspace table). The Temporal workflow never
holds goal state in memory — it reads and mutates it only through activities,
so the loop is replay-safe by construction.

## Lifecycle

A goal is `active`, `paused`, or `completed`.

- `goal_set` (agent tool), `CreateSessionRequest.goal`, or
  `ScheduledTaskAgentConfig.goal` create it. Setting a goal on a session that
  already has one replaces it in place: text/criteria are overwritten, the goal
  is re-activated (even from `paused`/`completed`), the version bumps, and the
  continuation counters reset.
- `goal_update` revises text/criteria or records a progress note. The version
  bump counts as progress for the no-progress detector. Status is unchanged.
- `goal_complete { evidence }` is terminal. Only a new `goal_set` can replace a
  completed goal.
- `goal_pause { rationale }` stops the loop until the goal is resumed or
  replaced.

Every transition lands on the session timeline as `goal.set`, `goal.updated`,
`goal.completed`, `goal.paused`, `goal.resumed`, or `goal.continuation` events.

## The continuation loop

When the session workflow finds no queued turn it asks the `maybeContinueGoal`
activity for a decision:

1. No goal, or goal not `active` → idle shutdown, exactly as before.
2. Any non-terminal turn exists (`queued`, `running`, or `requires_action`) →
   the queue wins. A pending human approval is never bypassed by a
   continuation.
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
5. Otherwise a continuation turn is enqueued: a deterministic prompt referencing
   the goal text and success criteria, the session's tool surface plus the
   first-party `opengeni` MCP server (so the goal tools are always reachable),
   and the session's saved run state — the agent keeps its full conversation
   context.

Continuation turns are ordinary turns: they bill, meter (`agent_run.created`
with source `session_turn`), and stream exactly like user turns. If billing or
usage limits would block another run, the goal pauses visibly
(`goal.paused`, `reason: "limits"`) instead of failing the session; the limits
gate is applied inside the same locked decision, before the counter bump, so a
budget pause never consumes continuation budget. Re-arming a goal (resume or
replace) starts a fresh continuation epoch: counters and the
previous-continuation pointers are cleared together.

## Interrupts and failures

- A user interrupt is the explicit act of stopping, so it pauses an active goal
  (`pausedReason: "user_interrupt"`, `goal.paused` with `actor: "user"`) in both
  interrupt paths: idle interrupt and mid-turn interrupt.
- If a turn fails and the session is marked `failed`, the goal row is left
  as-is; a failed session rejects new messages, so nothing drives the goal.
- If the `maybeContinueGoal` activity itself throws, the workflow falls through
  to the normal idle shutdown rather than failing the session. This means the
  workflow can complete normally while a goal is still `active` in the
  database; the goal is not lost — the next wake (a user message, a manual
  resume, or a scheduled fire) re-enters the loop and retries.

## API

- `POST /v1/workspaces/:id/sessions` accepts `goal: { text, successCriteria?,
  maxAutoContinuations? }`. A `goal.set` event is appended right after
  `session.created`.
- `GET /v1/workspaces/:id/sessions/:sessionId/goal` returns the goal
  (`sessions:read`; 404 when the session has no goal).
- `PATCH /v1/workspaces/:id/sessions/:sessionId/goal` with
  `{ status: "paused" | "active", rationale? }` is the operator override
  (`sessions:control`). Pausing emits `goal.paused` (`actor: "api"`). Resuming
  is only valid from `paused`: it resets the counters, emits `goal.resumed`,
  and wakes the session workflow — resume works even on a fully idle session
  because `signalWithStart` restarts a completed workflow. Invalid transitions
  (e.g. resuming a completed goal) return 409.

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
reachable even when the session was created with an empty tool list.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENGENI_GOAL_MAX_AUTO_CONTINUATIONS` | `20` | Hard ceiling on synthesized continuation turns per goal arming. |
| `OPENGENI_GOAL_NO_PROGRESS_LIMIT` | `3` | Consecutive zero-progress continuations tolerated before auto-pause. |
