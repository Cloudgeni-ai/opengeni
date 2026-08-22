-- deployment-mode: rolling
-- Personal GitHub repository discovery is live. Persist only the owner's
-- explicit selected set and monotonic authority facts. Runtime Git and GitHub
-- API execution remain disabled until their separately reviewed consumers land.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE personal_github_repository_selection_heads (
  connection_id uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  origin_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_subject_id text NOT NULL,
  provider_principal_id text NOT NULL,
  credential_binding_id uuid NOT NULL,
  connection_authority_generation bigint NOT NULL,
  generation bigint NOT NULL,
  updated_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT personal_github_repository_selection_heads_tenant_uq
    UNIQUE (account_id, origin_workspace_id, owner_subject_id, connection_id),
  CONSTRAINT personal_github_repository_selection_heads_generation_chk CHECK (
    connection_authority_generation > 0 AND generation > 0
    AND octet_length(owner_subject_id) BETWEEN 1 AND 512
    AND provider_principal_id ~ '^[1-9][0-9]*$'
  )
);
CREATE INDEX personal_github_repository_selection_heads_owner_idx
  ON personal_github_repository_selection_heads(account_id, owner_subject_id, connection_id);

CREATE TABLE personal_github_repository_selections (
  connection_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  origin_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_subject_id text NOT NULL,
  canonical_full_name text NOT NULL,
  canonical_https_uri text NOT NULL,
  default_branch text NOT NULL,
  visibility text NOT NULL,
  private boolean NOT NULL,
  archived boolean NOT NULL,
  disabled boolean NOT NULL,
  permissions jsonb NOT NULL,
  selected_access text NOT NULL,
  selection_generation bigint NOT NULL,
  selected_by_subject_id text NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connection_id, repository_id),
  CONSTRAINT personal_github_repository_selections_head_fk FOREIGN KEY (
    account_id, origin_workspace_id, owner_subject_id, connection_id
  ) REFERENCES personal_github_repository_selection_heads (
    account_id, origin_workspace_id, owner_subject_id, connection_id
  ) ON DELETE CASCADE,
  CONSTRAINT personal_github_repository_selections_shape_chk CHECK (
    repository_id > 0 AND selection_generation > 0
    AND selected_access IN ('read', 'write')
    AND visibility IN ('public', 'private', 'internal')
    AND private = (visibility = 'private')
    AND octet_length(owner_subject_id) BETWEEN 1 AND 512
    AND canonical_full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$'
    AND octet_length(canonical_full_name) BETWEEN 3 AND 140
    AND octet_length(default_branch) BETWEEN 1 AND 255
    AND canonical_https_uri = 'https://github.com/' || canonical_full_name
    AND jsonb_typeof(permissions) = 'object'
    AND permissions ?& ARRAY['pull','push','admin','maintain','triage']
    AND permissions - ARRAY['pull','push','admin','maintain','triage']::text[] = '{}'::jsonb
    AND jsonb_typeof(permissions -> 'pull') = 'boolean'
    AND jsonb_typeof(permissions -> 'push') = 'boolean'
    AND jsonb_typeof(permissions -> 'admin') = 'boolean'
    AND jsonb_typeof(permissions -> 'maintain') = 'boolean'
    AND jsonb_typeof(permissions -> 'triage') = 'boolean'
    AND (
      permissions -> 'pull' = 'true'::jsonb
      OR permissions -> 'push' = 'true'::jsonb
      OR permissions -> 'admin' = 'true'::jsonb
      OR permissions -> 'maintain' = 'true'::jsonb
      OR permissions -> 'triage' = 'true'::jsonb
    )
    AND (selected_access <> 'write' OR (
      NOT archived AND NOT disabled
      AND (
        permissions -> 'push' = 'true'::jsonb
        OR permissions -> 'admin' = 'true'::jsonb
        OR permissions -> 'maintain' = 'true'::jsonb
      )
    ))
  )
);
CREATE INDEX personal_github_repository_selections_tenant_idx
  ON personal_github_repository_selections(account_id, origin_workspace_id, connection_id);

