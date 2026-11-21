-- deployment-mode: rolling
-- App data sync, round two (docs/app-sync.md):
--
--   1. app_sync_queue.lease_token: each claim of a queued run gets a new
--      token. A run renews its lease only while it still holds the token, and
--      stops calling the tool and writing once it doesn't; the current holder
--      settles the run.
--   2. app_sync_subscriptions.account_server_id: the account a person chose
--      when they opted in to a personal sync (their own account route). Every
--      run checks it is still theirs.
--   3. app_sync_keys: the keys each sync wrote (per person for a personal
--      sync), so `removeMissing` removes only records this sync wrote and
--      nobody changed since. Rows hold ids, keys and, for a table sync, a
--      fingerprint of the values written; never record data.
--
-- Rolling: the previous release never reads or writes the new columns or the
-- new table. Its claims leave lease_token unchanged, so the new release
-- fences on the claim's attempt count as well as the token.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE app_sync_queue ADD COLUMN lease_token uuid;

ALTER TABLE app_sync_subscriptions ADD COLUMN account_server_id text;
ALTER TABLE app_sync_subscriptions ADD CONSTRAINT app_sync_subscriptions_account_check
  CHECK (account_server_id IS NULL OR char_length(account_server_id) BETWEEN 1 AND 256) NOT VALID;

CREATE TABLE app_sync_keys (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  -- The person a personal sync wrote the key for; '' for a shared sync.
  subject_id text NOT NULL,
  record_key text NOT NULL,
  -- The run pass that last saw the key in the tool's result.
  seen_pass uuid NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  -- A table sync's fingerprint of the values it last wrote for the key, so
  -- removeMissing keeps a row someone else changed since. Null for a
  -- collection, whose records name their last writer.
  written_hash text,
  CONSTRAINT app_sync_keys_pkey PRIMARY KEY (workspace_id, task_id, subject_id, record_key),
  CONSTRAINT app_sync_keys_subject_check CHECK (char_length(subject_id) <= 1024),
  CONSTRAINT app_sync_keys_key_check CHECK (char_length(record_key) BETWEEN 1 AND 256),
  CONSTRAINT app_sync_keys_hash_check CHECK (written_hash IS NULL OR char_length(written_hash) <= 128),
  CONSTRAINT app_sync_keys_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_sync_keys_task_fk FOREIGN KEY (task_id)
    REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);
CREATE INDEX app_sync_keys_task_idx ON app_sync_keys (task_id);
COMMENT ON TABLE app_sync_keys IS 'Keys an App data sync wrote, so removeMissing removes only its own records.';

ALTER TABLE app_sync_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_sync_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_sync_keys
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE app_sync_keys FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_sync_keys TO opengeni_app';
  END IF;
END
$$;
