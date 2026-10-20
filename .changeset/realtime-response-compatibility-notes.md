---
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

Document the realtime WebSocket response compatibility boundary. Negotiation responses, including the legacy Gateway and SuperGrok route aliases, now include `protocol` (the wire dialect), `protocols` (WebSocket subprotocols), and `sessionUpdate` (the initial client event, or `null` when the mint already configured the session). Consumers must handle nullable `sessionUpdate` rather than always sending an event.

Older exported strict response validators reject the added fields. Update custom validators to the current response contract, including these fields and their allowed values; retaining a legacy route or method name does not make its response satisfy the old strict schema. Controlled tests of the old official SDK handshake accepted the added metadata because those methods do not apply that strict response parser. This is not a guarantee for every cached or third-party client, live audio, or deployed authentication path.

New clients require a compatible server. The new SDK requests `/realtime/websocket` without a 404 downgrade, and the new transport still requires the new response metadata when using an older negotiation method. Serve new client assets only with compatible server responses; rolling back the server while new clients remain loaded is not a qualified compatibility path.

The bounded consumer audit found no known incompatible production consumer, not zero usage: historical Gateway counters exist, callers remain unidentified, and deployed client bundles were not proven. Validate your own consumers before upgrading.

Published Site embedded chat remains HTTP/SSE. Site voice was already unsupported and is outside this release's scope; this change does not add Site voice or a Site WebSocket proxy.

This is a documentation-only clarification. It does not change the transport-kind behavior or settle the separate release-version decision for that change.
