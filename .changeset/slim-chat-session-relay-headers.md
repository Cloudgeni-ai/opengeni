---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/react-native": minor
---

Keep operator instructions, skill bodies and the full tool catalog out of default
chat session responses through the explicit typed `client.withSessionResponse("chat")` opt-in
and JSON content negotiation on the existing Accept header. SDK defaults and
required Session fields stay unchanged. Console, mobile and packaged chat clients
opt into the compact type. Settings and server-side integrations can explicitly read
the full configuration with `getSessionConfiguration` and session-control authority.
Server-owned session relays refuse browser configuration and model-context reads.

Export `OPENGENI_BROWSER_RESPONSE_HEADERS`, share it between API CORS and the
packaged relay, and warn once when required history response metadata is unreadable.
Cross-origin hosts should use the export for `Access-Control-Expose-Headers`.
