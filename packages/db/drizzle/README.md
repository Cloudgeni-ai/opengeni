# Migrations

Each `NNNN_slug.sql` file is one forward-only migration. Shipped files are
frozen; fix forward with a new file. The `migration-immutability` CI guard
fails any change to an existing file here other than adding a new one.

The `0977_baseline_NN.sql` parts are the schema that migrations 0000-0977
produced, and they replace those files. A fresh database applies the parts in
order. A database whose ledger already records every replaced name records the
parts without running them. A database that stopped partway through the old
chain must first be upgraded with the last release that shipped the individual
files. `packages/db/src/migration-baseline.ts` lists both sets of names. The
parts share ordinal 0977 by design, and the ordinals and immutability guards
read that list: the replaced names are retired, so the guards accept the
parts and the deletion of the replaced files.

The parts create foreign keys in the order the old chain created them, not
alphabetically. Postgres fires a table's foreign-key cascade triggers in
creation order, so this keeps cascading deletes (for example deleting an
account) running in the same order as on a database built from the old chain.

Line 1 declares the deployment mode. **Rolling is the default:**

```sql
-- deployment-mode: rolling
```

A rolling migration must keep the previous release working. Split incompatible
changes into expand, migrate/backfill and contract steps across releases, and
mark a contract step (drop, rename, type change, `SET NOT NULL` on an existing
table) with the migration or PR after which nothing uses the old shape, or why
the previous release is unaffected:

```sql
-- deployment-mode: rolling
-- contract-step: since migration 0790 (PR #4500) no binary reads legacy_color
```

Phase-aware releases run the posture-inert rolling prefix before parking, the maintenance
span while parked, and the eligible suffix after traffic returns. Non-unique
concurrent indexes are automatically eligible for post. Most authors need no
annotation. Mark a unique concurrent index or batched backfill with
`-- opengeni:post-release` only when new code tolerates it being absent or
incomplete; `-- opengeni:pre-release` opts an automatic index out. Keep the
execution directive on line 2 and place the release marker below it. File order
always wins: a later non-eligible migration keeps earlier work out of post.
Rolling table/function/grant/RLS and other posture-changing SQL stays out of
pre until old production binaries have forward-compatible readiness. Even
all-rolling plans can have a maintenance span; run `--phase=maintenance` before
a rolling rollout to apply all required non-post work. See the guide for the
conservative classification and the unchanged `requiresDrain` contract.

Maintenance drains every API, control and turn worker for its migration span.
Use it only when no expand/contract sequence works, and say why. An
execution `-- opengeni:` directive stays on line 2; indent continuation lines with `--   `:

```sql
-- deployment-mode: maintenance
-- maintenance-justification: <why old and new binaries cannot share any
--   intermediate schema>
```

`bun run check:migration-deployment-mode` enforces this in CI. See
[the expand/contract guide](../../../docs/migrations-expand-contract.md).
