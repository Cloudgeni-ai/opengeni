# Run lifecycle: turns, goals, and memory

This is the orientation for how an OpenGeni agent run actually executes over
time. It ties together three subsystems a contributor touching the session
workflow, the worker activity, or the runtime must keep straight. Code wins
over this doc; the canonical sources are `apps/worker/src/workflows/session.ts`,
`apps/worker/src/activities/agent-turn.ts`, and `packages/runtime/src/index.ts`.

## Turns

A **turn** is one logical unit of agent work inside a session: a waiting
human/API prompt, an approval decision, or one coalesced internal-update batch
is processed until the agent reaches a natural stopping point. The visible
queue contains only waiting human/API prompts; goals, schedules, child results,
capacity recovery, and lifecycle notices are typed internal updates, not queue
rows. One execution attempt runs as one non-retryable Temporal `runAgentTurn`
activity. Inside the activity the OpenAI Agents SDK loop makes as many model
calls and tool calls as the work needs.

Synthesized goal continuations inherit the model and reasoning effort from the
newest turn with a durable `turn.started` event. The session default is used
only when no turn has actually started. This keeps routing and billing
ownership aligned after an explicit per-turn switch and excludes turns rejected
during admission, whose `started_at` claim timestamp alone is not proof that
their policy ran. Spawned-child terminal results enter the parent's bounded
typed internal-update batch without injecting a synthetic `user.message` or a
human queue row.

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
and stores one session-scoped waiter fenced by goal version, accepted policy
hash, blocked turn, and the effective admission gate. The workflow waits for the earliest
authoritative provider reset or a bounded secret-safe metadata refresh, and
capacity-affecting writes increment a same-transaction wake revision before a
best-effort Temporal signal. Duplicate/lost signals are harmless: row-locked
re-evaluation is the sole continuation writer, and unobserved revisions repair
commit-to-signal loss after restart or `continueAsNew`; a signal delivered
between waiter commit and the activity result is compared against the workflow's
pre-dispatch wake counters and cannot be baselined away. Capacity return records
one typed goal-continuation internal update with the blocked turn's effective
model/reasoning/resources/tools while resetting execution-local worker-death and
credential-failover counters. That update can start one internal-update
inference only when no human prompt or approval is waiting and the admission
gate is open; it does not create a user message or visible queue row, replay the
failed full turn, poll with inference, or redeem a reset/boost entitlement.

Provider context-window overflow is also handled inside the activity, not by a
Temporal retry. When an OpenAI/Azure context overflow is classified,
`runAgentTurn` invokes the portable Codex-local compaction path. The summarizer
receives a bounded, protocol-valid temporary copy of structured active history
plus the checkpoint prompt. Aggregate tool outputs are replaced oldest-first in
that copy; whole oldest user-delimited units are removed only if necessary. A
provider overflow gets one smaller refit, so the path performs at most two
provider calls rather than one failing request per history item. Other failures
propagate without changing active history. After a fenced durable replacement,
the same activity, turn, attempt, and sandbox rebuild model input and continue;
compaction never creates queue or recovery work.
A no-shrink result publishes a clear recovery message and leaves the session
`idle`, so zero-progress churn cannot loop. Exhausted or impossible compaction
fails with an error that identifies compaction summarization, not the threshold
event; it never installs a mechanical summary.

Resolved model context metadata is authoritative on every model-facing path.
For the Codex subscription catalog this means a 272,000-token raw window, a
258,400-token effective input ceiling (95%), and automatic compaction at
244,800 tokens (90%, reached with `>=`). Local checkpoint replacement retains
only the newest real user messages that fit one cumulative 20,000-token budget,
then appends the summary; internal resume notices are never retained as user
intent. See [`context-compaction.md`](context-compaction.md).

Before model/tool work, a claimed turn inserts a first-class
`session_turn_attempts` row containing its exact Temporal activity id, current
trigger, monotonic dispatch generation, verified control revision, and write
lease. A real Temporal activity retry retains the activity id; a re-dispatch
creates a new attempt. Every event, model-history write, run-state write,
compaction transition, tool receipt, and terminal settlement must match that
attempt. A typed schedule-to-start timeout is the only no-attempt recovery case
because its activity never ran.

