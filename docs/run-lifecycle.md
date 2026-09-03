# Run lifecycle: turns, goals, and memory

This is the orientation for how an OpenGeni agent run actually executes over
time. It ties together three subsystems a contributor touching the session
workflow, the worker activity, or the runtime must keep straight. Code wins
over this doc; the canonical sources are `apps/worker/src/workflows/session.ts`,
`apps/worker/src/activities/agent-turn/` (orchestrator `run.ts`), `packages/runtime/src/index.ts`,
`packages/runtime/src/model-input.ts`, and `packages/runtime/src/run-events.ts`.

## Turns

A **turn** is one logical unit of agent work inside a session: a waiting
human/API prompt, an approval or structured-input response, or one coalesced
internal-update batch is processed until the agent reaches a natural stopping
point. Human/API prompts remain the only reorderable prompt rows. The same
compact queue surface also projects canonical pending machine inputs, attached
to the prompt they will join or grouped as standalone incoming updates. Goals,
child results, and lifecycle notices remain internal machine inputs. A pure
scheduled-occurrence batch that creates a standalone scheduler-owned turn is
the deliberate model-facing exception: its durable history item uses the `user`
role so the model receives a fresh task boundary, with exact task/run/update ids
and an instruction to refresh mutable external state. A scheduled occurrence
attached to an existing human/API turn remains system-role context. The fresh
task boundary never impersonates a human in backend authority: the turn
initiator remains the scheduler service and its frozen causal-human,
personal-connection, provider-account, audit, and settlement facts remain
unchanged. Codex capacity recovery preserves the current logical turn directly
and is neither a queue row nor an internal update. One execution attempt runs as
one non-retryable Temporal `runAgentTurn` activity. Inside the activity the
OpenAI Agents SDK loop makes as many model calls and tool calls as the work
needs.

Session display titles are durable session metadata, not a truncation of model
history. Creation and migration use `New conversation` only as the durable
marker that semantic naming is still pending. Human-facing clients render a
short, sensitive-safe opening-prompt preview while that marker (or a legacy null
title) remains. Unsafe leading lines are skipped, so a pasted URL followed by a
normal request still gets a useful immediate label; if no safe prompt line
exists, a short session reference keeps rows distinguishable without exposing
prompt bytes. The preview/reference is display-only, never persisted or searched
as title metadata, and the client naturally yields when `session.title_set`
arrives.

The first-party `session_create` tool is the bounded exception for an
agent-created child: the manager may provide a concise semantic title, and an
omission derives one from the delegated goal or initial message through the same
sensitive-safe automatic-title normalizer. The title row mutation and
`session.title_set` event commit in the child's atomic initial-state transaction,
before its first turn can wake. Public REST/SDK creation does not gain a title
field, and a human title still wins over every automatic write. If every child
candidate is rejected as sensitive or unsuitable, the ordinary pending marker
and first-turn self-heal path remain.

While a session still has the pending marker, and its exact selected first-party
tool and permission policy permits `set_session_title`, the production runtime
removes that operation from the model-visible catalog for the attempt and starts
one bounded, tool-less title request beside the ordinary response stream. The
sidecar uses the same resolved provider and credential authority, receives only
a bounded conversation opener, and is metered as its own model call. The main
agent does not wait for a title tool result or make a title follow-up model call.
When the main stream reaches normal settlement, the worker waits for the
already-running bounded sidecar and joins it without cancelling. Exceptional or
cancelled exits abort and join any still-pending sidecar. A completed candidate
then uses the canonical title mutation, which updates the session row and
appends `session.title_set`. Generation or persistence failure leaves the safe
pending marker in place, and a human title remains protected from every later
automatic write. Historical fallback sessions therefore self-heal on their
next eligible model turn.

`OpenGeniRuntime.generateSessionTitle` is a rolling-compatible optional seam.
Older or custom runtimes that do not implement it retain the prior attempt-local
`set_session_title` tool plus one-shot model instruction, so an embedding host
does not silently lose automatic naming during an upgrade. That compatibility
path remains serialized; the production runtime takes the parallel path.

Ordinary Send acknowledges locally before transport completion. The composer
freezes the exact text, annotations, resources, settings, and one
`clientEventId`, clears the visible draft immediately, and renders that snapshot
directly in chat when admitted toward execution, in the prompt queue when it
must wait behind work, or as `Not sent` after a definite rejection. Rapid
distinct sends keep distinct keys and preserve order: while the first admission
is unsettled, the next Send is provisionally placed in the queue and never
bounces between surfaces. An outcome-unknown retry first reconciles and reuses
the same key; a definite rejection retry receives a fresh key. Newer edits are
a separate draft shadow and survive the in-flight operation and remount. The
optimistic row disappears when the authoritative `user.message` arrives, so
HTTP-first, SSE-first, reconnect, and remount paths cannot create duplicate
visible messages.

The outside and inside composers are separate authorities. Before a session
exists, `new_session_drafts` owns the next session. Inside a session,
`composer_drafts` owns the next message for that actor/session; navigation and
workspace defaults do not copy policy between them. Send/Steer submits one exact
inside draft revision and the server rotates that row to a blank next revision
in the same transaction that freezes the queued turn. Every queued turn therefore
retains its own text, resources, model, reasoning, and latency. Editing a queued
turn checks that exact snapshot back into the inside composer atomically, and a
nonempty composer is replaced only after explicit confirmation. An independent
session fork copies the source session's exact typed reasoning and latency; it
does not invent defaults or consult either composer.

On the server, prompt acceptance remains one canonical Postgres transaction:
the user event, physically queued turn, immutable admission routing,
session/queue state, optional realtime mirror, audit receipt,
`agent_run.created` usage fact, and workflow-wake outbox revision commit
together. The response is built from those returned committed rows.
NATS and workspace-control fanout plus the immediate Temporal wake attempt are
scheduled only after commit and are not response-holding; durable event replay
and the wake outbox recover their failures.

One narrow Send exception prevents a conversational answer from getting stuck
behind the question it is answering. When the active, unpaused branch is in
`requires_action`, a normal human Send is promoted inside that same transaction
to Steer-equivalent replacement: pending human-input or approval state is
cancelled, the new prompt is inserted at the head, and its routing is
`accepted_for_steering`. Running, recovering, and capacity-waiting turns retain
ordinary Send queue semantics. An explicitly paused branch also remains inert;
only Resume or an explicit Steer activates it. Resubmitting a checked-out queue
Edit also keeps ordinary queue placement: it is a revision of already accepted
work, not a new conversational answer to the active wait.

An owner-authored `personalResourceAttachment` is part of that same accepted
work transaction for create, Send, and Steer. The server derives the fixed
personal Variable Set/Rig/selected Connected Machine closure from the locked session; callers never issue
a grant and then send work in a second operation. `once` is consumed against
the logical turn id, so every recovery attempt for that turn copies the same
immutable snapshot. It is never copied to a queue edit, goal continuation, or
machine-input successor; editing a queued once-bearing turn is rejected.
`session` and `always` remain live grant generations for later causal turns.
Revocation cannot erase bytes already injected into a running sandbox, but it
rejects every later resolution and recovery admission. Realtime session staging
does not accept this intent because it has no initial logical-turn boundary.

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
The same-browser owner record also carries a versioned, bounded delegation
replay journal. A delegation snapshot is written before it enters the bridge
queue; successful sync advances the journal from the exact pending entry to its
accepted item identity before in-memory acknowledgement. Reload recovery
requeues pending snapshots without rereading host context and suppresses
accepted provider duplicates. Malformed, normalization-changing, oversized,
over-count, or unwritable journal state fails closed and stops that connection
generation instead of mutating or dropping durable work; terminal mode
settlement removes the owner record and journal together.
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

That same exact calling-turn boundary supplies an agent-spawned child's omitted
model, reasoning effort, and latency mode. Explicit child values may override
them. A Codex-subscription manager therefore keeps its external billing path for
workers by default instead of falling back to the deployment's OpenGeni-credit
model.

