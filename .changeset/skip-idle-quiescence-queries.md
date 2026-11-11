---
"@opengeni/db": patch
---

Skip the exact quiescence and pending-writer queries on the turn peek and claim paths when a cheap probe shows the session has no attempt that could await its quiescence receipt, saving their planning cost on most turns.
