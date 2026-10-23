---
"@opengeni/react": patch
---

A parent session now shows the questions and tool approvals its sub-sessions are waiting on, pinned above the composer. Each one names the sub-session that is asking, uses the same answer form or approval card as the sub-session's own page, and sends the answer or decision to that sub-session as if it were given there, with the same permission checks. An unsent answer is shared with the sub-session's page, so it is still there when you switch between them. Several waiting sub-sessions stack under one line ("3 sub-sessions need you") that collapses. Each item links to the sub-session, opened at the moment it asked. A request disappears once it is resolved anywhere, including by the parent agent answering it. The collapsed bar of a question with a deadline no longer shows "[object Object]".
