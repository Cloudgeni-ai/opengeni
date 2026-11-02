---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Slack agents are now shown one way everywhere: `@Opengeni Data team`, with the name as the admin wrote it (`+name` still works). In a thread, a bare name switches agents only when it is the whole message or is followed by "," or ":", and a bare name stays in the request. New names need two letters and can't be sentence starters such as "Hi" or "Test"; one-word names get a warning. Chats hand off only when the person asks for the agent by name, and otherwise answer and may show "<Agent> handles questions like this." with an Ask button. Admins can pick an announcement channel for new agents, the intro page shows a live Slack preview, sorts and searches channels, and reports channels where Slack limits posting.
