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

The same closed adapter stabilizes 0807's policy deparsing on all supported
servers. Dedicated-schema deployments put `opengeni_private` on `search_path`,
which causes `pg_get_expr` to omit the schema that 0807's exact helper matcher
requires. Only that hash-pinned source temporarily uses the quoted data schema
and `pg_catalog` while deparsing and rewriting policies, then restores the
caller's path. The strict matcher, row-account fence, administrator check and
transaction boundaries remain unchanged; failure rolls back the local setting.

## Why rolling is the default

Rolling migrations can run while the previous release's API, control workers
and turn workers serve traffic. The legacy deployment runs all pending work in
one job, parking the fleet if any migration needs maintenance. On 2026-10-15
one release carried 135 migrations as a single maintenance batch and production
was down for 1 h 47 min. Phase-aware orchestration can instead keep only the
necessary middle span parked (the runner itself never parks or restores pods).

A rolling migration therefore has one rule: **every binary from the previous
release must keep reading, writing and passing readiness after it commits.**

## Release phases

Most authors need no new annotations: posture-inert rolling migrations run before parking,
and non-unique concurrent indexes run after traffic returns, subject to file
order. The runner never skips dependencies by moving files across each other.
From the database's currently pending files, in file order, it partitions:

1. **post**: the maximal suffix of post-release-eligible migrations.
2. **pre**: the longest prefix of the rest that is both rolling and
   posture-inert, stopping at the first other file.
3. **maintenance**: everything between them, including any intervening rolling
   work. Even an all-rolling release can have a nonempty maintenance span.

These phase names describe safety classes, not deployment-mode headers. Until
the old production binary has forward-compatible readiness, a rolling header
alone cannot prove its continuously checked posture stays ready. Concurrent
indexes and batched backfills are inert. Ordinary SQL is admitted only when it
has no table/function/procedure creation, grants/revokes, ownership changes,
row-level security or policies, schema creation, default privileges, views,
`SECURITY DEFINER`, or table/function drops. Unknown/dynamic statement forms
(including `DO`, `CALL`, and nonliteral `SELECT`/CTEs), table renames/moves/
inheritance/partition changes, and role switches stay out of pre. Historical/unclassified files also
stay out. Comments do not count as SQL; uncertainty conservatively moves work
into the middle span rather than rejecting execution.

For a maintenance deployment, run pre while live, then run maintenance while
parked. For a rolling deployment, run **maintenance**, not just pre, before
rolling the fleet, as the legacy workflow did; `requiresDrain` retains its
existing meaning and is not recomputed from the phase name. Post always follows
the rollout. TODO: relax the inert prefix only after forward-compatible
readiness is already running in production, not when first deploying that fix.

Only rolling migrations accepted by the concurrent-index or batched-backfill
parser can be eligible. Non-unique concurrent indexes are eligible automatically.
A unique concurrent index or batched backfill needs `-- opengeni:post-release`;
add it **only when the new code tolerates the index being absent or the backfill
being incomplete**. Never mark ordinary DDL, tables, columns, grants, functions,
maintenance or unclassified migrations. Use `-- opengeni:pre-release` to keep an
automatically eligible index out of post (it still follows file order and may
therefore land in the maintenance span). Never combine both markers.

Keep the execution directive on line 2 and the release marker immediately below
it, before SQL. For example:

```sql
-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- opengeni:post-release
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS widgets_external_id ON widgets (external_id);
```

The same marker placement works with `-- opengeni:batched-backfill ...`.
Do not edit shipped migrations to add markers; their hashes remain immutable.

From `packages/db`, the ops contract is:

| Command | Work applied |
| --- | --- |
| `bun src/migrate.ts --phase=pre` | pre only, before parking |
| `bun src/migrate.ts --phase=maintenance` | pre + maintenance, parked for maintenance releases or before a rolling rollout |
| `bun src/migrate.ts --phase=post` | all remaining work, after restoring traffic |
| `bun src/migrate.ts` | all remaining work, unchanged default |

