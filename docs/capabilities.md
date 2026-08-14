# Capability Catalog

OpenGeni exposes a workspace-level Capabilities control-plane read model for Packs, external MCP/API integrations, Skills, and Plugins. Capability is a UI and discovery umbrella, not one runtime type or one generic enable/disable lifecycle.

The catalog merges:

- built-in and workspace-registered Packs
- immutable, reviewed curated skill-library entries (`source: "library"`)
- external MCP servers managed through `OPENGENI_MCP_SERVERS`
- manual remote MCP entries added through the API or web app
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

The generic `capability_catalog_items` and `capability_installations` tables are
MCP-only. Skills, Plugins, Integration Definitions, and Packs are projected
from their dedicated authoritative ledgers, and their mutations use their
type-specific preview/install/configure/uninstall flows. Clients must not infer
one universal Enable action from catalog membership.

### Protocol-neutral API Integrations

OpenAPI 3.0/3.1 and GraphQL endpoints use an immutable preview-before-install
flow. Curated Integration Definitions cover Google Drive/Gmail and Microsoft
Outlook Mail/Calendar/Contacts/OneDrive; a general OpenAPI URL, GraphQL endpoint,
or auto-detected URL creates a workspace Definition through the same contracts. Preview performs
bounded, pinned source discovery, compiles stable tool identities and safety
metadata, reports the required authentication without returning credentials,
and returns the exact revision id and SHA-256. Install re-fetches the source and
returns `409` if either immutable fact changed, so unreviewed tools are never
installed from a stale preview.

Authenticated Integrations require an existing active Connection for the exact
provider domain. The selected Connection's Personal/workspace ownership and
required scopes are checked during install; caller-supplied ownership cannot
relabel it. Connections remain independently managed and are never deleted by
Integration uninstall. Direct, Plugin, Pack, and migration ownership records
share the normalized component ledger, so uninstall preview identifies whether
the runtime adapter will actually disappear. Mutation uses the Plugin
installation version as an optimistic-concurrency fence.

The Capabilities page exposes this lifecycle as **Connect custom API**. The
default path accepts one URL or domain and detects OpenAPI or GraphQL; advanced
controls allow an explicit OpenAPI document/base URL or GraphQL endpoint/name.
Detection is non-mutating. If discovery reports authentication, the dialog
defaults to creating a new Personal or workspace Connection and also offers
only compatible active existing Connections for the exact domain and
ownership. An authenticated GraphQL preview is then retried through that exact
Connection. The final review shows the immutable digest, tools, safety and
approval policy, warnings, ownership, and account label before install.

Installed custom APIs appear in a dedicated section rather than the legacy
generic “Add custom” catalog dialog. Multiple named instances of one definition
remain independent (for example, `Linear — Finance` and `Linear — Sales`), with
their own Connection, stable runtime identity, selected tools, status, update
review, reconnect action, and instance-scoped removal. Updating preserves only
previously allowed tools that still exist; newly discovered tools are opt-in,
and an explicit empty selection is never interpreted as all tools. Readiness is
derived from the persisted authentication scheme: a no-auth API can remain
ready even when an optional Connection is attached, while authenticated APIs
never claim readiness when Connection data is unavailable.

API-key Connections may store bounded, validated header, query, and cookie
placements. The broker resolves those placements only for the exact provider
destination and local HTTP API adapter; query/cookie material fails closed for
remote MCP transport. Duplicate destinations, forbidden transport headers,
cookie injection, control characters, and oversized values are rejected before
the request URL or headers are mutated.

Curated Google and Microsoft Definitions use one signed PKCE flow:

- `POST /v1/workspaces/:workspaceId/integrations/oauth/start`
- `GET /v1/integrations/provider-oauth/callback`

