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
propagate without changing active history. A Codex terminal SSE failure carried
on HTTP 200 is converted to one bounded, marked, non-retried provider error; it
cannot masquerade as an empty successful summary. After a fenced durable
replacement, the same activity, turn, attempt, and sandbox rebuild model input
and continue; compaction never creates queue or recovery work.
A no-shrink result publishes a clear recovery message and leaves the session
`idle`, so zero-progress churn cannot loop. Exhausted, empty-summary, or
otherwise failed compaction identifies compaction summarization or the provider
failure, never installs a mechanical summary, and preserves active history. A
failed same-turn recovery atomically settles the exact turn, defers ordinary
internal updates, terminalizes a delivered goal-continuation receipt, and ends
that workflow run. Without a newer actionable work wake, the workflow cannot
synthesize another goal continuation from unchanged history. Ordinary machine
updates remain pending; a later human/API prompt, Steer, or explicitly requested
Compact may create newer truth and make one new attempt.

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
`workspace_inference_controls FOR SHARE` when the write is control-aware, then
the actual `workspaces` row `FOR KEY SHARE`, UUID-ordered sessions `FOR UPDATE`,
UUID-ordered exact turns `FOR UPDATE`, and UUID-ordered exact attempts
`FOR UPDATE`. Generic audit/title appends skip the control row but use the same
workspace-key-share prefix. Event inserts also touch the workspace through their
foreign keys, so acquiring it later would reintroduce a claim/preemption
deadlock; key-share rather than update keeps unrelated sessions in one workspace
concurrent. Start, requires-action, ordinary terminal, recoverable interruption,
supersession, and worker-death events commit
with turn status, session status/pointer, and `lastSequence` in one transaction.
Generic appends and operation-keyed Agent Message/Steer commands retry PostgreSQL
`40P01`/`40001` only around their bounded, idempotent persistence transaction.
Provider inference, tools, live event publication, and workflow wakes remain after
that boundary and are never replayed. An exhausted or non-retryable database
failure surfaces as sanitized typed truth with SQLSTATE, stage, one correlation
ID, and allowlisted catalog identifiers—never raw SQL text or bound parameters.

After a reviewed release reaches staging, run the dry-by-default OPE-63 canary
with `bun run canary:session-event-ordering`. Execution requires
`OPENGENI_CANARY_EXECUTE=1`, the API base URL, workspace ID, and exactly one
canary API credential. It creates one isolated `sandboxBackend=none` session on
a `codex/*` subscription model, immediately writes a first-turn title through
the normal API, and accepts only one model-usage event plus one successful
terminal event on a unique contiguous durable sequence. The operator output is
limited to safe IDs, event counts, sequences, and model name; credentials and
event payloads are never printed.
Pause closes the exact live attempt as `interrupted_recoverable` and leaves its
logical turn `recovering`; Steer closes it as `superseded`, makes the steered
human prompt first, and does not revive the old turn. A missing or already
closed owner is an event-free stale no-op. This prevents a superseded activity
that keeps running from publishing contradictory history or terminal truth.
Each Pause/Steer cause is a durable `session_attempt_interruptions` row; the
workflow's `sessionControl` signal is only a wake hint to settle those rows.

Control settlement and physical cancellation are deliberately separate
boundaries. A receipt-gated v2 workflow first atomically settles the exact
interruption and closes the attempt in Postgres, fencing every
model/tool/history/UI write. Only after that transaction commits does it request
Temporal cancellation using `TRY_CANCEL`; it does not await the activity
promise. Histories without the `session-attempt-quiescence-v2` patch retain the
v1 WAIT/fallback command order only for deterministic replay; new workflow runs
never select that path, and the current activity still writes the authoritative
receipt. Temporal cancellation,
completion, or failure is transport state and can never prove that a sandbox
process or parallel tool operation stopped. Worker heartbeat throttles cap
cancellation delivery at five seconds independently of the two-minute
heartbeat timeout and the activity's ten-second heartbeat timer.

