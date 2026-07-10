# Run lifecycle: turns, goals, and memory

This is the orientation for how an OpenGeni agent run actually executes over
time. It ties together three subsystems a contributor touching the session
workflow, the worker activity, or the runtime must keep straight. Code wins
over this doc; the canonical sources are `apps/worker/src/workflows/session.ts`,
`apps/worker/src/activities/agent-turn.ts`, and `packages/runtime/src/index.ts`.

## Turns

A **turn** is one unit of agent work inside a session: an input (a user message,
a goal continuation, or an approval decision) is processed until the agent
reaches a natural stopping point. One turn runs as one non-retryable Temporal
activity (`runAgentTurn`; the activity is also registered under its former name
`runAgentSegment` for in-flight workflow-history compatibility — do not schedule
the old name in new code). Inside that activity the OpenAI Agents SDK loop makes
as many model calls and tool calls as the work needs.

Synthesized goal continuations inherit the model and reasoning effort from the
newest turn with a durable `turn.started` event. The session default is used
only when no turn has actually started. This keeps routing and billing
ownership aligned after an explicit per-turn switch and excludes turns rejected
during admission, whose `started_at` claim timestamp alone is not proof that
their policy ran. Child-completion parent wakes are temporarily disabled by
default (`OPENGENI_CHILD_COMPLETION_PARENT_WAKE_ENABLED=false`): spawned child
sessions retain their own durable events and goal evidence without injecting a
synthetic `user.message` or queued turn into the parent chat.

**Runs have no length limits, by design.** What the SDK calls "turns" are model
calls; `OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN` exists but defaults to
effectively unbounded. There is no continuation cap and the agent activity's
Temporal timeout is measured in days, not hours. OpenGeni is built for agents
that legitimately run for a very long time, so **run length is bounded by
symptoms, never by counts**: the no-progress detector and budget exhaustion are
the real guards. Do not reintroduce count- or duration-based caps on legitimate
run length; if a run is misbehaving, detect the pathology, do not cap the clock.

Recoverable conditions end a turn gracefully (idle the session, keep the
context) instead of failing it, so a long run survives them: hitting the
model-call cap (if one is configured), provider rate-limit backpressure,
escaped MCP request timeouts, and budget/credit exhaustion. With an active
goal, provider/MCP backpressure resumes after a pacing delay; without one, the
session idles until the next user message (a long-lived session between goals
must not go terminal because an external service had a bad minute). For an MCP
timeout that escapes after a successful tool output, conversation truth is
checkpointed before the turn settles and the continuation is a new follow-up —
the completed tool call/full turn is never blindly replayed. Budget/credit
exhaustion likewise idles the turn rather than failing the session, so a top-up
lets the same session continue.

Codex-subscription turns add one explicit recovery boundary before the model
run. With workspace-local leasing enabled, the worker atomically selects and
leases a credential under the workspace rotation-row lock; concurrent replicas
therefore observe earlier reservations. A second 401, 403, explicit quota, or
429 can quarantine that credential and requeue the same durable turn after a
conversation-truth checkpoint. Network/5xx/invalid-content/partial-stream
failures never rotate or blindly replay. The allocator, strict workspace scope,
five-hour reset semantics, and rollout fence are canonical in
[`codex-subscription-rotation.md`](codex-subscription-rotation.md).

When every allocator-enabled Codex credential is unavailable and the session
still has an active goal, this recovery boundary becomes a durable capacity
wait. The worker atomically settles the blocked turn once, idles the session,
and stores one session-scoped waiter fenced by goal version, control generation,
accepted policy hash, and blocked turn. The workflow waits for the earliest
authoritative provider reset or a bounded secret-safe metadata refresh, and
capacity-affecting writes increment a same-transaction wake revision before a
best-effort Temporal signal. Duplicate/lost signals are harmless: row-locked
re-evaluation is the sole continuation writer, and unobserved revisions repair
commit-to-signal loss after restart or `continueAsNew`; a signal delivered
between waiter commit and the activity result is compared against the workflow's
pre-dispatch wake counters and cannot be baselined away. Capacity return enqueues
one normal, queue-respecting goal continuation with the blocked turn's effective
model/reasoning/resources/tools while resetting execution-local worker-death and
credential-failover counters; it does not create a user message, replay the
failed full turn, poll with inference, or redeem a reset/boost entitlement.

