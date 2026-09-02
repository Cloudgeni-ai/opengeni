-- deployment-mode: rolling
-- Durable Modal Rig provider-image cleanup obligations. As of 2026-08-31,
-- snapshot creation can outlive the activity process that started it; persist
-- the idempotent request before creation and let replacement workers discover
-- and GC the exact late image.

CREATE TABLE rig_provider_image_cleanup_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  sandbox_group_id uuid NOT NULL,
  source_lease_id uuid NOT NULL,
  source_lease_epoch integer NOT NULL,
  source_instance_id text NOT NULL,
  source_workspace_generation integer NOT NULL,
  provider_backend text NOT NULL,
  provider_binding_key text NOT NULL,
  provider_binding jsonb NOT NULL,
  build_request_id text NOT NULL,
  object_id text,
  state text DEFAULT 'building' NOT NULL,
  delete_after timestamptz,
  delete_attempts integer DEFAULT 0 NOT NULL,
  delete_claim_id uuid,
  delete_claimed_at timestamptz,
  last_delete_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  object_recorded_at timestamptz,
  settled_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT rig_provider_image_cleanup_obligations_source_check CHECK (
    source_lease_epoch >= 0
    AND source_workspace_generation >= 0
    AND octet_length(source_instance_id) BETWEEN 1 AND 512
    AND octet_length(build_request_id) BETWEEN 1 AND 256
  ),
  CONSTRAINT rig_provider_image_cleanup_backend_check CHECK (
    provider_backend = 'modal'
  ),
  CONSTRAINT rig_provider_image_cleanup_binding_shape_check CHECK (
    jsonb_typeof(provider_binding) = 'object'
    AND provider_binding = jsonb_build_object(
      'version', 1,
      'serverUrl', provider_binding ->> 'serverUrl',
      'workspaceName', provider_binding ->> 'workspaceName',
      'environment', provider_binding ->> 'environment'
    )
    AND coalesce(octet_length(provider_binding ->> 'serverUrl'), 0) > 0
    AND coalesce(octet_length(provider_binding ->> 'workspaceName'), 0) > 0
    AND provider_binding ->> 'environment' IS NOT NULL
  ),
  CONSTRAINT rig_provider_image_cleanup_binding_key_check CHECK (
    octet_length(provider_binding_key) BETWEEN 1 AND 1024
    AND provider_binding_key::jsonb = provider_binding
    AND provider_binding_key = format(
      '{"version":1,"serverUrl":%s,"workspaceName":%s,"environment":%s}',
      to_jsonb(provider_binding ->> 'serverUrl')::text,
      to_jsonb(provider_binding ->> 'workspaceName')::text,
      to_jsonb(provider_binding ->> 'environment')::text
    )
  ),
  CONSTRAINT rig_provider_image_cleanup_object_check CHECK (
    object_id IS NULL OR octet_length(object_id) BETWEEN 1 AND 1024
  ),
  CONSTRAINT rig_provider_image_cleanup_obligations_state_check CHECK (
    state IN (
      'building', 'outcome_unknown', 'build_failed', 'delete_pending',
      'deleting', 'delete_failed', 'settled', 'deleted'
    )
    AND ((state IN ('building', 'outcome_unknown', 'build_failed') AND object_id IS NULL)
      OR (state NOT IN ('building', 'outcome_unknown', 'build_failed') AND object_id IS NOT NULL))
  ),
  CONSTRAINT rig_provider_image_cleanup_obligations_delete_claim_check CHECK (
    (state = 'deleting' AND delete_claim_id IS NOT NULL AND delete_claimed_at IS NOT NULL)
    OR (state <> 'deleting' AND delete_claim_id IS NULL AND delete_claimed_at IS NULL)
  )
);

CREATE UNIQUE INDEX rig_provider_image_cleanup_obligations_request_uq
  ON rig_provider_image_cleanup_obligations (
    provider_backend, provider_binding_key, build_request_id, source_instance_id
  );
CREATE INDEX rig_provider_image_cleanup_obligations_source_idx
  ON rig_provider_image_cleanup_obligations (
    workspace_id, source_lease_id, source_instance_id
  );
CREATE INDEX rig_provider_image_cleanup_obligations_gc_idx
  ON rig_provider_image_cleanup_obligations (delete_after, created_at, id)
  WHERE state IN ('delete_pending', 'delete_failed', 'deleting');

