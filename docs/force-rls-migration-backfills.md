# FORCE-RLS migration backfills

Canonical home for one migration hazard class: a data backfill that runs during
a migration over a table with `FORCE ROW LEVEL SECURITY`, matches **zero rows**,
and reports success.

## The mechanism

`FORCE ROW LEVEL SECURITY` binds the **table owner**, not merely ordinary roles.
Only a genuine `SUPERUSER` (or a role with `BYPASSRLS`) is exempt. OpenGeni's
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

1. **Open the owner-only posture window** (preferred; the house pattern, see
   `packages/db/drizzle/0009_goal_sessions_first_party_goals_manage.sql` and
   `0120_durable_goal_wake.sql`):

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

### The runtime sibling: SECURITY DEFINER reads and row locks

The same binding applies at *runtime*, not only during a migration. A SECURITY
DEFINER routine owned by the schema owner is policy-bound on a FORCE-RLS table
exactly like an ordinary caller, so a definer that reads a tenancy table needs a
policy branch it can actually satisfy - a capability row, or one of the
`opengeni.organization_tenancy_lifecycle` markers the authority tables already
gate on (`0263`'s `assert_active_managed_human_organization_membership` is the
worked example, and `0336`'s
`opengeni_private.bind_connection_owner_authority` is the newer one).

One PostgreSQL rule makes this class especially easy to miss: **`SELECT ... FOR
UPDATE/SHARE` is gated on the UPDATE/ALL policy `USING` clause in addition to
the SELECT one.** A capability policy declared only `FOR SELECT` therefore lets
a plain read through and silently returns **zero rows** for the identical query
with a row lock on it. That is exactly how migration 0256's connection
owner-membership lookup became blind on every production deployment while its
sibling classifier - the same join without `FOR SHARE` - kept working.

The organization-tenancy lane alone has produced four instances, all invisible
until a test ran through `acquireOwnerMigratedTestDatabase`:

| Writer | Table | Command it issues | Was covered by |
| --- | --- | --- | --- |
| `bind_connection_authority` (mint) | `organization_memberships` | `SELECT ... FOR SHARE` | a `FOR SELECT` policy only |
| `bind_connection_authority` (mint) | `organization_user_resource_authorities` | `INSERT` | nothing |
| `bind_connection_authority` (backfill verify) | `organization_memberships` | `SELECT ... FOR SHARE` | a `FOR SELECT` policy only |
| `activate_session_tenancy_product` | `session_tenancy_activations` | `INSERT` | a `FOR SELECT` policy only |

A fifth, same class but not a write: 0305 restated the shared
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

`packages/db/test/migration-0336-owner-migrated-tenancy-cutover.test.ts` is the
regression harness for the runtime half, the way
`migration-0296-force-rls-backfill-repair.test.ts` is for the migration half.

### Enforcement

- `bun run check:migration-rls-backfills` (`scripts/check-migration-rls-backfills.ts`,
  library in `scripts/migration-rls-backfills.ts`) replays the whole ordered
  ledger, tracks per-table `ENABLE`/`FORCE`/`NO FORCE` state, and fails on any
  **new** migration that writes, or guards with `RAISE EXCEPTION` over, a
  FORCE-RLS table outside a window. It runs as the `migration-rls-backfills` CI
  guard whenever `packages/db/drizzle/` changes, and its unit test
  (`scripts/check-migration-rls-backfills.test.ts`) also pins the shipped ledger.
- The offenders that predate this guard are recorded in `GRANDFATHERED_MIGRATIONS` and
  `GRANDFATHERED_VACUOUS_GUARDS`. Migration bytes are frozen by the release
  schema-contract hash ladder and cannot be rewritten. **Do not add to those
  lists.**
- `acquireOwnerMigratedTestDatabase` (`packages/testing/src/shared-pg.ts`) hands
  out a database owned by a `NOSUPERUSER NOBYPASSRLS` login role, so a test can
  drive `migrate()` through the real production boundary.
  `packages/db/test/migration-0296-force-rls-backfill-repair.test.ts` is the
  worked example: it demonstrates the no-op before the repair and convergence
  after, in one run.

## Repair: migration 0296

`packages/db/drizzle/0296_force_rls_backfill_noop_repair.sql` (rolling) repairs
the three statements whose no-op neither aborts its own migration nor is
recomputed by any runtime path:

| Origin | Statement | Production symptom |
| --- | --- | --- |
| `0256_connection_authority_delegation.sql` | `UPDATE connections SET origin_workspace_id = workspace_id` | `resolve_accepted_connection_use` compares `origin_workspace_id IS DISTINCT FROM p_workspace_id`; a `NULL` denies **every** workspace-owned connection with `connection_identity_changed`. |
| `0262_scoped_connected_machines_and_rigs.sql` | `UPDATE enrollments SET origin_workspace_id = workspace_id` | Connected Machine provenance lost; a later user-scope conversion writes an `organization_user_resource_authorities` row with a `NULL` origin. |
| `0263_organization_membership_lifecycle.sql` | `UPDATE organization_memberships SET role = 'owner'` (self-organization) | `organization_membership_command` denies invite, accept/revoke, role change, suspend/reactivate, offboard, and retention policy for every pre-0263 organization; "cannot demote the last owner" sees zero owners. |

The repair is idempotent and non-widening:

- `connections` / `enrollments` are touched only where
  `authority_scope = 'workspace'` and `origin_workspace_id IS NULL`, and only to
  the value the shipped constraint already requires. Every later scope is written
  by the lifecycle routines, which set the column explicitly.
- `organization_memberships` re-executes 0263's own predicate verbatim - an exact
  identity match between the self-organization's external Better Auth user and
  the membership subject - the same predicate the live
  `organization_memberships_assign_managed_self_owner` `BEFORE INSERT` trigger
  already applies to every new row.
- Authority is never inferred from `created_by`, connection attribution, a
  default workspace, a resource name, or current access.
- On a superuser-migrated deployment, where the originals *did* succeed, all
  three statements match zero rows.

0256's `connections_authority_binding` trigger treats `origin_workspace_id` as
immutable owner authority, so the repair disables it for the window. That is
transactional DDL behind the `ACCESS EXCLUSIVE` lock the statement already takes,
so no concurrent writer ever observes the table without its binding trigger.

### Operator procedure

Rolling. `bun run db:migrate` (or the Helm migration Job) applies 0296 with no
drain. The migration's own verification block raises SQLSTATE `55000` and rolls
the whole file back if the repair did not converge.

To see the exposure before migrating, from the migration (owner) connection:

```sql
ALTER TABLE connections NO FORCE ROW LEVEL SECURITY;
SELECT count(*) FROM connections WHERE origin_workspace_id IS NULL;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;
```

A non-zero count on a deployment that already ran 0256 confirms the no-op.

## Full classification of the shipped ledger

Sixty-eight migrations contain a top-level write over a FORCE-RLS table; twenty
contain a preflight guard that can never fire. The complete machine-checked
inventory is `GRANDFATHERED_MIGRATIONS` / `GRANDFATHERED_VACUOUS_GUARDS` in
`scripts/migration-rls-backfills.ts`. Their dispositions:

### Repaired by 0296

`0256` (`connections.origin_workspace_id`), `0262` (`enrollments`), `0263`
(`organization_memberships.role`).

### Self-aborting - the migration cannot have committed with data present

The un-backfilled state makes a later `VALIDATE CONSTRAINT` / `SET NOT NULL` /
non-`NOT VALID` `ADD CONSTRAINT` / unique-index / FK check evaluate `FALSE`, and
those bypass RLS. If such a deployment exists, it is stuck loudly, not silently
wrong:

`0018`, `0057` (queue-purity + waiter FK), `0058`, `0063`, `0068`, `0069`,
`0111` (deferred to `0113`), `0117`, `0122`, `0126`, `0135`, `0136`, `0152`,
`0172`, `0175`, `0180` (first statement), `0184`, `0186`, `0202`, `0212`
(browser state transfer), `0213`, `0215`, `0222`, `0224`, `0226`, `0232`
(component kind), `0233`, `0252`, `0256` (the personal-connection loop - its
`connections_authority_shape_check` is `FALSE` for a `subject_id IS NOT NULL`
row, so the classification half aborts rather than mis-classifying), `0258`,
`0289` (the `sessions.reasoning_effort` / `sessions.latency_mode` seed is
followed immediately by `SET NOT NULL` on both columns in the same file, so a
blinded backfill leaves every pre-existing row `NULL` and the migration aborts).

### Benign

