# Capability Catalog

OpenGeni exposes a workspace-level Capabilities control-plane read model for Packs, external MCP/API integrations, Skills, and Plugins. Capability is a UI and discovery umbrella, not one runtime type or one generic enable/disable lifecycle.

The catalog merges:

- built-in and workspace-registered Packs
- immutable, reviewed curated skill-library entries (`source: "library"`)
- external MCP servers managed through `OPENGENI_MCP_SERVERS`
- local catalog items added through the API or web app
- reviewed integrations.sh snapshot imports stored as global `source: "registry"` catalog rows
- public remote MCP servers discovered from the official MCP Registry

Native OpenGeni product surfaces are deliberately absent from the installable catalog. The internal `opengeni`, `files`, and `docs` MCP carriers, Documents, Scheduled Tasks, GitHub repository resources, Rigs, and Sandboxes remain available through their owning runtime and product surfaces; they are never manufactured as enabled catalog rows. Agent discovery may return a separate native connection recommendation, such as GitHub owner consent, without adding that recommendation to the workspace catalog.

Every catalog item includes a typed `lifecycle` projection and a bounded list of supported `actions` (`install`, `connect`, `configure`, `update`, `repair`, `disconnect`, `uninstall`, or `inspect`). The legacy `enabled` fields remain a compatibility projection while clients migrate; provenance such as `built_in` never implies lifecycle state. External configured MCPs are reported as deployment-managed and inspect-only.

## Runtime Behavior

Remote MCP capabilities with a streamable HTTP endpoint are executable. Enabling a remote MCP first performs an MCP initialize/list-tools probe. If the probe succeeds, OpenGeni stores a `capability_installations` row and the API/worker merge that row into the runtime MCP server list for new sessions, follow-ups, and scheduled tasks. Sessions and scheduled tasks created without an explicit `tools` key are attached to every enabled capability MCP server by default; an explicit tools list (even an empty one) is taken verbatim. If the probe fails, the API returns `422` and the capability stays disabled, so a stale, down, or auth-only endpoint never breaks agent turns at runtime.

Tool selection is durable session state. The session tool picker atomically
updates connected MCP servers and individual OpenGeni tools under one version;
the next attempt reads that selection. Follow-up Send and Steer requests do not
carry a private one-turn tool list. OpenGeni's web picker hides its internal
`opengeni` carrier and the default-on `files` server from the visible count.
The public API remains exact: an explicit session policy may omit `files`.
Provider-native web search remains available independently of this MCP policy.
Its search, open-page, and find-in-page response items settle from their own
provider status and render before the answer they informed; they do not wait for
a separate function-tool output event.

MCP tool refs are strict by default. A newly submitted bare `{ "kind": "mcp", "id": "docs" }` must name a server configured for this deployment, and a runtime connect/list failure fails the turn. A client or pack can mark a ref `{ "kind": "mcp", "id": "context7", "optional": true }` to make it portable: if the deployment does not configure that server the ref is skipped during validation, and if the server is configured but unavailable at runtime it is skipped for that turn with a warning. Persisted refs have a separate turn-time safety rule: if a previously valid server is later disconnected, disabled, or removed from the runtime registry, OpenGeni preserves that selection in the session's effective-policy audit projection but omits it from executable tools for the turn. The model receives a bounded system notice naming the unavailable server and must not claim to have read or updated it, so one disappearing integration cannot trap every later chat turn in an `Unknown MCP server id` failure loop.

An optional connection-backed MCP whose credential is unavailable during
`initialize` or `tools/list` is setup availability, not proof that the user
asked to use that integration. OpenGeni skips it without emitting a
conversational `tool.auth_needed` card. A concrete `tools/call` authentication
failure still emits the actionable event with its tool name, and historical
tool-less setup events remain available to debug/audit projections rather than
the chat transcript.

The deployment-provided `codex_apps` registry follows the same durable policy
only when connected apps are enabled and the workspace has one explicit,
currently authorized Apps credential designation. Workspace-default sessions
receive it as an optional MCP. Explicit and inherited fixed policies include it
only when selected. No designation means no Apps server and no credential
fallback. Apps authentication is independent of the inference model,
subscription, quota, allocator, rotation, pin, lease, and cooldown, and it never
widens the model-visible tool policy. Runtime authorization is rechecked before
each Apps request; ownership and mutation rules are detailed in
[`mcp-surfaces.md`](mcp-surfaces.md).

### Credential headers

MCP servers that require request headers (for example an `Authorization` bearer token) are enabled by passing the headers in the enable request:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities/mcp%3Asecure-mcp/enable" \
  -H 'content-type: application/json' \
  -d '{"headers":{"Authorization":"Bearer <token>"}}'
```

The probe runs with those headers, and on success the values are stored encrypted (AES-256-GCM under `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, like workspace variable set values) on the installation. At runtime the worker decrypts them and sends them only to that MCP server. The API never returns header values — installation responses expose the stored header names only. Re-enabling without a `headers` field reuses the stored credentials; passing `headers` replaces them.