`--phase pre` also works. `OPENGENI_MIGRATION_PHASE` selects the CLI phase when
no flag is present; a flag wins, and invalid values fail before connecting.
Programmatic `migrate`/`runMigrations` callers may pass `phase` in runtime
options; without it they continue applying everything, independent of the CLI
phase environment variable. Every invocation recomputes from committed receipts
under the existing advisory lock, preserves depth-policy reconciliation, and is
safe to retry after partial progress. A later phase catches up earlier work.
Each phase opens a fresh connection with the database URL's startup settings.
For example, 0874's `RESET statement_timeout` restores a URL-configured 35-minute
timeout after 0867's backfill, and 0875/0879 inherit it whether executed in that
same invocation or a fresh post phase. Concurrent builds temporarily use
`lock_timeout=0` and do not override `statement_timeout`.

`--plan` / `planMigrations` retain `pending` and `requiresDrain` unchanged and
add `phaseProtocol: 1` and `phases: {pre: string[], maintenance: string[], post:
string[]}`. Planning remains read-only; its snapshot is not execution authority.
Ops must fall back to the legacy single job when `phaseProtocol` is absent.

Every successful CLI phase prints the exact legacy success line:

```text
Applied Drizzle SQL migrations.
```

It also prints one compact JSON line (other existing runner logs remain):

```json
{"schemaVersion":"opengeni/migration-phase/v1","phase":"pre","applied":["0900_example.sql"],"remaining":["0901_example.sql"]}
```

Names are full SQL filenames in file order. `applied` means newly applied by
this invocation, not the cumulative ledger; `remaining` is pending after it.
No-phase runs report `"phase":"post"`. Failed runs do not print a success
receipt; already committed migration receipts are used on retry.

## The sequence

1. **Expand** (rolling). Add the new shape next to the old one: nullable
   columns or columns with a `DEFAULT`, indexes (`-- opengeni:concurrent-index`
   on hot tables), and triggers that fill or sync the new shape from old
   writers' rows. New ungranted tables and securely shaped FORCE-RLS tables with
   runtime grants can be additive, once the previous release contains the
   forward-compatible posture evaluator. Follow the posture recipe below.
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
| New FORCE-RLS table + grants   | ship forward-compatible evaluator once                       | add securely shaped table + its code                         | -                          |
| Change a known posture        | evaluator accepts both exact postures                        | apply the new posture                                        | evaluator requires it      |

Steps marked for a later release can wait longer; they cannot go sooner.

## Recipes

**Concurrent indexes and readers.** The concurrent-index runner lets PostgreSQL
finish its safe wait for older snapshots (also needed for partial/expression
indexes when the reader uses another table). It temporarily disables
`lock_timeout` for `CREATE/DROP INDEX CONCURRENTLY` and restores the caller's
setting afterwards. Historical `lock-timeout=5s` directive text remains immutable
and parseable, but does not bound these waits. Ordinary migration DDL still uses
its five-second lock timeout. A failed or interrupted concurrent build is never
treated as applied: the next attempt drops an invalid index concurrently and
rebuilds it before the migration receipt is written. No reader is cancelled.

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

**New FORCE-RLS tables and routines.** API and worker startup and worker readiness
use `packages/db/src/runtime-posture.ts`. Once this forward-compatible binary
is the **previous production release**, an entirely unknown table in the data
schema or `opengeni_private` may have SELECT, INSERT, UPDATE and DELETE grants when RLS is enabled,
forced, active for the runtime role, has at least one policy, and the runtime
does not own it, and it has no inheritance or partition relationship. Parent
queries use the parent's ACL/RLS rather than a known child's contract, so these
relationships require explicit compatibility review, even when the unknown
child has no direct grants (a known parent still exposes it). TRUNCATE, REFERENCES,
TRIGGER, MAINTAIN and other non-row privileges are never tolerated on unknown
tables. Ungranted unknown non-RLS tables are harmless; runtime grants
(including column-only grants) on them still fail readiness. A data-schema
table declaring RLS but not meeting the secure shape also fails. Private
owner-only tables without grants remain inert. Existing default privileges can
grant DML automatically on new tables; inspect effective grants, not merely the
presence of GRANT statements in a migration.

