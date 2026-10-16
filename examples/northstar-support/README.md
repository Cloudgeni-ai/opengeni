# Northstar support agent example

A small fictional customer-support SaaS showing the complete Opengeni
integration as a clear before/after:

1. Open the product with Opengeni off and use it as a small support SaaS:
   search and filter the queue, switch between four tickets, inspect customer
   signals, change fields, add internal notes, and reply.
2. Turn on the frontend-only **Opengeni** switch to embed the agent workspace in
   the same product.
3. The product backend onboards the demo operator as an external workspace
   member, creates each Opengeni session as that user with an explicit tool
   selection and a stable idempotency key, and mounts the SDK's packaged
   `createSessionProxyHandler` at `/api/opengeni/*`. The organization API key
   stays server-side, and the browser can reach only the conversation routes of
   the sessions it started (see [Anonymous visitors](#anonymous-visitors)).
4. Opengeni calls the product's authenticated Streamable HTTP MCP server.
5. MCP tools read and mutate the same ticket data used by the human workflow.
6. Product SSE updates the ticket immediately while Opengeni SSE updates the
   agent timeline independently.
7. The panel is the default embed: `<OpenGeniProvider>` plus
   `<SessionConversation>`, with Northstar tool renderers and Markdown. Runs use
   the workspace's default model; the browser cannot choose another.
8. The panel uses the SDK's `data-og-density="compact"` preset. Typography and
   composer sizing come from public `--og-*` tokens; the demo only supplies
   Northstar colors and product-specific layout.

The demo deliberately exposes four tools over the selected ticket: `get_ticket`,
`get_customer`, `update_ticket`, and `add_internal_note`. Mutations are
pre-approved and idempotent so the full loop is easy to demonstrate.

The example depends on `@opengeni/sdk` and `@opengeni/react` through
`workspace:*`, so a repository checkout always runs against the current SDK and
component source rather than a stale published copy.

## Run against managed Opengeni

Requirements: Bun, an organization API key for the configured shared
organization workspace, and a public HTTPS tunnel for the MCP endpoint.

The server acts through `asUser` and onboards the demo operator with
`addExternalWorkspaceMember`, so a workspace API key does not work. The
organization key needs `workspace:read`, `sessions:create`, `sessions:read`,
`sessions:control`, `mcp_servers:attach`, and `members:manage`; the built-in
full-access scope (which includes `workspace:admin`) also qualifies. The server
grants the fixed demo operator (`maya.chen`, source `northstar-demo`) the same
permissions without `members:manage`; `mcp_servers:attach` is there because its
sessions carry a per-session MCP server. An operator onboarded earlier with a
different permission set keeps that membership: onboarding never overwrites
permissions. The sessions are private, which needs the organization's
private-session setting (on unless an owner or admin turned it off).

```bash
cd examples/northstar-support
cp .env.example .env.local
# Set OPENGENI_WORKSPACE_ID, OPENGENI_API_KEY, and a random MCP token.
bun run server
```

In a second terminal, expose only the MCP port:

```bash
ngrok http 4101
```

In a third terminal:

```bash
cd examples/northstar-support
bun run dev
```

Open <http://127.0.0.1:3101>. If not using ngrok, set
`OPENGENI_DEMO_MCP_URL` to any public HTTPS origin or full `/mcp` endpoint.

## Anonymous visitors

The demo has no login, so it is safe to publish only because the server keeps
anonymous browsers apart. Opengeni sees one demo operator; the product server
decides which of that operator's sessions each browser may use:

- **Visitor cookie.** Every API response issues a browser without a valid
  cookie an opaque random visitor id, signed with an HMAC key generated when
  the process starts. The cookie is `HttpOnly`, `SameSite=Lax`, a browser
  session cookie, and `Secure` with the `__Host-` prefix when the configured
  origin (or the request) is https. A missing, forged, or pre-restart cookie
  means a fresh visitor that owns nothing.
- **Session ownership.** `POST /api/demo/sessions` records which visitor
  created each session, and the proxy's `authorizeSession` lets a browser reach
  only those. The proxy runs it before every session-scoped route (read,
  events and stream, send, steer, queue, composer draft, control, goal, human
  input, artifacts, realtime); unknown or foreign ids are a 404. Idempotency
  keys are derived per visitor, so one browser cannot replay another's start.
- **Narrow sessions.** Sessions are created `visibility: "private"`,
  `agentAccess: "session"`, and `memoryScope: "off"`, with only the Northstar
  MCP server, no first-party tools, no sandbox, and a $1.00 usage limit
  (`usageLimitMicros`) that the browser cannot raise.
- **Closed proxy surfaces.** Browser session creation, the session list,
  archive, model selection, files and uploads, voice input, realtime voice,
  sandbox files, artifacts, and Sites are all off. Mutations must be
  same-origin and come from an established visitor (`authorizeMutation`), and
  request bodies are limited to 32 KiB.
- **Rate limits.** Agent runs are limited to 6 per visitor per 10 minutes and
  30 per hour across the demo; resets to 5 per visitor and 30 in total per
  minute. A refusal is a 429 with `Retry-After`. Tune the constants at the top
  of `src/server.ts`.

Visitor state lives in memory, so run one replica. Product data (tickets,
notes, replies, Reset) is the fictional product's shared database: every
visitor sees the same tickets. The workspace live-control stream the provider
subscribes to stays open to every visitor because the panel refreshes session
state from it; its events carry only pause and resume facts (a session id,
action, actor, and bounded reason) that `authorizeSession` makes useless to
anyone but the session's owner.

## What to inspect

- `src/server.ts`: explicit onboarding, server-side session creation, the
  packaged session proxy, MCP tools, dummy domain state, and product SSE.
- `src/visitors.ts` and `src/rate-limit.ts`: anonymous visitor isolation and
  abuse limits.
- `src/support-agent-panel.tsx`: `OpenGeniProvider` + `SessionConversation`.
- `src/support-tool-renderers.tsx`: product-specific rendering of MCP activity.
- `src/use-support-demo.ts`: product SSE plus missed-event reconciliation.

The visitor cookie is a demo stand-in for authentication, not a production auth
template. A real SaaS should authenticate its users in `resolve` (one Opengeni
user per product user), pass its CSRF check as `authorizeMutation`, authorize
each product resource and Opengeni workspace mapping, deploy MCP on its
backend, store secrets in a secret manager, and rate-limit both its session and
tool endpoints with shared storage. See
[`docs/product-integration.md`](../../docs/product-integration.md),
[`docs/session-mcp-servers.md`](../../docs/session-mcp-servers.md), and
[`packages/sdk/README.md`](../../packages/sdk/README.md).