The start request names the Integration Definition and ownership and may name an existing
Connection for reconnect/incremental consent. Google can reuse the deployment's
Google Drive OAuth app; Microsoft and alternate Google clients are selected
from `OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON` by authorization-server URL.
The Google callback keeps the existing registered URI and verifies the signed
state before dispatching either the legacy read-only Drive connector or a named
provider instance. A Google Web application client must include its client
secret; a public client may explicitly use `tokenEndpointAuthMethod: "none"`.
Callbacks consume single-use state, recheck `connections:write`, verify the
provider principal, require every Definition scope, preserve an existing refresh
token when the provider omits a replacement, and CAS-update or duplicate-safe
create the normal encrypted Connection. Emulator-backed tests are merge proof;
provider-live consent remains a separately labeled operational check.

In the web control center, curated Definitions enter that flow through one
reusable three-step connection journey. The account step gives every sibling
account a human label and explains the consequences of Personal and Workspace
ownership; users without integration-management permission may open the
journey but receive administrator remediation instead of a mutation action. The
access step describes reviewed agent use cases and permissions in plain
language. Exact OAuth scopes and the provider domain remain available under
progressive **Technical details**, rather than becoming the default interface.
The review step repeats the provider, label, ownership, and capabilities before
the user continues to the provider consent screen.

The journey descriptor is presentation metadata only: it cannot grant scopes,
select a Connection, or replace the Definition and Connection authority above.
Its deterministic web reducer resets between account attempts and ignores stale
submission outcomes. The existing controller still mints and preserves the
exact instance key across a failed-start retry, owns the OAuth return path, and
performs callback preview/install for that exact instance. The shared shell owns
navigation, cancellation, accessible focus and progress semantics, loading, and
safe errors; future thin provider adapters may add reviewed resource pickers or
provider details without turning the shell into a generic schema form or
changing the backend lifecycle.

The normalized rows store the protocol-compiled revision, tools, Integration
and API Facets, Facet installations, and owners under FORCE RLS. They are the
only Integration Definition installation authority; generic API catalog and
installation projections are not written. At turn start, active installations are projected as
ordinary MCP servers and backed by an in-process local adapter. This preserves
the existing bounded lazy tool search, exact session policy, child and schedule
inheritance, approval/action policy, frozen Connection resolver, cancellation,
and auth-needed paths without sending MCP traffic to the provider API.

Safe OpenAPI reads and GraphQL queries may refresh an OAuth credential and retry
exactly once after a provider `401`. A mutation is never replayed after the
provider accepted the request path: OpenGeni refreshes only for a future call
and reports the current outcome as unknown. Credential-bearing redirects remain
disabled and provider response bodies remain bounded.

The owning endpoints are:

- `GET /v1/workspaces/:workspaceId/integrations/definitions`
- `GET /v1/workspaces/:workspaceId/integrations`
- `POST /v1/workspaces/:workspaceId/integrations/preview`
- `POST /v1/workspaces/:workspaceId/integrations/install`
- `GET /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/uninstall-preview`
- `DELETE /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey`
- `GET /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets`
- `GET /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/browse`
- `PUT /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/source`
- `PUT /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey`
- `POST /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/pause`
- `POST /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey/resume`
- `DELETE /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/facets/:facetKey`

One immutable Integration definition may have many active instances. Each
instance has a stable `instanceKey`, human-editable display name, collision-free
runtime MCP id, exact Connection/configuration, optimistic version, and owner
ledger. This supports two Gmail accounts, two Linear workspaces, or several
resource-scoped configurations without copying the schema or overwriting a
sibling. Reconnect and uninstall operate on the exact instance; the underlying
Connection and shared definition survive unless separately removed.

Provider adapters may also publish immutable generic facet definitions for
Knowledge Sources, Inbound Triggers, Delivery Destinations, and Identity Links.
Google Drive and OneDrive expose drive-content Knowledge Sources; Gmail and
Outlook expose mail or calendar trigger/delivery facets and connected-account
identity. These definitions are adapter-owned and cannot be invented or
rewritten by a browser request. Operators configure only a definition's bounded
schema on one exact Integration instance, inheriting that instance's exact
Connection and Personal/workspace authority. Configure, pause, resume, and
remove use caller UUID idempotency plus exact binding-version OCC. The public
projection reports only whether a provider cursor exists; page tokens, delta
links, and other cursor contents remain private durable state. Integration
definition upgrades migrate same-key facets without losing configuration,
cursor, lifecycle status, evidence timestamps, or owner edges, and reject an
upgrade that would silently remove a configured facet.

