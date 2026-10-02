# OpenGeni for your coding agent

This plugin connects a local coding agent to an OpenGeni workspace. It installs
as a plugin in Claude Code and Codex; Cursor, VS Code (GitHub Copilot), Devin
Desktop (formerly Windsurf), Zed, Gemini CLI, and any other MCP client with
remote HTTP and OAuth use the same MCP server and Skill folders directly.

- **Workspace MCP server**: `<origin>/v1/workspaces/<workspaceId>/mcp`, signed
  in with standard MCP OAuth (dynamic client registration, PKCE, scope
  `mcp:access`). No API key is stored on your machine.
- **`offload-to-opengeni` Skill**: when you ask to run something in the cloud,
  in the background, or on OpenGeni, the agent writes a self-contained brief,
  creates a session, gives you its link, checks status, fetches results, and
  sends follow-ups.
- **`build-with-opengeni` Skill**: guidance for adding OpenGeni agents to your
  own product with `@opengeni/sdk` and `@opengeni/react`, including a hello
  world and a tested recipe for a small local chat app
  (`local-demo-app.md`). `opengeni-client/` beside it is a generated copy of
  the canonical integration guide in `.agents/skills/opengeni-client`; run
  `bun run sync:client-skill` after changing the canonical guide.

The Skills are plain Markdown folders (`SKILL.md` with `name` and `description`
frontmatter, plus linked files), so any agent can use them.

User documentation: https://docs.opengeni.ai/guides/coding-agents

## Before you start

1. Open the workspace you want to use in OpenGeni. Its ID is the UUID after
   `/workspaces/` in the address bar. Sessions you start from your coding agent
   run there and use that workspace's repositories, connections, and billing.
2. The deployment must have workspace MCP OAuth enabled. On a self-hosted
   deployment set `OPENGENI_MCP_OAUTH_ENABLED=true` and `OPENGENI_PUBLIC_BASE_URL`
   (see `docs/deployment.md#workspace-mcp-oauth`).
3. Sign in to OpenGeni in your default browser. Every client below opens an
   OpenGeni consent page there; choose the organization and the same workspace
   as in the URL, and approve.

Your MCP URL is `<origin>/v1/workspaces/<workspaceId>/mcp`, for example
`https://app.opengeni.ai/v1/workspaces/<workspaceId>/mcp`. The snippets below
write it as `<MCP URL>` and name the server `opengeni`.

## Claude Code

```bash
claude plugin marketplace add Cloudgeni-ai/opengeni --sparse .claude-plugin plugins
claude plugin install opengeni@opengeni --config workspace_id=<workspaceId>
```

Add `--config base_url=https://<your-deployment>` for a deployment other than
`https://app.opengeni.ai`. Inside a session the equivalents are
`/plugin marketplace add Cloudgeni-ai/opengeni` and
`/plugin install opengeni@opengeni`, which prompt for the two values.

Run `/mcp`, select `plugin:opengeni:opengeni`, and sign in. On a machine
without a browser, run `claude mcp login --no-browser plugin:opengeni:opengeni`
and paste the redirect URL back.

Without the plugin, add only the server:
`claude mcp add --scope user --transport http opengeni <MCP URL>`.

One connection covers one workspace: the MCP URL contains the workspace ID, and on the sign-in page you approve that same workspace. Sign in to the Opengeni web app in your browser first; a signed-out sign-in shows an error instead of redirecting.

## Codex

```bash
codex mcp add opengeni --url <MCP URL>
```

