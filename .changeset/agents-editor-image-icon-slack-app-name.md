---
"@opengeni/api-router": patch
"@opengeni/contracts": minor
"@opengeni/react": patch
---

The agent editor shows an agent's image icon and keeps it when other fields are saved, instead of clearing it.

An agent's Slack rows (`GET /agents/:id/slack`) carry the Opengeni app's name in each Slack workspace as optional `botDisplayName`, so the agent page shows how people really ask it there (for example `@Opengeni Staging Release Scribe`); without it, clients use `@Opengeni`.
