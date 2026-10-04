---
name: opengeni-client
audience: integration-agent
description: >-
  Add Opengeni agents to a product: the packaged chat UI behind one server
  route, workspaces per tenant or user, the product's own tools with per-user
  auth and approvals, background agents, and verification. Use when integrating
  Opengeni into a website, backend, or app. Not for changing Opengeni itself.
---

# Opengeni client

The product keeps its users, auth, and UI. Opengeni runs the agent: sessions,
tools, approvals, and history. The browser talks only to the product's server,
and the server talks to Opengeni with an organization API key that never leaves
it.

No organization or key yet? Do
[Opengeni developer setup](https://docs.opengeni.ai/guides/developer-plugin)
first, then come back.

The installed `@opengeni/sdk` and `@opengeni/react` types are authoritative.
Without the repository, read https://docs.opengeni.ai/llms.txt. The tenancy
model is specified in
[product-integration.md](https://github.com/Cloudgeni-ai/opengeni/blob/main/docs/product-integration.md).

## Decide

1. Inspect the repository: framework, auth, how users and teams are modeled,
   any existing chat UI, package manager, tests.
2. Ask the user only what the request and repository leave open, in one short
   message, with a recommendation:
   - Is each chat private to the person who started it, or shared with their
     team? (Recommend private.)
   - May the agent change data, and which actions need approval? (Recommend:
     approve every write.)
3. Pick the shape:
   - React frontend: the default below.
   - An existing chat UI to keep, an assistant bound to one record, or a
     custom layout: [Existing chat UI](references/existing-chat-ui.md).
   - A non-JavaScript backend: keep the React UI and implement the
     [proxy contract](https://docs.opengeni.ai/integrate/proxy-from-any-backend).
   - Scheduled work, or chats created by the server:
     [Background agents](references/background-agents.md).

Decide local mechanics yourself (ports, test users, tunnels). Do not push,
merge, or deploy without the user's permission.

## Default integration

Install `@opengeni/sdk` and `@opengeni/react` at the same version. Put
`OPENGENI_API_KEY` in the server's git-ignored env. Self-hosted deployments
also pass `baseUrl: process.env.OPENGENI_API_BASE_URL`.

Server, one catch-all route at `/api/opengeni/*` (Next.js App Router shown):

```ts
// app/api/opengeni/[...path]/route.ts
import { OpenGeni } from "@opengeni/sdk/chat";
import { createSessionProxyRoute } from "@opengeni/sdk/next";

const og = new OpenGeni({ apiKey: process.env.OPENGENI_API_KEY! });

export const dynamic = "force-dynamic";
export const { GET, POST, PUT, PATCH, DELETE } = createSessionProxyRoute(og, {
  resolve: async (request) => {
    const user = await getSignedInUser(request); // the product's own auth
    if (!user) return new Response("Unauthorized", { status: 401 });
    return { user: user.id, tenant: user.teamId };
  },
  createSession: ({ initialMessage, idempotencyKey }) => ({
    initialMessage,
    idempotencyKey,
    agent: { identity: "You are Acme's assistant. Friendly and brief.", capabilities: "none" },
    sandboxBackend: "none", // chat and tools only; turns start in seconds
  }),
});
```

Other servers: build `const handler = createSessionProxyHandler(og, options)`
from `@opengeni/sdk/session-proxy` with the same options, then mount
`toNodeMiddleware(handler)` from `@opengeni/sdk/express` (before any body
parser), `toHonoHandler(handler)` from `@opengeni/sdk/hono`, or call
`handler(request)` on any web-standard server.

Browser:

```tsx
import { OpenGeniChat } from "@opengeni/react/session-ui";
import "@opengeni/react/compiled.css";

<OpenGeniChat baseUrl="/api/opengeni" />;
```

`OpenGeniChat` is the user's chat list plus the conversation, with streaming,
approvals, questions, and attachments. It needs no provider or workspace id:
the proxy tells it which workspace the user is in. Importing from `session-ui`
instead of the package root avoids pulling in optional heavy peers. Brand it
with `--og-*` CSS tokens.

### Who sees what

| `resolve` returns       | Workspace      |
| ----------------------- | -------------- |
| `{ user, tenant }`      | one per tenant |
| `{ user }`              | one per user   |
| `{ user, workspaceId }` | yours          |

Workspaces and memberships are created on first use (the key needs
`members:manage`, which full-access keys have). To remove a user, stop
resolving them. Chats are private to the user who started them;
`chats: "shared"` on the handler shares them with the workspace. A tenant is
the product's team, organization, or customer: the group that shares data and
tools. Derive `user` and `tenant` from the product's session, never from the
request body or path. Server-side code gets the same workspace with
`og.workspaceId({ tenant })` or `og.workspaceId({ user })`.

### The agent

The browser sends only the first message; `createSession` decides the rest:
`agent.identity` (who it is), `agent.capabilities` (`"none"` for product tools
only, `"all"`, or a mix), `agent.instructions`, inline product `skills`, and
`sandboxBackend`. See [Configure the agent](references/configure-the-agent.md).
Per-message facts such as today's date or the current page go in
`beforeForwardMessage: () => ({ modelContext })`, not in instructions.

### The product's tools

Expose the product's data as an MCP endpoint that acts as the signed-in user:

```ts
createSessionProxyRoute(og, {
  resolve,
  createSession,
  toolServer: { approvals: { ask: ["update_ticket"] } }, // every write tool
});
```

The proxy attaches the endpoint at `OPENGENI_TOOL_SERVER_URL` (public HTTPS)
to each chat with a short-lived per-user token. The endpoint calls
`verifyToolRequest(request)` from `@opengeni/sdk/tool-auth` and scopes every
query to the returned `user` and `tenant`. The user approves each call to a tool
in `approvals.ask`. See [Tools and auth](references/tools-and-auth.md).

## Verify

1. The product's typecheck, build, and tests pass.
2. Signed out, `/api/opengeni/...` returns 401.
3. Signed in, a real product question streams a useful answer, and the chat is
   still there after reload.
4. A question that needs a product tool calls it with the right user's data; a
   write asks for approval first.
5. A second user, and a user in another tenant, cannot see the first user's
   chats or data.

To see which models a workspace can use, call
`GET /v1/config/client?workspaceId=<id>` with the key. Without `workspaceId`, an
organization key sees no models and an "unavailable" fallback; that is expected,
not a blocked model. A real chat turn is the true test.

Locally, Opengeni must reach the tool endpoint over public HTTPS. Never tunnel
the whole app (that publishes every page, including sign-in and admin): run the
tool-only forwarder from
[Tools and auth](references/tools-and-auth.md#local-development), tunnel only
its port, set `OPENGENI_TOOL_SERVER_URL` to the tunnel URL plus the tool path,
and tell the user.

Before production, and for the handoff, read the
[Production checklist](references/production-checklist.md).

## Rules

- The API key is used only by the server (the proxy); it never goes in browser
  code.
- Never replace the proxy with a raw passthrough to the Opengeni API.
- Keep every `@opengeni/*` package at one version. The SDK is ESM-only; from
  CommonJS, use `await import("@opengeni/sdk")`.
- With cookie auth, pass the product's CSRF check as `authorizeMutation`.
- This skill guides the coding agent. Do not add it to the product agent's
  skills.

## Advanced

Products that provision workspaces and members themselves can still use
`ensureWorkspace`, `addExternalWorkspaceMember`, and `asUser`; see the
[Production checklist](references/production-checklist.md#explicit-provisioning).