Unknown routines may be SECURITY INVOKER, or SECURITY DEFINER only when neither
runtime nor PUBLIC can execute them and they are not trigger/event-trigger
functions or bound in `pg_trigger`. PostgreSQL does not check EXECUTE when a
trigger fires: owner-only trigger definers still require a prior explicit binary
contract. Definers must also have no catalog dependents in `pg_depend`: aggregates
and other support-function callers can invoke them without checking the support
function's EXECUTE grant. Missing dependency metadata fails closed. Runtime ownership always fails. A fixed
search path and a non-runtime owner cannot prove an unknown definer's body
safe: it could expose an owner capability or disable owner RLS. Introduce an
explicit, reviewed compatibility-binary contract before granting EXECUTE on
such a definer. The old private-routine catalog's implicit EXECUTE contract is
now frozen in `packages/db/src/runtime-posture-legacy-routines.json`; it is an
inventory, not a provisioning grant list. Never regenerate it from a live
database to silence findings. New named private capabilities need explicit
registration and their own authority tests.

**A new definer the runtime must call takes two releases.** Create it without
runtime EXECUTE, and register it in `RUNTIME_DEFINER_ROUTINES` and
`DEFERRED_RUNTIME_PRIVATE_ROUTINES` so readiness accepts it with or without
the grant. Code that calls it treats `insufficient_privilege` as "not yet".
Once a binary that knows it is the previous release (the pinned baseline
below), grant it in a rolling migration, drop it from
`DEFERRED_RUNTIME_PRIVATE_ROUTINES` so readiness requires it, and remove the
"not yet" handling. A new non-RLS table the runtime writes needs the same two
steps, with readiness accepting no runtime DML or all four. 0929, 0930, 0932
and 0935 granted on creation instead; 0937 withheld those grants and the
`event_ingress_routes` DML again, and 0947 restored them. 0946 created the
recording retention inventory withheld, and 0950 granted it. 0978 created the
personal-machine owner lookup withheld; its callers check
`has_function_privilege` first, because they run inside transactions that a
permission error would abort. 0984 created the connected-command re-arm
withheld the same way, with the same caller check.

**If `migrate` stops anywhere between 0929 and 0937, fix it and rerun it
immediately.** Until 0937 commits, the previous release's readiness rejects
those grants, so the old fleet stays unready. The gap is normally only the
seconds the migrations before rollout (`--phase=maintenance`) take.

Every existing check for **known** objects remains exact: missing objects and
privileges, excess grants, owner relationships, RLS, capability predicates,
search paths and cutover receipts. Caller-specific contract overrides cannot
turn a binary-known table or routine into an unknown one. A known table's
column grants do not satisfy its required table-level privileges.

This is structural readiness, not policy/body verification. Migration review
must still establish tenant isolation and the appropriateness of every grant;
always-true policies remain outside this structural check. Non-row privileges
and unknown trigger definers fail readiness rather than relying on review alone.

The 0796/0797 headers describe a **historical** previous binary that rejected
all new protected tables. Leave their bytes and maintenance markers unchanged.
For future changes of that shape, do not copy that blanket maintenance
justification once the compatible binary is in production. A new FORCE-RLS
table and DML grants can then be rolling in one release; new callable definers
or changes to known-object contracts can still need a prior compatibility
release. Cite the actual incompatible operation, the pinned old-binary test
failure and why an expand/contract sequence cannot work if maintenance is
necessary. The presence of a new table alone is no longer a justification.

**Changes to a known posture.** Ship an evaluator accepting both specific
postures, change the schema in a later release, then tighten it. Forward
compatibility never permits relaxing an old object's RLS or widening its grants.

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
the first SQL statement or `/* */` comment. An execution `-- opengeni:` directive must
stay on line 2, so the justification goes below it. Wrap long text onto
continuation lines indented as `--   `; the value ends at a blank line or an
unindented comment:

```sql
-- deployment-mode: maintenance
-- maintenance-justification: revokes a credential path that pre-NNNN binaries
--   still serve; any window where an old API runs is the exposure itself.
```

It needs at least 40 characters and six words, and placeholders such as `TODO`,
`TBD`, `n/a` or `<...>` fail. A `-- opengeni:concurrent-index` migration cannot
carry other comment lines except the release markers and is always rolling. Also document the operator
steps (drain, roles, image pinning) in `docs/deployment.md` or a note under
`docs/maintenance-migrations/`.

