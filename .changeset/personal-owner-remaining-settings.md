---
"@opengeni/api-router": patch
---

The owner of a Personal workspace can now change its credential profile, remove secrets from its chats' stored history, configure Memory-to-Slack publishing and set its Slack task policy, like a workspace admin does in a shared workspace. These routes now use the workspace settings check (a workspace admin, or the verified owner of the Personal workspace); delegated owner lookalikes and non-admin members of shared workspaces are still refused.
