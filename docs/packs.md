# Capability Packs

Capability Packs are role-oriented bundles that compose existing OpenGeni primitives rather than creating a second runtime. A Pack may describe:

- exact Plugin, Skill, Integration-instance, and Integration-feature components;
- legacy inline Skills that the v2 installer migrates into ordinary immutable Skill components;
- an explicit Rig requirement, including compatibility with a legacy `sandboxImage` declaration;
- MCP tool selections, connector requirements, and optional knowledge;
- a Variable Set requirement;
- scheduled-task templates and task metadata.

The built-in `marketing-social-daily-analysis` Pack connects social accounts, attaches marketing knowledge, and creates an ordinary scheduled agent run. It has no component or Rig plan, so it remains compatible with the simple legacy enable route.

## Product model

The user-facing model is intentionally simpler than the storage model:

- **Pack — what:** a reviewed solution recipe that adds or references Skills, Integrations, templates, policies, and automations.
- **Connection — whose account:** one authenticated Gmail, Linear, Slack, or other provider account. Provider credentials never move into a Pack or Variable Set.
- **Compute environment — where:** the normal OpenGeni compute choice, or a compatible versioned Rig only when the Pack genuinely requires special tooling.
- **Configuration & secrets — extra runtime values:** an existing encrypted Variable Set selected only when the Pack declares required variable names.

Most Packs require neither special compute nor extra configuration, so those choices stay hidden. A Pack never changes the workspace's default compute, embeds account credentials, or owns secret values. Pack-created scheduled work may inherit the selected Rig and Variable Set; unrelated workspace sessions do not.

The portable Pack manifest is the **blueprint**. Installation preview resolves it into an exact workspace-local **installation plan**: pinned component versions, named Integration instances, and any selected Rig or Variable Set. Users review the plan; they do not manually author database UUIDs or content digests in the ordinary product flow.

## Invariants

1. **A Pack is composition, not a parallel runtime.** Pack-created work still uses ordinary sessions, Skills, Integration adapters, Rigs, Connections, Variable Sets, and scheduled tasks.
2. **Review precedes mutation.** Component resolution, the exact manifest digest, Rig compatibility, and required Variable Set names are returned by installation preview. Install rejects source drift and unresolved required components.
3. **Ownership is shared and reversible.** Pack ownership uses the same normalized component ledgers as direct installs and Plugins. Uninstall removes only the Pack's owner edges; exact components retained by another direct, Plugin, Pack, or migration owner remain active.
4. **Only active owners affect runtime.** An `installing`, `needs_attention`, or `disabled` Pack owner does not make an otherwise unowned component executable. A partially completed Pack therefore cannot leak a half-installed runtime.
5. **V2 runtime comes from components plus a Rig.** A v2 installation is identified by its frozen `manifestSnapshot` and `manifestDigest`. The worker does not directly load that manifest's inline Skills or `sandboxImage`; the installer already migrated those Skills and selected a Rig.
6. **Connections remain independent.** A Pack may adopt an exact named Integration instance or feature binding, but uninstalling the Pack never deletes the underlying Connection.
7. **Tenant boundaries are enforced twice.** Pack installation, selected Rig, component ledger, and operation rows are workspace/account scoped under FORCE RLS, and database triggers reject cross-tenant Rig or ledger references.

## Manifest composition

`components` contains uniquely keyed immutable references:

| Kind | Exact identity checked during preview |
|---|---|
| `plugin` | `pluginKey`, version, and manifest SHA-256 |
| `skill` | capability ID and whole-artifact content SHA-256 |
| `integration` | capability ID, named `instanceKey`, immutable revision ID, and content SHA-256 |
| `feature` | capability ID, named `instanceKey`, feature key, binding key, and exact configuration SHA-256 |

Each reference is required by default. A missing or mismatched optional reference is reported in preview but does not block installation; a required one does.

### Inline Skill migration

The manifest `skills` field is retained for compatibility, but v2 installation converts each inline Skill into the ordinary immutable Skill persistence model:

- its complete normalized file artifact receives one SHA-256;
- its canonical identity is based on case-insensitive Skill name plus exact content hash, not Pack ID;
- two Packs declaring the same name and exact content share one Skill installation with two Pack owners;
- an effective Skill with the same case-insensitive name but different content is a preview-time mismatch;
- uninstalling one Pack retains the Skill while another effective owner remains;
- uninstalling the final owner removes the Skill from later turns.

