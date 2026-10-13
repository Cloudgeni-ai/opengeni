-- deployment-mode: maintenance
-- Vaults (secrets overhaul, §A FOUNDATION). Adds hosted vaults with items,
-- fields, versioned encrypted values and name aliases, plus a vault policy on
-- sessions and schedules, and copies every active variable set into a vault
-- with the same ID (each variable becomes an `api_key` item with the same ID
-- and byte-identical ciphertext). Set header rows stay for scheduled-run
-- fences; §B deletes their values, and a later contract migration drops them.
--
-- §C (W4), at the end of this file, removes protected-fill site
-- authentication: non-provider site-auth connections, `awaiting_secret` auth
-- runs, `auth_runs.pending_fields` and the `protected_fill` operation kind.
--
-- §B, after §C, retires Variable Set values: it re-checks every vault copy,
-- scrubs variable names from persisted sandbox env and deletes the values.
--
-- Maintenance: stop every API, control worker and turn worker first. The copy
-- takes table locks on the variable-set tables and the new tables only, and
-- takes no advisory fence, so there is no lock-order inversion with live
-- traffic. All access to the new tables goes through the SECURITY DEFINER
-- functions below; the application role has no table privileges on them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

-- ---------------------------------------------------------------------------
-- 1. Names
-- ---------------------------------------------------------------------------

-- The one authoritative name key: NFC, trimmed, lower case.
CREATE FUNCTION vault_name_key(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
SET search_path = pg_catalog
AS $$ SELECT pg_catalog.lower(pg_catalog.btrim(normalize(p, NFC))) $$;

-- Q-10: 1-120 characters, no / { } # \ or control characters, no surrounding
-- whitespace, not starting with "id:".
CREATE FUNCTION opengeni_private.vault_name_is_valid(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT p IS NOT NULL
    AND pg_catalog.char_length(p) BETWEEN 1 AND 120
    AND p !~ '[/{}#\\[:cntrl:]]'
    AND p !~ '[\u0080-\u009f]'
    AND pg_catalog.btrim(p, E' \t\n\r\f\x0B') = p
    AND pg_catalog.lower(p) NOT LIKE 'id:%'
$$;

-- Legacy names that break the rules: forbidden characters become "-",
-- surrounding whitespace is trimmed, a leading "id:" becomes "id-", and an
-- empty result becomes "Unnamed". Truncated to leave room for a suffix.
CREATE FUNCTION opengeni_private.vault_sanitize_legacy_name(p text) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  cleaned text := pg_catalog.regexp_replace(
    coalesce(p, ''), '[/{}#\\[:cntrl:]\u0080-\u009f]', '-', 'g'
  );
BEGIN
  cleaned := pg_catalog.btrim(cleaned, E' \t\n\r\f\x0B');
  IF pg_catalog.lower(cleaned) LIKE 'id:%' THEN
    cleaned := pg_catalog.substr(cleaned, 1, 2) || '-' || pg_catalog.substr(cleaned, 4);
  END IF;
  IF cleaned = '' THEN
    cleaned := 'Unnamed';
  END IF;
  RETURN pg_catalog.btrim(pg_catalog.left(cleaned, 112), E' \t\n\r\f\x0B');
END
$$;

-- {"mode":"all"} or {"mode":"selected","vaultIds":[<= 200 uuids]}.
CREATE FUNCTION opengeni_private.vault_policy_is_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p IS NULL OR pg_catalog.jsonb_typeof(p) <> 'object' THEN false
    WHEN p ->> 'mode' = 'all' THEN (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p)) = 1
    WHEN p ->> 'mode' = 'selected' THEN
      (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p)) = 2
      AND pg_catalog.jsonb_typeof(p -> 'vaultIds') = 'array'
      AND pg_catalog.jsonb_array_length(p -> 'vaultIds') <= 200
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p -> 'vaultIds') element
        WHERE pg_catalog.jsonb_typeof(element) <> 'string'
          OR NOT (element #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    ELSE false
  END
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE vaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  -- Same semantics as workspace_variable_sets.workspace_id: the workspace a
  -- vault lives in; deleting that workspace deletes the vault. New Only-me
  -- vaults live in the owner's personal workspace when they have one.
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('user', 'workspace', 'organization', 'task')),
  authority_id uuid,
  owner_organization_membership_id uuid,
  origin_workspace_id uuid,
  root_session_id uuid,
  name text NOT NULL,
  name_key text GENERATED ALWAYS AS (vault_name_key(name)) STORED,
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  source text NOT NULL DEFAULT 'opengeni' CHECK (source IN ('opengeni', 'onepassword', 'host')),
  mode text NOT NULL DEFAULT 'read_write' CHECK (mode IN ('read_write', 'read_only')),
  provider_connection_id uuid REFERENCES connections(id) ON DELETE RESTRICT,
  provider_vault_ref text,
  provider_content_version text,
  sync_status text NOT NULL DEFAULT 'ok'
    CHECK (sync_status IN ('ok', 'syncing', 'error', 'auth_expired', 'rate_limited')),
  sync_error_code text,
  sync_error_message text,
  last_synced_at timestamptz,
  rate_limited_until timestamptz,
  allowed_workspace_ids uuid[],
  allow_personal_workspaces boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vaults_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT vaults_owner_shape CHECK (
    (owner_kind = 'user' AND authority_id IS NOT NULL
      AND owner_organization_membership_id IS NOT NULL
      AND root_session_id IS NULL AND allowed_workspace_ids IS NULL)
    OR (owner_kind IN ('workspace', 'organization') AND authority_id IS NULL
      AND owner_organization_membership_id IS NULL AND root_session_id IS NULL)
    OR (owner_kind = 'task' AND authority_id IS NULL
      AND owner_organization_membership_id IS NULL
      AND root_session_id IS NOT NULL AND source = 'opengeni')
  ),
  CONSTRAINT vaults_org_availability CHECK (owner_kind = 'organization' OR allowed_workspace_ids IS NULL),
  CONSTRAINT vaults_provider_shape CHECK (
    (source = 'opengeni' AND provider_vault_ref IS NULL AND provider_connection_id IS NULL
      AND mode = 'read_write')
    OR (source = 'onepassword' AND provider_vault_ref IS NOT NULL AND provider_connection_id IS NOT NULL)
    OR (source = 'host' AND provider_vault_ref IS NOT NULL AND provider_connection_id IS NULL)
  ),
  CONSTRAINT vaults_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id)
    REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id)
    ON DELETE RESTRICT,
  CONSTRAINT vaults_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id),
  CONSTRAINT vaults_root_session_fk FOREIGN KEY (workspace_id, root_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX vaults_id_account_idx ON vaults (id, account_id);
CREATE UNIQUE INDEX vaults_workspace_name_idx ON vaults (workspace_id, name_key)
  WHERE owner_kind = 'workspace';
CREATE UNIQUE INDEX vaults_user_name_idx ON vaults (account_id, owner_organization_membership_id, name_key)
  WHERE owner_kind = 'user';
CREATE UNIQUE INDEX vaults_org_name_idx ON vaults (account_id, name_key)
  WHERE owner_kind = 'organization';
CREATE UNIQUE INDEX vaults_task_idx ON vaults (workspace_id, root_session_id)
  WHERE owner_kind = 'task';
CREATE UNIQUE INDEX vaults_default_idx ON vaults (
  workspace_id, owner_kind,
  coalesce(owner_organization_membership_id, '00000000-0000-0000-0000-000000000000'::uuid)
) WHERE is_default AND owner_kind = 'workspace';
CREATE UNIQUE INDEX vaults_user_default_idx ON vaults (account_id, owner_organization_membership_id)
  WHERE is_default AND owner_kind = 'user';
CREATE INDEX vaults_account_owner_idx ON vaults (account_id, owner_kind);
CREATE INDEX vaults_workspace_idx ON vaults (workspace_id);
CREATE INDEX vaults_provider_connection_idx ON vaults (provider_connection_id)
  WHERE provider_connection_id IS NOT NULL;

CREATE TABLE vault_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  vault_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('login', 'api_key', 'note', 'file', 'passkey')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  name_key text GENERATED ALWAYS AS (vault_name_key(name)) STORED,
  websites text[] NOT NULL DEFAULT '{}' CHECK (cardinality(websites) <= 20),
  expires_at timestamptz,
  primary_field_id uuid,
  provider_item_ref text,
  provider_version text,
  passkey_sign_count bigint CHECK (passkey_sign_count IS NULL OR passkey_sign_count >= 0),
  last_used_at timestamptz,
  archived_at timestamptz,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_items_vault_fk FOREIGN KEY (vault_id, account_id)
    REFERENCES vaults(id, account_id) ON DELETE CASCADE,
  CONSTRAINT vault_items_passkey_shape CHECK ((type = 'passkey') = (passkey_sign_count IS NOT NULL))
);
CREATE UNIQUE INDEX vault_items_name_idx ON vault_items (vault_id, name_key) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX vault_items_provider_ref_idx ON vault_items (vault_id, provider_item_ref)
  WHERE provider_item_ref IS NOT NULL;
CREATE INDEX vault_items_vault_updated_idx ON vault_items (vault_id, updated_at DESC);
CREATE INDEX vault_items_name_key_idx ON vault_items (name_key);
CREATE INDEX vault_items_websites_idx ON vault_items USING gin (websites);

CREATE TABLE vault_item_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  item_id uuid NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  name_key text GENERATED ALWAYS AS (vault_name_key(name)) STORED,
  kind text NOT NULL CHECK (kind IN ('text', 'concealed', 'totp', 'file')),
  position integer NOT NULL DEFAULT 0,
  -- NULL for provider fields.
  current_version integer CHECK (current_version IS NULL OR current_version > 0),
  provider_field_ref text,
  file_name text,
  file_size integer CHECK (file_size IS NULL OR file_size >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_item_fields_name_not_otp CHECK (name_key <> 'otp')
);
CREATE UNIQUE INDEX vault_item_fields_name_idx ON vault_item_fields (item_id, name_key);
ALTER TABLE vault_items ADD CONSTRAINT vault_items_primary_field_fk
  FOREIGN KEY (primary_field_id) REFERENCES vault_item_fields(id)
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE vault_field_versions (
  field_id uuid NOT NULL REFERENCES vault_item_fields(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  account_id uuid NOT NULL,
  -- v1/v2 envelope from environment-crypto.ts (every kind, text included).
  value_encrypted text NOT NULL,
  created_by_kind text NOT NULL
    CHECK (created_by_kind IN ('human', 'agent', 'api_key', 'migration', 'provider', 'system')),
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, version)
);

CREATE TABLE vault_item_name_aliases (
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name_key text NOT NULL,
  item_id uuid NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, name_key)
);
CREATE INDEX vault_item_name_aliases_item_idx ON vault_item_name_aliases (item_id);

-- scope_key: workspace id (workspace vaults), membership id (user vaults) or
-- account id (organization vaults).
CREATE TABLE vault_name_aliases (
  account_id uuid NOT NULL,
  scope_key text NOT NULL,
  name_key text NOT NULL,
  vault_id uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope_key, name_key)
);
CREATE INDEX vault_name_aliases_vault_idx ON vault_name_aliases (vault_id);

-- holder = "<browserSessionId>:<targetId>"
CREATE TABLE vault_passkey_leases (
  item_id uuid PRIMARY KEY REFERENCES vault_items(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  holder text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX vault_passkey_leases_holder_idx ON vault_passkey_leases (holder);

-- Constant defaults: no table rewrite. The CHECK constraints still validate
-- existing rows once (a scan, not a rewrite) while ADD runs. IF NOT
-- EXISTS lets fixtures stopped before 0739 stage the column for current adapters.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS vault_policy jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  ADD CONSTRAINT sessions_vault_policy_check
    CHECK (opengeni_private.vault_policy_is_valid(vault_policy));
ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS vault_policy jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  ADD CONSTRAINT scheduled_tasks_vault_policy_check
    CHECK (opengeni_private.vault_policy_is_valid(vault_policy));

-- ---------------------------------------------------------------------------
-- 3. Copy active variable sets into vaults (same IDs, byte-identical values)
-- ---------------------------------------------------------------------------

-- The copy reads and writes across tenants, so it lifts FORCE row security on
-- the tables it reads for this transaction only (the migration owner has no
-- tenant GUC set) and restores it below. The new tables get FORCE row
-- security after the copy.
ALTER TABLE workspace_variable_sets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_variable_set_variables NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_user_resource_authorities NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;

DO $vault_copy$
DECLARE
  set_row record;
  variable_row record;
  set_scope_key text;
  base_name text;
  candidate text;
  suffix integer;
  vault_authority_id uuid;
  field_id uuid;
  copied_vaults integer := 0;
  copied_items integer := 0;
  copied_versions integer := 0;
  renamed_vaults integer := 0;
  renamed_items integer := 0;
  skipped_revoked integer := 0;
  old_count bigint;
  new_count bigint;
  old_length numeric;
  new_length numeric;
  old_digest text;
  new_digest text;
BEGIN
  CREATE TEMP TABLE vault_copy_used_names (
    scope_key text NOT NULL,
    name_key text NOT NULL,
    PRIMARY KEY (scope_key, name_key)
  ) ON COMMIT DROP;

  SELECT pg_catalog.count(*) INTO skipped_revoked
  FROM workspace_variable_sets WHERE status <> 'active';

  FOR set_row IN
    SELECT * FROM workspace_variable_sets
    WHERE status = 'active'
    ORDER BY created_at, id
  LOOP
    set_scope_key := CASE set_row.authority_scope
      WHEN 'workspace' THEN set_row.workspace_id::text
      WHEN 'user' THEN set_row.owner_organization_membership_id::text
      ELSE set_row.account_id::text
    END;
    base_name := opengeni_private.vault_sanitize_legacy_name(set_row.name);
    candidate := base_name;
    suffix := 1;
    WHILE EXISTS (
      SELECT 1 FROM vault_copy_used_names used
      WHERE used.scope_key = set_row.authority_scope || ':' || set_scope_key
        AND used.name_key = vault_name_key(candidate)
    ) LOOP
      suffix := suffix + 1;
      candidate := base_name || ' (' || suffix || ')';
    END LOOP;
    INSERT INTO vault_copy_used_names VALUES (
      set_row.authority_scope || ':' || set_scope_key, vault_name_key(candidate)
    );
    IF candidate IS DISTINCT FROM set_row.name THEN
      renamed_vaults := renamed_vaults + 1;
    END IF;

    vault_authority_id := NULL;
    IF set_row.authority_scope = 'user' THEN
      -- A vault gets its own authority row; the set keeps its own until the
      -- variable-set removal migration.
      vault_authority_id := pg_catalog.gen_random_uuid();
      INSERT INTO organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status, created_at, updated_at
      )
      SELECT vault_authority_id, authority.account_id, authority.organization_membership_id,
        'vault', set_row.id, authority.origin_workspace_id, authority.generation,
        authority.status, authority.created_at, authority.updated_at
      FROM organization_user_resource_authorities authority
      WHERE authority.id = set_row.authority_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'vault copy: user variable set % has no authority row', set_row.id;
      END IF;
    END IF;

    INSERT INTO vaults (
      id, account_id, workspace_id, owner_kind, authority_id,
      owner_organization_membership_id, origin_workspace_id, name, description,
      generation, created_at, updated_at
    ) VALUES (
      set_row.id, set_row.account_id, set_row.workspace_id, set_row.authority_scope,
      vault_authority_id, set_row.owner_organization_membership_id,
      set_row.origin_workspace_id, candidate,
      CASE WHEN set_row.description IS NULL THEN NULL
        ELSE pg_catalog.left(set_row.description, 2000) END,
      set_row.generation, set_row.created_at, set_row.updated_at
    );
    copied_vaults := copied_vaults + 1;
    IF vault_name_key(candidate) IS DISTINCT FROM vault_name_key(set_row.name) THEN
      INSERT INTO vault_name_aliases (account_id, scope_key, name_key, vault_id, created_at)
      VALUES (set_row.account_id, set_scope_key, vault_name_key(set_row.name), set_row.id, set_row.created_at)
      ON CONFLICT DO NOTHING;
    END IF;

    FOR variable_row IN
      SELECT * FROM workspace_variable_set_variables
      WHERE variable_set_id = set_row.id
      ORDER BY created_at, id
    LOOP
      base_name := opengeni_private.vault_sanitize_legacy_name(variable_row.name);
      candidate := base_name;
      suffix := 1;
      WHILE EXISTS (
        SELECT 1 FROM vault_copy_used_names used
        WHERE used.scope_key = 'item:' || set_row.id::text
          AND used.name_key = vault_name_key(candidate)
      ) LOOP
        suffix := suffix + 1;
        candidate := base_name || ' (' || suffix || ')';
      END LOOP;
      INSERT INTO vault_copy_used_names VALUES ('item:' || set_row.id::text, vault_name_key(candidate));
      IF candidate IS DISTINCT FROM variable_row.name THEN
        renamed_items := renamed_items + 1;
      END IF;

      field_id := pg_catalog.gen_random_uuid();
      INSERT INTO vault_items (
        id, account_id, vault_id, type, name, primary_field_id, created_at, updated_at
      ) VALUES (
        variable_row.id, set_row.account_id, set_row.id, 'api_key', candidate, field_id,
        variable_row.created_at, variable_row.updated_at
      );
      INSERT INTO vault_item_fields (
        id, account_id, item_id, name, kind, position, current_version, created_at, updated_at
      ) VALUES (
        field_id, set_row.account_id, variable_row.id, 'value', 'concealed', 0,
        variable_row.version, variable_row.created_at, variable_row.updated_at
      );
      INSERT INTO vault_field_versions (
        field_id, version, account_id, value_encrypted, created_by_kind, created_at
      ) VALUES (
        field_id, variable_row.version, set_row.account_id, variable_row.value_encrypted,
        'migration', variable_row.updated_at
      );
      copied_items := copied_items + 1;
      copied_versions := copied_versions + 1;
      IF vault_name_key(candidate) IS DISTINCT FROM vault_name_key(variable_row.name) THEN
        -- An old key that another copied item now holds as its current name
        -- stays with that item (current names beat aliases).
        INSERT INTO vault_item_name_aliases (vault_id, name_key, item_id, account_id, created_at)
        VALUES (set_row.id, vault_name_key(variable_row.name), variable_row.id, set_row.account_id,
          variable_row.created_at)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;

  -- Self-check: every active variable has exactly one version row with the
  -- same item ID, version and ciphertext.
  SELECT pg_catalog.count(*),
    coalesce(pg_catalog.sum(pg_catalog.length(variable.value_encrypted)), 0),
    coalesce(pg_catalog.string_agg(
      variable.id::text || ':' || variable.version || ':' || pg_catalog.md5(variable.value_encrypted),
      ',' ORDER BY variable.id, variable.version
    ), '')
    INTO old_count, old_length, old_digest
  FROM workspace_variable_set_variables variable
  JOIN workspace_variable_sets variable_set ON variable_set.id = variable.variable_set_id
  WHERE variable_set.status = 'active';

  SELECT pg_catalog.count(*),
    coalesce(pg_catalog.sum(pg_catalog.length(version.value_encrypted)), 0),
    coalesce(pg_catalog.string_agg(
      field.item_id::text || ':' || version.version || ':' || pg_catalog.md5(version.value_encrypted),
      ',' ORDER BY field.item_id, version.version
    ), '')
    INTO new_count, new_length, new_digest
  FROM vault_field_versions version
  JOIN vault_item_fields field ON field.id = version.field_id
  WHERE version.created_by_kind = 'migration';

  IF old_count IS DISTINCT FROM new_count
    OR old_length IS DISTINCT FROM new_length
    OR old_digest IS DISTINCT FROM new_digest
    OR copied_versions IS DISTINCT FROM new_count::integer
    OR copied_vaults IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer FROM workspace_variable_sets WHERE status = 'active'
    )
  THEN
    RAISE EXCEPTION 'vault copy self-check failed: % variables (% bytes) vs % versions (% bytes)',
      old_count, old_length, new_count, new_length;
  END IF;

  INSERT INTO audit_events (account_id, workspace_id, subject_id, action, target_type, metadata)
  VALUES (NULL, NULL, 'system:migration:0739', 'vault.migrated', 'migration', pg_catalog.jsonb_build_object(
    'migration', '0739_vaults.sql',
    'vaults', copied_vaults,
    'items', copied_items,
    'versions', copied_versions,
    'skippedRevokedSets', skipped_revoked,
    'renamedVaults', renamed_vaults,
    'renamedItems', renamed_items
  ));