Google Drive's `drive-content` facet uses a provider-specific editor because
its required schema contains a bounded array of verified folders/Shared Drives
plus a bound document destination. Browse and save resolve the exact named
Integration instance before loading its Connection. Save re-reads every source
from Google, rejects stale client labels/types/drive identities, binds the
organization/workspace/personal destination authority, and writes only the
facet binding. The generic facet `PUT` rejects this provider-owned facet;
only the provider-specific `/source` route may persist its config, so a
schema-valid payload cannot bypass Google metadata checks or forge destination
authority. A sibling Google Drive instance—whether it uses another Google
account or another ownership scope—is never selected by provider/domain
fallback and is not mutated. Generic browser editing refuses required object or
array fields unless a provider-specific flow owns them, so OneDrive and future
rich schemas cannot be submitted as silently incomplete primitive config.

The Definition inventory returns only safe public metadata (id, label, provider
family/domain, protocol, summary, requested scope names, and immutable facet
schemas/capability facts). Deployment OAuth client identifiers, secrets, and
provider cursors never cross this boundary. `/capabilities`
renders that inventory as one service card per immutable definition and one
independent row per named account instance; “Add another account” always creates
a new Connection/binding instead of replacing a sibling.

X and Reddit use the same multi-account control-center model through a
first-party social provider adapter. Their catalog cards are
`provider_integration` projections derived from every visible Personal or
workspace `social_connections` row, not from one preferred singleton. The safe
summary publishes provider-specific connected, needs-reauth, disabled, and
total counts without Connection UUIDs. The detail view then lists exact visible
accounts for the selected ownership, with independent status, disconnect, and
add/reconnect actions. Mixed healthy and repair-needed accounts keep the card in
`needs_attention` without hiding the healthy rows.

New X and Reddit policies use provider-scoped first-party tool identities
(`x_*` and `reddit_*`). Each tool binds the provider namespace and requires an
exact matching connection before provider I/O; aggregate
`social_connections_list`, `social_posts_recent`, and
`social_daily_analysis_context` remain available for cross-provider Pack flows.
Legacy generic live/write `social_*` aliases remain compatibility-only during
rolling migration. The public capability kind remains the compatible `api`
contract value while item metadata and the web label identify the surface as an
Integration.

The web route keeps orchestration separate from catalog presentation.
`capability-catalog-sections.tsx` owns the typed discovery controls, Enabled
section, Browse states, registry fallback, and incremental window sentinel;
provider, source-package, Pack, and connection workflows remain in their owning
components/hooks. Browse renders at most 48 catalog tiles initially and advances
in bounded windows near the scroll edge. Logos stay lazy, integration/source
control centers are code-split, and filtering/searching remains client-local and
deterministic after the single catalog projection arrives. Browser acceptance
exercises a delayed 5,000-row response, proves the initial window bound, and
checks responsive filtering alongside 320/375/768/1280/1440 light/dark,
forced-colors, reduced-motion, keyboard, coarse-pointer, and Axe states.

### Plugin packages

A Plugin is a bounded JSON manifest that groups existing safe component
lifecycles. Schema version `1` accepts at most 64 uniquely keyed components:

- a public `skills.sh` or GitHub Skill URL;
- a protocol-neutral API Integration source; or
- the id of an MCP server already configured by the deployment.

Plugins never embed arbitrary MCP endpoints, deployment header credentials, or
Personal Connection identifiers. A configured MCP with static headers or a
subject-scoped Connection cannot be auto-activated through a Plugin. An
authenticated API Integration instead names a normal active Connection through
the request's per-component `bindings`; the Connection remains independently
owned and is never deleted by Plugin uninstall.

