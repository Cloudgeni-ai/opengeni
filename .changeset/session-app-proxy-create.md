---
"@opengeni/sdk": patch
---

The session proxy creates chats from the packaged session app. With `sessionApp: true`, a new chat no longer fails with "visibility cannot be set from the browser": the proxy takes the app's first-message id and new-chat draft revision, drops the `visibility` and empty `connectionAccounts` it sends (the server chooses both), and still refuses any other configuration. A browser `modelContext` on create (such as an Excel selection) is now appended after the server's context, as on follow-up messages.