END
$vault_copy$;

-- Check the deferred primary-field references now, so the row-security DDL
-- below sees no pending trigger events on vault_items.
SET CONSTRAINTS vault_items_primary_field_fk IMMEDIATE;

ALTER TABLE workspace_variable_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_variable_set_variables FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_user_resource_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Row security and the vault authority capability
-- ---------------------------------------------------------------------------

-- A SECURITY DEFINER vault routine records a capability row for its own
-- backend and transaction; the owner-only policies below admit the routine
-- owner only while that row exists. The application role has no privileges
-- on any vault table and reaches them only through these routines.
CREATE TABLE opengeni_private.vault_authority_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vault_authority_capabilities_kind_chk CHECK (capability_kind IN ('read', 'write')),
  CONSTRAINT vault_authority_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind)
);
REVOKE ALL ON TABLE opengeni_private.vault_authority_capabilities FROM PUBLIC;

CREATE FUNCTION opengeni_private.vault_authority_capability_active(
  p_capability_kind text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.vault_authority_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND (p_capability_kind IS NULL OR capability.capability_kind = p_capability_kind)
  )
$$;
REVOKE ALL ON FUNCTION opengeni_private.vault_authority_capability_active(text) FROM PUBLIC;

-- Invoker rights: only effective inside a vault routine, where the current
-- user is the routine owner.
CREATE FUNCTION opengeni_private.vault_capability_open(p_kind text) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog
AS $$
  INSERT INTO opengeni_private.vault_authority_capabilities (backend_pid, transaction_id, capability_kind)
  VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_kind)
  ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION opengeni_private.vault_capability_close() RETURNS void
LANGUAGE sql
SET search_path = pg_catalog
AS $$
  DELETE FROM opengeni_private.vault_authority_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
$$;
REVOKE ALL ON FUNCTION opengeni_private.vault_capability_open(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.vault_capability_close() FROM PUBLIC;

-- Every vault capability policy is scoped TO the routine owner. Their USING
-- already demands current_user = owner, so this changes nothing for vault
-- routines; it keeps other roles (reporting/analytics readers of sessions,
-- workspaces, ...) from ever evaluating the private predicate they cannot
-- EXECUTE (0359 reporting-role compatibility).
DO $vault_policies$
DECLARE
  data_schema text := current_schema();
  routine_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'vaults', 'vault_items', 'vault_item_fields', 'vault_field_versions',
    'vault_item_name_aliases', 'vault_name_aliases', 'vault_passkey_leases'
  ] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', data_schema, table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', data_schema, table_name);
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', data_schema, table_name);
    EXECUTE format(
      'CREATE POLICY vault_authority_capability_write ON %I.%I FOR ALL TO %I '
        || 'USING (current_user = %L AND opengeni_private.vault_authority_capability_active(''write'')) '
        || 'WITH CHECK (current_user = %L AND opengeni_private.vault_authority_capability_active(''write''))',
      data_schema, table_name, routine_owner, routine_owner, routine_owner
    );
  END LOOP;

  -- Tables vault routines read (reach, fences, labels).
  FOREACH table_name IN ARRAY ARRAY[
    'vaults', 'vault_items', 'vault_item_fields', 'vault_field_versions',
    'vault_item_name_aliases', 'vault_name_aliases', 'vault_passkey_leases',
    'managed_accounts', 'workspaces', 'organization_memberships', 'workspace_memberships',
    'organization_user_resource_authorities', 'sessions', 'session_turns',
    'session_turn_attempts', 'session_attempt_interruptions', 'scheduled_tasks',
    'scheduled_task_runs', 'connections'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY vault_authority_capability_read ON %I.%I FOR SELECT TO %I '
        || 'USING (current_user = %L AND opengeni_private.vault_authority_capability_active())',
      data_schema, table_name, routine_owner, routine_owner
    );
  END LOOP;

  -- Tables vault routines write besides their own: user-vault authorities,
  -- audit rows, and the session vault policy.
  EXECUTE format(
    'CREATE POLICY vault_authority_capability_insert ON %I.organization_user_resource_authorities '
      || 'FOR INSERT TO %I WITH CHECK (current_user = %L AND '
      || 'opengeni_private.vault_authority_capability_active(''write''))',
    data_schema, routine_owner, routine_owner
  );
  EXECUTE format(
    'CREATE POLICY vault_authority_capability_update ON %I.organization_user_resource_authorities '
      || 'FOR UPDATE TO %I USING (current_user = %L AND '
      || 'opengeni_private.vault_authority_capability_active(''write'')) '
      || 'WITH CHECK (current_user = %L AND opengeni_private.vault_authority_capability_active(''write''))',
    data_schema, routine_owner, routine_owner, routine_owner
  );
  EXECUTE format(
    'CREATE POLICY vault_authority_capability_insert ON %I.audit_events '
      || 'FOR INSERT TO %I WITH CHECK (current_user = %L AND '
      || 'opengeni_private.vault_authority_capability_active())',
    data_schema, routine_owner, routine_owner
  );
  EXECUTE format(
    'CREATE POLICY vault_authority_capability_update ON %I.sessions '
      || 'FOR UPDATE TO %I USING (current_user = %L AND '
      || 'opengeni_private.vault_authority_capability_active(''write'')) '
      || 'WITH CHECK (current_user = %L AND opengeni_private.vault_authority_capability_active(''write''))',
    data_schema, routine_owner, routine_owner, routine_owner
  );
END
$vault_policies$;

-- ---------------------------------------------------------------------------
-- 5. Internal helpers (invoker rights; effective only inside vault routines)
-- ---------------------------------------------------------------------------

-- Errors carry the VaultErrorCode as the message prefix and HINT
-- 'opengeni.vault_error'; the TypeScript layer maps them to VaultError.
CREATE FUNCTION opengeni_private.vault_raise(
  p_code text, p_message text, p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = p_code || ': ' || p_message,
    DETAIL = coalesce(p_details, '{}'::jsonb)::text,
    HINT = 'opengeni.vault_error';
END
$$;

-- Limits (DM-8). Tests may only lower them, through the transaction-local
-- GUC opengeni.vault_limits_override = '{"itemsPerVault": 3, ...}'.
CREATE FUNCTION opengeni_private.vault_limit(p_name text, p_default integer) RETURNS integer
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  raw_override text := nullif(pg_catalog.current_setting('opengeni.vault_limits_override', true), '');
  override_value integer;
BEGIN
  IF raw_override IS NULL THEN
    RETURN p_default;
  END IF;
  BEGIN
    override_value := (raw_override::jsonb ->> p_name)::integer;
  EXCEPTION WHEN OTHERS THEN
    RETURN p_default;
  END;
  RETURN least(p_default, coalesce(override_value, p_default));
END
$$;

CREATE FUNCTION opengeni_private.vault_audit(
  p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_action text,
  p_target_type text, p_target_id text, p_metadata jsonb
) RETURNS void
LANGUAGE sql
SET search_path FROM CURRENT
AS $$
  INSERT INTO audit_events (account_id, workspace_id, subject_id, action, target_type, target_id, metadata)
  VALUES (p_account_id, p_workspace_id, p_subject_id, p_action, p_target_type, p_target_id,
    coalesce(p_metadata, '{}'::jsonb))
$$;

-- The caller's active organization membership, or NULL (API keys, services).
CREATE FUNCTION vault_actor_membership(p_account uuid, p_subject text) RETURNS uuid
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT membership.id FROM organization_memberships membership
  WHERE membership.account_id = p_account
    AND membership.subject_id = p_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  LIMIT 1
$$;

CREATE FUNCTION opengeni_private.vault_workspace_is_personal(p_account uuid, p_workspace uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account AND membership.personal_workspace_id = p_workspace
  )
$$;

-- A live person in this workspace: an active organization member whose
-- personal workspace this is, or who holds a workspace membership.
CREATE FUNCTION opengeni_private.vault_subject_in_workspace(
  p_account uuid, p_workspace uuid, p_subject text
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account
      AND membership.subject_id = p_subject
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND (
        membership.personal_workspace_id = p_workspace
        OR membership.role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account
            AND workspace_membership.workspace_id = p_workspace
            AND workspace_membership.subject_id = p_subject
        )
      )
  )
$$;

-- Whether a person may use secrets here (`secrets:use` or one of its aliases,
-- Q-16). Organization owners and admins and the personal-workspace owner may.
CREATE FUNCTION opengeni_private.vault_subject_has_secrets_use(
  p_account uuid, p_workspace uuid, p_subject text
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account
      AND membership.subject_id = p_subject
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
      AND (membership.personal_workspace_id = p_workspace OR membership.role IN ('owner', 'admin'))
  ) OR EXISTS (
    SELECT 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account
      AND workspace_membership.workspace_id = p_workspace
      AND workspace_membership.subject_id = p_subject
      AND (
        workspace_membership.role = 'admin'
        OR workspace_membership.permissions ?| ARRAY[
          'secrets:use', 'variable-sets:use', 'variable-sets:attach', 'environments:use',
          'workspace:admin'
        ]
      )
  )
$$;

-- Intersect two policy vault-ID lists; NULL means "all".
CREATE FUNCTION opengeni_private.vault_policy_ids(p_policy jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_policy ->> 'mode' = 'selected' THEN coalesce(p_policy -> 'vaultIds', '[]'::jsonb) END
$$;
CREATE FUNCTION opengeni_private.vault_policy_intersect(p_left jsonb, p_right jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN p_left IS NULL THEN p_right
    WHEN p_right IS NULL THEN p_left
    ELSE coalesce((
      SELECT pg_catalog.jsonb_agg(element ORDER BY ordinality)
      FROM pg_catalog.jsonb_array_elements(p_left) WITH ORDINALITY AS left_ids(element, ordinality)
      WHERE p_right @> pg_catalog.jsonb_build_array(element)
    ), '[]'::jsonb)
  END
$$;

-- The effective policy of a session: its own policy, every ancestor's, and
-- (for scheduled runs) the schedule's. NULL means "all". The nearest
-- narrowing ancestor is reported for the UI.
CREATE FUNCTION opengeni_private.vault_session_policy_chain(
  p_account uuid, p_workspace uuid, p_session uuid, p_include_self boolean
) RETURNS TABLE (vault_ids jsonb, narrowed_by uuid)
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  chain_row record;
  result_ids jsonb := NULL;
  narrowing uuid := NULL;
BEGIN
  FOR chain_row IN
    WITH RECURSIVE chain(id, parent_session_id, vault_policy, depth) AS (
      SELECT session_value.id, session_value.parent_session_id, session_value.vault_policy, 0
      FROM sessions session_value
      WHERE session_value.id = p_session
        AND session_value.account_id = p_account
        AND session_value.workspace_id = p_workspace
      UNION ALL
      SELECT parent.id, parent.parent_session_id, parent.vault_policy, chain.depth + 1
      FROM chain
      JOIN sessions parent
        ON parent.id = chain.parent_session_id
       AND parent.account_id = p_account
       AND parent.workspace_id = p_workspace
      WHERE chain.depth < 64
    )
    SELECT * FROM chain ORDER BY depth
  LOOP
    CONTINUE WHEN chain_row.depth = 0 AND NOT p_include_self;
    IF chain_row.vault_policy ->> 'mode' = 'selected' AND narrowing IS NULL THEN
      narrowing := chain_row.id;
    END IF;
    result_ids := opengeni_private.vault_policy_intersect(
      result_ids, opengeni_private.vault_policy_ids(chain_row.vault_policy)
    );
  END LOOP;
  vault_ids := result_ids;
  narrowed_by := narrowing;
  RETURN NEXT;
END
$$;

-- Resolve who is acting and what they may reach, for a principal (or, when
-- p_principal is NULL, for the subject in the opengeni.* GUCs). Raises when
-- an attempt principal is not the exact current attempt (AX-8).
CREATE FUNCTION opengeni_private.vault_principal_context(p_principal jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  guc_account uuid := nullif(pg_catalog.current_setting('opengeni.account_id', true), '')::uuid;
  guc_workspace uuid := nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid;
  guc_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
  principal_kind text := coalesce(p_principal ->> 'kind', 'subject');
  acting_subject text;
  membership_id uuid;
  human_expected boolean := false;
  human_valid boolean := false;
  has_use boolean := false;
  agent_allowed boolean := true;
  include_user boolean := false;
  include_shared boolean := false;
  task_root uuid;
  task_mode text := 'none';
  policy_ids jsonb := NULL;
  narrowed_by uuid := NULL;
  session_row record;
  schedule_policy jsonb;
  schedule_owner text;
  attempt_session uuid;
BEGIN
  IF guc_account IS NULL OR guc_workspace IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'vault access needs a tenant context');
  END IF;
  IF p_principal IS NOT NULL AND (
    (p_principal ->> 'accountId')::uuid IS DISTINCT FROM guc_account
    OR (p_principal ->> 'workspaceId')::uuid IS DISTINCT FROM guc_workspace
  ) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'principal is outside the tenant context');
  END IF;

  IF principal_kind IN ('subject', 'human', 'site_viewer') THEN
    acting_subject := CASE WHEN principal_kind = 'subject' THEN guc_subject
      ELSE nullif(p_principal ->> 'subjectId', '') END;
    IF principal_kind <> 'subject' AND guc_subject IS NOT NULL AND acting_subject IS DISTINCT FROM guc_subject THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied', 'principal subject mismatch');
    END IF;
    membership_id := CASE WHEN acting_subject IS NULL THEN NULL
      ELSE vault_actor_membership(guc_account, acting_subject) END;
    human_valid := membership_id IS NOT NULL;
    IF principal_kind = 'site_viewer' THEN
      has_use := human_valid
        AND opengeni_private.vault_subject_has_secrets_use(guc_account, guc_workspace, acting_subject);
      include_user := has_use;
      include_shared := has_use;
    ELSE
      -- Human and API callers: permission checks happen at the route.
      has_use := true;
      include_user := human_valid;
      include_shared := true;
      task_mode := 'visible';
    END IF;
  ELSIF principal_kind = 'attempt' THEN
    SELECT session_value.id, session_value.root_session_id,
        session_value.first_party_mcp_permissions,
        coalesce(
          nullif(pg_catalog.btrim(turn_value.initiating_human_subject_id), ''),
          CASE WHEN turn_value.initiator_kind = 'subject'
            THEN nullif(pg_catalog.btrim(turn_value.initiator_subject_id), '') END
        ) AS human_subject,
        turn_value.scheduled_task_run_id
      INTO session_row
    FROM sessions session_value
    JOIN session_turns turn_value
      ON turn_value.id = (p_principal ->> 'turnId')::uuid
     AND turn_value.account_id = session_value.account_id
     AND turn_value.workspace_id = session_value.workspace_id
     AND turn_value.session_id = session_value.id
    JOIN session_turn_attempts attempt
      ON attempt.id = (p_principal ->> 'attemptId')::uuid
     AND attempt.account_id = turn_value.account_id
     AND attempt.workspace_id = turn_value.workspace_id
     AND attempt.session_id = turn_value.session_id
     AND attempt.turn_id = turn_value.id
    WHERE session_value.id = (p_principal ->> 'sessionId')::uuid
      AND session_value.account_id = guc_account
      AND session_value.workspace_id = guc_workspace
      AND session_value.active_turn_id = turn_value.id
      AND turn_value.active_attempt_id = attempt.id
      AND turn_value.execution_generation = (p_principal ->> 'executionGeneration')::integer
      AND attempt.execution_generation = (p_principal ->> 'executionGeneration')::integer
      AND attempt.state IN ('claimed', 'running')
      AND attempt.closed_at IS NULL
      AND attempt.quiesced_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM session_attempt_interruptions interruption
        WHERE interruption.account_id = guc_account
          AND interruption.workspace_id = guc_workspace
          AND interruption.session_id = session_value.id
          AND interruption.attempt_id = attempt.id
          AND interruption.state IN ('pending', 'delivered', 'acknowledged')
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'vault_permission_denied: secret resolution requires the exact current attempt',
        HINT = 'opengeni.vault_error';
    END IF;
    task_root := coalesce(session_row.root_session_id, session_row.id);
    attempt_session := session_row.id;
    task_mode := 'root';
    acting_subject := session_row.human_subject;
    IF acting_subject IS NOT NULL THEN
      human_expected := true;
    ELSIF session_row.scheduled_task_run_id IS NOT NULL THEN
      SELECT task.owner_subject_id, task.vault_policy INTO schedule_owner, schedule_policy
      FROM scheduled_task_runs run
      JOIN scheduled_tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
      WHERE run.id = session_row.scheduled_task_run_id AND run.workspace_id = guc_workspace;
      acting_subject := nullif(pg_catalog.btrim(schedule_owner), '');
      human_expected := acting_subject IS NOT NULL;
    END IF;
    IF human_expected THEN
      membership_id := vault_actor_membership(guc_account, acting_subject);
      human_valid := membership_id IS NOT NULL
        AND opengeni_private.vault_subject_in_workspace(guc_account, guc_workspace, acting_subject);
      IF NOT human_valid THEN
        membership_id := NULL;
      END IF;
      has_use := human_valid
        AND opengeni_private.vault_subject_has_secrets_use(guc_account, guc_workspace, acting_subject);
    ELSE
      has_use := true;
    END IF;
    agent_allowed := session_row.first_party_mcp_permissions IS NULL
      OR pg_catalog.jsonb_typeof(session_row.first_party_mcp_permissions) <> 'array'
      OR session_row.first_party_mcp_permissions ?| ARRAY[
        'secrets:use', 'variable-sets:use', 'variable-sets:attach', 'environments:use'
      ];
    include_user := agent_allowed AND human_valid AND has_use;
    include_shared := agent_allowed AND has_use AND (NOT human_expected OR human_valid);
    IF NOT agent_allowed THEN
      task_mode := 'none';
    END IF;
    SELECT chain.vault_ids, chain.narrowed_by INTO policy_ids, narrowed_by
    FROM opengeni_private.vault_session_policy_chain(guc_account, guc_workspace, session_row.id, true) chain;
    IF schedule_policy IS NULL AND session_row.scheduled_task_run_id IS NOT NULL THEN
      SELECT task.vault_policy INTO schedule_policy
      FROM scheduled_task_runs run
      JOIN scheduled_tasks task ON task.id = run.task_id AND task.workspace_id = run.workspace_id
      WHERE run.id = session_row.scheduled_task_run_id AND run.workspace_id = guc_workspace;
    END IF;
    policy_ids := opengeni_private.vault_policy_intersect(
      policy_ids, opengeni_private.vault_policy_ids(schedule_policy)
    );
  ELSE
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'unknown principal kind');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'kind', principal_kind,
    'accountId', guc_account,
    'workspaceId', guc_workspace,
    'subjectId', acting_subject,
    'sessionId', attempt_session,
    'membershipId', membership_id,
    'humanExpected', human_expected,
    'humanValid', human_valid,
    'hasSecretsUse', has_use,
    'agentAllowed', agent_allowed,
    'includeUser', include_user,
    'includeShared', include_shared,
    'taskMode', task_mode,
    'taskRoot', task_root,
    'personalWorkspace', opengeni_private.vault_workspace_is_personal(guc_account, guc_workspace),
    'policyVaultIds', policy_ids,
    'narrowedBySessionId', narrowed_by
  );
