---
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Require Node.js 22.19 or later (`engines.node`) for the packages that load `@opengeni/runtime`, whose `e2b` dependency requires it; installers that enforce engines refused them on 22.15.
