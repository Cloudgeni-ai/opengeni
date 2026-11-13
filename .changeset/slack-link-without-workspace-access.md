---
"@opengeni/api-router": patch
---

People without access to a workspace can open its Slack link again. The Slack user-link routes (`POST …/integrations/slack/user-link-intents`, `GET …/:requestId`, and `POST …/:requestId/link`, `/request-access` and `/cancel`) were behind the workspace access check, so an organization member outside the workspace got "workspace access denied" instead of linking their Slack account, and anyone else couldn't ask for access. The routes keep their own checks (a managed sign-in, the signed Slack link or the request it prepared for that person, and workspace-scoped reads and writes).