END
$$;

-- Vaults a context reaches, with their lookup tier (0 task, 1 Only me,
-- 2 workspace, 3 organization). Policies narrow every vault but the task vault.
CREATE FUNCTION opengeni_private.vault_reach(p_context jsonb)
RETURNS TABLE (vault_id uuid, tier integer)
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT vault.id,
    CASE vault.owner_kind WHEN 'task' THEN 0 WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END
  FROM vaults vault
  WHERE vault.account_id = (p_context ->> 'accountId')::uuid
    AND (
      (vault.owner_kind = 'task'
        AND vault.workspace_id = (p_context ->> 'workspaceId')::uuid
        AND (
          (p_context ->> 'taskMode' = 'root'
            AND vault.root_session_id = (p_context ->> 'taskRoot')::uuid)
          OR (p_context ->> 'taskMode' = 'visible' AND EXISTS (
            SELECT 1 FROM sessions root_session
            WHERE root_session.workspace_id = vault.workspace_id
              AND root_session.id = vault.root_session_id
              AND (root_session.visibility = 'workspace_shared'
                OR root_session.owner_subject_id = p_context ->> 'subjectId')
          ))
        ))
      OR (vault.owner_kind = 'user'
        AND (p_context ->> 'includeUser')::boolean
        AND vault.owner_organization_membership_id = (p_context ->> 'membershipId')::uuid)
      OR (vault.owner_kind = 'workspace'
        AND (p_context ->> 'includeShared')::boolean
        AND vault.workspace_id = (p_context ->> 'workspaceId')::uuid)
      OR (vault.owner_kind = 'organization'
        AND (p_context ->> 'includeShared')::boolean
        AND (vault.allowed_workspace_ids IS NULL
          OR (p_context ->> 'workspaceId')::uuid = ANY (vault.allowed_workspace_ids))
        AND (vault.allow_personal_workspaces OR NOT (p_context ->> 'personalWorkspace')::boolean))
    )
    AND (
      vault.owner_kind = 'task'
      OR pg_catalog.jsonb_typeof(p_context -> 'policyVaultIds') IS DISTINCT FROM 'array'
      OR (p_context -> 'policyVaultIds') @> pg_catalog.jsonb_build_array(vault.id::text)
    )
$$;

-- The vault row, if the context reaches it; raises vault_not_found otherwise.
CREATE FUNCTION opengeni_private.vault_reachable_row(p_context jsonb, p_vault_id uuid)
RETURNS vaults
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  vault_row vaults;
BEGIN
  SELECT vault.* INTO vault_row FROM vaults vault
  WHERE vault.id = p_vault_id
    AND vault.id IN (SELECT reach.vault_id FROM opengeni_private.vault_reach(p_context) reach);
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'vault not found', pg_catalog.jsonb_build_object('vaultId', p_vault_id));
  END IF;
  RETURN vault_row;
END
$$;

CREATE FUNCTION opengeni_private.vault_owner_scope_key(p_vault vaults) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path FROM CURRENT
AS $$
  SELECT CASE p_vault.owner_kind
    WHEN 'workspace' THEN p_vault.workspace_id::text
    WHEN 'user' THEN p_vault.owner_organization_membership_id::text
    WHEN 'organization' THEN p_vault.account_id::text
    ELSE 'task:' || p_vault.root_session_id::text
  END
$$;

CREATE FUNCTION opengeni_private.vault_summary_json(p_vault vaults, p_context jsonb) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_vault.id,
    'workspaceId', p_vault.workspace_id,
    'ownerKind', p_vault.owner_kind,
    'ownerLabel', CASE p_vault.owner_kind
      WHEN 'user' THEN 'Only me'
      WHEN 'task' THEN 'This task'
      WHEN 'workspace' THEN (SELECT workspace.name FROM workspaces workspace WHERE workspace.id = p_vault.workspace_id)
      ELSE (SELECT account.name FROM managed_accounts account WHERE account.id = p_vault.account_id)
    END,
    'rootSessionId', p_vault.root_session_id,
    'name', p_vault.name,
    'description', p_vault.description,
    'source', p_vault.source,
    'mode', p_vault.mode,
    'syncStatus', p_vault.sync_status,
    'syncErrorCode', p_vault.sync_error_code,
    'syncErrorMessage', p_vault.sync_error_message,
    'lastSyncedAt', p_vault.last_synced_at,
    'rateLimitedUntil', p_vault.rate_limited_until,
    'providerConnectionId', p_vault.provider_connection_id,
    'providerVaultRef', p_vault.provider_vault_ref,
    'availability', CASE WHEN p_vault.owner_kind = 'organization' THEN pg_catalog.jsonb_build_object(
      'allowedWorkspaceIds', pg_catalog.to_jsonb(p_vault.allowed_workspace_ids),
      'allowPersonalWorkspaces', p_vault.allow_personal_workspaces
    ) END,
    'isDefault', p_vault.is_default,
    'itemCount', (SELECT pg_catalog.count(*) FROM vault_items item
      WHERE item.vault_id = p_vault.id AND item.archived_at IS NULL),
    'ownedByCaller', p_vault.owner_kind = 'user'
      AND p_vault.owner_organization_membership_id = (p_context ->> 'membershipId')::uuid,
    'generation', p_vault.generation,
    'createdBySubjectId', p_vault.created_by_subject_id,
    'createdAt', p_vault.created_at,
    'updatedAt', p_vault.updated_at
  )
$$;

-- Item JSON for the TypeScript layer. Values stay encrypted: text-kind
-- fields carry `valueEncrypted` (the service decrypts them for display) and
-- every other kind carries none.
CREATE FUNCTION opengeni_private.vault_item_json(p_item vault_items, p_with_fields boolean)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_item.id,
    'vaultId', p_item.vault_id,
    'vaultName', vault.name,
    'vaultOwnerKind', vault.owner_kind,
    'vaultSource', vault.source,
    'vaultMode', vault.mode,
    'type', p_item.type,
    'name', p_item.name,
    'nameKey', p_item.name_key,
    'websites', pg_catalog.to_jsonb(p_item.websites),
    'expiresAt', p_item.expires_at,
    'archivedAt', p_item.archived_at,
    'lastUsedAt', p_item.last_used_at,
    'updatedAt', p_item.updated_at,
    'createdAt', p_item.created_at,
    'createdBySubjectId', p_item.created_by_subject_id,
    'generation', p_item.generation,
    'primaryFieldId', p_item.primary_field_id,
    'passkeySignCount', p_item.passkey_sign_count,
    'passkeyLeasedUntil', (SELECT lease.expires_at FROM vault_passkey_leases lease
      WHERE lease.item_id = p_item.id AND lease.expires_at > pg_catalog.now()),
    'aliases', coalesce((SELECT pg_catalog.jsonb_agg(alias.name_key ORDER BY alias.name_key)
      FROM vault_item_name_aliases alias WHERE alias.item_id = p_item.id), '[]'::jsonb),
    'fields', coalesce((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', field.id,
        'name', field.name,
        'kind', field.kind,
        'position', field.position,
        'currentVersion', field.current_version,
        'providerFieldRef', field.provider_field_ref,
        'fileName', field.file_name,
        'fileSize', field.file_size,
        'updatedAt', field.updated_at,
        'valueEncrypted', CASE
          WHEN field.kind = 'text'
            AND (p_with_fields OR field.name_key IN ('username', 'rpid', 'credentialid'))
          THEN (SELECT version.value_encrypted FROM vault_field_versions version
            WHERE version.field_id = field.id AND version.version = field.current_version)
        END
      ) ORDER BY field.position, field.name_key)
      FROM vault_item_fields field WHERE field.item_id = p_item.id
    ), '[]'::jsonb)
  )
  FROM vaults vault WHERE vault.id = p_item.vault_id
$$;

-- The principal context, checked against an expected workspace.
CREATE FUNCTION opengeni_private.vault_context(p_principal jsonb, p_workspace uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb := opengeni_private.vault_principal_context(p_principal);
BEGIN
  IF p_workspace IS NOT NULL AND (context ->> 'workspaceId')::uuid IS DISTINCT FROM p_workspace THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'workspace is outside the tenant context');
  END IF;
  RETURN context;
END
$$;

-- The item row, if the context reaches its vault; raises vault_item_not_found otherwise.
CREATE FUNCTION opengeni_private.vault_reachable_item(p_context jsonb, p_item_id uuid)
RETURNS vault_items
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  item_row vault_items;
BEGIN
  SELECT item.* INTO item_row FROM vault_items item
  WHERE item.id = p_item_id
    AND item.account_id = (p_context ->> 'accountId')::uuid
    AND item.vault_id IN (SELECT reach.vault_id FROM opengeni_private.vault_reach(p_context) reach);
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_item_not_found', 'item not found',
      pg_catalog.jsonb_build_object('itemId', p_item_id));
  END IF;
  RETURN item_row;
END
$$;

-- Hosted items change only in hosted read-write vaults, and never from a Site.
CREATE FUNCTION opengeni_private.vault_assert_writable(p_context jsonb, p_vault vaults) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
BEGIN
  IF p_context ->> 'kind' = 'site_viewer' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'Sites cannot change vault items');
  END IF;
  IF p_vault.source <> 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_read_only',
      'items in a connected vault change through its provider',
      pg_catalog.jsonb_build_object('vaultId', p_vault.id));
  END IF;
  IF p_vault.mode <> 'read_write' THEN
    PERFORM opengeni_private.vault_raise('vault_read_only', 'vault is read-only',
      pg_catalog.jsonb_build_object('vaultId', p_vault.id));
  END IF;
END
$$;

CREATE FUNCTION opengeni_private.vault_assert_name(p_name text, p_what text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NOT opengeni_private.vault_name_is_valid(p_name) THEN
    PERFORM opengeni_private.vault_raise('invalid_secret_name',
      p_what || ' names are 1-120 characters without / { } # \ or control characters, '
        || 'without surrounding spaces, and do not start with "id:"',
      pg_catalog.jsonb_build_object('name', p_name));
  END IF;
END
$$;

-- Insert a vault in the context's scope (limits, name conflicts, user authority).
CREATE FUNCTION opengeni_private.vault_insert(
  p_context jsonb, p_owner_kind text, p_name text, p_description text,
  p_allowed_workspace_ids uuid[], p_allow_personal_workspaces boolean,
  p_is_default boolean, p_root_session_id uuid
) RETURNS vaults
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  account uuid := (p_context ->> 'accountId')::uuid;
  workspace uuid := (p_context ->> 'workspaceId')::uuid;
  membership uuid := (p_context ->> 'membershipId')::uuid;
  new_id uuid := pg_catalog.gen_random_uuid();
  authority uuid;
  scope_count integer;
  vault_limit integer := opengeni_private.vault_limit('vaultsPerOwnerScope', 200);
  vault_row vaults;
BEGIN
  PERFORM opengeni_private.vault_assert_name(p_name, 'Vault');
  IF p_owner_kind NOT IN ('user', 'workspace', 'organization', 'task') THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'unknown vault owner');
  END IF;
  IF p_owner_kind = 'user' AND membership IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      'Only-me vaults belong to a person; this caller has no organization membership');
  END IF;
  IF p_description IS NOT NULL AND pg_catalog.char_length(p_description) > 2000 THEN
    PERFORM opengeni_private.vault_raise('invalid_secret_name', 'vault descriptions are at most 2000 characters');
  END IF;
  IF p_owner_kind <> 'task' THEN
    -- Serialize creation per owner scope so the count and name checks hold.
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'vault-scope:' || account::text || ':' || p_owner_kind || ':' || CASE p_owner_kind
        WHEN 'workspace' THEN workspace::text WHEN 'user' THEN membership::text ELSE account::text END,
      0));
    SELECT pg_catalog.count(*) INTO scope_count FROM vaults vault
    WHERE vault.account_id = account AND vault.owner_kind = p_owner_kind
      AND (p_owner_kind = 'organization'
        OR (p_owner_kind = 'workspace' AND vault.workspace_id = workspace)
        OR (p_owner_kind = 'user' AND vault.owner_organization_membership_id = membership));
    IF scope_count >= vault_limit THEN
      PERFORM opengeni_private.vault_raise('vault_limit_reached',
        'at most ' || vault_limit || ' vaults per owner',
        pg_catalog.jsonb_build_object('limit', vault_limit, 'ownerKind', p_owner_kind));
    END IF;
    IF EXISTS (
      SELECT 1 FROM vaults vault
      WHERE vault.account_id = account AND vault.owner_kind = p_owner_kind
        AND vault.name_key = vault_name_key(p_name)
        AND (p_owner_kind = 'organization'
          OR (p_owner_kind = 'workspace' AND vault.workspace_id = workspace)
          OR (p_owner_kind = 'user' AND vault.owner_organization_membership_id = membership))
    ) THEN
      PERFORM opengeni_private.vault_raise('vault_name_conflict', 'a vault with this name already exists',
        pg_catalog.jsonb_build_object('name', p_name));
    END IF;
  END IF;
  IF p_owner_kind = 'user' THEN
    authority := pg_catalog.gen_random_uuid();
    INSERT INTO organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id, origin_workspace_id
    ) VALUES (authority, account, membership, 'vault', new_id, workspace);
  END IF;
  INSERT INTO vaults (
    id, account_id, workspace_id, owner_kind, authority_id, owner_organization_membership_id,
    origin_workspace_id, root_session_id, name, description, allowed_workspace_ids,
    allow_personal_workspaces, is_default, created_by_subject_id
  ) VALUES (
    -- An Only-me vault lives with its owner's personal workspace when there is
    -- one, so deleting the workspace it was first saved from cannot take it.
    new_id, account,
    CASE WHEN p_owner_kind = 'user' THEN coalesce((
      SELECT membership_row.personal_workspace_id FROM organization_memberships membership_row
      JOIN workspaces home ON home.id = membership_row.personal_workspace_id AND home.account_id = account
      WHERE membership_row.account_id = account AND membership_row.id = membership), workspace)
    ELSE workspace END,
    p_owner_kind, authority,
    CASE WHEN p_owner_kind = 'user' THEN membership END,
    CASE WHEN p_owner_kind IN ('user', 'organization') THEN workspace END,
    CASE WHEN p_owner_kind = 'task' THEN p_root_session_id END,
    p_name, p_description,
    CASE WHEN p_owner_kind = 'organization' THEN p_allowed_workspace_ids END,
    coalesce(p_allow_personal_workspaces, true), coalesce(p_is_default, false),
    p_context ->> 'subjectId'
  ) RETURNING * INTO vault_row;
  PERFORM opengeni_private.vault_audit(account, workspace, p_context ->> 'subjectId', 'vault.created',
    'vault', vault_row.id::text, pg_catalog.jsonb_build_object(
      'vaultId', vault_row.id, 'name', vault_row.name, 'ownerKind', vault_row.owner_kind,
      'isDefault', vault_row.is_default));
  RETURN vault_row;
END
$$;

-- The caller's default "Private" (user) or "Shared" (workspace) vault,
-- created lazily. An existing vault with the default name becomes the default.
CREATE FUNCTION opengeni_private.vault_ensure_default(p_context jsonb, p_owner_kind text)
RETURNS vaults
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  account uuid := (p_context ->> 'accountId')::uuid;
  workspace uuid := (p_context ->> 'workspaceId')::uuid;
  membership uuid := (p_context ->> 'membershipId')::uuid;
  default_name text := CASE p_owner_kind WHEN 'user' THEN 'Private' ELSE 'Shared' END;
  vault_row vaults;
BEGIN
  IF p_owner_kind = 'user' THEN
    IF NOT coalesce((p_context ->> 'includeUser')::boolean, false) OR membership IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'this caller cannot use Only-me vaults here');
    END IF;
  ELSIF p_owner_kind = 'workspace' THEN
    IF NOT coalesce((p_context ->> 'includeShared')::boolean, false) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'this caller cannot use workspace vaults here');
    END IF;
  ELSE
    PERFORM opengeni_private.vault_raise('vault_permission_denied',
      'default vaults exist only for "user" and "workspace"');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vault-default:' || account::text || ':' || p_owner_kind || ':'
      || CASE p_owner_kind WHEN 'user' THEN membership::text ELSE workspace::text END, 0));
  SELECT vault.* INTO vault_row FROM vaults vault
  WHERE vault.account_id = account AND vault.owner_kind = p_owner_kind
    AND (
      (p_owner_kind = 'user' AND vault.owner_organization_membership_id = membership)
      OR (p_owner_kind = 'workspace' AND vault.workspace_id = workspace)
    )
  ORDER BY vault.is_default DESC, (vault.name_key = vault_name_key(default_name)) DESC, vault.created_at
  LIMIT 1;
  IF FOUND AND (vault_row.is_default OR vault_row.name_key = vault_name_key(default_name)) THEN
    IF NOT vault_row.is_default THEN
      UPDATE vaults SET is_default = true, updated_at = pg_catalog.now()
      WHERE id = vault_row.id RETURNING * INTO vault_row;
    END IF;
    RETURN vault_row;
  END IF;
  RETURN opengeni_private.vault_insert(p_context, p_owner_kind, default_name, NULL, NULL, true, true, NULL);
END
$$;

-- The task vault of a session's root, created lazily. Attempts reach only
-- their own tree; people only trees they can see.
CREATE FUNCTION opengeni_private.vault_ensure_task(p_context jsonb, p_session uuid)
RETURNS vaults
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  account uuid := (p_context ->> 'accountId')::uuid;
  workspace uuid := (p_context ->> 'workspaceId')::uuid;
  root_id uuid;
  root_row record;
  vault_row vaults;
BEGIN
  SELECT coalesce(session_value.root_session_id, session_value.id) INTO root_id
  FROM sessions session_value
  WHERE session_value.id = p_session
    AND session_value.account_id = account
    AND session_value.workspace_id = workspace;
  IF root_id IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'session not found',
      pg_catalog.jsonb_build_object('sessionId', p_session));
  END IF;
  IF p_context ->> 'taskMode' = 'root' THEN
    IF (p_context ->> 'taskRoot')::uuid IS DISTINCT FROM root_id THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied', 'another task''s vault');
    END IF;
  ELSIF p_context ->> 'taskMode' = 'visible' THEN
    SELECT root_session.visibility, root_session.owner_subject_id INTO root_row
    FROM sessions root_session
    WHERE root_session.workspace_id = workspace AND root_session.id = root_id;
    IF NOT FOUND OR NOT (root_row.visibility = 'workspace_shared'
      OR root_row.owner_subject_id = p_context ->> 'subjectId') THEN
      PERFORM opengeni_private.vault_raise('vault_not_found', 'session not found',
        pg_catalog.jsonb_build_object('sessionId', p_session));
    END IF;
  ELSE
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'this caller has no task vault');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vault-task:' || workspace::text || ':' || root_id::text, 0));
  SELECT vault.* INTO vault_row FROM vaults vault
  WHERE vault.workspace_id = workspace AND vault.owner_kind = 'task' AND vault.root_session_id = root_id;
  IF FOUND THEN
    RETURN vault_row;
  END IF;
  RETURN opengeni_private.vault_insert(p_context, 'task', 'Task', NULL, NULL, true, false, root_id);
