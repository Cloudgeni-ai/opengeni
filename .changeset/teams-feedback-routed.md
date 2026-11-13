---
"@opengeni/db": patch
---

Microsoft Teams feedback (thumbs up or down) on replies in routed 1:1 chats, including Personal and other non-home workspaces, and in chats with agents anyone in the organization may use, is now recorded instead of being refused as `feedback_not_permitted`. It is authorized like the chat itself: the reacting person must be the linked owner of that chat, with live organization membership and access to its workspace (organization-agent chats record as `teams-agent:<agentId>` while the agent is still open to them). `TeamsDeliveredReply` adds the chat's `workspace_id`, `actor_id` and `agent_id`. Linking a Teams account with workspace routing now also refuses an agent acting for the person; only the person signed in to Opengeni themselves can link.
