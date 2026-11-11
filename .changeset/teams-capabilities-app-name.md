---
"@opengeni/api-router": patch
"@opengeni/sdk": minor
---

The Teams bot card on the Capabilities page is now named after the deployment's Teams app (`OPENGENI_TEAMS_APP_NAME`, default "Opengeni") instead of "Opengeni for Teams", so it matches the app people install in Teams. Its link and setup hints name that app too. `GET /v1/workspaces/:workspaceId/integrations/teams/bot` returns the name as `appName`, and `TeamsBotStatus.appName` is optional for servers that predate it. The refusal for a personal Microsoft account no longer says "Opengeni for Teams".
