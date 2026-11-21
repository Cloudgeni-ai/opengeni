-- deployment-mode: rolling
-- App package files that `app_export` stores in object storage for an agent
-- to download (docs/app-packages.md#export-file-cleanup). Each is recorded
-- before it is stored, with an expiry (24 hours), and the API's sweeper
-- deletes the object, then its row, once it expires; a failed delete stays
-- for a later retry with backoff.
--
-- Rows hold ids, the object key and retry state only. The sweeper finds due
-- rows across workspaces through a read-only policy that applies only
-- outside any workspace or account context (like app_sync_queue in 1520),
-- and then claims and deletes each one under that workspace's row-level
-- security.
--
-- Rolling: a new table the previous release never reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE app_package_exports (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- When the sweeper next tries to delete it: the expiry, a claim, or a retry.
  next_attempt_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT app_package_exports_pkey PRIMARY KEY (id),
  CONSTRAINT app_package_exports_object_key_check
    CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  CONSTRAINT app_package_exports_attempts_check CHECK (attempts >= 0),
  CONSTRAINT app_package_exports_error_check
    CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  CONSTRAINT app_package_exports_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX app_package_exports_due_idx ON app_package_exports (next_attempt_at);
CREATE INDEX app_package_exports_workspace_idx ON app_package_exports (workspace_id);
COMMENT ON TABLE app_package_exports IS 'Stored app package files and when the API deletes them.';

ALTER TABLE app_package_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_package_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_package_exports
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- The sweeper lists due rows across workspaces outside any workspace
-- context. Inside a workspace or account context a query sees only that
-- workspace's rows; every claim and delete needs the workspace's own context.
CREATE POLICY sweeper_read ON app_package_exports FOR SELECT USING (
  opengeni_private.current_workspace_id() IS NULL
  AND opengeni_private.current_account_id() IS NULL
);

REVOKE ALL ON TABLE app_package_exports FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_package_exports TO opengeni_app';
  END IF;
END
$$;
