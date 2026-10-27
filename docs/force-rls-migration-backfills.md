# FORCE-RLS migration backfills

Canonical home for one migration hazard class: a data backfill that runs during
a migration over a table with `FORCE ROW LEVEL SECURITY`, matches **zero rows**,
and reports success.

## The mechanism

`FORCE ROW LEVEL SECURITY` binds the **table owner**, not merely ordinary roles.
Only a genuine `SUPERUSER` (or a role with `BYPASSRLS`) is exempt. Opengeni's
documented deployment posture ([`deployment.md`](deployment.md)) runs migrations
as `OPENGENI_MIGRATIONS_DATABASE_URL`'s identity - the schema **owner**, which on
every managed Postgres (Azure Flexible Server, AWS RDS, Cloud SQL) is a
non-superuser without `BYPASSRLS`.

During a migration no `opengeni.account_id` / `opengeni.workspace_id` GUC is set.
Every workspace-scoped table's `workspace_isolation` policy is
`opengeni_private.workspace_rls_visible(account_id, workspace_id)`, which is
`account_id = NULL AND workspace_id = NULL` → `NULL` → not true. So for the
migration principal the table looks empty:

```
UPDATE connections SET origin_workspace_id = workspace_id
WHERE origin_workspace_id IS NULL;
-- UPDATE 0        (and no error)
```

Three consequences follow, in increasing order of nastiness:

1. **A backfill writes nothing** and the migration commits.
2. **A `DO $$ ... IF EXISTS (SELECT ... FROM <table>) ... RAISE EXCEPTION`
   preflight guard sees zero rows and certifies success.** A cutover's own
   drain/convergence verification is therefore decoration.
3. **A `DO $$ ... FOR row IN SELECT ... LOOP` repair loop iterates zero times.**

What *does* still see every row: `ALTER TABLE ... VALIDATE CONSTRAINT`,
`ALTER COLUMN ... SET NOT NULL`, `ADD CONSTRAINT` without `NOT VALID`, unique
index builds, and foreign-key/RI checks. These are internal scans, not user
queries, and PostgreSQL documents RI checks as bypassing row security. That is
why many historical migrations in this repo were saved by accident - and why the
ones that were *not* are exactly the ones whose new constraints tolerate the
un-backfilled state.

The CHECK-tolerance rule is the subtle part: **a CHECK expression that evaluates
to `NULL` passes; only `FALSE` fails.** `0256`'s
`connections_authority_shape_check` compares `origin_workspace_id = workspace_id`,
which is `NULL` (not `FALSE`) when the column is `NULL`, so the whole conjunction
is `NULL` and validation passes. `0258` wrote
`CHECK (origin_workspace_id IS NOT NULL)` instead and therefore aborts loudly on
the same defect.

**Why CI never caught it:** `packages/testing/src/shared-pg.ts` builds its
migrated template as the container superuser `postgres`, for whom FORCE RLS never
engages.

## The required pattern

A migration-time backfill over a FORCE-RLS table must do one of:

1. **Open the owner-only posture window** (preferred; the house pattern):

   ```sql
   ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY;
   -- ... the backfill, and any preflight/convergence guard over it ...
   ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
   ```

   `NO FORCE` relaxes **only the owner**; the application role stays policy-bound
   throughout. The runner executes each file as one implicit transaction, so a
   failure rolls back the posture change together with the data repair.

2. **Set the tenant GUC** around the statement, when the work is genuinely
   single-tenant.

3. **Avoid the migration-time read entirely** - `ADD COLUMN ... NOT NULL DEFAULT`
   is RLS-immune and is the correct shape whenever the backfill value is a
   constant (`0234_xai_subscription_authority.sql` does this well).

A convergence assertion is not a substitute for any of the above: put the
assertion *inside* the window so a silent no-op fails loudly.

## The same trap at runtime: `SECURITY DEFINER` routines

The mechanism is not confined to migration time. Inside a `SECURITY DEFINER`
function, `current_user` is the function's **owner** - the same schema owner that
runs migrations - so `FORCE ROW LEVEL SECURITY` binds it there too, on every
ordinary request. A definer routine reading a capability-gated table therefore
has the identical failure mode: **zero rows, no error.**

Two rules, both of which fail silently when broken:

1. **Open the capability window before the read.** A table like
   `organization_memberships` carries no GUC-only read policy; every branch is
   `current_user = <owner> AND <x>_capability_active()`. Installing the
   capability *after* the `SELECT` (or after an `IF FOUND` on it) makes the read
   match nothing and takes the not-found path.
2. **A capability-gated read must carry no locking clause.** PostgreSQL applies a
   relation's `UPDATE` policies to any `SELECT` with a row-locking clause, so
   `FOR SHARE`, `FOR KEY SHARE`, `FOR NO KEY UPDATE`, and `FOR UPDATE` **all**
   return zero rows when the only matching policy is `FOR SELECT`. Nothing
   raises. Where a referential pin is genuinely needed, take it through a foreign
   key: RI checks bypass row security and lock the referenced row `FOR KEY SHARE`.

`reclassify_document_authority` follows both rules and asserts the window is live
before the read, so a regression aborts instead of quietly pinning a personal
Document to its origin workspace forever.

Migration `0343_personal_document_force_rls_lock_repair.sql` repairs the two
shipped 0258 routines that violated rule 2. Its owner-migrated regression test
proves the silent legacy fallback before the repair and the portable authority
mint after it. New SECURITY DEFINER routines that touch FORCE-RLS tables must
carry the same `acquireOwnerMigratedTestDatabase` coverage for every command
they issue; a superuser-migrated test is not evidence for this boundary.