Provider and tool effects have a narrower durability boundary than the full
activity. Immediately before every ordinary model or compaction provider call,
the worker awaits an exact `session_turn_model_call_admissions` insert under the
turn-attempt fence. The admission records the positive call index, kind,
provider/API/model, trigger, and execution generation; at most one admission
may remain unlinked on an attempt. Only after that commit may provider inference
start. Function tools expose the provider-stable call id at the SDK `invoke`
seam; the worker must likewise register that exact call receipt under the turn
fence **before** the underlying function can start. A missing call id or failed
registration blocks the effect.

A completed ordinary model response prepares the exact new conversation rows
and, only when the provider supplied usage, the idempotent accounting source key
and reserved `agent.model.usage` producer event. A completed compaction response
additionally prepares the exact apply/skip transition, replacement fingerprint,
and persistence key. Provider completion then atomically inserts the full
prepared obligation in `session_turn_persistence_receipts` and links admission
and receipt in both directions. The admission therefore cannot be mistaken for
proof that a provider call did not complete.

The full prepared obligation is committed first to
`session_turn_persistence_receipts` as JSONB with its canonical SHA-256 digest,
exact attempt UUID, execution generation, trigger, turn, and kind. Only after
that row is durable does the activity heartbeat a strict version-2 reference:
receipt/turn/trigger/generation/attempt/kind/digest, with no extra keys and a
maximum encoded size of 1 KiB. Raw provider output, model history, metering,
tool arguments, and compaction replacement rows therefore never enter Temporal
workflow history. The heartbeat precedes the first lease renewal or application
of that prepared obligation.

If the worker cannot prove final persistence, it returns internal status
`persistence_pending` with that same bounded reference. If the process dies
after the receipt commit, the reference normally remains in the last Temporal
heartbeat. If it dies before that heartbeat, the control lane discovers the one
pending receipt directly by exact attempt. The workflow/control activity
validates the receipt identity, digest, kind, and stored obligation, then invokes
only `persistTurnHandoffAndRecover`, a retryable control activity whose
dependency closure contains database/event persistence but no provider,
runtime, tool, or sandbox execution. Its fixed orders are:

- tool: pending-call receipt → receipt settlement → same-turn recovery;
- model: conversation rows → optional usage/credit ledger and exact usage event
  → receipt settlement → same-turn recovery;
- compaction: optional usage/credit ledger and exact usage event → exact
  prepared apply/skip → receipt settlement → same-turn recovery.

Provider completion without usage is still a completed effect: history (and a
compaction transition when applicable) persists and the receipt settles, but
the worker manufactures neither billing nor an `agent.model.usage` event. The
full contract is **durable admission → provider invocation → complete obligation
→ atomic admission/receipt link → persistence-only phases → receipt
settlement**.

Every phase is idempotent under the original attempt fence. Exact producer rows
confirm an ambiguous event commit; compaction confirms the same persistence key
and replacement fingerprint; accounting uses the same source key. Only after
all Postgres obligations are confirmed does the transactionally fenced recovery
advance the logical turn for a higher-generation attempt. Activity-response
loss, Temporal control-activity retry, and old/new worker overlap therefore
repeat persistence only—not inference, tool invocation, or an external effect.
If any receipt-fenced phase rejects, the control activity reloads the exact
receipt and attempt under workspace → session → turn → attempt → receipt locks.
A settled receipt on the still-live attempt means another worker completed the
same obligation and recovery continues; a still-pending live receipt raises a
retryable control-activity failure; only a replaced or terminal attempt is
stale. A generic stale result never substitutes for this classification.
A malformed heartbeat/result reference, a reference-to-row identity or digest
mismatch, or a malformed stored obligation fails closed and cannot fall back to
generic worker-death redispatch. One PostgreSQL transaction quarantines the
receipt, closes the exact live attempt as failed, clears the active attempt,
fails the turn/session, closes pending tool calls, and appends a non-retryable
`turn.failed(code="invalid_turn_persistence_handoff", effectState="unknown")`.
PostgreSQL is the authority; NATS fanout is retried/best-effort delivery and
never changes whether recovery is safe.

