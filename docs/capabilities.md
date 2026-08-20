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

MCP tool refs are strict by default. A newly submitted bare `{ "kind": "mcp", "id": "docs" }` must name a server configured for this deployment, and a runtime connect/list failure fails closed when the turn demands that server's catalog or a tool. Startup eagerness is independent: only an exact session ref with `"eager": true` makes connection and schema admission a first-model-request barrier. A client or pack can mark a ref `{ "kind": "mcp", "id": "context7", "optional": true }` to make it portable: if the deployment does not configure that server the ref is skipped during validation, and if the server is configured but unavailable at runtime it is skipped for that turn with a warning. Persisted refs have a separate turn-time safety rule: if a previously valid server is later disconnected, disabled, or removed from the runtime registry, OpenGeni preserves that selection in the session's effective-policy audit projection but omits it from executable tools for the turn. The model receives a bounded system notice naming the unavailable server and must not claim to have read or updated it, so one disappearing integration cannot trap every later chat turn in an `Unknown MCP server id` failure loop.

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

The probe runs with those headers, and on success the values are stored encrypted (AES-256-GCM under `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, like workspace variable set values) on the installation. At runtime the worker decrypts them and sends them only to that MCP server. The API never returns header values - installation responses expose the stored header names only. Re-enabling without a `headers` field reuses the stored credentials; passing `headers` replaces them.

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

Installed custom APIs appear as ordinary rows in the Connectors section's
Custom APIs list rather than the legacy generic “Add custom” catalog dialog.
Multiple named instances of one definition
remain independent (for example, `Linear - Finance` and `Linear - Sales`), with
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
Connection for reconnect/incremental consent. Ownership is optional on the wire,
but a new Connection whose provider allows both ownerships must state one: an
omitted value is a 422 rather than a silent choice, because defaulting to
`personal` inverts the documented default and defaulting to `workspace` would
share a newly connected mailbox with the whole workspace. A reconnect keeps the
existing Connection's ownership. Requesting `personal` requires an authenticated
human — an API key, the `configured:` key, a service principal, or an agent
attempt is refused with a 422 rather than owning a personal Connection. Google can reuse the deployment's
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

In the web app, curated Definitions enter that flow with no account-naming
form: every curated Definition today is oauth2-only and already reviewed
(Official), so starting or adding an account is a single click that redirects
straight to the provider's own consent screen - that screen is the disclosure,
not a local step. `apps/web/src/components/capabilities/use-api-integration-accounts.tsx`
mints and preserves the exact instance key across a failed-start retry, owns
the OAuth return path (`apiIntegrationOAuthReturnPath`/`pendingApiIntegrationOAuth`,
matched by `definitionId` in the URL so one shared effect handles every
provider's return regardless of how many rows are on screen), and performs
callback preview/install for that exact instance before folding it into its
provider row's Connected accounts block. A local step exists only for an
*uncurated* Connector whose `oauth2` is not yet reviewed: one line naming the
domain, rendered by the shared `quick-connect-dialog.tsx` described above.

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
sibling. A personal instance's Connection may be rebound only by its exact
subject, and the replacement Connection must retain that same subject; workspace
administration alone never transfers it. Reconnect and uninstall operate on the
exact instance; the underlying Connection and shared definition survive unless
separately removed.

Provider adapters may also publish immutable generic facet definitions for
Knowledge Sources, Inbound Triggers, Delivery Destinations, and Identity Links.
Google Drive and OneDrive expose drive-content Knowledge Sources; Gmail and
Outlook expose mail or calendar trigger/delivery facets and connected-account
identity. In the web app these live in
`apps/web/src/components/capabilities/integration-facets-panel.tsx`, mounted
per account entry inside the integration sheet's **Connected accounts** block
through the lazy `integration-account-facets.tsx` boundary (which also carries
the provider-specific Google Drive knowledge-source dialog). The panel is
scoped to exactly one `capabilityId`/`instanceKey`/`instanceVersion` and is
omitted entirely for a definition that publishes no facets. These definitions
are adapter-owned and cannot be invented or
rewritten by a browser request. Operators configure only a definition's bounded
schema on one exact Integration instance, inheriting that instance's exact
Connection and Personal/workspace authority. Configure, pause, resume, and
remove use caller UUID idempotency plus exact binding-version OCC. The public
projection includes the effective owner ledger plus an exact `directlyOwned`
decision for the requested capability/instance/facet identity; clients must not
infer current control from the presence of some unrelated `direct` owner. A
Pack-, Plugin-, migration-, or other-direct-owned binding is read-only in the
direct Integration controls. Removing a direct owner reports when another
owner retains the binding instead of presenting the shared facet as deleted.
The projection reports only whether a provider cursor exists; page tokens,
delta links, and other cursor contents remain private durable state.
Integration definition upgrades migrate same-key facets without losing
configuration, cursor, lifecycle status, evidence timestamps, or owner edges,
and reject an upgrade that would silently remove a configured facet.

Google Drive's `drive-content` facet uses a provider-specific editor because
its required schema contains a bounded array of verified folders/Shared Drives
plus a bound document destination. Browse and save resolve the exact named
Integration instance before loading its Connection. Save re-reads every source
from Google, rejects stale client labels/types/drive identities, binds the
organization/workspace/personal destination authority, and writes only the
facet binding. The generic facet `PUT` rejects this provider-owned facet;
only the provider-specific `/source` route may persist its config, so a
schema-valid payload cannot bypass Google metadata checks or forge destination
authority. A sibling Google Drive instance-whether it uses another Google
account or another ownership scope-is never selected by provider/domain
fallback and is not mutated. Generic browser editing refuses required object or
array fields unless a provider-specific flow owns them, so OneDrive and future
rich schemas cannot be submitted as silently incomplete primitive config.

The Definition inventory returns only safe public metadata (id, label, provider
family/domain, protocol, summary, requested scope names, and immutable facet
schemas/capability facts). Deployment OAuth client identifiers, secrets, and
provider cursors never cross this boundary. `/capabilities` renders that
inventory as exactly one provider row per integration, with every named account
instance folded into that row's **Connected accounts** block; “+ Add account”
always creates a new Connection/binding instead of replacing a sibling.

X and Reddit use the same multi-account model through a
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
components/hooks. The whole workspace-scoped data load lives in
`use-capabilities-catalog.tsx`, which fences every response on the exact client
and workspace it was requested for, so switching workspaces mid-flight can never
populate the new workspace with the previous one's connections, definitions, or
installed instances. Browse renders at most 48 catalog tiles initially and
advances in bounded windows near the scroll edge. Logos stay lazy, the custom-API
wizard, the Drive folder picker, and the per-account facets panel are code-split,
and filtering/searching remains client-local and deterministic after the single
catalog projection arrives - including the Custom APIs list, which answers the
same query as every other connector instead of ignoring it. Browser acceptance
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

The **Capabilities** view has exactly three top-level sections, in this order:
**Integrations**, **Connectors**, and **Bundles**. The first two are
connections - something that holds an identity in another product. The third is
not: a Bundle is a named collection of tools and instructions.

The heading outline says the same thing: exactly three `<h2>`s, one per
section. The Featured strip, the discovery controls, **Enabled**, **Custom
APIs**, and **Browse** all render *inside* the Connectors `<section>` element,
and Enabled and Browse are `<h3>`s under it - they are views of Connectors, not
surfaces of their own.

**Integrations** are built and run by OpenGeni: Slack, GitHub, Google Drive,
Jira & Confluence, Outlook Mail, Outlook Calendar, Outlook Contacts, and
OneDrive. They receive events, post as OpenGeni, and hold their own identity in
the other product. Every integration renders through the same two components
(`apps/web/src/components/capabilities/integration-row.tsx` and
`integration-sheet.tsx`) fed by one plain view-model
(`integration-view-model.ts`); one adapter hook per provider
(`use-slack-integration.tsx`, `use-github-integration.tsx`,
`use-google-drive-integration.tsx`, `use-atlassian-integration.tsx`,
`use-outlook-mail-integration.tsx`, `use-outlook-calendar-integration.tsx`,
`use-outlook-contacts-integration.tsx`, `use-onedrive-integration.tsx`) maps
that provider's data onto the view-model and picks the content for the
viewer's role. There is exactly one row per provider, never one row per
account and never a separate control center: the shared multi-account layer
(`use-api-integration-accounts.tsx`) folds every curated `IntegrationDefinition`
instance a provider has (Outlook Mail/Calendar/Contacts, OneDrive, and extra
Google Drive accounts beyond the primary knowledge connection) into that one
row's rolled-up state. The row and the sheet contain no provider-specific
branch; every account/provider difference lives in the adapters.

- Each row shows mark, name, one-line description, and a compact circular
  connection-state indicator in place of a text chip: a filled check for
  `Connected`, a triangle for `Needs attention`, a plus for `Not connected`
  *when a fast connect path exists*, a muted dot for every other
  non-interactive state (`Set up by an admin`, and `Not connected` with no
  fast path), and a spinner while `Loading` or while that row's own mutation
  is in flight. The click target is split: the large body button opens the
  detail sheet, and its accessible name is `"<name>. <state>"`; the small
  trailing indicator is a separate sibling button that is the one fast connect
  path when the current state is `Not connected`, a dialog-free or one-dialog
  connect action exists, and nothing is already running (guarding on that
  in-flight state is what stops a double click from starting two redirects) -
  for every other state it is purely decorative, never a dead click target,
  and carries its state as visually hidden text so colour and shape are never
  the only signal. There is one sheet, always the same one; there is no
  lightweight preview variant. No inline scope text or per-provider buttons on
  the row itself.
- The detail sheet is a fixed frame with blocks in fixed order, empty blocks
  omitted. **Connection** is label/value facts; **Access** is the scoped
  resources (channels, repositories, folders, projects and spaces) with
  exactly one edit affordance - for a multi-account provider this block
  becomes **Connected accounts**: one entry per account, keyed on its own
  `instanceKey` so a status change never remounts the row and steals focus,
  with a status dot (`ok`/`warn`), optional meta text, its own inline
  per-item actions (`Reconnect` only when that account is unhealthy,
  `Remove` always, confirmed before it destroys anything), and its
  per-instance **Facets** panel (below) expanded in place under the entry.
  Google Drive's primary knowledge connection is one such entry, and the
  folders it contributes stay visible as its sub-entries rather than
  disappearing when a second Drive account exists. A `+ Add account`
  edit-link sits in the block header;
  **Options** are switches (and, where a setting is a choice, a compact
  select); **Tools** is a flat, purely informational, monospace chip grid of
  the tool/function names the connection actually publishes (no toggles, no
  per-tool detail), populated only from an already-available cheap source
  (a stored allowlist) and omitted entirely when unavailable; **Action** is a
  footer from a closed set: `Reconnect` + `Disconnect` when connected, the
  same pair with `Reconnect` primary when broken, `Set up` when not connected,
  or a locked sentence when the viewer cannot change anything (a multi-account
  row with at least one account also uses the locked sentence, pointing the
  viewer at the Connected accounts block above instead of an ambiguous
  whole-row Reconnect/Disconnect). The locked sentence defaults to "A
  workspace admin looks after this integration. You do not need to connect
  anything."; an adapter may supply a truthful variant instead (e.g.
  personal-only Slack tells a member that connection management permission is
  required, because no admin can connect it for them). Provider limited-use
  disclosures (Google's OAuth disclosures) render in a fixed place above the
  footer, and the connect/publish affordances reference them via
  `aria-describedby`.
- Role changes content, never layout. Anyone with connection management
  permission (`connections:write` or workspace admin) sees the Slack bot
  (installation facts, what OpenGeni can see, and install/reconnect/disconnect);
  the reaction shortcut, knowledge destination, and decision publication options
  stay admin-gated inside that sheet. Everyone else sees their own personal
  Slack account. Nobody is offered both. Deep provider dialogs (the Drive
  folder picker, the Jira/Confluence source picker, the reaction conversation
  picker, the Slack decision-publication settings) open from the Access block's
  single edit affordance or an option's action link.
- Adding an account to a multi-account provider (Outlook, OneDrive, extra
  Google Drive accounts) is a zero-dialog, straight OAuth redirect - every
  curated `IntegrationDefinition` today is oauth2-only and already reviewed,
  so there is no account-naming form first. The one shared
  `quick-connect-dialog.tsx` component exists for the two authKind cases that
  do need a screen (`api_key`: one field, no scope bullet list; unreviewed
  `oauth2`: one line naming the domain), and is reused by both the "+ Add
  account" action and the Connectors row-icon fast path described below.
  Gmail is not a multi-account provider: it is a single personal-only
  Connector, not an API integration definition (see the Gmail section below).

**Connectors** are MCP servers from the catalog, plus workspace-defined Custom
APIs (OpenAPI/GraphQL) - there is no third bucket. The existing `authKind`
field (`"none" | "oauth2" | "api_key" | "unknown"`) already carries every
behavioral difference the connect flow needs, so Custom API connectors use the
exact same click-split/quick-connect treatment as any other Connector.
Connection setup defaults to workspace-owned; a personal connection requires
the explicit **Connect only for me** choice (official Gmail and Slack's hosted
MCP are the personal-only exceptions). The row-icon fast path resolves that
ownership through exactly the same rule as the detail sheet
(`capabilityQuickConnectPlan` in `apps/web/src/lib/capabilities.ts`), so a
one-click connect can never start a workspace-owned binding for a personal-only
connector. It also stores an api-key credential under the field's **wire header
name**, never its human label, and declines the fast path entirely for a
connector declaring more than one required header - a single-field dialog would
otherwise store half a credential that only fails later as a 401.
Inside that section a **Featured** strip of tiles driven by curated
`metadata.curation.featured` leads, followed by the searchable long tail: the
enabled catalog strip, then a **Custom APIs** list of already-installed
workspace-defined instances (`CustomApiSection`), then the Browse grid. The
enabled strip carries only `mcp`/`api` rows, so its one remove affordance is
**Disconnect**; removing a Skill lives in the Bundles section.

The Connectors search and kind filters are scoped to Connectors. The catalog is
narrowed to `kind: "mcp"` and `kind: "api"` items once
(`isConnectorCatalogItem` in `apps/web/src/lib/capabilities.ts`) before the
Featured, Enabled, Browse, and count projections are derived, so no Skill,
Plugin, or Pack row can appear in any of them and the chip counts describe what
that grid can actually show. `CAPABILITY_FILTERS` therefore offers exactly
`All`, `MCP servers`, and `APIs`. Skills, Plugins, and Packs have their own
search in the Bundles section below.
Tile badges are only `Official` (curated `metadata.curation.official`) and
`Built by OpenGeni` (first-party bridges such as Fiken); nothing is ever
labelled reviewed or verified. Every tile shows the same connection-state
indicator and click-split as an Integrations row: the icon is the fast
connect path, the rest of the tile opens the detail sheet. Custom API
*creation* (paste an OpenAPI/GraphQL source URL, preview, pick tools,
authenticate, create) stays its own multi-phase wizard
(`custom-api-setup-dialog.tsx`, reachable from the Custom APIs list's own
**Connect custom API** button) - that is a fundamentally different "define a
new connector from a spec" flow, not a catalog connect. Once created, a
custom API instance is an ordinary row
fed directly from `listApiIntegrations` filtered to
`definitionProvenance === "workspace"`, not a `CapabilityCatalogItem`; this is
a deliberately narrower fold-in than making custom APIs first-class catalog
citizens, to avoid touching unrelated `kind: "api"` catalog-builder behavior.

Open the **Capabilities** view in the web app to:

- filter and search the local catalog
- review, install/update/repair, and ownership-safely uninstall role Packs with explicit Rig/Variable Set selection, and register a Pack manifest of your own
- add and enable public MCP Registry results
- add and connect manual MCP integrations through the MCP-only catalog form
- detect, review, authenticate, and install custom OpenAPI or GraphQL APIs
- manage multiple named custom API instances, updates, reconnects, and removals
- import GitHub/skills.sh Skills through immutable file/commit review, then update or remove the direct owner under an installation-version fence
- install Plugin manifests through immutable manifest/component review, bind each credentialed component to one exact active Connection, inspect update diffs, and remove only Plugin-owned components
- select enabled custom MCPs in the agent composer

**Bundles** are Skills, Plugins, and Packs: a named collection of tools and
instructions, not a live connection to anything. Install one and everything
inside it becomes available together. They render in one section
(`bundles-section.tsx`) with one heading, one bundle-scoped search with a
count, and one uniform row - the same `IntegrationRow` the Integrations list
uses, so the whole list scans as one thing. A row is never given the
quick-connect fast path: installing a Bundle always needs at least a
confirmation, so the trailing state indicator stays decorative. The bundle
chip vocabulary is the widened closed set in `integration-view-model.ts`
(`Installed`, `Not installed`, `Update available`, `Installing`, plus
`Needs attention`); a Bundle is never labelled `Connected`.

Three provenances coexist and each is named on the row itself, as
`<Kind> · <Provenance> · <description>`:

- **Curated by OpenGeni** - the reviewed curated Skill library, and the Pack
  manifests OpenGeni ships (`source: "built_in"` catalog rows).
- **Registered in this workspace** - a Pack manifest any workspace admin
  registered through **Add manifest** (`registerPackManifest`; the entry point
  is a paste-JSON dialog in the section header, `source: "manual"` catalog
  rows).
- **Imported from source** - a Skill imported from GitHub/skills.sh, or a
  Plugin installed from a reviewed manifest URL.

A Pack's provenance is read from its `pack:<id>` catalog row, and Packs and the
catalog load independently, so "no matching row yet" resolves to *unknown*
rather than `built_in`: the row simply omits the provenance segment until the
catalog arrives instead of briefly claiming OpenGeni curated it. The row's
`aria-label` replaces its own contents, so each row also supplies an
`accessibleDetail` ("Pack, curated by OpenGeni") that `IntegrationRow` speaks
between the name and the state - it renders whatever string it is given and
branches on no kind. The bundle search matches name, description, category,
tags, and source, plus the kind word itself as a discrete token, so narrowing
to `pack` cannot also return every Plugin whose text contains "package".

Only the detail differs, and only where it genuinely must. An imported Skill or
Plugin opens the same four-block `IntegrationSheet` an Integration does, with
its immutable pinned identity as **Connection** facts and an `actions` footer
(`Check for update` / `Review update`, and `Remove`); a viewer without
workspace-administrator authority gets the locked sentence instead of inert
buttons. A catalog Skill keeps the catalog detail sheet
(`capability-detail-sheet.tsx`), which already owns its reviewed library
identity, install/update/remove, and immutable provenance panel. A Pack opens
`PackDetailDialog` (`pack-dialogs.tsx`), because choosing a Rig and a Variable
Set, reviewing an exact component plan, and uninstall/unregister do not
compress into four blocks. Opening a Pack row *is* the review request, so the
plan resolves immediately rather than behind a second button. That dialog names
the installed identity a repair or a version comparison turns on - manifest
version, role, category, the installed manifest digest, and the Pack's own
description - under its header, because the title only ever carries a name.

No `kind: "plugin"` catalog item is produced anywhere today, and both catalog
Skills and Packs are scoped out of the Connectors projections by kind rather
than by a per-row filter, so the same installation never appears twice and the
Connectors grid cannot silently start showing a Bundle if the catalog builder
changes. Closing and reopening an in-progress source dialog retains its input
and error state; Plugin mutation retries retain one stable idempotency key,
while every changed Connection binding must be re-previewed before the final
install/update action becomes available. Connection-list load failure is shown
as unavailable data, not misreported as an empty account inventory. A footer
action that opens the import stepper or a removal confirmation closes the sheet
first: one modal surface at a time.

`/workspaces/:workspaceId/packs` redirects to `capabilities?section=packs`,
which now scrolls the Bundles section into view instead of selecting a kind
filter the Connectors grid no longer offers.

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

Those scopes support search/read, draft creation, approval-gated sending
(`send_message`, `send_draft`), and the reviewed label and unlabel operations.
The Google scope is broader than the exposed tools, but the reviewed surface
does not expose a delete tool, and every send requires durable human approval
first - not a workspace setting. Gmail OAuth is handled by the ordinary
encrypted connection broker,
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

Gmail is the single connector path for the provider: the catalog row's
`gmailmcp.googleapis.com/mcp/v1` resource is the connection and consent
identity, but every tool call executes against a first-party OpenGeni bridge
over Gmail's REST API (`packages/runtime/src/gmail-rest-mcp.ts`), never
against Google's Developer Preview MCP endpoint directly. There is no
per-deployment toggle: the bridge is unconditional. This is also why Gmail has
no separate OpenAPI API-integration definition and no REST-adapter fallback
mode - both existed only while the bridge coexisted with a direct-passthrough
option; consolidated onto one path, they were removed rather than deprecated.

The catalog pins the exact twelve tools in the reviewed surface (the
Developer Preview's ten plus `send_message`/`send_draft`, which the real
Developer Preview server does not offer at all). A newly added tool is
unavailable until the catalog contract is reviewed and updated. Draft
creation, both send tools, and label/unlabel tools require the ordinary
durable human approval - mandatory, not a workspace setting; search,
message/thread reads, draft lists, and label lists do not. The bridge's
credential broker binding permits only
`https://gmail.googleapis.com/gmail/v1/users/me/...`: it cannot call another
Google API or address another mailbox. Read-only calls may refresh after one
401 and retry once; a mutation (including both send tools) is never replayed
after an ambiguous provider response - it fails closed with an explicit
"outcome is uncertain" error instead of risking a duplicate send.

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
merge. The refresh reads the integrations.sh index (`api.json`), hydrates one
per-domain discovery document (`/api/{domain}/discovery`) for every distinct MCP
domain it lists because the index no longer embeds MCP endpoints itself, and
then probes every candidate endpoint with an MCP `initialize` request. Only
endpoints that answer as MCP (a JSON-RPC or SSE reply, or a `WWW-Authenticate`
challenge) survive; a transient connection error, timeout, or 5xx is retried a
bounded number of times before it evicts a row, while a definitive 404 or
non-MCP body is never retried. Committed rows whose endpoint upstream no longer
lists stay candidates and are re-probed like every other row (`--no-retain`
disables this), so a reviewed first-party endpoint that integrations.sh never
indexed survives exactly as long as it still answers. Because a retained row is
re-emitted byte-identical, the snapshot header records every retention decision
under `retention` (`candidateRows`, the kept `retainedRows` keyed by domain plus
canonical `mcpUrl`, and `droppedRows` with the evicting reason) so an upstream
delisting is visible in the PR diff rather than a zero-diff no-op. A refresh
that yields zero upstream candidates fails instead of rewriting the committed
file, and one that would keep fewer than half of the committed rows also fails
because that is a probe outage (DNS, proxy, rate limiting, budget exhaustion)
rather than upstream evidence; importing such a file would mark every missing
registry row stale. `--allow-shrink` overrides that floor for a genuine mass
delisting. Upstream fetches never follow redirects and are byte-bounded, and a
malformed committed snapshot or committed row fails the refresh loudly instead
of silently disabling retention. `--input <raw.json>` accepts either an
already-hydrated upstream document or a precomputed `importRows` snapshot for
offline reruns.
Standard Helm installs and upgrades import that committed snapshot by
default through the `catalogImport` hook Job; set `catalogImport.enabled=false`
to opt out. The default `catalogImport.skipLogos=true` keeps deployment success
independent of third-party logo hosts by skipping network logo fetches for the
uncurated long tail; curated connectors still ship their logos from the
vendored assets described below, so the default install is not monogram-only.
Set it to `false` to additionally fetch, validate, and self-host long-tail
logos. `bun run dev` also
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
excluded from default workspace catalog listings. An upstream domain rekey
(for example the Atlassian row moving from `atlassian.net` to `jira.com`)
produces a new capability id and marks the old row stale, so a workspace that
enabled the old row must re-enable the rekeyed one.

### Curated overlay

The snapshot is raw aggregator output: names are unnormalized and its `tier`
says nothing about trust. `data/catalog/curated.json` is the committed overlay
that fixes that, applied during the same normalization pass and keyed by exact
canonical MCP URL. Every field is optional; a supplied value wins over the
snapshot and an omitted one falls through unchanged, so a name-only entry is a
pure branding fix while a full entry can pin the reviewed first-party contract
(scopes, allowed tools, approval, ownership, docs, logo policy). It replaces the
in-code maps that previously carried the Gmail, Slack, and Mobbin contracts, and
its parser fails the import loudly on any malformed entry rather than silently
shipping the raw aggregator row.

Two curated flags surface in the product. `featured` places a connector in
the Featured strip above the Browse grid. `official` renders an "Official" marker meaning
the provider publishes the MCP server on its own domain. Both are checkable
claims recorded in the row's `metadata.curation`; neither is a security review,
and the UI must never label a connector as reviewed or verified. Every entry
must be backed by the provider's own current documentation, and its `notes`
field records the reasoning for reviewers. Editing the overlay is the same PR
workflow as the snapshot: change the file, re-run the import, review the diff.
The overlay's canonical parsed form is part of the `--if-changed` import
fingerprint, so an overlay-only change lands on the next deploy while a
whitespace-only reformat does not trigger a re-import. Every entry must be
written in canonical MCP URL form and must match an importable snapshot row;
the import fails loudly on an unknown key, a non-canonical URL, or a curated
entry that matches nothing, because each of those would otherwise silently
ship the raw aggregator row.

Every overlay match also records `metadata.curation.curated: true`. That fact
is presentation provenance, not a badge or a security review. The web browser
uses it to place synthesized first-party rows and the reviewed connector set
before the raw aggregator long tail in the initial bounded window. Rows with a
self-hosted logo follow, then ordinary long-tail names, with hostname- and
machine-id-like labels last. Search still filters the complete catalog before
this stable presentation sort, so no imported row is hidden or made
undiscoverable. `official` remains the narrower evidence-based provider-domain
claim and is the only one of these facts rendered as an Official badge.

Curated `category` values are grouping slugs rendered through a display-label
map in the web app. The API retains its stable `kind`, `category`, `name`
ordering; the connector browser applies the presentation-only stable grouping
above after search and filtering.

Imported logos are validated as images below 512KB and stored through OpenGeni
object storage under `catalog-assets/...`; catalog rows store only the
self-hosted `logoAssetPath`, never the third-party logo URL, and record where
the bytes came from in `metadata.logoSource` (`vendored`, `integrations.sh`, or
`generic_monogram` when no asset exists). The normalization pass strips raw
control characters from string fields, collapses duplicate `(domain, name)`
clusters to the best deterministic row, skips known-dead demo domains, and
quarantines flagged suspicious URLs in the batch details for manual review.

### Vendored logos

A default deployment must not depend on integrations.sh or any other logo host
being reachable at deploy time, yet the curated connectors should still render
their logos rather than monograms. `data/catalog/logos/` therefore holds one
committed asset per curated row whose effective logo source is published,
plus `manifest.json` recording provenance for each (capability id, domain,
canonical MCP URL, source URL, SHA-256, content type, byte size, fetch time).
The importer copies a vendored asset into object storage under the same
`catalog-assets/...` key a fetched logo would use, in every mode: `--skip-logos`
suppresses only network fetches for the uncurated long tail, because a
vendored copy adds no third-party dependency. A curated `logoSourceUrl: null`
(currently Gmail and Mobbin, which publish no reusable logo licence) always
wins: no asset is vendored for such a row and a stray vendored file for it is
ignored. A vendored entry whose recorded source no longer matches the row's
effective source, or whose bytes no longer match its digest, is not served;
the import records a visible logo failure and the row falls back to the
monogram until the directory is regenerated. The manifest's canonical form is
part of the `--if-changed` import fingerprint, so adding or replacing a
vendored asset lands on the next deploy.

Regenerate the directory with `bun run catalog:vendor-logos` (add `--dry-run`
to preview). It fetches each curated row's logo once, applies the same
image-content-type and size validation the importer applies, refuses to write
an invalid response, keeps a still-valid prior asset when a refetch fails, and
removes files no curated row references. Review the diff and commit it like a
snapshot or overlay change; the committed manifest is checked in tests to cover
exactly the curated rows that permit a logo, byte for byte.

Fiken, X, and Reddit are synthesized first-party catalog rows rather than
integrations.sh imports, so they cannot receive an importer-owned
`logoAssetPath`. Their three passive SVG marks ship with the web build under
`apps/web/public/capability-logos/`, beside a small provenance manifest. The
browser prefers those local marks for the exact built-in ids and otherwise uses
the normal self-hosted catalog asset URL. Missing or invalid bytes still fall
back to the same monogram. Keep this exception limited to first-party rows;
registry marks continue to belong in the reviewed vendoring pipeline above.
