---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Opengeni no longer pays for two Nango connections for the same account. When a person connects the same verified account to the same Nango integration in several organizations, every organization's row now points at one shared Nango connection, and that connection is deleted in Nango only when the last row referencing it is gone. Reconnects, refused or failed connect attempts and disconnects release the replaced connection through the same reference check, and the worker now sweeps Nango every 15 minutes: it merges leftover duplicates, deletes abandoned and cascade-orphaned connections, and deletes connections whose refresh has failed for 24 hours. Disconnecting a Nango-managed Google app still does not revoke the grant at Google, because Nango's OAuth client is shared across the person's connections.