The turn activity span retains bounded failure provenance (`persistence_boundary`,
`worker_shutdown`, `attempt_fenced`, or `activity_cancelled`) and, when a database
wrapper exposes it, the nested driver cause type and SQLSTATE/code. It never
promotes SQL text, parameters, or arbitrary provider messages into those stable
attributes. A persistence-boundary span also uses a constant error type/message
for both OTLP error attributes and status; the raw wrapper error is never passed
to the exporter.

One model response's parallel tool calls are tracked as an in-memory settlement
batch while its stream is active; batch identity is not durable schema. A
completed response can reconcile and clear its exact call IDs even if an older
response left an unresolved receipt. Turn-end recovery searches both active and
compacted (inactive) canonical history. A complete pair made inactive by
compaction is consumed silently; it is never reactivated and never produces a
duplicate `agent.toolCall.output`. A still-active complete pair retains the
existing recovery projection because its receipt can mark a crash after memory
was saved but before the original event publish. Only genuinely unresolved
execution gets one explicit `interrupted / outcome unknown` closure.

Claim, interruption, and event-writing settlement share one lock order:
workspace, then session, then exact turn, then exact attempt. Event inserts also touch the workspace through
their foreign keys, so acquiring it later would reintroduce a claim/preemption
deadlock. Start, requires-action, ordinary terminal, recoverable interruption,
supersession, and worker-death events commit
with turn status, session status/pointer, and `lastSequence` in one transaction.
Pause closes the exact live attempt as `interrupted_recoverable` and leaves its
logical turn `recovering`; Steer closes it as `superseded`, makes the steered
human prompt first, and does not revive the old turn. A missing or already
closed owner is an event-free stale no-op. This prevents a superseded activity
that keeps running from publishing contradictory history or terminal truth.
Each Pause/Steer cause is a durable `session_attempt_interruptions` row; the
workflow's `sessionControl` signal is only a wake hint to settle those rows.

Sandbox lease warming is bounded for the same reason: it is a capacity/setup
symptom, not legitimate agent work. A turn that attaches while another worker is
creating the group sandbox waits at most
`OPENGENI_SANDBOX_WARMING_TIMEOUT_MS` (default 600000). If the lease does not
reach `warm` in that budget, the activity fails the turn with a clear
backend/capacity timeout instead of heartbeating forever. When a provider create
does return, the worker immediately records the provider instance id on the
warming lease before readiness/display/setup work; any later setup failure
terminates that just-created sandbox before the lease can be retried.

**Worker restarts are survivable without guessing at provider effects.** A
graceful worker shutdown (a deploy or rollout restart delivers SIGTERM;
Temporal cancels in-flight activities with reason `WORKER_SHUTDOWN`)
checkpoints conversation truth and the sandbox envelope. What happens next is
determined from PostgreSQL, not from the cancellation reason:

- with no provider admission or pending receipt, the worker closes the exact
  attempt as recoverable and leaves the same logical turn in `recovering`;
- with a linked pending receipt, the control lane completes persistence only,
  settles the receipt, and then recovers the same turn;
- with an admitted but unlinked model/compaction call, provider effect state is
  unknown, so one transaction fails the exact attempt/turn/session with
  `ambiguous_model_call`, `effectState="unknown"`, and `retryable=false`.

The third case never redispatches provider inference merely because SIGTERM
arrived before receipt establishment. None of these paths creates a human queue
row or synthetic user message. An in-flight side-effecting tool call is durably
closed with an explicit `interrupted / outcome unknown` result before a safe
next attempt can run; a late result is retained only as rejected evidence. A
recoverable path creates a fresh attempt for the same turn on a healthy worker
and reconstructs model input from durable model history and tool-call lineage.
This is explicit checkpoint/resume, not an automatic Temporal retry. A newer
control revision, terminal state, or successor attempt wins instead of being
overwritten.

