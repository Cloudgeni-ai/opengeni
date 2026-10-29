---
"@opengeni/db": patch
---

Reuse a root session's already locked control fields during attempt write admission instead of repeating its ancestry query. Child sessions and KEY SHARE writers retain fresh ancestry reads; pause, authority and interruption fences are unchanged.
