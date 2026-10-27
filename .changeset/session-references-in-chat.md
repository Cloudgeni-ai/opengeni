---
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/runtime": patch
---

Agents can link another chat as `[title](session:<sessionId>)`. `parseOpenGeniLink` returns a `session` target and `openGeniConsolePath` maps it to the chat's console route. A link resolver may now return `{ href, open }`: a plain click runs `open` in place while modified clicks keep the browser's handling of `href`. The console opens chat references in place, and a reference no host resolves shows just its title.
