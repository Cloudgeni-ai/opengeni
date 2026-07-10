---
"@opengeni/runtime": patch
---

Freeze the codex tool_search description for the whole turn once connectors are discovered, instead of re-rendering it from the live connector-namespace Set on every model call. A mid-turn Set change used to flip the tools block, which precedes the conversation history in the request prefix and so cold-started the entire prompt-cache prefix from that point on. The freeze locks the first discovered (non-empty) connector list and reuses it byte-stably for the rest of the turn; while the Set is still empty (discovery slow/failed) it falls back to a live render rather than freezing an empty list, so a turn's connectors are never silently disabled.
