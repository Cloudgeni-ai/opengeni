---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

When the Teams bot is @mentioned in a group chat or channel thread, the agent now sees the recent messages it was not mentioned in, as Slack already does. A package built with `OPENGENI_TEAMS_APP_CONVERSATION_CONTEXT=true` asks for the `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat` resource-specific permissions, so Teams delivers every message in a conversation where the app is installed; Opengeni keeps a bounded recent window and attaches it to the mention. Only a fresh @mention still triggers a reply. A follow-up mention in the same channel thread now continues that thread's chat instead of opening a new one. Team-scope packages now declare `supportsChannelFeatures: "tier1"`, which the Teams admin center requires for manifest 1.25 uploads.
