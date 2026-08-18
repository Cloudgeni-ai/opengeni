<!-- docs-refs: record -->

> **Point-in-time design record.** Frozen on August 18, 2026 (OPE-273). Code and
> [`../organization-tenancy.md`](../organization-tenancy.md) are the current
> implementation map.

# Non-RLS authority tables: can cross-organization denial move into the database?

Status: **three reasoned exemptions, one of them permanent by construction**

## The question

Every content table in OpenGeni — sessions, documents, connections, knowledge,
variable sets, rigs — is FORCE RLS and genuinely isolated: a query running under
organization B's context cannot read organization A's row, full stop.

Three tables are not. `workspaces`, `workspace_memberships`, and
`auth_identities` carry an `account_id`, grant the runtime role full
`SELECT/INSERT/UPDATE/DELETE`, and have no row-level security at all. They sit in
`NON_RLS_RUNTIME_TABLES` (`packages/db/src/runtime-posture.ts`) with the comment
that "their access model is implemented by the authentication/access layer or by
exact global keys."

That is a deliberate decision. But OPE-10's acceptance says cross-organization
access is denied *at every surface*, and "every surface" reads as including the
database. This record decides the question explicitly instead of letting the
exemption be inherited silently.

**It does not change any authorization behaviour.** No RLS was enabled, no policy
was added to these three tables, and no query was rewritten. What shipped
alongside it is attestation only: `packages/db/test/non-rls-authority-tables.test.ts`
pins the exemption's exact shape so a future widening has to be deliberate.

## Verdict per table

| Table | Is an `account_id = current_account_id()` predicate feasible? | Verdict |
| --- | --- | --- |
| `workspaces` | **No — self-referential.** The predicate's input is produced by a query against the table the predicate would guard. | Permanent exemption |
| `workspace_memberships` | **No as an unconditional predicate.** The central authorization query derives the account from this table. A bootstrap escape hatch is possible but degenerates to today's posture, and three dormant policies make enabling RLS actively dangerous. | Exemption, revisit only with a redesigned context bootstrap |
| `auth_identities` | **Malformed question.** Its `account_id` is not a tenant id, and its queries do not run on a connection that can carry an OpenGeni GUC. | Permanent exemption; also correct the table's description |

### `workspaces` — the circularity is one function

`opengeni_private.current_account_id()` reads the `opengeni.account_id` GUC.
`setRlsContext` (`packages/db/src/database.ts`) refuses to run without a non-empty
account id — deliberately, because an empty account silently returns zero rows
from every scoped read. So the account id must come from somewhere, and for the
whole workspace-scoped wrapper family it comes from here:

```ts
export async function rlsContextForWorkspace(db, workspaceId) {
  const [row] = await db
    .select({ accountId: schema.workspaces.accountId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
  return { accountId: row.accountId, workspaceId };
}
```

This runs on the bare handle with zero GUCs set, on every `withWorkspaceRls`,
`withWorkspaceSubjectRls`, `withWorkspaceSessionActivityRls`,
`withWorkspaceUsageLock`, and retry wrapper — roughly 750 call sites across
`packages/` and `apps/`. Under an `account_id = current_account_id()` policy the
GUC is unset, the predicate evaluates to `NULL`, the row disappears, and the
function throws `Workspace not found` for every workspace in the deployment.

The predicate would be self-defeating, not merely inconvenient. It is the query
that *produces* the value it would be checked against.

Other reads that would break for the same reason, before considering the
bootstrap: `bootstrapWorkspace`'s external-key lookup (pre-`setRlsContext`),
`getWorkspace`/`requireWorkspace` (unwrapped, and the source of the 404-vs-403
distinction in `packages/core/src/access/index.ts`), and
`listWorkspacesForSubject` (cross-account by intent — it powers `GET /v1/workspaces`).

Separately, several paths are cross-account *by design* and would break even with
a correctly-set account GUC: the deployment-global
`list_sandbox_viewer_force_drain_workspaces()` scan that drives the sandbox
reaper, `countWorkspacesForAccount` behind billing limits, the organization
inventory seam, and the organization-membership lifecycle's org-wide workspace
walks during suspend/offboard.

A bootstrap escape hatch — say a `session_visibility_write_capabilities`-style
capability, or a policy branch admitting a context-free read of exactly
`(id, account_id)` — is technically constructible. But the only column an
attacker gains from `workspaces` is workspace metadata, and the escape hatch
would have to admit precisely the read that leaks it. The predicate would be
decoration.

### `workspace_memberships` — same shape, plus a live trap