The prompt queue is not worker backlog. `session_turns.status = 'queued'` means
the worker has not claimed the physical row; it does not decide whether the user
sees a queued prompt. Immutable `session_turns.prompt_routing` records that
admission decision: `accepted_for_execution` and `accepted_for_steering` stay in
chat, while only `queued_for_execution` appears in the prompt queue. Null remains
a conservative visible-queue fallback for rolling/legacy writers. New durable
`user.message` and `turn.queued` events repeat the same routing fact so live
streaming and reload reconstruction cannot briefly place a prompt on the wrong
surface. In particular,
human prompts preserved behind paused session/workspace gates are intentionally
ineligible and do not schedule an activity. Fleet pressure comes from Temporal's
dedicated `runAgentTurn` activity queue (`approximateBacklogCount` and oldest
backlog age), together with the turn workers' used/memory-safe slots. Each turn
worker must obtain a cgroup-aware slot before polling. Admission is capped at the
measured density of 16 and reserves a hard 100 MiB per turn plus 512 MiB of
runtime/native headroom; a finite container that cannot safely admit one turn
does not start. The invariant is checked both before and after Temporal's native
worker construction, and live retained-memory growth contracts new slot
availability. Before decoding model-facing JSONB, PostgreSQL rejects a complete
active transcript above any of four materialization limits: 15 MiB UTF-8 JSON,
8,192 rows, 131,072 decoded JSON nodes, or 65,536 object properties. It never
silently trims conversation truth; normal proactive compaction keeps long
sessions under the boundary. Pause stores only the open-suffix sentinel; the
approval/run-state serving envelope still rejects leftover SDK heaps above 3 MiB,
65,536 nodes, or 32,768 properties so they cannot enter a serving worker. A missing or malformed Temporal task-queue stats
object is a failed read and makes the capacity sample stale; it is never
normalized into a fresh zero backlog. The release target remains at most
50 MiB incremental RSS per active turn. A production read-only forensic
fingerprint over 3,823 sessions exited 137 inside a 1 GiB serving API pod; heavy
forensics and density profiling therefore run only in a bounded non-serving
execution class and never in API or turn-worker serving pods. See
[`deployment.md`](deployment.md) for the reproducible density harness.

Compact agent discovery keeps that queue boundary intact. `queuedPromptCount`
reports waiting human/API work, while `sessions_list` `includeLastMessage` and
the MCP `session_events` monitoring read omit a human/API `user.message` whose
accepted turn was never claimed, so an orchestrator cannot mistake a waiting or
pre-claim-terminal prompt (deleted, edited, cancelled) for processed
conversation. The predicate is `session_turns.started_at IS NULL`: every claim
path stamps `started_at` in the transaction that moves the turn to `running`
and nothing clears it, so it cannot drift with the status vocabulary. Once the
turn is claimed the exact stored row appears at its original sequence. Two
consequences follow: an admission-rejected human/API turn (never claimed,
settled `failed`) keeps its prompt hidden from agent monitoring while its
`turn.failed` stays visible, and a turn that the removed worker-death
preemption requeue (`requeuePreemptedTurn`, Jun 12 - Jul 14 2026) reset to
`started_at IS NULL` and that was cancelled before any re-claim stays hidden
there too. The probe is served by the partial index
`session_turns_unclaimed_prompt_trigger_idx` (migration 0322). The
filter is agent-monitoring only: REST event pages (which the browser composer
uses to reconcile an outcome-unknown Send by `clientEventId`), SSE, and forensic
reads stay byte-identical, and stored events are never rewritten.

Related-work search is another compact projection over this same durable state,
not a new run-lifecycle input. It searches semantic titles, active goals, and
bounded typed work claims only after ordinary authorization/host narrowing; it
never searches opening prompts or makes a claim control the turn, goal, queue,
or worker. Terminal goal/session lifecycle settles active claim evidence while
Pause and recovery preserve it. See
[`work-discovery.md`](work-discovery.md) for the complete authority, ranking,
mutation, and rollout contract.

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
If operational database access fails after the atomic attempt claim but before
turn-start completion, the activity exports only the exact turn, trigger,
generation, and safe database failure class. The workflow's unbounded-retry
DB-only control lane revalidates that identity, closes the same attempt as
recovering, and backs off before a replacement claim; it never converts the
claimed inference into a terminal failure or a new prompt.
The same database-owned transition covers a lost claim commit response: if the
activity reports retryable pre-claim failure but the control lane finds its
exact active attempt, that durable attempt wins and is recovered.

SuperGrok/xAI connected-subscription work separately freezes an identifier-free
`workspace | user` provider-account authority snapshot. Workspace is the
default shared pool. User scope is explicit/private and remains bound to the
exact initiating human. Send, Steer, edits, children, goal continuations,
schedules, compaction, and internal updates copy only their exact causal
snapshot; runtime never substitutes the session creator, current browser user,
worker identity, or another member's account. See
[`supergrok-subscription.md`](supergrok-subscription.md).

The same accepted logical-turn boundary governs prompt policy and structured
preferences. After claim, the owning attempt installs immutable instruction-
policy and preference-descriptor snapshots reconstructed from lifecycle events
as of the turn's immutable `created_at`, not from mutable heads at claim time.
Service-only turns have no human preference scope and skip the preference
snapshot capability entirely; service continuations carrying a frozen causal
human and legacy subject turns still snapshot that human's applicable entries.
The session's normalized policy role is independent of workspace membership and
memory roles. Service-initiated goal continuations and compactions may preserve
the causal human in `initiating_human_subject_id` solely for personal
preference authority while retaining their service initiator; pure service work
has no personal authority. Runtime composition is deterministic: core safety,
organization/workspace/user preference descriptors plus organization/global,
workspace, and role policy, then durable session instructions, tool/repository/
skill substrate, and memory. Optional application `modelContext` is not part of
that prefix: claim stores it as a separate leading `input_text` part of the
exact chronological user message. Standard timeline rendering omits it, while
full audit data retains it. Documents and RAG evidence never become policy,
and full preference bodies require explicit retrieval. When no structured
governance applies, the legacy prompt bytes remain unchanged.

Turn acceptance freezes `memoryEnabled`, `memoryPromptMode`, and a bounded
projection of legacy workspace instructions in one immutable turn-context
snapshot. The first exact attempt creates a content-free selection receipt that
binds that snapshot to the accepted logical turn. Its default `retrieval_only`
(migration 0271; absent settings resolve to it) removes
the broad Memory V1 working-set block. Every existing Memory kind remains
available through explicit agent search; legacy preference and procedure rows
are historical context rather than behavioral authority. The former
`legacy_standing` opt-out is retired. A root still receives the bounded company profile, while a child
omits it and retains mandatory instruction policy plus the always-visible
structured preference and configured Skill descriptors. At the ordinary model
request boundary, metadata-only telemetry records the exact attempt, existing
governance snapshot ids, inclusion reason, authority class, root/child role,
UTF-8 size, and estimated tokens without recording content. Replacement
attempts reuse the receipt, its bounded legacy Memory candidate identities, and
the exact whole-entry subset that fit the original prompt budget. Current
authorization, lifecycle, version, and content-hash revalidation may remove a
rendered candidate but never add a newer or originally budget-omitted one.

Approval, capacity wait, worker recovery, and Pause/Resume create newer
attempts for the **same logical turn**, so they must replay the original policy
rather than resolve or overwrite it; they also reuse the accepted governance
snapshots. A new user/API turn or a newly materialized goal, system,
child-result, scheduled, or compaction turn is a new logical turn and resolves
fresh execution and governance policy. Thus a per-turn model/provider switch
persists through recovery without accidentally becoming a permanent session
default, while later policy or preference changes affect only later accepted
turns.

**Runs have no default length limits, by design.** What the SDK calls "turns" are model
calls; `OPENGENI_AGENT_MAX_MODEL_CALLS_PER_TURN` exists but defaults to
effectively unbounded. There is no continuation cap and the agent activity's
Temporal timeout is measured in days, not hours. OpenGeni is built for agents
that legitimately run for a very long time. Budget/admission policy and
explicit goal completion or pause bound execution; OpenGeni does not infer
"no progress" from tool/event shape. Do not reintroduce default count- or
duration-based caps on legitimate run length; fix the pathology instead.

Recoverable conditions preserve context instead of failing the session, so a
long run survives them. Retryable provider connectivity, 5xx failures, and typed
required-MCP connectivity failures resume the same accepted turn after a pacing
delay. The exact Modal `TaskExecStart` `ClientError` for DNS resolution of a
`task-*.w.modal.host:443` command router is also recovery-safe after Modal's own
ten `UNAVAILABLE` retries: DNS failed before the command transport connected, so
OpenGeni resumes the same accepted turn through the connectivity backoff.
Generic `TaskExecStart` `UNAVAILABLE`, mixed failure batches, message-only
lookalikes, any attached HTTP status metadata, and the exact
`FAILED_PRECONDITION: Modal Sandbox is shutting down` condition remain
non-retryable because pre-command safety is not proven. Required first-party
connect/tools-list also treats a rolling API
replacement's temporary `404` or statusless plain transport `Error` as
recovery-safe. That narrow exception does not apply to external MCP servers,
tool invocation, explicit non-404 client responses, or typed
protocol/programming failures. The retry classifier records typed out-of-band
category metadata without rewriting the exact source diagnostic retained by
OpenGeni. A failed MCP request records its HTTP method, parsed JSON-RPC method
when available, and a bounded exact source/cause chain in the durable recovery
detail before SDK layers can flatten the transport error. Only genuinely public
SDK/console diagnostics receive a fixed structural projection; raw transport
messages, URLs, and response bodies remain exact on internal data paths. Other
HTTP client failures and unknown provider codes remain authoritative and
terminal. Hitting an explicitly configured
model-call cap and budget/credit exhaustion ends the current turn gracefully;
an active goal may create a later continuation, while an otherwise idle session
waits for the next user message. For an MCP timeout that escapes after a
successful tool output, conversation truth is checkpointed before the turn
settles and the continuation is a new follow-up — the completed tool call/full
turn is never blindly replayed. Budget/credit exhaustion likewise idles the turn
rather than failing the session, so a top-up lets the same session continue.

