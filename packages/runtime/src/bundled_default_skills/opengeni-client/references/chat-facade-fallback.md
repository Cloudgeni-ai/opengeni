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

const og = new OpenGeni({ apiKey: OPENGENI_API_KEY, organizationId: OPENGENI_ORGANIZATION_ID });

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
old user-namespaced helper. The facade defaults to `agentAccess: "session"` and
`memory: false`. The adapters send only the latest user message and import
earlier messages once as first-message context; afterwards OpenGeni owns the
history. They run in the customer's backend: they do not add `/responses` or
`/chat/completions` to the OpenGeni service. See
[Compatibility and troubleshooting](compatibility-and-troubleshooting.md) and
`examples/chat-quickstart`.