`getWorkspaceGrant` is the central authorization query. It joins
`workspace_memberships` to `workspaces`, on the bare handle, inside no wrapper,
with no GUC, and returns `accountId: row.workspace.accountId`. Everything
downstream in the request uses that account. It is called from
`accessGrantAuthorization` on every request whose `AccessContext` does not
already carry the target workspace grant — API-key principals, delegated tokens
aimed at another workspace, cache-miss re-checks — and from six OAuth callback
handlers whose only input is the signed `state` blob.

Two further shapes resist the predicate:

- `listWorkspacesForSubject` filters on `subject_id` alone and is inherently
  cross-account.
- The managed-access grant projection in `ensureManagedAccessForUser` also
  filters on `subject_id` alone while the account GUC is pinned to one
  organization. Today that correctly returns a multi-organization human's
  memberships everywhere. Under the predicate it would silently truncate their
  `workspaceGrants` to the pinned organization — a fail-quiet authorization
  change, which is worse than the gap it would close.

**The trap.** PostgreSQL accepts `CREATE POLICY` on a table whose RLS is disabled
and stores it inert. Three capability lanes did exactly that on
`workspace_memberships`:

| Migration | Policy |
| --- | --- |
| `0254_scoped_variable_set_authority.sql` | `variable_set_authority_capability_read` |
| `0258_three_scope_document_knowledge_authority.sql` | `personal_document_authority_capability_read` |
| `0262_scoped_connected_machines_and_rigs.sql` | `scoped_compute_capability_read` |

Each is `FOR SELECT USING (current_user = <migration owner> AND <capability>)`.
Nothing drops them. The moment anyone runs `ALTER TABLE workspace_memberships
ENABLE ROW LEVEL SECURITY`, those three become the *entire* admission set, and the
runtime role is never the migration owner — so every membership read returns zero
rows and every authorization in the product fails closed. The runtime-posture
verifier inspects `relrowsecurity`, so it cannot see this. It is now pinned by
test instead.

Beyond that, every SECURITY DEFINER authorization gate that does
`PERFORM 1 FROM workspace_memberships … FOR SHARE` — the variable-set, personal-
document, scoped-compute, connection-authority, and workspace-connection-use
lanes — runs as the migration owner, which FORCE RLS does not exempt. All of them
would fail closed too.

### `auth_identities` — the premise does not hold

`auth_identities.account_id` is `text`, not a `uuid` foreign key to
`managed_accounts`. It holds Better Auth's `account.accountId`: the OAuth
provider's subject string (a Google `sub`, a GitHub numeric id, or the local user
id for password auth). `canonical-human-identities.ts` aliases it
`providerAccountId`, and the unique index is `(provider_id, account_id)`.

So `account_id = opengeni_private.current_account_id()` is a type error
(`text = uuid`) before it is a policy question. The table carries no tenant
identity in any column.

Even given a tenant column, the queries could not carry a context. Better Auth
does not use OpenGeni's Drizzle handle: `apps/api/src/auth/managed-auth.ts`
constructs its own `new Pool({ connectionString })` and hands it to `betterAuth`.
Every sign-up, sign-in, OAuth link, unlink, and token refresh runs on a
connection that never executes `set_config('opengeni.*', …)` and has no code path
by which it could. The one OpenGeni-side read,
`synchronizeCanonicalHumanLoginBindings`, runs inside Better Auth's
`session.create.before` hook — strictly before any `managed_accounts` row has
been discovered for the request.

`auth_identities` is a credential store keyed by provider identity, not a tenant
resource. The right correction is to the table's description, not to its posture.

## What actually denies cross-organization access

Measured, not asserted (`packages/db/test/non-rls-authority-tables.test.ts`):
under organization B's exact request context on the runtime role, organization
A's `workspaces` row and `workspace_memberships` rows **are** readable, while
organization A's `sessions` row is **not**.

Denial for the three tables therefore rests entirely on the access layer:

- `AccessContext` is built once per request from an authenticated principal, and
  `accessGrantAuthorization` requires an exact grant for the target workspace
  before any route handler runs — 404 when the workspace does not exist, 403 when
  it exists but is not granted.
- Every workspace-scoped read then re-derives and pins `opengeni.account_id` from
  the target workspace itself, so the content tables are isolated by the account
  that owns the workspace being addressed, not by a caller-supplied claim.
- `setRlsContext` fails loud on a blank account and `assertRlsContextApplied`
  read-backs the GUC on the same backend, so a transaction-pooler backend swap
  cannot silently degrade an isolated read into a context-free one.