Preview fetches the manifest and every referenced source through the existing
bounded pinned transports, resolves Skills to immutable commits, compiles API
Integrations to immutable revisions, and returns an exact component bill of
materials. Each BOM digest includes the component's immutable source facts, not
only its display metadata. Install repeats resolution and rejects manifest or
component drift with `409`, so a stale preview cannot authorize changed code,
tools, scopes, or deployment MCP configuration.

Install and update use a caller-supplied idempotency key plus an optimistic
installation-version fence. The durable operation journal checkpoints each
completed component. Until every component is present, the top-level Plugin is
`needs_attention` and none of its otherwise unowned child components enter the
runtime. Retrying the exact request with the same idempotency key resumes the
operation; reusing the key for a different request is rejected. Workspace-local
component advisory locks make concurrent Plugins converge on one child
identity. Multiple owners may share the same exact version, but a divergent
version is rejected while another direct, Plugin, Pack, or migration owner is
still pinned to the current version.

An update records a new immutable Plugin version, computes added/removed/
changed/unchanged component keys, and removes stale ownership edges only after
the replacement BOM completes. Uninstall preview reports whether each child is
retained by another owner. Uninstall removes only this Plugin's edges, disables
orphaned child installations, and never removes a shared component or a
Connection.

The owning endpoints are:

- `GET /v1/workspaces/:workspaceId/plugins`
- `POST /v1/workspaces/:workspaceId/plugins/preview`
- `POST /v1/workspaces/:workspaceId/plugins/install`
- `GET /v1/workspaces/:workspaceId/plugins/:pluginKey/uninstall-preview`
- `DELETE /v1/workspaces/:workspaceId/plugins/:pluginKey`

The list projection returns only top-level installed Plugin packages, never the
internal Plugin records that back direct Skills, Integrations, or MCP
components. It contains metadata and immutable/version facts only: Plugin key,
version, source URL, manifest digest, installation version, component count,
status, and timestamps. The SDK mirrors these as `listInstalledPlugins`,
`previewPlugin`, `installPlugin`, `previewPluginUninstall`, and
`uninstallPlugin`.

## Curated skill library

The default sandbox carries no Terraform, Checkov, social-marketing, or other domain methodology guidance. Those Skills live in the immutable curated library under `packages/runtime/src/curated_skill_library/` and are discoverable but uninstalled until explicitly installed through the normal Skill lifecycle, selected for an exact session, or acquired through a Pack. The initial reviewed set is Checkov, Refactor Module, Social Media Marketing, Terraform Search and Import, Terraform Stacks, Terraform Style Guide, Terraform Test, and Azure Verified Modules.

- `id` is stable (`skill:azure-verified-modules` in the catalog).
- `metadata.libraryId`, `metadata.version`, `metadata.contentSha256`, `metadata.sourceCommit`, `metadata.sourceUrl`, `metadata.provenance`, `metadata.license`, `metadata.documentationUrl`, `metadata.compatibility`, and `metadata.upgrade` make provenance inspectable. `contentSha256` is a canonical whole-artifact digest over sorted normalized relative paths and the exact bytes of every recursively materialized regular file, not only `SKILL.md`.
- Entries are immutable. A changed artifact is a new version and hash; install requires the exact reviewed version and whole-artifact hash and returns `409` if the reviewed artifact changed.
- Installing a library Skill stores the exact files plus canonical version/hash/provenance in the normalized Plugin/Skill-Facet ledger. It does not attach a Variable Set, credentials, MCP servers, tools, cloud permissions, tenant access, or model routing. The Skill contributes guidance files to the normal `.agents/` Skill index only.
- Active library skills are resolved by the worker at turn start. A missing entry, unavailable artifact, or hash mismatch fails closed; it never substitutes a different version.

