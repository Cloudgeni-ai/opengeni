# Backend chat quickstart

A server-only example of `createChatHandler` from `@opengeni/sdk/chat`.
There is no bundled chat frontend. For the full React agent experience, use
the existing `SessionConversation`, or compose `MessageTimeline` and
`ChatComposer` with the normal session SDK and your authenticated backend.
Those components do not consume this simplified chat-handler protocol.

## Run

```bash
cd examples/chat-quickstart
cp .env.example .env.local
# Set OPENGENI_API_KEY (a full-access organization key) and OPENGENI_ORGANIZATION_ID.
bun run onboard u_42
bun run server
```

`bun run onboard u_42` creates the demo tenant's workspace and makes the
product user `u_42` a member with the permissions the chat needs
(`CHAT_USER_PERMISSIONS` in `quickstart.ts`). Chat requests never grant
workspace membership, so without this step the API answers `403`. A real
product runs the same `onboardChatUser` call once, when it admits a user to a
tenant, not on every message. The command prints its operation id before
calling; after an uncertain result, retry with `bun run onboard u_42 <that id>`.

Send a message with the demo-only identity header:

```bash
curl -N http://127.0.0.1:4200/api/chat \
  -H 'Content-Type: application/json' \
  -H 'x-demo-user: u_42' \
  -H 'x-opengeni-conversation: c_1' \
  -d '{"message":"Hello"}'
```

This executes an agent and may incur usage charges. `GET /api/chat` with the
same headers restores history and pending decisions; `POST /api/chat/respond`
answers a pending decision. Replace the spoofable demo identity header with
real server-side authentication before exposing this server to other users;
it listens on 127.0.0.1 only.

Conversation ids are not namespaced per user: OpenGeni authorization decides
who may open a conversation, so a real product also checks that the
authenticated user may use the conversation id the page sends.

## Wire formats

The handler streams native chat chunks by default. It also supports the
existing `vercel`, `openai-chat`, and `openai-responses` adapters. These are
partial chat-protocol adapters, not full SDK or tool-result parity. See the
[product integration guide](../../docs/product-integration.md).
