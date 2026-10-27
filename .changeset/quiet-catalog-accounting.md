---
"@opengeni/db": patch
---

Count concurrent fills of the same verified tool catalog once in the cache's byte budget, avoiding unnecessary eviction and repeated hydration. Every read still checks the durable row under its existing access scope.