**Ungraceful worker death is also survivable — bounded, never blind.** A hard
kill (SIGKILL, OOM, node loss, a rollout whose grace period expired) never
runs the graceful checkpoint; it surfaces to the session workflow as a
heartbeat-timeout `ActivityFailure` carrying the exact dead activity id. The
workflow does not fail the session independently for that shape: conversation
truth was still persisted after every completed model response during the turn.
When the heartbeat carries a pending exact persistence reference, the workflow
settles that PostgreSQL receipt through `persistTurnHandoffAndRecover` before
any redispatch. When no heartbeat reference exists, `recoverSessionDispatch`
locks the exact attempt and checks both its pending receipt and model-call
admission in the same transaction that would otherwise close it. This covers
receipt-commit-to-heartbeat, admission-to-provider, provider-to-receipt, and
establishment-vs-worker-death races. A linked receipt returns for persistence-
only recovery. No receipt and no admission permits `recoverDispatch` to close
the lost attempt, mark the same logical turn `recovering`, and let the loop
dispatch its next attempt. An unlinked admission instead atomically quarantines
the attempt with `ambiguous_model_call`; it is evidence that provider execution
may have escaped, never evidence that redispatch is safe. This is not
prompt-queue work and not an automatic Temporal retry of side-effectful work:
a safely resumed attempt sees everything durably checkpointed, including
explicit `interrupted / outcome unknown` tool results when an effect cannot be
proven.
The dying activity never writes a competing cancellation or authoritative late
result.
A per-turn redispatch counter persisted on the turn row (ceiling 3) breaks
crash loops: the transaction that exceeds the ceiling appends the failure
events and fails the exact turn/session, and the workflow performs no second
split failure settlement.

**Failed sessions are revivable by talking to them.** Conversation truth is
items, so a failed turn does not invalidate history. A new `user.message`
into a failed session transitions it failed → queued, restarts the session
workflow (signalWithStart), and the next turn runs from the stored items.
Only `cancelled` — an explicit user act — is terminal.

Every transaction that creates or re-enables workflow work also increments the
session's durable wake revision. Single-target producers signal directly;
recursive controls trigger the bounded dispatcher once without loading the
affected tree into API memory. Successful delivery acknowledges the exact
revision, and the dispatcher retries only due unacknowledged rows.
Temporal is therefore a nudge, never the work ledger, and a commit/signal crash
cannot strand the prompt. Repaired wakes inspect unsettled exact-attempt
interruptions so a live Pause/Steer still reaches settlement. The workflow
records a monotonic signal version before its final activity chain and refuses to
return when a signal arrived during that chain, closing the completion race.

## Goals — what makes long runs continue

Agents stop prematurely. A **goal** flips the default so that finishing a turn
with nothing queued records one typed goal-continuation internal update and the
agent must explicitly `goal_complete` or `goal_pause` to stop. The update joins
the next bounded internal batch and never appears as a human queue row. This is
the mechanism behind every multi-day autonomous run. Full detail in
`docs/goals.md`; the one-line model: queued human input always wins over an
internal continuation, and goals are bounded by progress/budget guards, not
counts.

## Memory — three stores, three jobs

A session's content lives in three places. Keep them straight; reaching for the
wrong one is the classic mistake.

1. **`session_history_items` — conversation truth (the model-facing store).**
   Ordered, verbatim SDK `AgentInputItem` JSON, unredacted, RLS-scoped. This is
   what a new turn's input is built from. It is dual-written as the agent
   streams (reconciled after every model response and at every turn-end path).
   A completed response with a linked receipt converges through persistence
   only after a crash; an admitted response without a linked receipt is
   quarantined as unknown and is never replayed. Ordinary inference has no
   second conversation-memory read path.
2. **`agent_run_states` — approval resume only.** The serialized SDK `RunState`
   blob is an opaque, SDK-version-gated process checkpoint. Its one legitimate
   job is resuming a turn that paused mid-flight for a human approval
   (`requires_action`); a half-finished tool approval cannot be represented as
   plain history items. The blob is written only for that case.
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
