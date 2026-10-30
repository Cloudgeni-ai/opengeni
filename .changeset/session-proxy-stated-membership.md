---
"@opengeni/sdk": minor
---

The session proxy's `resolve` can return `membership: { permissions }`. Every forwarded request then runs as `asUser(user, { source, membership })`, so the user's grant in the workspace matches the stated permissions, as with a server-side `asUser` client. Without it, the stored grant applies as before.
