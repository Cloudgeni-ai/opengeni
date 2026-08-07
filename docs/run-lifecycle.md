# Run lifecycle: turns, goals, and memory

This is the orientation for how an OpenGeni agent run actually executes over
time. It ties together three subsystems a contributor touching the session
workflow, the worker activity, or the runtime must keep straight. Code wins
over this doc; the canonical sources are `apps/worker/src/workflows/session.ts`,
`apps/worker/src/activities/agent-turn.ts`, and `packages/runtime/src/index.ts`.

## Turns

A **turn** is one logical unit of agent work inside a session: a waiting
human/API prompt, an approval or structured-input response, or one coalesced
internal-update batch is processed until the agent reaches a natural stopping
point. Human/API prompts remain the only reorderable prompt rows. The same
compact queue surface also projects canonical pending machine inputs, attached
to the prompt they will join or grouped as standalone incoming updates. Goals,
schedules, child results, and lifecycle notices never impersonate human
messages. Codex capacity recovery preserves the current logical turn directly
and is neither a queue row nor an internal update. One execution attempt runs as
one non-retryable Temporal `runAgentTurn` activity. Inside the activity the
OpenAI Agents SDK loop makes as many model calls and tool calls as the work
needs.

The same ordinary session can add and remove a realtime voice
conversational transport without creating a second session, queue, or workflow.
Only the authenticated browser owner/connection is exclusive. Human
composer/queue/Send/Steer, ordinary turns, recovery, compaction, goals, and
maintenance continue through their existing transactions and worker claims
while voice is active. Realtime and ordinary mutations still serialize on the
canonical PostgreSQL locks, but neither becomes an admission fence for the
other. Ending or expiring the owner commits `session.realtime.ended`; an expired
lease is also cleaned up lazily during a normal claim. The lifecycle is
canonical in
`packages/db/src/session-realtime.ts`, `packages/db/src/index.ts`, and
`apps/worker/src/workflows/session.ts`.

The ordinary web session composes this durable mode through one lifecycle
controller and a selected provider transport. Connected Codex keeps its native
WebRTC/V3 transport unchanged. AI Gateway models mint a single-use short-lived
browser token, connect through Gateway's normalized realtime WebSocket, and
translate only at the edge into the same pinned V3 bridge. Both therefore share
the same owner, connection epochs, ledger, context projection, delegation/Steer,
tail handoff, heartbeat, rotation, and recovery semantics. The already-mounted composer, Send/Steer,
model/reasoning/tool configuration, and queue mutations remain available while
voice is active. Its only persistent surface is a split voice action beside
Send: the primary click starts or ends the call, while the disclosure holds the
supported realtime-model choice, connection status, recovery actions, and dev
diagnostics. Realtime-model choice is intentionally independent from the
ordinary session model and remembers the user's last workspace choice. The
catalog groups OpenGeni-managed Gateway, Connected Codex, and workspace-owned
Gateway models; unconfigured credentials remain visible but disabled.
The owner operation and browser proof are
scoped to session storage and never rendered or logged. Reload replays that
same operation and rotates only the dead browser connection. Without matching
proof, the surface truthfully remains lost-owner until an end/expiry event;
there is no status API or newly invented logical mode. Canonical:
`packages/sdk/src/codex-realtime-controller.ts`,
`packages/sdk/src/gateway-realtime-transport.ts`,
`packages/react/src/realtime/realtime-control.tsx`, and
`apps/web/src/routes/session.tsx`.

Finite provider calls are hidden behind connection generations, not new
realtime modes. On OpenGeni's configured conservative proactive-rotation interval, or after a dead or
disconnected peer, the controller reuses a healthy microphone stream and
negotiates one replacement beside the active connection. PostgreSQL permits
exactly one `active` connection and one `negotiating`/`ready` replacement for a
mode. The browser activates the replacement only after its data channel opens;
that transaction advances the connection epoch, retires the old row, and keeps
the same realtime id, owner, lifecycle, and durable V3 ledger. During rolling
deployment, clients that omit the new browser-activation marker retain the old
immediate-activation behavior; hardened clients always require the two-phase
proof. Startup replay and OpenGeni client-delivery ACKs remain bound to the promoted connection,
and browser generation fences make late answers, duplicate callbacks, and old
peer events inert. Failed preparation leaves the old healthy peer active;
recovery uses bounded backoff and terminal conflicts permanently stop its retry
loop. Stop, reload without owner proof, and concurrent timer/network failure
all abort pending negotiation and release peers, timers, media, and playback.
The browser installs a raw listener synchronously when `oai-events` is created,
before any asynchronous negotiation. Its activation FIFO excludes audio deltas,
rejects malformed or over-1-MiB events, and is hard-bounded to 256 entries and
16 MiB; crossing either bound aborts that generation instead of dropping and
continuing. Negotiation plus channel-open has one abortable 20-second deadline
under the 30-second mode lease. Activation drains the early FIFO and swaps to
the direct bridge listener synchronously, with no await gap or duplicate.

Microphone and audible output are separate truthful states. Permission denial,
missing device, acquisition failure, and an ended track have deterministic
non-secret codes; a lost track is reacquired before recovery can claim input is
healthy. Remote playback never disables or serializes microphone input, so
native full-duplex GPT-Live barge-in remains provider-controlled. If browser
autoplay rejects `audio.play()`, the existing connection remains live but the UI
announces audible output as blocked and offers a user-gesture retry; retrying
playback neither begins another mode nor negotiates another provider call.
Diagnostics distinguish permission, device, autoplay, negotiation, rotation,
reconnect, lost-owner, and terminal-stop transitions without SDP, credentials,
audio, or transcript bodies.

