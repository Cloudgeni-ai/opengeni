-- deployment-mode: rolling
-- Site Data (OPE-800): persistent JSON collections and files for published
-- Sites. The data belongs to the Site, not a version, so it survives new
-- versions and rollbacks; it is removed with the Site's workspace (Sites are
-- never hard-deleted). Every table is workspace-owned, FORCE RLS and kept in
-- its own `site_data_*` set so it can move to another store later. The API
-- enforces who may read or write which records; RLS isolates tenants.
-- New tables only: no lock on existing tables beyond the FK validation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE site_data_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  access_mode text NOT NULL
    CHECK (access_mode IN ('shared', 'shared_read', 'per_viewer', 'append_only')),
  -- per_viewer only: records stay private even from the Site's managers.
  private_records boolean NOT NULL DEFAULT false,
  json_schema jsonb CHECK (json_schema IS NULL OR octet_length(json_schema::text) <= 65536),
  indexed_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(indexed_fields) = 'array'),
  unique_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unique_fields) = 'array'),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_data_collections_private_mode_check
    CHECK (NOT private_records OR access_mode = 'per_viewer'),
  CONSTRAINT site_data_collections_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_collections_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_data_collections_workspace_id_uq ON site_data_collections (workspace_id, id);
CREATE UNIQUE INDEX site_data_collections_site_name_uq
  ON site_data_collections (workspace_id, site_id, name);

CREATE TABLE site_data_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  -- '' for shared collections; the owner principal for per-viewer and
  -- append-only collections, so each viewer has their own key space.
  key_scope text NOT NULL DEFAULT '',
  record_key text CHECK (record_key IS NULL OR char_length(record_key) BETWEEN 1 AND 256),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  owner_principal text NOT NULL CHECK (char_length(owner_principal) BETWEEN 1 AND 300),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_data_records_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_records_collection_fk FOREIGN KEY (workspace_id, collection_id)
    REFERENCES site_data_collections(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_data_records_workspace_id_uq ON site_data_records (workspace_id, id);
CREATE UNIQUE INDEX site_data_records_key_uq ON site_data_records (collection_id, key_scope, record_key)
  WHERE record_key IS NOT NULL;
CREATE INDEX site_data_records_created_idx ON site_data_records (collection_id, created_at, id);
CREATE INDEX site_data_records_updated_idx ON site_data_records (collection_id, updated_at, id);
CREATE INDEX site_data_records_owner_idx
  ON site_data_records (collection_id, owner_principal, created_at, id);
CREATE INDEX site_data_records_site_idx ON site_data_records (workspace_id, site_id);
CREATE INDEX site_data_records_data_idx ON site_data_records USING gin (data jsonb_path_ops);

-- Declared unique field sets and indexed fields, maintained in the same
-- transaction as the record. Unique entries make the constraint atomic;
-- index entries prefilter queries before the exact JSON predicate.
CREATE TABLE site_data_record_values (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL,
  record_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unique', 'index')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 1024),
  scope text NOT NULL DEFAULT '',
  value_hash text CHECK (value_hash IS NULL OR value_hash ~ '^[0-9a-f]{64}$'),
  value_text text COLLATE "C" CHECK (value_text IS NULL OR char_length(value_text) <= 256),
  value_num double precision,
  PRIMARY KEY (record_id, kind, name),
  CONSTRAINT site_data_record_values_shape_check
    CHECK ((kind = 'unique') = (value_hash IS NOT NULL)),
  CONSTRAINT site_data_record_values_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_record_values_record_fk FOREIGN KEY (workspace_id, record_id)
    REFERENCES site_data_records(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_data_record_values_unique_uq
  ON site_data_record_values (collection_id, name, scope, value_hash) WHERE kind = 'unique';
CREATE INDEX site_data_record_values_text_idx
  ON site_data_record_values (collection_id, name, value_text) WHERE kind = 'index';
CREATE INDEX site_data_record_values_num_idx
  ON site_data_record_values (collection_id, name, value_num) WHERE kind = 'index';

CREATE TABLE site_data_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('shared', 'private')),
  owner_principal text NOT NULL CHECK (char_length(owner_principal) BETWEEN 1 AND 300),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_data_files_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_files_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX site_data_files_site_idx ON site_data_files (workspace_id, site_id, created_at, id);

-- Per-Site totals, updated in the write transaction under this row's lock so
-- quotas are enforced exactly per Site.
CREATE TABLE site_data_usage (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  collection_count integer NOT NULL DEFAULT 0 CHECK (collection_count >= 0),
  record_count bigint NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  record_bytes bigint NOT NULL DEFAULT 0 CHECK (record_bytes >= 0),
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  file_bytes bigint NOT NULL DEFAULT 0 CHECK (file_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id),
  CONSTRAINT site_data_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_usage_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);

-- Fixed one-minute write windows per principal and per Site ('*').
CREATE TABLE site_data_rate_windows (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  principal_key text NOT NULL CHECK (char_length(principal_key) BETWEEN 1 AND 300),
  window_started_at timestamptz NOT NULL,
  operations integer NOT NULL CHECK (operations >= 0),
  PRIMARY KEY (workspace_id, site_id, principal_key),
  CONSTRAINT site_data_rate_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_data_rate_windows_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);

DO $rls$
DECLARE
  site_data_table text;
BEGIN
  FOREACH site_data_table IN ARRAY ARRAY[
    'site_data_collections', 'site_data_records', 'site_data_record_values',
    'site_data_files', 'site_data_usage', 'site_data_rate_windows'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', site_data_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', site_data_table);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
      'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      site_data_table
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', site_data_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO opengeni_app', site_data_table);
    END IF;
  END LOOP;
END
$rls$;
