---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": patch
---

An agent acting as a person with their full access (an agent with session admin access, or a connected agent given Full access over all workspaces) can now do what that person can in the organization: give their sessions admin access and allow it for the organization, approve an agent sign-in they started, manage connected agents, read and tidy their inbox and session mutes, and redeem usage-limit resets. An agent with less access is refused the steps that give or approve access, so it can never widen its own. Creating organizations, invitations, organization recovery and identity links stay with the person in the browser. The session control action now describes that cancel is permanent while pause is reversible, and the agent sign-in and connected-agent bodies are named contract schemas (`McpConnectionDecision`, `UpdateOrganizationMcpConnectionRequest`).
