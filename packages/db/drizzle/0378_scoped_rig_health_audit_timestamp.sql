-- deployment-mode: rolling
-- Repair the already-ledgered scoped Rig health projection so generic audit
-- metadata can never abort a SECURITY DEFINER read. Audit occurrence time is
-- the trusted ordering and display timestamp for audit-backed evidence.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE OR REPLACE FUNCTION scoped_rig_json(p_rig_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', rig.id, 'accountId', rig.account_id, 'workspaceId', rig.workspace_id,
    'scope', rig.authority_scope, 'generation', rig.generation, 'status', rig.status,
    'name', rig.name, 'description', rig.description, 'createdBy', rig.created_by,
    'activeVersion', (
      SELECT pg_catalog.jsonb_build_object(
        'id', version.id, 'rigId', version.rig_id, 'version', version.version,
        'image', version.image, 'setupScript', version.setup_script,
        'checks', version.checks, 'credentialHooks', version.credential_hooks,
        'defaultVariableSetIds', version.default_variable_set_ids,
        'changelog', version.changelog, 'providerImages', version.provider_images,
        'createdBy', version.created_by, 'active', version.active,
        'createdAt', version.created_at
      ) FROM rig_versions version
      WHERE version.rig_id = rig.id AND version.account_id = rig.account_id
        AND version.active = true LIMIT 1
    ),
    'activeVersionHealth', (
      SELECT pg_catalog.jsonb_build_object(
        'checkHealth', coalesce(health.check_health, 'unknown'),
        'lastVerifiedAt', health.verified_at
      )
      FROM rig_versions active_version
      LEFT JOIN LATERAL (
        SELECT candidate.check_health, candidate.verified_at
        FROM (
          SELECT CASE change.verification ->> 'passed'
              WHEN 'true' THEN 'passing' WHEN 'false' THEN 'failing' END AS check_health,
            coalesce(
              nullif(change.verification ->> 'finishedAt', '')::timestamptz,
              change.updated_at
            ) AS verified_at
          FROM rig_changes change
          WHERE change.account_id = active_version.account_id
            AND change.workspace_id = active_version.workspace_id
            AND change.result_version_id = active_version.id
            AND change.verification ->> 'passed' IN ('true', 'false')
          UNION ALL
          SELECT CASE event.action WHEN 'rig.verification.passed' THEN 'passing'
              ELSE 'failing' END,
            event.occurred_at
          FROM audit_events event
          WHERE event.account_id = active_version.account_id
            AND event.workspace_id = active_version.workspace_id
            AND event.target_type = 'rig'
            AND event.target_id = rig.id::text
            AND event.action IN ('rig.verification.passed', 'rig.verification.failed')
            AND event.metadata ->> 'versionId' = active_version.id::text
        ) candidate
        ORDER BY candidate.verified_at DESC
        LIMIT 1
      ) health ON true
      WHERE active_version.rig_id = rig.id
        AND active_version.account_id = rig.account_id
        AND active_version.active = true
      LIMIT 1
    ),
    'versionCount', (SELECT count(*)::integer FROM rig_versions version
      WHERE version.rig_id = rig.id AND version.account_id = rig.account_id),
    'createdAt', rig.created_at, 'updatedAt', rig.updated_at
  ) FROM rigs rig WHERE rig.id = p_rig_id
$$;

REVOKE ALL ON FUNCTION scoped_rig_json(uuid) FROM PUBLIC;

COMMENT ON FUNCTION scoped_rig_json(uuid) IS
  'Access-controlled Rig projection with active-version health from terminal evidence and trusted audit occurrence timestamps.';