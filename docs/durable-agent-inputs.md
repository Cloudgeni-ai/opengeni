# Durable agent inputs

Agent-to-agent messages, Agent Steer instructions, child results, scheduled
occurrences, goal continuations, session-wait timeouts, and terminal background
commands share one durable lifecycle. They are not human prompts, but they are
real model input and therefore cannot exist only in an activity-local system
message.

## Canonical lifecycle

1. A producer inserts one typed `session_system_updates` row with a stable
   dedupe identity. `pending` is the authoritative waiting state.
2. The queue endpoint reads those rows directly. Session events only tell a
   client to refresh; they never reconstruct the queue.
3. A turn claim locks and selects a bounded group, assigns the receiving turn,
   serializes one deterministic system message, and inserts that exact message
   into `session_history_items` in the same transaction that marks every member
   `delivered`. The message states the batch's `deliveredAt` and each member's
   `createdAt` as minute-precision UTC with the weekday (a scheduled occurrence
   promoted to a user-role task carries the same `Delivered:` and `Created:`
   lines), so a turn that no human message started still knows the current
   time. Both values are the durable row timestamps, never the rendering clock.
   A `requires_action` resume is the one two-phase form of that boundary: the
   resumed attempt first persists the interrupted call/result pair, then
   idempotently re-enters its exact claim to attach only machine inputs whose
   pending-event sequence was frozen when that resumed attempt started. This keeps provider
   call/result ordering valid, prevents a second inference for pre-resume
   input, and leaves later arrivals pending for the next turn.
4. The worker builds the first and every subsequent model request from active
   session history. It does not inject a second transient copy and does not
   remove system input during reconciliation.
5. Recovery reclaims the same logical turn and reads the same persisted batch.
   An interruption, failure, or Steer never returns model-visible input to
   `pending`. A later input is a new row and may cause a new inference.
6. Only explicit durable context compaction may replace active history. The
   prior rows remain inactive audit evidence.

The database links every delivered input to one
`delivered_history_item_id`. Every member of a coalesced batch shares that id.
Agent Steer is guaranteed admission to the bounded batch and is serialized last
so an older goal or lifecycle notice cannot override the replacement direction.

Pending machine input also wakes a session-level `wait_for_input` declaration.
The wait belongs to the session, not its goal: it persists the exact declaring
turn, reason, set time, and absolute PostgreSQL deadline. An `immediate` update
(a child terminal/action notice, Agent message or Steer, schedule, media result,
or background-command result) makes the session runnable. The next claim
delivers the batch, and that newer finished turn retires the wait with
`session.wait.finished{outcome:"input"}`. `deferred` child notices remain
pending without ending a current wait; they are delivered when the wait times
out, is superseded, or immediate input arrives. When the database deadline
passes unchanged, settlement clears the wait and atomically queues one typed
`session_wait_timeout` input plus its workflow wake.

The wait is retired only by a newer finished turn that a person did not start,
by a person's turn that consumed immediate machine input, or by its own timeout.
A person's turn (`source` `user` or `api`, or an operator's manual `/compact`)
still runs immediately, but unless that turn calls `wait_for_input` again, the
wait keeps its declaring turn, reason, and deadline. The exception is a queued
person's turn that claims pending `immediate` machine input as coalesced
context, for example a child result that arrived just before the question ran:
it consumed what the wait was for, so it retires the wait like the system turn
it replaced. The same holds when the person's turn read part of a child
result (its answer or a goal continuation it reports) that was superseded as
`consumed_by_parent_read`: the result never wakes the parent, so the read
retires the wait. Re-reading only parts that a completed attempt had already
read when the wait was declared leaves it held. Coalesced `deferred` notices
alone do not retire it.
This is what lets a status question asked while a child runs get its answer and
still leave the child's later result able to wake a goalless parent; without
it, the answer turn retired the wait and the result stayed pending with nothing
to wake it. Goal, system, scheduled, and other machine-input turns still
supersede the wait. If the person's message replaced the task and the agent
neither waits again nor stops the child, the child's result or the deadline
wakes the agent once more; the deadline bounds that cost.
`sessionInputWaitDecidingTurnSql` in `packages/db/src/index.ts` is the single
predicate for this rule. Worker peek and settlement, wake and claim admission,
public `inputWait`, and waiting-descendant counts all read it.
The operational instructions still tell the agent to answer and then call
`wait_for_input` again while the awaited work is still in flight, reusing the
earlier reason and only the time left before the earlier deadline, because
each turn's wait sets a fresh deadline from its timeout.

