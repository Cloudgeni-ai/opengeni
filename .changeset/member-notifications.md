---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react-native": minor
"@opengeni/api-router": minor
---

Agents can notify another member of their workspace. `notify_user` takes an optional `recipient` (email or member name); it reaches that member only while they allow other members' agents to notify them in that workspace, a per-person setting that is off by default (`GET`/`PUT /v1/workspaces/:workspaceId/inbox/member-notifications`, `getMemberNotifications` and `updateMemberNotifications` in the SDK). Otherwise the agent gets a clear refusal, as it does for non-members and for sessions that work for no person. Inbox items now carry `sender` (who the notification came from) and `sessionAvailable`: another member's private session is never linked, titled or opened from the inbox or the phone notification. Inbox items are kept per recipient, so one key can reach the owner and a teammate separately, and `notification_withdraw` can withdraw one member's copy.
