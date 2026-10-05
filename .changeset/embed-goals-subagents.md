---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Goal controls and sub-agent chats in the stock embedded chat.

- `createSessionProxyHandler` serves the session goal: `GET goal`, `PATCH goal` forwarding only `{ status: "paused" | "active" }` (a browser rationale is dropped; other fields are refused), and `DELETE goal`, the proxy's only `DELETE` route.
- `SessionConversation` shows the goal in its chrome with Pause, Resume, and Clear when the client can reach goals. An older proxy's 404 reads as "no goal".
- `SessionConversation` takes `onOpenSession`, forwarded to the timeline's sub-agent cards and the chrome's child updates. `OpenGeniChat` defaults it to opening the child chat in place.
