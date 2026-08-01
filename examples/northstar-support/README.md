# Northstar support agent example

A small fictional customer-support SaaS showing the complete OpenGeni
integration as a clear before/after:

1. Open the product with OpenGeni off and use it as a small support SaaS:
   search and filter the queue, switch between four tickets, inspect customer
   signals, change fields, add internal notes, and reply.
2. Turn on the frontend-only **OpenGeni** switch to embed the agent workspace in
   the same product.
3. The product backend creates OpenGeni sessions and proxies workspace-scoped
   API/SSE traffic, keeping the OpenGeni API key server-side.
4. OpenGeni calls the product's authenticated Streamable HTTP MCP server.
5. MCP tools read and mutate the same ticket data used by the human workflow.
6. Product SSE updates the ticket immediately while OpenGeni SSE updates the
   agent timeline independently.

The demo deliberately exposes four tools over the selected ticket: `get_ticket`,
`get_customer`, `update_ticket`, and `add_internal_note`. Mutations are
pre-approved and idempotent so the full loop is easy to demonstrate.

The example depends on `@opengeni/sdk` and `@opengeni/react` through
`workspace:*`, so a repository checkout always runs against the current SDK and
component source rather than a stale published copy.

## Run against managed OpenGeni

Requirements: Bun, an OpenGeni workspace API key, and a public HTTPS tunnel for
the MCP endpoint.

The product API key needs `workspace:read`, `sessions:create`, `sessions:read`,
`sessions:control`, `mcp_servers:attach`, `files:upload`, and `files:read`.
These are workspace capabilities, not browser-origin registrations; file bytes
still travel through short-lived signed storage URLs.

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

## What to inspect

- `src/server.ts`: backend session creation, scoped API proxy, MCP tools, dummy
  domain state, and product SSE.
- `src/support-agent-panel.tsx`: OpenGeni React timeline, status, and composer.
- `src/support-tool-renderers.tsx`: product-specific rendering of MCP activity.
- `src/use-support-demo.ts`: product SSE plus missed-event reconciliation.

This is a local integration example, not a production auth template. A real
SaaS should authenticate its users, authorize each product resource and
OpenGeni workspace mapping, deploy MCP on its backend, store secrets in a secret
manager, and rate-limit both its session and tool endpoints. See
[`docs/embedding.md`](../../docs/embedding.md),
[`docs/session-mcp-servers.md`](../../docs/session-mcp-servers.md), and
[`packages/sdk/README.md`](../../packages/sdk/README.md).