A successful Temporal signal is transport delivery, not input admission. The
current workflow-wake revision stays retryable while an eligible immediate input
remains pending, or an idle session still owns an expired input wait. Future holds acknowledge
the early signal so settlement can re-arm their deadline without retaining an
earlier retry time. A closing
workflow cannot acknowledge away that obligation.
An immediate update that reaches an idle session whose wake is still
undelivered joins that revision instead of opening another one. The row is
often future-dated (the `wait_for_input` deadline or goal idle backoff), so the
update pulls it to now and its producer still signals after commit; without
that signal the input would wait for the periodic dispatcher tick. The extra
signal is a hint only: one claim consumes the whole pending batch, and the
acknowledgement rules above keep the revision open until it does. Terminal
background-command settlement registers the same wake but does not signal from
its settlement callers, so the dispatcher delivers it. Claim, supersession, and
explicit control remain authoritative; deferred notices and late child results
without ongoing intent do not create new work.

Public session reads expose `inputWait` only for an idle, active-control session
whose newest finished turn that can decide the wait is the declaring turn.
Queued/running, paused, terminal, or superseded waits project as null. The
deadline stays visible after it passes until settlement: the web header and
rail say “recheck due”, not “running”. Waiting descendants contribute to
working aggregates independently of personal unread state. SSE wait, status, and pending-input events refresh the
detail projection; an older status event cannot override a newer detail read.

## Wake classes and child lifecycle notices

Every kind has one wake class in `SESSION_SYSTEM_UPDATE_WAKE_CLASS`
(`@opengeni/contracts`). `immediate` kinds (every pre-existing kind plus
`child_requires_action`, `session_wait_timeout`, and
`background_command_result`) register a workflow wake in the same commit as the
pending row, may resume a goal paused only by its continuation ceiling, and end
a `wait_for_input` declaration through the next durable turn. `deferred` kinds insert only the
durable pending row and its `system.update.pending` event; the next claim
delivers them coalesced, `session_wait` reports them without ending the wait
(`ownPendingImmediateUpdates` vs `ownPendingDeferredUpdateKinds`), and they
never resume a goal by themselves.

A child session reports its lifecycle to its parent through typed notices, each
produced inside the child's own lifecycle transaction as one dedupe-keyed
`session_system_update_outbox` row (the worker delivers it; the reaper retries a
committed row after a crash) under the child-lifecycle lock prefix (control
FOR SHARE, workspace FOR KEY SHARE, UUID-ordered child + parent sessions FOR NO
KEY UPDATE, exact turn/attempt), never as a direct insert into the parent's
rows:

| Kind | Class | Produced by | Dedupe |
| --- | --- | --- | --- |
| `child_terminal_result` | immediate | idle/failed/cancelled terminal boundary; an idle result carries the child's `finalAnswer` | `child-completion:<child>:...` |
| `child_requires_action` | immediate | the child's `requires_action` settlement; bounded human-input previews plus approval ids (no subject ids, no tool arguments) | `child-requires-action:<child>:<turn>:<generation>` |
| `child_requires_action_resolved` | deferred | human/API/agent answer or skip, expiry, approval decision, terminal cancellation of a pending request | `child-requires-action-resolved:<child>:<turn>:<generation>:<request or approval>` |
| `child_paused` | deferred | a direct `pause` of the child (not a recursive ancestor pause, not when the parent's own attempt issued it); `action_required` for a human/API pause, `info` for an agent pause | `child-paused:<child>:<receipt>` |
| `child_waiting_capacity` | deferred | a Codex or xAI capacity waiter armed on the child | `child-waiting-capacity:<child>:<waiter>` |
| `child_progress` | deferred | the child's agent `goal_progress`; a newer note supersedes an older still-pending one | `child-progress:<child>:<receipt>` |

Delivery into the parent happens through `addSessionSystemUpdateWithSourceMutation`:
a `child_requires_action_resolved` for one exact (child, turn, generation)
marks the still-pending `child_requires_action` of that boundary `superseded`
(one accepted response advances the boundary; a later re-freeze is a new
generation and a new notice), a newer `child_progress` supersedes the older
pending one, and the parent timeline records `system.update.cancelled` with
`reason: superseded_by_resolution | superseded_by_newer_progress`. Supersession
and the parent's claim order both follow delivery order, so the reaper claims a
backlog oldest first (`created_at`, `id`) and delivers it in exactly that order;
the claim returns its rows sorted instead of in heap order (migration 0528). Like
child results, an immediate child notice may autonomously wake a parent with either
an active goal or a current session-level wait. Without either durable
obligation, child lifecycle notices remain pending until new intent arrives.

A failed or cancelled child reports from its settlement transaction. An idle
child reports at its workflow's terminal-for-now idle boundary: after goal
evaluation, the workflow re-peeks PostgreSQL and runs `markSessionIdle` without
an unconditional grace timer. That transaction rechecks control, active and
queued work and runnable machine input, suppresses completion for a held input
wait or active goal, and commits the episode-deduplicated `child_terminal_result`
outbox row with its
frozen answer. Delivery can precede the workflow run's actual close; a signal
accepted during the close activity chain causes another durable peek, and
later work can start a new workflow run of the same session through the durable
`signalWithStart` wake path. Follow-ups need not coalesce with the completed
episode. The `session-normal-idle-no-grace-v1` patch preserves recorded legacy
5 s timer commands for replay. Held input-wait and other lifecycle timers are
unchanged.

Terminal background-command settlement follows the same proof-first rule as
the command lifecycle. The transaction that changes the exact command row from
`running|stopping` to `exited|lost` also appends
`session.command.finished` and, for a nonterminal session, inserts one
dedupe-keyed `background_command_result` input with an output locator, appends
`system.update.pending`, and registers the workflow wake when idle and
runnable. A failed or cancelled session cannot claim another turn: its terminal
control transition already drained pending input, so command settlement keeps
the exact event but does not reopen model work. A duplicate or stale proof
changes nothing and cannot create a second input. NATS publication happens only
after commit and is a replaceable short-wait hint; PostgreSQL remains
authoritative.

Managed retained-process settlement includes this command/input boundary in
the same transaction as the process row, parent admission, non-TTL holder, and
lease-count transition. If event/input/wake persistence fails, none of those
terminal state changes commit; the already-checkpointed provider proof remains
eligible for a settlement-only retry and provider execution is never replayed.

The five new kinds are produced only while
`OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` is on (default off): a worker from
before these kinds existed throws on an unknown kind, so enable the flag only
once the whole fleet runs an image that understands them. Delivery and
consumption of an already committed notice never read the flag.

Rollout and rollback rule: once the flag has produced rows, a pre-notice image
must never restart while any new-kind row is still pending in
`session_system_updates` or `session_system_update_outbox`; a pre-notice worker
fails its whole outbox reaper batch on one such row and re-peeks a parent's
claim forever. Turning the flag back off stops production but does not drain
already committed rows. Images from this change onward are hardened against the
same two failure modes for any future kind: the outbox reaper dead-letters one
unparseable row (`status = failed`, bounded `last_error`) and keeps delivering
the rest, and the claim path marks a pending row whose kind or payload it
cannot parse `failed` with a visible `system.update.cancelled{reason:
"unrecognized_kind"}` instead of throwing.

An idle `child_terminal_result` is result-bearing. The idle settlement that
commits its outbox row also freezes the child's newest result-bearing
`turn.completed` output as optional `payload.finalAnswer` (`sequence`, `text`,
`truncated`, `totalBytes`, and `nextAction` when truncated). The copy is at
most `CHILD_TERMINAL_RESULT_FINAL_ANSWER_MAX_BYTES` (8 KiB) UTF-8 bytes
including its marker: a longer answer keeps its head and tail around an
explicit omitted-bytes marker, never splits a character, and `nextAction`
names the exact `session_events` `view: "results"` read of the full answer.
The complete answer stays only in the child's own durable event. No answer is
copied when the child's newest turn ended failed, cancelled, superseded, or at a
segment limit (`max_turns`, `budget_exhausted`), or its answer row is itself a
retained preview: an older answer is never presented as the newest task's
result. Only standalone maintenance turns are skipped. A turn claimed only to
continue the child's goal (a goal-routed turn that received no other input,
typically one that confirms and completes the goal after the answer) does not
replace the answer: the settlement walks back past such turns, within the
child's 16 newest turn outcomes, to the newest outcome that had other input,
reports that answer, and lists each continuation's output after it as
`finalAnswer.goalContinuations` (`sequence`, `text`, oldest first). The walk
also stops, as at such a turn, at an earlier outcome that is not a readable
answer (failed, cancelled, superseded, segment-limited, or a retained preview)
and at the child's newest `goal.set` or `goal.resumed` event: goal
continuations never cross an idle boundary that reported the goal inactive, so
the walk never reaches output an earlier result already reported. If the window
holds only continuations, the result is the newest answer alone, exactly as if
no walk were made. The answer and every continuation are copied whole when
together they fit the 8 KiB bound. Otherwise the copy is the newest part,
marked `truncated`: `sequence` and `text` are that part behind a leading note
of how many earlier bytes were omitted (the part itself is cut around a marker
only if it alone exceeds the bound), `omittedSequences` lists each earlier
part, `totalBytes` counts every part, and `nextAction` reads them all from the
first. A child that works across goal continuations therefore still reports its
final report, and no copy ever presents a cut or partial answer as the whole
result. The worker's goal
enrichment upsert keeps the committed `finalAnswer` and `childEventEvidence`
under the row lock rather than replacing them, so an immediately delivered row
and a reaper-delivered row carry the same answer. The field is optional, so older
rows and older workers keep working. An untruncated `finalAnswer` (with each goal
continuation) is itself the consumption evidence for the parent claim's human
acknowledgment, so such a row carries no separate `childEventEvidence`; other lifecycle notices and
answerless terminal results keep the bounded evidence.

