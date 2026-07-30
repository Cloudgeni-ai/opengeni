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
in canonical input/history storage, not the redacted event payload.

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