CREATE TABLE personal_github_repository_selection_operations (
  connection_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  account_id uuid NOT NULL,
  origin_workspace_id uuid NOT NULL,
  owner_subject_id text NOT NULL,
  request_digest bytea NOT NULL,
  resulting_generation bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connection_id, idempotency_key),
  CONSTRAINT personal_github_repository_selection_operations_head_fk FOREIGN KEY (
    account_id, origin_workspace_id, owner_subject_id, connection_id
  ) REFERENCES personal_github_repository_selection_heads (
    account_id, origin_workspace_id, owner_subject_id, connection_id
  ) ON DELETE CASCADE,
  CONSTRAINT personal_github_repository_selection_operations_shape_chk CHECK (
    resulting_generation > 0
    AND octet_length(idempotency_key) BETWEEN 1 AND 200
    AND octet_length(owner_subject_id) BETWEEN 1 AND 512
    AND octet_length(request_digest) = 32
  )
);

ALTER TABLE personal_github_repository_selection_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_github_repository_selection_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE personal_github_repository_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_github_repository_selections FORCE ROW LEVEL SECURITY;
ALTER TABLE personal_github_repository_selection_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_github_repository_selection_operations FORCE ROW LEVEL SECURITY;

CREATE POLICY personal_github_repository_selection_heads_owner_isolation
  ON personal_github_repository_selection_heads
  USING (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND origin_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
  ) WITH CHECK (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND origin_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
  );
CREATE POLICY personal_github_repository_selections_owner_isolation
  ON personal_github_repository_selections
  USING (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND origin_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
  ) WITH CHECK (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND origin_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
  );
CREATE POLICY personal_github_repository_selection_operations_owner_isolation
  ON personal_github_repository_selection_operations
  USING (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND origin_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
  ) WITH CHECK (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND origin_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND owner_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
  );

