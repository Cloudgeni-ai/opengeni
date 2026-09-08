# Chat quickstart

The smallest OpenGeni integration: one server file with `createChatHandler`
from `@opengeni/sdk/chat`, one page with `OpenGeniChat` from
`@opengeni/react/chat`. No OpenGeni routes are proxied and no SDK client runs in
the browser.

What you see: a chat box. Each message goes to `/api/chat`, the backend maps the
demo tenant to one organization workspace (created on the first message) and
the `conversation` query parameter, scoped to the signed-in user, to one
session, and the reply streams back. Reload the page and the conversation comes
back (`GET /api/chat`). Open `/?conversation=c_2` for a second, isolated chat.
The demo user is the `x-demo-user` header the page sends; the backend treats it
as the signed-in user, so the agent remembers that user across their chats
(`memory: "user"`) while each chat stays isolated from every other chat
(`agentAccess: "session"`), and a conversation id only ever reaches that
user's own sessions.

## Run

Requirements: Bun and an organization API key for your organization on
[app.opengeni.ai](https://app.opengeni.ai) (Organization settings, API keys).

```bash
cd examples/chat-quickstart
cp .env.example .env.local
# Set OPENGENI_API_KEY and OPENGENI_ORGANIZATION_ID.
bun run server
```

In a second terminal:

```bash
bun run dev
```

Open http://127.0.0.1:3102.

## Swap the wire format

`createChatHandler` streams native chunks by default. Pass `format: "vercel"`
to serve an existing Vercel AI SDK `useChat` client unchanged, or
`format: "openai-chat"` / `format: "openai-responses"` for an OpenAI-shaped
client. See the [product integration guide](../../docs/product-integration.md).
