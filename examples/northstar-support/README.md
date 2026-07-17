# Northstar support agent example

A small fictional SaaS product showing the complete OpenGeni integration:

1. The browser renders product UI plus `@opengeni/react` session components.
2. The product backend creates OpenGeni sessions and proxies workspace-scoped
   API/SSE traffic, keeping the OpenGeni API key server-side.
3. OpenGeni calls the product's authenticated Streamable HTTP MCP server.
4. MCP tools read and mutate product data.
5. Product SSE updates the ticket immediately while OpenGeni SSE updates the
   agent timeline independently.

The demo deliberately exposes four tools over one ticket: `get_ticket`,
`get_customer`, `update_ticket`, and `add_internal_note`. Mutations are
pre-approved and idempotent so the full loop is easy to demonstrate.

## Run against managed OpenGeni

Requirements: Bun, an OpenGeni workspace API key, and a public HTTPS tunnel for
the MCP endpoint.

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
