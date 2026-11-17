---
"@opengeni/api-router": patch
---

Reconnect works again for MCP sign-ins whose catalog domain differs from their server's host, such as Sentry (sentry.io, mcp.sentry.dev) and Stripe (stripe.com, mcp.stripe.com). Connect saves an account under the server's host, while Reconnect on the Capabilities page sent the catalog's domain, and the sign-in start only accepted an exact match, so it answered "connection not found" ("It may have been removed"). Reconnect now signs in to the exact connection it names, for the same server, under the provider domain that connection was saved with; a built-in profile's fixed domain is still required. Turning the connector off and connecting again is no longer needed.
