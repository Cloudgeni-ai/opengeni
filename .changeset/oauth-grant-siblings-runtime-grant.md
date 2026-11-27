---
"@opengeni/db": patch
---

Activate the shared OAuth grant checks: migration 1680 grants the runtime EXECUTE on migration 1611's two definers, so a disconnect revokes at Google only when no other live connection anywhere may hold the grant, and a refused refresh checks the same account's other connections. The definers now accept only the Google family pinned in SQL (token endpoints, provider domain and account metadata keys); a caller can no longer match connections by keys it chooses. Rows without a stored account identity still block a revoke and are never marked.