DO $personal_github_repository_functions$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.get_self_personal_github_repository_selection(
      p_account_id uuid,
      p_origin_workspace_id uuid,
      p_owner_subject_id text,
      p_connection_id uuid
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog, pg_temp
    AS $body$
    DECLARE
      connection_row connections%%ROWTYPE;
      head_row personal_github_repository_selection_heads%%ROWTYPE;
      selected_rows jsonb;
    BEGIN
      IF p_account_id IS DISTINCT FROM
          nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_origin_workspace_id IS DISTINCT FROM
          nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_owner_subject_id IS DISTINCT FROM
          nullif(current_setting('opengeni.subject_id', true), '')
      THEN
        RETURN NULL;
      END IF;
      SELECT connection_value.* INTO connection_row
      FROM connections connection_value
      WHERE connection_value.id = p_connection_id
        AND connection_value.account_id = p_account_id
        AND connection_value.origin_workspace_id = p_origin_workspace_id
        AND connection_value.workspace_id = p_origin_workspace_id
        AND connection_value.subject_id = p_owner_subject_id
        AND connection_value.status = 'active'
        AND connection_value.authority_scope = 'user'
        AND connection_value.provider_domain = 'github.com'
        AND connection_value.kind = 'oauth2'
        AND connection_value.granted_scopes = '["repo"]'::jsonb
        AND connection_value.metadata ->> 'credentialRole' = 'opengeni_github_personal'
        AND connection_value.metadata ->> 'providerFamily' = 'github'
        AND connection_value.metadata ->> 'providerPrincipalId' ~ '^[1-9][0-9]*$'
        AND connection_value.metadata ->> 'credentialBindingId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT head.* INTO head_row
      FROM personal_github_repository_selection_heads head
      WHERE head.connection_id = p_connection_id
        AND head.account_id = p_account_id
        AND head.origin_workspace_id = p_origin_workspace_id
        AND head.owner_subject_id = p_owner_subject_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object(
          'connectionAuthorityGeneration', connection_row.authority_generation,
          'credentialBindingId', connection_row.metadata ->> 'credentialBindingId',
          'providerPrincipalId', connection_row.metadata ->> 'providerPrincipalId',
          'selectionGeneration', 0,
          'repositories', '[]'::jsonb
        );
      END IF;
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'repositoryId', selected.repository_id::text,
        'fullName', selected.canonical_full_name,
        'canonicalUrl', selected.canonical_https_uri,
        'defaultBranch', selected.default_branch,
        'visibility', selected.visibility,
        'private', selected.private,
        'archived', selected.archived,
        'disabled', selected.disabled,
        'permissions', selected.permissions,
        'selectedAccess', selected.selected_access,
        'selectionGeneration', selected.selection_generation,
        'selectedAt', selected.selected_at,
        'lastVerifiedAt', selected.verified_at
      ) ORDER BY selected.canonical_full_name, selected.repository_id), '[]'::jsonb)
      INTO selected_rows
      FROM personal_github_repository_selections selected
      WHERE selected.connection_id = p_connection_id
        AND selected.account_id = p_account_id
        AND selected.origin_workspace_id = p_origin_workspace_id
        AND selected.owner_subject_id = p_owner_subject_id;
      RETURN jsonb_build_object(
        'connectionAuthorityGeneration', connection_row.authority_generation,
        'credentialBindingId', head_row.credential_binding_id,
        'providerPrincipalId', head_row.provider_principal_id,
        'selectionGeneration', head_row.generation,
        'repositories', selected_rows
      );
    END
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.mutate_self_personal_github_repository_selection(
      p_account_id uuid,
      p_origin_workspace_id uuid,
      p_owner_subject_id text,
      p_connection_id uuid,
      p_expected_connection_authority_generation bigint,
      p_expected_selection_generation bigint,
      p_idempotency_key text,
      p_repositories jsonb,
      p_verify_only boolean DEFAULT false
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog, pg_temp
    AS $body$
    DECLARE
      connection_row connections%%ROWTYPE;
      head_row personal_github_repository_selection_heads%%ROWTYPE;
      receipt_row personal_github_repository_selection_operations%%ROWTYPE;
      item jsonb;
      request_digest bytea;
      current_generation bigint;
      next_generation bigint;
      authority_changed boolean;
    BEGIN
      IF p_account_id IS DISTINCT FROM
          nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_origin_workspace_id IS DISTINCT FROM
          nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_owner_subject_id IS DISTINCT FROM
          nullif(current_setting('opengeni.subject_id', true), '')
      THEN RAISE EXCEPTION 'personal GitHub repository selection is unavailable'
        USING ERRCODE = '42501';
      END IF;
      IF p_expected_connection_authority_generation <= 0
        OR p_expected_selection_generation < 0
        OR octet_length(p_idempotency_key) NOT BETWEEN 1 AND 200
        OR jsonb_typeof(p_repositories) <> 'array'
        OR jsonb_array_length(p_repositories) > 100
      THEN RAISE EXCEPTION 'invalid personal GitHub repository selection'
        USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_repositories) selected(value)
        WHERE jsonb_typeof(value) <> 'object'
          OR value - ARRAY[
            'repositoryId','fullName','canonicalUrl','defaultBranch','visibility',
            'private','archived','disabled','permissions','selectedAccess','lastVerifiedAt'
          ]::text[] <> '{}'::jsonb
          OR NOT (value ?& ARRAY[
            'repositoryId','fullName','canonicalUrl','defaultBranch','visibility',
            'private','archived','disabled','permissions','selectedAccess','lastVerifiedAt'
          ])
          OR value ->> 'repositoryId' !~ '^[0-9]+$'
          OR (value ->> 'repositoryId')::numeric <= 0
          OR value ->> 'fullName'
            !~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$'
          OR value ->> 'canonicalUrl' IS DISTINCT FROM
            'https://github.com/' || (value ->> 'fullName')
          OR octet_length(value ->> 'defaultBranch') NOT BETWEEN 1 AND 255
          OR value ->> 'visibility' NOT IN ('public','private','internal')
          OR jsonb_typeof(value -> 'private') <> 'boolean'
          OR jsonb_typeof(value -> 'archived') <> 'boolean'
          OR jsonb_typeof(value -> 'disabled') <> 'boolean'
          OR value -> 'private' IS DISTINCT FROM
            to_jsonb((value ->> 'visibility') = 'private')
          OR value ->> 'selectedAccess' NOT IN ('read','write')
          OR jsonb_typeof(value -> 'permissions') <> 'object'
          OR NOT (value -> 'permissions' ?& ARRAY['pull','push','admin','maintain','triage'])
          OR EXISTS (
            SELECT 1 FROM jsonb_each(value -> 'permissions') permission(key, permission_value)
            WHERE key NOT IN ('pull','push','admin','maintain','triage')
              OR jsonb_typeof(permission_value) <> 'boolean'
          )
          OR NOT (
            value -> 'permissions' -> 'pull' = 'true'::jsonb
            OR value -> 'permissions' -> 'push' = 'true'::jsonb
            OR value -> 'permissions' -> 'admin' = 'true'::jsonb
            OR value -> 'permissions' -> 'maintain' = 'true'::jsonb
            OR value -> 'permissions' -> 'triage' = 'true'::jsonb
          )
          OR (
            value ->> 'selectedAccess' = 'write'
            AND (
              value -> 'archived' = 'true'::jsonb
              OR value -> 'disabled' = 'true'::jsonb
              OR NOT (
                value -> 'permissions' -> 'push' = 'true'::jsonb
                OR value -> 'permissions' -> 'admin' = 'true'::jsonb
                OR value -> 'permissions' -> 'maintain' = 'true'::jsonb
              )
            )
          )
          OR (value ->> 'lastVerifiedAt')::timestamptz IS NULL
      ) OR (
        SELECT count(*) FROM jsonb_array_elements(p_repositories)
      ) <> (
        SELECT count(DISTINCT value ->> 'repositoryId')
        FROM jsonb_array_elements(p_repositories) selected(value)
      ) OR (
        SELECT count(*) FROM jsonb_array_elements(p_repositories)
      ) <> (
        SELECT count(DISTINCT lower(value ->> 'fullName'))
        FROM jsonb_array_elements(p_repositories) selected(value)
      )
      THEN RAISE EXCEPTION 'invalid personal GitHub repository selection'
        USING ERRCODE = '22023';
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(
        'personal-github-repositories:' || p_connection_id::text, 0
      ));
      SELECT connection_value.* INTO connection_row
      FROM connections connection_value
      WHERE connection_value.id = p_connection_id
        AND connection_value.account_id = p_account_id
        AND connection_value.origin_workspace_id = p_origin_workspace_id
        AND connection_value.workspace_id = p_origin_workspace_id
        AND connection_value.subject_id = p_owner_subject_id
        AND connection_value.status = 'active'
        AND connection_value.authority_scope = 'user'
        AND connection_value.provider_domain = 'github.com'
        AND connection_value.kind = 'oauth2'
        AND connection_value.granted_scopes = '["repo"]'::jsonb
        AND connection_value.authority_generation = p_expected_connection_authority_generation
        AND connection_value.metadata ->> 'credentialRole' = 'opengeni_github_personal'
        AND connection_value.metadata ->> 'providerFamily' = 'github'
        AND connection_value.metadata ->> 'providerPrincipalId' ~ '^[1-9][0-9]*$'
        AND connection_value.metadata ->> 'credentialBindingId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'personal GitHub repository selection is unavailable'
        USING ERRCODE = '42501'; END IF;

      SELECT head.* INTO head_row
      FROM personal_github_repository_selection_heads head
      WHERE head.connection_id = p_connection_id
      FOR UPDATE;
      current_generation := CASE WHEN FOUND THEN head_row.generation ELSE 0 END;
      request_digest := digest(convert_to(jsonb_build_object(
        'expectedConnectionAuthorityGeneration', p_expected_connection_authority_generation,
        'expectedSelectionGeneration', p_expected_selection_generation,
        'verifyOnly', p_verify_only,
        'repositories', coalesce((
          SELECT jsonb_agg(
            jsonb_build_array(
              value ->> 'repositoryId',
              lower(value ->> 'fullName'),
              value ->> 'selectedAccess'
            ) ORDER BY (value ->> 'repositoryId')::numeric
          )
          FROM jsonb_array_elements(p_repositories) incoming(value)
        ), '[]'::jsonb)
      )::text, 'UTF8'), 'sha256');
      IF FOUND THEN
        SELECT operation.* INTO receipt_row
        FROM personal_github_repository_selection_operations operation
        WHERE operation.connection_id = p_connection_id
          AND operation.idempotency_key = p_idempotency_key;
        IF FOUND THEN
          IF receipt_row.request_digest IS DISTINCT FROM request_digest THEN
            RAISE EXCEPTION 'personal GitHub repository idempotency key was reused'
              USING ERRCODE = '23505';
          END IF;
          IF current_generation IS DISTINCT FROM receipt_row.resulting_generation THEN
            RAISE EXCEPTION 'personal GitHub repository selection changed'
              USING ERRCODE = '40001';
          END IF;
          RETURN get_self_personal_github_repository_selection(
            p_account_id, p_origin_workspace_id, p_owner_subject_id, p_connection_id
          );
        END IF;
      END IF;
      IF current_generation IS DISTINCT FROM p_expected_selection_generation THEN
        RAISE EXCEPTION 'personal GitHub repository selection changed'
          USING ERRCODE = '40001';
      END IF;
      IF p_verify_only AND current_generation = 0
        AND jsonb_array_length(p_repositories) = 0
      THEN
        RETURN get_self_personal_github_repository_selection(
          p_account_id, p_origin_workspace_id, p_owner_subject_id, p_connection_id
        );
      END IF;
      IF p_verify_only AND (
        (SELECT count(*) FROM personal_github_repository_selections selected
          WHERE selected.connection_id = p_connection_id)
          <> jsonb_array_length(p_repositories)
        OR EXISTS (
          SELECT 1 FROM personal_github_repository_selections selected
          WHERE selected.connection_id = p_connection_id
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(p_repositories) incoming(value)
              WHERE incoming.value ->> 'repositoryId' = selected.repository_id::text
                AND incoming.value ->> 'selectedAccess' = selected.selected_access
            )
        )
      ) THEN RAISE EXCEPTION 'personal GitHub verify set changed'
        USING ERRCODE = '40001'; END IF;

      SELECT current_generation = 0 OR EXISTS (
        (SELECT selected.repository_id::text, selected.canonical_https_uri,
                selected.selected_access
         FROM personal_github_repository_selections selected
         WHERE selected.connection_id = p_connection_id
         EXCEPT
         SELECT value ->> 'repositoryId', value ->> 'canonicalUrl', value ->> 'selectedAccess'
         FROM jsonb_array_elements(p_repositories) incoming(value))
        UNION ALL
        (SELECT value ->> 'repositoryId', value ->> 'canonicalUrl', value ->> 'selectedAccess'
         FROM jsonb_array_elements(p_repositories) incoming(value)
         EXCEPT
         SELECT selected.repository_id::text, selected.canonical_https_uri,
                selected.selected_access
         FROM personal_github_repository_selections selected
         WHERE selected.connection_id = p_connection_id)
      ) INTO authority_changed;
      next_generation := CASE
        WHEN authority_changed THEN current_generation + 1 ELSE current_generation END;

      INSERT INTO personal_github_repository_selection_heads (
        connection_id, account_id, origin_workspace_id, owner_subject_id,
        provider_principal_id, credential_binding_id,
        connection_authority_generation, generation, updated_by_subject_id
      ) VALUES (
        p_connection_id, p_account_id, p_origin_workspace_id, p_owner_subject_id,
        connection_row.metadata ->> 'providerPrincipalId',
        (connection_row.metadata ->> 'credentialBindingId')::uuid,
        connection_row.authority_generation, next_generation, p_owner_subject_id
      ) ON CONFLICT (connection_id) DO UPDATE SET
        provider_principal_id = EXCLUDED.provider_principal_id,
        credential_binding_id = EXCLUDED.credential_binding_id,
        connection_authority_generation = EXCLUDED.connection_authority_generation,
        generation = EXCLUDED.generation,
        updated_by_subject_id = EXCLUDED.updated_by_subject_id,
        updated_at = clock_timestamp();

      FOR item IN SELECT value FROM jsonb_array_elements(p_repositories) incoming(value)
      LOOP
        INSERT INTO personal_github_repository_selections (
          connection_id, repository_id, account_id, origin_workspace_id,
          owner_subject_id, canonical_full_name, canonical_https_uri,
          default_branch, visibility, private, archived, disabled, permissions,
          selected_access, selection_generation, selected_by_subject_id,
          selected_at, verified_at, updated_at
        ) VALUES (
          p_connection_id, (item ->> 'repositoryId')::bigint, p_account_id,
          p_origin_workspace_id, p_owner_subject_id, item ->> 'fullName',
          item ->> 'canonicalUrl', item ->> 'defaultBranch', item ->> 'visibility',
          (item ->> 'private')::boolean, (item ->> 'archived')::boolean,
          (item ->> 'disabled')::boolean, item -> 'permissions',
          item ->> 'selectedAccess', next_generation, p_owner_subject_id,
          clock_timestamp(), (item ->> 'lastVerifiedAt')::timestamptz, clock_timestamp()
        ) ON CONFLICT (connection_id, repository_id) DO UPDATE SET
          canonical_full_name = EXCLUDED.canonical_full_name,
          canonical_https_uri = EXCLUDED.canonical_https_uri,
          default_branch = EXCLUDED.default_branch,
          visibility = EXCLUDED.visibility,
          private = EXCLUDED.private,
          archived = EXCLUDED.archived,
          disabled = EXCLUDED.disabled,
          permissions = EXCLUDED.permissions,
          selected_access = EXCLUDED.selected_access,
          selection_generation = CASE
            WHEN personal_github_repository_selections.canonical_https_uri
                  IS DISTINCT FROM EXCLUDED.canonical_https_uri
              OR personal_github_repository_selections.selected_access
                  IS DISTINCT FROM EXCLUDED.selected_access
            THEN next_generation
            ELSE personal_github_repository_selections.selection_generation
          END,
          selected_at = CASE
            WHEN personal_github_repository_selections.canonical_https_uri
                  IS DISTINCT FROM EXCLUDED.canonical_https_uri
              OR personal_github_repository_selections.selected_access
                  IS DISTINCT FROM EXCLUDED.selected_access
            THEN EXCLUDED.selected_at
            ELSE personal_github_repository_selections.selected_at
          END,
          verified_at = EXCLUDED.verified_at,
          updated_at = clock_timestamp();
      END LOOP;
      IF NOT p_verify_only THEN
        DELETE FROM personal_github_repository_selections selected
        WHERE selected.connection_id = p_connection_id
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_repositories) incoming(value)
            WHERE incoming.value ->> 'repositoryId' = selected.repository_id::text
          );
      END IF;
      INSERT INTO personal_github_repository_selection_operations (
        connection_id, idempotency_key, account_id, origin_workspace_id,
        owner_subject_id, request_digest, resulting_generation
      ) VALUES (
        p_connection_id, p_idempotency_key, p_account_id, p_origin_workspace_id,
        p_owner_subject_id, request_digest, next_generation
      );
      RETURN get_self_personal_github_repository_selection(
        p_account_id, p_origin_workspace_id, p_owner_subject_id, p_connection_id
      );
    END
    $body$
  $ddl$, data_schema);