The Pack manifest and component ledger retain the Pack provenance even when the underlying Skill artifact is shared.

### Rig requirements and legacy images

New Pack definitions should use `rig`:

- `required` defaults to `true`;
- `rigId` pins the Pack to one workspace Rig and cannot be overridden by the caller;
- `requireVerified` requires the selected Rig's active version health to be passing;
- `description` explains the compute requirement in review UI.

Legacy `sandboxImage` also makes Rig selection required. Preview accepts only a Rig whose active version has that exact logical image. The installer stores `selectedRigId`; Pack-created scheduled tasks inherit it, and each resulting session freezes the Rig version that is active when that session is created.

`sandboxProviderImages` is retained as legacy manifest provenance. V2 installation does not copy or execute that Pack field directly. Provider-native acceleration belongs to the selected Rig's verified active version; see [`rigs.md`](rigs.md).

## Installation lifecycle

### Register

Workspace administrators register or replace a manifest at:

```text
POST /v1/workspaces/:workspaceId/packs
```

Registration stores the manifest but does not install its components.

### Preview

```text
POST /v1/workspaces/:workspaceId/packs/:packId/installation-preview
```

The optional body contains `rigId` and `variableSetId`. The response includes:

- the exact manifest SHA-256 and Pack version;
- the current installation version, if any;
- action: `install`, `update`, or `repair`;
- every component's `ready`, `missing`, or `mismatch` result;
- the selected Rig and its `ready`, `missing`, `mismatch`, or `unverified` result;
- required Variable Set validation;
- explicit blockers and a top-level `ready` decision;
- legacy inline-Skill count and legacy image provenance for migration review.

Preview is read-only. A manifest replacement after preview changes the digest and fences the subsequent install.

### Install, update, or repair

```text
POST /v1/workspaces/:workspaceId/packs/:packId/install
```

The request supplies:

- `expectedManifestDigest` from preview;
- the reviewed `rigId` and `variableSetId`, when applicable;
- a UUID `idempotencyKey`;
- `expectedInstallationVersion` for update or repair;
- optional metadata.

The durable operation journal and workspace-local advisory locks make retries resumable and component identity deterministic. Admission row-locks a workspace-registered manifest and rechecks its canonical digest, so concurrent register/replace/unregister cannot freeze a source that was already stale when the operation linearized. Reusing the same idempotency key for a different request is rejected, and a second request cannot re-enter an operation that is still running. A failed `pending` operation may resume with the same key; after a browser reload, a newly previewed request with the current installation version may safely supersede it under the same Pack lock. A database-time heartbeat keeps live work fresh. An abandoned `running` claim becomes recoverable after 15 minutes: the same key may reclaim it, or a newly previewed key may take over only when the frozen manifest, Rig, and metadata intent are identical. Every heartbeat/finalize/defer presents the admitted operation version, so an older handler cannot overwrite the recovered result. A stale installation version or changed manifest returns `409` without superseding a recovery path.

The installer migrates inline Skills, adopts exact referenced components, records the Pack component ledger, removes stale owner edges only after the replacement plan completes, and finally activates the Pack. A failed operation leaves the Pack `needs_attention`; retry the same request with the same idempotency key, or review the current plan again to start an OCC-fenced replacement operation.

Installation status is one of:

- `installing` — the reviewed operation is in progress;
- `active` — the complete frozen plan owns its resolved components;
- `needs_attention` — an interrupted or failed plan is resumable but not an effective owner;
- `disabled` — no Pack-owned component is effective.

### Uninstall

First inspect ownership effects:

```text
GET /v1/workspaces/:workspaceId/packs/:packId/uninstall-preview
```

Each component reports `retainedByOtherOwners`. Then uninstall with the previewed version:

```text
DELETE /v1/workspaces/:workspaceId/packs/:packId/installation
```

The body contains `expectedInstallationVersion` and a UUID `idempotencyKey`. Uninstall removes only Pack owner edges, cleans up truly orphaned component installations and feature bindings, deletes the Pack's component ledger rows, and marks the installation disabled. An active v2 Pack cannot be disabled through the generic capability route or unregistered until this lifecycle completes.

