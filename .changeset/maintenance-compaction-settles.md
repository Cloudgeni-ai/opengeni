---
"@opengeni/react": patch
---

A proactive context compaction that runs as its own maintenance turn no longer leaves a "Working" row with a ticking clock when it is the chat's last turn. When the maintenance turn completes, its startup steps are dropped and only the "Conversation history compacted" landmark remains, as for a manual compaction.
