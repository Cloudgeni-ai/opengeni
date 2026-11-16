# Messaging another session reads as Queue and Steer

`session_send_message` is renamed `session_queue_message`, so an agent's two
ways of messaging another session carry the same names as a person's two modes
in the chat: Queue (read after the target's current turn ends; adds
information) and Steer (read at the target's next step; replaces direction).
Delivery timing is unchanged.

Agents read the old name and its receipt (`outcome: "accepted"`, the target's
control state `"active"`, `delivery: "coalesced_internal_update"`) as
"delivered", and left workers running on stale direction until their long turn
ended. The tool descriptions and results now say which mode was used and when
the target reads it; the prompt only follows the rename.

Size: +14 bytes in the modular prompt, +2 bytes in the legacy contract. The legacy contract carries the same rename in the
delegation sentence, so that sentence stays in parity. The two session-target
sentences exist only in the modular prompt, so their lines in
`2026-11-11-legacy-sentence-edits.md` are edited in place.

```text
- Delegation has setup and coordination overhead: by default, answer directly when the work takes only a few steps, and send a related follow-up to a child you already spawned with `session_send_message` instead of spawning another.
+ Delegation has setup and coordination overhead: by default, answer directly when the work takes only a few steps, and queue a related follow-up to a child you already spawned with `session_queue_message` instead of spawning another.
- Send only when asked, and use Steer only for an explicit change of direction.
+ Queue a message only when asked, and use Steer only for an explicit change of direction.
- After Send or Steer, use session_message_status with the returned update ID to follow its exact consuming turn and read the indicated result before relaying it.
+ After Queue or Steer, use session_message_status with the returned update ID to follow its exact consuming turn and read the indicated result before relaying it.
```
