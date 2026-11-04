---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/api-router": patch
---

`PUT /sessions/:id/tool-policy` accepts an optional `firstPartyMcpPermissions`, so an existing session can gain a newly granted tool and the first-party permissions it needs in one versioned update. The caller must hold every permission it grants, a child stays within its parent, an agent attempt may only narrow, and a session with an open goal keeps `goals:manage`.