Fresh progressive-disclosure attempts complete only session-marked eager MCP
connection and schema admission before inference. All non-eager MCPs—strict or
optional—connect/list concurrently with the first provider request. A plain
terminal model response does not join that background work. Every actual local
function call does join the one exact preparation promise before Runner can
dispatch it, including always-visible base tools such as `exec_command` and
`load_skill`; their stable first-request schemas remain eager, but their
execution does not bypass catalog persistence. Search disclosure, deferred
invocation, Codemode activation, catalog persistence, and cleanup join that same
promise, so no partial catalog grants authority. An exact preparation failure is
therefore observed at the first tool-call boundary and the tool body never runs.
Approval/human-interaction resumes and editable-artifact turns retain the fully
prepared catalog path because their continuation depends on exact prior tool or
catalog identity.

Retryable provider connectivity and 5xx failures recover the same accepted turn
after a durable 2 s, 5 s, 15 s, 30 s, then 60 s capped delay, indexed by that
turn's durable consecutive provider-recovery count rather than unrelated
execution attempts. A fenced current-attempt `agent.model.request` completion
atomically clears that durable count with its event; only after the commit does
the worker clear its in-memory copy. Failed requests and late/zombie completion
events cannot reset the streak. Successful inference between transient outages
therefore starts the next outage at the first backoff step instead of consuming
a lifetime budget for a long-running turn.
An explicit provider retry hint is a lower bound. Rate limits use the provider's
`Retry-After` when present and otherwise wait 60 s; other retryable classes keep
their existing pacing. Automatic same-turn provider/MCP recovery is finite: five
consecutive replacement attempts may be scheduled, and a sixth retryable failure settles the
same logical turn as failed with the original typed cause plus explicit recovery-
exhaustion evidence. This is an infrastructure retry budget, not a goal,
continuation, model-call, or run-length cap; a later human/API prompt may retry as
new accepted work. If an operational database outage interrupts the recovery
checkpoint itself, the existing post-claim failure wire carries the immutable
turn identity, classified provider cause, and exact next recovery count into the
DB-only control lane. That lane accepts the checkpoint only when the identity
still owns the attempt and the count is exactly one beyond durable turn metadata;
ambiguous commits and stale replays therefore cannot reset the retry budget.
Every Steer commits a control wake revision, including when
the recovering turn has no live attempt. A later coalesced Send cannot downgrade
it to an ordinary queue signal, so the workflow interrupts the hold and processes
the new direction immediately.

Codex-subscription turns add one explicit recovery boundary before the model
run. The worker always selects and leases a credential atomically under the
workspace rotation-row lock; concurrent replicas
therefore observe earlier reservations. A second 401, 403, explicit quota, or
429 can quarantine that credential and requeue the same durable turn after a
conversation-truth checkpoint. Network/5xx/invalid-content/partial-stream
failures never rotate or blindly replay. The first accepted failover freezes its
enabled-alternate ceiling in turn metadata, so later pool changes neither strand
an originally permitted account nor extend the same-turn retry budget. The allocator, strict workspace scope,
five-hour reset semantics, and rollout fence are canonical in
[`codex-subscription-rotation.md`](codex-subscription-rotation.md).

SuperGrok/xAI uses the same provider-tagged durable same-turn wait protocol but
with its explicit workspace-or-user authority pool. A definitive typed or
marked 401, 403, or 429 may quarantine only the exact leased credential while
the attempt is atomically closed and preserved. HTTP 200 SSE terminals match
that 429 path only for known overload/rate-limit codes or the observed Grok
sentence "The model is currently at capacity due to high demand..."; isolated
"high demand"/"overloaded" wording is not enough. Ambiguous 5xx, partial
streams, and unrelated errors never walk the pool. See
[`supergrok-subscription.md`](supergrok-subscription.md).

When the policy-selected credential is allocator-disabled, or every
allocator-enabled Codex credential is unavailable, this recovery boundary
becomes a durable capacity wait for the current logical turn, whether or not the
session has an active goal. The worker atomically closes the exact
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
inference, redeem a reset/boost entitlement, create a consent prompt, or borrow
another user's account. For SuperGrok, account reconnect,
allocator/rotation changes, and exact lease release durably advance the same
waiter plus workflow-wake outbox.

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
propagate without changing active history. Remote v2 likewise keeps its first
request unchanged and, only for the exact `context_length_exceeded` code, makes
one same-endpoint retry with tool-result bodies temporarily reduced while every
message, reasoning item, call/result identity, checkpoint, and item position is
preserved. It never drops history units, folds chunks, or falls back to portable.
A Codex terminal SSE failure carried
on HTTP 200 is converted to one bounded, marked, non-retried provider error; it
cannot masquerade as an empty successful summary. After a fenced durable
replacement, the same activity, turn, attempt, and sandbox rebuild model input
and continue; compaction itself never creates queue or recovery work. If that
fresh continuation ends without any terminal model response, it is not accepted
as an empty completion: cancellation still wins, otherwise the compacted
checkpoint enters the ordinary bounded same-turn recovery path while newer
queued prompts remain behind it. Steer admission is immediate but deliberately
does not interrupt while the latest exact-attempt compaction landmark is
`started`, because an interruption row would also fence the terminal checkpoint
write. Once `session.context.compacted` or
`session.context.compaction.skipped` is durable, a waiting human/API or Agent
Steer cooperatively settles the ordinary turn as `superseded` before another
model request. A claimed standalone compaction instead completes its maintenance
turn, then the waiting Steer is first to claim. Pause and Cancel remain immediate
interruption fences.
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
only when the caller supplies a proven visual transport: Responses wires
(including Gateway Kimi and SuperGrok) and Codex use `computer_*` function
tools with structured image results when the model catalog lists image input.
Gateway DeepSeek stays text-only and therefore receives neither image input nor
computer tools. Chat Completions receives no computer tools: tool results on
that wire are text, so a screenshot would become a base64 string rather than an
image the model sees.

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

A completed pending tool receipt retains two deliberately separate lossless
projections: the bounded SDK result item that may become model-visible history,
and the exact `agent.toolCall.output` value used by the durable audit event.
Normal publication and crash recovery consume the same retained event value, so
recovery cannot reconstruct a poorer MCP result from model-facing content or
drop open protocol extension fields.

Recoverable attempt transitions close ordinary in-flight receipts with an
explicit outcome-unknown result but preserve every receipt carrying an
`interruption_kind`. Those rows are the exact open-suffix authority a
replacement attempt needs to replay the original approval or human-input
trigger, including a result already consumed before worker loss. Capacity waits,
recoverable pause/maintenance, provider failover, graceful shutdown, and worker
death all follow that rule. Terminal failure/cancellation and superseding Steer
close the entire turn ledger. Recovery never reconstructs this authority from
history or `agent_run_states`.

For MCP, the runtime reads the complete provider `CallToolResult` through the
SDK's `callToolResult` seam and carries a private duplicate only until the exact
audit projection is durable. An HTTP-successful result with `isError: true`
therefore remains a failed tool outcome in live SDK state, model-facing history,
the pending receipt, the durable event, recovery, and the timeline. The physical
invocation boundary also records
`opengeni_mcp_tool_calls_total{outcome}` and
`opengeni_mcp_tool_call_duration_seconds{outcome}` with one closed structural
outcome: `success`, `provider_declared_error`, `auth_needed`,
`outcome_uncertain`, `timeout`, `cancelled`, `thrown_transport_error`, or
`thrown_protocol_error`. Server, tool, tenant, request, error, and content values
are deliberately absent from labels.

