# Durable agent inputs

Agent-to-agent messages, Agent Steer instructions, child results, scheduled
occurrences, and goal continuations share one durable lifecycle. They are not
human prompts, but they are real model input and therefore cannot exist only in
an activity-local system message.

## Canonical lifecycle

1. A producer inserts one typed `session_system_updates` row with a stable
   dedupe identity. `pending` is the authoritative waiting state.
2. The queue endpoint reads those rows directly. Session events only tell a
   client to refresh; they never reconstruct the queue.
3. A turn claim locks and selects a bounded group, assigns the receiving turn,
   serializes one deterministic system message, and inserts that exact message
   into `session_history_items` in the same transaction that marks every member
   `delivered`.
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

Pending machine input also wakes a held orchestrator. An active goal whose
latest turn declared a `goal_wait` hold (see [`goals.md`](goals.md)) does not
materialize a goal continuation at idle, but a pending `session_system_updates`
row of an `immediate` wake class (a child result, agent message, schedule, or
`child_requires_action`) still makes the session runnable: the idle evaluation
returns `queue` instead of `held`, the next claim delivers the batch, and that
delivering turn retires the hold because it is a newer finished turn. The hold
only suppresses the synthesized continuation between real inputs and the hold
deadline. `deferred` rows (see below) do not end a current hold; they are
delivered when it ends or an immediate input arrives. Without a current hold any
pending row makes the session runnable.

## Wake classes and child lifecycle notices

Every kind has one wake class in `SESSION_SYSTEM_UPDATE_WAKE_CLASS`
(`@opengeni/contracts`). `immediate` kinds (every pre-existing kind plus
`child_requires_action`) register a workflow wake in the same commit as the
pending row, may resume a goal paused only by its continuation ceiling, and end a
`goal_wait` hold at the next idle evaluation. `deferred` kinds insert only the
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
| `child_terminal_result` | immediate | idle/failed/cancelled terminal boundary (unchanged) | `child-completion:<child>:...` |
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
`reason: superseded_by_resolution | superseded_by_newer_progress`. Like child
results, no child notice may autonomously wake a parent whose goal is not
active or that has already failed.

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
(an ordinary machine-input turn with no goal continuation, schedule, xAI-user,
or private-owner authority behind it) has no human to acknowledge for and
writes nothing.

Read state is per viewer, so this only ever changes the rail for that one
human; another member still sees the child unread. It only ever removes noise:
`unread` is nothing but `sessions.last_sequence > acknowledged_sequence`, so a
child that emits one more event goes unread again with no special handling, and
the `failed` and `requires_action` rail indicators are derived from
`sessions.status`, rank above unread, and are untouched. The fence is monotone:
a human who has already read further, or a racing claim that observed a later
sequence, is never regressed, while an explicit mark-unread still wins.

The write is deliberately lightweight. It takes no lock on the child session,
turn, or attempt (only a plain workspace-RLS read of the child's
`last_sequence` plus a monotone upsert under a temporary subject scope), and it
does not take the `session-personal-state` advisory fence, because workspace
membership removal takes that fence *before* the workspace/session lock prefix
the claim already holds. Taking it there would invert the canonical order. The
other `session_pins` writers therefore tolerate a row appearing between their
read and their write; the acknowledgment row is pin-neutral and
archive-neutral, so their conflict path is the same transition as their insert.

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