The residual exposure is precise: **an authenticated principal that reached the
database layer with a query it constructed itself, bypassing the access layer,
could read another organization's workspace and membership metadata — names,
ids, settings, member subject ids — but no content.** That is a defence-in-depth
gap, not an access-control hole, because no product surface issues such a query.

## Proposed amendment to OPE-10's acceptance

Current wording (paraphrased): *cross-organization access is denied at every
surface.*

Proposed replacement:

> Cross-organization access to **workspace content** — sessions and their
> history/events/turns, documents, knowledge, connections, variable sets, rigs,
> machines, files, and every derived projection — is denied at every surface,
> and is additionally enforced by FORCE row-level security so that a query which
> bypasses the access layer still returns nothing.
>
> Cross-organization access to the **context-bootstrap tables** — `workspaces`,
> `workspace_memberships`, and the credential store `auth_identities` — is denied
> by the authentication and access layer only. These three are the tables read to
> *establish* the organization context that every RLS predicate depends on, so a
> row-level predicate over them is circular (`workspaces`,
> `workspace_memberships`) or type-incoherent (`auth_identities`, whose
> `account_id` is a provider subject string, not a tenant id). The exemption is
> recorded in
> `docs/design/organization-tenancy-non-rls-authority-tables-2026-08-18.md` and
> attested by `packages/db/test/non-rls-authority-tables.test.ts`. Adding a table
> to `NON_RLS_RUNTIME_TABLES` is a tenancy decision and must update both.

## Related findings

**`api_keys` hash branch.** The FORCE-RLS policy on `api_keys` is
`optional_workspace_rls_visible(account_id, workspace_id) OR key_hash =
opengeni_private.current_api_key_hash()`. The second branch carries no account,
workspace, revocation, or expiry check, and it appears in `WITH CHECK` as well as
`USING`.

It is necessary and, under the intended flow, sound: `findActiveApiKeyByHash` is
the only place that sets `opengeni.api_key_hash`, transaction-locally, from
`sha256(presented bearer)` — and presenting that bearer *is* the authentication.
Without the branch, API-key authentication would return zero rows and be dead.
Revocation and expiry are enforced in the application `WHERE`, not the policy.

The bounded residual: the branch is a plain equality on a stored, unsalted digest
rather than a proof of preimage. Anyone able to influence the GUC — SQL injection
reaching `set_config`, a future caller passing attacker-controlled data, or a leak
of the `key_hash` column — gets read *and write* access to that key's row with no
tenant fence. Blast radius is exactly one row (`key_hash` is uniquely indexed) and
the GUC is transaction-local. It was previously unexercised: the only `api_keys`
RLS test never sets the GUC, so it proves the account branch and structurally
cannot reach this one. It is now covered — the branch admits the presented key's
own row and nothing else, not even its own account's other keys.

Recommended follow-up, not taken here: fold `revoked_at IS NULL` and the expiry
check into the policy so a future query that forgets them cannot authenticate a
revoked key.

**Migration-owner naming.** The reported concern that some capability policies
hardcode `CURRENT_USER = 'postgres'` while others resolve
`pg_get_userbyid(relowner)` **does not hold in this repository.** There is not a
single occurrence of the string `'postgres'` anywhere under
`packages/db/drizzle/`, and no comparison of `current_user` to any string
literal. Every owner-gated policy uses one of two owner-agnostic idioms:
`migration_owner text := current_user` captured in a `DO` block and interpolated
with `%L` (13 sites, including `0225`, `0254`, `0258`, `0262`, `0285`), or
`current_user = pg_catalog.pg_get_userbyid(...)` resolved from the catalog (12
sites). Nothing breaks on a deployment whose owner is not named `postgres`. The
finding should be recorded as already-correct rather than as a defect.

## What would change the verdict

The `workspaces` and `workspace_memberships` exemptions are consequences of one
architectural fact: **the account context is derived from the workspace being
addressed, at query time, from the database.** They would become closable if the
account id were instead carried by the authenticated principal and verified
independently — for example a signed session/token claim binding
`subject → account`, checked once at the edge, so that `rlsContextForWorkspace`
becomes a *verification* (`account_id = <claimed>`) rather than a *derivation*.
That is a request-lifecycle redesign spanning Better Auth, API keys, delegated
tokens, and the OAuth callbacks, and it must be its own slice with its own
rollout. It is not a policy change.

`auth_identities` would not change even then, unless Better Auth were moved onto
OpenGeni's pooled handle and the table gained a real tenant column — neither of
which is desirable for a shared credential store keyed by provider identity.
