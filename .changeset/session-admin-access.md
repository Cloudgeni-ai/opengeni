---
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/db": minor
---

Owners and admins can give one of their own sessions admin access. When the organization allows it (Organization settings > Security & data > Agents, off by default), "Give admin access…" in a session's header menu lets its agent find and run every organization action the person can, across all workspaces, through `admin_actions_search`, `admin_action_describe` and `admin_action_call`. A small shield beside the session title shows it is on and turns it off. Access is checked on every call and ends when either switch is turned off or the person stops being an owner or admin. SDK: `getOrganizationAgentAdminAccess`, `updateOrganizationAgentAdminAccess`, `getSessionAdminAccess`, `grantSessionAdminAccess`, `revokeSessionAdminAccess`.
