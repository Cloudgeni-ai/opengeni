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
5. MCP tools read and mutate the same ticket data used by the human workflow
   (each browser's own copy; see [Anonymous visitors](#anonymous-visitors)).
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

Requirements: Bun, an organization API key for a shared organization
workspace used only by the demo, and a public HTTPS tunnel for the MCP
endpoint.

The server acts through `asUser` and onboards the demo operator with
`addExternalWorkspaceMember`, so a workspace API key does not work. Use an
organization key on an **Admin** service account (`members:manage` is
admin-only) with **Access: Custom** granting exactly these permissions, and
**Available in: Only selected workspaces** set to the demo workspace:

| Permission           | Used for                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `members:manage`     | Onboarding the demo operator (`addExternalWorkspaceMember`); key only      |
| `workspace:read`     | The operator reading the workspace and its live-control stream             |
| `sessions:create`    | The operator creating each run (`POST /api/demo/sessions`)                 |
| `sessions:read`      | Session reads, the event history, and the event stream                     |
| `sessions:control`   | Send, steer, queue, composer draft, pause and resume, and approval answers |
| `mcp_servers:attach` | Creating sessions that carry the per-session Northstar MCP server          |

The key needs nothing else: no `files:*` (uploads are off), no
`workspace:admin`, and no organization-level permission. An `asUser` request
holds only the permissions both the key and the operator's membership hold, so
the server grants the fixed demo operator (`maya.chen`, source
`northstar-demo`) the same list without `members:manage`. An operator
onboarded earlier with a different permission set keeps that membership:
onboarding never overwrites permissions. The sessions are private, which needs
the organization's private-session setting (on unless an owner or admin turned
it off).

