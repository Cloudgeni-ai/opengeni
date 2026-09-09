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
# Set OPENGENI_API_KEY and OPENGENI_ORGANIZATION_ID.
bun run server
```

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
real server-side authentication before exposing this server to other users.

The backend's existing user-namespaced conversation addressing and memory
settings are unchanged. It is not an example of shared-chat identity.

## Wire formats

The handler streams native chat chunks by default. It also supports the
existing `vercel`, `openai-chat`, and `openai-responses` adapters. These are
partial chat-protocol adapters, not full SDK or tool-result parity. See the
[product integration guide](../../docs/product-integration.md).