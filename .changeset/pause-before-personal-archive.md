---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Pause chat work atomically before personal archiving, require confirmation for active shared work, and retain explicit hide-only behavior for read-only and embedded proxy clients. Restore does not resume work. Keep sidebar survivors stable across archive completion and overlap independent session response reads without changing transaction or authorization boundaries.
