# OpenGeni plugin for coding agents

One plugin and marketplace, both named **`opengeni`**. The package at
`./plugins/opengeni` holds three skills and one MCP server, `opengeni`, which
connects the coding agent to the person's OpenGeni organization through the
[organization MCP server](mcp-surfaces.md#organization-mcp-server)
(`https://app.opengeni.ai/v1/mcp`). It has no hooks, plugin UI, or install-time
settings. Installing it grants nothing: the first MCP use opens the server's
own OAuth sign-in, where the person chooses what the agent may access.

## Skills

| Public skill | Purpose |
| --- | --- |
| `build-with-opengeni` | Build a product or local demo, with the complete client guide as supporting reference material. |
| `offload-to-opengeni` | Run work in an OpenGeni session through the `opengeni` MCP tools (find, describe, run an action). |
| `opengeni-setup` | Browser-assisted SDK/REST setup. Uses the `opengeni` MCP tools when available; never required. |

The nested `build-with-opengeni/opengeni-client` guide is not a fourth public
plugin skill. The canonical client/setup sources remain
`.agents/skills/opengeni-client` and `.agents/skills/opengeni-setup`.
These are coding-agent guides, not the Skills of the customer-facing agent.

## MCP server

Each host reads its own native file; both name the server `opengeni`, point at
the same URL, and carry no credential, header, or environment variable.

| Host | File | Entry |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json` `mcpServers` | `{ "type": "http", "url": "https://app.opengeni.ai/v1/mcp" }` |
| Codex, Cursor, other Agent Plugins hosts | `mcp.json` (Agent Plugins MCP schema) | `{ "type": "streamable-http", "url": "https://app.opengeni.ai/v1/mcp" }` |

Both clients discover the server's OAuth metadata from its `401`
`WWW-Authenticate` challenge, register a client dynamically, and open the
browser sign-in on first use. Claude Code lists the server as
`plugin:opengeni:opengeni` and signs in through `/mcp`; Codex lists it as
`opengeni` and signs in through `codex mcp login opengeni`. Organization API
keys also work with the server, but the plugin never asks for one.

There is deliberately no plugin-root `.mcp.json`: Claude's inline entry and the
portable `mcp.json` are the only sources, so neither host sees a second copy.

## Claude Code

```bash
claude plugin marketplace add Cloudgeni-ai/opengeni
claude plugin install opengeni@opengeni --scope user
```

Invoke `/opengeni:build-with-opengeni`, `/opengeni:offload-to-opengeni`, or
`/opengeni:opengeni-setup`. To test a checkout without marketplace installation:

```bash
git clone https://github.com/Cloudgeni-ai/opengeni.git
claude --plugin-dir ./opengeni/plugins/opengeni
```

For a local marketplace, use `claude plugin marketplace add ./opengeni`, then
the same install selector. The marketplace is at the repository root; the plugin
is the **nested directory**, not `.claude-plugin/` or the repository root.
Installation prompts for nothing (no `userConfig`); `claude mcp list` then shows
`plugin:opengeni:opengeni` as needing authentication until the person signs in.

## Codex

```bash
codex plugin marketplace add Cloudgeni-ai/opengeni
codex plugin add opengeni@opengeni
```

Use `codex plugin marketplace add ./opengeni` for a local checkout, or add
`--ref YOUR_REF` to the GitHub marketplace command to test a branch. Keep the
catalog and `plugins/opengeni` contents together; a catalog-only sparse checkout
is not an installable package. `/plugins` is an alternative in supported clients.

Codex loads the portable manifest at `plugins/opengeni/plugin.json` and the
portable `mcp.json` beside it. It discovers only immediate folders under
`skills/`, so the nested client guide is supporting material rather than a
competing fourth skill. The same package with only the legacy Claude manifest is
recursively scanned by Codex and exposes the nested `opengeni-client` too; the
native smoke check tests that counterexample. There is no separate Codex
manifest, custom skills array, or competing identity.

## Cursor and ChatGPT

In Cursor **Customize → From GitHub Repository**, import
`https://github.com/Cloudgeni-ai/opengeni`, then install **OpenGeni**. The root
`.cursor-plugin/marketplace.json` points to the same nested portable package;
no Cursor-specific plugin overlay is needed. Repository `.agents/skills`
discovery is separate and may expose maintainer guides when working in this repo.

OpenAI's documentation supports portable plugins in ChatGPT and Codex. Use
supported desktop repo/local marketplace surfaces and workspace permissions;
availability varies. This repository **has not been published** to the
universal public directory, and registration does not make it available to
every ChatGPT web account. It is not a legacy action/OpenAPI plugin.

## Shared layout and generated sources

```text
.claude-plugin/marketplace.json     # opengeni → ./plugins/opengeni
.agents/plugins/marketplace.json   # same identity/source for OpenAI hosts
.cursor-plugin/marketplace.json    # same identity/source for Cursor
plugins/opengeni/
  .claude-plugin/plugin.json       # shared metadata + Claude's inline MCP entry
  plugin.json                      # Agent Plugins 1.0.0 portable entry point
  mcp.json                         # Agent Plugins 1.0.0 portable MCP entry
  skills/
    build-with-opengeni/
      SKILL.md
      local-demo-app.md
      opengeni-client/              # generated canonical client guide
    offload-to-opengeni/SKILL.md
    opengeni-setup/                 # generated canonical setup guide
```

`bun run sync:client-skill` extends the existing generator, preserving its
runtime bundle and full-text docs mirror, and also generates the contained
client and setup guides. The client mirror is byte-identical. The setup mirror
only redirects its three sibling-client Markdown links to the contained
`build-with-opengeni/opengeni-client` guide; all auth/API/example content is
unchanged. `bun run check:client-skill` checks every file and rejects stale,
missing, extra, or symlinked mirror entries. Edit canonical sources, not mirrors.

Both plugin manifests carry the same `version`; bump it with every change so
installed copies update.

## Verification

```bash
set -o pipefail
bun test ./scripts/developer-plugin-packaging.test.ts ./scripts/sync-client-skill.test.ts
bun run check:client-skill
bun scripts/check-developer-plugin-hosts.ts
```

The focused tests check the single identity, contained paths, frontmatter,
canonical parity, that no install-time settings are required, the portable
schema shape, and the exact MCP entry for each host with no credential. The
native check pins Claude Code and Codex versions, uses isolated temporary
configurations, validates/installs the real package, and checks native
three-skill inventories, the one `opengeni` MCP server in each host, and the
legacy fourth-skill counterexample. It validates the portable manifest and
`mcp.json` against the official Agent Plugins schemas with `ajv-cli@5.0.0`. It
makes no model requests and no network sign-in. It writes a JSON verification
receipt. Cursor/ChatGPT GUI installation is not claimed as tested by that check.

## Official references

Formats verified by direct HTTPS reads on **October 1, 2026**; MCP entries on
**October 3, 2026**:

- [OpenAI packaging](https://developers.openai.com/plugins/build/plugins) and
  [submission reference](https://developers.openai.com/plugins/deploy/submission):
  portable/compatibility layouts, root `mcp.json`, and manifest precedence.
- [OpenAI Codex source](https://github.com/openai/codex): native CLI install
  arguments, `codex mcp login`, and app-server `plugin/read` inventory.
- [Claude manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference),
  [components](https://code.claude.com/docs/en/plugins/components),
  [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference),
  and [installation](https://code.claude.com/docs/en/plugins/install): default
  skill directories, inline `mcpServers`, validation and repository-relative
  sources.
- [Cursor plugins](https://cursor.com/docs/plugins),
  [plugin reference](https://cursor.com/docs/reference/plugins), and
  [skills](https://cursor.com/docs/skills): portable packages, catalogs, imports
  and local discovery.
- [Agent Plugins 1.0.0 plugin schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
  and [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json):
  strict portable shapes; snapshots are retained in `scripts/fixtures/` for
  reproducible validation.
