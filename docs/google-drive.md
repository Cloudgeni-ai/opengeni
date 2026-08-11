# Google Drive named knowledge sources

Google Drive is a built-in API Integration preset. A workspace may install the
same immutable Drive definition many times, with a separate account label,
Connection, ownership, tool namespace, health state, and feature configuration
for each instance. For example, `Google Drive — Finance` and `Google Drive —
Sales` can coexist without provider-domain fallback or singleton overwrite.

The current shipped source slice provides:

- signed PKCE OAuth through the normal provider-preset flow;
- encrypted server-side credentials on a Personal or workspace Connection;
- exact-instance browsing of My Drive, folders, shared folders, and Shared
  Drives;
- provider re-verification of every selected boundary at save time;
- a versioned `drive-content` Knowledge Source binding containing 1–100
  sources, bound destination authority, cadence, and read policy;
- generic pause, resume, and removal for that one feature; and
- multiple named Drive instances using separate Connections without crossing
  credentials or configuration.

This slice **does not** dispatch a recurring import, download file bytes,
create Documents/chunks, run embeddings, process a durable Drive change cursor,
project Drive ACLs, or update workspace memory. The inventory/export planner is
implemented as a provider-neutral execution boundary, but no API route,
scheduler, or worker invokes it yet. The UI therefore reports saved source
configuration, not completed or running ingestion.

## OAuth and local setup

The provider preset is configured in `packages/capabilities/src/providers.ts`.
Its generic API surface includes Drive tools and currently requests the full
`https://www.googleapis.com/auth/drive` scope. That scope satisfies recursive
metadata/content reads and also authorizes the preset's reviewed write tools;
tool approval/action policy remains independent of source configuration.

The retained legacy connector at
`/v1/workspaces/:workspaceId/connections/google-drive/*` requests the narrower
`drive.readonly` scope and remains only for rollback/migration compatibility.
New Capabilities UI setup uses the provider-preset callback:

```text
http://127.0.0.1:8000/v1/integrations/provider-oauth/callback
```

Local configuration requires:

```bash
OPENGENI_INTEGRATIONS_ENABLED=true
OPENGENI_PUBLIC_BASE_URL=http://127.0.0.1:8000
OPENGENI_WEB_BASE_URL=http://127.0.0.1:3000
OPENGENI_INTEGRATIONS_STATE_SECRET=replace-with-random-state-secret
OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY=replace-with-base64-32-byte-key
OPENGENI_GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret
```

The generic Google client may alternatively be supplied through
`OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON`. Generate the encryption key with
`openssl rand -base64 32` and the state secret with `openssl rand -hex 32`.
Enable the Google Drive API, configure the requested scopes and exact callback
URI on the Google OAuth client, then run `bun run dev`. Google classifies broad
Drive grants as sensitive/restricted; production use must complete Google's
applicable verification and security-review requirements.

In **Capabilities → Connected services**, choose **Connect Google Drive**, give
the account a human-readable label, choose Personal or workspace ownership, and
complete Google consent. **Add another account** creates another Connection and
Integration instance instead of replacing the first one.

## Exact-instance source configuration

Each account row has a **Features** drawer. Configuring **Drive content** opens
the provider-specific browser for that exact `capabilityId`, `instanceKey`, and
`featureKey`:

- `GET /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey/browse`
- `PUT /v1/workspaces/:workspaceId/integrations/:capabilityId/instances/:instanceKey/features/:featureKey/source`

The browser starts at My Drive, lists folders only, supports pagination, and
accepts a pasted Google Drive folder/Shared Drive URL or ID. Selecting a parent
includes descendants; the UI suppresses redundant visible child selections.
At least one and at most 100 sources are required.

Browse first resolves the exact installed Integration, verifies that the facet
is the adapter-owned Google Drive Knowledge Source, loads only that instance's
Connection, and sends its exact token to Google. Personal Connections require
the current subject; workspace Connections are visible under workspace
authority. Provider-domain equality alone never selects a credential.

Save validates a UUID idempotency key and optional binding version, authorizes
the requested destination, and re-reads every source from Google. A changed
name, MIME type, or Shared Drive identity returns `409` so stale UI state cannot
bind a different provider object. The persisted config contains:

- provider-verified source id, name, MIME type, optional drive id, source kind,
  and `includeDescendants`;
- an exact organization, current-workspace, or initiating-user personal
  destination authority;
- `manual`, `hourly`, or `daily` cadence; and
- `allow`, `ask`, or `block` read policy.

The generic feature-configuration `PUT` rejects this provider-owned Knowledge
Source. Callers must use the `/source` route so Google metadata verification and
destination-authority binding cannot be bypassed.

The config is stored on `integration_feature_bindings`. It is not copied onto
Connection metadata. Provider credentials and page/change cursors remain
private. Updating requires the current binding version when the request would
change state; an unchanged semantic replay converges without manufacturing a
new version. Pause, resume, and removal use the generic feature lifecycle and
never disconnect the account or remove sibling features/instances.

## Connection and failure behavior

The generic provider Connection uses normal statuses:

- `active` permits exact-instance browse and save;
- `needs_reauth` requires reconnect/re-consent; and
- `revoked` is locally disconnected.

The Drive adapter requires a stored grant that proves recursive source reads.
Known permanent refresh or provider permission failures transition only the
exact Connection generation to `needs_reauth`; stale provider responses cannot
mutate a reconnected generation. Provider descriptions, response bodies,
tokens, and client secrets are not written to Connection metadata or
`lastError`.

The legacy dedicated connector retains its richer active/paused/token-revoked/
app-removed/disconnected/reconnect/re-consent metadata state and local
disconnect receipt. Those routes remain tested for compatibility, but the
Capabilities page no longer renders the singleton legacy card.

## Bounded inventory and export planning

`@opengeni/documents/google-drive` owns the execution plan for a future
backfill:

- destination authority is frozen to exactly one organization, workspace, or
  initiating-user personal scope;
- pagination is breadth-first with a versioned serializable checkpoint bound to
  provider permission, tenant, source boundary, and destination identities;
- a page is buffered before its items are consumed, preventing crash recovery
  from skipping the remainder of a fetched page;
- explicit item, byte, request/cost, folder, per-file, and invocation-time
  bounds apply;
- Google Docs, Sheets, Slides, and Drawings plan deterministic PDF export;
  ordinary PDF/text-like files plan authenticated download; unsupported or
  oversized siblings are isolated as skipped items; and
- incomplete search or provider-page failure does not advance the checkpoint.

The planner does not fetch bytes or persist source/object/version rows. Durable
change reconciliation, scheduling, indexing, ACL intersection/revocation, and
citation reauthorization remain separate future boundaries and must not be
claimed from successful source configuration alone.