Value is recomputed by the runtime, the statement is no-op-shaped anyway, the
column already carried the intended DDL default, the table is provably empty at
that point in history, or a later protected migration redoes the work:

`0014`, `0045` (residual: pre-0045 memories keep a `NULL` `text_hash`), `0057`
(event-vocabulary and session-pointer rewrites), `0061` (`runtime_control_operations`,
dropped by `0063`), `0063` (audit appends, obsolete metadata key), `0064`,
`0136` (`composer_drafts`), `0138`, `0143`, `0170`, `0197`, `0225`, `0232`
(`capability_operations`), `0247` (temp-table driver).

### Protected by policy shape, not by a window

`0094` (`capability_catalog_items` - the global-row policy branch admits exactly
the targeted rows; `import_batches` - `USING (true)`), `0104` (`host_export_outbox`
carries an owner-role policy), `0235` (RLS is enabled *after* the backfill),
`0063` (`workspaces` is not FORCE-RLS).

### Genuinely no-oped, NOT repaired here - each needs its own reviewed repair

These are real and were newly discovered while establishing the blast radius.
They are deliberately out of scope for the 0296 repair because each one either
re-derives live session-lifecycle state, needs immutability triggers disabled
again, or would change authority, and must be reviewed on its own:

| Migration | What is wrong today |
| --- | --- |
| `0061` | The wake-outbox cutover seed inserted nothing and `list_enrollable_sessions` was dropped in the same file. Sessions with queued/recovering/`requires_action` work, pending machine input, or `compact_requested` at that boundary are permanently un-enrolled. `0120` later re-arms only active goals with no queued work. |
| `0057` | `running` turns were never moved to `recovering`. `list_claimable/enrollable/continuable_sessions` never enumerate `running`, and the stale row occupies `session_turns_one_current_inference_uq`, so the session can neither continue nor accept a new claim. |
| `0065` | `session_turn_attempts.quiesced_at` never backfilled. A closed attempt with a settled interruption and a `NULL` receipt blocks every future claim on that session, and `0174` makes each wake pass emit a `sessionControl` cancellation for it. |
| `0132` | Legacy hosted-Slack MCP connections keep `subject_id IS NULL`, so a personal-only credential stays workspace-visible; the matching `capability_installations` metadata still carries the concrete connection UUID. **Do not blind-repair:** re-running infers user ownership from `created_by_subject_id`, which the current authority rules forbid. Audit and decide explicitly. |
| `0148` | `session_turns.latency_mode` disagrees with the row's own frozen metadata; because the column is `NOT NULL DEFAULT 'standard'`, goal continuations read `standard` and lock the degradation in. |
| `0149` | Pre-0149 sessions keep `first_party_mcp_permissions IS NULL`, which the editable-artifact authorization functions treat as allow-all. |
| `0180` | `workspace_screenshot_quotas` counters were never re-projected. |
| `0212` (Slack bindings) | `slack_installation_bindings` is empty, so `resolve_slack_installation` finds nothing for already-verified installs. Partially self-heals through the sync trigger on the next connection update. |
| `0216` | `auth_runs.health_sequence` ordering plus a `setval` reset to `1`; new runs collide with existing sequence values. |
| `0231` | The integration-identity cutover migrated nothing and its own postconditions certified convergence. |
| `0232` | Pack manifests/snapshots/digests and `integration_facet_binding_owners.owner_id` keep the `feature:` shape. |
| `0238` (goal persistence) | No `session_goal_revisions` baseline for pre-existing goals; sessions with an explicit tool list never gained `goal_progress`. |
| `0238` (recover unclaimed turns) | The entire migration is one RLS-blinded `WITH RECURSIVE ... INSERT`; nothing was unstuck. |
| `0240` | Slack sessions never received the durable replacement safety policy, and the cutover's live-turn gate cannot fire. |
| `0247` | The Terraform Stacks provenance repair changed nothing. |
| `0275` | `scheduled_task_revision_authorities` is empty, and `dispatched` runs stranded by the no-op now violate a live `NOT VALID` CHECK, so any future UPDATE of them fails. |
| `0277` | Pre-0277 `sandbox_workspace_mutation_admissions` / `sandbox_retained_processes` keep the `legacy_unattributed` sentinel, so a new persistable `/workspace` write fails closed with `authority_unattributed`. |
| `0094` | `capability_installations` rows still point at quarantined catalog entries. |
