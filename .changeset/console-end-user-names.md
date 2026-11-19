---
"@opengeni/sdk": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
---

Console shows who your end users are: send `displayName` and `email` with the user (`asUser(id, { displayName, email })`, the session proxy's `resolve`, the chat facade's `userProfile`, or `identity` on `addExternalWorkspaceMember`). They are display details, never the identity; the latest sent wins and an omitted one keeps its value. Console lists name, email and the product's id (on hover, copyable), shows workspace names in full, and searches people and workspace names at every review level.
