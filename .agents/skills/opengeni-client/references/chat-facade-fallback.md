# Chat facade fallback: `@opengeni/sdk/chat`

This is not the default integration. Use it only when:

- the product already has a chat UI speaking Vercel `useChat` or an
  OpenAI-shaped protocol (Chat Completions or Responses) and wants a
  compatible drop-in backend while reusing that UI; or
- a server-side bot or automation needs text replies through
  `og.chat(...).send()`.

State its limits to the user before choosing it. It is a text-only projection
of the session: tool outputs are dropped (the Vercel adapter emits only
`output: { status }`); there are no files, attachments, artifacts, or images;
there is no goals, queue, or steer UI; and reopening a conversation restores
only a text snapshot. When any of those matter, use the default
`SessionConversation` embed behind `createSessionProxyHandler`, or graduate to
`og.client` (`OpenGeniClient`) on the same `chat.sessionId`.

## Setup

When using `user`, first provision that user's approved workspace membership
through the explicit onboarding flow in
[External users and embedded connection setup](external-users-and-connect.md).
The facade uses `asUser()` and never grants or restores membership on a chat
request. An existing tenant is not proof that this user belongs to it.

```ts
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new OpenGeni({
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
});

export const POST = createChatHandler(og, {
  // Your auth hook. Tenant and user come from the authenticated request, never the body.
  resolve: async (request) => {
    const me = await authenticate(request);
    return me ? { tenant: me.accountId, user: me.userId } : new Response("Unauthorized", { status: 401 });
  },
  // format: "vercel" keeps an existing useChat client; "openai-chat" / "openai-responses"
  // keep an OpenAI-shaped client. The default streams native chunks for custom clients.
});

// Server-side use without an endpoint:
const chat = await og.chat({ tenant: "acme", user: "u_42", conversation: "c_9" });
const reply = await chat.send("hello"); // reply.text; chat.stream(...) yields chunks
```

Every customer gets one workspace (`tenant`), every conversation one
deterministic session. Conversation IDs are independent of the acting user;
ordinary API authorization decides who can use a shared conversation, so use the
same OpenGeni session ID for shared conversations. Without a `user`, `resolve`
must return the `conversation` itself. Use `chatBySessionId` to reopen
historical sessions whose IDs were derived with the old user-namespaced helper.
The Vercel and OpenAI adapters send only the latest user message and import
earlier messages once as context on the first message; afterwards OpenGeni owns
the history. Reset private UI state and cancel old requests when the
authenticated user or tenant changes.

## Isolation per session

| Scenario | `agentAccess` | `memory` |
| --- | --- | --- |
| Support desk: agent confined to its chat tree | `"session"` (default) | `false` (default) |
| Agents restricted to their canonical user's chats | `"user"` with `asUser()` | `"user"` |
| A team collaborating across chats | `"workspace"` | `"workspace"` |
| Any of the above with Knowledge authoring initially Off | any | `false` |

`agentAccess` is enforced in the server-side session-authorization seam for
agents as outbound task scope: own tree, same canonical user, or workspace. A
narrow target remains reachable by an authorized broad coordinator; target
private visibility and normal permissions still apply. `asUser()` establishes
canonical authority, not a second end-user label. The `examples/chat-quickstart`
directory provides a backend-only server example.

The adapters run in the customer's backend and talk to the OpenGeni session
API; they do not add `/responses` or `/chat/completions` routes to the OpenGeni
service. See [Compatibility and troubleshooting](compatibility-and-troubleshooting.md).
