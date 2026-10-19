---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
---

Site and console chat turns now use the same native authority, tools and execution settings. Remove automatic Site-agent restrictions and forced member profiles; retain normal access checks, approvals and outside-workspace visitor identities. Existing saved member settings and accepted turns are not rewritten. Site authors can explicitly choose narrower ordinary chat settings.
