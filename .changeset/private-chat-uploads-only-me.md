---
"@opengeni/sdk": patch
"@opengeni/react": patch
---

Files attached in a private embedded chat are now the uploader's own (Only me), as in the Opengeni web app, instead of workspace files. The stock conversation hooks pass the chat's upload scope, and `createSessionProxyHandler` adds `scope: "personal"` to an upload that names no scope unless `chats` is `"shared"`, so older or custom browsers get the same default. An explicit `scope` passes through unchanged, and shared chats keep workspace files. `uploadScopeForSession` is exported for custom layouts that call `useFileAttachments` themselves.