Only provider `turn.done` events persist transcript truth: one complete
role-bearing user or assistant entry per provider turn. Live transcript deltas
remain non-authoritative. Each `delegation.created` carries the bounded finalized
dialogue since the previous delegation and records its transcript fence. When
voice ends, the browser first seals and durably drains every already-parsed V3
event. The same end transaction then selects only finalized transcript after the
latest delegation fence, excludes a late user `turn.done` already represented by
that delegation, renders a bounded Codex-style XML tail, and submits it through
the canonical ordinary `Steer` path. The associated
`session_realtime_context_projections` row is idempotency/audit provenance for
that durable tail turn; workers perform no hidden next-turn injection. An empty
tail creates no turn. A later voice call receives both bounded durable session
history and bounded prior finalized voice turns as inert, role-labeled startup
context with an explicit silence instruction. Canonical:
`packages/sdk/src/codex-realtime-v3.ts`,
`packages/db/src/session-realtime-context.ts`, and
`apps/api/src/session-realtime-context.ts`.

A provider `delegation.created` uses the same execution path as a human change
of direction. After exact owner, active connection epoch, and provider-start
proof, one transaction ledgers the call and invokes canonical prompt `Steer` on
that same session with a service initiator and immutable realtime provenance.
Idle work queues normally; active work is superseded/interrupted; queued work is
reordered by the existing Steer semantics. The call row links one-to-one to the
turn for terminal result/error projection. Invalid calls receive a deterministic
outbound error; transient admission failure rolls call and Steer back together.
No separate realtime worker-claim exception or voice-only turn semantics exist.
Completion, failure, and cancellation atomically append one turn-linked
`delegation_result` or deterministic `error` while that exact realtime
delegation remains active. Steer is session continuation: realtime receives the
accepted direction and later agent stream through session context, with no
synthetic stopped/error message. Progress uses commentary
`delegation.context.append`; completion uses speakable
`delegation.context.append`. Work that predated voice, was sent by the
human composer, or belongs to a prior voice call instead follows the active
session-wide route: commentary progress and speakable terminal output use
`session.context.append`. Accepted human Send/Steer is mirrored once through
that same session-wide route without a channel, in a typed envelope saying it
was already accepted by execution; voice therefore understands the change but
does not delegate it again. The browser durably ACKs receipt of each row from
OpenGeni. Pinned V3 exposes no provider receipt for either append event, so
provider sends remain at-least-once: a live
bridge suppresses repeat sends only within that generation after a full local
send, while a browser crash or connection rotation replays the same durable row
and may repeat an ambiguous provider append. Stale connection identities cannot
advance even the client-delivery ACK. No child session, fork, handoff framework,
or after-commit admission loop exists.

Every accepted turn also carries one immutable `TurnInitiator`. Human/API
Send and Steer capture the authenticated subject that accepted the command;
schedules, goal continuation, compaction, and coalesced internal batches use
explicit service principals. An Agent Steer remains the causal initiator when
ordinary machine notices coalesce into its inference; those notices cannot
erase the steering subject merely because they arrived in the same batch. The
session creator is stored separately and is
copied only when idempotently repairing that same create command's first turn.
Queue move/edit/resubmit preserves the original initiator, while Steer creates a
new turn with the steering actor. Agent-created work inherits the frozen
initiator through the worker-signed calling-turn reference and appends bounded
provenance. Approval, structured-human-input response, recovery, and retry
reuse the existing row and therefore cannot change authority. Legacy rows use
`{ kind: "service", subjectId: "unattributed-legacy" }`, which host credential
ports must reject rather than infer from another identity.

An embedding host may separate authorization from causal service provenance by
signing a service-only initiator into its delegated grant. The ordinary grant
subject and permissions still authorize the command; the asserted service is
only the immutable initiator of the newly created work. It cannot assert a
human subject or override a worker-signed exact agent attempt.

Connection ownership is a different axis. Capability setup defaults to a
workspace-owned OAuth/API-key connection, available under normal workspace
authorization; **Connect only for me** explicitly creates a subject-owned row.
A turn can execute a personal row only when it carries an exact immutable
`McpPersonalConnectionDelegation` containing the selected MCP server, connection,
owner, provider, and kind. Those private identifiers never enter public queue,
turn, or task payloads: the disclosure there is only `{serverId,
providerDomain}`.

Direct session creation, Send, and Steer freeze the authenticated subject's
currently selected active personal rows. Queue editing preserves that snapshot.
Agent Message and Agent Steer copy the calling turn's snapshot through the
worker-signed exact turn reference. A child session stores immutable
`parent_turn_id` and copies that spawning turn, rather than consulting whichever
turn is latest later. Approval, structured input, capacity recovery, and worker
recovery remain the same logical turn and therefore retain the same snapshot.
No path infers personal authority from the session creator, current user,
service initiator, latest connection, latest queue head, or an unrelated newer
turn.

Synthesized goal continuations inherit the model and reasoning effort from the
newest turn with a durable `turn.started` event. The session default is used
only when no turn has actually started. This keeps routing and billing
ownership aligned after an explicit per-turn switch and excludes turns rejected
during admission, whose `started_at` claim timestamp alone is not proof that
their policy ran. The continuation records the exact latest finished
`causalTurnId` and copies that turn's personal delegation snapshot when it is
materialized; a later unrelated human turn cannot mutate the frozen update.
Spawned-child terminal results retain the spawning parent-turn snapshot in the
outbox and enter the parent's bounded typed internal-update batch without
injecting a synthetic `user.message` or a human queue row. Ordinary internal
updates coalesce only when their personal delegation snapshots match; Agent
Steer remains the authoritative initiator and delegation source when compatible
notices join it. Claim persists the exact deterministic batch and authority in
`session_history_items`/the claimed turn before inference and links every member
to that row. Recovery reuses it; later reconciliation never filters it from
model memory.

Immediately after claim, the exact owning attempt installs or reads the
logical turn's accepted execution policy before credit admission, credential
allocation, compaction, or provider work. That value-free metadata policy
freezes the public product model id, provider id, upstream deployment id, credential-source
class, billing attribution, wire API, and definition version. The public id is
not necessarily the provider request id: `codex/gpt-5.6-sol`, for example,
routes upstream as `gpt-5.6-sol`. Billing and Codex allocator eligibility are
derived from the explicit accepted attribution, never from a model prefix or a
mutable active-credential snapshot; malformed present metadata fails closed.

