---
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
---

Enforce EU-only inference. When a workspace is EU-only, model resolution
refuses routes that are not EU, every provider adapter checks each request
against the EU routes before it is sent, and the worker checks the setting
again on every attempt. Refusals use the `region_restricted` code.
