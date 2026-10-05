---
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Embedded chats no longer carry Opengeni's own defaults into your product. In `SessionConversation` and `OpenGeniChat`, live voice is now opt-in (`realtimeVoice={true}`, or `createSessionProxyHandler({ realtimeVoice: true })`, which now reports `realtimeVoice: true` in the client config), so a call never spends credits or asks for the microphone unless you turn it on. The working indicator says "Thinking…" instead of the console's playful phrases; the new `genieLoading` prop sets your own copy or visual. The session proxy accepts `visitor: true` from `resolve` for anonymous visitors: they get no attach button and their uploads are refused unless the handler sets `visitorUploads: true`. A proxy with `files: false` now also reports uploads off, so the stock composer hides the attach button it could not serve. Explicit `realtimeVoice`, `attachments`, and `files` settings keep working; the Opengeni web app is unchanged.
