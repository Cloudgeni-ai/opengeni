---
"@opengeni/db": patch
"@opengeni/testing": patch
---

Repair the migration-time backfills that silently matched zero rows under a non-superuser table owner, and stop the class from recurring (OPE-276).

`FORCE ROW LEVEL SECURITY` binds the table *owner*, not merely ordinary roles, and OpenGeni migrates as a non-superuser owner without `BYPASSRLS`. No tenant GUC is set during a migration, so a bare `UPDATE`/`DELETE`/`INSERT ... SELECT`/`DO $$` backfill over a workspace-scoped table matched **zero rows and reported success**. The hazard was invisible in CI because the test harness migrates as a superuser.

Rolling migration `0296_force_rls_backfill_noop_repair.sql` repairs the three statements whose no-op neither aborted its own migration nor is recomputed at runtime: `connections.origin_workspace_id` (0256), `enrollments.origin_workspace_id` (0262), and the self-organization `organization_memberships.role = 'owner'` (0263). The first denied every workspace-owned connection at use time with `connection_identity_changed`; the third locked every pre-0263 organization out of its own membership administration. The repair is idempotent, is a no-op on a superuser-migrated database, and never infers authority from `created_by`, connection attribution, a default workspace, a resource name, or current access.

New `bun run check:migration-rls-backfills` CI guard fails any future migration that backfills, or guards with `RAISE EXCEPTION` over, a FORCE-RLS table without opening the owner-only `NO FORCE` window. New `acquireOwnerMigratedTestDatabase` test helper drives `migrate()` through a `NOSUPERUSER NOBYPASSRLS` owner so this boundary is exercised for real. Full classification of every affected migration in `docs/force-rls-migration-backfills.md`.
