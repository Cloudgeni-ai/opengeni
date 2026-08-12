-- deployment-mode: rolling
-- Cache browserd's provider tunnel separately from desktop and terminal. The
-- cache is nullable for rolling compatibility and is always fenced by the
-- lease's epoch + provider instance before publication/use.

ALTER TABLE "sandbox_leases"
  ADD COLUMN IF NOT EXISTS "controller_data_plane_url" text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
