---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

An organization key acting as an external user can now state that user's workspace membership on each request: `asUser(id, { source, membership: { permissions } })`, or `membership` in the `x-opengeni-external-actor` value. Opengeni makes the stored grant in the request's shared workspace exactly those permissions before authorizing the request. It creates a missing member, writes only when the grant differs, and applies the external-members ceiling and last-administrator rules with their errors. Removing the member wins over requests already in flight. Without `membership`, the stored grant applies as before.
