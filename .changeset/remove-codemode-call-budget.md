---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/db": patch
---

Remove the arbitrary per-turn Codemode call cap. One turn may journal as many Codemode calls as the work needs; recovery still reuses that same journal rather than minting a new budget.
