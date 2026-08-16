---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": minor
---

Complete governed goal rewrites with strict agent change metadata, immutable
proposal rejection and CAS-fenced rollback, bounded revision pagination, and
accepted-turn root constraints that child agents may inherit or narrow. The
original raw-array goal-revision list remains unchanged; bounded pagination is
available through a separately named API and SDK surface.
