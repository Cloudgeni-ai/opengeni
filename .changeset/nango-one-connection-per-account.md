---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

One verified account is now one connection, on every backend. Connections record a server-owned `account_identity_key` (the integration and the verified provider account), and the database allows one live connection per organization, owner and key, so a racing or legacy writer can no longer save a second connection to the same account; it fails as "already connected" instead. OAuth MCP logins, Nango connections and provider OAuth connections (personal GitHub and others) set it.

Opengeni also no longer pays for two Nango connections for the same account. When a person connects the same verified account to the same Nango integration in several organizations, every organization's row now points at one shared Nango connection, and that connection is deleted in Nango only when the last row referencing it is gone. Reconnects, refused or failed connect attempts and disconnects release the replaced connection through the same reference check, and the worker now sweeps Nango every 15 minutes: it merges leftover duplicates, deletes abandoned and cascade-orphaned connections, and deletes connections whose refresh has failed for 24 hours. Disconnecting a Nango-managed Google app still does not revoke the grant at Google, because Nango's OAuth client is shared across the person's connections.

Reconnecting the same verified account no longer breaks running turns: the connection keeps its authority generation when the new grant includes every scope it had, so tool calls in a turn accepted before the reconnect no longer fail with "Authentication required". A different account, fewer scopes, a revoke or a status change still end that authority.

While a release rolls out, or after a rollback to an older release, pods of the older release still delete a replaced Nango connection directly; a connection shared by this release can then be revoked in another organization and must be reconnected there.