Set a workspace budget on the demo workspace: it is the hard spend cap for
anonymous visitors. When the Opengeni server also accepts per-task usage limits
(`OPENGENI_SESSION_USAGE_LIMITS_ENABLED=true`, reported as
`sessionUsageLimits.enabled` by `GET /v1/config/client`), each run additionally
carries a $1.00 usage limit. When it does not, runs start without one;
Opengeni refuses a limit while the setting is off, so the demo never sends
one then. The server rereads the setting at most once a minute (15 seconds
after a failed read), and a start refused because the setting was just turned
off continues without the limit. Either way `GET /api/demo/health` answers 200;
`ok` says whether runs can start (credentials, MCP token, and public MCP URL
are configured), and `sessionUsageLimitsEnabled` (true, false, or null when
unreadable) is informational.

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
decides which of that operator's sessions, and which copy of the product data,
each browser and its agent may use:

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
- **Own product data.** Every visitor starts from the same frozen, read-only
  seed tickets and gets its own copy on its first change (a ticket edit, note,
  or reply, or one of its agent's tool calls). `/api/demo/state`, the product
  update stream `/api/demo/events`, Reset, and the four MCP tools read and
  change only the caller's copy, so one visitor's notes, ticket edits, and
  Reset never reach another visitor's page or agent (and text one visitor
  writes cannot become another visitor's agent input). The server keeps up to
  200 changed copies; the least recently active one starts over from the seed
  first, and its open pages are told to refetch. Each ticket keeps only its
  newest 50 notes, replies, and activity entries.
- **Agent tools bound to the visitor.** Besides the shared bearer token
  (`OPENGENI_DEMO_MCP_TOKEN`), each session's MCP server carries an
  `X-Northstar-Visitor` header that this server sets when it creates the
  session: the visitor id, signed with the per-process key for this purpose
  only. Opengeni stores MCP headers encrypted and never returns their values,
  and the proxy refuses browser credential rotations (`mcpCredentialUpdates`),
  so neither the browser nor the model can change it. `/mcp` answers 401
  without the bearer token and 403 without a valid binding (missing, forged, a
  cookie value, or signed before a restart), then gives the tools only that
  visitor's data.
- **Narrow sessions.** Sessions are created `visibility: "private"`,
  `agentAccess: "session"`, and `memoryScope: "off"`, with only the Northstar
  MCP server, no first-party tools, no sandbox, no model fields (the
  workspace's default model applies), and, when the Opengeni server accepts
  per-task usage limits, a $1.00 usage limit (`usageLimitMicros`) that the
  browser cannot raise. The agent starts from
  `capabilities: { from: "none", skills: false }` with no bundled Skills: it
  can use its Northstar tools and ask the visitor for input, but cannot read,
  save, install, or remove Skills (which would change every other visitor's
  agent), search or fetch the web, generate media, resolve secrets, start
  subagents, or use Knowledge, schedules, or workspace tools. As a further
  safeguard, set the demo workspace's Agent learning (Knowledge, Instructions,
  Skills) to Off.
- **Closed proxy surfaces.** Browser session creation, the session list,
  archive, model selection, files and uploads, voice input, realtime voice,
  sandbox files, artifacts, and Sites are all off. A browser can change only
  the sessions it started: workspace-level writes (such as resuming a paused
  workspace) are refused. Mutations must be same-origin and come from an
  established visitor (`authorizeMutation`). Request bodies are limited to
  32 KiB on the proxy and the demo API, and to 64 KiB for every request the
  server accepts, MCP calls included.
- **Rate limits.** Each action is limited per visitor, per client network, and
  across the demo, and only valid requests count, so a burst of malformed
  starts cannot use up anyone's allowance:

  | Action                                                         | Per visitor | Per client network | Whole demo   |
  | -------------------------------------------------------------- | ----------- | ------------------ | ------------ |
  | Agent runs (`POST /api/demo/sessions`)                         | 6 / 10 min  | 10 / hour          | 30 / hour    |
  | Messages (send, steer, draft submit, approval or input answer) | 20 / 10 min | 40 / 10 min        | 200 / 10 min |
  | Every forwarded session write (also draft saves and controls)  | 60 / min    | 120 / min          | 600 / min    |
  | Proxied reads (config, workspace, own sessions, stream opens)  | 300 / min   | 600 / min          | 3,000 / min  |
  | Ticket edits, notes, and replies                               | 20 / min    | 40 / min           | 120 / min    |
  | Resets                                                         | 5 / min     | 10 / min           | 30 / min     |
  | Open agent event streams (concurrent)                          | 8           | 24                 | 200          |
  | Open product update streams (concurrent)                       | 4           | 24                 | 200          |

  A refusal is a 429 with `Retry-After`. The limits apply to the single-origin
  server (`PORT` set, as in the container); `bun run server` for local
  development listens on loopback only and skips them. Every write, the product update
  stream, and the workspace live stream need an established visitor cookie, so
  dropping the cookie never buys a fresh per-visitor allowance. Other proxied
  reads do not (the page's first config read sets the cookie), so a cookie-less
  read counts as a new visitor and the per-network and demo-wide limits bound
  it. Reads and writes of a session the visitor did not start are refused
  without calling Opengeni and never count. A client
  network is an IPv4 address or an IPv6 /64. By default it is the socket
  peer's; behind a reverse proxy, set `OPENGENI_DEMO_CLIENT_IP_HEADER` to a
  header the proxy overwrites with the client address, or every visitor shares
  the proxy's address and the per-network limits act as a smaller demo-wide
  cap. For ingress-nginx, as in the hosted demo, use `x-real-ip`: nginx sets
  it to the TCP peer, which is the real client with
  `externalTrafficPolicy: Local`, and a client cannot spoof it. Never name a
  header the client can set itself (such as `X-Forwarded-For` behind a proxy
  that appends to it); for a single list header, the last entry is used. A
  request without the configured header falls back to the socket peer. Tune
  the constants at the top of `src/server.ts`.

Visitor state (the cookie key, session ownership, and the product data copies)
lives in memory, so run one replica; a restart starts every visitor over. The
workspace live-control stream the provider subscribes to is open to every
established visitor because the panel refreshes session state from it; its
events carry only pause and resume facts (a session id, action, actor, and
bounded reason) that `authorizeSession` makes useless to anyone but the
session's owner.

## What to inspect

- `src/server.ts`: explicit onboarding, server-side session creation, the
  packaged session proxy, MCP tools, dummy domain data, and product SSE.
- `src/visitors.ts`, `src/visitor-state.ts`, and `src/rate-limit.ts`:
  anonymous visitor isolation (cookies, session ownership, MCP bindings, and
  per-visitor product data) and abuse limits.
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
