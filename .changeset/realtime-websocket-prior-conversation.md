---
"@opengeni/sdk": patch
"@opengeni/contracts": patch
---

Voice calls on WebSocket voice models (Eleven Realtime, SuperGrok and AI Gateway) now start knowing the chat's earlier conversation: it is part of the voice session's instructions, as for hosted GPT Live, instead of messages sent once the socket opens, which Eleven Realtime kept unread. Progress from the agent is sent to the voice model as one update when the person starts speaking or before a requested reply, instead of one message per streamed fragment, so Eleven Realtime no longer rejects it. The connect response's `initialItems` is now always empty and deprecated.
