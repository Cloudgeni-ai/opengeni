---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Framework adapters for web-standard handlers such as
`createSessionProxyHandler` and `createChatHandler`: `@opengeni/sdk/next`
(`toNextRouteHandlers`, `createSessionProxyRoute` for an App Router catch-all
route), `@opengeni/sdk/express` (`toNodeMiddleware` for Express, Connect, and
`node:http`, streaming SSE and aborting on disconnect), and
`@opengeni/sdk/hono` (`toHonoHandler`).

The session proxy serves the chat list (`listSessionPage`, limited by default
to the chats the resolved user created; `sessionList: "visible" | false`) and
archive/restore (`archive: false` to disable). `@opengeni/react` adds
`SessionList` and `OpenGeniChat`, a list-plus-conversation experience with a
responsive sidebar/drawer, a new-chat composer, and rename/archive.