END
$personal_github_repository_functions$;

DO $personal_github_repository_privileges$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.get_self_personal_github_repository_selection('
      || 'uuid,uuid,text,uuid) FROM PUBLIC', data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.mutate_self_personal_github_repository_selection('
      || 'uuid,uuid,text,uuid,bigint,bigint,text,jsonb,boolean) FROM PUBLIC', data_schema
  );
  IF to_regrole('opengeni_app') IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.personal_github_repository_selection_heads, '
        || '%I.personal_github_repository_selections, '
        || '%I.personal_github_repository_selection_operations FROM opengeni_app',
      data_schema, data_schema, data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.get_self_personal_github_repository_selection('
        || 'uuid,uuid,text,uuid) TO opengeni_app', data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.mutate_self_personal_github_repository_selection('
        || 'uuid,uuid,text,uuid,bigint,bigint,text,jsonb,boolean) TO opengeni_app', data_schema
    );
  END IF;
END
$personal_github_repository_privileges$;

COMMENT ON TABLE personal_github_repository_selection_heads IS
  'Owner-only monotonic authority head for an explicit personal GitHub repository set.';
COMMENT ON TABLE personal_github_repository_selections IS
  'Only explicitly selected personal GitHub repositories; never a private discovery catalog.';

-- Scheduled tasks already freeze user-owned connection.use authority in a
-- separate immutable ledger. Admit the dedicated personal-GitHub discriminator
-- into that existing lane; the exact repository set remains in the task's
-- accepted personal_connection_delegations snapshot and execution digest.
ALTER TABLE scheduled_task_connection_authority_snapshots
  DROP CONSTRAINT scheduled_task_connection_authority_shape_chk,
  ADD CONSTRAINT scheduled_task_connection_authority_shape_chk CHECK (
    task_authority_revision > 0
    AND execution_digest ~ '^[0-9a-f]{64}$'
    AND octet_length(server_id) BETWEEN 1 AND 256
    AND connection_generation > 0
    AND (selected_kind IS NULL OR selected_kind IN ('oauth2','api_key','app_install','delegated'))
    AND (connection_type IS NULL OR connection_type IN ('mcp', 'github_personal'))
    AND membership_authorization_revision > 0
    AND authority_generation > 0
    AND grant_generation > 0
    AND grant_mode IN ('once', 'session', 'always')
    AND grant_context IN ('user_private', 'workspace_shared')
    AND grant_context = session_visibility
    AND session_visibility IN ('user_private', 'workspace_shared')
    AND cardinality(selection_sources) > 0
  ) NOT VALID;

ALTER TABLE scheduled_task_connection_authority_snapshots
  VALIDATE CONSTRAINT scheduled_task_connection_authority_shape_chk;

-- Per-occurrence repository-generation revalidation belongs to the scheduled
-- lifecycle phase. Keep the existing run-ledger discriminator unchanged so a
-- task definition can retain explicit personal GitHub authority while every
-- occurrence still fails closed before a provider consumer can run.