ALTER TABLE rig_provider_image_cleanup_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rig_provider_image_cleanup_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON rig_provider_image_cleanup_obligations
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $rig_provider_image_cleanup_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_rig_provider_image_cleanup_obligations(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      id uuid,
      provider_backend text,
      provider_binding_key text,
      provider_binding jsonb,
      build_request_id text,
      object_id text,
      delete_attempts integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_claim_id IS NULL OR p_limit < 1 OR p_limit > 500 OR p_claim_ttl_ms < 1 THEN
        RAISE EXCEPTION 'invalid Rig provider image cleanup claim';
      END IF;

      UPDATE %1$I.rig_provider_image_cleanup_obligations obligation SET
        state = 'settled',
        settled_at = coalesce(obligation.settled_at, pg_catalog.now()),
        delete_after = null,
        delete_claim_id = null,
        delete_claimed_at = null,
        last_delete_error = null,
        updated_at = pg_catalog.now()
      WHERE obligation.object_id IS NOT NULL
        AND obligation.state IN ('delete_pending', 'delete_failed', 'deleting')
        AND EXISTS (
          SELECT 1 FROM %1$I.sandbox_checkpoint_artifacts artifact
          WHERE artifact.provider_backend = obligation.provider_backend
            AND artifact.provider_binding_key = obligation.provider_binding_key
            AND artifact.object_id = obligation.object_id
            AND artifact.state <> 'deleted'
        );

      WITH stale_claims AS MATERIALIZED (
        SELECT obligation.id
        FROM %1$I.rig_provider_image_cleanup_obligations obligation
        WHERE obligation.state = 'deleting'
          AND obligation.delete_claimed_at
            < pg_catalog.now()
              - pg_catalog.make_interval(secs => p_claim_ttl_ms / 1000.0)
        ORDER BY obligation.delete_claimed_at, obligation.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      )
      UPDATE %1$I.rig_provider_image_cleanup_obligations obligation SET
        state = 'delete_failed',
        delete_after = pg_catalog.now(),
        delete_claim_id = null,
        delete_claimed_at = null,
        last_delete_error = coalesce(
          obligation.last_delete_error, 'stale delete claim recovered'
        ),
        updated_at = pg_catalog.now()
      FROM stale_claims
      WHERE obligation.id = stale_claims.id;

      RETURN QUERY
      WITH candidates AS (
        SELECT obligation.id
        FROM %1$I.rig_provider_image_cleanup_obligations obligation
        WHERE obligation.object_id IS NOT NULL
          AND obligation.state IN ('delete_pending', 'delete_failed')
          AND coalesce(obligation.delete_after, obligation.created_at) <= pg_catalog.now()
          AND NOT EXISTS (
            SELECT 1 FROM %1$I.sandbox_checkpoint_artifacts artifact
            WHERE artifact.provider_backend = obligation.provider_backend
              AND artifact.provider_binding_key = obligation.provider_binding_key
              AND artifact.object_id = obligation.object_id
              AND artifact.state <> 'deleted'
          )
        ORDER BY coalesce(obligation.delete_after, obligation.created_at), obligation.id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
      )
      UPDATE %1$I.rig_provider_image_cleanup_obligations obligation SET
        state = 'deleting',
        delete_claim_id = p_claim_id,
        delete_claimed_at = pg_catalog.now(),
        delete_attempts = obligation.delete_attempts + 1,
        updated_at = pg_catalog.now()
      FROM candidates
      WHERE obligation.id = candidates.id
      RETURNING obligation.id, obligation.provider_backend,
        obligation.provider_binding_key, obligation.provider_binding,
        obligation.build_request_id, obligation.object_id,
        obligation.delete_attempts;
    END
    $function$;
  $create$, data_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.settle_rig_provider_image_cleanup_obligation(
      p_id uuid,
      p_claim_id uuid,
      p_deleted boolean,
      p_error text,
      p_retry_after_ms bigint
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE affected integer;
    BEGIN
      IF p_retry_after_ms < 1 THEN
        RAISE EXCEPTION 'invalid Rig provider image cleanup retry';
      END IF;
      UPDATE %1$I.rig_provider_image_cleanup_obligations SET
        state = CASE WHEN p_deleted THEN 'deleted' ELSE 'delete_failed' END,
        delete_after = CASE WHEN p_deleted THEN null
          ELSE pg_catalog.now()
            + pg_catalog.make_interval(secs => p_retry_after_ms / 1000.0) END,
        delete_claim_id = null,
        delete_claimed_at = null,
        last_delete_error = CASE WHEN p_deleted THEN null ELSE left(p_error, 4000) END,
        deleted_at = CASE WHEN p_deleted THEN pg_catalog.now() ELSE null END,
        updated_at = pg_catalog.now()
      WHERE id = p_id AND state = 'deleting' AND delete_claim_id = p_claim_id;
      GET DIAGNOSTICS affected = ROW_COUNT;
      RETURN affected = 1;
    END
    $function$;
  $create$, data_schema);
END
$rig_provider_image_cleanup_functions$;

REVOKE ALL ON FUNCTION opengeni_private.claim_rig_provider_image_cleanup_obligations(uuid, integer, bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.settle_rig_provider_image_cleanup_obligation(uuid, uuid, boolean, text, bigint)
  FROM PUBLIC;

DO $rig_provider_image_cleanup_grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.rig_provider_image_cleanup_obligations TO opengeni_app',
      data_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_rig_provider_image_cleanup_obligations(uuid, integer, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.settle_rig_provider_image_cleanup_obligation(uuid, uuid, boolean, text, bigint)
      TO opengeni_app;
  END IF;
END
$rig_provider_image_cleanup_grants$;