The same accepted logical-turn boundary governs prompt policy and structured
preferences. After claim, the owning attempt installs immutable instruction-
policy and preference-descriptor snapshots reconstructed from lifecycle events
as of the turn's immutable `created_at`, not from mutable heads at claim time.
The session's normalized policy role is independent of workspace membership and
memory roles. Service-initiated goal continuations and compactions may preserve
the causal human in `initiating_human_subject_id` solely for personal
preference authority while retaining their service initiator; pure service work
has no personal authority. Runtime composition is deterministic: core safety,
organization/workspace/user preference descriptors plus organization/global,
workspace, and role policy, then session/turn instructions, tool/repository/
skill substrate, and memory. Documents and RAG evidence never become policy,
and full preference bodies require explicit retrieval. When no structured
governance applies, the legacy prompt bytes remain unchanged.

Approval, capacity wait, worker recovery, and Pause/Resume create newer
attempts for the **same logical turn**, so they must replay the original policy
rather than resolve or overwrite it; they also reuse the accepted governance
snapshots. A new user/API turn or a newly materialized goal, system,
child-result, scheduled, or compaction turn is a new logical turn and resolves
fresh execution and governance policy. Thus a per-turn model/provider switch
persists through recovery without accidentally becoming a permanent session
default, while later policy or preference changes affect only later accepted
turns.

**Runs have no length limits, by design.** What the SDK calls "turns" are model
calls; `OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN` exists but defaults to
effectively unbounded. There is no continuation cap and the agent activity's
Temporal timeout is measured in days, not hours. OpenGeni is built for agents
that legitimately run for a very long time, so **run length is bounded by
symptoms, never by counts**: the no-progress detector and budget exhaustion are
the real guards. Do not reintroduce count- or duration-based caps on legitimate
run length; if a run is misbehaving, detect the pathology, do not cap the clock.

Recoverable conditions preserve context instead of failing the session, so a
long run survives them. Retryable provider connectivity, 5xx failures, and typed
required-MCP connectivity failures resume the same accepted turn after a pacing
delay. Required first-party connect/tools-list also treats a rolling API
replacement's temporary `404` or statusless plain transport `Error` as
recovery-safe. That narrow exception does not apply to external MCP servers,
tool invocation, explicit non-404 client responses, or typed
protocol/programming failures. The retry classifier records typed out-of-band
category metadata without rewriting the exact source diagnostic retained by
OpenGeni. Only genuinely public SDK/console diagnostics receive a fixed
structural projection; raw transport messages, URLs, and response bodies remain
exact on internal data paths. Other HTTP client failures and unknown provider
codes remain authoritative and terminal. Hitting an explicitly configured
model-call cap and budget/credit exhaustion ends the current turn gracefully;
an active goal may create a later continuation, while an otherwise idle session
waits for the next user message. For an MCP timeout that escapes after a
successful tool output, conversation truth is checkpointed before the turn
settles and the continuation is a new follow-up — the completed tool call/full
turn is never blindly replayed. Budget/credit exhaustion likewise idles the turn
rather than failing the session, so a top-up lets the same session continue.

Retryable provider connectivity and 5xx failures recover the same accepted turn
after a durable 2 s, 5 s, 15 s, 30 s, then 60 s capped delay, indexed by that
turn's durable provider-recovery count rather than unrelated execution attempts.
An explicit provider retry hint is a lower bound. Rate limits use the provider's
`Retry-After` when present and otherwise wait 60 s; other retryable classes keep
their existing pacing. Every Steer commits a control wake revision, including
when the recovering turn has no live attempt. A later coalesced Send cannot
downgrade it to an ordinary queue signal, so the workflow interrupts the hold
and processes the new direction immediately.

Codex-subscription turns add one explicit recovery boundary before the model
run. With workspace-local leasing enabled, the worker atomically selects and
leases a credential under the workspace rotation-row lock; concurrent replicas
therefore observe earlier reservations. A second 401, 403, explicit quota, or
429 can quarantine that credential and requeue the same durable turn after a
conversation-truth checkpoint. Network/5xx/invalid-content/partial-stream
failures never rotate or blindly replay. The allocator, strict workspace scope,
five-hour reset semantics, and rollout fence are canonical in
[`codex-subscription-rotation.md`](codex-subscription-rotation.md).

When every allocator-enabled Codex credential is unavailable, this recovery
boundary becomes a durable capacity wait for the current logical turn, whether
or not the session has an active goal. The worker atomically closes the exact
attempt with outcome `waiting_capacity`, leaves the turn and session
nonterminal with the same active-turn pointer, and stores one session-scoped
waiter fenced by blocked turn generation, accepted policy hash, and the
effective admission gate. An active goal adds an optional id/version fence; it
does not own the waiter or the turn.

The workflow waits for the earliest authoritative provider reset or a bounded
value-free metadata refresh. Capacity-affecting writes increment a
same-transaction wake revision before a best-effort Temporal signal.
Duplicate/lost signals are harmless: row-locked re-evaluation is the sole
resume writer, and unobserved revisions repair commit-to-signal loss after
restart or `continueAsNew`; a signal delivered between waiter commit and the
activity result is compared against the workflow's pre-dispatch wake counters
and cannot be baselined away. Capacity return atomically moves that exact turn
to `recovering`; ordinary attempt admission then claims the same turn id with a
new attempt before provider/model/tool/billing work starts. It creates no
system update, new queue turn, user message, usage event, or goal continuation,
and it does not independently settle/requeue the blocked turn, poll with
inference, or redeem a reset/boost entitlement.

Ordinary prompts queued during the wait remain behind the current turn. Pause
leaves the waiter intact and lets the workflow close; Resume's revisioned
`signalWithStart` wake reconstructs it. Steer, cancellation, and changes to the
optional goal, accepted credential policy, active pointer, or blocked-turn
generation supersede the waiter/turn under their durable fences, so no stale
timer or signal can produce double inference.

