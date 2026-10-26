---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Work the owner starts in their own Personal workspace (their chats and scheduled tasks) can now remove that workspace's Skills, as it can already save and edit them. Removal follows the chat's Skills mode: Automatic removes, Review first leaves a deletion proposal for the owner, Off refuses. In shared workspaces a private chat still removes only the person's own Skills, another person's personal Skill stays out of reach, and an agent removal that names a scope is refused. When a removal is refused, the agent now points to the Skills page for workspace Skills and the person's own Skills.
