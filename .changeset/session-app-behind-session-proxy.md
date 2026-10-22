---
"@opengeni/sdk": minor
"@opengeni/react": patch
---

`createSessionProxyHandler` accepts `sessionApp: true`, so the packaged `SessionApp` runs behind a product's session proxy with no Opengeni credential in the browser (`<SessionApp apiBaseUrl="/api/opengeni" …/>`). The app sees only the resolved workspace and the resolved user's access to it. Its other reads in that workspace, and in chats `authorizeSession` admits, pass through as that user, so Opengeni's permissions decide what they see. A short list of the app's own writes passes too: pinning a chat, moving it to a project, managing projects, the new-chat draft and a chat's tool approval settings. Every other write is refused. Rosters, keys, budgets and administration stay closed even for reads. All existing proxy routes keep their rules, including the host's `createSession` and message hooks.

Startup error screens no longer name Opengeni, so a product that embeds the app shows neutral text ("Couldn't start", "Under maintenance").