Provider context-window overflow is also handled inside the activity, not by a
Temporal retry. When an OpenAI/Azure context overflow is classified,
`runAgentTurn` invokes compaction for the session's frozen mode: portable
Codex-local plaintext for non-Codex and portable-locked Codex sessions, or
Codex remote compaction v2 for `remote_v2` Codex sessions. On the portable path the summarizer
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
failed same-turn recovery atomically settles the exact turn and ends that
workflow run. Every input already visible to the model remains delivered in
durable history; it is never requeued or terminalized. Newly arriving machine
updates remain pending. Without a newer actionable work wake, the workflow
cannot synthesize another goal continuation from unchanged history. A later
human/API prompt, Steer, explicitly requested Compact, or genuinely new machine
input may create newer truth and make one new attempt.

Resolved model context metadata is authoritative on every model-facing path.
For the Codex subscription catalog this means a 272,000-token raw window, a
258,400-token effective input ceiling (95%), and automatic compaction at
244,800 tokens (90%, reached with `>=`). Local checkpoint replacement retains
only the newest real user messages that fit one cumulative 20,000-token budget,
then appends the summary; internal resume notices are never retained as user
intent. Automatic compaction uses provider-reported usage only: the durable
prior-call input count at a turn boundary, or the immediately preceding
same-activity provider total plus bounded newly appended input. With no bound
provider count, OpenGeni sends the request and recovers from a genuine provider
context overflow instead of compacting from a whole-request approximation.
Each authoritative terminal response replaces the durable count with its usable
input count or null; an omitted count never leaves an older response active.
Local media-aware estimates remain confined to compaction-request fitting and
history-only replacement reporting. See
[`context-compaction.md`](context-compaction.md).

Outside the explicit durable compaction transition, model-visible history is
append-only. Given an unchanged canonical prefix and runtime settings, every
later provider request must reproduce that serialized filtered prefix exactly.
Request-time filters may normalize computer calls, normalize provider item
identities, or bound tool output deterministically; they may not classify or
rewrite arbitrary textual content and may not remove or reorder an
earlier `view_image` call/result pair. Computer-use tools are likewise exposed
only when the caller supplies a proven visual transport: responses routes
use hosted computer tools, Codex subscription routes return structured image
results, and chat-wire or omitted/unproven public runtime routes receive no
computer tools rather than screenshot data URLs encoded as text.

Before model/tool work, a claimed turn inserts a first-class
`session_turn_attempts` row containing its exact Temporal activity id, current
trigger, monotonic dispatch generation, verified control revision, and write
lease. The same claim snapshots every per-session MCP approval policy under the
session lock and adopts the selected machine-input batch's exact personal-MCP
delegation snapshot. A real Temporal activity retry retains the activity id; a
re-dispatch creates a new attempt and captures the then-current policy. Every
event, model-history write, run-state write, compaction transition, tool receipt,
and terminal settlement must match that attempt. A typed schedule-to-start
timeout is the only no-attempt recovery case because its activity never ran.

Raw SDK tool call, result, and approval items are normalized to protocol JSON
before they enter the attempt-fenced `session_pending_tool_calls` receipt
ledger, the requires-action run-state snapshot, or a durable tool/approval event
projection. This uses the same boundary as canonical history: own object
properties with JavaScript `undefined` values are omitted as wire-absent
without mutating the SDK object, while undefined array entries and every other
non-JSON graph fail with the exact offending path. The lossless database codec
stays strict rather than silently changing arbitrary input.

Before a personal MCP is attached, the worker/Toolspace boundary revalidates the
delegation's exact workspace membership, connection id, provider domain, kind,
owner subject, and active status. A missing, revoked, transferred, or otherwise
invalid row is never replaced with another subject's connection. Only that MCP
is omitted and the turn receives a bounded visible instruction explaining that
the source was not available and must not be claimed as used; unrelated tools
and work continue. Optional-server `initialize`/`tools/list` credential misses
do not create conversational `tool.auth_needed` cards. If the model makes a
concrete `tools/call` and authentication fails, the event includes that tool
name and remains actionable.

Session creation persists skill selection but never starts a sandbox. At turn
execution, bundled, curated, pack, and inline session skills remain SDK-lazy:
only a selected skill directory is materialized when `load_skill` is called.
If repository resources are attached, ordinary repository setup first makes
their existing checkout available; runtime then indexes canonical
`.agents/skills` and compatible `.claude/skills` directories through the bound
sandbox session before the first model call. This performs no second clone,
copy, or manifest materialization. With no repository resource, that workspace
discovery capability is absent and cannot force provisioning.

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
ID, an equally sanitized typed cause, and allowlisted catalog identifiers—never
raw SQL text, a raw driver cause, or bound parameters.

