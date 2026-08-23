---
"@opengeni/config": minor
---

Add `OPENGENI_CHILD_LIFECYCLE_NOTICES_ENABLED` (default `false`): produce child lifecycle notices (`child_requires_action`, its resolution, `child_paused`, `child_waiting_capacity`, `child_progress`) for parent sessions. Rolling hazard: a worker from before these kinds existed throws on an unknown `session_system_updates` kind, so enable only once the whole fleet runs an image that understands them. The deployment contract carries it as a valueEnv passthrough (`CHILD_LIFECYCLE_NOTICES_PASSTHROUGH_ENV`).
Once the flag has produced rows, a pre-notice image must never restart while any new-kind row is still pending in `session_system_updates` or `session_system_update_outbox`; turning the flag back off stops production but does not drain already committed rows.
