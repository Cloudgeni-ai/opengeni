---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Omit a human/API prompt whose turn was never claimed (still queued, or deleted/edited/cancelled before any claim) from `sessions_list` `includeLastMessage` previews and the MCP `session_events` monitoring read, so orchestrators do not mistake work the model never received for processed conversation. `queuedPromptCount` still reports waiting work, the exact stored row appears at its original sequence once the turn is claimed, and REST event pages, SSE, and forensic reads are unchanged. Rolling migration 0322 adds the partial index `session_turns_unclaimed_prompt_trigger_idx` (`workspace_id, session_id, trigger_event_id` where `started_at IS NULL`) that serves the unclaimed-turn probe.