After a reviewed release reaches staging, run the dry-by-default event-ordering invariant canary
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
If provider failure races with an accepted exact-attempt Pause or Steer, that
control request owns the attempt: recovery returns stale and the normal
settlement/quiescence path completes the transition. The workspace-control lock
also orders the opposite race safely—if recovery commits first, the subsequent
Steer immediately supersedes the now-ownerless recovering turn.
Terminal Cancel uses the same exact-attempt interruption fence but settles the
live turn as `cancelled`, marks the selected session and every existing
descendant terminal, and drains their queued/non-running work in the same
transaction. The workspace-control lock orders concurrent prompts and child
creation around that terminal write, so no work can appear behind the final
empty snapshot. A cancelled ancestor permanently rejects Send, Steer, Resume,
and new descendants. The cancellation transaction also advances the durable
workflow wake for every affected session, including an approval or capacity
wait with no live attempt, so the terminal row cannot leave a Temporal workflow
parked indefinitely. When the selected root is a child, the same transaction
also enqueues one deduplicated `child_terminal_result` with status `cancelled`
for its surviving parent and copies the causal parent-turn delegation snapshot;
cancelled descendants do not notify parents inside the same terminal subtree.
Only physical attempt quiescence can clear the stopping projection.
When paused control remains authoritative after that receipt is durable, the
session parks as `idle` while retaining the same `recovering` logical turn and
active-turn pointer. This is projection settlement only: no claim, model/tool
work, queue row, or parent-completion notice is created. Resume later admits
that preserved turn with a new exact attempt.
Each Pause/Steer cause is a durable `session_attempt_interruptions` row; the
workflow's `sessionControl` signal is only a wake hint to settle those rows.
Wake repair treats only an undelivered control revision, an actionable
interruption, or a settled interruption whose exact attempt still lacks its
quiescence receipt as control work. A fully quiesced historical interruption is
audit evidence and cannot upgrade a later ordinary queue wake to
`sessionControl`.
For Agent Steer, accepting that signal is not an admission acknowledgement: if
effective control is active while the newest `agent_steer_instruction` remains
pending, the delivery path leaves its coalesced workflow-wake revision
unacknowledged. The bounded outbox dispatcher can therefore redeliver across a
workflow close or `continueAsNew`; the attempt-fenced Postgres claim consumes
the newest instruction once, so duplicate signals cannot duplicate inference.
A real Pause is the truthful blocker and may acknowledge the old revision;
Resume commits a fresh revision for the preserved pending instruction.

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
quiesce, stops and drains attempt-owned Git, Toolspace, and generic
run-credential renewal/materialization writes, and immediately writes
`session_turn_attempts.quiesced_at` before
attempt-qualified credential deletion, cache, recording, provider, lease, or
workspace housekeeping. The
receipt, its `session.queue.changed` event, the session queue/sequence update,
and the exact `session_workflow_wake_outbox` revision commit in one retryable,
idempotent transaction. Provider completion and batch flushes that ignore
cancellation are detached with rejection handlers; all later housekeeping is
attempt-fenced and detachable. While either logical interruption or the exact
physical receipt remains pending, `effectiveControl.settlement` stays typed as
`stopping` and reports `attemptCount`, `interruptionPendingCount`, and
`quiescencePendingCount`; Resume does not clear or bypass that receipt gate.
Hosted POSIX process cancellation still validates the exact PID, process group,
and randomized command token before signalling; it reads those facts through
`ps` when available and Linux `/proc` when a minimal image omits procps. Missing
or malformed identity remains fail-closed. An explicit `tty:false` command keeps
pipe-mode stdin/stdout/stderr and never receives terminal control bytes during
cancellation; the same marker-bound process-group TERM/KILL proof remains
authoritative. Omitting `tty` preserves the existing interactive default.

The direct receipt remains the preferred path. If its three Postgres attempts
exhaust, `runAgentTurn` does not suppress the failure or infer a receipt from
Temporal terminal state. It instead retries delivery of one immutable physical
proof through `signalWithStart`, using a 250 ms-to-5 s bounded delivery backoff.
The proof binds the exact account, workspace, session, attempt, workflow id,
workflow run id, and activity id; retrying changes none of those fields and
retries only Temporal delivery, never DB eligibility or workflow state. A
missing signaler or an activity exit without either a committed receipt or an
accepted proof fails hard.

The workflow deduplicates an accepted proof and, before every ordinary peek,
close, or `continueAsNew` boundary, passes it to a DB-only control activity.
That activity has bounded executions with unbounded Temporal retry and calls
the same idempotent receipt transaction. Under the canonical control →
workspace → session → turn → attempt locks, the transaction additionally
matches the proof's exact account/workflow-run/activity dispatch before it may
set `quiesced_at`, append the queue event, advance session sequence/version, and
enqueue the exact wake revision. The signal is durable recovery evidence, not
admission authority. NATS publish happens only after the transaction and is
best-effort live fanout; a NATS failure cannot trigger proof recovery or undo a
committed receipt.

Settling or stale-rejecting an interruption atomically commits its own durable
control wake. While the receipt is absent, wake acknowledgement remains pending,
`peekSessionWork` returns `cancellation-wait`, and every claim path remains
`control-pending` from the interruption ledger alone—queue presentation metadata
is never admission authority. The workflow waits up to five seconds for a wake
and may then close without running another turn activity; the outbox continues
bounded redelivery until the exact activity disappears or supplies its proof. A
proof accepted at that timeout boundary is persisted before close. Once the
receipt commits, its coalescing outbox wake uses
`signalWithStart` on the same stable workflow id, which restarts the exact
session and admits the replacement once. This event-driven path needs no
quiescence scanner, inferred timeout, polling loop, synthetic user message,
prompt/history/effect replay, or duplicate visible queue row. Admission searches
all closed attempts for a settled or stale-rejected interruption that still
lacks its receipt; a newer recovery generation cannot hide the exact predecessor
that a queued Steer is waiting for. Reconciliation still requires the bound
Temporal activity to be absent, heartbeat-expired, or attached to an exact
workflow run that Temporal reports as missing, plus no open workspace writers
or retained processes—elapsed time alone is never proof. Queue telemetry follows
the latest live interruption and any exact predecessor referenced by a queued
human/API Steer, so `stoppingPreviousAttempt` remains truthful without allowing
unrelated historical attempts to contaminate current UI.
The same DB-only reconciliation lane also repairs a paused pre-fix row whose
receipt is already durable but whose session status still says `recovering`;
that case skips Temporal liveness inspection and idempotently parks only the
session projection.

Sandbox lease warming is bounded for the same reason: it is a capacity/setup
symptom, not legitimate agent work. A turn that attaches while another worker is
creating the group sandbox waits at most
`OPENGENI_SANDBOX_WARMING_TIMEOUT_MS` (default 600000). If the lease does not
reach `warm` in that budget, the activity fails the turn with a clear
backend/capacity timeout instead of heartbeating forever. When a provider create
does return, the worker immediately records the provider instance id on the
warming lease before readiness/display/setup work; any later setup failure
terminates that just-created sandbox before the lease can be retried.

