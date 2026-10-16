# Expand/contract migrations

Rolling is the default deployment mode for an Opengeni migration. Write
`-- deployment-mode: rolling` on line 1 and shape the change so the previous
release keeps working against the new schema. Use
`-- deployment-mode: maintenance` only when no expand/contract sequence works,
and say why in the file.

## Historical server compatibility

Published migration files remain byte-for-byte immutable. PostgreSQL 18 added
column NOT NULL entries to `pg_constraint`, so the migration runner adapts only
the exact deployed 0345/0598 sources through
`packages/db/src/migration-postgres-compatibility.ts` on PostgreSQL 18 or newer.
The adapter verifies the source SHA-256 before excluding `contype = 'n'` from
three registry/capability comparisons and the pool constraint-copy loop.
0345 still checks `pg_attribute.attnotnull`; 0598's `CREATE TABLE ... LIKE`
already copies NOT NULL. Ownership, ACL, RLS and all other constraints remain
unchanged. Older servers use the original SQL, and already-applied migrations
are not rerun. Release-schema contracts hash the original files, not adapted
execution text. A new forward migration cannot repair an earlier fresh-install
failure, and changing the historical files would invalidate deployed hashes.

## Why rolling is the default

The deploy applies every pending migration in the pre-upgrade hook, before it
replaces application pods, so for the whole rollout the previous release's API,
control workers and turn workers run against the new schema.
`bun run db:migrate-plan` reports `requiresDrain: true` as soon as one pending
migration is maintenance, and then every API, control and turn worker is
stopped for the entire release, however many rolling migrations ride along. On
2026-10-15 one release carried 135 migrations as a single maintenance batch and
production was down for 1 h 47 min.

A rolling migration therefore has one rule: **every binary from the previous
release must keep reading, writing and passing readiness after it commits.**

## The sequence

1. **Expand** (rolling). Add the new shape next to the old one: nullable
   columns or columns with a `DEFAULT`, indexes (`-- opengeni:concurrent-index`
   on hot tables), and triggers that fill or sync the new shape from old
   writers' rows. New tables are safe in `opengeni_private` without direct
   runtime grants; a new data-schema table with RLS or runtime grants changes
   the runtime posture the previous release checks on every readiness probe, so
   follow the posture recipe below.
2. **Migrate** (code plus rolling backfill). Ship code that writes both shapes
   and reads the new one, falling back to the old one where it is still empty.
   Backfill existing rows with a `-- opengeni:batched-backfill` migration on
   large tables, then validate constraints in a separate migration.
3. **Contract** (rolling, annotated). Once no binary that might still run uses
   the old shape, remove or narrow it. Mark the file with
   `-- contract-step: <migration or PR after which nothing uses it>`, or say
   why the previous release is unaffected (for example a fill trigger covers
   its writes).

A step that only adds is safe in the same release as the code that uses it. A
contract step must ship in a release **after** the release whose code stopped
using the old shape: the release that drops a column can only follow a release
that already ignores it. Count on two to three releases for a full sequence:

| Change                         | Release N                                                     | Release N+1                                                  | Release N+2                |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- |
| Add a column                   | expand + code                                                 | -                                                            | -                          |
| Drop a column/table            | code stops reading and writing it                             | drop (`contract-step`)                                       | -                          |
| Rename a column                | new column, sync trigger, dual-write, backfill                | read new only, stop writing old                              | drop old (`contract-step`) |
| Change a column type           | same as rename, with the new type                             | read new only                                                | drop old (`contract-step`) |
| Make a column NOT NULL         | code always writes it; fill trigger or `DEFAULT`; backfill    | `CHECK ... NOT VALID`, validate, `SET NOT NULL` (`contract-step`) | -                     |
| New writer protocol (fences)   | code follows old **and** new protocol                         | enforce new protocol (`contract-step`)                       | drop old protocol          |
| New FORCE-RLS, grants, posture | posture evaluator accepts both postures                       | apply the new posture                                        | evaluator requires it      |

Steps marked for a later release can wait longer; they cannot go sooner.

## Recipes

**Rename a column or table.** Prefer not to: names are cheap, outages are not.
If you must, add the new column (or table), keep both in sync with a trigger or
dual writes, backfill, move every reader to the new name, and drop the old one
in a later release. Never `RENAME` in place: the previous release's queries
fail the moment it commits.

**Change a column type.** Add a column with the new type, dual-write or sync it
with a trigger, backfill, switch readers, drop the old column later. A
metadata-only widening that previous binaries read and write unchanged (for
example `varchar(n)` to `text`) may ship as one rolling step; annotate it with
`-- contract-step:` saying why the previous release is unaffected.

