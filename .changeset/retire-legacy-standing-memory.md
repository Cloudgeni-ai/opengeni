---
"@opengeni/contracts": major
"@opengeni/db": major
"@opengeni/api-router": major
"@opengeni/sdk": major
---

Retire Memory V1's standing prompt block and its agent writes. `memoryPromptMode` is now always `retrieval_only`: no pinned/recency working set is injected into any agent prompt, and the `legacy_standing` rollback opt-out can no longer be selected. The `memory_save` and `memory_correct` first-party tools are removed; durable agent writes go through `remember` (explicit user-directed) and task-note promotion (the agent's own findings), while `memory_search` remains so an agent can still read what a workspace knows.

Nothing is rewritten or deleted: `knowledge_memories` rows, human REST/UI audit, search, correction, export, and the Memory Slack publication path are unchanged. A workspace that stored `legacy_standing` keeps the stored value in its passthrough settings bag, where it simply stops meaning anything, and already accepted turns keep the mode they recorded because those snapshots are immutable facts about what was composed. Migration 0289 changes no data; it reports whether anything was still relying on the mode rather than assuming it was unused.
