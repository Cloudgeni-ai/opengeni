---
"opengeni-web": patch
---

The session Artifacts dock no longer re-lists the artifact catalog of every sub-session after each tool call. A tool call now re-reads the chat itself and only the sub-sessions whose activity advanced since the last read; the end of a turn, Retry and pin changes still re-read everything. Chats that delegate to many sub-sessions previously issued two catalog requests per sub-session on every tool output while open in a browser.