First-party `session_create` and `session_send_message` failures return an MCP
`isError` result with a bounded structured `{ error: { code, message } }`
projection. The durable tool-output event retains that raw MCP result, and the
React timeline promotes the two calls to worker rows that display the safe code
and message. Known authorization/control failures use fixed public wording;
unknown internal exceptions remain generic. This diagnostic projection does
not alter transaction admission, retry, or idempotency semantics.

Before a personal MCP is attached, the worker/Codemode boundary revalidates the
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

Host-owned rotating sandbox run credentials split resolution from sandbox
materialization when lazy provisioning is enabled. The worker binds and resolves
the exact accepted turn, attempt, shared sandbox group, initiator, and effective
backend once before model preparation so partial `auth_needed` state is available
as bounded model context and reconnect UI. Only the first actual sandbox
operation enters the existing single-flight provisioner, writes that exact
resolved material to the lease before the waiting operation, and starts renewal.
A model-only turn therefore owns no credential write, renewal, lease, box, or
exact-generation cleanup work. Signed file resources are eager only on the exact
turn that attached them; historical attachment ids do not cause sandbox or
object-storage work. This-turn generated-video files may still copy onto the
box before dispatch; a copy miss is deferred like generated images (the
durable File remains) and does not fail the turn.
Source-bearing `generate_video` calls join that same single-flight provisioner
immediately before inspecting their `/workspace` references and use the active
routed session. Text-to-video requests do not acquire a sandbox.

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

Claim, interruption, and event-writing settlement share one lock order: the
workspace-control advisory lock plus `workspace_inference_controls FOR SHARE`
when the write is control-aware, then the actual `workspaces` row
`FOR KEY SHARE`, UUID-ordered sessions `FOR NO KEY UPDATE`, UUID-ordered exact
turns `FOR UPDATE`, and UUID-ordered exact attempts `FOR UPDATE`.
`lockWorkspaceInferenceControl` takes
`pg_advisory_xact_lock[_shared](hashtextextended('workspace-control:<id>', 0))`
in the same mode before the row lock. The row lock alone is unfair: PostgreSQL
lets a new `FOR SHARE` join a share-locked tuple without queueing behind an
already waiting `FOR UPDATE`, so with many sessions continuously claiming,
settling, and appending, a Pause/Resume could wait for hours while every
HTTP caller gave up and left its backend parked with a pinned snapshot. The
heavyweight advisory queue is FIFO, so a mutator waits only for the holders that
preceded it and sharers resume right after it commits. Only genuine control
mutations (Pause/Resume/Cancel, workspace Pause/Resume, auto-resume, settings
narrowing, quiescent tree deletion) take the exclusive prefix. Read projections
(`getSession`, session lists, discovery) read the control row with lock `none`
and never join the prefix queue. Send, Steer,
queued Steer, and realtime ledger sync use
`lockWorkspaceInferenceControlForAdmission`: the shared prefix while the target
branch is active (it still excludes every control mutation, so the observed
state cannot change inside the transaction), escalating to the exclusive prefix
for a paused branch only after rolling back a savepoint, because an in-place
upgrade deadlocks as soon as two sharers escalate together. Request-scoped API
mutations pass `workspaceControlRequestLockTimeoutMs()`: one wall-clock budget
shared by every lock step of the admission (advisory lock, row lock, and a
savepoint escalation), so the total wait never exceeds the bound. The budget is
the `@opengeni/config` setting `workspaceControlLockTimeoutMs`
(`OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS`, positive integer milliseconds,
default 20000, validated at boot); the API installs it into `@opengeni/db` once
at app construction through `configureWorkspaceControlRequestLockTimeoutMs`,
and nothing parses the env per request. Exceeding it fails with
the typed retryable `WorkspaceControlBusyError` before any write; `app.onError`
renders it for every route as HTTP 503 with `retryable: true`,
`outcomeUnknown: false`, and `details.code: WORKSPACE_CONTROL_BUSY`, the MCP
orchestration envelope reports `<tool>_workspace_busy` with a retry hint, and
Slack interactions keep the raw error so their classifier retries it. Worker
settlement and claims never pass a bound. The bounded request-scoped takers are
exactly: Send, Steer, queued Steer, Pause/Resume/Cancel, workspace
Pause/Resume, realtime ledger sync, queue move/edit/delete, composer draft save,
the MCP agent message and agent Steer, `updateWorkspaceSettings` (settings
narrowing, exclusive prefix), and `deleteSessionTreeIfQuiescent` (exclusive
prefix); each accepts an optional `controlLockTimeoutMs`, the API routes and
`@opengeni/core` commands pass the request budget, and a lifecycle caller that
omits it keeps the unbounded wait. The remaining HTTP-originated shared takers
stay unbounded by design: session create (`lockWorkspaceForSessionCreate`),
goal clear/update (`clearSessionGoal`, `updateSessionGoalWithEvent`), the
session MCP approval-policy and tool-policy writers
(`appendSessionEventsWithLockedSessionUpdate`, shared with worker writers), and
realtime session begin/end. They only hold `FOR SHARE`, so they wait solely
behind an exclusive holder or a queued mutator and never behind each other; a
bound there would trade a brief wait for a failed request. Generic
audit/title appends skip the control row but use the same
workspace-key-share prefix. Retained-screenshot prepare takes that same prefix
before insert so its turn/attempt FK checks cannot invert against event writers;
retry only that idempotent prepare transaction on `40P01`/`40001`. Event inserts also touch the workspace through their
foreign keys, so acquiring it later would reintroduce a claim/preemption
deadlock; the session lock excludes competing mutation while remaining compatible
with FK key-share checks. Start, requires-action, ordinary terminal, recoverable interruption,
supersession, and worker-death events commit
with turn status, session status/pointer, and `lastSequence` in one transaction.
Migration 0374 also advances `session_event_cursors` from an AFTER INSERT
statement trigger and rejects any non-contiguous batch. This is a rolling
dual-write/parity phase, not the allocator cutover: writers must keep locking
and updating `sessions.lastSequence` until Pause/Steer admission and every event
writer share the narrow cursor lock.
Generic appends and operation-keyed Agent Message/Steer commands retry PostgreSQL
`40P01`/`40001` only around their bounded, idempotent persistence transaction.
The pre-inference turn claim follows the same rule around its complete
transaction, reusing the exact workflow, run, attempt, and dispatch identities.
Provider inference, tools, live event publication, and workflow wakes remain after
that boundary and are never replayed. An exhausted or non-retryable database
failure surfaces as sanitized typed truth with SQLSTATE, stage, one correlation
ID, an equally sanitized typed cause, and allowlisted catalog identifiers—never
raw SQL text, a raw driver cause, or bound parameters.

An activity failure can occur before that transaction creates its attempt row.
The turn worker exports a stable typed Temporal disposition: exhausted
contention and operational database unavailability are retryable, while
constraints, permissions, malformed state, and claim invariants are permanent.
The failure activity distinguishes this from a
stale or settled attempt. Retryable and rolling-legacy unknown failures record a
delayed `session_workflow_wake_outbox` revision and return an explicit
`unclaimed` result; new workflow histories retain the logical turn, back off
exponentially to a one-minute ceiling, and re-peek durable work. User/queue,
control, accepted approval, and capacity signals all interrupt that timer,
including signals received while activity execution or failure settlement is
in flight. A permanent failure atomically fails the exact still-runnable turn
(or the session-level
compaction/internal-update obligation), session, events, maintenance, and child
terminal outbox without fabricating an attempt row or looping. Raw SQL and
invariant messages never enter workflow history.
Older histories retain their recorded activity arguments for deterministic
replay. A still-open legacy history records a tail patch after its historical
failure activity and follows the bounded re-peek path even when a rolling legacy
activity worker returned void; an already-completed history replays its original
close. A separate pre-claim-classification marker preserves the exact v2
failure-activity arguments for histories that already recorded that command;
new histories and open histories that have not reached it can send the trigger
and typed disposition fields. The upgraded
activity derives the stable workflow id and leaves the same
durable restart obligation. Migration 0238 seeds that obligation for
already-recovering active turns whose `active_attempt_id` is null and for every
effectively active pre-attempt claim shape whose existing wake revision was
fully delivered: queued turns, accepted approval responses, released capacity
waits, manual compaction, and pending internal updates. The cutover mirrors
runtime's recursive session/workspace control algebra and excludes live
attempts, unanswered approvals, real capacity waiters, compaction-failure holds,
paused work, and healthy undelivered wakes.

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
logical turn `recovering`; Steer normally closes it as `superseded`, makes the
steered human prompt first, and does not revive the old turn. The exact exception
is active compaction: while the latest exact-attempt landmark is
`session.context.compaction.started`, and for the whole lifetime of a claimed
standalone compaction turn, Steer records durable waiting work but inserts no
interruption. The terminal checkpoint write therefore remains authorized; its
first safe boundary supersedes the ordinary turn before another model request,
or completes standalone maintenance before the Steer claim. A missing or
already closed owner is an event-free stale no-op. This prevents a superseded
activity that keeps running from publishing contradictory history or terminal
truth without creating a compaction/Steer retry loop.

