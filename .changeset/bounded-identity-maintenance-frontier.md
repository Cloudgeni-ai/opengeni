---
"@opengeni/db": patch
---

Keep historical identity maintenance frontier reads ordered by native UUID so they use the primary-key index rather than sorting cast text, and apply configured job timeouts to startup inspection.
