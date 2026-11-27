---
"@opengeni/db": patch
---

The child-result and quiescence-receipt wake repair inventories now find stranded sessions when the database owner does not bypass row security, the posture in docs/deployment.md. Before, they found none there and never repaired a wake. Each call opens the wake dispatcher's maintenance claim; results under an owner that bypasses row security are unchanged.
