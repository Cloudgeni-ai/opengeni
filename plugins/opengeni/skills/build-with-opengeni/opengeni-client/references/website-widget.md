# Website widget

A chat bubble on a plain HTML/JS site (no React, no build step) whose visitors
are anonymous: a marketing site, docs, or a landing page.

## Server

Mount the text chat handler before any body parser:

```js
import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";
import { toNodeMiddleware } from "@opengeni/sdk/express";

const og = new OpenGeni({ apiKey: process.env.OPENGENI_API_KEY });

const chat = createChatHandler(og, {
  format: "native",
  resolve: (request) => {
    const visitor = visitorIdFromCookie(request.headers.get("cookie"));
    if (!visitor) return new Response("Unauthorized", { status: 401 });
    if (request.method !== "GET" && !sameOrigin(request)) {
      return new Response("Forbidden", { status: 403 });
    }
    return {
      tenant: "website", // one workspace for every visitor
      user: `visitor:${visitor}`, // each visitor sees only their own chat
      conversation: `visitor:${visitor}`, // the chat's address in that workspace
      agent: { identity: "You are Acme's website assistant. Brief and friendly.", capabilities: "none" },
      instructions: "Answer only from these facts: … Reply in plain text, without Markdown.",
      create: { sandboxBackend: "none", reasoningEffort: "low" },
    };
  },
});
app.use("/api/chat", ensureVisitorCookie, toNodeMiddleware(chat)); // before express.json()
```

- Always return a fixed `tenant` for anonymous visitors. `{ user }` alone gives
  every visitor a workspace of their own, which fills the organization with one
  workspace per browser.
- `conversation` addresses one chat inside the workspace, independent of the
  user, so it must differ per visitor. A constant id makes the second visitor's
  first message fail with `SESSION_CREATE_CONFLICT`.
- `ensureVisitorCookie` issues a random id (32 bytes, base64url) in an
  `HttpOnly; SameSite=Lax; Path=/` cookie (`Secure` in production). Never take
  the visitor id from the body, query, or a header the page sets.
- `sameOrigin` compares the request's `Origin` with the site's own origin.
- Put product facts (features, prices) in `instructions`, or give the agent a
  read-only tool. Do not let the model guess them.
- Every visitor spends your organization's credits. Rate-limit `/api/chat` per
  IP and set a member allowance
  (https://docs.opengeni.ai/guides/usage-allowances) before going live.

## Browser

`GET /api/chat` returns `{ messages: [{ role, text }], pending, status }` to
restore the chat after a reload. `POST /api/chat` with `{ "message": "…" }`
streams SSE: `event: chunk` blocks whose JSON is `{ type: "text", text }`
(append), `{ type: "tool", … }`, `{ type: "pending", … }`, or
`{ type: "done", reply }`, and `event: error` on failure. With a bundler,
`parseChatChunkStream(response.body)` from `@opengeni/sdk/chat` reads it.
Without one, a small `fetch` reader that splits on blank lines is enough.

Replies are Markdown unless the instructions say otherwise. Either ask for plain
text (as above) or render Markdown with a sanitizer; never insert reply text as
raw HTML.

Verify: two browsers get separate chats, a reload restores the chat, a
cross-site `POST` is refused, the key is absent from everything under the
public directory, and the organization still has one website workspace.
