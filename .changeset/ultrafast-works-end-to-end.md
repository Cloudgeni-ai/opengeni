---
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/db": patch
---

Choosing Ultrafast now works. The database accepted only Standard, Priority and Fast, so with Ultrafast selected every draft save, new chat and message failed with a server error. Migrations 1302-1310 widen the latency-mode checks on chats, turns and both kinds of drafts (added NOT VALID, then validated separately, so no table is locked for long), and scheduled runs into an Ultrafast chat are admitted. Compaction turns, goal continuations and scheduled runs keep a chat's Ultrafast setting instead of dropping to its default. The built-in provider offers Ultrafast only on the direct OpenAI API, where OpenAI serves it, not on Azure OpenAI or another base URL; turns already accepted there keep running. Agents can start Ultrafast workers with `session_create`.
