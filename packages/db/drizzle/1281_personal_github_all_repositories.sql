-- deployment-mode: rolling
-- "All my repositories" for Your GitHub (docs/personal-github.md).
--
-- 1. personal_github_repository_selection_heads.all_repositories_access is
--    null (only the selected repositories, as before) or the access every
--    repository the person can reach on GitHub gets ('read' or 'write').
--    The selected rows stay while it is on, so turning it off restores them.
--    The check is added NOT VALID; 1282 validates it.
--    all_repositories_generation is the selection generation at which the
--    mode last changed: work accepted under the mode before then (it was
--    turned off, or its access changed) stays stopped when it is turned on
--    again.
-- 2. get_self_personal_github_repository_selection also returns
--    allRepositoriesAccess and allRepositoriesGeneration. Older binaries
--    ignore the extra keys.
-- 3. mutate_self_personal_github_repository_selection keeps accepting the
--    repository array (the mode is unchanged, as older binaries expect) and
--    also accepts {"repositories": [...], "allRepositoriesAccess": ...},
--    which sets the list and the mode together. A mode change advances the
--    selection generation like any other authority change. The array form's
--    idempotency digest is unchanged, so earlier receipts stay valid.
--
-- Rolling: additive nullable column; signatures, owners, grants and search
-- paths of both routines are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE personal_github_repository_selection_heads
  ADD COLUMN all_repositories_access text;
ALTER TABLE personal_github_repository_selection_heads
  ADD COLUMN all_repositories_generation bigint;
ALTER TABLE personal_github_repository_selection_heads
  ADD CONSTRAINT personal_github_repository_selection_heads_all_access_chk CHECK (
    all_repositories_access IS NULL OR all_repositories_access IN ('read', 'write')
  ) NOT VALID;

DO $install$
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION get_self_personal_github_repository_selection(p_account_id uuid, p_origin_workspace_id uuid, p_owner_subject_id text, p_connection_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog', 'pg_temp'
    AS $_$
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
          'allRepositoriesAccess', NULL,
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
        'allRepositoriesAccess', head_row.all_repositories_access,
        'allRepositoriesGeneration', head_row.all_repositories_generation,
        'repositories', selected_rows
      );
    END
    $_$;
