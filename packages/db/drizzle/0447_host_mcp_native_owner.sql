-- deployment-mode: maintenance
-- Host ownership follows the effective organization member. Linking creates no
-- ownership transfer: old external bindings remain external, new native bindings
-- are independent. Accepted linked work retains its separate revocable link.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0447 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0447 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0447 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;
ALTER TABLE host_mcp_bindings
  DROP CONSTRAINT host_mcp_bindings_external_owner_fk,
  ADD CONSTRAINT host_mcp_bindings_member_owner_fk FOREIGN KEY (account_id, owner_subject_id)
    REFERENCES organization_memberships(account_id, subject_id),
  ADD CONSTRAINT host_mcp_bindings_human_owner_check CHECK (
    owner_subject_id ~ '^(external_user:|user:)[^\r\n]+$');
ALTER TABLE host_mcp_delegations
  DROP CONSTRAINT host_mcp_delegations_external_owner_fk,
  ADD CONSTRAINT host_mcp_delegations_member_owner_fk FOREIGN KEY (account_id, owner_subject_id)
    REFERENCES organization_memberships(account_id, subject_id),
  ADD CONSTRAINT host_mcp_delegations_human_owner_check CHECK (
    owner_subject_id ~ '^(external_user:|user:)[^\r\n]+$');