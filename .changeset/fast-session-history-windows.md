---
"@opengeni/db": patch
"@opengeni/react": patch
---

Keep lazy session-history reads sub-second on large sessions by fitting each browser window and its continuation lookahead into one bounded database query instead of walking the page through many sequential 64-row batches.