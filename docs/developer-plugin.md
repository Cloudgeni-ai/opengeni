# OpenGeni developer plugin

Skills for the coding agent working on your product, not the agent you embed:

- [`opengeni-setup`](../.agents/skills/opengeni-setup/SKILL.md): set up SDK access.
- [`opengeni-client`](../.agents/skills/opengeni-client/SKILL.md): integrate OpenGeni into a product.

The plugin is **skills-only**: no MCP configuration, server, hooks, or UI. Installation
does not create an OpenGeni account, grant API access, or configure credentials.

## Claude Code

Install from the repository marketplace:

```bash
claude plugin marketplace add Cloudgeni-ai/opengeni
claude plugin install opengeni-developer@opengeni-developer-plugins --scope user
```

Inside Claude Code, the corresponding commands are `/plugin marketplace add
Cloudgeni-ai/opengeni` and `/plugin install
opengeni-developer@opengeni-developer-plugins`; choose the scope in the install panel.
Invoke `/opengeni-developer:opengeni-setup` or
`/opengeni-developer:opengeni-client`.

To load a local root-repository checkout without installing it:

```bash
git clone https://github.com/Cloudgeni-ai/opengeni.git
claude --plugin-dir ./opengeni
```

Or register that checkout as a marketplace with `claude plugin marketplace add
./opengeni`, then run the same install command. Keep the entire repository root:
`.claude-plugin/` alone is not the plugin. Relative plugin sources require a
repository or directory marketplace, not a URL serving only `marketplace.json`.

## Codex

Register the GitHub marketplace:

```bash
codex plugin marketplace add Cloudgeni-ai/opengeni
codex plugin add opengeni-developer@opengeni-developer-plugins
```

For a local root checkout, use `codex plugin marketplace add ./opengeni` instead.
The direct install command was verified with Codex CLI 0.159.3. You can also open
`/plugins` in a supported Codex CLI to browse and install **OpenGeni Developer**,
or select **OpenGeni Developer Plugins** in the ChatGPT desktop app's Plugins
Directory and install it there. Restart the desktop app after changing local plugin
files. Marketplace registration and plugin installation are separate steps.

To select a non-default Git ref for testing, use `codex plugin marketplace add
Cloudgeni-ai/opengeni --ref YOUR_REF`. Do not use a sparse checkout that omits
`.agents/skills`: the marketplace loads the repository root, not just its catalog.

## Cursor

In **Customize**, choose **From GitHub Repository**, import
`https://github.com/Cloudgeni-ai/opengeni`, then install **OpenGeni Developer**.
The repository includes the required `.cursor-plugin/marketplace.json`.
Teams and Enterprise can also import the repository in **Dashboard → Plugins &
MCPs → Add Marketplace → Import from Repo**.

When you work inside an OpenGeni checkout, Cursor discovers `.agents/skills/`
directly; no plugin install is needed. That repository discovery also exposes the
repository's maintainer skills, unlike the plugin's explicit two-skill selection.
For another product, use the marketplace plugin rather than copying skills into
this plugin package. Local `~/.agents/skills` are not synced to Cursor Cloud Agents;
use project skills in their repository or Cursor's supported marketplace route.

## ChatGPT

**Skills-only plugins are officially supported as of October 1, 2026.** OpenAI's
current packaging and submission docs explicitly allow skills without MCP.
This repository uses the supported Codex compatibility package for ChatGPT and
Codex; it is not a legacy `.well-known/ai-plugin.json` action/OpenAPI plugin.

Use the repo/local marketplace through the ChatGPT desktop app's supported
plugin surfaces as described above. Availability depends on the surface and
workspace permissions. Repository registration does **not** publish the plugin
to ChatGPT's universal public directory or make it available to every web account.
Public distribution is a separate upload/review/publish workflow; this repository
does not claim an approved public listing or register any MCP connection.

## Packaging decisions

The repository root is the plugin root for all three hosts. Each manifest's
`skills` array selects exactly `./.agents/skills/opengeni-setup` and
`./.agents/skills/opengeni-client`. Both directories remain inside the installed
package, and each contains its own `SKILL.md` and supporting references.
Marketplace sources are `./`, resolved from the repository/marketplace root,
**not** from the directory containing `marketplace.json`.

- **Codex/ChatGPT:** `.codex-plugin/plugin.json` is an officially supported
  standalone compatibility manifest. Its custom skill paths are directory paths
  relative to the plugin root. The onboarding entry names
  `./.agents/skills/opengeni-setup/SKILL.md`.
- **Claude Code:** `.claude-plugin/plugin.json` accepts custom skill directories,
  including a directory with `SKILL.md` directly. Custom paths add to default
  `skills/` discovery; this package has no `skills/` directory.
- **Cursor:** `.cursor-plugin/plugin.json` accepts skill paths and replaces default
  skill discovery when they are explicit. Its marketplace uses the same root source.

There is deliberately **no portable root `plugin.json`**: Agent Plugins 1.0.0 fixes
skills at `skills/`; OpenAI ignores custom `skills` declarations in compatibility
overlays when a recognized portable root manifest exists. Adding that manifest
would hide these canonical sources. This package needs no copied skill trees or
symlinks, including no links whose targets escape an install cache.

`scripts/sync-client-skill.ts` already treats `.agents/skills/opengeni-client` as
the sole authored client guide. Its runtime bundle and public full-text page are
generated distribution assets, checked for equality by `bun run check:client-skill`.
Plugin manifests do not point at those generated copies.

## Verification

From the repository root, with both canonical skills present:

```bash
set -o pipefail
bun test ./scripts/developer-plugin-packaging.test.ts
bun run check:client-skill
claude plugin validate . --strict
```

The focused tests check manifest metadata, exact canonical skill paths and their
frontmatter/references, root marketplace resolution, docs navigation, and the
absence of copied/default skills and MCP or executable plugin components.
They are packaging checks, not evidence that a particular host/account installed
or executed the skills. Use the actual host to smoke-test discovery after install.

## Official references

Verified by direct HTTPS reads on **October 1, 2026**:

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
  — compatibility manifests, root-relative paths, marketplace formats and registration.
- [OpenAI: Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission)
  — Codex directory/array `skills`, onboarding paths, skills-only ChatGPT support,
  and portable-manifest precedence.
- [OpenAI: Plugins](https://developers.openai.com/codex/plugins)
  — supported surfaces and the Codex CLI plugin browser.
- [OpenAI Codex CLI source](https://github.com/openai/codex)
  — native CLI 0.159.3 `plugin add --help` and `plugin marketplace add --help`
  verified the install selector and marketplace flags.
- [OpenAI: Build skills](https://developers.openai.com/codex/build-skills)
  — `.agents/skills` discovery and portable skill files.
- [Claude Code: Plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)
  — custom skill directories, containment, defaults and validation.
- [Claude Code: Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)
  — root-relative plugin sources and catalog schema.
- [Claude Code: Install and manage plugins](https://code.claude.com/docs/en/plugins/install)
  — marketplace installation and scopes.
- [Cursor: Agent Skills](https://cursor.com/docs/skills)
  — project discovery, Cloud Agent limits and GitHub installation through plugins.
- [Cursor: Plugins reference](https://cursor.com/docs/reference/plugins)
  — custom skill paths and marketplace resolution.
- [Cursor: Plugins](https://cursor.com/docs/plugins)
  — repository imports and team marketplaces.
- [Agent Plugins 1.0.0 manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
  — portable manifests do not define a custom `skills` field.