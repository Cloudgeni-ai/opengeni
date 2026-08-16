# Connection authority delegation

Status: active foundation plus bounded runtime activation. Connection-specific wire and snapshot
contracts live in `@opengeni/contracts/connection-authority`, pure capture and
revalidation logic lives in `@opengeni/core/connection-authority`, and migration
`0256_connection_authority_delegation.sql` owns database authority binding, the
owner-only grant lifecycle, generation fences, and the immediate pre-use
resolver. Maintenance migration `0264_connection_authority_runtime_activation.sql`
persists server-built accepted-turn snapshots and activates configured remote
MCP, API-hosted OpenAPI/GraphQL, Gmail REST, host MCP credential, and Google
Drive publication requests. Other provider surfaces must not claim delegated
execution until their own acceptance and per-request adapters land.

## Authority model

- A workspace connection has `subject_id IS NULL`, belongs to the exact target
  workspace, and is usable only through explicit workspace authority. Historical
  omission parses as workspace authority for compatibility, but the accepted
  snapshot records `legacy_workspace_omission` rather than losing provenance.
- A personal connection has one server-derived owner subject and organization
  membership. It is never eligible for workspace authority and no request shape
  accepts an owner supplied by the caller.
- Personal sharing reuses the common user-resource lifecycle exactly: one
  `organization_user_resource_authorities` row with `resource_kind=connection`
  and grants whose only accepted action is `connection.use`. Provider-specific
  actions or grants are invalid.
- The public authority envelope is opaque. It carries authority/grant
  identity and fences, never owner identity, credential material, provider
  metadata, quota, or usage values.

## Immutable accepted-work snapshot

Every activated accepted human/API turn that selects a connection freezes:

- organization, origin workspace, target workspace, target session,
  visibility, and authority epoch;
- exact connection UUID, generation, active status, provider domain, and kind;
- workspace or user scope plus explicit/legacy/delegated provenance;
- for personal scope only, the server-derived owner subject and organization
  membership used for internal revalidation and usage/audit attribution;
- the complete opaque user-resource delegation and bounded selection sources.

The snapshot contains no credential, token, refresh material, provider account
metadata, quota, usage value, or arbitrary caller-supplied owner.

## Immediate pre-use fence

The activated provider surface supplies only exact lookup identity; the database
loads the persisted accepted-work snapshot and validates the following in one
authority boundary.
That surface must invoke it immediately before each provider request, including
queued, resumed, scheduled, approval-resumed, and long-lived tool use:

1. exact organization and target workspace access;
2. live target session identity, visibility, and authority epoch;
3. exact connection UUID, origin workspace, generation, active status, provider
   domain, kind, and unchanged owner;
4. for personal scope, the exact active owner membership;
5. the exact active `resource_kind=connection` authority and generation;
6. the exact active `connection.use` grant, session/context/epoch fences,
   generation, expiry, and once-consumption state.

Disconnect, reconnect, owner change, membership loss, authority revocation,
grant revocation/consumption/expiry, session visibility change, or authority
epoch change therefore denies before credential decryption or provider I/O.
There is no effect replay and no substitution with another active connection.

## Attribution and discovery

Authorized personal use attributes metadata-only usage/audit facts to the
personal owner retained in the immutable snapshot. Workspace use has no personal
owner. Ordinary public projections remain credential/value-free.

Connection discovery and lifecycle mutation are owner-only and opaque:
list/issue/revoke operations derive the current authenticated human from the
integrity-checked access grant, filter the common lifecycle to
`resource_kind=connection`, and never accept or disclose another owner. Cross-
organization discovery is denied before lookup.

## Maintenance activation and compatibility boundary

Migration 0256 was rolling and inert. Migration 0264 is a drained maintenance
cutover: it rejects pre-activation executable work that could otherwise carry a
common user connection without a snapshot, and old API/worker images must not
restart afterward. It checks for live `opengeni_app` sessions before and after
exclusive writer locks and never backfills accepted authority from a mutable
current grant. Personal connection rows whose exact organization membership is available are
bound to a common user-resource authority. Pre-tenancy rows without that proof
are retained as `legacy_user`: they remain subject-private through the existing
row policy but receive no delegable authority and use only the exact bounded
legacy compatibility lane. They are never silently upgraded from mutable
authority state.

For authorized personal use, the target workspace is checked independently from
the connection's frozen origin workspace. The credential broker loads only the
exact authorized connection generation from that origin, which lets one user's
connection follow them across workspaces in the same organization without
making it a workspace credential. The canonical managed personal-workspace
owner is admitted through the lifecycle-derived organization membership even
though that workspace intentionally has no durable membership row; other users
and administrators are denied.

Provider-specific connector behavior, transfer of personal credentials/quota,
variable sets, machines, and rigs are outside this design.