Pause/Resume command persistence distinguishes `changed`, `unchanged`, and
`replayed` before allocating a control revision. A fresh Pause is unchanged
only when the selected direct recursive blocker is already represented, no
newer descendant run override must be invalidated, every live attempt is
already covered by an actionable Pause interruption, and no adopted command is
still running. A fresh Resume is unchanged only when the selected branch has no
undefeated blocker and every currently continuable descendant already has an
undelivered workflow wake; otherwise it advances the override and repairs wake
delivery. Workspace Pause/Resume applies the same rules across the workspace.
An unchanged result writes only its operation receipt: no control revision,
control/session event, audit event, child notice, interruption, command stop,
or workflow wake. Reusing that exact operation key remains `replayed`, not
`unchanged`.

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
Terminal results are not the only child lifecycle notice. Behind
`OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED`, the child's own lifecycle
transactions also enqueue one dedupe-keyed outbox row for the parent when the
child freezes in `requires_action` (`child_requires_action`, immediate wake
class, bounded question previews and approval ids), when such a request is
answered, skipped, expired, decided, or cancelled
(`child_requires_action_resolved`), when a human/API/agent pauses the child
directly (`child_paused`), when a capacity waiter is armed
(`child_waiting_capacity`), and when the child records goal progress
(`child_progress`); the latter four are `deferred` (pending row + event, no wake,
delivered with the next claim). Each producer takes the child-lifecycle lock
prefix (the parent session row is locked with the child) and the worker delivers
the row right after the producing commit; the reaper covers crashes. See
[`durable-agent-inputs.md`](durable-agent-inputs.md).

Every child terminal result remains a durable pending machine input even when it
arrives late. It may autonomously wake an idle parent only while the parent has
an active goal, which is the durable obligation to keep working. A goal paused
only by its continuation ceiling (`max_auto_continuations`) counts: that pause
is pacing, not intent, so the arriving result resumes the goal in the same
commit (`goal.resumed`, `reason: "external_input"`) and then wakes the parent. A
no-goal parent whose ordinary turn completed, a goal paused by the user, API,
agent, limits, or no-progress policy, a completed goal, and an already-failed
parent are settled authority: the result stays pending for a later human/new-goal
turn and cannot manufacture a new inference or rewrite the settled public status
by itself. A result arriving while the parent turn is live remains available to
that turn's ordinary loop.
The provider-neutral coordination contract creates a child only for concrete,
bounded, independently useful work with a defined integration point. Parent
work must stay disjoint from the delegated scope. A parent joining a child uses
`session_wait` with `waitFor: "completion"` before committing or publishing
dependent work. `goal.completed` is a durable goal fact, not proof that the
child has emitted its final result. Completed commentary messages, maintenance
turns, and continuation segment settlements are also ignored until an ordinary
result-bearing turn settles. The ordinary `waitFor: "change"` mode remains
available for progress monitoring.
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
For every accepted human/API prompt and Agent Steer, accepting a Temporal signal
is not an admission acknowledgement. While effective control is active, the
delivery path leaves the current coalesced workflow-wake revision
unacknowledged if any human/API turn remains physically queued, and leaves the
wake unacknowledged while the newest `agent_steer_instruction` remains pending.
An older prompt sender may still advance only its own stale revision because the
newer coalesced revision remains outstanding. The bounded outbox dispatcher can
therefore redeliver across a workflow close or `continueAsNew`; the
attempt-fenced Postgres claim consumes each prompt turn or newest instruction
once, so duplicate signals cannot duplicate inference. A real Pause is the
truthful blocker and may acknowledge the old revision; Resume commits a fresh
revision for preserved pending direction.

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
process or parallel tool operation stopped. The turn activity heartbeat timer
and worker SDK throttle share a 500 ms bound, leaving the unchanged four-second
live control budget for physical writer drain and receipt-gated replacement
admission independently of the two-minute heartbeat timeout.
Each streamed SDK event read uses Temporal's activity cancellation signal with
one listener that is removed when the iterator advances. Never race every event
against `Context.cancelled`: that promise intentionally never settles on normal
completion and would retain one losing promise reaction per token/event for the
activity lifetime.

The dying `runAgentTurn` activity owns physical proof. It cancels the exact
turn's tool/sandbox controller, waits for all controller-owned operations to
quiesce, stops and drains attempt-owned Git, Codemode, and generic
run-credential renewal/materialization writes, and immediately writes
`session_turn_attempts.quiesced_at` before
attempt-qualified credential deletion, cache, recording, provider, lease, or
workspace housekeeping. The
receipt, its `session.queue.changed` event, the session queue/sequence update,
and the exact `session_workflow_wake_outbox` revision commit in one retryable,
idempotent transaction. The commit returns that exact still-undelivered wake;
the activity immediately attempts its `signalWithStart` before NATS fanout, and
the durable outbox retains the same revision for bounded repair if transport
fails or the worker dies after commit. Provider completion and batch flushes
that ignore
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
authoritative. Omitting `tty` preserves the existing interactive default. A
durably retained command performs marker read, token/PGID validation, TERM/KILL,
and group-absence proof in one bounded in-box helper on its exact pinned backend,
then enters one exact provider-session settlement phase. Inconclusive identity,
transport failure, or a still-live group retries that same idempotent proof and
keeps admission closed; the ordinary path does not serialize one provider round
trip per signal and poll.
Modal turn-owned exec starts use isolated command-router handles. If cancellation
arrives before `TaskExecStart` returns a provider session id, the controller
closes only that pending handle, reattaches the same sandbox for control, writes
the invocation's randomized in-box tombstone, and terminates only a marker whose
PID/PGID command line contains the same token. The wrapper publishes its marker
before checking the tombstone, so a late accepted start cannot execute user code;
the fence still waits for both exact process-group absence and the original
provider promise to settle. Timeout, missing marker, and transport failure remain
non-proof. The queue/chrome projection renders this period as stopping previous
work (or current work under Pause), never as a first-step wait or a completed
direction change.

Model-facing shell waits preserve that same cancellation boundary without
making the model poll it. `exec_command` and `write_stdin` divide the requested
wait window into provider calls of at most 250 ms, checking the turn fence
between slices. A short command therefore returns its terminal result from the
original tool call, while an explicitly short yield or a command still running
after the requested window returns the retained session id. Empty internal
polls use the exact process-control route and never create another model turn or
workspace mutation admission.
If that process's durable row already records exit or loss, a later model-visible
`write_stdin` remains fenced before provider dispatch but returns the stored
terminal exit/loss banner. It never labels a permanently dead handle as a
retryable platform fault or calls the provider again. If provider polling and a
lease-loss reconciler race to settle the same terminal state, the first durable
state and evidence reason win; a later matching state/exit proof is idempotent
and unpins the local route even when its bounded evidence reason differs, while
a contradictory state or exit code remains outcome-unknown and pinned.

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
control wake. Activity-owned recoverable shutdown commits an ordinary durable
wake in the same transaction as `turn.recovery.requested`. While the receipt is
absent, wake acknowledgement remains pending for either recovery form,
`peekSessionWork` returns `cancellation-wait`, and every claim path remains
`control-pending` from the interruption ledger alone—queue presentation metadata
is never admission authority. The workflow waits up to five seconds for a wake
and may then close without running another turn activity; the outbox continues
bounded redelivery until the exact activity disappears or supplies its proof.
When an attempt-owned retained process was the final writer, its terminal
settlement advances that outbox revision atomically, so settlement racing the
workflow's last reconciliation check cannot be lost. A proof accepted at that
timeout boundary is persisted before close. Once the
receipt commits, its coalescing outbox wake uses immediate `signalWithStart` on
the same stable workflow id, which restarts the exact
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

Sandbox lease warming has two distinct bounded waits. A turn attached to a
sibling creator waits at most `OPENGENI_SANDBOX_WARMING_TIMEOUT_MS` (default
600000) for that durable warming lease to settle. The creator records the exact
provider instance as soon as create/restore returns, then gives Modal's command
router a separate 60-second readiness budget before publishing the lease warm.
The two failures retain different typed stages, group and instance identities,
and truthful durations; a command-readiness failure is never rewritten as a
600-second provider-capacity failure. It terminates the unpublished instance,
rolls only the exact warming epoch back to cold, and fails the turn rather than
rapidly creating sibling boxes. Any later display/setup failure follows the same
owned cleanup path.

