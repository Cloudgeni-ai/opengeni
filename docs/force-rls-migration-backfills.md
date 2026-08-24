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

`packages/db/drizzle/0334_document_authority_reclassification.sql`'s
`reclassify_document_authority` follows both rules and asserts the window is live
before the read, so a regression aborts instead of quietly pinning a personal
Document to its origin workspace forever.

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
