---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Live voice for embedded chats. `createSessionProxyHandler` now forwards the realtime model catalog and the live voice call routes (begin, connect, heartbeat, end, activate, transcript sync) as the resolved end user, with Opengeni's usual `sessions:control` and call-ownership checks; `beforeForwardMessage` sees voice start and transcript saves as `delivery: "realtime"`, and `realtimeVoice: false` turns it off. The stock `OpenGeniChat` composer shows the live voice button when the workspace offers an available voice model.