Codex detects OAuth and opens the sign-in page; `codex mcp login opengeni`
signs in again later. For the Skills, install this plugin
(`codex plugin marketplace add Cloudgeni-ai/opengeni` and
`codex plugin add opengeni@opengeni`) or copy them into `.agents/skills/` (see
[Skills for any agent](#skills-for-any-agent)). Run the `codex mcp add` command
either way: Codex does not fill in the plugin's workspace setting, and your
`opengeni` server replaces the plugin's placeholder.

## Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(one project). Remote servers need only `url`:

```json
{ "mcpServers": { "opengeni": { "url": "<MCP URL>" } } }
```

Cursor registers itself with OpenGeni and asks you to sign in when the server
first connects; in the Cursor CLI, run `agent mcp login opengeni`. Skills:
`.agents/skills/` or `.cursor/skills/` in the project, or `~/.cursor/skills/`.

## VS Code (GitHub Copilot agent mode)

```bash
code --add-mcp '{"name":"opengeni","type":"http","url":"<MCP URL>"}'
```

That adds the server to your user profile. For one project, add it to
`.vscode/mcp.json` (key `servers`) or to the portable `.mcp.json` at the
repository root (key `mcpServers`, also read by Claude Code):

```json
{ "servers": { "opengeni": { "type": "http", "url": "<MCP URL>" } } }
```

VS Code opens the browser sign-in on the first connection; the account then
appears in the Accounts menu. Skills: `.agents/skills/` or `.github/skills/` in
the project, or `~/.copilot/skills/`.

## Devin Desktop (formerly Windsurf)

```bash
devin mcp add -s user opengeni <MCP URL>
devin mcp login opengeni
```

Or add it to `~/.config/devin/mcp_config.json` (all projects) or
`.devin/mcp_config.json` (one project):

```json
{ "mcpServers": { "opengeni": { "url": "<MCP URL>", "transport": "http" } } }
```

Devin Local also asks you to authenticate on first use, and shows **Needs auth**
with an **Authenticate** button when the sign-in expires. Skills:
`.agents/skills/` or `.windsurf/skills/` in the project, or `~/.agents/skills/`.
Older Windsurf releases read `~/.codeium/windsurf/mcp_config.json` with
`serverUrl` instead of `url`.

## Zed

Add the server in Settings → AI → MCP Servers → Add Remote Server, or in
`~/.config/zed/settings.json`:

```json
{ "context_servers": { "opengeni": { "url": "<MCP URL>" } } }
```

Zed starts the MCP OAuth sign-in because the server has no `Authorization`
header. Skills: `.agents/skills/` in the project or `~/.agents/skills/` (Zed
reads only these).

## Gemini CLI

```bash
gemini mcp add --transport http -s user opengeni <MCP URL>
```

Or set it in `~/.gemini/settings.json` or `.gemini/settings.json`:

```json
{ "mcpServers": { "opengeni": { "httpUrl": "<MCP URL>" } } }
```

Gemini CLI signs in automatically on first use; `/mcp auth opengeni` signs in
again. It needs a local browser. Skills: `.agents/skills/` or `.gemini/skills/`
in the project, or `~/.gemini/skills/`.

## Any other MCP client

Use these settings in any client that supports remote MCP servers over
Streamable HTTP with MCP OAuth: server URL `<MCP URL>`, no headers or API key,
and OAuth with dynamic client registration. The authorization server is the
deployment origin (`/.well-known/oauth-authorization-server`); it accepts
public clients only (`token_endpoint_auth_method: "none"`), PKCE `S256`, the
`resource` parameter set to the MCP URL, scope `mcp:access`, and redirect URIs
that are `https`, loopback `http` (`localhost`, `127.0.0.1`, `[::1]`), or a
custom scheme with a host and path.

For a client that only runs local (stdio) servers, use the `mcp-remote` bridge,
which performs the OAuth sign-in in your browser and keeps tokens in
`~/.mcp-auth`:

```json
{ "mcpServers": { "opengeni": { "command": "npx", "args": ["-y", "mcp-remote", "<MCP URL>"] } } }
```

## Skills for any agent

`.agents/skills/` in a repository (or `~/.agents/skills/` for all projects) is
read by Codex, Cursor, VS Code, Devin Desktop, Zed, and Gemini CLI. Claude Code
reads `.claude/skills/` instead, which the plugin covers. To install both Skills
without cloning the whole repository:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/Cloudgeni-ai/opengeni.git /tmp/opengeni-skills
git -C /tmp/opengeni-skills sparse-checkout set plugins/opengeni/skills
mkdir -p .agents/skills && cp -R /tmp/opengeni-skills/plugins/opengeni/skills/. .agents/skills/
```

For an agent without Skills support, keep the folders anywhere in the
repository and point its instructions file (`AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, `.github/copilot-instructions.md`, or `.cursor/rules/*.mdc`) at
them:

```markdown
## OpenGeni
- To run work in the cloud, in the background, or "on OpenGeni", or to check an
  OpenGeni session, read and follow `.agents/skills/offload-to-opengeni/SKILL.md`.
- To add OpenGeni agents to an app, or to create a local OpenGeni chat app, read
  and follow `.agents/skills/build-with-opengeni/SKILL.md`.
```

## Tool names

The server publishes tools as `opengeni__<tool>`, for example
`opengeni__session_create`. Clients add a prefix: Claude Code shows
`mcp__plugin_opengeni_opengeni__opengeni__session_create` for the plugin
server. The endpoint rejects workspace API keys, so sign in with OAuth; the
OAuth token works only on the MCP endpoint, never on the REST API.

## Verification status

Checked on 2026-10-01. "Docs" means the configuration format and sign-in
trigger were checked against the client's current documentation; "source"
means its open-source OAuth client was read against OpenGeni's authorization
server rules above; "end to end" means a real sign-in against OpenGeni. Rows
without an end-to-end test are unverified for the `resource` parameter, which
OpenGeni requires on the authorization request. Re-check a row when a client
changes its MCP support.

| Client | Config format | OAuth against OpenGeni | Skills location |
| --- | --- | --- | --- |
| Claude Code | Docs; `claude plugin validate --strict` | Tested end to end on a local stack (2.1.285): sign-in, Skill load, session create and read | Plugin |
| Codex | Docs | Sign-in tested end to end on a local stack (0.154.0) | Docs |
| Cursor | Docs (the IDE sign-in prompt is not documented) | Closed source; its redirect URIs pass registration on a local stack | Docs |
| VS Code | Docs; `code --add-mcp` accepting `url` checked in source | Not tested end to end; its documented DCR and callbacks (`http://127.0.0.1:33418`, `https://vscode.dev/redirect`) fit OpenGeni's rules | Docs |
| Devin Desktop / Windsurf | Docs (legacy `~/.codeium/windsurf/mcp_config.json` not in current docs) | Closed source; DCR documented for Devin Local | Docs |
| Zed | Docs (project-level `.zed/settings.json` not documented) | Unverified: DCR and callback are not documented | Docs |
| Gemini CLI | Docs and source | Not tested end to end; it requires the `iss` callback parameter, which OpenGeni sends, and a loopback callback | Docs |
| `mcp-remote` | README | Not tested end to end; loopback callback fits OpenGeni's rules | n/a |

## Maintaining this plugin

- `.claude-plugin/marketplace.json` at the repository root lists this plugin;
  Claude Code and Codex both read it.
- Bump `version` in `.claude-plugin/plugin.json` when the plugin changes;
  installed copies update only on a new version.
- Run `claude plugin validate --strict .` from the repository root and
  `bun test scripts/agent-plugin.test.ts`.
- `local-demo-app.md` was built from its own text and run against a local
  stack; rebuild it the same way when `@opengeni/sdk` or `@opengeni/react`
  change the proxy, provider, or chat exports.
