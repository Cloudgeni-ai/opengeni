---
"@opengeni/runtime": minor
---

Codex remote compaction now keeps the same 20,000-token window of recent messages as portable compaction instead of 64,000. In agent-driven sessions that larger window was filled by platform updates the checkpoint already summarizes, so about 80,000 tokens stayed in context after each compaction. Turn-scoped operational notices from earlier turns are also left to the checkpoint. `REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET` is removed; use `COMPACT_USER_MESSAGE_MAX_TOKENS`.
