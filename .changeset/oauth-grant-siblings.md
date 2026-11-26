---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Disconnecting a Google connection (Gmail, Drive, Calendar or a Google Integration) no longer cuts off the same Google account's other connections in other workspaces or organizations. Google ends the whole grant of one account and OAuth client when any one of its tokens is revoked, so a disconnect now ends the grant at the provider only when a deployment-wide check (migration 1591) finds no other live connection that may hold it: same provider, the same or an unknown client, and not provably another account. Otherwise, or while that check is not yet granted to the runtime, the disconnect only destroys Opengeni's stored tokens. The rule is generic for any provider registered as revoking on disconnect, and the check returns only yes or no.

When a refresh of such a provider is refused with `invalid_grant`, every other active connection that provably held the same grant (same token endpoint, the same known client and the same account, saved before the grant was last known alive) is moved to `needs_reauth` with a clear `last_error`, each with its own compare-and-set, so dead siblings stop showing as connected. A connection whose account or client can't be matched, or one reconnected after the grant ended, is left alone. Both checks are created withheld from the runtime role, as new definers must be; a later migration grants them.
