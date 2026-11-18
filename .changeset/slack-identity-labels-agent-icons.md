---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

Chats started for a person from Slack, Teams, a schedule or the API now freeze that person's name like chats started in the app, and the sidebar resolves older unlabeled chats to the person's name instead of showing an id fragment. Session list entries carry `agentId`, so agent chats show the agent's icon in the sidebar and chat switcher. Agents' Slack installs report `postsAsAgent`; when the Slack app lacks `chat:write.customize`, the Slack integration page and the agent's Slack row say replies show as Opengeni, with one Update action.