$create$, current_schema());
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION mutate_self_personal_github_repository_selection(p_account_id uuid, p_origin_workspace_id uuid, p_owner_subject_id text, p_connection_id uuid, p_expected_connection_authority_generation bigint, p_expected_selection_generation bigint, p_idempotency_key text, p_repositories jsonb, p_verify_only boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO %1$I, 'pg_catalog', 'pg_temp'
    AS $_$
    DECLARE
      connection_row connections%%ROWTYPE;
      head_row personal_github_repository_selection_heads%%ROWTYPE;
      receipt_row personal_github_repository_selection_operations%%ROWTYPE;
      item jsonb;
      request_digest bytea;
      current_generation bigint;
      next_generation bigint;
      authority_changed boolean;
      v_repositories jsonb;
      v_mode_given boolean := false;
      v_mode text;
      head_found boolean;
      current_mode text;
      mode_generation bigint;
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
      -- The object form sets the repository list and "All my repositories"
      -- together; the array form keeps the current mode.
      IF jsonb_typeof(p_repositories) = 'object' THEN
        IF p_verify_only
          OR p_repositories - ARRAY['repositories','allRepositoriesAccess']::text[] <> '{}'::jsonb
          OR NOT (p_repositories ?& ARRAY['repositories','allRepositoriesAccess'])
          OR jsonb_typeof(p_repositories -> 'allRepositoriesAccess') NOT IN ('string','null')
          OR (jsonb_typeof(p_repositories -> 'allRepositoriesAccess') = 'string'
            AND p_repositories ->> 'allRepositoriesAccess' NOT IN ('read','write'))
        THEN RAISE EXCEPTION 'invalid personal GitHub repository selection'
          USING ERRCODE = '22023';
        END IF;
        v_repositories := p_repositories -> 'repositories';
        v_mode_given := true;
        v_mode := p_repositories ->> 'allRepositoriesAccess';
      ELSE
        v_repositories := p_repositories;
      END IF;
      IF p_expected_connection_authority_generation <= 0
        OR p_expected_selection_generation < 0
        OR octet_length(p_idempotency_key) NOT BETWEEN 1 AND 200
        OR v_repositories IS NULL
        OR jsonb_typeof(v_repositories) <> 'array'
        OR jsonb_array_length(v_repositories) > 100
      THEN RAISE EXCEPTION 'invalid personal GitHub repository selection'
        USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_repositories) selected(value)
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
        SELECT count(*) FROM jsonb_array_elements(v_repositories)
      ) <> (
        SELECT count(DISTINCT value ->> 'repositoryId')
        FROM jsonb_array_elements(v_repositories) selected(value)
      ) OR (
        SELECT count(*) FROM jsonb_array_elements(v_repositories)
      ) <> (
        SELECT count(DISTINCT lower(value ->> 'fullName'))
        FROM jsonb_array_elements(v_repositories) selected(value)
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
      head_found := FOUND;
      current_generation := CASE WHEN head_found THEN head_row.generation ELSE 0 END;
      current_mode := CASE WHEN head_found THEN head_row.all_repositories_access ELSE NULL END;
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
          FROM jsonb_array_elements(v_repositories) incoming(value)
        ), '[]'::jsonb)
      ) || CASE WHEN v_mode_given
        THEN jsonb_build_object('allRepositoriesAccess', coalesce(v_mode, 'none'))
        ELSE '{}'::jsonb END
      )::text, 'UTF8'), 'sha256');
      IF head_found THEN
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
        AND jsonb_array_length(v_repositories) = 0
      THEN
        RETURN get_self_personal_github_repository_selection(
          p_account_id, p_origin_workspace_id, p_owner_subject_id, p_connection_id
        );
      END IF;
      IF p_verify_only AND (
        (SELECT count(*) FROM personal_github_repository_selections selected
          WHERE selected.connection_id = p_connection_id)
          <> jsonb_array_length(v_repositories)
        OR EXISTS (
          SELECT 1 FROM personal_github_repository_selections selected
          WHERE selected.connection_id = p_connection_id
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(v_repositories) incoming(value)
              WHERE incoming.value ->> 'repositoryId' = selected.repository_id::text
                AND incoming.value ->> 'selectedAccess' = selected.selected_access
            )
        )
      ) THEN RAISE EXCEPTION 'personal GitHub verify set changed'
        USING ERRCODE = '40001'; END IF;

      SELECT current_generation = 0
        OR (v_mode_given AND v_mode IS DISTINCT FROM current_mode)
        OR EXISTS (
        (SELECT selected.repository_id::text, selected.canonical_https_uri,
                selected.selected_access
         FROM personal_github_repository_selections selected
         WHERE selected.connection_id = p_connection_id
         EXCEPT
         SELECT value ->> 'repositoryId', value ->> 'canonicalUrl', value ->> 'selectedAccess'
         FROM jsonb_array_elements(v_repositories) incoming(value))
        UNION ALL
        (SELECT value ->> 'repositoryId', value ->> 'canonicalUrl', value ->> 'selectedAccess'
         FROM jsonb_array_elements(v_repositories) incoming(value)
         EXCEPT
         SELECT selected.repository_id::text, selected.canonical_https_uri,
                selected.selected_access
         FROM personal_github_repository_selections selected
         WHERE selected.connection_id = p_connection_id)
      ) INTO authority_changed;
      next_generation := CASE
        WHEN authority_changed THEN current_generation + 1 ELSE current_generation END;
      mode_generation := CASE
        WHEN v_mode_given AND v_mode IS DISTINCT FROM current_mode THEN next_generation
        WHEN head_found THEN head_row.all_repositories_generation
        ELSE NULL END;

      INSERT INTO personal_github_repository_selection_heads (
        connection_id, account_id, origin_workspace_id, owner_subject_id,
        provider_principal_id, credential_binding_id,
        connection_authority_generation, generation, updated_by_subject_id,
        all_repositories_access, all_repositories_generation
      ) VALUES (
        p_connection_id, p_account_id, p_origin_workspace_id, p_owner_subject_id,
        connection_row.metadata ->> 'providerPrincipalId',
        (connection_row.metadata ->> 'credentialBindingId')::uuid,
        connection_row.authority_generation, next_generation, p_owner_subject_id,
        CASE WHEN v_mode_given THEN v_mode ELSE current_mode END, mode_generation
      ) ON CONFLICT (connection_id) DO UPDATE SET
        provider_principal_id = EXCLUDED.provider_principal_id,
        credential_binding_id = EXCLUDED.credential_binding_id,
        connection_authority_generation = EXCLUDED.connection_authority_generation,
        generation = EXCLUDED.generation,
        updated_by_subject_id = EXCLUDED.updated_by_subject_id,
        all_repositories_access = EXCLUDED.all_repositories_access,
        all_repositories_generation = EXCLUDED.all_repositories_generation,
        updated_at = clock_timestamp();

      FOR item IN SELECT value FROM jsonb_array_elements(v_repositories) incoming(value)
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
            SELECT 1 FROM jsonb_array_elements(v_repositories) incoming(value)
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
    $_$;
$create$, current_schema());
END
$install$;