END
$$;

-- Create or update one hosted item and its fields in one step. Values arrive
-- encrypted (`valueEncrypted`) with their plaintext byte size (`valueSize`).
-- p: {name?, type?, websites?, expiresAt?, primaryFieldName?, expectedGeneration?,
--     createdByKind?, passkeySignCount?, fields: [{fieldId?, name, newName?, kind?,
--     valueEncrypted?, valueSize?, restoreVersion?, remove?, fileName?}]}
CREATE FUNCTION opengeni_private.vault_write_item(
  p_context jsonb, p_vault vaults, p_existing vault_items, p jsonb
) RETURNS vault_items
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  subject text := p_context ->> 'subjectId';
  created_by text := coalesce(nullif(p ->> 'createdByKind', ''),
    CASE p_context ->> 'kind' WHEN 'attempt' THEN 'agent' ELSE 'human' END);
  is_new boolean := p_existing.id IS NULL;
  item_row vault_items;
  new_name text;
  new_type text;
  item_count integer;
  field_input jsonb;
  field_row vault_item_fields;
  field_found boolean;
  field_name text;
  field_kind text;
  field_count integer;
  value_size integer;
  size_limit integer;
  next_version integer;
  restored_value text;
  next_position integer;
  primary_id uuid;
  default_primary text;
  changed_fields jsonb := '[]'::jsonb;
  websites_value text[];
  items_limit integer := opengeni_private.vault_limit('itemsPerVault', 2000);
  fields_limit integer := opengeni_private.vault_limit('fieldsPerItem', 50);
  versions_limit integer := opengeni_private.vault_limit('versionsPerField', 10);
BEGIN
  IF p ? 'websites' AND pg_catalog.jsonb_typeof(p -> 'websites') = 'array' THEN
    websites_value := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p -> 'websites'));
    IF pg_catalog.cardinality(websites_value) > 20
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(websites_value) website
        WHERE pg_catalog.char_length(website) > 2048) THEN
      PERFORM opengeni_private.vault_raise('vault_limit_reached', 'at most 20 websites of 2048 characters');
    END IF;
  END IF;

  IF is_new THEN
    new_name := p ->> 'name';
    new_type := coalesce(nullif(p ->> 'type', ''), 'login');
    PERFORM opengeni_private.vault_assert_name(new_name, 'Item');
    IF new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey') THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'unknown item type',
        pg_catalog.jsonb_build_object('type', new_type));
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vault-items:' || p_vault.id::text, 0));
    SELECT pg_catalog.count(*) INTO item_count FROM vault_items item WHERE item.vault_id = p_vault.id;
    IF item_count >= items_limit THEN
      PERFORM opengeni_private.vault_raise('vault_limit_reached',
        'at most ' || items_limit || ' items per vault',
        pg_catalog.jsonb_build_object('limit', items_limit, 'vaultId', p_vault.id));
    END IF;
    IF EXISTS (SELECT 1 FROM vault_items item WHERE item.vault_id = p_vault.id
      AND item.archived_at IS NULL AND item.name_key = vault_name_key(new_name)) THEN
      PERFORM opengeni_private.vault_raise('vault_item_name_conflict',
        'an item with this name already exists in the vault',
        pg_catalog.jsonb_build_object('name', new_name, 'vaultId', p_vault.id));
    END IF;
    INSERT INTO vault_items (
      account_id, vault_id, type, name, websites, expires_at, passkey_sign_count, created_by_subject_id
    ) VALUES (
      p_vault.account_id, p_vault.id, new_type, new_name, coalesce(websites_value, '{}'),
      nullif(p ->> 'expiresAt', '')::timestamptz,
      CASE WHEN new_type = 'passkey' THEN coalesce((p ->> 'passkeySignCount')::bigint, 0) END,
      subject
    ) RETURNING * INTO item_row;
  ELSE
    item_row := p_existing;
    IF item_row.archived_at IS NOT NULL THEN
      PERFORM opengeni_private.vault_raise('vault_item_not_found', 'item is archived; restore it first',
        pg_catalog.jsonb_build_object('itemId', item_row.id, 'archived', true));
    END IF;
    IF p ? 'expectedGeneration' AND p ->> 'expectedGeneration' IS NOT NULL
      AND (p ->> 'expectedGeneration')::bigint <> item_row.generation THEN
      PERFORM opengeni_private.vault_raise('vault_generation_conflict', 'item changed since it was read',
        pg_catalog.jsonb_build_object('itemId', item_row.id, 'generation', item_row.generation));
    END IF;
    new_name := coalesce(p ->> 'name', item_row.name);
    new_type := coalesce(nullif(p ->> 'type', ''), item_row.type);
    IF (new_type = 'passkey') IS DISTINCT FROM (item_row.type = 'passkey')
      OR new_type NOT IN ('login', 'api_key', 'note', 'file', 'passkey') THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'item type cannot change to or from passkey');
    END IF;
    IF new_name IS DISTINCT FROM item_row.name THEN
      PERFORM opengeni_private.vault_assert_name(new_name, 'Item');
      IF vault_name_key(new_name) <> item_row.name_key THEN
        IF EXISTS (SELECT 1 FROM vault_items item WHERE item.vault_id = p_vault.id
          AND item.archived_at IS NULL AND item.id <> item_row.id
          AND item.name_key = vault_name_key(new_name)) THEN
          PERFORM opengeni_private.vault_raise('vault_item_name_conflict',
            'an item with this name already exists in the vault',
            pg_catalog.jsonb_build_object('name', new_name, 'vaultId', p_vault.id));
        END IF;
        INSERT INTO vault_item_name_aliases (vault_id, name_key, item_id, account_id)
        VALUES (p_vault.id, item_row.name_key, item_row.id, item_row.account_id)
        ON CONFLICT (vault_id, name_key) DO UPDATE SET item_id = EXCLUDED.item_id, created_at = pg_catalog.now();
        DELETE FROM vault_item_name_aliases alias
        WHERE alias.vault_id = p_vault.id AND alias.item_id = item_row.id
          AND alias.name_key = vault_name_key(new_name);
      END IF;
    END IF;
    UPDATE vault_items SET
      name = new_name,
      type = new_type,
      websites = coalesce(websites_value, websites),
      expires_at = CASE WHEN p ? 'expiresAt' THEN nullif(p ->> 'expiresAt', '')::timestamptz ELSE expires_at END
    WHERE id = item_row.id
    RETURNING * INTO item_row;
  END IF;

  FOR field_input IN SELECT element FROM pg_catalog.jsonb_array_elements(coalesce(p -> 'fields', '[]'::jsonb)) element LOOP
    field_name := field_input ->> 'name';
    field_found := false;
    IF field_input ->> 'fieldId' IS NOT NULL THEN
      SELECT field.* INTO field_row FROM vault_item_fields field
      WHERE field.id = (field_input ->> 'fieldId')::uuid AND field.item_id = item_row.id;
      field_found := FOUND;
      IF NOT field_found THEN
        PERFORM opengeni_private.vault_raise('vault_field_not_found', 'field not found',
          pg_catalog.jsonb_build_object('fieldId', field_input ->> 'fieldId'));
      END IF;
    ELSE
      PERFORM opengeni_private.vault_assert_name(field_name, 'Field');
      SELECT field.* INTO field_row FROM vault_item_fields field
      WHERE field.item_id = item_row.id AND field.name_key = vault_name_key(field_name);
      field_found := FOUND;
    END IF;

    IF coalesce((field_input ->> 'remove')::boolean, false) THEN
      IF NOT field_found THEN
        PERFORM opengeni_private.vault_raise('vault_field_not_found', 'field not found',
          pg_catalog.jsonb_build_object('name', field_name));
      END IF;
      DELETE FROM vault_item_fields WHERE id = field_row.id;
      changed_fields := changed_fields || pg_catalog.to_jsonb(field_row.name);
      CONTINUE;
    END IF;

    IF field_found AND field_row.current_version IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_read_only', 'connected fields change through the provider');
    END IF;
    field_kind := coalesce(nullif(field_input ->> 'kind', ''), field_row.kind,
      CASE WHEN vault_name_key(field_name) IN ('username', 'rpid', 'credentialid', 'userhandle')
        THEN 'text' WHEN vault_name_key(field_name) = 'file' THEN 'file' ELSE 'concealed' END);
    IF NOT field_found THEN
      field_kind := coalesce(nullif(field_input ->> 'kind', ''),
        CASE WHEN vault_name_key(field_name) IN ('username', 'rpid', 'credentialid', 'userhandle')
          THEN 'text' WHEN vault_name_key(field_name) = 'file' THEN 'file' ELSE 'concealed' END);
    END IF;
    IF field_kind NOT IN ('text', 'concealed', 'totp', 'file') THEN
      PERFORM opengeni_private.vault_raise('invalid_secret_name', 'unknown field kind',
        pg_catalog.jsonb_build_object('kind', field_kind));
    END IF;
    value_size := (field_input ->> 'valueSize')::integer;
    size_limit := CASE WHEN field_kind = 'file'
      THEN opengeni_private.vault_limit('fileValueMaxBytes', 262144)
      ELSE opengeni_private.vault_limit('textValueMaxBytes', 65536) END;
    IF value_size IS NOT NULL AND value_size > size_limit THEN
      PERFORM opengeni_private.vault_raise('secret_value_too_large',
        'value is larger than ' || size_limit || ' bytes',
        pg_catalog.jsonb_build_object('limit', size_limit, 'field', coalesce(field_name, field_row.name)));
    END IF;

    IF NOT field_found THEN
      IF field_input ->> 'valueEncrypted' IS NULL THEN
        PERFORM opengeni_private.vault_raise('vault_field_not_found', 'a new field needs a value',
          pg_catalog.jsonb_build_object('name', field_name));
      END IF;
      SELECT pg_catalog.count(*), coalesce(pg_catalog.max(field.position) + 1, 0)
        INTO field_count, next_position
      FROM vault_item_fields field WHERE field.item_id = item_row.id;
      IF field_count >= fields_limit THEN
        PERFORM opengeni_private.vault_raise('vault_limit_reached',
          'at most ' || fields_limit || ' fields per item',
          pg_catalog.jsonb_build_object('limit', fields_limit));
      END IF;
      INSERT INTO vault_item_fields (account_id, item_id, name, kind, position, current_version, file_name, file_size)
      VALUES (item_row.account_id, item_row.id, field_name, field_kind, next_position, 1,
        CASE WHEN field_kind = 'file' THEN field_input ->> 'fileName' END,
        CASE WHEN field_kind = 'file' THEN value_size END)
      RETURNING * INTO field_row;
      INSERT INTO vault_field_versions (field_id, version, account_id, value_encrypted, created_by_kind, created_by_subject_id)
      VALUES (field_row.id, 1, item_row.account_id, field_input ->> 'valueEncrypted', created_by, subject);
    ELSE
      IF field_input ? 'newName' AND field_input ->> 'newName' IS DISTINCT FROM field_row.name THEN
        PERFORM opengeni_private.vault_assert_name(field_input ->> 'newName', 'Field');
        IF EXISTS (SELECT 1 FROM vault_item_fields field WHERE field.item_id = item_row.id
          AND field.id <> field_row.id AND field.name_key = vault_name_key(field_input ->> 'newName')) THEN
          PERFORM opengeni_private.vault_raise('invalid_secret_name', 'the item already has a field with this name');
        END IF;
      ELSIF field_input ->> 'fieldId' IS NOT NULL AND field_name IS NOT NULL
        AND field_name IS DISTINCT FROM field_row.name THEN
        PERFORM opengeni_private.vault_assert_name(field_name, 'Field');
        IF EXISTS (SELECT 1 FROM vault_item_fields field WHERE field.item_id = item_row.id
          AND field.id <> field_row.id AND field.name_key = vault_name_key(field_name)) THEN
          PERFORM opengeni_private.vault_raise('invalid_secret_name', 'the item already has a field with this name');
        END IF;
        field_input := field_input || pg_catalog.jsonb_build_object('newName', field_name);
      END IF;
      restored_value := NULL;
      -- Versions carry no kind: a field's history must never be restorable as a
      -- less concealed kind, so a kind change needs a fresh value and starts a new
      -- history (hiding text as concealed keeps it).
      IF field_kind IS DISTINCT FROM field_row.kind
        AND NOT (field_row.kind = 'text' AND field_kind = 'concealed')
        AND field_input ->> 'valueEncrypted' IS NULL THEN
        PERFORM opengeni_private.vault_raise('invalid_secret_name',
          'changing a field''s kind needs a new value',
          pg_catalog.jsonb_build_object('field', field_row.name, 'kind', field_kind));
      END IF;
      IF field_input ->> 'valueEncrypted' IS NULL AND field_input ->> 'restoreVersion' IS NOT NULL THEN
        SELECT version.value_encrypted INTO restored_value FROM vault_field_versions version
        WHERE version.field_id = field_row.id AND version.version = (field_input ->> 'restoreVersion')::integer;
        IF restored_value IS NULL THEN
          PERFORM opengeni_private.vault_raise('vault_field_not_found', 'version not found',
            pg_catalog.jsonb_build_object('fieldId', field_row.id, 'version', field_input ->> 'restoreVersion'));
        END IF;
      END IF;
      IF coalesce(field_input ->> 'valueEncrypted', restored_value) IS NOT NULL THEN
        SELECT coalesce(pg_catalog.max(version.version), 0) + 1 INTO next_version
        FROM vault_field_versions version WHERE version.field_id = field_row.id;
        INSERT INTO vault_field_versions (field_id, version, account_id, value_encrypted, created_by_kind, created_by_subject_id)
        VALUES (field_row.id, next_version, item_row.account_id,
          coalesce(field_input ->> 'valueEncrypted', restored_value), created_by, subject);
        IF field_kind IS DISTINCT FROM field_row.kind
          AND NOT (field_row.kind = 'text' AND field_kind = 'concealed') THEN
          DELETE FROM vault_field_versions version
          WHERE version.field_id = field_row.id AND version.version <> next_version;
        END IF;
        DELETE FROM vault_field_versions version
        WHERE version.field_id = field_row.id
          AND version.version NOT IN (
            SELECT kept.version FROM vault_field_versions kept
            WHERE kept.field_id = field_row.id ORDER BY kept.version DESC LIMIT versions_limit
          );
      ELSE
        next_version := field_row.current_version;
      END IF;
      UPDATE vault_item_fields SET
        name = coalesce(field_input ->> 'newName', name),
        kind = field_kind,
        current_version = next_version,
        file_name = CASE WHEN field_kind = 'file' THEN coalesce(field_input ->> 'fileName', file_name) END,
        file_size = CASE WHEN field_kind = 'file' THEN coalesce(value_size, file_size) END,
        updated_at = pg_catalog.now()
      WHERE id = field_row.id
      RETURNING * INTO field_row;
    END IF;
    changed_fields := changed_fields || pg_catalog.to_jsonb(field_row.name);
  END LOOP;

  -- Primary field: as requested, else kept, else the type default, else the
  -- first secret field (passkeys have none).
  SELECT item.primary_field_id INTO primary_id FROM vault_items item WHERE item.id = item_row.id;
  IF p ->> 'primaryFieldName' IS NOT NULL THEN
    SELECT field.id INTO primary_id FROM vault_item_fields field
    WHERE field.item_id = item_row.id AND field.name_key = vault_name_key(p ->> 'primaryFieldName');
    IF primary_id IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_field_not_found', 'primary field not found',
        pg_catalog.jsonb_build_object('name', p ->> 'primaryFieldName'));
    END IF;
  ELSIF primary_id IS NULL AND new_type <> 'passkey' THEN
    default_primary := CASE new_type WHEN 'login' THEN 'password' WHEN 'api_key' THEN 'value'
      WHEN 'note' THEN 'note' WHEN 'file' THEN 'file' END;
    SELECT field.id INTO primary_id FROM vault_item_fields field
    WHERE field.item_id = item_row.id
    ORDER BY (field.name_key = default_primary) DESC, (field.kind <> 'text') DESC, field.position, field.name_key
    LIMIT 1;
    IF primary_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM vault_item_fields field WHERE field.id = primary_id
        AND (field.name_key = default_primary OR field.kind <> 'text')
    ) THEN
      primary_id := NULL;
    END IF;
  END IF;

  UPDATE vault_items SET
    primary_field_id = primary_id,
    generation = CASE WHEN is_new THEN generation ELSE generation + 1 END,
    updated_at = pg_catalog.now()
  WHERE id = item_row.id
  RETURNING * INTO item_row;

  PERFORM opengeni_private.vault_audit(item_row.account_id, (p_context ->> 'workspaceId')::uuid, subject,
    CASE WHEN is_new THEN 'vault.item.created' ELSE 'vault.item.updated' END,
    'vault_item', item_row.id::text, pg_catalog.jsonb_build_object(
      'vaultId', p_vault.id, 'itemId', item_row.id, 'itemName', item_row.name,
      'fields', changed_fields, 'createdByKind', created_by,
      'sessionId', p_context ->> 'sessionId'));
  RETURN item_row;
END
$$;

-- What a session may use and choose, as the context sees it (SessionSecretsView
-- without `capabilityEnabled`, which the service adds).
CREATE FUNCTION opengeni_private.vault_session_view_json(p_context jsonb, p_session uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  account uuid := (p_context ->> 'accountId')::uuid;
  workspace uuid := (p_context ->> 'workspaceId')::uuid;
  human_context jsonb := p_context || pg_catalog.jsonb_build_object('policyVaultIds', NULL);
  session_row record;
  parent_ids jsonb;
  parent_narrowed uuid;
  own_ids jsonb;
  own_narrowed uuid;
  task_vault vaults;
  reachable jsonb;
  effective jsonb;
BEGIN
  SELECT session_value.id, coalesce(session_value.root_session_id, session_value.id) AS root_id,
      session_value.vault_policy
    INTO session_row
  FROM sessions session_value
  WHERE session_value.id = p_session AND session_value.account_id = account
    AND session_value.workspace_id = workspace;
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'session not found',
      pg_catalog.jsonb_build_object('sessionId', p_session));
  END IF;
  SELECT chain.vault_ids, chain.narrowed_by INTO parent_ids, parent_narrowed
  FROM opengeni_private.vault_session_policy_chain(account, workspace, p_session, false) chain;
  SELECT chain.vault_ids, chain.narrowed_by INTO own_ids, own_narrowed
  FROM opengeni_private.vault_session_policy_chain(account, workspace, p_session, true) chain;
  SELECT vault.* INTO task_vault FROM vaults vault
  WHERE vault.workspace_id = workspace AND vault.owner_kind = 'task'
    AND vault.root_session_id = session_row.root_id;

  SELECT
    coalesce(pg_catalog.jsonb_agg(
      opengeni_private.vault_summary_json(vault, human_context) || pg_catalog.jsonb_build_object(
        'tier', reach.tier,
        'selected', own_ids IS NULL OR own_ids @> pg_catalog.jsonb_build_array(vault.id::text),
        'selectable', parent_ids IS NULL OR parent_ids @> pg_catalog.jsonb_build_array(vault.id::text)
      ) ORDER BY reach.tier, vault.name_key, vault.id
    ), '[]'::jsonb),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(vault.id) ORDER BY reach.tier, vault.name_key, vault.id)
      FILTER (WHERE own_ids IS NULL OR own_ids @> pg_catalog.jsonb_build_array(vault.id::text)), '[]'::jsonb)
    INTO reachable, effective
  FROM opengeni_private.vault_reach(human_context) reach
  JOIN vaults vault ON vault.id = reach.vault_id
  WHERE vault.owner_kind <> 'task';

  IF task_vault.id IS NOT NULL THEN
    effective := pg_catalog.jsonb_build_array(task_vault.id) || effective;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'policy', session_row.vault_policy,
    'effectiveVaultIds', effective,
    'narrowedBySessionId', parent_narrowed,
    'taskVault', CASE WHEN task_vault.id IS NULL THEN NULL
      ELSE opengeni_private.vault_summary_json(task_vault, human_context) END,
    'taskItems', coalesce((
      SELECT pg_catalog.jsonb_agg(opengeni_private.vault_item_json(item, false) ORDER BY item.name_key, item.id)
      FROM vault_items item WHERE item.vault_id = task_vault.id AND item.archived_at IS NULL
    ), '[]'::jsonb),
    'reachableVaults', reachable
  );
