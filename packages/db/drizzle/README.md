# Migrations

Each `NNNN_slug.sql` file is one forward-only migration. Shipped files are
frozen; fix forward with a new file.

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

Phase-aware releases run the rolling prefix before parking, the maintenance
span while parked, and the eligible suffix after traffic returns. Non-unique
concurrent indexes are automatically eligible for post. Most authors need no
annotation. Mark a unique concurrent index or batched backfill with
`-- opengeni:post-release` only when new code tolerates it being absent or
incomplete; `-- opengeni:pre-release` opts an automatic index out. Keep the
execution directive on line 2 and place the release marker below it. File order
always wins: a later non-eligible migration keeps earlier work out of post.

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
