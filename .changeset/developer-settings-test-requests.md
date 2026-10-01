---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
---

Let workspace administrators test integration endpoints and see what they inherit. `testWorkspaceWebhook` sends a signed `webhook.test` event (accepted by `verifyWebhookEvent`, never queued), `testWorkspaceCredentialProvider` sends a `credentials.request` with `purpose: "test"` and returns only the names of what a run would get, and `getWorkspaceInheritedIntegrations` lists the organization provider and webhooks that reach a workspace. The web app's Developer settings now explain both integrations, give each webhook and the provider its own page with deliveries and a test, and manage organization-wide registrations under Organization settings > Developer.