END
$$;

-- Items in the given vaults whose current name or alias has this key.
CREATE FUNCTION opengeni_private.vault_items_by_key(p_vault_ids uuid[], p_key text)
RETURNS TABLE (item_id uuid, vault_id uuid, matched_by text)
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT item.id, item.vault_id, 'name'::text FROM vault_items item
  WHERE item.vault_id = ANY (p_vault_ids) AND item.name_key = p_key
  UNION ALL
  SELECT alias.item_id, alias.vault_id, 'alias'::text
  FROM vault_item_name_aliases alias
  JOIN vault_items item ON item.id = alias.item_id AND item.vault_id = alias.vault_id
  WHERE alias.vault_id = ANY (p_vault_ids) AND alias.name_key = p_key
$$;

-- Vaults among the given ones whose current name or alias has this key.
CREATE FUNCTION opengeni_private.vault_vaults_by_key(p_vault_ids uuid[], p_key text)
RETURNS TABLE (vault_id uuid, matched_by text)
LANGUAGE sql STABLE
SET search_path FROM CURRENT
AS $$
  SELECT vault.id, 'name'::text FROM vaults vault
  WHERE vault.id = ANY (p_vault_ids) AND vault.name_key = p_key
  UNION ALL
  SELECT alias.vault_id, 'alias'::text FROM vault_name_aliases alias
  WHERE alias.vault_id = ANY (p_vault_ids) AND alias.name_key = p_key
    AND NOT EXISTS (SELECT 1 FROM vaults vault WHERE vault.id = alias.vault_id AND vault.name_key = p_key)
$$;

-- ---------------------------------------------------------------------------
-- 6. Vault routines (SECURITY DEFINER; called through withRlsContext with the
--    tenant and, for people, the subject GUCs). p_principal NULL means the
--    subject in the GUCs; otherwise a SecretPrincipal object.
-- ---------------------------------------------------------------------------

CREATE FUNCTION list_vaults_for_subject(p_workspace uuid, p_principal jsonb DEFAULT NULL)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal, p_workspace);
  RETURN QUERY
    SELECT opengeni_private.vault_summary_json(vault, context)
      || pg_catalog.jsonb_build_object('tier', reach.tier)
    FROM opengeni_private.vault_reach(context) reach
    JOIN vaults vault ON vault.id = reach.vault_id
    ORDER BY reach.tier, vault.name_key, vault.id;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

CREATE FUNCTION get_vault_for_subject(p_vault uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_vault);
  result := opengeni_private.vault_summary_json(vault_row, context) || pg_catalog.jsonb_build_object(
    'tier', CASE vault_row.owner_kind WHEN 'task' THEN 0 WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

-- p: {name, description?, ownerKind, availability?: {allowedWorkspaceIds, allowPersonalWorkspaces},
--     allowOrganization?: boolean (the caller holds account:admin)}
CREATE FUNCTION create_vault(p jsonb, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  owner_kind text := p ->> 'ownerKind';
  vault_row vaults;
  allowed uuid[];
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  IF owner_kind NOT IN ('user', 'workspace', 'organization') OR owner_kind IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'vaults are created for "user", "workspace" or "organization"');
  END IF;
  IF owner_kind = 'organization' AND NOT coalesce((p ->> 'allowOrganization')::boolean, false) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'organization vaults need account:admin');
  END IF;
  IF owner_kind = 'user' AND NOT coalesce((context ->> 'includeUser')::boolean, false) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'this caller cannot own Only-me vaults');
  END IF;
  IF pg_catalog.jsonb_typeof(p #> '{availability,allowedWorkspaceIds}') = 'array' THEN
    allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
  END IF;
  vault_row := opengeni_private.vault_insert(context, owner_kind, p ->> 'name', p ->> 'description',
    allowed, coalesce((p #>> '{availability,allowPersonalWorkspaces}')::boolean, true), false, NULL);
  result := opengeni_private.vault_summary_json(vault_row, context) || pg_catalog.jsonb_build_object(
    'tier', CASE vault_row.owner_kind WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

-- p: {name?, description? (null clears), availability?, allowOrganization?}
CREATE FUNCTION update_vault(p_id uuid, p_expected_generation bigint, p jsonb, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  new_name text;
  allowed uuid[];
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_id);
  IF vault_row.owner_kind = 'task' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'task vaults cannot be changed');
  END IF;
  IF vault_row.owner_kind = 'organization' AND NOT coalesce((p ->> 'allowOrganization')::boolean, false) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'organization vaults need account:admin');
  END IF;
  IF p_expected_generation IS DISTINCT FROM vault_row.generation THEN
    PERFORM opengeni_private.vault_raise('vault_generation_conflict', 'vault changed since it was read',
      pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'generation', vault_row.generation));
  END IF;
  new_name := coalesce(p ->> 'name', vault_row.name);
  IF new_name IS DISTINCT FROM vault_row.name THEN
    PERFORM opengeni_private.vault_assert_name(new_name, 'Vault');
  END IF;
  IF vault_name_key(new_name) <> vault_row.name_key THEN
    IF EXISTS (
      SELECT 1 FROM vaults vault
      WHERE vault.account_id = vault_row.account_id AND vault.owner_kind = vault_row.owner_kind
        AND vault.id <> vault_row.id AND vault.name_key = vault_name_key(new_name)
        AND (vault_row.owner_kind = 'organization'
          OR (vault_row.owner_kind = 'workspace' AND vault.workspace_id = vault_row.workspace_id)
          OR (vault_row.owner_kind = 'user'
            AND vault.owner_organization_membership_id = vault_row.owner_organization_membership_id))
    ) THEN
      PERFORM opengeni_private.vault_raise('vault_name_conflict', 'a vault with this name already exists',
        pg_catalog.jsonb_build_object('name', new_name));
    END IF;
    INSERT INTO vault_name_aliases (account_id, scope_key, name_key, vault_id)
    VALUES (vault_row.account_id, opengeni_private.vault_owner_scope_key(vault_row), vault_row.name_key, vault_row.id)
    ON CONFLICT (account_id, scope_key, name_key) DO UPDATE
      SET vault_id = EXCLUDED.vault_id, created_at = pg_catalog.now();
    DELETE FROM vault_name_aliases alias
    WHERE alias.vault_id = vault_row.id AND alias.name_key = vault_name_key(new_name);
  END IF;
  IF p ? 'description' AND p ->> 'description' IS NOT NULL
    AND pg_catalog.char_length(p ->> 'description') > 2000 THEN
    PERFORM opengeni_private.vault_raise('invalid_secret_name', 'vault descriptions are at most 2000 characters');
  END IF;
  IF vault_row.owner_kind = 'organization' AND p ? 'availability' THEN
    IF pg_catalog.jsonb_typeof(p #> '{availability,allowedWorkspaceIds}') = 'array' THEN
      allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
    END IF;
  END IF;
  UPDATE vaults SET
    name = new_name,
    description = CASE WHEN p ? 'description' THEN p ->> 'description' ELSE description END,
    allowed_workspace_ids = CASE WHEN owner_kind = 'organization' AND p ? 'availability'
      THEN allowed ELSE allowed_workspace_ids END,
    allow_personal_workspaces = CASE WHEN owner_kind = 'organization' AND p ? 'availability'
      THEN coalesce((p #>> '{availability,allowPersonalWorkspaces}')::boolean, true)
      ELSE allow_personal_workspaces END,
    generation = generation + 1,
    updated_at = pg_catalog.now()
  WHERE id = vault_row.id
  RETURNING * INTO vault_row;
  PERFORM opengeni_private.vault_audit(vault_row.account_id, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.updated', 'vault', vault_row.id::text,
    pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'name', vault_row.name,
      'changed', (SELECT coalesce(pg_catalog.jsonb_agg(key), '[]'::jsonb)
        FROM pg_catalog.jsonb_object_keys(p - 'allowOrganization') key)));
  result := opengeni_private.vault_summary_json(vault_row, context) || pg_catalog.jsonb_build_object(
    'tier', CASE vault_row.owner_kind WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION delete_vault(
  p_id uuid, p_confirm_name text, p_allow_organization boolean DEFAULT false, p_principal jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  removed_items integer;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_id);
  IF vault_row.owner_kind = 'task' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'task vaults are removed with their task');
  END IF;
  IF vault_row.owner_kind = 'organization' AND NOT coalesce(p_allow_organization, false) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'organization vaults need account:admin');
  END IF;
  IF p_confirm_name IS DISTINCT FROM vault_row.name THEN
    PERFORM opengeni_private.vault_raise('invalid_secret_name', 'confirmName must equal the vault name',
      pg_catalog.jsonb_build_object('vaultId', vault_row.id));
  END IF;
  SELECT pg_catalog.count(*) INTO removed_items FROM vault_items item WHERE item.vault_id = vault_row.id;
  DELETE FROM vaults WHERE id = vault_row.id;
  IF vault_row.authority_id IS NOT NULL THEN
    UPDATE organization_user_resource_authorities SET
      status = 'revoked', revoked_at = pg_catalog.clock_timestamp(),
      generation = generation + 1, updated_at = pg_catalog.clock_timestamp()
    WHERE id = vault_row.authority_id AND account_id = vault_row.account_id AND status <> 'revoked';
  END IF;
  PERFORM opengeni_private.vault_audit(vault_row.account_id, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.deleted', 'vault', vault_row.id::text,
    pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'name', vault_row.name,
      'ownerKind', vault_row.owner_kind, 'items', removed_items));
  PERFORM opengeni_private.vault_capability_close();
END
$$;

CREATE FUNCTION ensure_default_vault(p_workspace uuid, p_owner_kind text, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal, p_workspace);
  vault_row := opengeni_private.vault_ensure_default(context, p_owner_kind);
  result := opengeni_private.vault_summary_json(vault_row, context) || pg_catalog.jsonb_build_object(
    'tier', CASE vault_row.owner_kind WHEN 'user' THEN 1 ELSE 2 END);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION ensure_task_vault(p_workspace uuid, p_session uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal, p_workspace);
  vault_row := opengeni_private.vault_ensure_task(context, p_session);
  result := opengeni_private.vault_summary_json(vault_row, context) || pg_catalog.jsonb_build_object('tier', 0);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

-- Keyset pagination: p_cursor = "<name_key>|<item id>". Returns up to p_limit + 1
-- rows so the caller knows whether another page exists.
CREATE FUNCTION list_vault_items(
  p_vault uuid, p_query text, p_type text, p_include_archived boolean, p_cursor text,
  p_limit integer, p_principal jsonb DEFAULT NULL
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  page_size integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  query_key text := nullif(vault_name_key(coalesce(p_query, '')), '');
  cursor_key text;
  cursor_id uuid;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_vault);
  IF nullif(p_cursor, '') IS NOT NULL THEN
    cursor_key := pg_catalog.left(p_cursor, pg_catalog.length(p_cursor) - 37);
    BEGIN
      cursor_id := pg_catalog.right(p_cursor, 36)::uuid;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.vault_raise('vault_item_not_found', 'invalid cursor');
    END;
  END IF;
  RETURN QUERY
    SELECT opengeni_private.vault_item_json(item, false)
    FROM vault_items item
    WHERE item.vault_id = vault_row.id
      AND (coalesce(p_include_archived, false) OR item.archived_at IS NULL)
      AND (p_type IS NULL OR item.type = p_type)
      AND (query_key IS NULL
        OR pg_catalog.strpos(item.name_key, query_key) > 0
        OR EXISTS (SELECT 1 FROM pg_catalog.unnest(item.websites) website
          WHERE pg_catalog.strpos(pg_catalog.lower(website), query_key) > 0))
      AND (cursor_id IS NULL OR (item.name_key, item.id) > (cursor_key, cursor_id))
    ORDER BY item.name_key, item.id
    LIMIT page_size + 1;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

CREATE FUNCTION get_vault_item(p_item uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  item_row vault_items;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  item_row := opengeni_private.vault_reachable_item(context, p_item);
  result := opengeni_private.vault_item_json(item_row, true);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

-- p: vault_write_item input plus {itemId?} (update) or {vaultId, mode?: "create"|"upsert"}.
-- "upsert" updates the non-archived item with that name when one exists.
CREATE FUNCTION upsert_vault_item(p jsonb, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  existing vault_items;
  item_row vault_items;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  IF p ->> 'itemId' IS NOT NULL THEN
    existing := opengeni_private.vault_reachable_item(context, (p ->> 'itemId')::uuid);
    vault_row := opengeni_private.vault_reachable_row(context, existing.vault_id);
  ELSE
    vault_row := opengeni_private.vault_reachable_row(context, (p ->> 'vaultId')::uuid);
    IF p ->> 'mode' = 'upsert' THEN
      SELECT item.* INTO existing FROM vault_items item
      WHERE item.vault_id = vault_row.id AND item.archived_at IS NULL
        AND item.name_key = vault_name_key(p ->> 'name');
    END IF;
  END IF;
  PERFORM opengeni_private.vault_assert_writable(context, vault_row);
  item_row := opengeni_private.vault_write_item(context, vault_row, existing, p);
  result := opengeni_private.vault_item_json(item_row, true)
    || pg_catalog.jsonb_build_object('created', existing.id IS NULL);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION archive_vault_item(p_item uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  item_row vault_items;
  vault_row vaults;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  item_row := opengeni_private.vault_reachable_item(context, p_item);
  vault_row := opengeni_private.vault_reachable_row(context, item_row.vault_id);
  PERFORM opengeni_private.vault_assert_writable(context, vault_row);
  IF item_row.archived_at IS NULL THEN
    UPDATE vault_items SET archived_at = pg_catalog.now(), generation = generation + 1, updated_at = pg_catalog.now()
    WHERE id = item_row.id RETURNING * INTO item_row;
    DELETE FROM vault_passkey_leases WHERE item_id = item_row.id;
    PERFORM opengeni_private.vault_audit(item_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId', 'vault.item.archived', 'vault_item', item_row.id::text,
      pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'itemId', item_row.id, 'itemName', item_row.name,
        'sessionId', context ->> 'sessionId'));
  END IF;
  result := opengeni_private.vault_item_json(item_row, false);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION restore_vault_item(p_item uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  item_row vault_items;
  vault_row vaults;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  item_row := opengeni_private.vault_reachable_item(context, p_item);
  vault_row := opengeni_private.vault_reachable_row(context, item_row.vault_id);
  PERFORM opengeni_private.vault_assert_writable(context, vault_row);
  IF item_row.archived_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM vault_items item WHERE item.vault_id = vault_row.id
      AND item.archived_at IS NULL AND item.name_key = item_row.name_key) THEN
      PERFORM opengeni_private.vault_raise('vault_item_name_conflict',
        'another item now has this name; rename one of them first',
        pg_catalog.jsonb_build_object('name', item_row.name, 'vaultId', vault_row.id));
    END IF;
    UPDATE vault_items SET archived_at = NULL, generation = generation + 1, updated_at = pg_catalog.now()
    WHERE id = item_row.id RETURNING * INTO item_row;
    PERFORM opengeni_private.vault_audit(item_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId', 'vault.item.restored', 'vault_item', item_row.id::text,
      pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'itemId', item_row.id, 'itemName', item_row.name));
  END IF;
  result := opengeni_private.vault_item_json(item_row, true);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION delete_vault_item_permanently(p_item uuid, p_principal jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  item_row vault_items;
  vault_row vaults;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  item_row := opengeni_private.vault_reachable_item(context, p_item);
  vault_row := opengeni_private.vault_reachable_row(context, item_row.vault_id);
  PERFORM opengeni_private.vault_assert_writable(context, vault_row);
  IF item_row.archived_at IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'archive the item before deleting it',
      pg_catalog.jsonb_build_object('itemId', item_row.id));
  END IF;
  DELETE FROM vault_items WHERE id = item_row.id;
  PERFORM opengeni_private.vault_audit(item_row.account_id, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.item.deleted', 'vault_item', item_row.id::text,
    pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'itemId', item_row.id, 'itemName', item_row.name));
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- Move keeps the item ID, fields and history; copy writes a new item with the
-- current version of each field.
CREATE FUNCTION move_vault_item(
  p_item uuid, p_target_vault uuid, p_mode text, p_new_name text, p_principal jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  item_row vault_items;
  source_vault vaults;
  target_vault vaults;
  new_name text;
  item_count integer;
  copy_row vault_items;
  field_row record;
  new_field_id uuid;
  primary_name_key text;
  result jsonb;
  items_limit integer := opengeni_private.vault_limit('itemsPerVault', 2000);
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  IF p_mode NOT IN ('move', 'copy') OR p_mode IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'mode is "move" or "copy"');
  END IF;
  item_row := opengeni_private.vault_reachable_item(context, p_item);
  source_vault := opengeni_private.vault_reachable_row(context, item_row.vault_id);
  target_vault := opengeni_private.vault_reachable_row(context, p_target_vault);
  IF item_row.archived_at IS NOT NULL THEN
    PERFORM opengeni_private.vault_raise('vault_item_not_found', 'item is archived; restore it first',
      pg_catalog.jsonb_build_object('itemId', item_row.id, 'archived', true));
  END IF;
  IF p_mode = 'move' OR source_vault.source <> 'opengeni' THEN
    PERFORM opengeni_private.vault_assert_writable(context, source_vault);
  END IF;
  PERFORM opengeni_private.vault_assert_writable(context, target_vault);
  new_name := coalesce(p_new_name, item_row.name);
  PERFORM opengeni_private.vault_assert_name(new_name, 'Item');
  IF p_mode = 'move' AND target_vault.id = source_vault.id AND vault_name_key(new_name) = item_row.name_key THEN
    result := opengeni_private.vault_item_json(item_row, true);
    PERFORM opengeni_private.vault_capability_close();
    RETURN result;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vault-items:' || target_vault.id::text, 0));
  IF EXISTS (SELECT 1 FROM vault_items item WHERE item.vault_id = target_vault.id
    AND item.archived_at IS NULL AND item.name_key = vault_name_key(new_name)
    AND item.id <> item_row.id) THEN
    PERFORM opengeni_private.vault_raise('vault_item_name_conflict',
      'an item with this name already exists in the target vault',
      pg_catalog.jsonb_build_object('name', new_name, 'vaultId', target_vault.id));
  END IF;
  IF target_vault.id <> source_vault.id OR p_mode = 'copy' THEN
    SELECT pg_catalog.count(*) INTO item_count FROM vault_items item WHERE item.vault_id = target_vault.id;
    IF item_count >= items_limit THEN
      PERFORM opengeni_private.vault_raise('vault_limit_reached',
        'at most ' || items_limit || ' items per vault',
        pg_catalog.jsonb_build_object('limit', items_limit, 'vaultId', target_vault.id));
    END IF;
  END IF;

  IF p_mode = 'move' THEN
    DELETE FROM vault_item_name_aliases alias WHERE alias.item_id = item_row.id;
    DELETE FROM vault_passkey_leases WHERE item_id = item_row.id;
    UPDATE vault_items SET vault_id = target_vault.id, name = new_name,
      generation = generation + 1, updated_at = pg_catalog.now()
    WHERE id = item_row.id RETURNING * INTO item_row;
    PERFORM opengeni_private.vault_audit(item_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId', 'vault.item.moved', 'vault_item', item_row.id::text,
      pg_catalog.jsonb_build_object('itemId', item_row.id, 'itemName', item_row.name,
        'fromVaultId', source_vault.id, 'toVaultId', target_vault.id));
    result := opengeni_private.vault_item_json(item_row, true);
  ELSE
    SELECT field.name_key INTO primary_name_key FROM vault_item_fields field WHERE field.id = item_row.primary_field_id;
    INSERT INTO vault_items (account_id, vault_id, type, name, websites, expires_at, passkey_sign_count, created_by_subject_id)
    VALUES (target_vault.account_id, target_vault.id, item_row.type, new_name, item_row.websites,
      item_row.expires_at, item_row.passkey_sign_count, context ->> 'subjectId')
    RETURNING * INTO copy_row;
    FOR field_row IN
      SELECT field.*, version.value_encrypted
      FROM vault_item_fields field
      JOIN vault_field_versions version ON version.field_id = field.id AND version.version = field.current_version
      WHERE field.item_id = item_row.id
      ORDER BY field.position, field.name_key
    LOOP
      INSERT INTO vault_item_fields (account_id, item_id, name, kind, position, current_version, file_name, file_size)
      VALUES (copy_row.account_id, copy_row.id, field_row.name, field_row.kind, field_row.position, 1,
        field_row.file_name, field_row.file_size)
      RETURNING id INTO new_field_id;
      INSERT INTO vault_field_versions (field_id, version, account_id, value_encrypted, created_by_kind, created_by_subject_id)
      VALUES (new_field_id, 1, copy_row.account_id, field_row.value_encrypted,
        CASE context ->> 'kind' WHEN 'attempt' THEN 'agent' ELSE 'human' END, context ->> 'subjectId');
      IF field_row.name_key = primary_name_key THEN
        UPDATE vault_items SET primary_field_id = new_field_id WHERE id = copy_row.id;
      END IF;
    END LOOP;
    SELECT item.* INTO copy_row FROM vault_items item WHERE item.id = copy_row.id;
    PERFORM opengeni_private.vault_audit(copy_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId', 'vault.item.copied', 'vault_item', copy_row.id::text,
      pg_catalog.jsonb_build_object('itemId', copy_row.id, 'itemName', copy_row.name,
        'sourceItemId', item_row.id, 'fromVaultId', source_vault.id, 'toVaultId', target_vault.id));
    result := opengeni_private.vault_item_json(copy_row, true);
  END IF;
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

-- One field value (ciphertext, or provider refs) and its audit row in the
-- same statement. p_purpose: 'reveal' (human, vault.field.revealed),
-- 'agent_read' (secret_get, vault.secret.read) or 'internal' (no audit; for
-- service-side copies such as fromReference).
CREATE FUNCTION read_vault_field_ciphertext(
  p_field uuid, p_version integer, p_purpose text, p_principal jsonb DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  field_row vault_item_fields;
  item_row vault_items;
  vault_row vaults;
  wanted integer;
  cipher text;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  IF p_purpose NOT IN ('reveal', 'agent_read', 'internal') OR p_purpose IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'unknown read purpose');
  END IF;
  SELECT field.* INTO field_row FROM vault_item_fields field
  WHERE field.id = p_field AND field.account_id = (context ->> 'accountId')::uuid;
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_field_not_found', 'field not found',
      pg_catalog.jsonb_build_object('fieldId', p_field));
  END IF;
  item_row := opengeni_private.vault_reachable_item(context, field_row.item_id);
  SELECT vault.* INTO vault_row FROM vaults vault WHERE vault.id = item_row.vault_id;
  IF field_row.current_version IS NOT NULL THEN
    wanted := coalesce(p_version, field_row.current_version);
    SELECT version.value_encrypted INTO cipher FROM vault_field_versions version
    WHERE version.field_id = field_row.id AND version.version = wanted;
    IF cipher IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_field_not_found', 'version not found',
        pg_catalog.jsonb_build_object('fieldId', p_field, 'version', wanted));
    END IF;
  ELSIF p_version IS NOT NULL THEN
    PERFORM opengeni_private.vault_raise('vault_field_not_found', 'connected fields have no stored versions',
      pg_catalog.jsonb_build_object('fieldId', p_field));
  END IF;
  IF p_purpose <> 'internal' THEN
    PERFORM opengeni_private.vault_audit(item_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId',
      CASE p_purpose WHEN 'reveal' THEN 'vault.field.revealed' ELSE 'vault.secret.read' END,
      'vault_item', item_row.id::text,
      coalesce(p_metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object(
        'vaultId', vault_row.id, 'itemId', item_row.id, 'itemName', item_row.name,
        'fieldId', field_row.id, 'fieldName', field_row.name, 'version', wanted,
        'sessionId', context ->> 'sessionId'));
  END IF;
  result := pg_catalog.jsonb_build_object(
    'valueEncrypted', cipher,
    'version', wanted,
    'currentVersion', field_row.current_version,
    'kind', field_row.kind,
    'fieldId', field_row.id,
    'fieldName', field_row.name,
    'fileName', field_row.file_name,
    'itemId', item_row.id,
    'itemName', item_row.name,
    'itemType', item_row.type,
    'vaultId', vault_row.id,
    'vaultName', vault_row.name,
    'vaultOwnerKind', vault_row.owner_kind,
    'source', vault_row.source,
    'providerConnectionId', vault_row.provider_connection_id,
    'providerVaultRef', vault_row.provider_vault_ref,
    'providerItemRef', item_row.provider_item_ref,
    'providerFieldRef', field_row.provider_field_ref
  );
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION list_vault_field_versions(p_field uuid, p_principal jsonb DEFAULT NULL)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  field_row vault_item_fields;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  SELECT field.* INTO field_row FROM vault_item_fields field
  WHERE field.id = p_field AND field.account_id = (context ->> 'accountId')::uuid;
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_field_not_found', 'field not found',
      pg_catalog.jsonb_build_object('fieldId', p_field));
  END IF;
  PERFORM opengeni_private.vault_reachable_item(context, field_row.item_id);
  RETURN QUERY
    SELECT pg_catalog.jsonb_build_object(
      'version', version.version,
      'current', version.version = field_row.current_version,
      'createdAt', version.created_at,
      'createdByKind', version.created_by_kind,
      'createdBySubjectId', version.created_by_subject_id
    )
    FROM vault_field_versions version
    WHERE version.field_id = field_row.id
    ORDER BY version.version DESC;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- One roundtrip for a whole call (§10B.2). p_refs: [{index, form: "path"|"id",
-- segments?: [..1-3], itemId?, field?, otp, previous}]. The first row is
-- {"meta": true, ...principal facts}; every other row is one candidate. The
-- service picks among candidates (archived, tier, name before alias).
CREATE FUNCTION resolve_secret_reference_candidates(p_principal jsonb, p_refs jsonb)
RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  reach_ids uuid[];
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  IF pg_catalog.jsonb_typeof(p_refs) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_refs) > 500 THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'p_refs must be an array of at most 500 references');
  END IF;
  SELECT coalesce(pg_catalog.array_agg(reach.vault_id), '{}') INTO reach_ids
  FROM opengeni_private.vault_reach(context) reach;
  RETURN NEXT pg_catalog.jsonb_build_object(
    'meta', true,
    'kind', context ->> 'kind',
    'subjectId', context ->> 'subjectId',
    'humanExpected', (context ->> 'humanExpected')::boolean,
    'humanValid', (context ->> 'humanValid')::boolean,
    'hasSecretsUse', (context ->> 'hasSecretsUse')::boolean,
    'agentAllowed', (context ->> 'agentAllowed')::boolean,
    'includeUser', (context ->> 'includeUser')::boolean,
    'includeShared', (context ->> 'includeShared')::boolean,
    'policyVaultIds', context -> 'policyVaultIds',
    'reachableVaultCount', pg_catalog.cardinality(reach_ids)
  );
  RETURN QUERY
  WITH refs AS (
    SELECT (ref ->> 'index')::integer AS ref_index,
      ref ->> 'form' AS form,
      CASE WHEN ref ->> 'form' = 'id' THEN (ref ->> 'itemId')::uuid END AS item_id,
      CASE WHEN pg_catalog.jsonb_typeof(ref -> 'segments') = 'array' THEN ref -> 'segments'
        ELSE '[]'::jsonb END AS segments,
      nullif(ref ->> 'field', '') AS field,
      coalesce((ref ->> 'otp')::boolean, false) AS otp,
      coalesce((ref ->> 'previous')::boolean, false) AS previous
    FROM pg_catalog.jsonb_array_elements(p_refs) ref
  ), shaped AS (
    SELECT refs.*, pg_catalog.jsonb_array_length(refs.segments) AS segment_count FROM refs
  ), base AS (
    SELECT shaped.ref_index, 'item'::text AS interpretation, match.vault_id, match.item_id,
      match.matched_by, NULL::text AS field_name, false AS require_field, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 1
    UNION ALL
    SELECT shaped.ref_index, 'item_field', match.vault_id, match.item_id, match.matched_by,
      shaped.segments ->> 1, true, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 2
    UNION ALL
    SELECT shaped.ref_index, 'vault_item', vault_match.vault_id, match.item_id,
      CASE WHEN vault_match.matched_by = 'name' AND match.matched_by = 'name' THEN 'name' ELSE 'alias' END,
      NULL::text, false, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_vaults_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) vault_match
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(ARRAY[vault_match.vault_id], vault_name_key(shaped.segments ->> 1)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 2
    UNION ALL
    SELECT shaped.ref_index, 'vault_item_field', vault_match.vault_id, match.item_id,
      CASE WHEN vault_match.matched_by = 'name' AND match.matched_by = 'name' THEN 'name' ELSE 'alias' END,
      shaped.segments ->> 2, true, shaped.otp, shaped.previous
    FROM shaped
    CROSS JOIN LATERAL opengeni_private.vault_vaults_by_key(reach_ids, vault_name_key(shaped.segments ->> 0)) vault_match
    CROSS JOIN LATERAL opengeni_private.vault_items_by_key(ARRAY[vault_match.vault_id], vault_name_key(shaped.segments ->> 1)) match
    WHERE shaped.form = 'path' AND shaped.segment_count = 3
    UNION ALL
    SELECT shaped.ref_index, 'id', item.vault_id, item.id, 'id', shaped.field, shaped.field IS NOT NULL,
      shaped.otp, shaped.previous
    FROM shaped
    JOIN vault_items item ON item.id = shaped.item_id AND item.vault_id = ANY (reach_ids)
    WHERE shaped.form = 'id'
  )
  SELECT pg_catalog.jsonb_build_object(
    'refIndex', base.ref_index,
    'interpretation', base.interpretation,
    'tier', CASE vault.owner_kind WHEN 'task' THEN 0 WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END,
    'matchedBy', base.matched_by,
    'vaultId', vault.id,
    'vaultName', vault.name,
    'vaultOwnerKind', vault.owner_kind,
    'source', vault.source,
    'providerConnectionId', vault.provider_connection_id,
    'providerVaultRef', vault.provider_vault_ref,
    'itemId', item.id,
    'itemName', item.name,
    'itemType', item.type,
    'archived', item.archived_at IS NOT NULL,
    'providerItemRef', item.provider_item_ref,
    'fieldId', field.id,
    'fieldName', field.name,
    'fieldKind', field.kind,
    'fileName', field.file_name,
    'providerFieldRef', field.provider_field_ref,
    'currentVersion', field.current_version,
    'version', version.version,
    'valueEncrypted', version.value_encrypted,
    'missing', CASE
      WHEN field.id IS NULL THEN CASE
        WHEN base.field_name IS NOT NULL THEN 'field'
        WHEN base.otp THEN 'totp_field'
        ELSE 'primary_field' END
      WHEN field.current_version IS NOT NULL AND version.version IS NULL THEN
        CASE WHEN base.previous THEN 'previous_version' ELSE 'value' END
    END
  )
  FROM base
  JOIN vault_items item ON item.id = base.item_id
  JOIN vaults vault ON vault.id = base.vault_id
  LEFT JOIN LATERAL (
    SELECT candidate_field.* FROM vault_item_fields candidate_field
    WHERE candidate_field.item_id = item.id AND (
      (base.field_name IS NOT NULL AND candidate_field.name_key = vault_name_key(base.field_name))
      OR (base.field_name IS NULL AND base.otp AND candidate_field.kind = 'totp')
      OR (base.field_name IS NULL AND NOT base.otp AND candidate_field.id = item.primary_field_id)
    )
    ORDER BY candidate_field.position, candidate_field.name_key
    LIMIT 1
  ) field ON true
  LEFT JOIN LATERAL (
    SELECT candidate_version.version, candidate_version.value_encrypted
    FROM vault_field_versions candidate_version
    WHERE candidate_version.field_id = field.id
      AND CASE WHEN base.previous THEN candidate_version.version < field.current_version
        ELSE candidate_version.version = field.current_version END
    ORDER BY candidate_version.version DESC
    LIMIT 1
  ) version ON true
  WHERE NOT base.require_field OR field.id IS NOT NULL
  ORDER BY base.ref_index, base.interpretation, vault.id, item.id;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- One vault.secret.used row per resolution batch; stamps last_used_at.