Registry entries that declare required headers are tagged `requires-credentials` and cannot be enabled until the declared headers are supplied.

The current compatibility table still records existing catalog installations, but product actions route to the owning type-specific domain. A Skill is installed, an Integration is connected/configured, and a Pack is installed/configured; clients must not infer one universal Enable action from catalog membership.

## Curated skill library

The default sandbox carries no Terraform, Checkov, social-marketing, or other domain methodology guidance. Those Skills live in the immutable curated library under `packages/runtime/src/bundled_skill_library/` and are discoverable but uninstalled until explicitly selected. The initial reviewed set is Checkov, Refactor Module, Social Media Marketing, Terraform Search and Import, Terraform Stacks, Terraform Style Guide, Terraform Test, and Azure Verified Modules.

- `id` is stable (`skill:azure-verified-modules` in the catalog).
- `metadata.libraryId`, `metadata.version`, `metadata.contentSha256`, `metadata.sourceCommit`, `metadata.sourceUrl`, `metadata.provenance`, `metadata.license`, `metadata.documentationUrl`, `metadata.compatibility`, and `metadata.upgrade` make provenance inspectable. `contentSha256` is a canonical whole-artifact digest over sorted normalized relative paths and the exact bytes of every recursively materialized regular file, not only `SKILL.md`.
- Entries are immutable. A changed artifact is a new version and hash; enabling an unsupported `config.version` returns `422` rather than silently selecting another revision.
- Enabling a library skill stores only the canonical exact version/hash metadata. It does not attach a variable set, credentials, MCP servers, tools, cloud permissions, tenant access, or Azure/OpenAI model routing. The skill contributes guidance files to the normal `.agents/` skill index only.
- Active library skills are resolved by the worker at turn start. A missing entry, unavailable artifact, or hash mismatch fails closed; it never substitutes a different version.

Enable the exact catalog version (the `config.version` field is optional when the catalog has one current immutable version):

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities/skill%3Aazure-verified-modules/enable" \
  -H 'content-type: application/json' \
  -d '{"config":{"version":"1.0.0"},"metadata":{"enabledBy":"operator"}}'
```

The resulting catalog row reports an installed/ready lifecycle (and retains `enabled: true` with `enabledReason: "explicitly selected"` for compatibility). Uninstalling the selection removes the curated skill from subsequent turns.

### Skill source precedence

The runtime keeps these sources inspectable and separate:

1. explicitly selected immutable curated-library skills;
2. enabled capability-Pack skills;
3. inline per-session skills;
4. repository-local `.agents/skills` or `.claude/skills` discovered at their real mounted path; and
5. native editable-artifact skills, only after the exact artifact runtime preflight succeeds.

Pack skills retain explicit precedence when a Pack declares the same skill directory name as a curated entry. Duplicate or conflicting names fail instead of shadowing ambiguously. The effective runtime selection reports source, version, hash, and reason without exposing secrets.

Self-hosted/Connected Machine deployments may omit the curated artifact from their runtime image. Such a deployment omits the entry from discovery and cannot activate it; it does not download, substitute, or silently route the turn to Azure-hosted inference.

### Compatibility and migration

Skill-library selection is currently workspace-scoped through the capability installation. Existing session rows do not contain a per-session library pin, so resumed and newly created sessions use the workspace's active exact-pinned library installations plus their Pack/session/repository sources. This deliberately removes the former seven deployment-default domain Skills rather than silently retaining methodology a workspace never selected. A future per-session pin migration can preserve historical library context for long-lived sessions if product requirements call for that stronger continuation guarantee; it must use the same immutable id/version/hash records and must not broaden authorization.

### Remote Skill imports

Workspace administrators can preview and install a Skill from a public
`skills.sh` URL or a GitHub repository/deep-folder URL. Preview resolves the
repository to an immutable commit, walks only the selected tree, rejects
symlinks, submodules, traversal, invalid UTF-8, duplicate paths, missing
frontmatter, and bounded-size violations, then returns file digests without
returning file contents. Install repeats source resolution and requires both
the previewed commit and whole-artifact SHA-256 to match; source drift is a
`409` and never installs unreviewed bytes.

The normalized v2 persistence model stores the immutable Plugin version, Skill
facet, exact text files, workspace installation, and component owners under
FORCE RLS. Runtime materialization revalidates the stored artifact and digest
before adding it to the same lazy `.agents/` Skill index as curated, Pack,
session, repository, and native artifact Skills. Uninstall is previewed and
optimistic-concurrency fenced: removing the direct owner retains the Skill when
a Plugin or Pack still owns it, and only the final owner removes it from later
turns. The compatibility catalog/install rows are dual-written during the
rolling migration; they are a projection, not the artifact authority.

The owning endpoints are:

- `POST /v1/workspaces/:workspaceId/skills/preview`
- `POST /v1/workspaces/:workspaceId/skills/install`
- `GET /v1/workspaces/:workspaceId/skills/:capabilityId/uninstall-preview`
- `DELETE /v1/workspaces/:workspaceId/skills/:capabilityId`

Configured MCP endpoint URLs are visible in the catalog. Do not put tokens or other secrets in `OPENGENI_MCP_SERVERS` URLs.

## API

List the merged catalog:

```bash
curl "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities"
```

Search the official MCP Registry for public remote MCP servers:

```bash
curl "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities/discovery/mcp-registry?query=social&limit=20"
```

Add a public remote MCP server to the local catalog:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities" \
  -H 'content-type: application/json' \
  -d '{
    "id": "mcp:example-mcp",
    "kind": "mcp",
    "source": "manual",
    "name": "Example MCP",
    "endpointUrl": "https://example.com/mcp",
    "category": "marketing",
    "tags": ["social", "analytics"]
  }'
```

