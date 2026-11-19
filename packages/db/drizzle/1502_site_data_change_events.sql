-- deployment-mode: rolling
-- Site Data change events and idempotent inserts (docs/site-data.md).
--
--   1. site_data_usage.change_seq: a per-Site counter every Site Data write
--      transaction increments while it already holds the Site's usage row
--      lock, so change numbers are gapless per transaction and ordered like
--      the commits. live_until: until when someone has a live connection to
--      the Site; while it is in the future, writes also append a change row.
--   2. site_data_changes: a transactional outbox of what changed (collection
--      names, operation counts, capped record ids), never record data. Rows
--      are written only while the Site has a live listener and pruned to the
--      newest few hundred per Site, so a Site nobody watches costs one
--      counter increment per write.
--   3. site_data_insert_keys: the record an insert with an idempotency key
--      created, per collection and principal, so a retried insert returns
--      the original record instead of a duplicate.
--
-- Rolling: two new FORCE-RLS tables and two new nullable/defaulted columns.
-- The previous release neither reads nor writes them; its writes leave
-- change_seq unchanged, which only means they send no change hint.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE site_data_usage
  ADD COLUMN change_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN live_until timestamptz;

CREATE TABLE site_data_changes (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  change_seq bigint NOT NULL,
  kind text NOT NULL,
  collections jsonb NOT NULL DEFAULT '[]'::jsonb,
  op_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  record_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  truncated boolean NOT NULL DEFAULT false,
  actor_kind text NOT NULL,
  chain_depth smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_data_changes_pkey PRIMARY KEY (workspace_id, site_id, change_seq),
  CONSTRAINT site_data_changes_kind_check
    CHECK (kind IN ('write', 'import', 'reset', 'collection', 'files')),
  CONSTRAINT site_data_changes_actor_kind_check
    CHECK (actor_kind IN ('user', 'guest', 'agent', 'schedule', 'service', 'other')),
  CONSTRAINT site_data_changes_collections_check
    CHECK (jsonb_typeof(collections) = 'array' AND octet_length(collections::text) <= 8192),
  CONSTRAINT site_data_changes_op_counts_check
    CHECK (jsonb_typeof(op_counts) = 'object' AND octet_length(op_counts::text) <= 1024),
  CONSTRAINT site_data_changes_record_ids_check
    CHECK (jsonb_typeof(record_ids) = 'array' AND octet_length(record_ids::text) <= 4096),
  CONSTRAINT site_data_changes_chain_depth_check CHECK (chain_depth >= 0),
  CONSTRAINT site_data_changes_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_changes_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE site_data_changes IS 'Outbox of Site Data change facts (no record data), written only while a Site has a live listener; newest few hundred per Site.';

CREATE TABLE site_data_insert_keys (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  principal text NOT NULL,
  idempotency_key text NOT NULL,
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_data_insert_keys_pkey
    PRIMARY KEY (workspace_id, collection_id, principal, idempotency_key),
  CONSTRAINT site_data_insert_keys_key_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  CONSTRAINT site_data_insert_keys_principal_check
    CHECK (char_length(principal) BETWEEN 1 AND 300),
  CONSTRAINT site_data_insert_keys_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_insert_keys_record_fk FOREIGN KEY (workspace_id, record_id)
    REFERENCES site_data_records(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_data_insert_keys_site_created_idx
  ON site_data_insert_keys (workspace_id, site_id, created_at);
CREATE INDEX site_data_insert_keys_record_idx
  ON site_data_insert_keys (workspace_id, record_id);
COMMENT ON TABLE site_data_insert_keys IS 'Idempotency keys of Site Data inserts: the record a keyed insert created, kept for a day or until the record is deleted.';

ALTER TABLE site_data_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_data_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON site_data_changes
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE site_data_insert_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_data_insert_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON site_data_insert_keys
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE site_data_changes FROM PUBLIC;
REVOKE ALL ON TABLE site_data_insert_keys FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE site_data_changes TO opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE site_data_insert_keys TO opengeni_app';
  END IF;
END
$$;