### Legacy enable compatibility

`POST /packs/:packId/enable` and generic capability Enable remain available only for simple Packs that have no `components`, inline `skills`, `rig`, `sandboxImage`, or `sandboxProviderImages`. This preserves existing built-in and metadata/task-template Packs without allowing new composed Packs to bypass review.

Pre-v2 active installation rows have no `manifestSnapshot` and no `manifestDigest`. The worker retains their old direct Pack Skill/image behavior for rollback compatibility. Any v2 install/update freezes the manifest and moves the Pack to component/Rig runtime; the two models are never combined for one installation.

## Variable Sets, Connections, and scheduled tasks

A Pack may declare a `variableSet` block (`description`, `requiredVariables`, `required`). Preview and install accept a workspace `variableSetId` and validate required variable **names**. Values remain encrypted under the Variable Set authority described in [`variable-sets.md`](variable-sets.md).

Connector records are identity/authorization authorities, not Pack-owned secrets. For social connectors, `social_connections.credential_ref` points at an external broker or secret store; raw provider tokens must not be placed in Pack metadata. Protocol-neutral Integration instances use ordinary encrypted Connection records and their token broker.

Pack template creation produces ordinary scheduled tasks with:

- `agentConfig.tools`, resources, prompt, and Pack/template metadata;
- the Pack installation's selected Variable Set, when present;
- the Pack installation's selected Rig, when present.

The scheduled task and its sessions then follow the normal Temporal, authorization, Connection, Rig, and runtime paths.

## HTTP example

Preview a registered image Pack against a chosen Rig:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/packs/$PACK_ID/installation-preview" \
  -H 'content-type: application/json' \
  -d "{\"rigId\":\"$RIG_ID\",\"variableSetId\":\"$VARIABLE_SET_ID\"}"
```

After reviewing the response, install the exact plan:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/packs/$PACK_ID/install" \
  -H 'content-type: application/json' \
  -d "{
    \"expectedManifestDigest\": \"$MANIFEST_SHA256\",
    \"rigId\": \"$RIG_ID\",
    \"variableSetId\": \"$VARIABLE_SET_ID\",
    \"idempotencyKey\": \"$IDEMPOTENCY_KEY\"
  }"
```

For an update or repair, include the previewed `expectedInstallationVersion`.

## Marketing Social Pack

The built-in Pack exposes:

- Pack catalog and installation records under `/v1/workspaces/:workspaceId/packs`;
- social connector routes under `/v1/workspaces/:workspaceId/social`;
- provider-scoped X/Reddit live tools (`x_*` and `reddit_*`) bound to exact accounts, plus aggregate Pack tools such as `social_connections_list`, `social_posts_recent`, and `social_daily_analysis_context`;
- optional document knowledge through the docs MCP server;
- a daily analysis scheduled-task template.

Because it currently declares no component or Rig plan, it may still be enabled with the simple compatibility route:

```bash
curl -X POST "http://127.0.0.1:8000/v1/workspaces/$WORKSPACE_ID/packs/marketing-social-daily-analysis/enable" \
  -H 'content-type: application/json' \
  -d '{"metadata":{"enabledBy":"operator"}}'
```

Registering provider accounts and creating its scheduled task continue through the ordinary social and scheduled-task APIs.

## Client surfaces

The SDK exposes:

- `previewPackInstallation`
- `installPack`
- `previewPackUninstall`
- `uninstallPack`

`@opengeni/react` mirrors the lifecycle through `usePacks`. The web Capabilities page is review-first: it selects a Rig and Variable Set, displays exact component status and migration facts, supports install/update/repair, and previews shared-owner retention before uninstall.

## Canonical implementation

- contracts: `packages/contracts/src/index.ts`
- domain preview and legacy migration: `packages/core/src/domain/packs.ts`
- HTTP lifecycle: `apps/api/src/routes/packs.ts`
- operation/installation persistence: `packages/db/src/pack-installations.ts`
- component resolution/ownership: `packages/db/src/pack-components.ts`
- schema and rolling migration: `packages/db/src/schema.ts`, `packages/db/drizzle/0203_pack_component_ownership.sql`
- legacy worker compatibility: `apps/worker/src/activities/packs.ts`
- web review UI: `apps/web/src/components/capabilities/packs-section.tsx`