Install the exact reviewed catalog version and hash:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/skills/library/azure-verified-modules/install" \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":"1.0.0","expectedContentSha256":"<reviewed-sha256>"}'
```

The resulting catalog row reports an installed lifecycle. Updating requires the
previewed installation version, and uninstall removes only the direct owner;
the Skill remains active when a Plugin or Pack still owns the same exact
artifact.

### Skill source precedence

The runtime keeps these sources inspectable and separate:

1. active immutable workspace Skill components, whether owned directly, by a Plugin, by a v2 Pack, or by a curated-library selection;
2. legacy pre-v2 Pack inline Skills;
3. inline per-session Skills;
4. repository-local `.agents/skills` or `.claude/skills` discovered at their real mounted path; and
5. native editable-artifact Skills, only after the exact artifact runtime preflight succeeds.

V2 Pack installation resolves names before mutation: identical case-insensitive name plus exact content is one shareable Skill component, while different content under an effective name is a blocking mismatch. It therefore never relies on runtime shadowing. Legacy Pack inline Skills retain their historical precedence only for installations with no frozen manifest snapshot/digest. The effective runtime selection reports source, version, hash, and reason without exposing secrets.

Self-hosted/Connected Machine deployments may omit the curated artifact from their runtime image. Such a deployment omits the entry from discovery and cannot activate it; it does not download, substitute, or silently route the turn to Azure-hosted inference.

### Compatibility and migration

Skill-library installation is workspace-scoped through the authoritative
Plugin/Skill-Facet installation. Existing session rows do not contain a
per-session library pin, so resumed and newly created sessions use the
workspace's active exact-pinned Skill installations plus their
Pack/session/repository sources. This deliberately removes the former
deployment-default domain Skills rather than silently retaining methodology a
workspace never selected. A future per-session pin migration can preserve
historical library context for long-lived sessions if product requirements call
for that stronger continuation guarantee; it must use the same immutable
id/version/hash records and must not broaden authorization.

### Remote Skill imports

Workspace administrators can preview and install a Skill from a public
`skills.sh` URL or a GitHub repository/deep-folder URL. Preview resolves the
repository to an immutable commit, walks only the selected tree, rejects
symlinks, submodules, traversal, invalid UTF-8, duplicate paths, missing
frontmatter, and bounded-size violations, then returns file digests without
returning file contents. Install repeats source resolution and requires both
the previewed commit and whole-artifact SHA-256 to match; source drift is a
`409` and never installs unreviewed bytes. Preview also reports whether that
exact Skill is already installed and its current installation version.
Updating an installed direct Skill requires that optimistic-concurrency
version; omission is rejected and a stale version returns `409`, so two
administrators cannot silently overwrite each other's accepted source
revision.

The authoritative persistence model stores the immutable Plugin version, Skill
facet, exact text files, workspace installation, and component owners under
FORCE RLS. Runtime materialization revalidates the stored artifact and digest
before adding it to the same lazy `.agents/` Skill index as other active
workspace components, session, repository, and native artifact Skills. Uninstall is previewed and
optimistic-concurrency fenced: removing the direct owner retains the Skill when
a Plugin or Pack still owns it, and only the final owner removes it from later
turns. Migration `0233_skill_and_integration_authority_cutover.sql` preserves
exact active curated selections in this ledger, deletes every generic Skill
projection, and constrains the generic catalog/install tables to MCP rows.

The owning endpoints are:

- `GET /v1/workspaces/:workspaceId/skills`
- `POST /v1/workspaces/:workspaceId/skills/library/:libraryId/install`
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
- review, install/update/repair, and ownership-safely uninstall role Packs with explicit Rig/Variable Set selection
- add and enable public MCP Registry results
- add and connect manual MCP integrations through the MCP-only catalog form
- detect, review, authenticate, and install custom OpenAPI or GraphQL APIs
- manage multiple named custom API instances, updates, reconnects, and removals
- import GitHub/skills.sh Skills through immutable file/commit review, then update or remove the direct owner under an installation-version fence
- install Plugin manifests through immutable manifest/component review, bind each credentialed component to one exact active Connection, inspect update diffs, and remove only Plugin-owned components
- select enabled custom MCPs in the agent composer

Workspace-imported Skills and top-level Plugins render in a dedicated **Skills
and Plugins** section instead of the generic catalog grid. Imported Skills are
filtered out of the legacy Enabled/Browse projections so the same installation
never appears twice. Closing and reopening an in-progress source dialog retains
its input and error state; Plugin mutation retries retain one stable idempotency
key, while every changed Connection binding must be re-previewed before the
final install/update action becomes available. Connection-list load failure is
shown as unavailable data, not misreported as an empty account inventory.

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

## Official Gmail MCP

The reviewed catalog includes Google's official hosted Gmail MCP at
`https://gmailmcp.googleapis.com/mcp/v1`. It is currently a Google Developer
Preview. OpenGeni requests only the three scopes used by the reviewed tool
surface:

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/gmail.modify`

Those scopes support search/read, draft creation, and the reviewed label and
unlabel operations. The Google scope is broader than the exposed tools, but the
reviewed Google MCP surface and REST fallback do not expose a direct-send or
delete tool. Gmail OAuth is handled by the ordinary encrypted connection broker,
with a narrow Google
compatibility path: authorization requests ask for offline consent, Google
authorization/token origins are pinned, and the RFC 8707 `resource` parameter
is omitted from Google's authorization, token, and refresh requests. The MCP
resource remains stored in the encrypted bundle and bound to the runtime
connection.

Gmail is personal-only. Enabling the capability makes Gmail available in the
workspace catalog, but it does not share a mailbox: each member must authorize
their own Google account. Personal connection rows and identifiers are hidden
from other members, and a turn can execute Gmail only through the initiating
member's frozen personal delegation. OpenGeni rejects workspace-owned Gmail
OAuth and capability bindings at the API boundary. Gmail content that a user
asks the agent to quote, summarize, or otherwise add to a session follows that
session's visibility; connection privacy does not turn a shared session into a
private one.

The catalog also pins the exact ten tools in Google's reviewed Developer
Preview surface. A newly added remote tool is unavailable until the catalog
contract is reviewed and updated. Draft creation and label/unlabel tools require
the ordinary durable human approval; search, message/thread reads, draft lists,
and label lists do not.

While hosted MCP enrollment is pending, a deployment can set
`OPENGENI_GMAIL_REST_ADAPTER_ENABLED=true`. This opt-in substitutes a bounded
Gmail REST implementation for that exact official MCP endpoint in agent turns
and the attempt-frozen Codemode projection; it does not create a second
capability or connection. The
adapter preserves the reviewed ten-tool allowlist, tool names, output field
shape, subject-owned delegation, and approval policy. Its credential broker
binding permits only `https://gmail.googleapis.com/gmail/v1/users/me/...`: it
cannot call another Google API or address another mailbox. Read-only calls may
refresh after one 401 and retry once; a mutation is never replayed after an
ambiguous provider response. Keep the flag off by default and disable it after
the hosted endpoint works for the enrolled account and project.