After a managed lease is warm, immutable Rig setup has a second, setup-specific
single-flight boundary. One worker claims the exact `(lease epoch, provider
instance, setup spec hash)` receipt and runs the existing marker-guarded script;
sibling turns join or reuse its durable completion instead of entering the
sandbox concurrently. Join reads back off from 100 ms to a two-second ceiling
and reset when the durable revision advances. If provider execution succeeds
but database settlement is unavailable, the current turn does not replay the
script; after the bounded claim deadline, a successor re-enters the same
box-local marker and records completion. Failed setup remains fail-closed and
retryable. Per-turn Git/run credentials, Codemode tokens, Azure login,
repository clone authority, file resources, and generated media are always
prepared privately after the shared Rig boundary.

Lazy establishment observes one correlation-qualified logical provision at a
time. Its terminal durable `sandbox.provision` event records a closed structural
stage/category/code plus internal-attempt count; expected lease supersession or
capture/rotation wait is explicitly distinct from an actual logical failure.
Provider create/resume ownership annotates the unchanged source diagnostic with
its typed boundary stage, and classification otherwise uses typed error properties
and provider status/code evidence—never arbitrary message matching. Metrics keep
logical terminal outcomes separate from internal safe retries. A typed transport
category is diagnostic only and never licenses replay of an outcome-unknown
provider create or operation.

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
in the created session must match that binding before hydration. The verified
native artifact also pins the restore client's workspace-persistence mode; the
process default governs only archive-free creations and cannot invalidate an
older selected revision. A real tar
revision instead carries byte/hash plus deterministic content-tree metadata.
Repeated starts with the same rematerialization id are idempotent; rivals and
stale progress/commit writes are fenced. Native restore trusts Modal's snapshot
semantics and verifies receipt/readiness; only tar restore verifies the restored
tree. A partial hydrate or failed verification terminates the unpublished box
and leaves typed degraded/unrecoverable state; it never publishes a clean
replacement, a previous revision, or a mixed snapshot. A legacy per-session
archive can participate only after its archive fields—never provider identity—
are imported and selected under that same lock.

New Modal sessions persist `/workspace` with `snapshot_directory`: the restored
directory Image layers user files onto the currently selected rig/pack/base
image instead of replacing the whole machine. Existing serialized sessions keep
their recorded `snapshot_filesystem` or tar mode and remain recoverable. Warm
checkpoint attempts use the configured interval as a hard minimum even after a
new mutation generation; an already-complete generation never calls the
provider again. The zero-holder drain/rotation capture bypasses that interval so
the exact latest generation is durable before teardown. It may also use the
separate `OPENGENI_SANDBOX_DRAIN_SNAPSHOT_TIMEOUT_MS` provider budget so a large
workspace can receive extended recovery headroom without lengthening ordinary
periodic or turn-end finalization. Unset preserves the shared snapshot timeout;
Boot validation requires the larger configured capture budget and one reaper
period to fit strictly inside provider-deadline rotation headroom even when the
default backend is no longer Modal, because historical Modal leases remain
durable across that rollout. The explicit drain budget is independently
rejected unless reaper dispatch, the full durable capture, and retry handoff fit
inside the caller/DB transition wait ceiling. Process-local configuration is
only the initial observational budget. Once an opted-in acquisition or mutation
waiter sees the durable capture claim, it follows PostgreSQL's authoritative
remaining `archive_capture_deadline_at` plus retry-handoff grace, still capped by
the one-hour lifecycle ceiling. This keeps a timeout reduction and mixed-config
rolling activation aligned with the older child's frozen input without turning
the wait into capture-takeover authority or an unbounded request. Explicit
zero-wait probes preserve their immediate fenced result.

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

A yielded managed process promotes its parent admission to retained state and
creates the non-TTL process holder in the same transaction before any caller
receives a live locator. The holder keeps the exact temporary sandbox alive after
the turn ends. A yielded Connected Machine exec instead creates a session-owned
background-command row before returning; that row freezes the physical control
workspace, enrollment, connection instance, and op ID. The exact parent
admission/process UUID/provider locator or Connected Machine locator remains
pinned across active-pointer movement.
Both provider paths serialize adoption with Steer, Pause, terminal Cancel, and
session-tree deletion through the canonical workspace-control, workspace,
session, turn, and exact-attempt fence. Managed promotion and command insertion
are one transaction. For Connected Machines, the op-stream yield path takes
exact failure-cancellation authority before the adoption transaction begins;
if the fence rejects, that path exact-cancels the frozen op, while a committed
row transfers cancellation to session control and reconciliation. This closes
the post-commit/pre-unwind window in which attempt cancellation could otherwise
send `OpCancel` after durable adoption.
Model/user stdin is a separate process-owned mutation admission. Resize, EOF,
cancellation, helper exec, and drain polling are process control: they may prove
exit/loss but do not advance `workspace_generation`. Exact exit/loss atomically
settles the parent and process holder and closes any matching PTY; duplicate
identical proof is idempotent, while missing/conflicting proof keeps the fence
closed. Normal turn finalization drains only attempt-owned yielded shells before
workspace capture. Once a command's durable session adoption commits, normal
completion and Steer detach from it instead of cancelling it. Session/workspace
Pause and terminal Cancel atomically transition adopted commands to `stopping`;
provider-specific reconciliation then proves exact exit/loss before settlement.
Resume never revives a stopping command. Connected Machines and other
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
Repeated Modal binding-missing or binding-mismatch observations enter a durable
24-hour reconciliation quarantine after five claimed probes. Quarantine is
only backoff: the process remains active, retains every blocker, carries no
exit/loss proof, and is periodically eligible for a later positive binding
lookup and ordinary reconciliation.
The app exports bounded owner-state/backlog, reconciliation, and expired-drain
metrics; dashboard/PromQL integration is coordinated separately.

Connected Machine background commands use the same proof-before-settlement
discipline without borrowing managed lease identity. The global maintenance pass
claims oldest-due rows with `SKIP LOCKED`, sends `OpQuery` for `running` or
idempotent `OpCancel` for `stopping` to the immutable launch subject with epoch
zero, and checkpoints the typed terminal provider observation before changing
the lifecycle row. Running, offline, timed-out, malformed, and successor-only
states remain active/deferred; connection retirement or elapsed time is not
physical proof and cannot license replay or rebinding.
The exact terminal transition is also the agent-input boundary: changing the
command to `exited|lost` and appending `session.command.finished` commit
together. For a nonterminal session, one dedupe-keyed
`background_command_result`, `system.update.pending`, and any idle workflow
wake join that transaction. A failed or cancelled session remains terminal and
keeps event-only command audit rather than reopening pending model input. A
failed transaction leaves the command unsettled so the same already-checkpointed
proof can retry; a duplicate proof cannot create a second result.
For a managed retained process, its process row, parent admission, process
holder, lease counts, linked command transition, event, model input, and wake
are one transaction. A notification failure therefore rolls the process back
to active with its provider proof intact; the reaper defers that exact proof and
never repeats provider execution.
`command_wait` uses the terminal event only as a short live hint and re-reads
the durable command row. A longer wait uses session-level `wait_for_input`,
whose timeout never cancels the command.

Teardown preserves that authority. Session-tree deletion locks and refuses any
`running` or `stopping` command before cascading session-owned rows. Workspace
deletion takes a separate transaction-scoped background-command advisory prefix
before parent rows; adoption takes the matching shared prefix for both the
owning workspace and a distinct physical control workspace. Active target or
origin references return a typed blocker. Settled cross-workspace origin history
is pruned only at the final successful source-workspace deletion boundary, in
the same transaction as the cascade; a deletion attempt blocked later by leases
or other durable owners leaves that history intact.

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
run; this includes Codemode calls, whose operation is journaled before dispatch
and whose execution-start marker prevents replay after the side-effect boundary.
A late result is retained only as rejected evidence. The workflow then
creates a fresh attempt for that same turn on a healthy worker and reconstructs
model input from durable model history and tool-call lineage. At most the
single in-flight model step is lost, the same bound as a crash. This is an
explicit checkpoint/resume, not an automatic Temporal retry. A newer control
revision, terminal state, or successor attempt wins instead of being
overwritten.

The shared worker process owns its own fatality policy. The pinned Agents SDK
is patched so its MCP lifecycle queue settles every submitted command even when
an internal error value is hostile, and its tracing provider does not register
process-global `unhandledRejection` termination behavior. No SDK background
promise may escape into the process boundary. The worker listener remains an
observational last resort; a genuinely unhealthy worker stops polling and uses
the normal drain path rather than letting a dependency call `process.exit(1)`.

