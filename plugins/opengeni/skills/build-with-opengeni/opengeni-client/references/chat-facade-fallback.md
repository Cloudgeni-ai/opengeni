# Chat facade fallback: `@opengeni/sdk/chat`

Not the default. Use it only when the product already has a chat UI speaking
Vercel `useChat` or an OpenAI-shaped protocol and wants a compatible drop-in
backend that reuses that UI, or when a server-side bot needs
`og.chat(...).send()`. State its limits first: it is a text-only projection.
Tool outputs are dropped (the Vercel adapter emits only `output: { status }`);
there are no files, attachments, artifacts, or images; there is no goals,
queue, or steer UI; and reopening restores only a text snapshot. When any of
that matters, use the default `SessionConversation` embed, or graduate to
`og.client` on the same `chat.sessionId`.

Before using `user`, provision the user's workspace membership through the
explicit onboarding in [External users](external-users-and-connect.md); the
facade uses `asUser()` and never grants or restores membership.

```ts
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new OpenGeni({
  baseUrl: process.env.OPENGENI_API_BASE_URL!, // omitted = production app.opengeni.ai
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
});

export const POST = createChatHandler(og, {
  // Tenant and user come from the authenticated request, never the body.
  resolve: async (request) => {
    const me = await authenticate(request);
    return me ? { tenant: me.accountId, user: me.userId } : new Response("Unauthorized", { status: 401 });
  },
  format: "vercel", // or "openai-chat" / "openai-responses"; default: native chunks
});

const chat = await og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
const reply = await chat.send("hello"); // reply.text; chat.stream(...) yields chunks
```

Each tenant maps to one workspace and each conversation to one deterministic
session. Conversation IDs are independent of the acting user; authorization
decides who may use a shared conversation. Without a `user`, `resolve` must
return the `conversation`. `chatBySessionId` reopens sessions derived with the
old user-namespaced helper. `chats` defaults to `"private"` when a `user` is
given (private visibility, session-only agent reach, the user's personal
Knowledge; pass `memory: false` to keep Knowledge authoring off). Without a
user, omitted `chats` keeps workspace visibility, session-only reach and
Knowledge off; use `chats: "shared"` for service-owned chats. `agent` takes the
same object as sessions, and the facade's renderer defaults to `"markdown"`
(only that implicit default is dropped on a server without agent settings).
`resolve` may return `chats` and `agent` too. See
[Configure the agent](configure-the-agent.md). The adapters send only the
latest user message. Earlier messages from your app are imported only when the
session is first created, as context on its first message; after that OpenGeni
owns the history, and messages your app shows but never sent are not added.
They run in the customer's backend: they do not add `/responses` or
`/chat/completions` to the OpenGeni service. See
[Compatibility and troubleshooting](compatibility-and-troubleshooting.md) and
`examples/chat-quickstart`.
