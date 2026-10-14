-- deployment-mode: rolling
-- Site SQL: optional per-Site Cloudflare storage (one SQLite Durable Object
-- per Site; docs/design/published-sites-2026-10-14.md, PR B). The data lives
-- in the Durable Object; Postgres stays the source of truth for whether the
-- owner turned it on, the ordered migrations and the named queries, so a
-- Site's database can always be rebuilt and re-migrated. Usage counters and
-- rate windows live here too, so quotas are enforced by the API. Every table
-- is workspace-owned, FORCE RLS and kept in its own `site_sql_*` set. These
-- rows cascade away with the Site's artifact or workspace; the Durable
-- Object's data does not, so the API drops it after a workspace deletion
-- commits (best effort; see docs/site-data.md).
-- New tables only: no lock on existing tables beyond the FK validation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE site_sql_databases (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  -- Highest migration ordinal handed out. Migrations, rebuilds and resets
  -- hold this row's lock across their Durable Object calls; per-call usage
  -- goes to site_sql_usage so Site pages never wait on that lock.
  migration_count integer NOT NULL DEFAULT 0 CHECK (migration_count >= 0),
  rebuilt_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id),
  CONSTRAINT site_sql_databases_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_sql_databases_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);

-- Usage per Site: the database size the Durable Object last reported, its
-- high-water mark (storage growth is metered past it, so calls completing
-- out of order never count the same bytes twice) and the monthly row
-- counters of Site page calls, which the monthly caps read. Management calls
-- (export, inspect, migrations, resets, ad hoc SQL, imports) are metered as
-- usage events but never added here.
CREATE TABLE site_sql_usage (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  storage_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  storage_peak_bytes bigint NOT NULL DEFAULT 0 CHECK (storage_peak_bytes >= 0),
  -- Monthly row counters, reset when usage_month moves on.
  usage_month date NOT NULL DEFAULT (date_trunc('month', now()))::date,
  rows_read_month bigint NOT NULL DEFAULT 0 CHECK (rows_read_month >= 0),
  rows_written_month bigint NOT NULL DEFAULT 0 CHECK (rows_written_month >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id),
  CONSTRAINT site_sql_usage_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_sql_usage_database_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES site_sql_databases(workspace_id, site_id) ON DELETE CASCADE
);

-- Applied in ordinal order; a rebuild replays them all on an empty database.
-- A Site's migrations hold at most 6 MiB of SQL together (checked by the API
-- under the database row lock), so a rebuild fits in bounded gateway calls.
CREATE TABLE site_sql_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  sql text NOT NULL CHECK (char_length(sql) BETWEEN 1 AND 2097152),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_sql_migrations_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_sql_migrations_database_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES site_sql_databases(workspace_id, site_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_sql_migrations_ordinal_uq
  ON site_sql_migrations (workspace_id, site_id, ordinal);
CREATE UNIQUE INDEX site_sql_migrations_name_uq
  ON site_sql_migrations (workspace_id, site_id, name);

-- Named queries Site pages call with site.sql.run(name, params). Each holds
-- exactly one statement, checked when it is defined and again in the
-- Durable Object; principal parameters (:viewer...) are bound by the API.
CREATE TABLE site_sql_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  sql text NOT NULL CHECK (char_length(sql) BETWEEN 1 AND 16384),
  mode text NOT NULL CHECK (mode IN ('read', 'write')),
  params jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(params) = 'array'),
  audience text NOT NULL CHECK (audience IN ('everyone', 'signed_in', 'managers')),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  max_rows integer CHECK (max_rows IS NULL OR max_rows BETWEEN 1 AND 5000),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_sql_queries_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_sql_queries_database_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES site_sql_databases(workspace_id, site_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX site_sql_queries_name_uq ON site_sql_queries (workspace_id, site_id, name);

-- Fixed one-minute call windows per principal and per Site ('*').
CREATE TABLE site_sql_rate_windows (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id uuid NOT NULL,
  principal_key text NOT NULL CHECK (char_length(principal_key) BETWEEN 1 AND 300),
  window_started_at timestamptz NOT NULL,
  operations integer NOT NULL CHECK (operations >= 0),
  PRIMARY KEY (workspace_id, site_id, principal_key),
  CONSTRAINT site_sql_rate_windows_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_sql_rate_windows_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);

DO $rls$
DECLARE
  site_sql_table text;
BEGIN
  FOREACH site_sql_table IN ARRAY ARRAY[
    'site_sql_databases', 'site_sql_usage', 'site_sql_migrations', 'site_sql_queries',
    'site_sql_rate_windows'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', site_sql_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', site_sql_table);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
      'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      site_sql_table
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', site_sql_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO opengeni_app', site_sql_table);
    END IF;
  END LOOP;
END
$rls$;
