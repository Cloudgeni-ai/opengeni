-- deployment-mode: rolling
-- Current provisioning already removes broad table defaults. Normalize these
-- existing journal tables for legacy/custom migration owners as well, without
-- relying on another role-provisioning pass. No data or consent changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON billing_auto_top_up_settings, billing_auto_top_up_mutations, billing_auto_top_up_operations FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE ON billing_auto_top_up_settings, billing_auto_top_up_operations TO opengeni_app;
    GRANT SELECT, INSERT ON billing_auto_top_up_mutations TO opengeni_app;
  END IF;
END $$;
