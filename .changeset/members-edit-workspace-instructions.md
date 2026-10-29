---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
---

Members of a shared workspace can now edit its instructions and review the agent's proposed changes to them, like shared Skills and Knowledge. Anyone who can start chats there (`sessions:create`), acting as themselves, may create drafts, import the earlier persona, propose onboarding instructions, activate and roll back, and approve or reject instruction proposals; the Knowledge page shows these controls to them. Viewers still can't, and tokens that only carry `sessions:create` (an agent's own, a worker's, an organization or workspace API key's, or another product's person) are refused, so agents still change instructions only through agent learning. A member's personal API key, or a chat they gave full access, acts as that member, like their connected agent, within what they allowed. The workspace's learning settings stay with admins and the Personal owner. New `requireWorkspaceContributorGrant` / `workspaceContributionAuthorized` in `@opengeni/core` and `canContributeWorkspaceContent` in `@opengeni/react`.
