---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Workspace Slack bot tools are listed only when the workspace has a Slack bot available, so a Slack request in a workspace without one reaches the Slack connect offer. In interactive chats, sending a prepared bot message asks for approval whenever the person's own Slack sends would.
