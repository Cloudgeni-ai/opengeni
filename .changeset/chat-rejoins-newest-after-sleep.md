---
"@opengeni/sdk": minor
"@opengeni/react": patch
---

An open chat now jumps to its newest messages after the connection drops, for example when a laptop wakes from sleep, the network comes back or the stream times out, instead of streaming every event it missed. A gap of 16 events or fewer still replays over the live stream; a longer one catches up the conversation and re-reads the working turn's newest steps, or loads the newest window, and the live stream continues from there. The chat also notices a sleep or a returned network right away instead of waiting for the stream's heartbeat timeout. `streamSessionEvents` and `client.streamEvents` accept an optional `beforeReconnect(cursor)` that may move a reconnect's cursor forward; callers that don't pass it keep exactly-once replay.