## The CI guard

### Pinned previous-binary readiness

`scripts/runtime-posture-baseline.json` pins a full immutable source commit,
not a moving branch or tag. `runtime-posture-compatibility.yml` runs on database
PRs (including main PRs, whose broad CI is otherwise post-merge only) and pushes.
It migrates a fresh PostgreSQL database as a NOSUPERUSER/NOBYPASSRLS owner,
runs the current `provision-roles`, then calls **both the inspector and evaluator
from the pin** as the restricted runtime login. The checked-out source's full
named-object contracts are used, not a reconstructed subset of tables.
This is the deterministic readiness-code equivalent of starting the old API
and workers; it does not test their other queries or writer protocols.

The test also adds safe unknown objects and deliberately weakens RLS, adds
unsafe grants/definers and revokes known EXECUTE privileges. Both the current
and pinned binary must reject the negative controls. Missing PostgreSQL, pin
objects or extraction dependencies fail the dedicated job; there is no green
fallback to current code. Existing per-feature old-reader harnesses (for
example `fixtures/site-limits-2fef1581b.ts`) remain necessary for non-readiness
compatibility. The release-schema hash tests and historical maintenance notes
are complementary, not evidence that an old readiness probe passes.

The historical production source `bcc60cd80f2fd557e9f64beee38c1562d629de8c`
also runs as a negative control. Against the schema through 0887 it produces
42 violations: undeclared RLS plus grants for `session_title_operations` and
`site_session_access`, and 39 private helper EXECUTE expectations. The test
replays the two safe table shapes and 19 non-trigger owner-only helpers under
future names, preserving all current known objects, and requires both
compatibility evaluators to accept them without granting EXECUTE. The other
20 helpers are SECURITY DEFINER triggers: renamed unknown copies must still
fail, even with EXECUTE revoked. Treating all 39 as inert would introduce an
RLS-bypass path. Existing named trigger contracts remain unchanged. Later additions may add historical violations;
intentional retirement of this witness needs an explicit test update.

**Bootstrap:** the initial pin is explicitly `status: "bootstrap"`, pointing
at the compatibility implementation commit in this PR. It is not a claim
about today's production binary, which predates the fix. No additive rollout
may rely on this tolerance until the fix has shipped. After this PR is merged
and released, make a pin-only PR setting `sourceCommit` to the full released
merge/source SHA, `status` to `production`, and `release` to its immutable
production release receipt/tag. Repeat after each successful production
release. Resolve tags to their source commit before recording them; do not
follow "latest" at test time or advance the baseline in a migration PR to
make an incompatibility disappear. Retain/fetch the exact pin commit when
checking out shallow history. A legitimate incompatible maintenance change
will fail this rolling-readiness proof and needs an explicitly coordinated
compatibility release, not an automatic pin refresh or a skipped test.

### Migration declaration checks

`bun run check:migration-deployment-mode` (`scripts/check-migration-deployment-mode.ts`)
runs in CI on every migration change. For every migration from ordinal 0786 on
it fails when:

- line 1 is not exactly `-- deployment-mode: rolling` or
  `-- deployment-mode: maintenance`;
- an execution `-- opengeni:` directive sits anywhere but line 2, or a concurrent-index
  migration is declared maintenance;
- `post-release` marks anything other than a valid rolling concurrent-index or
  batched-backfill migration, or both release markers appear together;
- `pre-release` appears without a valid concurrent-index or batched-backfill
  execution directive (ordinary migrations cannot carry this marker);
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

## Online-safety guard

`bun run check:migration-online-safety` checks **0888 and later**. This separate
boundary leaves the already-shipped 0786–0887 deployment-mode range frozen;
never raise it to admit a new migration. The impact-selected CI guard runs with
the other migration checks. Ordinary main PRs use targeted local tests before
merge; the full CI impact plan runs after merge, following repository policy.
`bun scripts/check-migration-online-safety.ts --audit-existing` reports the older
0786+ range without failing CI or modifying SQL.