-- p_use: {surface, toolName, operationId?, sourceCallId?, siteId?};
-- p_items: [{itemId, vaultId, fieldId?, fieldName?, reference}] (no values).
CREATE FUNCTION record_vault_secret_use(p_principal jsonb, p_use jsonb, p_items jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  touched integer;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  UPDATE vault_items item SET last_used_at = pg_catalog.now()
  WHERE item.id IN (
      SELECT (element ->> 'itemId')::uuid FROM pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) element
    )
    AND item.account_id = (context ->> 'accountId')::uuid
    AND item.vault_id IN (SELECT reach.vault_id FROM opengeni_private.vault_reach(context) reach);
  GET DIAGNOSTICS touched = ROW_COUNT;
  PERFORM opengeni_private.vault_audit((context ->> 'accountId')::uuid, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.secret.used', 'vault_item', NULL,
    coalesce(p_use, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'principalKind', context ->> 'kind',
      'sessionId', coalesce(context ->> 'sessionId', p_principal ->> 'sessionId'),
      'turnId', p_principal ->> 'turnId',
      'attemptId', p_principal ->> 'attemptId',
      'siteId', p_principal ->> 'siteId',
      'count', pg_catalog.jsonb_array_length(coalesce(p_items, '[]'::jsonb)),
      'itemsTouched', touched,
      'items', coalesce(p_items, '[]'::jsonb)));
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- A session's own policy must stay inside its parent's effective set. Later
-- parent narrowing applies at resolve time, so children are not rewritten.
CREATE FUNCTION set_session_vault_policy(p_session uuid, p_policy jsonb, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  account uuid;
  workspace uuid;
  parent_ids jsonb;
  parent_narrowed uuid;
  normalized jsonb;
  outside jsonb;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  account := (context ->> 'accountId')::uuid;
  workspace := (context ->> 'workspaceId')::uuid;
  -- sessions is a session-tenancy hot table: take the workspace fence (shared)
  -- before reading the policy chain or updating the row (0345 protocol).
  PERFORM acquire_session_tenancy_fence(workspace);
  IF NOT opengeni_private.vault_policy_is_valid(p_policy) THEN
    PERFORM opengeni_private.vault_raise('vault_policy_outside_parent',
      'policy is {"mode":"all"} or {"mode":"selected","vaultIds":[...]} with at most 200 IDs');
  END IF;
  normalized := CASE WHEN p_policy ->> 'mode' = 'all' THEN '{"mode":"all"}'::jsonb
    ELSE pg_catalog.jsonb_build_object('mode', 'selected', 'vaultIds', coalesce((
      SELECT pg_catalog.jsonb_agg(DISTINCT pg_catalog.lower(element #>> '{}'))
      FROM pg_catalog.jsonb_array_elements(p_policy -> 'vaultIds') element
    ), '[]'::jsonb)) END;
  IF NOT EXISTS (SELECT 1 FROM sessions session_value WHERE session_value.id = p_session
    AND session_value.account_id = account AND session_value.workspace_id = workspace) THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'session not found',
      pg_catalog.jsonb_build_object('sessionId', p_session));
  END IF;
  SELECT chain.vault_ids, chain.narrowed_by INTO parent_ids, parent_narrowed
  FROM opengeni_private.vault_session_policy_chain(account, workspace, p_session, false) chain;
  IF parent_ids IS NOT NULL THEN
    IF normalized ->> 'mode' = 'all' THEN
      PERFORM opengeni_private.vault_raise('vault_policy_outside_parent',
        'a parent session narrows vault access; choose a subset of its vaults',
        pg_catalog.jsonb_build_object('narrowedBySessionId', parent_narrowed, 'allowedVaultIds', parent_ids));
    END IF;
    SELECT coalesce(pg_catalog.jsonb_agg(element), '[]'::jsonb) INTO outside
    FROM pg_catalog.jsonb_array_elements(normalized -> 'vaultIds') element
    WHERE NOT parent_ids @> pg_catalog.jsonb_build_array(element);
    IF pg_catalog.jsonb_array_length(outside) > 0 THEN
      PERFORM opengeni_private.vault_raise('vault_policy_outside_parent',
        'these vaults are outside the parent session''s vaults',
        pg_catalog.jsonb_build_object('narrowedBySessionId', parent_narrowed,
          'outsideVaultIds', outside, 'allowedVaultIds', parent_ids));
    END IF;
  END IF;
  UPDATE sessions SET vault_policy = normalized
  WHERE id = p_session AND account_id = account AND workspace_id = workspace;
  PERFORM opengeni_private.vault_audit(account, workspace, context ->> 'subjectId', 'vault.policy.updated',
    'session', p_session::text, pg_catalog.jsonb_build_object('sessionId', p_session, 'policy', normalized));
  result := opengeni_private.vault_session_view_json(context, p_session);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION session_secrets_view(p_session uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  result := opengeni_private.vault_session_view_json(context, p_session);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

CREATE FUNCTION update_passkey_sign_count(p_item uuid, p_count bigint, p_principal jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  item_row vault_items;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  item_row := opengeni_private.vault_reachable_item(context, p_item);
  IF item_row.type <> 'passkey' THEN
    PERFORM opengeni_private.vault_raise('vault_item_not_found', 'item is not a passkey',
      pg_catalog.jsonb_build_object('itemId', p_item));
  END IF;
  UPDATE vault_items SET
    passkey_sign_count = greatest(passkey_sign_count, coalesce(p_count, 0)),
    last_used_at = pg_catalog.now()
  WHERE id = item_row.id;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- Lease every reachable passkey not held by another live holder.
CREATE FUNCTION lease_vault_passkeys(p_principal jsonb, p_holder text, p_ttl_seconds integer)
RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  IF nullif(pg_catalog.btrim(p_holder), '') IS NULL OR coalesce(p_ttl_seconds, 0) <= 0 THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'a holder and a positive TTL are required');
  END IF;
  RETURN QUERY
    INSERT INTO vault_passkey_leases (item_id, account_id, holder, expires_at)
    SELECT item.id, item.account_id, p_holder,
      pg_catalog.now() + pg_catalog.make_interval(secs => least(p_ttl_seconds, 86400))
    FROM vault_items item
    WHERE item.type = 'passkey' AND item.archived_at IS NULL
      AND item.account_id = (context ->> 'accountId')::uuid
      AND item.vault_id IN (SELECT reach.vault_id FROM opengeni_private.vault_reach(context) reach)
    ON CONFLICT (item_id) DO UPDATE
      SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
      WHERE vault_passkey_leases.holder = EXCLUDED.holder OR vault_passkey_leases.expires_at <= pg_catalog.now()
    RETURNING vault_passkey_leases.item_id;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

CREATE FUNCTION release_vault_passkey_leases(p_holder text, p_principal jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_principal_context(p_principal);
  DELETE FROM vault_passkey_leases lease
  WHERE lease.holder = p_holder AND lease.account_id = (context ->> 'accountId')::uuid;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- Replace a provider vault's item mirror (metadata only, never values).
-- p_items: [{providerItemRef, providerVersion?, type, name, websites?,
--   fields: [{providerFieldRef, name, kind}], primaryFieldRef?}]
CREATE FUNCTION upsert_provider_vault_items(
  p_vault uuid, p_content_version text, p_items jsonb, p_principal jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  item_input jsonb;
  field_input jsonb;
  item_row vault_items;
  base_name text;
  candidate text;
  suffix integer;
  item_type text;
  field_name text;
  field_position integer;
  kept_refs text[] := '{}';
  kept_fields text[];
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_vault);
  IF vault_row.source = 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only connected vaults have a provider mirror');
  END IF;
  kept_refs := ARRAY(SELECT element ->> 'providerItemRef'
    FROM pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) element);
  -- Items gone from the provider free their names before anything is renamed.
  DELETE FROM vault_items item
  WHERE item.vault_id = vault_row.id AND item.provider_item_ref IS NOT NULL
    AND NOT (item.provider_item_ref = ANY (kept_refs));
  -- Names are sticky (references keep working): items already mirrored keep
  -- their "Name" or "Name (n)" first, then new items take the next free suffix.
  FOR item_input IN
    SELECT element FROM pg_catalog.jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
      WITH ORDINALITY AS input(element, ordinal)
    ORDER BY EXISTS (SELECT 1 FROM vault_items mirrored WHERE mirrored.vault_id = vault_row.id
      AND mirrored.provider_item_ref = input.element ->> 'providerItemRef') DESC, input.ordinal
  LOOP
    item_type := CASE WHEN item_input ->> 'type' IN ('login', 'api_key', 'note', 'file')
      THEN item_input ->> 'type' ELSE 'login' END;
    item_row := NULL;
    SELECT item.* INTO item_row FROM vault_items item
    WHERE item.vault_id = vault_row.id AND item.provider_item_ref = item_input ->> 'providerItemRef';
    base_name := opengeni_private.vault_sanitize_legacy_name(item_input ->> 'name');
    IF item_row.id IS NOT NULL
      AND (item_row.name_key = vault_name_key(base_name)
        OR (pg_catalog.left(item_row.name_key, pg_catalog.length(vault_name_key(base_name)) + 2)
              = vault_name_key(base_name) || ' ('
          AND pg_catalog.substr(item_row.name_key, pg_catalog.length(vault_name_key(base_name)) + 3)
              ~ '^[0-9]+\)$'))
      AND NOT EXISTS (SELECT 1 FROM vault_items other WHERE other.vault_id = vault_row.id
        AND other.archived_at IS NULL AND other.name_key = item_row.name_key
        AND other.id <> item_row.id) THEN
      candidate := item_row.name;
    ELSE
      candidate := base_name;
      suffix := 1;
      WHILE EXISTS (SELECT 1 FROM vault_items other WHERE other.vault_id = vault_row.id
        AND other.archived_at IS NULL AND other.name_key = vault_name_key(candidate)
        AND other.id IS DISTINCT FROM item_row.id) LOOP
        suffix := suffix + 1;
        candidate := base_name || ' (' || suffix || ')';
      END LOOP;
    END IF;
    IF item_row.id IS NULL THEN
      INSERT INTO vault_items (account_id, vault_id, type, name, websites, provider_item_ref, provider_version)
      VALUES (vault_row.account_id, vault_row.id, item_type, candidate,
        coalesce(ARRAY(SELECT pg_catalog.jsonb_array_elements_text(coalesce(item_input -> 'websites', '[]'::jsonb))), '{}'),
        item_input ->> 'providerItemRef', item_input ->> 'providerVersion')
      RETURNING * INTO item_row;
    ELSE
      UPDATE vault_items SET type = item_type, name = candidate,
        websites = coalesce(ARRAY(SELECT pg_catalog.jsonb_array_elements_text(coalesce(item_input -> 'websites', '[]'::jsonb))), '{}'),
        provider_version = item_input ->> 'providerVersion', archived_at = NULL,
        generation = CASE WHEN provider_version IS DISTINCT FROM item_input ->> 'providerVersion'
          THEN generation + 1 ELSE generation END,
        updated_at = pg_catalog.now()
      WHERE id = item_row.id RETURNING * INTO item_row;
    END IF;
    kept_fields := '{}';
    field_position := 0;
    FOR field_input IN SELECT element FROM pg_catalog.jsonb_array_elements(coalesce(item_input -> 'fields', '[]'::jsonb)) element LOOP
      field_name := opengeni_private.vault_sanitize_legacy_name(field_input ->> 'name');
      IF vault_name_key(field_name) = 'otp' THEN
        field_name := 'otp code';
      END IF;
      CONTINUE WHEN vault_name_key(field_name) = ANY (kept_fields);
      kept_fields := kept_fields || vault_name_key(field_name);
      INSERT INTO vault_item_fields (account_id, item_id, name, kind, position, current_version, provider_field_ref)
      VALUES (item_row.account_id, item_row.id, field_name,
        CASE WHEN field_input ->> 'kind' IN ('text', 'concealed', 'totp', 'file') THEN field_input ->> 'kind' ELSE 'concealed' END,
        field_position, NULL, field_input ->> 'providerFieldRef')
      ON CONFLICT (item_id, name_key) DO UPDATE SET
        name = EXCLUDED.name, kind = EXCLUDED.kind, position = EXCLUDED.position,
        provider_field_ref = EXCLUDED.provider_field_ref, updated_at = pg_catalog.now();
      field_position := field_position + 1;
    END LOOP;
    DELETE FROM vault_item_fields field WHERE field.item_id = item_row.id AND NOT (field.name_key = ANY (kept_fields));
    UPDATE vault_items SET primary_field_id = (
      SELECT field.id FROM vault_item_fields field WHERE field.item_id = item_row.id
      ORDER BY (field.provider_field_ref = item_input ->> 'primaryFieldRef') DESC NULLS LAST,
        (field.name_key = CASE item_type WHEN 'login' THEN 'password' WHEN 'api_key' THEN 'value'
          WHEN 'note' THEN 'note' ELSE 'file' END) DESC,
        (field.kind <> 'text') DESC, field.position
      LIMIT 1)
    WHERE id = item_row.id;
  END LOOP;
  UPDATE vaults SET provider_content_version = p_content_version, last_synced_at = pg_catalog.now(),
    sync_status = 'ok', sync_error_code = NULL, sync_error_message = NULL, rate_limited_until = NULL,
    updated_at = pg_catalog.now()
  WHERE id = vault_row.id;
  PERFORM opengeni_private.vault_audit(vault_row.account_id, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.provider.synced', 'vault', vault_row.id::text,
    pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'items', pg_catalog.cardinality(kept_refs),
      'contentVersion', p_content_version));
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- p: {status, errorCode?, errorMessage?, rateLimitedUntil?}
CREATE FUNCTION set_vault_sync_status(p_vault uuid, p jsonb, p_principal jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_vault);
  IF vault_row.source = 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only connected vaults sync');
  END IF;
  UPDATE vaults SET
    sync_status = p ->> 'status',
    sync_error_code = p ->> 'errorCode',
    sync_error_message = pg_catalog.left(p ->> 'errorMessage', 2000),
    rate_limited_until = nullif(p ->> 'rateLimitedUntil', '')::timestamptz,
    last_synced_at = CASE WHEN p ->> 'status' = 'ok' THEN pg_catalog.now() ELSE last_synced_at END,
    updated_at = pg_catalog.now()
  WHERE id = vault_row.id;
  IF p ->> 'status' IN ('error', 'auth_expired') THEN
    PERFORM opengeni_private.vault_audit(vault_row.account_id, (context ->> 'workspaceId')::uuid,
      context ->> 'subjectId', 'vault.provider.error', 'vault', vault_row.id::text,
      pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'status', p ->> 'status',
        'errorCode', p ->> 'errorCode'));
  END IF;
  PERFORM opengeni_private.vault_capability_close();
END
$$;

-- ---------------------------------------------------------------------------
-- W5: provider vault links (1Password connections and the embedder host)
-- ---------------------------------------------------------------------------

-- Link a provider vault as an OpenGeni vault (metadata mirror only; values are
-- read live). p: {ownerKind, name, description?, source: 'onepassword'|'host',
-- providerConnectionId? (onepassword), providerVaultRef, mode, availability?,
-- allowOrganization?}. A personal 1Password connection backs only its owner's
-- Only-me vaults; one provider vault is linked at most once per account.
CREATE FUNCTION link_provider_vault(p jsonb, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  owner_kind text := p ->> 'ownerKind';
  link_source text := p ->> 'source';
  link_mode text := coalesce(p ->> 'mode', 'read_only');
  connection_ref uuid := nullif(p ->> 'providerConnectionId', '')::uuid;
  vault_ref text := nullif(pg_catalog.btrim(p ->> 'providerVaultRef'), '');
  connection_row record;
  existing uuid;
  vault_row vaults;
  allowed uuid[];
  result jsonb;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  IF context ->> 'kind' = 'site_viewer' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'Sites cannot link vaults');
  END IF;
  IF owner_kind NOT IN ('user', 'workspace', 'organization') OR owner_kind IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'vaults are linked for "user", "workspace" or "organization"');
  END IF;
  IF owner_kind = 'organization' AND NOT coalesce((p ->> 'allowOrganization')::boolean, false) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'organization vaults need account:admin');
  END IF;
  IF owner_kind = 'user' AND NOT coalesce((context ->> 'includeUser')::boolean, false) THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'this caller cannot own Only-me vaults');
  END IF;
  IF link_source NOT IN ('onepassword', 'host') OR link_source IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only 1Password and host vaults are linked');
  END IF;
  IF link_mode NOT IN ('read_write', 'read_only') THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'mode is read_write or read_only');
  END IF;
  IF vault_ref IS NULL OR pg_catalog.char_length(vault_ref) > 300 THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'a provider vault reference is required');
  END IF;
  IF link_source = 'onepassword' THEN
    SELECT connection.id, connection.subject_id, connection.status INTO connection_row
    FROM connections connection
    WHERE connection.id = connection_ref
      AND connection.account_id = (context ->> 'accountId')::uuid
      AND connection.workspace_id = (context ->> 'workspaceId')::uuid
      AND pg_catalog.lower(connection.provider_domain) = '1password.com';
    IF connection_row.id IS NULL THEN
      PERFORM opengeni_private.vault_raise('vault_not_found', '1Password connection not found');
    END IF;
    IF connection_row.subject_id IS NOT NULL AND (
      owner_kind <> 'user' OR connection_row.subject_id IS DISTINCT FROM context ->> 'subjectId'
    ) THEN
      PERFORM opengeni_private.vault_raise('vault_permission_denied',
        'a personal 1Password connection backs only its owner''s Only-me vaults');
    END IF;
  ELSE
    connection_ref := NULL;
  END IF;
  SELECT vault.id INTO existing FROM vaults vault
  WHERE vault.account_id = (context ->> 'accountId')::uuid
    AND vault.source = link_source
    AND vault.provider_vault_ref = vault_ref
    AND vault.provider_connection_id IS NOT DISTINCT FROM connection_ref
  LIMIT 1;
  IF existing IS NOT NULL THEN
    PERFORM opengeni_private.vault_raise('vault_name_conflict', 'this provider vault is already linked',
      pg_catalog.jsonb_build_object('providerVaultRef', vault_ref));
  END IF;
  IF pg_catalog.jsonb_typeof(p #> '{availability,allowedWorkspaceIds}') = 'array' THEN
    allowed := ARRAY(SELECT pg_catalog.jsonb_array_elements_text(p #> '{availability,allowedWorkspaceIds}')::uuid);
  END IF;
  vault_row := opengeni_private.vault_insert(context, owner_kind, p ->> 'name', p ->> 'description',
    allowed, coalesce((p #>> '{availability,allowPersonalWorkspaces}')::boolean, true), false, NULL);
  UPDATE vaults SET source = link_source, mode = link_mode, provider_connection_id = connection_ref,
    provider_vault_ref = vault_ref, sync_status = 'syncing', updated_at = pg_catalog.now()
  WHERE id = vault_row.id RETURNING * INTO vault_row;
  PERFORM opengeni_private.vault_audit(vault_row.account_id, (context ->> 'workspaceId')::uuid,
    context ->> 'subjectId', 'vault.provider.linked', 'vault', vault_row.id::text,
    pg_catalog.jsonb_build_object('vaultId', vault_row.id, 'source', link_source, 'mode', link_mode,
      'providerConnectionId', connection_ref, 'ownerKind', owner_kind));
  result := opengeni_private.vault_summary_json(vault_row, context) || pg_catalog.jsonb_build_object(
    'tier', CASE vault_row.owner_kind WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END);
  PERFORM opengeni_private.vault_capability_close();
  RETURN result;
END
$$;

-- What a sync needs for one reachable provider vault (never values).
CREATE FUNCTION provider_vault_sync_target(p_vault uuid, p_principal jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_vault);
  IF vault_row.source = 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only connected vaults sync');
  END IF;
  PERFORM opengeni_private.vault_capability_close();
  RETURN pg_catalog.jsonb_build_object(
    'vaultId', vault_row.id,
    'workspaceId', vault_row.workspace_id,
    'source', vault_row.source,
    'mode', vault_row.mode,
    'providerConnectionId', vault_row.provider_connection_id,
    'providerVaultRef', vault_row.provider_vault_ref,
    'providerContentVersion', vault_row.provider_content_version,
    'rateLimitedUntil', vault_row.rate_limited_until);
END
$$;

-- One mirrored item's provider refs, by item id or by provider item ref (for
-- writes through the provider). Raises vault_item_not_found when absent.
CREATE FUNCTION provider_vault_item_ref(
  p_vault uuid, p_item uuid, p_provider_item_ref text, p_principal jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  vault_row vaults;
  item_row vault_items;
BEGIN
  PERFORM opengeni_private.vault_capability_open('read');
  context := opengeni_private.vault_context(p_principal);
  vault_row := opengeni_private.vault_reachable_row(context, p_vault);
  IF vault_row.source = 'opengeni' THEN
    PERFORM opengeni_private.vault_raise('vault_permission_denied', 'only connected vaults have provider items');
  END IF;
  SELECT item.* INTO item_row FROM vault_items item
  WHERE item.vault_id = vault_row.id AND item.provider_item_ref IS NOT NULL
    AND ((p_item IS NOT NULL AND item.id = p_item)
      OR (p_item IS NULL AND item.provider_item_ref = p_provider_item_ref));
  IF item_row.id IS NULL THEN
    PERFORM opengeni_private.vault_raise('vault_item_not_found', 'item not found',
      pg_catalog.jsonb_build_object('vaultId', vault_row.id));
  END IF;
  PERFORM opengeni_private.vault_capability_close();
  RETURN pg_catalog.jsonb_build_object(
    'itemId', item_row.id,
    'providerItemRef', item_row.provider_item_ref,
    'providerVersion', item_row.provider_version,
    'generation', item_row.generation);
END
$$;

-- Secret ask-card answers, written inside the human-input accept transaction
-- (values are encrypted by the caller). p_answers: [{questionId, saveTo?:
-- "user"|"task"|"workspace", vaultId?, item: vault_write_item input with name,
-- type and fields}]. Returns [{questionId, created, item}].
CREATE FUNCTION apply_secret_answers(
  p_session uuid, p_turn uuid, p_answers jsonb, p_principal jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  context jsonb;
  answer jsonb;
  vault_row vaults;
  existing vault_items;
  item_row vault_items;
  results jsonb := '[]'::jsonb;
  acting_human text;
BEGIN
  PERFORM opengeni_private.vault_capability_open('write');
  context := opengeni_private.vault_context(p_principal);
  SELECT coalesce(
      nullif(pg_catalog.btrim(turn_value.initiating_human_subject_id), ''),
      CASE WHEN turn_value.initiator_kind = 'subject'
        THEN nullif(pg_catalog.btrim(turn_value.initiator_subject_id), '') END)
    INTO acting_human
  FROM session_turns turn_value
  WHERE turn_value.id = p_turn AND turn_value.session_id = p_session
    AND turn_value.account_id = (context ->> 'accountId')::uuid
    AND turn_value.workspace_id = (context ->> 'workspaceId')::uuid;
  IF NOT FOUND THEN
    PERFORM opengeni_private.vault_raise('vault_not_found', 'turn not found',
      pg_catalog.jsonb_build_object('sessionId', p_session, 'turnId', p_turn));
  END IF;
  FOR answer IN SELECT element FROM pg_catalog.jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) element LOOP
    IF answer ->> 'vaultId' IS NOT NULL THEN
      vault_row := opengeni_private.vault_reachable_row(context, (answer ->> 'vaultId')::uuid);
    ELSIF coalesce(answer ->> 'saveTo', 'user') = 'task' THEN
      vault_row := opengeni_private.vault_ensure_task(context, p_session);
    ELSE
      -- "Only me" means the person the task acts for: someone else answering
      -- in a shared session would otherwise fill their own Private vault.
      IF coalesce(answer ->> 'saveTo', 'user') = 'user' AND context ->> 'kind' IS DISTINCT FROM 'attempt'
        AND acting_human IS NOT NULL AND acting_human IS DISTINCT FROM context ->> 'subjectId' THEN
        PERFORM opengeni_private.vault_raise('vault_permission_denied',
          'only the person this task works for can save an Only-me answer; save it to the task or the workspace instead');
      END IF;
      vault_row := opengeni_private.vault_ensure_default(context,
        CASE WHEN answer ->> 'saveTo' = 'workspace' THEN 'workspace' ELSE 'user' END);
      -- A narrowed agent answering for a child must stay inside its own policy.
      vault_row := opengeni_private.vault_reachable_row(context, vault_row.id);
    END IF;
    PERFORM opengeni_private.vault_assert_writable(context, vault_row);
    existing := NULL;
    SELECT item.* INTO existing FROM vault_items item
    WHERE item.vault_id = vault_row.id AND item.archived_at IS NULL
      AND item.name_key = vault_name_key(answer #>> '{item,name}');
    item_row := opengeni_private.vault_write_item(context, vault_row, existing,
      (answer -> 'item') - 'expectedGeneration'
        || pg_catalog.jsonb_build_object('createdByKind', 'human'));
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'questionId', answer ->> 'questionId',
      'created', existing.id IS NULL,
      'item', opengeni_private.vault_item_json(item_row, false)));
  END LOOP;
  PERFORM opengeni_private.vault_capability_close();
  RETURN results;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. Pin search paths and grant the application role the public routines
-- ---------------------------------------------------------------------------

DO $vault_routines$
DECLARE
  target_schema text := current_schema();
  routine regprocedure;
BEGIN
  FOR routine IN
    SELECT procedure.oid::regprocedure
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE (
        namespace.nspname = 'opengeni_private'
        AND procedure.proname LIKE 'vault\_%'
        AND procedure.proname NOT IN (
          'vault_name_is_valid', 'vault_sanitize_legacy_name', 'vault_policy_is_valid',
          'vault_authority_capability_active', 'vault_capability_open', 'vault_capability_close',
          'vault_policy_ids', 'vault_policy_intersect'
        )
      ) OR (
        namespace.nspname = target_schema
        AND procedure.proname IN (
          'vault_actor_membership', 'list_vaults_for_subject', 'get_vault_for_subject',
          'create_vault', 'update_vault', 'delete_vault', 'ensure_default_vault', 'ensure_task_vault',
          'list_vault_items', 'get_vault_item', 'upsert_vault_item', 'archive_vault_item',
          'restore_vault_item', 'delete_vault_item_permanently', 'move_vault_item',
          'read_vault_field_ciphertext', 'list_vault_field_versions',
          'resolve_secret_reference_candidates', 'record_vault_secret_use',
          'set_session_vault_policy', 'session_secrets_view', 'update_passkey_sign_count',
          'lease_vault_passkeys', 'release_vault_passkey_leases', 'upsert_provider_vault_items',
          'set_vault_sync_status', 'apply_secret_answers', 'link_provider_vault',
          'provider_vault_sync_target', 'provider_vault_item_ref'
        )
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
      routine, target_schema
    );
  END LOOP;
  FOREACH routine IN ARRAY ARRAY[
    'opengeni_private.vault_name_is_valid(text)',
    'opengeni_private.vault_sanitize_legacy_name(text)',
    'opengeni_private.vault_policy_ids(jsonb)',
    'opengeni_private.vault_policy_intersect(jsonb,jsonb)'
  ]::regprocedure[] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', routine);
  END LOOP;
  -- vault_policy_is_valid backs the sessions and scheduled_tasks CHECK
  -- constraints, so every role that inserts those rows must run it. It is pure.
  GRANT EXECUTE ON FUNCTION opengeni_private.vault_policy_is_valid(jsonb) TO PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    FOREACH routine IN ARRAY ARRAY[
      format('%I.list_vaults_for_subject(uuid,jsonb)', target_schema),
      format('%I.get_vault_for_subject(uuid,jsonb)', target_schema),
      format('%I.create_vault(jsonb,jsonb)', target_schema),
      format('%I.update_vault(uuid,bigint,jsonb,jsonb)', target_schema),
      format('%I.delete_vault(uuid,text,boolean,jsonb)', target_schema),
      format('%I.ensure_default_vault(uuid,text,jsonb)', target_schema),
      format('%I.ensure_task_vault(uuid,uuid,jsonb)', target_schema),
      format('%I.list_vault_items(uuid,text,text,boolean,text,integer,jsonb)', target_schema),
      format('%I.get_vault_item(uuid,jsonb)', target_schema),
      format('%I.upsert_vault_item(jsonb,jsonb)', target_schema),
      format('%I.archive_vault_item(uuid,jsonb)', target_schema),
      format('%I.restore_vault_item(uuid,jsonb)', target_schema),
      format('%I.delete_vault_item_permanently(uuid,jsonb)', target_schema),
      format('%I.move_vault_item(uuid,uuid,text,text,jsonb)', target_schema),
      format('%I.read_vault_field_ciphertext(uuid,integer,text,jsonb,jsonb)', target_schema),
      format('%I.list_vault_field_versions(uuid,jsonb)', target_schema),
      format('%I.resolve_secret_reference_candidates(jsonb,jsonb)', target_schema),
      format('%I.record_vault_secret_use(jsonb,jsonb,jsonb)', target_schema),
      format('%I.set_session_vault_policy(uuid,jsonb,jsonb)', target_schema),
      format('%I.session_secrets_view(uuid,jsonb)', target_schema),
      format('%I.update_passkey_sign_count(uuid,bigint,jsonb)', target_schema),
      format('%I.lease_vault_passkeys(jsonb,text,integer)', target_schema),
      format('%I.release_vault_passkey_leases(text,jsonb)', target_schema),
      format('%I.upsert_provider_vault_items(uuid,text,jsonb,jsonb)', target_schema),
      format('%I.set_vault_sync_status(uuid,jsonb,jsonb)', target_schema),
      format('%I.apply_secret_answers(uuid,uuid,jsonb,jsonb)', target_schema),
      format('%I.link_provider_vault(jsonb,jsonb)', target_schema),
      format('%I.provider_vault_sync_target(uuid,jsonb)', target_schema),
      format('%I.provider_vault_item_ref(uuid,uuid,text,jsonb)', target_schema)
    ]::regprocedure[] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO opengeni_app', routine);
    END LOOP;
    GRANT EXECUTE ON FUNCTION opengeni_private.vault_authority_capability_active(text)
      TO opengeni_app;
    REVOKE ALL ON TABLE opengeni_private.vault_authority_capabilities FROM opengeni_app;
  END IF;
END
$vault_routines$;

-- ===========================================================================
-- §C (W4): remove protected-fill site authentication
-- ===========================================================================
-- Remove protected-fill site authentication. Agents now log in by typing
-- {{secret:...}} references into ordinary browser fill and type actions, so
-- the `connection_fields` and `human` site-auth authorities, the
-- `awaiting_secret` auth-run state, its `pending_fields` column and the
-- `protected_fill` operation kind go away. Only provider-managed
-- (`external_provider`) site-auth connections survive.
--
-- A connection survives only when every configured authority is
-- `external_provider`. Every other connection is deleted with its auth runs,
-- the interventions linked to those runs, and their operation journal rows.
-- Auth runs still waiting for a secret on a surviving connection are deleted
-- the same way. Old releases still write the removed state and kind, so stop
-- every API and worker before applying this migration.

-- The deletes read and write across tenants. Each table below is FORCE row
-- security, so lift it for the owner within this transaction and restore it
-- after the deletes. No advisory fence is taken.
ALTER TABLE "site_auth_connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "auth_runs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_interventions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_resource_operations" NO FORCE ROW LEVEL SECURITY;

WITH removed_connections AS (
  SELECT connection."workspace_id", connection."id"
  FROM "site_auth_connections" AS connection
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(connection."authorities") AS authority(value)
    WHERE authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
  )
),
removed_runs AS (
  SELECT run."workspace_id", run."id"
  FROM "auth_runs" AS run
  WHERE run."state" = 'awaiting_secret'
    OR ("workspace_id", "site_auth_connection_id") IN (SELECT * FROM removed_connections)
),
removed_interventions AS (
  SELECT intervention."workspace_id", intervention."id"
  FROM "interaction_interventions" AS intervention
  WHERE ("workspace_id", "auth_run_id") IN (SELECT * FROM removed_runs)
)
DELETE FROM "interaction_resource_operations" AS operation
WHERE operation."kind" = 'protected_fill'
  OR (
    operation."resource_kind" = 'site_auth_connection'
    AND (operation."workspace_id", operation."resource_id") IN (SELECT * FROM removed_connections)
  )
  OR (
    operation."resource_kind" = 'auth_run'
    AND (operation."workspace_id", operation."resource_id") IN (SELECT * FROM removed_runs)
  )
  OR (
    operation."resource_kind" = 'intervention'
    AND (operation."workspace_id", operation."resource_id") IN (SELECT * FROM removed_interventions)
  );

-- auth_runs.intervention_id and interaction_interventions.auth_run_id both
-- SET NULL on delete, so interventions go first while their runs still exist.
WITH removed_connections AS (
  SELECT connection."workspace_id", connection."id"
  FROM "site_auth_connections" AS connection
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_array_elements(connection."authorities") AS authority(value)
    WHERE authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
  )
),
removed_runs AS (
  SELECT run."workspace_id", run."id"
  FROM "auth_runs" AS run
  WHERE run."state" = 'awaiting_secret'
    OR ("workspace_id", "site_auth_connection_id") IN (SELECT * FROM removed_connections)
)
DELETE FROM "interaction_interventions" AS intervention
WHERE (intervention."workspace_id", intervention."auth_run_id") IN (SELECT * FROM removed_runs);

DELETE FROM "auth_runs" AS run
WHERE run."state" = 'awaiting_secret'
  OR EXISTS (
    SELECT 1
    FROM "site_auth_connections" AS connection,
      jsonb_array_elements(connection."authorities") AS authority(value)
    WHERE connection."workspace_id" = run."workspace_id"
      AND connection."id" = run."site_auth_connection_id"
      AND authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
  );

DELETE FROM "site_auth_connections" AS connection
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(connection."authorities") AS authority(value)
  WHERE authority.value ->> 'kind' IS DISTINCT FROM 'external_provider'
);

ALTER TABLE "site_auth_connections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "auth_runs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_interventions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "interaction_resource_operations" FORCE ROW LEVEL SECURITY;

ALTER TABLE "auth_runs"
  DROP CONSTRAINT "auth_runs_state_check",
  DROP CONSTRAINT "auth_runs_values_check",
  DROP CONSTRAINT "auth_runs_projection_check";

ALTER TABLE "auth_runs" DROP COLUMN "pending_fields";

ALTER TABLE "auth_runs"
  ADD CONSTRAINT "auth_runs_state_check" CHECK (
    "state" IN (
      'discovering', 'awaiting_choice', 'awaiting_external_action',
      'working', 'verified', 'failed', 'cancelled'
    )
  ),
  ADD CONSTRAINT "auth_runs_values_check" CHECK (
    octet_length("target_id") BETWEEN 1 AND 512
    AND octet_length("controller_generation") BETWEEN 1 AND 256
    AND octet_length("target_generation") BETWEEN 1 AND 256
    AND ("document_generation" IS NULL OR octet_length("document_generation") BETWEEN 1 AND 256)
    AND ("method_id" IS NULL OR octet_length("method_id") BETWEEN 1 AND 512)
    AND ("authority_id" IS NULL OR octet_length("authority_id") BETWEEN 1 AND 512)
    AND jsonb_typeof("choices") = 'array'
    AND octet_length("choices"::text) BETWEEN 2 AND 65536
    AND ("external_action" IS NULL OR (
      jsonb_typeof("external_action") = 'object'
      AND octet_length("external_action"::text) BETWEEN 2 AND 65536
    ))
    AND ("verified_url" IS NULL OR octet_length("verified_url") BETWEEN 1 AND 16384)
    AND ("failure_code" IS NULL OR octet_length("failure_code") BETWEEN 1 AND 512)
    AND "version" > 0
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
  ),
  ADD CONSTRAINT "auth_runs_projection_check" CHECK (
    ("state" = 'awaiting_choice') = (jsonb_array_length("choices") > 0)
    AND ("state" = 'awaiting_external_action') = ("external_action" IS NOT NULL)
    AND ("state" = 'failed') = ("failure_code" IS NOT NULL)
  );

ALTER TABLE "interaction_resource_operations"
  DROP CONSTRAINT "interaction_resource_operations_kind_check";

ALTER TABLE "interaction_resource_operations"
  ADD CONSTRAINT "interaction_resource_operations_kind_check"
  CHECK ("kind" IN (
    'create',
    'update',
    'start',
    'report',
    'external_auth',
    'verify',
    'resolve',
    'save'
  ));

-- ===========================================================================
-- §B RETIRE VARIABLE SET VALUES
-- ===========================================================================
-- Env injection is gone: nothing reads variable values any more, and every
-- active value already lives in a vault (checked again below). This section
--   1. removes variable names from persisted sandbox env (session envelopes
--      and lease resume state), so no plaintext copy outlives the set, and
--   2. deletes every variable value, including those of revoked sets.
-- Set header rows, attachments and the set routines stay: scheduled-run
-- admission still fences set ids and generations. A later contract migration
-- drops the tables, columns and routines.

-- Removes `names` from every env map a persisted sandbox entry can carry:
-- sessionState.{manifest,providerState.manifest,providerState,}.environment,
-- at the top level and under each legacy sessionsByAgent.<agent> entry.
CREATE FUNCTION opengeni_private.vault_scrub_entry_environment(p_entry jsonb, p_names text[])
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  result jsonb := p_entry;
  env_path text[];
  target text[];
  agent_key text;
  prefix text[];
  prefixes text[][] := ARRAY[ARRAY['sessionState', '', '']];
BEGIN
  IF p_entry IS NULL OR pg_catalog.jsonb_typeof(p_entry) <> 'object'
    OR p_names IS NULL OR pg_catalog.cardinality(p_names) = 0 THEN
    RETURN p_entry;
  END IF;
  IF pg_catalog.jsonb_typeof(p_entry -> 'sessionsByAgent') = 'object' THEN
    FOR agent_key IN SELECT pg_catalog.jsonb_object_keys(p_entry -> 'sessionsByAgent') LOOP
      prefixes := prefixes || ARRAY[ARRAY['sessionsByAgent', agent_key, 'sessionState']];
    END LOOP;
  END IF;
  FOR i IN 1 .. pg_catalog.array_length(prefixes, 1) LOOP
    prefix := ARRAY(SELECT part FROM pg_catalog.unnest(prefixes[i:i]) part WHERE part <> '');
    FOREACH env_path SLICE 1 IN ARRAY ARRAY[
      ARRAY['manifest', 'environment', ''],
      ARRAY['providerState', 'manifest', 'environment'],
      ARRAY['providerState', 'environment', ''],
      ARRAY['environment', '', '']
    ] LOOP
      target := prefix || ARRAY(SELECT part FROM pg_catalog.unnest(env_path) part WHERE part <> '');
      IF pg_catalog.jsonb_typeof(result #> target) = 'object' THEN
        result := pg_catalog.jsonb_set(result, target, (result #> target) - p_names);
      END IF;
    END LOOP;
  END LOOP;
  RETURN result;
END
$$;

-- Names the platform and the shell own. A variable that shadowed one of them
-- keeps the key in persisted env: removing PATH or HOME would break resume.
CREATE FUNCTION opengeni_private.vault_platform_env_name(p_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT p_name IN ('PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'LANG',
      'LANGUAGE', 'TZ', 'TMPDIR', 'HOSTNAME', 'DISPLAY', 'PYTHONPATH', 'NODE_PATH')
    OR p_name LIKE 'LC\_%' OR p_name LIKE 'OPENGENI\_%' OR p_name LIKE 'XDG\_%'
$$;

ALTER TABLE workspace_variable_sets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_variable_set_variables NO FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_field_versions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_item_fields NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_session_envelopes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_leases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
-- The scrub only removes env keys. Lease guards police archive, billing,
-- checkpoint and provider-create state, none of which change here, so they
-- are switched off for this one statement rather than taught about it.
ALTER TABLE sandbox_leases DISABLE TRIGGER USER;

DO $retire_variable_values$
DECLARE
  missing_copies integer;
  scrubbed_envelopes integer := 0;
  scrubbed_leases integer := 0;
  removed_values integer := 0;
BEGIN
  -- Every value of an active set must have its byte-identical vault copy.
  SELECT pg_catalog.count(*)::integer INTO missing_copies
  FROM workspace_variable_set_variables variable
  JOIN workspace_variable_sets variable_set ON variable_set.id = variable.variable_set_id
  WHERE variable_set.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM vault_item_fields field
      JOIN vault_field_versions version ON version.field_id = field.id
      WHERE field.item_id = variable.id
        AND version.version = variable.version
        AND version.value_encrypted = variable.value_encrypted
    );
  IF missing_copies > 0 THEN
    RAISE EXCEPTION 'variable value retirement aborted: % active values have no vault copy',
      missing_copies;
  END IF;

  -- Values stored under the lossless codec stay valid when keys are removed.
  PERFORM pg_catalog.set_config('opengeni.lossless_content_writer', '1', true);

  WITH names AS (
    SELECT account_id, pg_catalog.array_agg(DISTINCT name) AS names
    FROM workspace_variable_set_variables
    WHERE NOT opengeni_private.vault_platform_env_name(name)
    GROUP BY account_id
  ), changed AS (
    UPDATE sandbox_session_envelopes envelope
    SET envelope = opengeni_private.vault_scrub_entry_environment(envelope.envelope, names.names)
    FROM names
    WHERE names.account_id = envelope.account_id
      AND opengeni_private.vault_scrub_entry_environment(envelope.envelope, names.names)
        IS DISTINCT FROM envelope.envelope
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO scrubbed_envelopes FROM changed;

  WITH names AS (
    SELECT account_id, pg_catalog.array_agg(DISTINCT name) AS names
    FROM workspace_variable_set_variables
    WHERE NOT opengeni_private.vault_platform_env_name(name)
    GROUP BY account_id
  ), changed AS (
    UPDATE sandbox_leases lease
    SET resume_state = opengeni_private.vault_scrub_entry_environment(lease.resume_state, names.names)
    FROM names
    WHERE names.account_id = lease.account_id
      AND opengeni_private.vault_scrub_entry_environment(lease.resume_state, names.names)
        IS DISTINCT FROM lease.resume_state
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO scrubbed_leases FROM changed;

  PERFORM pg_catalog.set_config('opengeni.lossless_content_writer', '', true);

  DELETE FROM workspace_variable_set_variables;
  GET DIAGNOSTICS removed_values = ROW_COUNT;

  INSERT INTO audit_events (account_id, workspace_id, subject_id, action, target_type, metadata)
  VALUES (NULL, NULL, 'system:migration:0739', 'variable_set.values_retired', 'migration',
    pg_catalog.jsonb_build_object(
      'migration', '0739_vaults.sql',
      'removedValues', removed_values,
      'scrubbedEnvelopes', scrubbed_envelopes,
      'scrubbedLeases', scrubbed_leases
    ));
END
$retire_variable_values$;

ALTER TABLE sandbox_leases ENABLE TRIGGER USER;
ALTER TABLE workspace_variable_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_variable_set_variables FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_field_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE vault_item_fields FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_session_envelopes FORCE ROW LEVEL SECURITY;
ALTER TABLE sandbox_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP FUNCTION opengeni_private.vault_scrub_entry_environment(jsonb, text[]);
DROP FUNCTION opengeni_private.vault_platform_env_name(text);
