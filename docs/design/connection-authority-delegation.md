# Connection authority delegation

Status: OPE-199 disjoint foundation. The database and runtime activation remain
blocked on a stable OPE-200 foundation containing migration 0254. Migration
`0255_connection_authority_delegation.sql` is reserved but must not be created
or registered before that base is supplied.

## Authority model

- A workspace connection has `subject_id IS NULL`, belongs to the exact target
  workspace, and is usable only through explicit workspace authority. Historical
  omission parses as workspace authority for compatibility, but the accepted
  snapshot records `legacy_workspace_omission` rather than losing provenance.
- A personal connection has one server-derived owner subject and organization
  membership. It is never eligible for workspace authority and no request shape
  accepts an owner supplied by the caller.
- Personal sharing reuses the OPE-198 lifecycle exactly: one
  `organization_user_resource_authorities` row with `resource_kind=connection`
  and grants whose only accepted action is `connection.use`. Provider-specific
  actions or grants are invalid.
- The public authority envelope is opaque. It carries OPE-198 authority/grant
  identity and fences, never owner identity, credential material, provider
  metadata, quota, or usage values.

## Immutable accepted-work snapshot

Every accepted turn or scheduled task that selects a connection freezes:

- organization, origin workspace, target workspace, target session,
  visibility, and authority epoch;
- exact connection UUID, generation, active status, provider domain, and kind;
- workspace or user scope plus explicit/legacy/delegated provenance;
- for personal scope only, the server-derived owner subject and organization
  membership used for internal revalidation and usage/audit attribution;
- the complete opaque OPE-198 delegation and bounded selection sources.

The snapshot contains no credential, token, refresh material, provider account
metadata, quota, usage value, or arbitrary caller-supplied owner.

## Immediate pre-use fence

The eventual database resolver must read and validate the following in one
authority boundary immediately before each provider request, including queued,
resumed, scheduled, approval-resumed, and long-lived tool use:

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

Connection discovery and lifecycle mutation will be owner-only and opaque:
list/issue/revoke operations derive the current authenticated human from the
integrity-checked access grant, filter the common lifecycle to
`resource_kind=connection`, and never accept or disclose another owner. Cross-
organization discovery is denied before lookup.

## Deferred integration boundary

After the stable OPE-200/0254 base is supplied, OPE-199 will add contiguous 0255
tables/functions/triggers or extensions required to bind connection generations
to accepted turn/task snapshots, expose public CRUD and owner-only authority
routes, and wrap the existing token broker with the immediate pre-use resolver.
That slice must also update shared DB exports/schema/runtime posture/release
contracts and worker integration only on the coordinated base.

Provider-specific connector behavior, transfer of personal credentials/quota,
variable sets, machines, and rigs are outside this design.