A parent's exact live attempt whose model receives a direct child's complete
final answer from `session_wait` (`contentComplete`) or `session_events` (a
whole `results`/debug item) has consumed it. Only a direct model call counts:
the worker's tool gateway marks each first-party call with the attempt surface
that issued it (`_meta.opengeniCaller`, `FIRST_PARTY_MCP_CALLER_META_KEY`), and
a Codemode script, which may return only a summary to the model, or an
unmarked call from an older worker proves nothing. The read records each such
answer on the reading turn as `metadata.consumedChildAnswers` entries
(`childSessionId`, `sequence`, `attemptId`; the newest 64 are kept) in a
separate best-effort transaction that locks only that turn row (a bounded wait;
a busy row skips it) and re-proves that the attempt is still live and the
session's current one and that each sequence is the child's result-bearing
`turn.completed`. A repeated read of an answer the attempt already recorded is
decided without any lock and writes nothing. Nothing is superseded at read
time: the tool output is not durable parent history until the attempt
completes its turn. `session_wait` reports own pending input less each idle
result whose every part (the answer, each goal continuation, and each omitted
part) this attempt or a completed turn received, so the parent is neither woken
by nor told to end its turn for an answer it already has.

The attempt's successful completion settlement
(`applySessionTurnSettlement` with `completed`) then marks each still-pending
idle `child_terminal_result` whose every part was received `superseded` and
appends `system.update.cancelled` with `reason: consumed_by_parent_read`, in
the same transaction and before any later claim, so it starts no inference
that repeats the answer. The child usually commits its result a few seconds
after the answer the parent joined, while the reading turn still runs; such a
result is inserted pending and that completion supersedes it. A result inserted
after the reading turn completed arrives already consumed when every part it
carries is recorded on one of the parent's 16 newest completed turns by the
attempt that completed it: the row is inserted `superseded`, keeps its
`system.update.pending` event for replay, and appends `system.update.cancelled`
with `reason: consumed_by_parent_read`, with no goal auto-resume, wake, or
queued status. The insert and the completion both hold the parent session lock,
so they serialize. A read by an attempt that fails, is interrupted, or is
replaced, even after the read, suppresses nothing: that result is delivered
normally, as is a result reporting any part the parent did not read, such as an
older answer skipped by a later cursor. The record only ever suppresses a
duplicate: an older writer or a lost record delivers the result as before, and
older workers ignore the metadata key. A parent that reads an answer and then
waits with `wait_for_input` for that same result is not woken by it; it wakes
on other input or its own deadline.

