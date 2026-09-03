---
"@opengeni/db": patch
"@opengeni/react": patch
---

Keep lazy session-history reads sub-second on large sessions by fitting each browser window and its continuation lookahead into one byte- and count-bounded database query instead of walking the page through sequential reads. Fresh and foreground tail loads may use one additional bounded page to preserve a complete turn boundary, and foreground replacement keeps the prior timeline visible until the new window is ready.