The dying `runAgentTurn` activity owns physical proof. It cancels the exact
turn's tool/sandbox controller, waits for all controller-owned operations to
quiesce, and immediately writes `session_turn_attempts.quiesced_at` before
credential, cache, recording, provider, lease, or workspace housekeeping. The
receipt, its `session.queue.changed` event, the session queue/sequence update,
and the exact `session_workflow_wake_outbox` revision commit in one retryable,
idempotent transaction. Provider completion and batch flushes that ignore
cancellation are detached with rejection handlers; all later housekeeping is
attempt-fenced and detachable. If receipt persistence exhausts its retries,
cleanup can still release local ownership but admission remains fail-closed:
no Temporal terminal state can reconstruct or substitute for physical proof.

While a settled interruption lacks that receipt, `peekSessionWork` returns a
durable `cancellation-wait` and every claim path remains `control-pending`. The
workflow waits up to five seconds for a wake and may then close without running
another activity. Once the receipt commits, its coalescing outbox wake uses
`signalWithStart` on the same stable workflow id, which restarts the exact
session and admits the replacement once. This path needs no quiescence scanner,
synthetic user message, or duplicate visible queue row. Queue telemetry follows
the latest session attempt only: `stoppingPreviousAttempt` can truthfully be
`true` with an empty human/API queue (internal Agent Steer), ignores replacement
metadata corruption/withdrawal, and is not contaminated by an older attempt
after a newer one exists.

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
reason `WORKER_SHUTDOWN`) checkpoints conversation truth and the sandbox
envelope, closes the exact attempt as recoverable, and leaves the same logical
turn in `recovering`. It never creates a human queue row or synthetic user
message. Any in-flight side-effecting tool call is durably closed with an
explicit `interrupted / outcome unknown` result before the next attempt can
run; a late result is retained only as rejected evidence. The workflow then
creates a fresh attempt for that same turn on a healthy worker and reconstructs
model input from durable model history and tool-call lineage. At most the
single in-flight model step is lost, the same bound as a crash. This is an
explicit checkpoint/resume, not an automatic Temporal retry. A newer control
revision, terminal state, or successor attempt wins instead of being
overwritten.

**Ungraceful worker death is also survivable — bounded, never blind.** A hard
kill (SIGKILL, OOM, node loss, a rollout whose grace period expired) never
runs the graceful checkpoint; it surfaces to the session workflow as a
heartbeat-timeout `ActivityFailure` carrying the exact dead activity id. The
workflow does not fail the session independently for that shape: conversation
truth was still dual-written after every model response during the turn, so
the fenced `recoverTurnAfterWorkerDeath` activity atomically closes the lost
attempt, marks the same
logical turn `recovering` and the loop dispatches its next attempt. This is not
prompt-queue work and not an automatic Temporal retry of side-effectful work:
the resumed attempt sees everything durably checkpointed, including explicit
`interrupted / outcome unknown` tool results when an effect cannot be proven.
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
   streams (reconciled after every model response and at every turn-end path)
   so a crash loses at most the single in-flight model call. Ordinary inference
   has no second conversation-memory read path.
2. **`agent_run_states` — approval resume only.** The serialized SDK `RunState`
   blob is an opaque, SDK-version-gated process checkpoint. Its one legitimate
   job is resuming a turn that paused mid-flight for a human approval
   (`requires_action`); a half-finished tool approval cannot be represented as
   plain history items. The blob is written only for that case.
   Do not use it as conversation memory.
3. **`session_events` — the redacted human/audit timeline.** Append-only,
   per-session sequence numbers, drives replay/SSE/UI. It is **secret-redacted
   and lossy** (reasoning items and several item types are dropped), and each
   payload is capped at 64 KiB with explicit surface/byte/token/non-retention
   metadata. Large text keeps deterministic head/tail facts; inline media is a
   compact `media_preview` and its bytes are not retained by this generic path.
   It is correct for human progress/audit previews and must never be used to
   reconstruct the target session's model conversation or advertised as a
   full-output evidence store. A manager can inspect an independently bounded
   cross-session monitoring projection as ordinary tool output; that does not
   turn audit events into conversation truth.

