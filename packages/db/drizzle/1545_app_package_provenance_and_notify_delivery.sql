-- deployment-mode: rolling
-- App package provenance (docs/app-packages.md "Provenance"): an app installed
-- or upgraded from a package records the package's id, so a later upgrade
-- can tell whether a package is a newer version of the same app.
--
-- Rolling: one new nullable column the previous release never reads or
-- writes; its inserts leave it null.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE workspace_artifacts ADD COLUMN IF NOT EXISTS package_id uuid;
