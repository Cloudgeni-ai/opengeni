# OpenGeni plugin for coding agents

One plugin and marketplace, both named **`opengeni`**. The package at
`./plugins/opengeni` is **skills-only**; it contains no MCP server/configuration,
hooks, or plugin UI. Installing it does not grant access or configure credentials.

## Skills

| Public skill | Purpose |
| --- | --- |
| `build-with-opengeni` | Build a product or local demo, with the complete client guide as supporting reference material. |
| `offload-to-opengeni` | The shared remote-work workflow. Actual offloading needs an available, authenticated transport; this package does not provide one. |
| `opengeni-setup` | Browser-assisted SDK/REST setup using the coding agent's own tools and a scoped Developer setup key. No MCP required. |

The nested `build-with-opengeni/opengeni-client` guide is not a fourth public
plugin skill. The canonical client/setup sources remain
`.agents/skills/opengeni-client` and `.agents/skills/opengeni-setup`.
These are coding-agent guides, not the Skills of the customer-facing agent.

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

The shared manifest retains required `base_url` and `workspace_id` options.
Claude Code 2.1.286 installs and inventories all three skills with both options
unset: it prints a reminder that two required options are not yet set, rather
than blocking skills-only installation. `claude plugin configure opengeni@opengeni
--json` shows that state. No dummy workspace is needed to install or load the
guides. These settings do not authenticate OpenGeni or install an MCP server.

## Codex

```bash
codex plugin marketplace add Cloudgeni-ai/opengeni
codex plugin add opengeni@opengeni
```

Use `codex plugin marketplace add ./opengeni` for a local checkout, or add
`--ref YOUR_REF` to the GitHub marketplace command to test a branch. Keep the
catalog and `plugins/opengeni` contents together; a catalog-only sparse checkout
is not an installable package. `/plugins` is an alternative in supported clients.

Codex 0.159.3 loads the portable manifest at `plugins/opengeni/plugin.json`.
It discovers only immediate folders under `skills/`, so the nested client guide
is supporting material rather than a competing fourth skill. The same package
with only the legacy Claude manifest is recursively scanned by Codex and exposes
the nested `opengeni-client` too; the native smoke check tests that counterexample.
There is no separate Codex manifest, custom skills array, or competing identity.

## Cursor and ChatGPT

In Cursor **Customize → From GitHub Repository**, import
`https://github.com/Cloudgeni-ai/opengeni`, then install **OpenGeni**. The root
`.cursor-plugin/marketplace.json` points to the same nested portable package;
no Cursor-specific plugin overlay is needed. Repository `.agents/skills`
discovery is separate and may expose maintainer guides when working in this repo.

OpenAI's current documentation supports skills-only plugins in ChatGPT and
Codex. Use supported desktop repo/local marketplace surfaces and workspace
permissions; availability varies. This repository **has not been published** to
the universal public directory, and registration does not make it available to
every ChatGPT web account. It is not a legacy action/OpenAPI plugin.

## Shared layout and generated sources

```text
.claude-plugin/marketplace.json     # opengeni → ./plugins/opengeni
.agents/plugins/marketplace.json   # same identity/source for OpenAI hosts
.cursor-plugin/marketplace.json    # same identity/source for Cursor
plugins/opengeni/
  .claude-plugin/plugin.json       # shared metadata and required userConfig
  plugin.json                      # Agent Plugins 1.0.0 portable entry point
  skills/
    build-with-opengeni/
      SKILL.md
      local-demo-app.md
      opengeni-client/              # generated canonical client guide
    offload-to-opengeni/SKILL.md
    opengeni-setup/                 # generated canonical setup guide
```

The shared Claude catalog, Claude manifest, build/demo and offload foundation
are from Bendik's exact `c22ffb374fbb740d9e8da008be567edeb71ac548` revision.
Its transport/README claims are not imported as delivery claims for this
skills-only package. Its `.mcp.json` is deliberately absent. A later transport
change must add and verify the relevant host configuration separately.

`bun run sync:client-skill` extends the existing generator, preserving its
runtime bundle and full-text docs mirror, and also generates the contained
client and setup guides. The client mirror is byte-identical. The setup mirror
only redirects its three sibling-client Markdown links to the contained
`build-with-opengeni/opengeni-client` guide; all auth/API/example content is
unchanged. `bun run check:client-skill` checks every file and rejects stale,
missing, extra, or symlinked mirror entries. Edit canonical sources, not mirrors.

The portable entry point is necessary for Codex's three-skill discovery. It
discovers portable `mcp.json`, **not** Claude's `.mcp.json`; adding only the latter
later would not make the transport available to portable OpenAI hosts. Keep
that provider difference explicit when adding transport. No server is included
or needed for SDK setup/build guidance in this revision.

## Verification

```bash
set -o pipefail
bun test ./scripts/developer-plugin-packaging.test.ts ./scripts/sync-client-skill.test.ts
bun run check:client-skill
bun scripts/check-developer-plugin-hosts.ts
```

The focused tests check the single identity, contained paths, frontmatter,
canonical parity, required settings, portable schema shape, and no executable
components/MCP. The native check pins Claude Code 2.1.286 and Codex 0.159.3,
uses isolated temporary configurations, validates/installs the real package,
and checks native three-skill inventories plus the legacy fourth-skill
counterexample. It validates the portable manifest against the official Agent
Plugins schema with `ajv-cli@5.0.0`. It makes no model requests and sets no
OpenGeni URL, workspace, or credentials. It writes a JSON verification receipt.
Cursor/ChatGPT GUI installation is not claimed as tested by that check.

## Official references

Verified by direct HTTPS reads on **October 1, 2026**:

- [OpenAI packaging](https://developers.openai.com/plugins/build/plugins) and
  [submission reference](https://developers.openai.com/plugins/deploy/submission):
  portable/compatibility layouts, skills-only support and manifest precedence.
- [OpenAI Codex source](https://github.com/openai/codex): native CLI 0.159.3
  install arguments and app-server `plugin/read` inventory.
- [Claude manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference),
  [components](https://code.claude.com/docs/en/plugins/components),
  [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference),
  and [installation](https://code.claude.com/docs/en/plugins/install): default
  skill directories, settings, validation and repository-relative sources.
- [Cursor plugins](https://cursor.com/docs/plugins),
  [plugin reference](https://cursor.com/docs/reference/plugins), and
  [skills](https://cursor.com/docs/skills): portable packages, catalogs, imports
  and local discovery.
- [Agent Plugins 1.0.0 schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json):
  strict portable identity/metadata shape; a semantic snapshot is retained in
  `scripts/fixtures/agent-plugin-1.0.0.schema.json` for reproducible validation.