---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

People who can start chats in a shared workspace (`sessions:create`) can now read its budget configuration: `GET /v1/workspaces/:workspaceId/allowance` and `/allowance/state` (`getWorkspaceAllowance`, `getWorkspaceAllowanceState`), alongside the remaining amount `/usage/me` already showed them. They still can't read other members' usage or change budgets or member limits, and agents, services and session-bound tokens stay refused. The app action catalog lists these reads under `sessions:create`.