Two other worked examples of a definer that satisfies a policy branch it can
actually reach: `0263`'s
`assert_active_managed_human_organization_membership`, which gates on one of the
`opengeni.organization_tenancy_lifecycle` markers the authority tables already
carry, and `0340`'s `opengeni_private.bind_connection_owner_authority`, which
opens its own narrow marker window and restores the previous marker on every
exit.

Do not imitate 0263's shape without checking the policy it lands on. Its read
carries `FOR KEY SHARE`, which rule 2 forbids against a `FOR SELECT`-only
policy; it is safe only because `organization_tenancy_lifecycle` is declared
`FOR ALL`, so the UPDATE branch a locking read consults exists. 0340 takes the
other lawful route and creates a *pair* - `connection_authority_binding_read`
(`SELECT`) and `connection_authority_binding_lock` (`UPDATE`) - which is why its
own `FOR SHARE` read sees rows. Either shape works; a locking read against a
lone `FOR SELECT` policy is the one that silently returns nothing.

**Known unrepaired instance.** `0258_three_scope_document_knowledge_authority.sql`
gets rule 1 right but not rule 2:
`create_personal_document_authority` and
`prepare_session_attempt_personal_document_reads` both read
`organization_memberships ... FOR SHARE` inside the capability window. On a
superuser-migrated database they see the row; on the documented production
posture they see none, so a new personal Document silently takes the legacy
workspace-anchored lane instead of minting a portable organization-user
authority. Migration bytes are frozen, so this needs its own reviewed repair
migration - it is listed here rather than fixed in passing.

**Known unrepaired global aggregate.** `opengeni_private.count_session_recovery_backlog()`
(0375, restated by 0519; 0633 moved its body into
`opengeni_private.summarize_session_recovery_backlog()` unchanged in shape) reads `sessions`, `session_turns`,
`session_turn_attempts`, `session_attempt_interruptions`, `session_events`, and
`workspace_inference_controls` with no tenant GUC and no capability window.
Every permissive policy those tables offer its owner needs one, so on the
documented posture the function reads zero rows and reports `0/0`: a blind
recovery-backlog monitor, never a false alert. A deployment whose migration
owner bypasses RLS sees the true counts. The repair is a narrow owner-only read
capability in the shape of 0497's `modal_inventory_read_capabilities`, with
`acquireOwnerMigratedTestDatabase` coverage. It needs its own reviewed migration
because `CREATE POLICY` takes an `ACCESS EXCLUSIVE` lock on each of those hot
tables. Check the other `opengeni_private.count_*` aggregates for the same shape
when repairing it.

The organization-tenancy lane alone has produced four more instances - all in
tenancy migrations rather than 0258's Document lane - all invisible
until a test ran through `acquireOwnerMigratedTestDatabase`:

| Writer | Table | Command it issues | Was covered by |
| --- | --- | --- | --- |
| `bind_connection_authority` (mint) | `organization_memberships` | `SELECT ... FOR SHARE` | a `FOR SELECT` policy only |
| `bind_connection_authority` (mint) | `organization_user_resource_authorities` | `INSERT` | nothing |
| `bind_connection_authority` (backfill verify) | `organization_memberships` | `SELECT ... FOR SHARE` | a `FOR SELECT` policy only |
| `activate_session_tenancy_product` | `session_tenancy_activations` | `INSERT` | a `FOR SELECT` policy only |

A fifth in that lane, same class but not a write: 0305 restated the shared
`organization_tenancy_lifecycle` marker list on `organization_memberships` and
dropped 0290's `organization_membership_backfill` entry, silently blinding both
membership-backfill read seams. That is the argument for giving a seam its own
narrow policy instead of appending a marker to a shared list.

The shape of a guard that would have caught every one of these is small and
specific: **for each SECURITY DEFINER routine, assert that every FORCE-RLS table
it touches has a policy covering the exact command it issues** - `FOR SELECT`
plus `FOR UPDATE`/`ALL` for a row-locking read, `FOR INSERT` for an append -
satisfiable by the routine's owner. It needs the routine's real statement list,
so it belongs in a test that inspects `pg_policies` against a declared
writer/command table, not in the source-scanning
`scripts/check-migration-rls-backfills.ts`, which strips `CREATE FUNCTION`
bodies by design and structurally cannot see any of them.

`packages/db/test/owner-migrated-tenancy-cutover.test.ts` is the
regression harness for the runtime half.

### Enforcement

- `bun run check:migration-rls-backfills` (`scripts/check-migration-rls-backfills.ts`,
  library in `scripts/migration-rls-backfills.ts`) replays the whole ordered
  ledger, tracks per-table `ENABLE`/`FORCE`/`NO FORCE` state, and fails on any
  **new** migration that writes, or guards with `RAISE EXCEPTION` over, a
  FORCE-RLS table outside a window. It runs as the `migration-rls-backfills` CI
  guard whenever `packages/db/drizzle/` changes, and its unit test
  (`scripts/check-migration-rls-backfills.test.ts`) also pins the shipped ledger.
- `acquireOwnerMigratedTestDatabase` (`packages/testing/src/shared-pg.ts`) hands
  out a database owned by a `NOSUPERUSER NOBYPASSRLS` login role, so a test can
  drive `migrate()` through the real production boundary.
