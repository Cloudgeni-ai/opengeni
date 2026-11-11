---
"@opengeni/db": patch
---

Reject rolling migrations that revoke, drop or rename a routine, table privilege or schema that the previous release's runtime posture still requires, judged against the posture of the main merge base and the pinned production baseline.