An active-route filesystem-root change uses the same durable same-logical-turn
boundary. A machine-primary attempt never pre-leases home. Clearing its pointer
to managed home emits `home_unavailable_this_turn`; swapping to a route whose
manifest root differs, or reconnecting the selected machine under a different
effective Hello root, emits `workspace_root_changed_this_turn` before another
provider operation is dispatched. Failure settlement durably reconciles
completed model/tool truth, closes only the unresolved tool suffix, records
`sandbox_route_transition`, and returns `recovering`. The next attempt starts
from the committed pointer and binds one exact root for its lifetime. There is
no new user message, per-turn machine cwd query, silent fallback, path
reinterpretation, or blind replay of an ambiguous operation.

Approval-gated MCP execution has an additional provider-side-effect fence.
Connection-backed actions and legacy per-session MCP servers configured with
`requireApproval` both create a durable action request keyed by the logical turn
and approval id before invocation. The approved transition admits the provider
once; a replay after execution started is recorded as outcome-unknown, and a
replay after completion is rejected as already executed. Recovery may therefore
re-enter the SDK approval step without issuing the MCP request again.

Root-task-tree note tools follow that same no-ambiguous-replay boundary. Their
operation receipts bind the exact accepted turn, attempt, execution generation,
root tree, and input. The same attempt/input may replay its durable receipt, but
a recovered successor attempt cannot claim or reissue the predecessor's
operation UUID. Notes remain an explicit retrieval surface and are never
composed into recovery history or ordinary prompts. See
[`company-brain-write-routing.md`](company-brain-write-routing.md).

Resource-based turn workers use that exact graceful path only as emergency
memory protection. Temporal's cgroup-aware slot tuner closes new admission at
`OPENGENI_TURN_WORKER_TARGET_MEMORY_USAGE`; reaching that target is ordinary
backpressure and does not restart a worker. An admitted long-running turn can
still retain native or external memory afterward. After each terminal model
response is durably reconciled into exact conversation truth, the worker
schedules one process-wide forced GC on a later task when JavaScript heap or
external memory has reached 512 MiB. Concurrent response checkpoints coalesce,
and collection runs at most once per 30 seconds. This does not trim history,
recycle the worker, or restart an activity: active turns and all exact context
they still own remain strongly reachable while completed request serialization
and stream buffers can be reclaimed. The worker also samples the
most pressured finite process cgroup or ancestor, falling back to whole-host
`MemAvailable` only without a finite cgroup. Process RSS pressure receives a
bounded asynchronous GC opportunity first. Only if the authoritative scope
stays at or above the separate
`OPENGENI_TURN_WORKER_EMERGENCY_MEMORY_USAGE`
for `OPENGENI_TURN_WORKER_MEMORY_GUARD_SUSTAIN_MS`, the worker stops polling via
its ordinary lifecycle drain; the sampling cadence is
`OPENGENI_TURN_WORKER_MEMORY_GUARD_INTERVAL_MS`. This is neither an activity
timeout nor a hard kill: conversation truth, pending side-effect receipts, and
outcome-unknown settlement retain the same authority described above, and a
replacement worker recovers the same logical turn without replaying an
ambiguous provider operation. The emergency threshold is constrained above the
maximum admission target. Fixed-concurrency and control workers do not run the
guard.

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
Consecutive continuations that consumed no external input are paced by a
delayed workflow-wake row (`goal_idle_backoff`), never by a Temporal timer or a
cap; any new input pulls that wake to now, and the claim that binds a goal turn
to a batch carrying other machine input restarts the no-input streak.
Full detail in `docs/goals.md`; goals are bounded by budget/admission policy and
explicit lifecycle control, not an inferred progress score.

## Memory — three stores, three jobs

A session's content lives in three places. Keep them straight; reaching for the
wrong one is the classic mistake.

Application-provided `modelContext` follows the same rule: it is ordinary
model-visible user-role content attached to one accepted message, not a system
or developer instruction. Initial, queued Send/Steer, realtime delegation, and
finalized transcript handoff all converge on the same canonical history shape.
Because the newest message carries the changing bytes, persistent
`Agent.instructions` and earlier history remain prompt-cache stable. Public
turn/queue projections and the standard timeline omit the field; full event and
audit reads may return it, so it is never a secret boundary.

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
   `computer_screenshot` and `view_image` typed PNG/JPEG/WebP bytes are validated
   and retained inside the tool invocation, before its result can enter live SDK
   history. The later SDK event only projects the established receipt, so
   event/state ordering cannot expose inline bytes to reconciliation. Every new
   history copy receives the deterministic bounded artifact receipt (or an
   explicit unavailable fact), never the provider object key or re-encoded
   base64 source.
   Function-transport `view_image` also validates the declared data-URL type
   against those supported magic bytes before constructing structured model
   image content. Unsupported or mismatched bytes return a concise conversion
   instruction as the tool result, so they cannot become a provider-level
   invalid-image request.
   New generated images follow the same no-inline-byte rule but are permanent
   workspace files: native hosted base64 is retained before serialization and
   adapter tools return the same compact `generated_image` receipt. A later
   model request projects that receipt to a deterministic artifact fact without
   provider identity, signed URLs, object keys, or base64. See
   [`image-generation.md`](image-generation.md).
   Model-visible tool results stay at or below 1 MiB. Overflow is a successful
   tool: exact serialized bytes become a workspace File, a current-turn copy
   lands at `tool-results/<operationId>.json` relative to the shell cwd (the
   durable rematerialization path remains the virtual
   `/workspace/tool-results/<operationId>.json`), and history/events keep the
   compact `{ sandboxPath, fileId, byteSize, mediaType }` receipt whose
   `sandboxPath` is that cwd-relative shell path. Later turns do not
   rematerialize; retrieve old bytes through Files MCP plus shell. Spill write
   failure is a bounded `result_too_large` error and never puts the huge payload
   in history.
   Codemode callers skip the 1 MiB cap; the existing 16 MiB journal cap on
   `session_attempt_codemode_calls` is unchanged. See
   `packages/runtime/src/tool-result-spill.ts` and
   `apps/worker/src/activities/agent-turn/tool-result-spill.ts`.
   User attachments use a separate one-turn delivery rule. The accepted user
   row stores private stable file references beside the message. Only that
   triggering turn resolves metadata, optionally inlines supported bytes, and
   materializes the files into active compute. Later model requests project the
   references as compact `fileId` receipts without file metadata reads,
   object-storage reads, filesystem checks, remounts, or downloads. Compaction
   preserves omitted references in one compact catalog. When old bytes are
   actually needed, the model uses the existing dedicated Files MCP download
   URL plus shell instead of startup rematerialization.
2. **`agent_run_states` — requires-action sentinel plus control snapshots.**
   Pauses flush completed-pair history, then persist the bounded open suffix
   on `session_pending_tool_calls` (the pending call item, tied reasoning the
   sanitizer would drop, and interruption kind). Unpaired calls never enter
   model-facing `session_history_items`. The same settlement writes the
   open-suffix sentinel into `agent_run_states` with pending-approval /
   human-input snapshots. Resume settles one suffix member
   (human-input response, approval invoke through the existing MCP execute-once
   fence, or rejection), promotes reasoning + call + bounded result as one pair,
   and either stays `requires_action` without a model call or continues from
   history. Before that continued model call, the exact resumed attempt
   idempotently attaches machine input inside its frozen pending-event sequence
   boundary, after the paired result in canonical history; input accepted later
   remains pending for the next turn. Missing suffix rows fail closed. It does
   not reconstruct SDK `RunState`.
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

Generated images have a separate permanent workspace-file lifecycle. Adapter
provider calls first cross a durable prepared/provider-started fence; after the
provider may have run, recovery may finish an existing deterministic upload but
must not repeat generation. Native hosted generation stays inside the ordinary
model-call crash boundary. Successful bytes are validated and retained once,
then materialized into the active sandbox for that turn. Historical receipts do
not trigger later eager copies; an agent retrieves the workspace file explicitly
when needed. A sandbox-copy failure never invalidates the permanent artifact or
replays paid work. Canonical:
[`image-generation.md`](image-generation.md).

