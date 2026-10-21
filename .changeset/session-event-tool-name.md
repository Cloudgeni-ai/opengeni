---
"@opengeni/db": patch
---

Conversation-first history reads no longer slow down with large tool arguments. Tool-call rows now carry a trigger-filled `tool_name` column, and the presented-tool filter reads it instead of the payload name, so skipped calls are no longer detoasted. Rows written before the migration fall back to the payload name and are classified exactly as before.