Lease liveness is not provider or workspace truth. The durable recovery
projection independently records provider existence, archive availability,
restore progress, and verified workspace readiness alongside lease liveness and
epoch. API attach/swap paths therefore resume the exact live instance and pass a
bounded command probe before reporting success. A legacy `warm` row projects to
`unknown` until that verification succeeds; a provider `NOT_FOUND` instead
retires only the exact `(lease_epoch, instance_id)` and advances the epoch once.

A lost provider is rematerialized by one cold-to-warming winner. Under the lease
row lock it selects one versioned archive revision. A native Modal revision must
match its immutable current artifact receipt, source mutation generation, and
canonical provider-workspace binding; the exact authenticated client embedded
in the created session must match that binding before hydration. A real tar
revision instead carries byte/hash plus deterministic content-tree metadata.
Repeated starts with the same rematerialization id are idempotent; rivals and
stale progress/commit writes are fenced. Native restore trusts Modal's snapshot
semantics and verifies receipt/readiness; only tar restore verifies the restored
tree. A partial hydrate or failed verification terminates the unpublished box
and leaves typed degraded/unrecoverable state; it never publishes a clean
replacement, a previous revision, or a mixed snapshot. A legacy per-session
archive can participate only after its archive fields—never provider identity—
are imported and selected under that same lock.

Concurrent routed calls may all discover the same missing provider. Exactly one
observer wins the lease-loss transition; the others receive typed `superseded`
recovery. Each ambiguous operation is invoked at most once and is never replayed
on a replacement backend. In the winning loss transaction, every active
retained process on that exact lease epoch/provider is marked lost, all matching
open admissions are rejected, matching PTYs are closed, and only those process
holders are removed before the epoch advances. Terminal processes and every
other epoch/provider remain untouched. During idle drain, a resumable cloud box
is deleted only after a verified workspace capture is durably folded onto the
fenced lease. Definitive `NOT_FOUND` before capture preserves any existing
archive or records typed unrecoverable truth when no durable revision exists.