**Add NOT NULL.** For a new column use `ADD COLUMN ... NOT NULL DEFAULT ...`:
old writers get the default. For an existing column, release N ships code that
always writes it plus a `DEFAULT` or a `BEFORE INSERT` fill trigger so the
previous release's writes are filled too, then backfills. Only then add
`CHECK (col IS NOT NULL) NOT VALID`: PostgreSQL enforces it on every new write
immediately, so it must not land while an old writer can still write NULL.
`VALIDATE CONSTRAINT` in its own migration, then `SET NOT NULL`, which
PostgreSQL proves from the validated check without a rescan. Migrations
0110-0114 are the reference (0110's fill triggers made the rest rolling).

**Drop a column or table.** Release N removes every read and write, and, if
the column is `NOT NULL` without a default, drops that constraint or adds a
default so release N's inserts succeed. Release N+1 drops it with
`-- contract-step:`.

**New FORCE-RLS, grants or other runtime-posture changes.** API readiness
re-checks the exact database posture on every probe
(`packages/db/src/runtime-posture.ts`), so the previous release's evaluator
marks its pods unready when it sees data-schema tables, policies, grants or
FORCE-RLS state it does not know. Either keep the new objects in
`opengeni_private` with execute-only access (as the allowance accounting tables
do), or first ship an evaluator that accepts both postures, apply the posture in
a later release, then tighten the evaluator. Migrations 0404-0405 changed the
posture and the evaluator in one release, which made them a maintenance
boundary.

**Writer-protocol changes** (for example a trigger that rejects writes without
a new advisory fence, as in 0345). First ship binaries that follow the old and
the new protocol together, taking locks in application order (see the lock-order
rule in `AGENTS.md`). Install the enforcing trigger in a later release, marked
`-- contract-step:` with the release that first followed the new protocol. A
trigger that rejects old writers in the same release as the code that satisfies
it is a maintenance migration.

**Backfills over FORCE-RLS tables.** A bare `UPDATE` matches zero rows for the
migration owner; see [force-rls-migration-backfills.md](force-rls-migration-backfills.md).
`ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` holds an `ACCESS EXCLUSIVE` lock
until commit, so use that window only for small tables. For large or hot tables,
add a GUC-gated owner policy arm in the expand migration, run the backfill with
`-- opengeni:batched-backfill` and register its GUC in
`packages/db/src/migration-runner-settings.ts`, then validate in a separate
migration (0409-0412 are the reference sequence).

## When maintenance is justified

Only when old and new binaries cannot both be correct against any intermediate
schema, and the release must not run mixed even briefly: for example a one-way
security cutover where any window with old writers is itself the
vulnerability, or a change the previous release cannot be taught to tolerate
because it is already shipped and its behavior is wrong. "It is more work" or
"it is a small table" is not a justification.

Put the justification in the leading comment block: the comment lines before
the first SQL statement or `/* */` comment. An `-- opengeni:` directive must
stay on line 2, so the justification goes below it. Wrap long text onto
continuation lines indented as `--   `; the value ends at a blank line or an
unindented comment:

```sql
-- deployment-mode: maintenance
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
-- maintenance-justification: revokes a credential path that pre-NNNN binaries
--   still serve; any window where an old API runs is the exposure itself.
```

It needs at least 40 characters and six words, and placeholders such as `TODO`,
`TBD`, `n/a` or `<...>` fail. A `-- opengeni:concurrent-index` migration cannot
carry other comment lines and is always rolling. Also document the operator
steps (drain, roles, image pinning) in `docs/deployment.md` or a note under
`docs/maintenance-migrations/`.

## The CI guard

`bun run check:migration-deployment-mode` (`scripts/check-migration-deployment-mode.ts`)
runs in CI on every migration change. For every migration from ordinal 0786 on
it fails when:

- line 1 is not exactly `-- deployment-mode: rolling` or
  `-- deployment-mode: maintenance`;
- an `-- opengeni:` directive sits anywhere but line 2, or a concurrent-index
  migration is declared maintenance;
- a maintenance migration has no meaningful `-- maintenance-justification:`;
- a rolling migration runs `DROP COLUMN`, `DROP TABLE`, `RENAME COLUMN`,
  `RENAME TO`, `ALTER COLUMN ... TYPE` or `SET NOT NULL` on a table it did not
  create earlier in the same file, without `-- contract-step:`.

The contract-step check is deliberately narrow. It ignores comments, string
literals, function bodies, `DROP INDEX`/`TRIGGER`/`POLICY`/`FUNCTION`/
`CONSTRAINT`, and DDL built dynamically in strings. It also does not catch other
changes that break old binaries, such as dropping a unique constraint an
`ON CONFLICT` relies on, `SET SCHEMA`, `DROP DEFAULT`, `ADD COLUMN ... NOT NULL`
without a default, `ADD CHECK ... NOT VALID`, `DROP VIEW`, `DROP TYPE` or
`RENAME VALUE`. Passing the guard does not make a change backward compatible;
the review still has to. Shipped migrations are frozen and exempt; never raise
the threshold to exempt a new file.
