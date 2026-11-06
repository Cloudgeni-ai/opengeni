---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
---

A Microsoft 365 Global Administrator or Teams Administrator can now connect their organization to Opengeni for Teams themselves, without an operator allowlist entry, when `OPENGENI_TEAMS_BOT_SELF_SERVE_SETUP_ENABLED=true` (default off) and the tenant is admitted. People in an organization that hasn't connected Opengeni get a welcome in their 1:1 chat with a Connect your organization link, at most once per ten minutes and a few times a day. Setup needs their Opengeni sign-in, a Microsoft sign-in through the bot's Entra app whose tenant and user match the Teams message and whose roles include one of those administrator roles, and a shared workspace they administer. It never moves or replaces an existing connection. `POST /v1/workspaces/:workspaceId/integrations/teams/bot/microsoft-sign-in` starts the Microsoft sign-in, `PUT .../teams/bot` takes an optional `microsoft: { code, state }`, and `teamsApi` adds `startMicrosoftSignIn` and an optional second argument to `installBot`. Operator-approved installers keep working as before.
