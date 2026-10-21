---
"@opengeni/sdk": patch
"@opengeni/react": minor
---

Live voice connects and answers faster. The microphone is requested alongside the begin request, WebSocket voices prepare capture while the provider session is minted, and microphone audio leaves the browser in 20 ms AudioWorklet frames instead of ~170 ms blocks. `prestartSessionRealtime` lets a host start voice for a session it has just created while it navigates; the session view's `useSessionRealtime` adopts that call. A delegated turn's spoken result is fetched as soon as the session reports the turn's outcome rather than on the next one-second sync.
