# Codex provider-account authority foundation

Migration `0226_personal_codex_authority_foundation.sql` adds the first inert,
expand-only storage and contract slice for private-by-default personal Codex
subscription credentials. It does **not** activate personal credential use.

## Credential authority facts

Every `codex_subscription_credentials` row now has an explicit
`workspace|user` authority scope. Existing rows and omitted new-writer values
are classified as `workspace`.

- `workspace` requires null owner-membership and user-resource authority facts.
- `user` requires one active same-account organization membership and the exact
  active `organization_user_resource_authorities` tuple whose resource kind is
  `codex_subscription`, resource id is the credential row id, and generation is
  the stored positive generation.

The validation trigger intentionally uses invoker rights. The runtime role has
no direct visibility or DML on the FORCE-RLS organization authority tables, so
this foundation does not give application code a path to manufacture a
user-scoped credential. A later activation must add a separately reviewed,
narrow lifecycle capability.

`connected_by_subject_id`, workspace placement, creator/audit metadata, email,
label, provider account id, and personal-workspace placement are not ownership
authority and are never used to derive `user` scope.

## Opaque accepted-work snapshot

`CodexProviderAccountAuthoritySnapshotV1` has exactly two forms:

```text
{ version: 1, scope: "workspace" }
{ version: 1, scope: "user", authorityGeneration: <positive safe integer> }
```

The snapshot contains no subject, organization membership, credential,
provider-account, or provider identifiers; no label, quota, token, or plan
metadata; and no independent grant to use a credential. It is stored immutably
on accepted logical turns, scheduled tasks, system updates, and child-result
system-update outbox rows. All legacy rows backfill to the workspace form, and
current writers continue to receive that default.

## Deliberately not activated

This slice does not change credential connection, discovery, listing,
selection, allocation, leases, token loading or refresh, pin/failover,
capacity, connected Apps, reset-credit redemption, realtime, transcription,
usage, billing, or consumption. Those paths remain workspace-scoped until a
later activation revalidates an opaque snapshot against exact live authority.
