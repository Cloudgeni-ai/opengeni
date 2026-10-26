---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

EU-only content stays in EU-only workspaces. A session reaching another workspace (session tools given a `workspaceId`, or `admin_action_call` naming one) is refused when it would bring an EU-only workspace's content into a workspace that isn't EU-only, or carry an EU-only session's messages or changes there; nothing runs when the setting can't be read. API routes answer such a refusal with the new error code `region_restricted` (HTTP 422). New `@opengeni/db` exports: `assertWorkspaceContentFlowAllowed`, `assertWorkspaceContentExchangeAllowed`, `workspaceContentFlowEnd` and `WorkspaceContentFlowRefusedError`.