Before importing/enabling the capability in a deployment:

1. Join the [Google Workspace Developer Preview
   Program](https://developers.google.com/workspace/preview) with the Google
   Workspace account that will authorize Gmail. Include the deployment's exact
   Google Cloud project in the application and wait for Google to confirm that
   both the account and project are registered. Enabling the APIs and granting
   OAuth scopes alone is not sufficient for the hosted MCP preview.
2. In that registered Google Cloud project, enable both the Gmail API and Gmail
   MCP API, configure the OAuth consent screen, and create a **Web application**
   OAuth client.
3. Register
   `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/oauth/callback` as an authorized
   redirect URI.
4. Set `OPENGENI_INTEGRATIONS_ENABLED=true`, configure the normal integration
   state/encryption secrets, and add the deployment-owned client:

   ```dotenv
   OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON='{"https://accounts.google.com":{"clientId":"...","clientSecret":"...","tokenEndpointAuthMethod":"client_secret_post"}}'
   ```

5. Run the normal reviewed catalog import, open **Capabilities**, search for
   **Gmail**, and select **Connect only for me**. The ownership choice is fixed:
   every member connects their own mailbox, and other workspace members cannot
   see or use it.

The fixed tool allowlist and approval defaults are defense in depth for the
provider's Developer Preview behavior. See Google's [configuration
guide](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
and [MCP tool
reference](https://developers.google.com/workspace/gmail/api/reference/mcp).

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