Enable it:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities/mcp%3Aexample-mcp/enable" \
  -H 'content-type: application/json' \
  -d '{"config":{},"metadata":{"enabledBy":"operator"}}'
```

If the MCP endpoint initializes successfully, the enabled MCP is returned by the workspace capability catalog and can be selected as a session tool in the web app. Configured MCP servers still come from `/v1/config/client`. If the probe fails, the API returns `422` and the capability remains disabled.

## Web Flow

Open the **Capabilities** view in the web app to:

- filter and search the local catalog
- install and configure role Packs
- add and enable public MCP Registry results
- add and connect manual MCP integrations
- install immutable Skills and inspect their provenance
- select enabled custom MCPs in the agent composer

The official MCP Registry is public metadata. Evaluate any server and its endpoint before enabling it in a workspace with sensitive data.

## Agent discovery and in-session authorization

Ordinary new sessions include two first-party OpenGeni tools:

- `capability_catalog_search` searches the same merged workspace catalog as the
  Capabilities page. It returns bounded, secret-free descriptors and a live
  setup state; it never returns credential instructions, tokens, or raw catalog
  metadata. Search is deterministic, excludes untrusted registry rows, and
  prefers exact, enabled, verified, and built-in matches. Agents should search
  by the outcome they need (for example, `GitHub repositories`, `product
  analytics`, or `Slack notifications`) rather than guessing an MCP endpoint.
- `capability_authorization_request` posts one `tool.auth_needed`-style card to
  the current session for an exact catalog result. Calling it does not install,
  enable, connect, or grant anything. The exact turn attempt fences the event,
  and the signed-in human must confirm the provider domain and complete setup.

The recommendation card resolves the catalog again at click time. A removed or
changed item is never authorized from stale event data. OAuth-backed MCPs can
start the normal connection flow directly from the session for a workspace
admin, return to the same session, and enable the capability against the exact
new connection. API-key, required-variable, and admin-review paths open the
existing protected Capabilities/variable-set setup surfaces; credential values
never enter the event or model-visible tool result. Existing explicit session
tool policies remain exact and do not silently gain the two discovery tools.

GitHub is the first fully specialized adapter. Search prefers the built-in
  native GitHub connection recommendation, checks the live workspace binding,
  and reports it ready only when an active owner-authorized installation exists. Otherwise the
human click mints fresh `github:manage` owner-consent state and carries only a
validated same-workspace session return path across GitHub redirects. The agent
never receives `github:manage`, an installation token, the signed browser state,
or a repository outside the durable allowlist. On success the browser returns
to the originating session and subsequent tool calls use the existing
host-owned GitHub authority.

## integrations.sh Snapshot Imports

The integrations catalog import pipeline is offline and reviewable. It never
live-consumes integrations.sh at request time. The reviewed source of truth is
the committed snapshot at `data/catalog/integrations-snapshot.json`. Updating it
is a PR workflow: run `bun run catalog:refresh`, review the snapshot diff, then
merge. Standard Helm installs and upgrades import that committed snapshot by
default through the `catalogImport` hook Job; set `catalogImport.enabled=false`
to opt out. The default `catalogImport.skipLogos=true` keeps deployment success
independent of third-party logo hosts and uses generic monograms; set it to
`false` to fetch, validate, and self-host the reviewed logos. `bun run dev` also
imports metadata after migrations by default; set
`OPENGENI_CATALOG_IMPORT_ENABLED=false` to opt out locally. Operators using a
different deployment system should run `bun run catalog:import --snapshot
data/catalog/integrations-snapshot.json --if-changed --skip-logos` after
migrations. The
fingerprinted `--if-changed` mode exits without database or object-storage
writes when that exact snapshot already completed successfully. The importer
writes global capability rows, records an `import_batches` provenance row with
MIT attribution, and upserts registry entries by `(provider_domain, mcp_url)`.
Rows removed from a later snapshot are marked `stale`, not deleted, and are
excluded from default workspace catalog listings.

Imported logos are fetched during import, validated as images below 512KB, and
stored through OpenGeni object storage under `catalog-assets/...`; catalog rows
store only the self-hosted `logoAssetPath`, never the third-party logo URL. The
normalization pass strips raw control characters from string fields, collapses
duplicate `(domain, name)` clusters to the best deterministic row, skips
known-dead demo domains, and quarantines flagged suspicious URLs in the batch
details for manual review.
