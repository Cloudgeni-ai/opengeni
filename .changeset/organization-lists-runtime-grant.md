---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

Migration 1272 grants the runtime role EXECUTE on the organization vault list (1218) and the organization machine and rig list (1224), which both withheld it for one release. Readiness and provisioning now require them, and `GET .../organization-vaults`, `GET .../organization-machines` and `GET .../organization-rigs` always list every organization one wherever it works. Their `complete` field is always `true`; servers before 1272 could list only the ones that work in the requested workspace and sent `false`.
