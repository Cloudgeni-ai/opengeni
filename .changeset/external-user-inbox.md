---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

External users have an inbox. A product's own users (external actors resolved through its organization key) now receive their sessions' questions, approvals, paused goals and agent notifications in an Opengeni inbox, as members do, and `notify_user` delivers to them instead of reporting `no_human_recipient`. `createSessionProxyHandler` relays the user's own inbox: `GET /v1/inbox` and `PATCH /v1/inbox/items/{id}` limited to the resolved workspace, and `GET`/`PUT /v1/inbox/settings`, so the stock app shows it behind a product's sign-in. `PATCH /v1/inbox/items/{id}` accepts `workspaceId` to act only on an item in that workspace. Phone pushes still need an Opengeni native-app sign-in.