Cross-session monitoring is tail-first and selected in PostgreSQL. With no
cursor, REST/SDK/MCP monitoring omits raw message, reasoning, command-output,
and PTY deltas, uses `summary` payloads, and returns exact covered-sequence and
continuation facts. Type filters and the `control`, `terminal`, `failure`,
`checkpoint`, `tool_receipt`, and `provider_account` semantic classes share one
union-then-subtract algebra; explicit exclusions win, while an explicit include
can opt a type back in from the monitoring defaults. `latest` is instead an
exclusive typed newest lookup: it cannot be combined with include/exclude type
or class filters, so its requested class cannot be unioned away or subtracted.
Explicit forensic REST/SDK
pages can return the exact retained audit projection, but remain count/byte
bounded and cannot recover source bytes that the audit boundary omitted. The
MCP result is separately capped to 64 KiB of exact pretty-printed JSON and never
advances a cursor over an event it did not return.

Session discovery is a separate compact monitoring projection, not a list of
full session rows. `sessions_list` defaults to deterministic descending
`(created_at, id)` order and can instead use the durable descending
`(activity_revision, updated_at, id)` activity order. `updated_at` is the
display/keyset suffix, not the snapshot clock. Revision zero is the untouched
legacy bucket and still traverses by exact PostgreSQL timestamp/UUID suffix.
Both paths use opaque, versioned, snapshot-bound keyset cursors and matching
workspace-prefixed indexes. For updated order the first-page transaction takes
workspace inference-control `FOR SHARE`, then the workspace activity counter
`FOR SHARE`, and reads session rows with ordinary MVCC. Control-aware semantic
writers use workspace control → UUID-sorted session rows → counter; inserts and
direct writers may omit the control/session prefix but never acquire those
locks after the counter. Holding the counter fence makes every later activity
receive a strictly greater transactional revision. The page returns that
decimal revision as `updatedThrough`; the next incremental scan passes it as
`updatedAfter`, so application-clock timestamps, equal timestamps, inserts,
and repeated updates cannot create a handoff gap. The one-row counter is touched
only for semantic monitoring activity, not raw deltas. Known targets should be
read with exact-ID `session_get`, whose model-facing projection independently
bounds every aggregate and the complete pretty-printed response to 64 KiB; the
REST session detail contract remains unchanged.

`sessions.updated_at` records semantic monitoring activity time, while
`sessions.activity_revision` is its transactional monotonic ordering fact; raw
stream volume advances neither. A batch containing only raw message, reasoning,
sandbox-command-output, or PTY
deltas advances `last_sequence` but does not advance `updated_at` or
`activity_revision`. A semantic event or explicit session mutation advances
the timestamp and transactionally allocates the workspace's next activity
revision as applicable. This keeps
updated-order discovery useful even while a productive session emits a large
raw token or terminal stream; `session_events` remains the exact sequenced
audit path for those retained previews.

Those durable stores are still not the realtime or browser representation.
NATS chunks bounded encoded messages; each session/workspace-control SSE body
queues at most one complete frame of at most 96 KiB, retains one latest-wins
live notification, and uses bounded-page Postgres replay/gap fill. If a second
write sees non-positive `desiredSize` for 30 seconds, the API errors only that
connection, releases its upstream subscription, and records a fixed-label bound
metric; reconnect resumes from the client's last observed durable sequence.
REST uses byte-bounded forward prefixes/backward suffixes; and
React retains one direction-aware count+byte window. Live/default accumulation
keeps the newest suffix. If backward paging retains an older prefix and evicts
the live tail, the hook aborts that iterator and reconnects from the retained
high-water mark, replaying the evicted tail before appending newer live rows.
Its highest-ever-observed sequence and latest status are stored separately from
that rewindable resume cursor. Historical oversized event rows remain readable
during the rolling migration and are defensively normalized at each outbound
boundary. Generic omitted output is unavailable unless a separate
access-controlled artifact/file receipt explicitly retained it.

Workspace-control events follow a smaller independent contract because they are
cursor invalidations, not evidence or conversation history. Human reason input
is limited to 8 KiB UTF-8 (and cannot contain NUL), authenticated actor ids are
limited to 1 KiB, and the durable event is at most 16 KiB with explicit original /
delivered / omitted byte facts for guarded historical or direct-writer values.
The generic full value was not retained. NATS asserts a 32-KiB message, SSE uses
the same one-frame 96-KiB connection queue, and REST pages use a separate 1-MiB
byte envelope plus the last delivered sequence as the resume cursor. Replaying
one guarded poison row must still advance to every later durable revision.

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
