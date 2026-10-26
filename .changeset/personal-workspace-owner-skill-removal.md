---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

An agent in the owner's own chat in their Personal workspace can now remove that workspace's Skills, as it can already save and edit them. Removal follows the chat's Skills mode: Automatic removes, Review first leaves a deletion proposal for the owner, Off refuses. In shared workspaces a private chat still removes only the person's own Skills, and another person's personal Skill stays out of reach. When a removal is refused, the agent now tells the person they can remove the Skill on the Skills page.
