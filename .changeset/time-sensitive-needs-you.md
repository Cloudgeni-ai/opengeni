---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

A person can have the phone alerts for their agents' questions and approvals arrive time-sensitive, so they break through Focus on iPhone while the agent waits on them. `InboxSettings` gains `timeSensitiveNeedsYou` (off by default; `GET`/`PUT /v1/inbox/settings`, `getInboxSettings` and `updateInboxSettings` in the SDK). The web Inbox settings and the mobile app's Notifications settings offer it. Replies and failures stay ordinary alerts, and an agent's own notifications keep the urgency the agent gives them.
