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
table) with the release that stopped using the old shape:

```sql
-- deployment-mode: rolling
-- contract-step: release 2026.10.20 (migration 0790) stopped reading legacy_color
```

Maintenance drains every API, control and turn worker for the whole release.
Use it only when no expand/contract sequence works, and say why:

```sql
-- deployment-mode: maintenance
-- maintenance-justification: <why old and new binaries cannot share any
--   intermediate schema>
```

`bun run check:migration-deployment-mode` enforces this in CI. See
[the expand/contract guide](../../../docs/migrations-expand-contract.md).
