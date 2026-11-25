---
"@opengeni/react": patch
---

A sub-session that waits only on a connection card no longer says "needs you" forever: completing a session's goal withdraws its open connection cards, and the parent's line for such a wait has Dismiss, which hides it until that sub-session waits again. Questions and approvals stay as they are.
