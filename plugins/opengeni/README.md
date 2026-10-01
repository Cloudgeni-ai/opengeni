# OpenGeni for your coding agent

This plugin connects a local coding agent (Claude Code, Codex, Cursor) to an
OpenGeni workspace:

- **Workspace MCP server**: `<origin>/v1/workspaces/<workspaceId>/mcp`, signed
  in with standard MCP OAuth (dynamic client registration, PKCE, scope
  `mcp:access`). No API key is stored on your machine.
- **`offload-to-opengeni` Skill**: when you ask to run something in the cloud,
  in the background, or on OpenGeni, the agent writes a self-contained brief,
  creates a session, gives you its link, checks status, fetches results, and
  sends follow-ups.
- **`build-with-opengeni` Skill**: guidance for adding OpenGeni agents to your
  own product with `@opengeni/sdk` and `@opengeni/react`, including a hello
  world. `opengeni-client/` beside it is a generated copy of the canonical
  integration guide in `.agents/skills/opengeni-client`; run
  `bun run sync:client-skill` after changing the canonical guide.

User documentation: https://docs.opengeni.ai/guides/coding-agents

## Before you start

1. Open the workspace you want to use in OpenGeni. Its ID is the UUID after
   `/workspaces/` in the address bar. Sessions you start from your coding agent
   run there and use that workspace's repositories, connections, and billing.
2. The deployment must have workspace MCP OAuth enabled. On a self-hosted
   deployment set `OPENGENI_MCP_OAUTH_ENABLED=true` and `OPENGENI_PUBLIC_BASE_URL`
   (see `docs/deployment.md#workspace-mcp-oauth`).

Your MCP URL is `<origin>/v1/workspaces/<workspaceId>/mcp`, for example
`https://app.opengeni.ai/v1/workspaces/<workspaceId>/mcp`.

## Claude Code

```bash
claude plugin marketplace add Cloudgeni-ai/opengeni --sparse .claude-plugin plugins
claude plugin install opengeni@opengeni --config workspace_id=<workspaceId>
```

Add `--config base_url=https://<your-deployment>` for a deployment other than
`https://app.opengeni.ai`. Inside a session the equivalents are
`/plugin marketplace add Cloudgeni-ai/opengeni` and
`/plugin install opengeni@opengeni`, which prompt for the two values.

Sign in to OpenGeni in your default browser first; the consent page needs that
session. Then run `/mcp`, select `plugin:opengeni:opengeni`, and sign in. On a machine
without a browser, run `claude mcp login --no-browser plugin:opengeni:opengeni`
and paste the redirect URL back. On the consent page, choose the same workspace
as in the URL.

Without the plugin, add only the server:
`claude mcp add --transport http opengeni <MCP URL>`.

## Codex

```bash
codex mcp add opengeni --url <MCP URL>
```

Codex detects OAuth and opens the sign-in page; `codex mcp login opengeni`
signs in again later. For the Skills, install this plugin
(`codex plugin marketplace add Cloudgeni-ai/opengeni` and
`codex plugin add opengeni@opengeni`) or copy the two folders under `skills/`
into `~/.agents/skills/` or your repository's `.agents/skills/`. Run the
`codex mcp add` command either way: Codex does not fill in the plugin's
workspace setting, and your `opengeni` server replaces the plugin's
placeholder.

## Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(one project):

```json
{
  "mcpServers": {
    "opengeni": { "url": "<MCP URL>" }
  }
}
```

Sign in from Cursor Settings → MCP. Copy the folders under `skills/` into
`~/.cursor/skills/` or your repository's `.cursor/skills/` or `.agents/skills/`.

## Tool names

The server publishes tools as `opengeni__<tool>`, for example
`opengeni__session_create`. Clients add a prefix: Claude Code shows
`mcp__plugin_opengeni_opengeni__opengeni__session_create` for the plugin
server. The endpoint rejects workspace API keys, so sign in with OAuth; the
OAuth token works only on the MCP endpoint, never on the REST API.

## Maintaining this plugin

- `.claude-plugin/marketplace.json` at the repository root lists this plugin;
  Claude Code and Codex both read it.
- Bump `version` in `.claude-plugin/plugin.json` when the plugin changes;
  installed copies update only on a new version.
- Run `claude plugin validate .` from the repository root and
  `bun test scripts/agent-plugin.test.ts`.