When a child's `child_terminal_result` is delivered, that child's still-pending
`child_progress` and `child_waiting_capacity` notices on the parent are
superseded (`reason: superseded_by_terminal`): they describe a state that no
longer exists. A pending `child_requires_action` is deliberately left to its
exact (child, turn, generation) resolution: terminal delivery is unordered
against notice creation (a stale idle result may arrive late through the
reaper after the child got a new prompt and froze again), and every terminal
path emits that resolution itself. A `failSessionWorkBeforeAttemptClaim` that cancels a
child's pending human-input rows emits the same `child_requires_action_resolved`
(`outcome: cancelled`, `respondedByKind: system`) as an ordinary terminal
settlement.

A live agent attempt may answer a child's blocking human-input request with the
first-party `session_human_input_respond` tool (`sessions:control`,
`session.human_input.write`); tool approvals (`session.approval.write`) are
denied to every agent attempt and remain a human decision. See
[`agent-session-authority.md`](agent-session-authority.md).

## Consuming a child notice acknowledges that child

A parent turn consuming a child's lifecycle update also acknowledges that child
for the turn's initiating human, exactly as if they had viewed it. The claim
transaction that marks the batch `delivered` and writes its
`session_history_items` row advances that human's `session_pins`
`acknowledged_sequence` on every child the batch reports on, to the child's
`last_sequence` at that instant. The claim commits or rolls back with the
acknowledgment, so a recovered or retried claim cannot leave the two out of
step.

The mechanism is keyed only on "a claimed turn consumed a child lifecycle
update, and that turn has a frozen initiating human". There is no
orchestrator-, goal-, or depth-specific rule, and every level of a nested chain
behaves identically. It applies to all six child lifecycle kinds, which share
the `childSessionId` field; several notices for one child in a single batch
produce one acknowledgment. A turn whose frozen principal is purely a service
(an ordinary machine-input turn with no causal child parent-turn, goal
continuation, schedule, xAI-user, or private-owner authority behind it) has no
human to acknowledge for and writes nothing.

Read state is per viewer, so this only ever changes the rail for that one
human; another member still sees the child unread. It only ever removes noise:
`unread` is nothing but `sessions.last_sequence > acknowledged_sequence`, so a
child that emits one more event goes unread again with no special handling.
`requires_action` remains a live lifecycle indicator until the input is
resolved. A failed lifecycle remains visible inside the session, while the
rail's red failure-attention marker is viewer-specific and appears only while
that failed session's latest event is unread. Parent tree projections expose a
separate `unreadFailedDescendants` count so an acknowledged historical failure
does not color every ancestor forever. The fence is monotone: a human who has
already read further, or a racing claim that observed a later sequence, is
never regressed.

Monotonicity has one consequence worth stating plainly: an explicit mark-unread
is **not** sticky against a later consumption. Marking a child unread, then
letting that child work and report again, leaves it acknowledged after the
parent's next claim. That follows from the premise that consumption is the read
signal, and the mark still holds until the parent consumes a newer notice, but
mark-unread is therefore not a durable personal to-do flag on a child of an
active orchestrator. Making it sticky would need a durable explicit-unread
marker the acknowledgment respects; there is deliberately no such marker.

The acknowledgment never touches `attention_version`. That revision orders
explicit human attention mutations against each other, and this writer emits no
event, NATS invalidation, or sequence advance a browser could observe. Bumping
it would silently stale the revision the rail holds and turn the human's next
mark-read click into a 409 with no way for the page to know why.

The write is deliberately lightweight and is one statement per claim.

- It honours the `session-personal-state` advisory fence with
  `pg_try_advisory_xact_lock_shared` and skips the acknowledgment when the fence
  is unavailable. Workspace membership removal takes that fence *exclusively* and
  *before* the workspace/session lock prefix the claim already holds, so blocking
  on it here would invert the canonical order; a non-blocking probe cannot.
  Honouring it is what keeps this from being the "racing pin writer recreates
  personal rows after cleanup" hole migration 0278 exists to close, and losing
  the probe is a clean no-op: the child stays unread, exactly as it does today.
  The probe is *shared* rather than exclusive because `listSessionsForSubject`
  holds the shared counterpart for its whole rail-list transaction, and that list
  refreshes on focus, online, and visibilitychange. An exclusive probe fails
  against a held shared lock, so it would drop acknowledgments precisely while
  the human is looking at the rail, and since `child_terminal_result` is
  typically a child's last notice, a drop there would leave exactly the permanent
  unread dot this mechanism exists to remove. Shared still conflicts with
  removal's exclusive hold, and acknowledgment writers need no mutual exclusion
  against each other because the upsert is monotone and row-locked.
