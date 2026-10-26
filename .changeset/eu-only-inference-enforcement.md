---
"@opengeni/config": minor
"@opengeni/runtime": minor
"@opengeni/core": minor
"@opengeni/contracts": minor
---

Enforce EU-only inference. When a workspace is EU-only, model resolution
refuses routes that are not EU, every provider adapter checks each request
against the EU routes before it is sent (including the deployment an Azure
deployment-path URL calls), and the worker checks the setting again on every
attempt and applies it to the whole attempt. Refusals use the
`region_restricted` code, are never retried, and end a turn once.
