---
"@opengeni/react": patch
---

The Connect card for an OAuth MCP connector that isn't set up in this workspace yet now offers your one own login for it ("Use it here") even when that login is already turned on here, and for connectors that share one workspace connection by default. Using it sets the connector up for each person's own account and turns the login on here only when it is off, so no new sign-in is needed. "Connect a different account" still asks who can use a new connection where the card would otherwise ask. `useMcpCapabilityConnect` returns a new `connectAnother` action for that button.
