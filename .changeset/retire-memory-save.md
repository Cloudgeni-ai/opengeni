---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
---

Retire the legacy Memory V1 `memory_save` agent tool from the default retrieval-only surface: it is now compatibility-only, excluded from the default first-party tool catalog, and registered only when a workspace opts into the `legacy_standing` rollback mode. Agents save user-directed knowledge through `remember` and their own findings through task notes and governed promotion; `memory_search` and `memory_correct` remain.