| Rule ID | Rolling migration rule / fix |
| --- | --- |
| `nonconcurrent-index` | Existing-table indexes need `CONCURRENTLY` in a separate file with the runner's line-2 `-- opengeni:concurrent-index lock-timeout=5s` directive. |
| `constraint-validation` | Add FOREIGN KEY/CHECK constraints `NOT VALID`; validate in a separate migration. Validation after another ALTER of that table in the same file retains its strong lock through the scan and is flagged too. |
| `table-rewrite` | Flag type changes, `SET NOT NULL`, policy-listed defaults, serial/identity and stored generated columns, PRIMARY KEY/UNIQUE builds, `CLUSTER`, `VACUUM FULL`, and tablespace/access-method/logging changes. Expand/backfill/contract instead, or attach an earlier concurrent unique index with `USING INDEX`. |
| `unbatched-data` | Existing-table UPDATE/DELETE and INSERT SELECT from potentially large existing sources need a rolling or post-release batched backfill. Known single-row config changes are allowed. |
| `unannotated-contract` | DROP TABLE/COLUMN, table/column RENAME and TRUNCATE need the existing `-- contract-step:` annotation naming the earlier release that stopped using the shape, or why the previous release is unaffected. |
| `explicit-lock` | Remove explicit `LOCK [TABLE]`; explain any unavoidable lock using an exception. |
| `maintenance-concurrent-index` | Move concurrent builds outside the parked window, into a rolling migration. |
| `maintenance-batched-backfill` | Move batches into a rolling or post-release migration. |
| `maintenance-unbatched-data` | Split large-table data work from the short maintenance cutover; run a rolling or post-release batched backfill. |

Every online-safety rule can be overridden with a reason of **at least six
words**, not a placeholder, in the leading comment block. Repeat the header for
each rule; it never silences other rules. Keep runner directives on line 2:

```sql
-- deployment-mode: rolling
-- contract-step: release 1.2 stopped nullable writes and installed the fill trigger.
-- online-safety-exception: table-rewrite: Migration 0888 validated the existing column's IS NOT NULL check.
ALTER TABLE example ALTER COLUMN value SET NOT NULL;
```

The lint deliberately does not infer validated NOT NULL checks; explain that
proof with `table-rewrite`. PRIMARY KEY attachment is also flagged because it
can scan nullable columns even when an index already exists. An online-safety
exception does **not** override
deployment-mode, contract-step, runner-directive validation, or other existing
guards. For example, the deployment-mode guard already disallows maintenance
concurrent-index directives. A `contract-step` proves compatibility, not cheap
locking: a type change can still require an online-safety exception.

This is a deterministic heuristic, not a planner or row-count estimate. All
existing tables are potentially large. A single-row exemption requires literal
equalities on every column of a known PRIMARY KEY/unique key from earlier SQL;
arbitrary WHERE clauses, LIMITs, procedural loops and joins do not prove it.
Partial/expression indexes do not supply that proof. New tables created earlier
in the same file are exempt; `IF NOT EXISTS` or conditional DO-block creation
does not prove a table is new. Catalog reads and constant SELECTs are allowed.
Quoted/schema-qualified names and nested comments are supported. Quoted routine
bodies and dynamic SQL strings are not analyzed; static SQL inside DO blocks is.
Phase directives are ordinary comments to this guard.

The heuristic does not model every PostgreSQL statement: MERGE, copies via
CREATE TABLE AS/SELECT INTO, partition operations, REINDEX and materialized-view
refreshes still need review. Comma joins and CTE/table name shadowing can hide
INSERT SELECT sources; SQL-standard BEGIN ATOMIC routine bodies are not reliably
distinguished from migration commands. Maintenance checks intentionally cover
only the three maintenance rules above, not every possible slow DDL operation.

The added-column default policy recognizes `now`, `random`, `gen_random_uuid`,
`uuid_generate_vN`/`uuid_generate_v1mc`, `uuidv4`/`uuidv7`, `nextval`, `setval`, `clock_timestamp` and
`timeofday`. It conservatively includes `now()` even though PostgreSQL treats
it as stable; unknown user-defined function volatility is not inferred. Passing
this lint is not a proof that arbitrary SQL is cheap or backward compatible.
