---
"@opengeni/contracts": minor
"@opengeni/config": minor
---

Record where every model route processes data. Each configured model carries a
residency record (geography, deployment type, regions and evidence); registry
providers and the built-in provider can declare it, other providers use reviewed
built-in rules, and an undeclared route is unknown, never EU. The model catalog
exposes the residency verdict without the evidence text.