Structured human input adds a durable control checkpoint, not a fourth memory
store. When the built-in `request_human_input` tool interrupts a run, the same
transaction stores its request rows, the open-suffix pending-tool receipts,
the `agent_run_states` sentinel, the `requires_action` projection, and
requested events. The request row is
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
workspace-prefixed indexes. The workspace activity counter is created with the
workspace, so an updated-order page reads its complete multi-query projection
through one short read-only repeatable-read MVCC snapshot and never takes a
counter or workspace-control lock. The page returns that decimal snapshot as
`updatedThrough`; the next incremental scan passes it as
`updatedAfter`, so application-clock timestamps, equal timestamps, inserts,
and repeated updates cannot create a handoff gap. Semantic writers acquire only
their domain locks while doing work. Their outermost database wrapper opens one
workspace-scoped activity gate, lets row triggers tag the changed session set
with the current full transaction id, settles every deferred constraint, and
then finalizes exactly once: one counter increment and one shared revision
stamped onto exactly that transaction's pending sessions. Low-level session
writers accept only the branded gate handle, while the SQL trigger catches raw
or stale callers at runtime. The finalizer clears the pending set in the same
transaction. A zero-change
transaction leaves the counter untouched; a semantic writer outside a matching
gate, a conflicting nested workspace, a manual revision write, or an open gate
without its finalizer fails closed and rolls back. A new gate must begin at the
outer transaction boundary; same-workspace nested scopes reuse that owner, while
an unrelated outer transaction is rejected. The counter therefore enters
the lock graph only after other transaction work is complete, while discovery
never enters that graph at all. Raw deltas do not mark a session pending. Known
targets should be read with exact-ID `session_get`, whose model-facing
projection independently bounds every aggregate and the complete pretty-printed
response to 64 KiB; the REST session detail contract remains unchanged.

`sessions.updated_at` records semantic monitoring activity time, while
`sessions.activity_revision` is its transactional monotonic ordering fact; raw
stream volume advances neither. A batch containing only raw message, reasoning,
sandbox-command-output, or PTY
deltas advances `last_sequence` but does not advance `updated_at` or
`activity_revision`. A semantic event or explicit session mutation advances
the timestamp, marks that session pending inside the activity gate, and shares
the transaction's single finalized workspace revision with every other changed
session. This keeps
updated-order discovery useful even while a productive session emits a large
raw token or terminal stream; `session_events` remains the exact sequenced
audit path for those retained previews.

Operation-keyed session commands retry only their rolled-back database
transaction on PostgreSQL deadlock or serialization SQLSTATEs, with a bounded
attempt count. Durable operation receipts make those retries idempotent;
publication and workflow wake delivery remain strictly after commit and are
never replayed by the database retry loop. Terminal persistence errors expose a
fixed safe message plus structured diagnostics while retaining the exact driver
failure only as the internal cause.

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
New history rows omit Responses output-only item `status` at persist
(`canonicalizePersistedHistoryItem`); pairing is `call_id`. The Codex
subscription fetch still strips leftover item `status` on the wire for
already-stored SuperGrok rows and mid-turn SDK items because the
ChatGPT/Codex input schema 400s `Unknown parameter: 'input[N].status'`. That
strip is request-local and does not rewrite stored history.
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

## Agent-loop request lifecycle observability

The user-visible startup critical path is also durable and phase-specific. The
existing `turn.queued`/`turn.started`, `sandbox.operation.*`, `rig.setup.*`, and
`agent.model.request` events reconstruct queueing, box establishment, rig,
repository/file work, and provider first byte. Compact
`turn.startup.phase.started|completed|failed` checkpoints fill the two gaps for
tool connection and model-request preparation; terminal payloads contain only a
closed phase name and non-negative `durationMs`. In particular, lazy
`sandbox.provision` completes as soon as the box is established, before owned
rig/repository/file setup, so “Starting sandbox” never absorbs unrelated work.
Model-request preparation is an enclosing span: it begins when control enters
the runtime and ends at the provider transport boundary, so it may include the
sandbox, rig, repository, and other setup rows whose starts appear below it.
The timeline labels that overlap explicitly instead of presenting the parent as
an additional sequential wait.

The periodic warm-workspace snapshot is mid-session durability. The lease
heartbeat must not start it until the first provider request has reached its
transport boundary: before then there is no agent-produced work to protect, and
the snapshot's workspace fence would make first-request sandbox preparation
wait behind maintenance. Turn-end capture and the existing single-flight gate
remain unchanged.

Fleet metrics keep this drill-down identity-free:
`opengeni_turn_worker_preparation_duration_seconds` measures the platform path,
`opengeni_turn_startup_phase_duration_seconds` attributes its bounded phases,
and `opengeni_turn_startup_milestone_duration_seconds` records real cumulative
queue, provider-dispatch, and first-byte SLO samples from the durable turn queue
timestamp. Their labels are limited to the closed provider/backend/outcome and,
where applicable, phase/count/cache vocabularies; session, turn, request,
credential, and content values remain only in authenticated durable events.
The database returns a milestone receipt only when the current transaction
inserted the first canonical current-association checkpoint, so ordinary
attempt recovery and callback replay cannot deterministically double-count it.
That decision is a per-turn ledger, `session_turn_startup_milestones` (one row
per turn, milestone, outcome; migration 0318): the event-append or settlement
transaction performs `insert ... on conflict do nothing returning` for each
checkpoint it inserted, and only a returned row is a receipt, measured from the
turn's durable `created_at` to the canonical event's own `occurred_at`. It
never re-reads the turn's `session_events` rows, so the cost is O(1) per model
request instead of O(events in the turn) inside the transaction that holds the
workspace inference-control row. The terminal failed first-byte outcome is
fenced on ledger state (a provider-dispatch row exists and no completed
first-byte row exists). A turn whose `turn.started` was already durable before
a ledger-aware writer touched it (in flight across the ledger rollout) is
sealed once with `pre_ledger_history` sentinel rows after one bounded probe for
an earlier current `turn.started`, and emits no further startup receipts rather
than re-observing a checkpoint with a duration equal to its age.
A terminal `turn.failed` after provider dispatch contributes one bounded failed
first-byte sample only when the logical turn produced no canonical byte in any
attempt. A recoverable pre-byte attempt and a later tool-loop failure after a
byte therefore cannot downgrade the logical startup outcome; successful
first-byte latency remains a separate completed series. Prometheus observation
is still an in-process, at-most-once side effect after the database commit: a
process crash in that COMMIT-to-observe window can lose a sample. It is not
transactionally exactly-once; a replica-safe Postgres-backed metrics projector
would be a separate observability architecture.

Provider request lifecycle diagnostics are synchronous, bounded, and best-effort. Codex reports `headers`, `first_byte`, and one semantic `terminal` phase; SuperGrok reports the equivalent `headers`, first valid SSE event, and terminal phases plus valid-event count/gap telemetry. Terminal outcomes are `completed`, `failed`, or `timed_out`. The worker maps these to `opengeni_model_request_phases_total{provider,phase,outcome}` and `opengeni_model_request_phase_duration_seconds{provider,phase}`. SuperGrok additionally exposes `opengeni_model_requests_inflight`, `opengeni_model_request_oldest_no_event_age_seconds`, `opengeni_model_request_stream_events_total`, and `opengeni_model_request_stream_event_gap_seconds`, all with provider-only labels. Provider ids come from the resolved provider registry; request ids, model bodies, credentials, session ids, and token content are not metric labels.

Native diagnostic observers run before the existing awaited
`agent.model.request` durable audit callback and cannot block or change it.
Durable append/publish fencing and ordering therefore remain the source of audit
truth. Every provider path first awaits a mandatory reconciliation of the SDK's
complete prior history at the follow-up request boundary. A provider can
therefore consume a completed tool batch only after its call/result pair is
replay-safe; the first request has no prior model/tool history to append.
When a Responses terminal omits its output array, completed stream items are
reassembled by numeric `output_index`; sparse provider positions are compacted
to the observed items rather than treated as missing output, while duplicate
indices still fail closed.
For generic providers, an attempt-local async context then awaits the durable
`started` checkpoint at the literal pre-fetch boundary; request bytes cannot
reach the wire first. Model-preparation `started` is durable before
`runStream` is invoked, including an immediately-calling native transport. A
semantic terminal is latched before downstream stream cleanup; if the consumer
cancels after parsing it, the audit remains `completed` rather than producing a
misleading trailing `failed`. Actual provider failure/incomplete/error,
transport failure, timeout, or caller abort remains failed/timed out. SuperGrok
persists only `started`, `headers`, `first_event`, and terminal checkpoints—not
every streamed event—and the terminal checkpoint carries bounded event-count,
last-event-type, last-progress-duration, and silence facts. An HTTP 200 SSE
error/failed/incomplete terminal is not forwarded into the Agents SDK; the
transport throws the bounded exact provider message. Rate-limit/capacity
refusals are marked 429 and enter the durable same-turn waiter; other
terminals persist that diagnostic on `turn.failed`. Lifecycle audit stays
metadata-only; worker stdout stays sanitized.
