# Existing chat UI and custom layouts

Use `OpenGeniChat` unless one of these applies. Styling alone is not a reason
to replace it: theme it with `--og-*` tokens, `theme`, and `labels`.

## An assistant bound to one record

For a ticket, document, or dashboard with its own conversation, create the
session on the server as the user (see
[Background agents](background-agents.md#a-chat-started-by-the-server)), keep
the session id on the record, and render only the conversation:

```tsx
import { SessionConversation } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

<SessionConversation baseUrl="/api/opengeni" sessionId={ticket.openGeniSessionId} />;
```

Add `authorizeSession(sessionId, context)` to the proxy when the product must
check that this user may open this record's chat.

## A different layout in React

Compose the headless hooks from `@opengeni/react/session` (`useSession`,
`useSessionEvents`, `useTurnQueue`, `useSessionControl`,
`useHumanInputRequests`, `projectPendingApprovals`) with `MessageTimeline` from
`@opengeni/react/session-ui`, behind the same proxy. They handle streaming,
reconnect, replay, queueing, approvals, and questions; do not rebuild those.
Wire Stop to `pauseSession`, which is resumable. `cancelSession` ends the
session for good.

## A chat UI that already speaks Vercel AI SDK or OpenAI

Keep it and point it at `createChatHandler` from `@opengeni/sdk/chat`:

```ts
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new OpenGeni({ apiKey: process.env.OPENGENI_API_KEY! });
export const handler = createChatHandler(og, {
  resolve: async (request) => {
    const user = await getSignedInUser(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    return { tenant: user.teamId, user: user.id, agent: { identity, capabilities: "none" } };
  },
  format: "vercel", // or "openai-chat", "openai-responses", "native"
});
```

Mount it for `GET` (history) and `POST` (messages), including the `/respond`
subpath, which answers approvals and questions. This is a text projection:
tool results, files, artifacts, and the queue do not reach the UI, and a
reopened chat restores only its text. Prefer `OpenGeniChat` when the product
can adopt it.

## A frontend that is not React

Keep the proxy on the server and build the UI natively. The
[Vue conversation recipe](https://github.com/Cloudgeni-ai/opengeni/blob/main/examples/vue-conversation/README.md)
is a runnable starting point.
