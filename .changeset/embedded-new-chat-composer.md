---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Embedded chat fixes for proxied embeds:

- `OpenGeniChat`'s new-chat composer is now the follow-up composer: file attachments, the model picker when offered, and `conversationProps.composerProps` (custom controls, voice input, copy). The first message's files and explicit model choice reach `createSession`, whose hook input now carries `resources` and, unless `modelSelection: false`, `model`, `reasoningEffort`, and `latencyMode`; the proxy adds those files and applies those choices to the request the hook returns.
- The session proxy forwards voice input (`POST .../transcriptions`) as the resolved user, and reports only one-shot recordings in the client config. `voiceInput: false` reports voice unavailable and refuses the route. Previously the config advertised voice while the route returned 404.
- `OpenGeniChat` and `SessionConversation` in `baseUrl` mode accept `headers` (static or per request) and `fetch` for bearer-token apps, and use a `client` passed alongside `baseUrl` instead of silently dropping it.