- It takes no child turn/attempt lock and no explicit child session lock.
  `session_pins` does carry two foreign keys to `sessions`, so each inserted row
  takes `FOR KEY SHARE` on the child's session row. That is compatible rather
  than an inversion: `FOR KEY SHARE` conflicts only with `FOR UPDATE`, and every
  canonical session writer takes `FOR NO KEY UPDATE`.
- One `INSERT ... SELECT ... ORDER BY id` covers every child in the batch, so
  rows lock in the same UUID order the rest of the session writers use and the
  index order migration 0278 deletes in.
- The insert is fenced on `parent_session_id`, so a payload field can never
  decide whose personal state is mutated on an unrelated session.

The other `session_pins` writers tolerate a row appearing between their read and
their write; the acknowledgment row is pin-neutral and archive-neutral, so their
conflict path is the same transition as their insert.

## Queue and timeline

The human prompt queue and pending machine inputs remain distinct canonical
records but have one UI surface. If a pending machine group will join the next
human prompt, the UI shows it attached to that prompt. Without an eligible
human prompt it appears as one compact incoming-update group. Human prompts
retain their existing edit, reorder, delete, and Steer controls; coalesced
machine inputs are inspected as typed members rather than impersonating human
messages.

The timeline is an audit projection over bounded lifecycle events. A delivered
batch appears immediately at its receiving turn with stable member ids, source
badges, typed labels, and bounded previews. Full model-facing content remains
in canonical input/history storage; the exact event payload is a separate
timeline contract and never reconstructs history.

## Cache invariant

Between explicit compactions, each consecutive model request extends the
previous durable input prefix. The same machine-input batch is present across
tool calls, later turns, and attempt recovery. This is both a causality
requirement and a prompt-cache cost requirement: deleting the batch on the next
call would shift the prefix and force the provider to ingest the conversation
again.

Migration `0135_durable_machine_input_batches.sql` performs the one-way cutover.
It reconstructs model history for delivered legacy rows, returns old deferred
rows to canonical pending state, collapses duplicate pending Agent Steers to the
newest direction, and installs the delivery/history and single-pending-Steer
constraints. A legacy delivery that predates the session's latest explicit
Compact/Clear transition is reconstructed as inactive audit evidence, so the
migration never resurrects context that the user already replaced. Deliveries
after that boundary are inserted into active history at their causal turn
position. There is no runtime compatibility path for ephemeral update injection.

### Showing incoming work in the session

The session dock separates pending inbox inputs from active background commands.
Its Commands panel lists only `running` and `stopping` records for the selected
session. The HTTP list filters at the database; settled records are never loaded
for this panel. Session detail carries the existing active-count projection, and
the command list mounts and polls only while its panel is open. Closing it aborts
an outstanding read and prevents a late Stop response from starting another read.

Delivery remains the timeline landmark: `system.update.delivered` renders through
the existing input row for visible update kinds, including wait timeouts. Those
rows stay outside collapsed steps, including an input received partway through
the same turn. Background command results are retained in durable agent input
and event history, but their delivery receipts are omitted from the chat
timeline, including when they arrive alongside other updates. A delivered input
does not necessarily start a new turn. Command-result summaries include the
bounded command preview; an unavailable exit result is described as unavailable
rather than asserting that execution failed.

The Goal segment keeps pause/resume and clear visible beside its label. The
Queue segment exposes Steer for its first authoritative queued message. These shortcuts stay visible for every pointer type; read-only views omit mutation
controls.

For deterministic local review, run `bun run dev` and open
`/dev/composer-chrome`. The gallery uses the production controls and timeline
projection with synthetic events, covers command loading/empty/error/stopping
states, crowded and read-only layouts, and supports local goal/queue actions.
Its command-result simulator changes fixture state only; no model calls or real
processes are needed. Actual command filtering and settlement are covered by the
real-PostgreSQL session-control algebra tests.

The web session uses compact chrome: queue and goal actions remain visible, while inbox, agents, and active commands share an Activity disclosure. Goal state stays visible; goal age is labelled as time since creation, not execution time. The development gallery includes a synthetic high-volume activity scenario.
