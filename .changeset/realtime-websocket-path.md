---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
---

Live voice models reached over a WebSocket (AI Gateway voices and SuperGrok) now share one path. `POST …/realtime/websocket` and `client.negotiateRealtimeWebsocket` return the provider socket URL, its subprotocols, the wire dialect and the complete provider session configuration, and `createRealtimeWebsocketTransportStarter` opens any of them; the browser no longer carries per-provider configuration. `negotiateGatewayRealtime`, `negotiateXaiSubscriptionRealtime` and the two older transport starters keep working and are deprecated. Voice connections also start slightly faster because billing settlement no longer blocks the connection response.