Provider context-window overflow is also handled inside the activity, not by a
Temporal retry. When an OpenAI/Azure context overflow is classified,
`runAgentTurn` forces client-side compaction through a bounded recovery
pipeline. Compaction first summarizes a rendered transcript, retries once with a
hard-trimmed rendered transcript on summarizer failure, then falls back to a
deterministic non-LLM rebuild if the summarizer still fails. A
`compacted:false` result is never a retry ticket. If no model/tool progress was
persisted for this turn, the activity retries only after an actual compacted
write, bounded by a per-turn recovery cap. If progress was already persisted,
it does not replay the trigger; it requeues the turn with a compaction resume
notice only after the persisted active-history token estimate strictly
decreases. A later resumed turn may compact and requeue again when it makes the
same durable shrink progress — long productive runs are not generation-capped.
A no-shrink result publishes a clear recovery message and leaves the session
`idle`, so zero-progress churn cannot loop. Exhausted or impossible compaction
fails with an error that names compaction summarization/fallback, not the
threshold event.

Resolved model context metadata is authoritative on every model-facing path.
For the Codex subscription catalog this means a 272,000-token raw window, a
258,400-token effective input ceiling (95%), and automatic compaction at
244,800 tokens (90%, reached with `>=`). Local checkpoint replacement retains
only the newest real user messages that fit one cumulative 20,000-token budget,
then appends the summary; internal resume notices are never retained as user
intent. See [`context-compaction.md`](context-compaction.md).

That requeue is one atomic durable settlement: lock the session and exact
active turn, append `turn.preempted` plus queued status, change the turn back to
queued, and clear the session's active pointer in the same transaction. A
missing/already-terminal turn, a newer attempt, or a durable `user.interrupt`
newer than the current attempt returns a stale no-op and appends nothing. This
prevents a cancelled activity that keeps running through compaction from
publishing a contradictory preemption and then failing the session on a later
row CAS. Interrupt settlement uses the same lock order and current-trigger
fence, so a delayed old workflow signal cannot cancel a newer turn.

Sandbox lease warming is bounded for the same reason: it is a capacity/setup
symptom, not legitimate agent work. A turn that attaches while another worker is
creating the group sandbox waits at most
`OPENGENI_SANDBOX_WARMING_TIMEOUT_MS` (default 600000). If the lease does not
reach `warm` in that budget, the activity fails the turn with a clear
backend/capacity timeout instead of heartbeating forever. When a provider create
does return, the worker immediately records the provider instance id on the
warming lease before readiness/display/setup work; any later setup failure
terminates that just-created sandbox before the lease can be retried.

**Worker restarts are survivable.** A graceful worker shutdown (a deploy or
rollout restart delivers SIGTERM; Temporal cancels in-flight activities with
reason `WORKER_SHUTDOWN`) preempts the in-flight turn instead of failing the
session: the activity checkpoints (final conversation-truth reconcile plus the
sandbox envelope; legacy run-state mode captures the RunState blob), puts the
turn back on the session queue, emits a `turn.preempted` event, and completes
with status `preempted`. The session workflow then re-dispatches the same turn
on a healthy worker — entering through a synthesized resume notice when the
turn had already persisted progress (so the model is not handed duplicate
input and is told to verify in-flight side effects before repeating them), or
replaying the original trigger when nothing was persisted yet. At most the
single in-flight model step is lost, the same bound as a crash. This is an
explicit checkpoint/resume, not an automatic Temporal retry.
The event, turn reset, and session transition share the atomic settlement above;
an interrupt, terminal state, or newer attempt is respected as stale rather
than overwritten.

