---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
---

Add `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/skills` and SDK `updateSessionSkills` to replace the Skills a session carries itself. It uses the session's tool-policy version, applies from the next turn and records a `session.skills.updated` event; an agent can only remove Skills.
