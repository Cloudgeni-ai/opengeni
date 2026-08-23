---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Child lifecycle notices. `SessionSystemUpdateKind` gains `child_requires_action`, `child_requires_action_resolved`, `child_paused`, `child_waiting_capacity`, and `child_progress` with typed, bounded payload schemas (no subject ids, credentials, or raw tool arguments), plus `SESSION_SYSTEM_UPDATE_WAKE_CLASS` (`immediate` for every pre-existing kind and `child_requires_action`; `deferred` for the other four) and `CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS`. The first-party tool catalog gains `session_human_input_respond` (default selection, not goal-required). The SDK mirrors the new kinds and tool name.
