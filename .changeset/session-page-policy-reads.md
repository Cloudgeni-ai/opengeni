---
"@opengeni/core": minor
"@opengeni/sdk": patch
---

Resolve session-page connector availability and defaults from one current registry read instead of loading it twice. Keep workspace and subject scopes unchanged.

Reduce temporary query allocations and repeated session-path strings in the SDK without changing request values or legacy response handling.
