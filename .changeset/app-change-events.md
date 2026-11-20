---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": minor
"@opengeni/db": minor
---

App data changes start automations and reach workspace webhooks: the `app.record.added`, `app.record.changed`, `app.record.removed` and `app.sql.changed` event types join the "This workspace" trigger source and the workspace webhook types, and `verifyWebhookEvent` accepts them. See docs/site-data.md.
