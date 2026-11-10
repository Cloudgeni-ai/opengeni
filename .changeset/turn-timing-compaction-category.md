---
"@opengeni/db": patch
---

Turn timing profiles (version 2) put context compaction inside a turn in its own `compaction_ms` category. A compaction whose summary call has no model request audit (the Messages subscription path) was charged to `after_tool_ms`, which made Opengeni's time between a tool result and the next step look about 100 times larger on that path than it is.
