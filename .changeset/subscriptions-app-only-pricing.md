---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Refuse connected subscriptions for API-origin work, including scheduled and
goal continuations, transcription and realtime voice, and skip them when choosing API defaults. Keep app
subscription use fee-free and own-key billing configuration-driven. Clarify
paid-plan and API pricing in the billing page, docs and bundled help.