**Ungraceful worker death is also survivable — bounded, never blind.** A hard
kill (SIGKILL, OOM, node loss, a rollout whose grace period expired) never
runs the graceful checkpoint; it surfaces to the session workflow as a
heartbeat-timeout `ActivityFailure`. The workflow does not fail the session
for that shape: conversation truth was still dual-written after every model
response during the turn, so the `requeueTurnAfterWorkerDeath` activity puts
the turn back on the queue and the loop re-dispatches it — through a
synthesized `turn.preempted` resume notice (reason `worker_death`) when the
dead attempt had persisted items for the turn, or by replaying the original
trigger when nothing was persisted. This is still not an automatic Temporal
retry of side-effectful work: the resumed attempt sees everything the dead
attempt checkpointed and is told to verify in-flight side effects before
repeating them. A per-turn redispatch counter persisted on the turn row
(ceiling 3) breaks crash loops: a turn that keeps killing workers fails the
session for real with a clear error.

**Failed sessions are revivable by talking to them.** Conversation truth is
items, so a failed turn does not invalidate history. A new `user.message`
into a failed session transitions it failed → queued, restarts the session
workflow (signalWithStart), and the next turn runs from the stored items.
Only `cancelled` — an explicit user act — is terminal.

## Goals — what makes long runs continue

Agents stop prematurely. A **goal** flips the default so that finishing a turn
with nothing queued does not idle the session out — the workflow synthesizes a
continuation turn and the agent must explicitly `goal_complete` or `goal_pause`
to stop. This is the mechanism behind every multi-day autonomous run. Full
detail in `docs/goals.md`; the one-line model: queued user input always wins
over a continuation, and goals are bounded by progress/budget guards, not counts.

## Memory — three stores, three jobs

A session's content lives in three places. Keep them straight; reaching for the
wrong one is the classic mistake.

1. **`session_history_items` — conversation truth (the model-facing store).**
   Ordered, verbatim SDK `AgentInputItem` JSON, unredacted, RLS-scoped. This is
   what a new turn's input is built from. It is dual-written as the agent
   streams (reconciled after every model response and at every turn-end path)
   so a crash loses at most the single in-flight model call. The read path is
   selected by `OPENGENI_SESSION_HISTORY_SOURCE` (default `items`).
2. **`agent_run_states` — approval resume only.** The serialized SDK `RunState`
   blob is an opaque, SDK-version-gated process checkpoint. Its one legitimate
   job is resuming a turn that paused mid-flight for a human approval
   (`requires_action`); a half-finished tool approval cannot be represented as
   plain history items. In items mode the blob is written only for that case.
   Do not use it as conversation memory.
3. **`session_events` — the redacted human/audit timeline.** Append-only,
   per-session sequence numbers, drives replay/SSE/UI. It is **secret-redacted
   and lossy** (reasoning items and several item types are dropped), so it is
   correct for humans and auditing and must never be fed back to the model.

Sandbox recovery state is persisted separately again, in
`sandbox_session_envelopes`: the small versioned descriptor (provider handle /
snapshot reference / manifest) used to reattach, snapshot-restore, or rebuild
the session's sandbox on its next turn — decoupled from the RunState blob.

See issue #35 for the rationale and the dual-write → flagged-read → default-flip
migration history.

One consequence of client-side conversation truth: model calls must not depend
on the provider's server-side response store. Provider-assigned item ids
(`rs_`/`msg_`/`fc_`…) are resolved against that store, and a response that
streamed successfully can be missing from it on the very next call, failing a
long run mid-turn with 400 "Item with id … not found". The runtime therefore
strips provider item ids from every model-call input by default
(`OPENGENI_OPENAI_PROVIDER_ITEM_IDS=strip`) and round-trips
`reasoning.encrypted_content` instead
(`OPENGENI_OPENAI_REASONING_ENCRYPTED_CONTENT=true`), so requests are
self-contained and reasoning continuity does not hinge on provider storage.
