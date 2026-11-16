---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

The agent offers each service's Connect card once. When the deployment has its own integration for a service (Gmail, Google Calendar, Google Drive, Slack, X, Reddit, or one served through Nango), a public-registry entry for the same service is no longer listed beside it, and a card requested for that entry is the built-in's card. When the organization's integration policy turns a built-in integration off, the agent gets no card for it or its registry duplicate and is told the integration is turned off for the organization. Google connectors served through Nango can be connected even when this deployment's own Google sign-in setup is unavailable. Registry entries for other services, entries already turned on in a workspace, and deployments without the built-in integration are unchanged.