An older deployment may have committed the cold/advanced-epoch transition
before settling the exact lost-provider blocker rows. The exceptional operator
path is blocker-first: one DB-only, repeatable-read/read-only preview binds the
full account/workspace/session/group, lease/epoch/provider/route,
workspace/archive/verification tuple, fresh externally supplied provider-object
observation, and every process/admission/PTY/holder/interruption identity into a
`clrp1:` receipt. Unknown, incomplete, possible-writer, or mismatched truth
blocks. Apply accepts only that exact reviewed receipt, re-previews before and
under row locks, and settles the same narrow rows as the automatic loss
transaction. It never calls a provider, changes epoch/archive/recovery truth,
writes `/workspace`, or replays an ambiguous operation. The exact runbook is in
[`deployment.md`](deployment.md#cold-lost-provider-blocker-reconciliation).

Every operation that may mutate a persistable `/workspace` first enters one
lease-scoped turn/direct/process admission ledger. In one transaction, admission
binds the session group, warm lease epoch, provider identity, and pinned route to
the canonical turn attempt, an API request UUID held as `direct:<request UUID>`,
or an exact retained-process UUID held as `process:<process UUID>`, then
increments `workspace_generation` and inserts the operation row. The exact
provider promise is physically settled as `resolved` or `rejected`; a resolved
result then passes the matching authority/lease/provider/route acceptance fences
before its output is accepted. Only a turn admission can use authoritative
`session_turn_attempts.quiesced_at` for its exact attempt; direct and process
authority remain capture blockers until settled.

A yielded process promotes its parent admission to retained state and creates
the non-TTL process holder in the same transaction before any caller receives a
live locator. The exact parent admission, process UUID, provider locator, lease
epoch, provider instance, and route remain pinned across active-pointer movement.
Model/user stdin is a separate process-owned mutation admission. Resize, EOF,
cancellation, helper exec, and drain polling are process control: they may prove
exit/loss but do not advance `workspace_generation`. Exact exit/loss atomically
settles the parent and process holder and closes any matching PTY; duplicate
identical proof is idempotent, while missing/conflicting proof keeps the fence
closed. Normal turn finalization invokes this same physical drain for every
registered yielded shell before workspace capture, independently of whether a
Pause/Steer quiescence receipt is required. Connected Machines and other
non-persistable routes do not dirty the provisioned cloud-home generation.

If an owner finalizer or worker dies before reaching that settlement, the sole
global lease reaper also runs a bounded, oldest-due reconciliation batch. A
direct owner or closed exact turn attempt makes a process eligible for provider
inspection only: owner/turn state, row age, timeout, and expired claim are never
physical-exit proof. The worker resumes the exact persisted provider envelope
and accepts only an exact SDK exit banner, exact provider-session-lost banner,
or structured provider-instance `NOT_FOUND`. It durably checkpoints that proof
before calling the same canonical settlement transaction, so a worker crash in
between can reclaim coordination without probing again. Running, malformed,
unsupported, identity-mismatched, timed-out, and transient provider results are
deferred without changing the process, admission, PTY, holder, lease, archive,
snapshot, or workspace generation. Settlement copies and fences the process
UUID, parent admission, process holder, lease/group, provider backend/instance,
lease epoch, route target/epoch, and provider session; exact replays are
idempotent and cannot touch a successor. This reconciliation never calls a
provider terminate/kill API and never captures or rotates a workspace snapshot.
The app exports bounded owner-state/backlog, reconciliation, and expired-drain
metrics; dashboard/PromQL integration is coordinated separately.

Capture preflight and archive fold block on every unsettled admission and live
direct/process holder in the closed write set. Publication is complete only when
that set is proven closed and `archive_generation === workspace_generation`.
Admission, ordinary settlement, and yielded-process promotion acquire the
canonical workspace/session/attempt-or-process prefix before the admission and
lease rows. A provider-terminal settlement retries only its idempotent database
transaction on PostgreSQL deadlock/serialization failure; it never reissues the
provider operation. This prevents one parallel completed command and one yielded
command from deadlocking, rolling back one settlement, and freezing checkpoint
capture behind an admission that is no longer physically running.
Late, concurrent, or replayed requests either remain blockers or are admitted
into a successor generation; no admitted operation is replayed after provider
rejection, provider loss, or a failed acceptance fence.

Terminal execution follows the same physical boundary. `terminalExec` does not
return a yielded process: success always carries a numeric `exitCode` and
`running: false`. Timeout or a non-timeout failure after yield first drains the
exact process group and settles retained authority; timeout cannot return while
the process or its durable admission remains live. PTY open returns only after
durable promotion and persistence of its exact process identity, and PTY close
leaves metadata open until exact exit/loss proof exists.

Migration `0117_sandbox_recovery_generations.sql` activates this protocol as a
one-way maintenance cutover. Stop all old API, control-worker, and turn-worker
writers first. A live `opengeni_app` session rejects activation with SQLSTATE
`55000` and the transaction rolls back cleanly. Application/image rollback to an
old writer is permitted only before activation; after activation no old writer
may restart, because there is no mixed-version or down-migration path.

**Worker restarts are survivable.** A graceful worker shutdown (a deploy or
rollout restart delivers SIGTERM; Temporal cancels in-flight activities with
reason `WORKER_SHUTDOWN`) checkpoints conversation truth and the sandbox
envelope, closes the exact attempt as recoverable, and leaves the same logical
turn in `recovering`. It never creates a human queue row or synthetic user
message. Any in-flight side-effecting tool call is durably closed with an
explicit `interrupted / outcome unknown` result before the next attempt can
run; this includes Toolspace calls, whose pending receipt is written before the
remote request. A late result is retained only as rejected evidence. The workflow then
creates a fresh attempt for that same turn on a healthy worker and reconstructs
model input from durable model history and tool-call lineage. At most the
single in-flight model step is lost, the same bound as a crash. This is an
explicit checkpoint/resume, not an automatic Temporal retry. A newer control
revision, terminal state, or successor attempt wins instead of being
overwritten.

Resource-based turn workers use that exact graceful path as continuous memory
headroom protection. Temporal's slot tuner closes new admission when its
configured memory target is already exhausted, but an admitted long-running
turn can retain native or external memory afterward. The worker therefore
samples whole-host `MemAvailable` and any finite cgroup memory scope while it is
running. If one scope stays at or above `OPENGENI_TURN_WORKER_TARGET_MEMORY_USAGE`
for `OPENGENI_TURN_WORKER_MEMORY_GUARD_SUSTAIN_MS`, the worker stops polling via
its ordinary lifecycle drain; the sampling cadence is
`OPENGENI_TURN_WORKER_MEMORY_GUARD_INTERVAL_MS`. This is neither an activity
timeout nor a hard kill: conversation truth, pending side-effect receipts, and
outcome-unknown settlement retain the same authority described above, and a
replacement worker recovers the same logical turn without replaying an
ambiguous provider operation. Fixed-concurrency and control workers do not run
the guard.

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
Only `cancelled` — an explicit terminal Cancel — is irreversible.

Every transaction that creates or re-enables workflow work also increments the
session's durable wake revision. An active goal has a second, goal-owned
monotonic wake/observed pair: terminal settlement advances it in the same
transaction as the workflow wake, and continuation materialization observes it
only alongside the typed update, event pair, usage fact, session transition,
and successor workflow wake. Single-target producers signal directly;
recursive controls trigger the bounded dispatcher once without loading the
affected tree into API memory. Successful delivery acknowledges the exact
revision, and the dispatcher retries only due unacknowledged rows.
Temporal is therefore a nudge, never the work ledger, and a commit/signal crash
cannot strand the prompt. Repaired wakes inspect unsettled exact-attempt
interruptions so a live Pause/Steer still reaches settlement. The workflow
records a monotonic signal version before its final activity chain and refuses to
return when a signal arrived during that chain, closing the completion race.

## Goals — what makes long runs continue

Agents stop prematurely. A **goal** flips the default so terminal settlement of
the last turn arms one durable Postgres continuation obligation and the agent
must explicitly `goal_complete` or `goal_pause` to stop. A locked transaction
materializes one revision as one typed goal-continuation update, its audit
events and usage fact, the exact latest finished causal turn plus its personal
delegation snapshot, and the next workflow wake. The stable
`goal-continuation:<goalId>:wake:<revision>` identity makes a lost commit
response/retry a no-op rather than another logical continuation. The update
joins the next bounded internal batch and never appears as a human queue row.

Queued human input and Steer always win; approval, same-turn recovery,
provider-capacity wait, recursive Pause, and cancellation block synthesis.
Temporal activity failure records a delayed outbox wake and may close the
workflow; `signalWithStart` later reconstructs delivery from Postgres without a
human message or model polling. A dead worker may re-dispatch the same logical
goal turn under a new fenced attempt, but cannot materialize or bill another
continuation. The goal API projects scheduled/running/blocked/invariant-broken
from one repeatable snapshot so UI state never guesses from `active` or `idle`.
Agent `goal_update` is itself a revisioned command: its stable operation key is
target-scoped across replacement attempts, while the receipt retains the
original attempt for audit. Receipt/result, goal version, session-sequenced
event, and mutation commit atomically. A lost response can therefore be
reconciled from a recovered attempt without double-applying the update, and an
old replay returns its stored result rather than overwriting newer goal truth.
Full detail in `docs/goals.md`; goals are bounded by progress/budget guards, not
counts.

## Memory — three stores, three jobs

A session's content lives in three places. Keep them straight; reaching for the
wrong one is the classic mistake.

1. **`session_history_items` — conversation truth (the model-facing store).**
   Ordered, protocol-preserving SDK `AgentInputItem` JSON, exact for accepted
   content and RLS-scoped. Token-shaped strings, headers, assignments, URLs,
   PEM-looking text, and configured-secret-shaped strings are never classified
   or rewritten. A new turn's
   input is built from this store. It is dual-written as the agent streams
   (reconciled after every model response and at every turn-end path) so a crash
   loses at most the single in-flight model call. Ordinary inference has no
   second conversation-memory read path. At this persistence boundary only,
   JavaScript SDK object properties whose value is `undefined` are treated as
   absent, matching their JSON wire meaning; arrays and every other non-JSON
   graph fail closed with the exact offending path. Historical inline image and
   screenshot items remain backward-compatible model history. New
   `computer_screenshot` typed PNG bytes are validated and retained before
   persistence; every new history copy receives the deterministic bounded
   artifact receipt (or an explicit unavailable fact), never the provider object
   key or re-encoded base64 source.
2. **`agent_run_states` — requires-action resume only.** The serialized SDK `RunState`
   blob is an opaque, SDK-version-gated process checkpoint. Its one legitimate
   job is resuming a turn that paused mid-flight for a human approval or
   structured-input tool call (`requires_action`); neither a half-finished tool
   approval nor an unanswered tool call can be represented as plain history
   items. Before the blob is written, every copy of a retained screenshot tool
   result inside the RunState is compacted to the same retry-stable receipt.
   The blob is written only for those cases.
   Historical sandbox envelopes receive one exact-path compatibility repair before
   SDK validation: invalid non-record `exposedPorts` values are removed only from
   the root and `sessionsByAgent[*]` session envelopes, while provider state and
   every unrelated RunState field remain intact. Provider predeclared-port arrays
   stay in provider state and are never emitted as SDK endpoint records.
   Do not use it as conversation memory.
3. **`session_events` — the exact human/audit timeline for accepted payloads.**
   Append-only, per-session sequence numbers, drives replay/SSE/UI. Event content
   is never secret-scanned or rewritten. The event, SSE, monitoring, and browser
   contracts still apply deterministic count/byte/media bounds; those bounds are
   content-agnostic protocol limits with explicit omission metadata, not secret
   classification. Inline media is represented by a compact `media_preview`; its
   bytes are not retained by that generic bounded path.
   A newly retained `computer_screenshot` event instead carries only its closed
   session artifact receipt after settlement succeeds, or a typed unavailable
   reason if validation, quota, or storage could not establish that receipt.
   Events remain a separate timeline and must never be used to
   reconstruct the target session's model conversation. A manager can inspect an
   independently bounded cross-session monitoring projection as ordinary tool
   output; that does not turn audit events into conversation truth.

Retained screenshots have a separate database/object lifecycle, not a fourth
conversation store. Preparation creates a deterministic pending file/artifact
pair and reserves exact workspace bytes. Verified provider settlement moves
`quota_state` from `reserved` to `ready` once; duplicate settlement replays the
same ready row. Session, turn, and attempt deletion use nullable `SET NULL`
references plus `cleanup_queued`, preserving the object, file row, and charged
quota until maintenance owns cleanup. Generic file deletion is restricted while
the lifecycle row exists.

The global bounded reaper claims stale pending, expired ready, and queued
cleanup rows with an exact UUID. A reconcile observation that is missing or
mismatched must first atomically promote that exact claim to `cleanup_pending`;
only then may it issue the idempotent provider delete. If a concurrent writer
settles the artifact ready, settlement clears the claim, promotion fails, and
the reaper cannot delete the live key. Terminal completion releases the
artifact's explicit reserved/ready quota bucket idempotently. Detached-session
cleanup removes the lifecycle and file rows only after provider deletion; a
late PUT racing parent deletion is compensated by deleting the now-unowned key.
Authenticated session artifact routes expose sanitized metadata and one bounded
range at a time, and the SDK verifies assembled length and SHA before React
renders an object URL.

Structured human input adds a durable control checkpoint, not a fourth memory
store. When the built-in `request_human_input` tool interrupts a run, the same
transaction stores its request rows, the opaque `agent_run_states` checkpoint,
the `requires_action` projection, and requested events. The request row is
owned by the exact turn execution generation; its creation attempt is only
provenance. Answer, allowed skip, expiry, or cancellation is first-writer-wins
and becomes structured output for that same SDK tool call. It never becomes a
synthetic queue row or `user.message`. A replay-safe workflow timer settles
expiry, Pause preserves the pending interruption, and permanent replacement
settles it as cancelled. Canonical: [`human-input.md`](human-input.md).

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

Sandbox recovery state is persisted separately again. The group lease owns the
authoritative provider/archive/restore/workspace projection and epoch;
`sandbox_session_envelopes` stores the small per-session provider/manifest
descriptor used to reattach and can supply a legacy archive only through the
lease's atomic revision-selection step. Both are decoupled from the RunState
blob. The current artifact's `archive_generation` remains the immutable capture
boundary while later tool admissions advance `workspace_generation`. Global
holder reconciliation claims a bounded lease-first `SKIP LOCKED` batch before
it deletes stale holders or recomputes counts, so an in-flight acquire is
deferred to the next sweep rather than overwritten from a pre-wait snapshot.

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
If Codex nevertheless rejects that exact opaque artifact with its recognized
HTTP-400 encrypted-content family, the current attempt atomically marks only
the exact active reasoning/compaction row IDs and the current turn's latest
RunState receipt containing opaque artifacts that participated in the rejected
request as provider-invalid.
Their durable rows, readable content, provenance, and timeline truth remain
intact. Recovery then reclaims the same logical turn with a new attempt and
builds one temporary input view that omits or neutralizes only that rejected
identity; an unusable remote-compaction blob is omitted because no portable
plaintext exists. Credential identity is irrelevant. A generic 400, a different
provider error, or a rejection that invalidates none of that exact candidate set is terminal
rather than an equivalent retry loop.

Subscription, model, and provider-route changes never alter canonical history
or a saved approval RunState. Responses consumes canonical history directly;
Chat Completions receives one request-local transcript projection only for item
types its wire protocol cannot represent. Historical `tool_search` and other
tool call/output pairs are completed facts, not authorization to execute again.
The projection is discarded after the request. Portable sessions may switch
between supported providers; `remote_v2` sessions remain Codex-only.
