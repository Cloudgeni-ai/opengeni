---
"@opengeni/config": minor
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Self-hosted operators can let API-origin work (organization access keys, embedded products) use the organization's own connected subscriptions with `OPENGENI_API_CONNECTED_SUBSCRIPTIONS_ENABLED=true` (`apiConnectedSubscriptionsEnabled`, default `false`). It is deployment configuration on the API and worker processes, never a request or tenant setting. With it on, agent turns, goals, schedules, stateless model calls, transcription, realtime voice, titles, model lists and defaults no longer refuse or skip connected subscriptions for API work; paid-plan requirements still apply where credit billing is active. Off, API selections of a subscription still return `403 subscription_api_unavailable`, as before. The operator is responsible for its provider's terms.
