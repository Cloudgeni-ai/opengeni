# Capability Catalog

OpenGeni exposes a workspace-level capability catalog for packs, MCP servers, APIs, skills, and plugins.

The catalog merges:

- built-in OpenGeni packs, APIs, MCP servers, and bundled sandbox skills
- immutable, reviewed curated skill-library entries (`source: "library"`)
- MCP servers configured through `OPENGENI_MCP_SERVERS`
- local catalog items added through the API or web app
- reviewed integrations.sh snapshot imports stored as global `source: "registry"` catalog rows
- public remote MCP servers discovered from the official MCP Registry

## Runtime Behavior

Remote MCP capabilities with a streamable HTTP endpoint are executable. Enabling a remote MCP first performs an MCP initialize/list-tools probe. If the probe succeeds, OpenGeni stores a `capability_installations` row and the API/worker merge that row into the runtime MCP server list for new sessions, follow-ups, and scheduled tasks. Sessions and scheduled tasks created without an explicit `tools` key are attached to every enabled capability MCP server by default; an explicit tools list (even an empty one) is taken verbatim. If the probe fails, the API returns `422` and the capability stays disabled, so a stale, down, or auth-only endpoint never breaks agent turns at runtime.

MCP tool refs are strict by default. A bare `{ "kind": "mcp", "id": "docs" }` must name a server configured for this deployment, and a runtime connect/list failure fails the turn. A client or pack can mark a ref `{ "kind": "mcp", "id": "context7", "optional": true }` to make it portable: if the deployment does not configure that server the ref is skipped during validation, and if the server is configured but unavailable at runtime it is skipped for that turn with a warning.

### Credential headers

MCP servers that require request headers (for example an `Authorization` bearer token) are enabled by passing the headers in the enable request:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/capabilities/mcp%3Asecure-mcp/enable" \
  -H 'content-type: application/json' \
  -d '{"headers":{"Authorization":"Bearer <token>"}}'
```

The probe runs with those headers, and on success the values are stored encrypted (AES-256-GCM under `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, like workspace variable set values) on the installation. At runtime the worker decrypts them and sends them only to that MCP server. The API never returns header values — installation responses expose the stored header names only. Re-enabling without a `headers` field reuses the stored credentials; passing `headers` replaces them.

Registry entries that declare required headers are tagged `requires-credentials` and cannot be enabled until the declared headers are supplied.

APIs, skills, and plugins are tracked in the same catalog and install table so operators can build a role-oriented workspace inventory. Built-in APIs and bundled skills are already available. Custom APIs, skills, and plugins need their own adapter or runtime implementation before tracking them changes agent execution.

## Curated skill library

The default sandbox bundle is intentionally provider-neutral. Infrastructure guidance that is not appropriate for every workspace, such as Azure Verified Modules guidance, lives in the immutable curated library under `packages/runtime/src/bundled_skill_library/` instead of the always-mounted bundle. A library entry is discoverable in the catalog but starts disabled:

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

The resulting catalog row reports `enabled: true` with `enabledReason: "explicitly selected"`. Disabling the installation removes the curated skill from subsequent turns; it does not change the default bundle.

### Skill source precedence

The runtime keeps three sources inspectable and separate:

1. deployment-default bundled/repository-local skills (always enabled where the sandbox Skills capability is available);
2. explicitly selected immutable curated-library skills;
3. enabled capability-pack skills.

Pack skills retain their existing behavior and have explicit precedence when a pack declares the same skill directory name as a bundled or curated entry. Duplicate names within the curated selection are rejected. The effective runtime selection reports source, version, hash, and reason without exposing secrets.

Self-hosted/Connected Machine deployments may omit the curated artifact from their runtime image. Such a deployment omits the entry from discovery and cannot activate it; it does not download, substitute, or silently route the turn to Azure-hosted inference.

### Compatibility and migration

Skill-library selection is currently workspace-scoped through the capability installation. Existing session rows do not contain a per-session skill pin, so resumed and newly created sessions use the same current default bundle plus the workspace's active exact-pinned library installations. This deliberately removes the former default Azure guidance rather than silently preserving provider-specific guidance in a session that was expected to be provider-neutral. Pack and repository-local skill behavior remains unchanged. A future per-session pin migration can preserve historical skill context for long-lived sessions if product requirements call for that stronger continuation guarantee; it must use the same immutable id/version/hash records and must not broaden authorization.

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
- enable role packs
- add and enable public MCP Registry results
- add manual MCP entries and track API/skill/plugin entries
- select enabled custom MCPs in the agent composer

The official MCP Registry is public metadata. Evaluate any server and its endpoint before enabling it in a workspace with sensitive data.

## integrations.sh Snapshot Imports

The integrations catalog import pipeline is offline and reviewable. It never
live-consumes integrations.sh at request time. The reviewed source of truth is
the committed snapshot at `data/catalog/integrations-snapshot.json`. Updating it
is a PR workflow: run `bun run catalog:refresh`, review the snapshot diff, then
merge. Operators import that committed snapshot with `bun run catalog:import
--snapshot data/catalog/integrations-snapshot.json` (or the same path inside the
application image). The importer writes global capability rows, records an
`import_batches` provenance row with MIT attribution, and upserts registry
entries by `(provider_domain, mcp_url)`.
Rows removed from a later snapshot are marked `stale`, not deleted, and are
excluded from default workspace catalog listings.

Imported logos are fetched during import, validated as images below 512KB, and
stored through OpenGeni object storage under `catalog-assets/...`; catalog rows
store only the self-hosted `logoAssetPath`, never the third-party logo URL. The
normalization pass strips raw control characters from string fields, collapses
duplicate `(domain, name)` clusters to the best deterministic row, skips
known-dead demo domains, and quarantines flagged suspicious URLs in the batch
details for manual review.
