---
"@opengeni/db": patch
---

Keep task-tree authority's root-session lock compatible with foreign-key checks,
preventing a cycle with concurrent child activity finalization while retaining
writer serialization and exact attempt/visibility checks. Migration 0542 is
rolling-compatible and preserves the function's owner and privileges.