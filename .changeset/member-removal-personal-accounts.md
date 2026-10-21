---
"@opengeni/db": patch
"@opengeni/core": patch
---

Removing a workspace member or offboarding an organization member now works when that person's sessions selected their own connected account. Previously two session fences rejected the revocation and the removal failed with a generic "not available". External membership errors now also name the database check that refused them.
