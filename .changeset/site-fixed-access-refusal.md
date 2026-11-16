---
"@opengeni/api-router": patch
"@opengeni/react": patch
---

A Site tool on an account with fixed access is refused as unavailable for that account instead of asking to reconnect, and a signed-out integration-platform account in the embeddable accounts list never starts a native sign-in: it reconnects through the host's `onReconnectViaConnector`, or says to sign in again from its connector.
