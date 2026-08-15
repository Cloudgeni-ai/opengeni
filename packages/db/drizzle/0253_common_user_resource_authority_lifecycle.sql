-- deployment-mode: rolling
-- Activate generic owner-only user-resource grant lifecycle and
-- correct direct/scheduled personal-resource authority so workspace location
-- and origin are provenance/lifecycle facts, never ownership authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE UNIQUE INDEX IF NOT EXISTS "organization_user_resource_grants_active_identity_uq"
  ON "organization_user_resource_grants" (
    "account_id", "authority_id", "workspace_id", "action", "mode", "context",
    coalesce("session_id", '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce("authority_epoch", 0)
  ) WHERE "status" = 'active';

CREATE OR REPLACE FUNCTION list_self_user_resource_authorities(
  p_account_id uuid
) RETURNS TABLE (
  authority_id uuid, resource_kind text, authority_generation bigint,
  authority_status text, grant_id uuid, target_workspace_id uuid,
  target_session_id uuid, action text, grant_mode text, grant_context text,
  grant_generation bigint, grant_status text, expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource authority scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT membership.id INTO STRICT owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  RETURN QUERY
  SELECT authority.id, authority.resource_kind, authority.generation, authority.status,
    grant_value.id, grant_value.workspace_id, grant_value.session_id,
    grant_value.action, grant_value.mode, grant_value.context,
    grant_value.generation, grant_value.status, grant_value.expires_at
  FROM organization_user_resource_authorities authority
  LEFT JOIN organization_user_resource_grants grant_value
    ON grant_value.account_id = authority.account_id
   AND grant_value.authority_id = authority.id
   AND grant_value.owner_organization_membership_id = owner_membership_id
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
  ORDER BY authority.created_at, authority.id, grant_value.created_at, grant_value.id;
END
$body$;

CREATE OR REPLACE FUNCTION issue_self_user_resource_grant(
  p_account_id uuid,
  p_authority_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_mode text,
  p_context text,
  p_session_id uuid DEFAULT NULL,
  p_workspace_shared_acknowledged boolean DEFAULT false
) RETURNS TABLE (
  grant_id uuid, target_workspace_id uuid, target_session_id uuid,
  action text, grant_mode text, grant_context text, grant_generation bigint,
  grant_status text, expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
  target_epoch integer;
  target_visibility text;
  normalized_action text := lower(btrim(p_action));
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource grant scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('once', 'session', 'always')
    OR p_context NOT IN ('user_private', 'workspace_shared')
    OR normalized_action = '' OR length(normalized_action) > 64
    OR normalized_action !~ '^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$'
  THEN
    RAISE EXCEPTION 'invalid user-resource grant request' USING ERRCODE = '22023';
  END IF;
  IF p_context = 'workspace_shared' AND NOT p_workspace_shared_acknowledged THEN
    RAISE EXCEPTION 'workspace_shared requires durable shared-output acknowledgement'
      USING ERRCODE = '42501';
  END IF;
  IF (p_mode = 'always' AND p_session_id IS NOT NULL)
    OR (p_mode IN ('once', 'session') AND p_session_id IS NULL)
  THEN
    RAISE EXCEPTION 'user-resource grant session fence is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT membership.id INTO STRICT owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.id = p_authority_id
    AND authority.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active self-owned user-resource authority required' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.id = p_workspace_id AND workspace_value.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'target workspace is outside the organization' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM organization_memberships membership
  WHERE membership.id = owner_membership_id
    AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = caller_subject
    ));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner lacks current target-workspace access' USING ERRCODE = '42501';
  END IF;

  IF p_session_id IS NOT NULL THEN
    SELECT session_value.authority_epoch, session_value.visibility
      INTO STRICT target_epoch, target_visibility
    FROM sessions session_value
    WHERE session_value.id = p_session_id
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    IF target_visibility IS DISTINCT FROM p_context THEN
      RAISE EXCEPTION 'grant context does not match current session visibility'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO organization_user_resource_grants (
    account_id, authority_id, owner_organization_membership_id, workspace_id,
    session_id, action, mode, context, authority_epoch, generation, status
  ) VALUES (
    p_account_id, p_authority_id, owner_membership_id, p_workspace_id,
    p_session_id, normalized_action, p_mode, p_context, target_epoch, 1, 'active'
  )
  ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
    (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce(authority_epoch, 0))) WHERE status = 'active'
  DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
  RETURNING id, workspace_id, session_id, organization_user_resource_grants.action,
    mode, context, generation, status, organization_user_resource_grants.expires_at
  INTO grant_id, target_workspace_id, target_session_id, action, grant_mode,
    grant_context, grant_generation, grant_status, expires_at;
  RETURN NEXT;
END
$body$;

CREATE OR REPLACE FUNCTION revoke_self_user_resource_grant(
  p_account_id uuid,
  p_grant_id uuid
) RETURNS TABLE (
  grant_id uuid, grant_generation bigint, grant_status text, revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  owner_membership_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR caller_subject IS NULL
  THEN
    RAISE EXCEPTION 'user-resource revoke scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT membership.id INTO STRICT owner_membership_id
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  UPDATE organization_user_resource_grants grant_value
  SET status = 'revoked', revoked_at = clock_timestamp(),
      generation = grant_value.generation + 1, updated_at = clock_timestamp()
  FROM organization_user_resource_authorities authority
  WHERE grant_value.id = p_grant_id
    AND grant_value.account_id = p_account_id
    AND authority.id = grant_value.authority_id
    AND authority.account_id = grant_value.account_id
    AND authority.organization_membership_id = owner_membership_id
    AND grant_value.owner_organization_membership_id = owner_membership_id
    AND grant_value.status <> 'revoked'
  RETURNING grant_value.id, grant_value.generation, grant_value.status, grant_value.revoked_at
  INTO grant_id, grant_generation, grant_status, revoked_at;
  IF FOUND THEN RETURN NEXT; RETURN; END IF;

  SELECT grant_value.id, grant_value.generation, grant_value.status, grant_value.revoked_at
    INTO grant_id, grant_generation, grant_status, revoked_at
  FROM organization_user_resource_grants grant_value
  JOIN organization_user_resource_authorities authority
    ON authority.id = grant_value.authority_id AND authority.account_id = grant_value.account_id
  WHERE grant_value.id = p_grant_id
    AND grant_value.account_id = p_account_id
    AND authority.organization_membership_id = owner_membership_id
    AND grant_value.owner_organization_membership_id = owner_membership_id
    AND grant_value.status = 'revoked';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'self-owned user-resource grant not found' USING ERRCODE = '42501';
  END IF;
  RETURN NEXT;
END
$body$;

REVOKE ALL ON FUNCTION list_self_user_resource_authorities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_self_user_resource_grant(uuid, uuid, uuid, text, text, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_self_user_resource_grant(uuid, uuid) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION list_self_user_resource_authorities(uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION issue_self_user_resource_grant(uuid, uuid, uuid, text, text, text, uuid, boolean) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION revoke_self_user_resource_grant(uuid, uuid) TO opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$grants$;

CREATE OR REPLACE FUNCTION authorize_session_attempt_personal_resource_reads(
  p_account_id uuid,
  p_workspace_id uuid,
  p_attempt_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  personal_count integer;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'personal-resource read scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT count(*)::integer INTO personal_count
  FROM session_turn_attempts attempt
  JOIN sessions session_value
    ON session_value.id = attempt.session_id
   AND session_value.account_id = attempt.account_id
   AND session_value.workspace_id = attempt.workspace_id
  LEFT JOIN workspace_variable_sets variable_set
    ON variable_set.id = session_value.variable_set_id
   AND variable_set.account_id = session_value.account_id
   AND variable_set.authority_scope = 'user'
  LEFT JOIN rigs rig
    ON rig.id = session_value.rig_id
   AND rig.account_id = session_value.account_id
   AND rig.authority_scope = 'user'
  LEFT JOIN rig_versions rig_version
    ON rig_version.id = session_value.rig_version_id
   AND rig_version.rig_id = session_value.rig_id
   AND rig_version.account_id = session_value.account_id
  LEFT JOIN LATERAL jsonb_array_elements_text(
    coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
  ) default_id(value) ON true
  LEFT JOIN workspace_variable_sets default_variable_set
    ON default_variable_set.id = default_id.value::uuid
   AND default_variable_set.account_id = session_value.account_id
   AND default_variable_set.authority_scope = 'user'
  WHERE attempt.id = p_attempt_id
    AND attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND (variable_set.id IS NOT NULL OR rig.id IS NOT NULL OR default_variable_set.id IS NOT NULL);
  IF personal_count = 0 THEN RETURN; END IF;
  PERFORM * FROM resolve_session_attempt_personal_resources(
    p_account_id, p_workspace_id, p_attempt_id
  );
END
$body$;

REVOKE ALL ON FUNCTION authorize_session_attempt_personal_resource_reads(uuid, uuid, uuid)
  FROM PUBLIC;
DO $read_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      authorize_session_attempt_personal_resource_reads(uuid, uuid, uuid)
      TO opengeni_app;
  END IF;
END
$read_grant$;

DO $personal_resource_delegation_authority_correction$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.admit_session_attempt_personal_resources()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      session_row sessions%%ROWTYPE;
      turn_row session_turns%%ROWTYPE;
      member_row organization_memberships%%ROWTYPE;
      resource_row record;
      grant_row organization_user_resource_grants%%ROWTYPE;
      resource_total integer := 0;
      snapshot_total integer := 0;
      initiating_subject text;
      affected integer;
    BEGIN
      INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'admit')
      ON CONFLICT DO NOTHING;

      SELECT session_value.* INTO STRICT session_row
      FROM sessions session_value
      WHERE session_value.id = NEW.session_id
        AND session_value.account_id = NEW.account_id
        AND session_value.workspace_id = NEW.workspace_id
      FOR SHARE;

      SELECT turn_value.* INTO STRICT turn_row
      FROM session_turns turn_value
      WHERE turn_value.id = NEW.turn_id
        AND turn_value.account_id = NEW.account_id
        AND turn_value.workspace_id = NEW.workspace_id
        AND turn_value.session_id = NEW.session_id
      FOR SHARE;

      SELECT count(*)::integer INTO resource_total
      FROM (
        SELECT DISTINCT selected.resource_kind, selected.resource_id
        FROM (
        SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id
        FROM workspace_variable_sets variable_set
        WHERE variable_set.id = session_row.variable_set_id
          AND variable_set.account_id = NEW.account_id
          AND variable_set.authority_scope = 'user'
        UNION ALL
        SELECT 'rig'::text, rig.id
        FROM rigs rig
        WHERE rig.id = session_row.rig_id
          AND rig.account_id = NEW.account_id
          AND rig.authority_scope = 'user'
        UNION ALL
        SELECT 'variable_set'::text, default_variable_set.id
        FROM rig_versions rig_version
        CROSS JOIN LATERAL jsonb_array_elements_text(
          rig_version.default_variable_set_ids
        ) default_id(value)
        JOIN workspace_variable_sets default_variable_set
          ON default_variable_set.id = default_id.value::uuid
         AND default_variable_set.account_id = NEW.account_id
         AND default_variable_set.authority_scope = 'user'
        WHERE rig_version.id = session_row.rig_version_id
          AND rig_version.rig_id = session_row.rig_id
          AND rig_version.account_id = NEW.account_id
        ) selected
      ) selected_personal_resources;

      IF resource_total = 0 THEN
        DELETE FROM opengeni_private.personal_resource_delegation_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN NEW;
      END IF;

      IF NEW.execution_generation <= 0
        OR NEW.state NOT IN ('claimed', 'running')
        OR NEW.closed_at IS NOT NULL
        OR NEW.quiesced_at IS NOT NULL
        OR session_row.active_turn_id IS DISTINCT FROM NEW.turn_id
        OR turn_row.active_attempt_id IS DISTINCT FROM NEW.id
        OR turn_row.execution_generation IS DISTINCT FROM NEW.execution_generation
        OR turn_row.status <> 'running'
        OR EXISTS (
          SELECT 1
          FROM session_attempt_interruptions interruption
          WHERE interruption.account_id = NEW.account_id
            AND interruption.workspace_id = NEW.workspace_id
            AND interruption.session_id = NEW.session_id
            AND interruption.attempt_id = NEW.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      THEN
        RAISE EXCEPTION 'personal-resource admission requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.authority_visibility IS DISTINCT FROM session_row.visibility
        OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch
        OR NEW.authority_owner_organization_membership_id
          IS DISTINCT FROM session_row.owner_organization_membership_id
      THEN
        RAISE EXCEPTION 'personal-resource admission requires the exact session authority'
          USING ERRCODE = '42501';
      END IF;

      initiating_subject := coalesce(
        nullif(btrim(turn_row.initiating_human_subject_id), ''),
        CASE WHEN turn_row.initiator_kind = 'subject'
          THEN nullif(btrim(turn_row.initiator_subject_id), '') END
      );
      IF initiating_subject IS NULL THEN
        RAISE EXCEPTION 'personal-resource admission requires an initiating human subject'
          USING ERRCODE = '42501';
      END IF;

      SELECT membership.* INTO STRICT member_row
      FROM organization_memberships membership
      WHERE membership.account_id = NEW.account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;

      IF member_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id THEN
        PERFORM 1
        FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = NEW.account_id
          AND workspace_membership.workspace_id = NEW.workspace_id
          AND workspace_membership.subject_id = initiating_subject
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'initiating human lacks target-workspace membership'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      INSERT INTO session_attempt_personal_resource_admissions (
        attempt_id, account_id, workspace_id, session_id, turn_id,
        execution_generation, initiating_human_subject_id,
        owner_organization_membership_id, membership_authorization_revision,
        session_visibility, session_authority_epoch, resource_count
      ) VALUES (
        NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
        NEW.execution_generation, initiating_subject, member_row.id,
        member_row.authorization_revision, session_row.visibility,
        session_row.authority_epoch, resource_total
      );

      FOR resource_row IN
        WITH selected AS (
          SELECT
            'variable_set'::text AS resource_kind,
            variable_set.id AS resource_id,
            NULL::uuid AS resource_version_id,
            'variable_set.use'::text AS action,
            'session_variable_set'::text AS selection_source,
            variable_set.workspace_id AS resource_workspace_id,
            variable_set.authority_id,
            variable_set.owner_organization_membership_id,
            variable_set.origin_workspace_id
          FROM workspace_variable_sets variable_set
          WHERE variable_set.id = session_row.variable_set_id
            AND variable_set.account_id = NEW.account_id
            AND variable_set.authority_scope = 'user'
          UNION ALL
          SELECT
            'rig'::text, rig.id, session_row.rig_version_id, 'rig.use'::text,
            'session_rig'::text, rig.workspace_id, rig.authority_id,
            rig.owner_organization_membership_id, rig.origin_workspace_id
          FROM rigs rig
          WHERE rig.id = session_row.rig_id
            AND rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
          UNION ALL
          SELECT
            'variable_set'::text, default_variable_set.id, NULL::uuid,
            'variable_set.use'::text,
            ('rig_default_variable_set:' || default_id.ordinality::text)::text,
            default_variable_set.workspace_id, default_variable_set.authority_id,
            default_variable_set.owner_organization_membership_id,
            default_variable_set.origin_workspace_id
          FROM rig_versions rig_version
          CROSS JOIN LATERAL jsonb_array_elements_text(
            rig_version.default_variable_set_ids
          ) WITH ORDINALITY default_id(value, ordinality)
          JOIN workspace_variable_sets default_variable_set
            ON default_variable_set.id = default_id.value::uuid
           AND default_variable_set.account_id = NEW.account_id
           AND default_variable_set.authority_scope = 'user'
          WHERE rig_version.id = session_row.rig_version_id
            AND rig_version.rig_id = session_row.rig_id
            AND rig_version.account_id = NEW.account_id
        )
        SELECT resource_kind, resource_id,
          min(resource_version_id::text)::uuid AS resource_version_id,
          action, array_agg(selection_source ORDER BY selection_source) AS selection_sources,
          min(resource_workspace_id::text)::uuid AS resource_workspace_id,
          min(authority_id::text)::uuid AS authority_id,
          min(owner_organization_membership_id::text)::uuid
            AS owner_organization_membership_id,
          min(origin_workspace_id::text)::uuid AS origin_workspace_id
        FROM selected
        GROUP BY resource_kind, resource_id, action
        ORDER BY resource_kind, resource_id
      LOOP
        IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
        THEN
          RAISE EXCEPTION 'personal resource owner/origin does not match initiating membership'
            USING ERRCODE = '42501';
        END IF;

        IF resource_row.resource_kind = 'variable_set' THEN
          PERFORM 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.id = resource_row.resource_id
            AND variable_set.account_id = NEW.account_id
            AND variable_set.authority_scope = 'user'
            AND variable_set.authority_id = resource_row.authority_id
            AND variable_set.owner_organization_membership_id = member_row.id
          FOR SHARE;
        ELSE
          PERFORM 1 FROM rigs rig
          WHERE rig.id = resource_row.resource_id
            AND rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
            AND rig.authority_id = resource_row.authority_id
            AND rig.owner_organization_membership_id = member_row.id
          FOR SHARE;
          IF FOUND THEN
            PERFORM 1 FROM rig_versions rig_version
            WHERE rig_version.id = resource_row.resource_version_id
              AND rig_version.account_id = NEW.account_id
              AND rig_version.rig_id = resource_row.resource_id
            FOR SHARE;
          END IF;
        END IF;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal resource identity changed during admission'
            USING ERRCODE = '42501';
        END IF;

        PERFORM 1
        FROM organization_user_resource_authorities authority
        WHERE authority.id = resource_row.authority_id
          AND authority.account_id = NEW.account_id
          AND authority.organization_membership_id = member_row.id
          AND authority.resource_kind = resource_row.resource_kind
          AND authority.resource_id = resource_row.resource_id
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal resource authority is not live'
            USING ERRCODE = '42501';
        END IF;

        SELECT grant_value.* INTO grant_row
        FROM organization_user_resource_grants grant_value
        WHERE grant_value.account_id = NEW.account_id
          AND grant_value.authority_id = resource_row.authority_id
          AND grant_value.owner_organization_membership_id = member_row.id
          AND grant_value.workspace_id = NEW.workspace_id
          AND grant_value.action = resource_row.action
          AND grant_value.context = session_row.visibility
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          AND (
            (
              grant_value.mode IN ('once', 'session')
              AND grant_value.session_id = NEW.session_id
              AND grant_value.authority_epoch = session_row.authority_epoch
            ) OR (
              grant_value.mode = 'always'
              AND grant_value.session_id IS NULL
              AND grant_value.authority_epoch IS NULL
            )
          )
        ORDER BY
          CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
          grant_value.generation DESC,
          grant_value.id
        LIMIT 1
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'matching personal-resource grant required'
            USING ERRCODE = '42501';
        END IF;

        INSERT INTO session_attempt_personal_resource_snapshots (
          attempt_id, account_id, workspace_id, session_id, turn_id,
          execution_generation, resource_kind, resource_id, resource_version_id,
          selection_sources, action, origin_workspace_id,
          owner_organization_membership_id, membership_authorization_revision,
          authority_id, authority_generation, target_workspace_id,
          session_visibility, session_authority_epoch, grant_id, grant_generation,
          grant_mode, grant_context, grant_session_id, grant_authority_epoch
        )
        SELECT
          NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
          NEW.execution_generation, resource_row.resource_kind, resource_row.resource_id,
          resource_row.resource_version_id, resource_row.selection_sources,
          resource_row.action, resource_row.origin_workspace_id, member_row.id,
          member_row.authorization_revision, authority.id, authority.generation,
          NEW.workspace_id, session_row.visibility, session_row.authority_epoch,
          grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
          grant_row.session_id, grant_row.authority_epoch
        FROM organization_user_resource_authorities authority
        WHERE authority.id = resource_row.authority_id
          AND authority.account_id = NEW.account_id;

        IF grant_row.mode = 'once' THEN
          UPDATE organization_user_resource_grants
          SET status = 'consumed', updated_at = clock_timestamp()
          WHERE id = grant_row.id
            AND account_id = NEW.account_id
            AND generation = grant_row.generation
            AND status = 'active';
          GET DIAGNOSTICS affected = ROW_COUNT;
          IF affected <> 1 THEN
            RAISE EXCEPTION 'once grant lost its first-use race'
              USING ERRCODE = '40001';
          END IF;
          INSERT INTO personal_resource_once_consumption_receipts (
            grant_id, account_id, attempt_id, workspace_id, session_id, turn_id,
            execution_generation, authority_id, authority_generation, grant_generation
          ) SELECT
            grant_row.id, NEW.account_id, NEW.id, NEW.workspace_id, NEW.session_id,
            NEW.turn_id, NEW.execution_generation, authority.id, authority.generation,
            grant_row.generation
          FROM organization_user_resource_authorities authority
          WHERE authority.id = resource_row.authority_id
            AND authority.account_id = NEW.account_id;
        END IF;
        snapshot_total := snapshot_total + 1;
      END LOOP;

      IF snapshot_total <> resource_total THEN
        RAISE EXCEPTION 'personal-resource snapshot collection is not exact'
          USING ERRCODE = '23514';
      END IF;

      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.resolve_session_attempt_personal_resources(
      p_account_id uuid,
      p_workspace_id uuid,
      p_attempt_id uuid
    ) RETURNS TABLE (
      resource_kind text,
      resource_id uuid,
      resource_version_id uuid,
      selection_sources text[],
      action text,
      authority_id uuid,
      authority_generation bigint,
      grant_id uuid,
      grant_generation bigint,
      grant_mode text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      admission_row session_attempt_personal_resource_admissions%%ROWTYPE;
      invalid_count integer;
      caller_subject text := coalesce(
        nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
      );
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
      THEN
        RAISE EXCEPTION 'personal-resource resolve scope mismatch'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;

      SELECT admission.* INTO STRICT admission_row
      FROM session_attempt_personal_resource_admissions admission
      WHERE admission.attempt_id = p_attempt_id
        AND admission.account_id = p_account_id
        AND admission.workspace_id = p_workspace_id;

      IF caller_subject IS DISTINCT FROM admission_row.initiating_human_subject_id THEN
        RAISE EXCEPTION 'personal-resource resolve initiating human mismatch'
          USING ERRCODE = '42501';
      END IF;

      PERFORM 1
      FROM sessions session_value
      JOIN session_turns turn_value
        ON turn_value.account_id = session_value.account_id
       AND turn_value.workspace_id = session_value.workspace_id
       AND turn_value.session_id = session_value.id
      JOIN session_turn_attempts attempt
        ON attempt.account_id = turn_value.account_id
       AND attempt.workspace_id = turn_value.workspace_id
       AND attempt.session_id = turn_value.session_id
       AND attempt.turn_id = turn_value.id
      WHERE session_value.id = admission_row.session_id
        AND session_value.account_id = admission_row.account_id
        AND session_value.workspace_id = admission_row.workspace_id
        AND session_value.active_turn_id = admission_row.turn_id
        AND turn_value.id = admission_row.turn_id
        AND turn_value.active_attempt_id = admission_row.attempt_id
        AND turn_value.execution_generation = admission_row.execution_generation
        AND turn_value.status = 'running'
        AND attempt.id = admission_row.attempt_id
        AND attempt.execution_generation = admission_row.execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND attempt.closed_at IS NULL
        AND attempt.quiesced_at IS NULL
      FOR SHARE OF session_value, turn_value
      FOR UPDATE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'personal-resource resolve requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM session_attempt_interruptions interruption
        WHERE interruption.account_id = admission_row.account_id
          AND interruption.workspace_id = admission_row.workspace_id
          AND interruption.session_id = admission_row.session_id
          AND interruption.attempt_id = admission_row.attempt_id
          AND interruption.state IN ('pending', 'delivered', 'acknowledged')
      )
      THEN
        RAISE EXCEPTION 'personal-resource resolve requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id
        AND NOT (
          EXISTS (
            SELECT 1
            FROM session_turn_attempts attempt
            JOIN sessions session_value
              ON session_value.id = attempt.session_id
             AND session_value.account_id = attempt.account_id
             AND session_value.workspace_id = attempt.workspace_id
            JOIN session_turns turn_value
              ON turn_value.id = attempt.turn_id
             AND turn_value.account_id = attempt.account_id
             AND turn_value.workspace_id = attempt.workspace_id
             AND turn_value.session_id = attempt.session_id
            WHERE attempt.id = snapshot.attempt_id
              AND attempt.account_id = snapshot.account_id
              AND attempt.workspace_id = snapshot.workspace_id
              AND attempt.session_id = snapshot.session_id
              AND attempt.turn_id = snapshot.turn_id
              AND attempt.execution_generation = snapshot.execution_generation
              AND attempt.state IN ('claimed', 'running')
              AND attempt.quiesced_at IS NULL
              AND attempt.authority_visibility = snapshot.session_visibility
              AND attempt.authority_epoch = snapshot.session_authority_epoch
              AND session_value.visibility = snapshot.session_visibility
              AND session_value.authority_epoch = snapshot.session_authority_epoch
              AND coalesce(
                nullif(btrim(turn_value.initiating_human_subject_id), ''),
                CASE WHEN turn_value.initiator_kind = 'subject'
                  THEN nullif(btrim(turn_value.initiator_subject_id), '') END
              ) = admission_row.initiating_human_subject_id
          )
          AND EXISTS (
            SELECT 1
            FROM organization_memberships membership
            WHERE membership.id = snapshot.owner_organization_membership_id
              AND membership.account_id = snapshot.account_id
              AND membership.subject_id = admission_row.initiating_human_subject_id
              AND membership.status = 'active'
              AND membership.revoked_at IS NULL
              AND membership.authorization_revision
                = snapshot.membership_authorization_revision
              AND (
                membership.personal_workspace_id = snapshot.workspace_id
                OR EXISTS (
                  SELECT 1
                  FROM workspace_memberships workspace_membership
                  WHERE workspace_membership.account_id = membership.account_id
                    AND workspace_membership.workspace_id = snapshot.workspace_id
                    AND workspace_membership.subject_id = membership.subject_id
                )
              )
          )
          AND EXISTS (
            SELECT 1
            FROM organization_user_resource_authorities authority
            WHERE authority.id = snapshot.authority_id
              AND authority.account_id = snapshot.account_id
              AND authority.organization_membership_id
                = snapshot.owner_organization_membership_id
              AND authority.resource_kind = snapshot.resource_kind
              AND authority.resource_id = snapshot.resource_id
              AND authority.generation = snapshot.authority_generation
              AND authority.status = 'active'
              AND authority.revoked_at IS NULL
          )
          AND (
            (
              snapshot.resource_kind = 'variable_set'
              AND EXISTS (
                SELECT 1 FROM workspace_variable_sets variable_set
                WHERE variable_set.id = snapshot.resource_id
                  AND variable_set.account_id = snapshot.account_id
                  AND variable_set.authority_scope = 'user'
                  AND variable_set.authority_id = snapshot.authority_id
                  AND variable_set.owner_organization_membership_id
                    = snapshot.owner_organization_membership_id
              )
            ) OR (
              snapshot.resource_kind = 'rig'
              AND EXISTS (
                SELECT 1 FROM rigs rig
                JOIN rig_versions rig_version
                  ON rig_version.id = snapshot.resource_version_id
                 AND rig_version.rig_id = rig.id
                 AND rig_version.account_id = rig.account_id
                WHERE rig.id = snapshot.resource_id
                  AND rig.account_id = snapshot.account_id
                  AND rig.authority_scope = 'user'
                  AND rig.authority_id = snapshot.authority_id
                  AND rig.owner_organization_membership_id
                    = snapshot.owner_organization_membership_id
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM organization_user_resource_grants grant_value
            WHERE grant_value.id = snapshot.grant_id
              AND grant_value.account_id = snapshot.account_id
              AND grant_value.authority_id = snapshot.authority_id
              AND grant_value.owner_organization_membership_id
                = snapshot.owner_organization_membership_id
              AND grant_value.workspace_id = snapshot.target_workspace_id
              AND grant_value.action = snapshot.action
              AND grant_value.mode = snapshot.grant_mode
              AND grant_value.context = snapshot.grant_context
              AND grant_value.generation = snapshot.grant_generation
              AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
              AND grant_value.authority_epoch
                IS NOT DISTINCT FROM snapshot.grant_authority_epoch
              AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
              AND (
                (
                  snapshot.grant_mode = 'once'
                  AND grant_value.status = 'consumed'
                  AND EXISTS (
                    SELECT 1 FROM personal_resource_once_consumption_receipts receipt
                    WHERE receipt.grant_id = snapshot.grant_id
                      AND receipt.account_id = snapshot.account_id
                      AND receipt.attempt_id = snapshot.attempt_id
                      AND receipt.authority_id = snapshot.authority_id
                      AND receipt.authority_generation = snapshot.authority_generation
                      AND receipt.grant_generation = snapshot.grant_generation
                  )
                ) OR (
                  snapshot.grant_mode IN ('session', 'always')
                  AND grant_value.status = 'active'
                )
              )
          )
        );

      IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'personal-resource authority snapshot is no longer live'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id;
      IF invalid_count <> admission_row.resource_count THEN
        RAISE EXCEPTION 'personal-resource snapshot collection is incomplete'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      SELECT snapshot.resource_kind, snapshot.resource_id,
        snapshot.resource_version_id, snapshot.selection_sources, snapshot.action,
        snapshot.authority_id, snapshot.authority_generation, snapshot.grant_id,
        snapshot.grant_generation, snapshot.grant_mode
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id
      ORDER BY snapshot.resource_kind, snapshot.resource_id;

      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

END
$personal_resource_delegation_authority_correction$;

CREATE OR REPLACE FUNCTION freeze_scheduled_task_personal_resources(
  p_account_id uuid,
  p_workspace_id uuid,
  p_task_id uuid,
  p_task_authority_revision bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $freeze_scheduled_task_personal_resources$
DECLARE
  task_row record;
  member_row record;
  session_row record;
  resource_row record;
  grant_row record;
  initiating_subject text := coalesce(
    nullif(btrim(current_setting('opengeni.initiating_human_subject_id', true)), ''),
    nullif(btrim(current_setting('opengeni.subject_id', true)), '')
  );
  target_session uuid;
  target_visibility text := 'workspace_shared';
  target_epoch integer;
  resource_total integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'scheduled personal-resource task scope mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;

  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
  FOR UPDATE;

  SELECT count(*)::integer INTO resource_total
  FROM (
    SELECT variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.id = task_row.variable_set_id
      AND variable_set.account_id = p_account_id
      AND variable_set.authority_scope = 'user'
    UNION
    SELECT rig.id
    FROM rigs rig
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
      AND rig.authority_scope = 'user'
    UNION
    SELECT default_variable_set.id
    FROM rigs rig
    JOIN rig_versions rig_version
      ON rig_version.rig_id = rig.id
     AND rig_version.account_id = rig.account_id
     AND rig_version.active
    CROSS JOIN LATERAL jsonb_array_elements_text(
      rig_version.default_variable_set_ids
    ) default_id(value)
    JOIN workspace_variable_sets default_variable_set
      ON default_variable_set.id = default_id.value::uuid
     AND default_variable_set.account_id = p_account_id
     AND default_variable_set.authority_scope = 'user'
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
  ) selected;

  IF resource_total = 0 THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    RETURN 0;
  END IF;

  IF initiating_subject IS NULL THEN
    RAISE EXCEPTION 'scheduled personal resources require a causal human'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT member_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = initiating_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;

  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = initiating_subject
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'scheduled personal-resource owner lacks workspace access'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF task_row.run_mode = 'existing_session'
    OR (task_row.run_mode = 'reusable_session' AND task_row.reusable_session_id IS NOT NULL)
  THEN
    target_session := task_row.reusable_session_id;
    SELECT session_value.* INTO STRICT session_row
    FROM sessions session_value
    WHERE session_value.id = target_session
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    target_visibility := session_row.visibility;
    target_epoch := session_row.authority_epoch;
  END IF;

  INSERT INTO scheduled_task_personal_resource_authorities (
    task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, execution_digest, resource_count
  ) VALUES (
    p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
    initiating_subject, member_row.id, member_row.authorization_revision,
    target_session, target_visibility, target_epoch, task_row.execution_digest,
    resource_total
  );

  FOR resource_row IN
    WITH selected AS (
      SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id,
        NULL::uuid AS resource_version_id, 'variable_set.use'::text AS action,
        'session_variable_set'::text AS selection_source,
        variable_set.workspace_id AS resource_workspace_id, variable_set.authority_id,
        variable_set.owner_organization_membership_id, variable_set.origin_workspace_id
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = p_account_id
        AND variable_set.authority_scope = 'user'
      UNION ALL
      SELECT 'rig'::text, rig.id, rig_version.id, 'rig.use'::text,
        'session_rig'::text, rig.workspace_id, rig.authority_id,
        rig.owner_organization_membership_id, rig.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND rig_version.active
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
        AND rig.authority_scope = 'user'
      UNION ALL
      SELECT 'variable_set'::text, default_variable_set.id, NULL::uuid,
        'variable_set.use'::text,
        ('rig_default_variable_set:' || default_id.ordinality::text)::text,
        default_variable_set.workspace_id, default_variable_set.authority_id,
        default_variable_set.owner_organization_membership_id,
        default_variable_set.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND rig_version.active
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version.default_variable_set_ids
      ) WITH ORDINALITY default_id(value, ordinality)
      JOIN workspace_variable_sets default_variable_set
        ON default_variable_set.id = default_id.value::uuid
       AND default_variable_set.account_id = p_account_id
       AND default_variable_set.authority_scope = 'user'
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
    )
    SELECT resource_kind, resource_id, min(resource_version_id::text)::uuid resource_version_id,
      action, array_agg(selection_source ORDER BY selection_source) selection_sources,
      min(resource_workspace_id::text)::uuid resource_workspace_id,
      min(authority_id::text)::uuid authority_id,
      min(owner_organization_membership_id::text)::uuid owner_organization_membership_id,
      min(origin_workspace_id::text)::uuid origin_workspace_id
    FROM selected
    GROUP BY resource_kind, resource_id, action
    ORDER BY resource_kind, resource_id
  LOOP
    IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
    THEN
      RAISE EXCEPTION 'scheduled personal resource belongs to another human or organization'
        USING ERRCODE = '42501';
    END IF;

    SELECT grant_value.* INTO grant_row
    FROM organization_user_resource_grants grant_value
    JOIN organization_user_resource_authorities authority
      ON authority.id = grant_value.authority_id
     AND authority.account_id = grant_value.account_id
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = resource_row.resource_kind
      AND authority.resource_id = resource_row.resource_id
      AND authority.status = 'active'
      AND authority.revoked_at IS NULL
      AND grant_value.owner_organization_membership_id = member_row.id
      AND grant_value.workspace_id = p_workspace_id
      AND grant_value.action = resource_row.action
      AND grant_value.context = target_visibility
      AND grant_value.status = 'active'
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      AND (
        (target_session IS NULL AND grant_value.mode = 'always'
          AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        OR (target_session IS NOT NULL AND (
          (grant_value.mode IN ('once', 'session')
            AND grant_value.session_id = target_session
            AND grant_value.authority_epoch = target_epoch)
          OR (grant_value.mode = 'always'
            AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        ))
      )
    ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
      grant_value.generation DESC, grant_value.id
    LIMIT 1
    FOR SHARE OF authority, grant_value;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'matching scheduled personal-resource grant required'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO scheduled_task_personal_resource_snapshots (
      task_id, task_authority_revision, account_id, workspace_id,
      resource_kind, resource_id, resource_version_id, selection_sources, action,
      origin_workspace_id, owner_organization_membership_id,
      membership_authorization_revision, authority_id, authority_generation,
      target_workspace_id, session_visibility, session_authority_epoch,
      grant_id, grant_generation, grant_mode, grant_context,
      grant_session_id, grant_authority_epoch
    )
    SELECT p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
      resource_row.resource_kind, resource_row.resource_id,
      resource_row.resource_version_id, resource_row.selection_sources, resource_row.action,
      resource_row.origin_workspace_id, member_row.id, member_row.authorization_revision,
      authority.id, authority.generation, p_workspace_id, target_visibility, target_epoch,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch
    FROM organization_user_resource_authorities authority
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id;
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RETURN resource_total;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RAISE;
END
$freeze_scheduled_task_personal_resources$;
CREATE OR REPLACE FUNCTION admit_scheduled_task_run_personal_resources()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $admit_scheduled_task_run_personal_resources$
DECLARE
  task_row record;
  authority_row record;
  once_snapshot record;
  selected_personal_count integer;
  has_authority boolean := false;
  invalid_count integer;
  affected integer;
BEGIN
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = NEW.task_id
    AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id
  FOR UPDATE;

  IF (NEW.task_authority_revision IS NULL) <> (NEW.task_execution_digest IS NULL) THEN
    RAISE EXCEPTION 'scheduled task run execution binding is incomplete'
      USING ERRCODE = '22023';
  END IF;
  IF NEW.task_authority_revision IS NOT NULL AND (
    NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
  ) THEN
    RAISE EXCEPTION 'scheduled task changed after worker read'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_admit')
  ON CONFLICT DO NOTHING;

  SELECT authority.* INTO authority_row
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = task_row.authority_revision;
  has_authority := FOUND;
  IF NOT has_authority THEN
    SELECT count(*)::integer INTO selected_personal_count
    FROM (
      SELECT variable_set.id
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = task_row.account_id
        AND variable_set.authority_scope = 'user'
      UNION
      SELECT rig.id
      FROM rigs rig
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = task_row.account_id
        AND rig.authority_scope = 'user'
      UNION
      SELECT default_variable_set.id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND rig_version.active
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version.default_variable_set_ids
      ) default_id(value)
      JOIN workspace_variable_sets default_variable_set
        ON default_variable_set.id = default_id.value::uuid
       AND default_variable_set.account_id = task_row.account_id
       AND default_variable_set.authority_scope = 'user'
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = task_row.account_id
    ) selected;
    IF selected_personal_count = 0 THEN
      DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
      WHERE backend_pid = pg_backend_pid()
        AND transaction_id = pg_current_xact_id_if_assigned()
        AND capability_kind = 'run_admit';
      RETURN NEW;
    END IF;
  END IF;

  -- Ordinary run-history rows remain writable for paused tasks. The active
  -- fence applies only when this insert would admit personal-resource
  -- authority, and is checked while holding the task row lock before any
  -- admission/snapshot/once-consumption write.
  IF task_row.status <> 'active' THEN
    RAISE EXCEPTION 'scheduled task is not active' USING ERRCODE = '55000';
  END IF;

  IF NOT has_authority THEN
    RAISE EXCEPTION 'scheduled personal-resource task has no authority snapshot'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.task_authority_revision IS NULL THEN
    RAISE EXCEPTION 'scheduled personal-resource run requires an execution binding'
      USING ERRCODE = '42501';
  END IF;
  IF authority_row.execution_digest IS DISTINCT FROM task_row.execution_digest
    OR authority_row.task_authority_revision IS DISTINCT FROM NEW.task_authority_revision
    OR authority_row.execution_digest IS DISTINCT FROM NEW.task_execution_digest
  THEN
    RAISE EXCEPTION 'scheduled personal-resource execution binding mismatch'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO invalid_count
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = authority_row.task_id
    AND snapshot.task_authority_revision = authority_row.task_authority_revision
    AND NOT (
      EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = snapshot.account_id
          AND membership.subject_id = authority_row.initiating_human_subject_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND membership.authorization_revision = snapshot.membership_authorization_revision
          AND (membership.personal_workspace_id = snapshot.workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = membership.account_id
              AND workspace_membership.workspace_id = snapshot.workspace_id
              AND workspace_membership.subject_id = membership.subject_id
          ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = snapshot.authority_id
          AND authority.account_id = snapshot.account_id
          AND authority.organization_membership_id = snapshot.owner_organization_membership_id
          AND authority.resource_kind = snapshot.resource_kind
          AND authority.resource_id = snapshot.resource_id
          AND authority.generation = snapshot.authority_generation
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
      )
      AND (
        (snapshot.resource_kind = 'variable_set' AND EXISTS (
          SELECT 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.id = snapshot.resource_id
            AND variable_set.account_id = snapshot.account_id
            AND variable_set.authority_scope = 'user'
            AND variable_set.authority_id = snapshot.authority_id
            AND variable_set.owner_organization_membership_id =
              snapshot.owner_organization_membership_id
        )) OR (snapshot.resource_kind = 'rig' AND EXISTS (
          SELECT 1 FROM rigs rig
          JOIN rig_versions rig_version
            ON rig_version.id = snapshot.resource_version_id
           AND rig_version.rig_id = rig.id
           AND rig_version.account_id = rig.account_id
          WHERE rig.id = snapshot.resource_id
            AND rig.account_id = snapshot.account_id
            AND rig.authority_scope = 'user'
            AND rig.authority_id = snapshot.authority_id
            AND rig.owner_organization_membership_id =
              snapshot.owner_organization_membership_id
        ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id
          AND grant_value.account_id = snapshot.account_id
          AND grant_value.authority_id = snapshot.authority_id
          AND grant_value.owner_organization_membership_id =
            snapshot.owner_organization_membership_id
          AND grant_value.workspace_id = snapshot.target_workspace_id
          AND grant_value.action = snapshot.action
          AND grant_value.mode = snapshot.grant_mode
          AND grant_value.context = snapshot.grant_context
          AND grant_value.generation = snapshot.grant_generation
          AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
          AND grant_value.authority_epoch IS NOT DISTINCT FROM snapshot.grant_authority_epoch
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      )
      AND (
        authority_row.target_session_id IS NULL
        OR EXISTS (
          SELECT 1 FROM sessions session_value
          WHERE session_value.id = authority_row.target_session_id
            AND session_value.account_id = authority_row.account_id
            AND session_value.workspace_id = authority_row.workspace_id
            AND session_value.status <> 'cancelled'
            AND session_value.visibility = authority_row.session_visibility
            AND session_value.authority_epoch = authority_row.session_authority_epoch
        )
      )
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'scheduled personal-resource authority snapshot is no longer live'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO scheduled_task_run_personal_resource_admissions (
    run_id, task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, execution_digest, resource_count
  ) VALUES (
    NEW.id, authority_row.task_id, authority_row.task_authority_revision,
    authority_row.account_id, authority_row.workspace_id,
    authority_row.initiating_human_subject_id,
    authority_row.owner_organization_membership_id,
    authority_row.membership_authorization_revision, authority_row.target_session_id,
    authority_row.session_visibility, authority_row.session_authority_epoch,
    authority_row.execution_digest, authority_row.resource_count
  );

  INSERT INTO scheduled_task_run_personal_resource_snapshots (
    run_id, task_id, task_authority_revision, account_id, workspace_id,
    resource_kind, resource_id, resource_version_id, selection_sources, action,
    origin_workspace_id, owner_organization_membership_id,
    membership_authorization_revision, authority_id, authority_generation,
    target_workspace_id, session_visibility, session_authority_epoch,
    grant_id, grant_generation, grant_mode, grant_context,
    grant_session_id, grant_authority_epoch
  )
  SELECT NEW.id, snapshot.task_id, snapshot.task_authority_revision,
    snapshot.account_id, snapshot.workspace_id, snapshot.resource_kind,
    snapshot.resource_id, snapshot.resource_version_id, snapshot.selection_sources,
    snapshot.action, snapshot.origin_workspace_id,
    snapshot.owner_organization_membership_id,
    snapshot.membership_authorization_revision, snapshot.authority_id,
    snapshot.authority_generation, snapshot.target_workspace_id,
    snapshot.session_visibility, snapshot.session_authority_epoch,
    snapshot.grant_id, snapshot.grant_generation, snapshot.grant_mode,
    snapshot.grant_context, snapshot.grant_session_id, snapshot.grant_authority_epoch
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = authority_row.task_id
    AND snapshot.task_authority_revision = authority_row.task_authority_revision;

  FOR once_snapshot IN
    SELECT snapshot.*
    FROM scheduled_task_run_personal_resource_snapshots snapshot
    WHERE snapshot.run_id = NEW.id
      AND snapshot.grant_mode = 'once'
    ORDER BY snapshot.grant_id
  LOOP
    UPDATE organization_user_resource_grants grant_value
    SET status = 'consumed', updated_at = clock_timestamp()
    WHERE grant_value.id = once_snapshot.grant_id
      AND grant_value.account_id = once_snapshot.account_id
      AND grant_value.authority_id = once_snapshot.authority_id
      AND grant_value.generation = once_snapshot.grant_generation
      AND grant_value.status = 'active';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'scheduled occurrence once grant lost its first-use race'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO scheduled_task_run_personal_resource_once_receipts (
      grant_id, run_id, account_id, workspace_id, authority_id,
      authority_generation, grant_generation
    ) VALUES (
      once_snapshot.grant_id, NEW.id, once_snapshot.account_id,
      once_snapshot.workspace_id, once_snapshot.authority_id,
      once_snapshot.authority_generation, once_snapshot.grant_generation
    );
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RAISE;
END
$admit_scheduled_task_run_personal_resources$;

DO $fixed_search_paths$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %1$I.list_self_user_resource_authorities(uuid) '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.issue_self_user_resource_grant('
      || 'uuid, uuid, uuid, text, text, text, uuid, boolean) '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.revoke_self_user_resource_grant(uuid, uuid) '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.authorize_session_attempt_personal_resource_reads(uuid, uuid, uuid) '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.freeze_scheduled_task_personal_resources(uuid, uuid, uuid, bigint) '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.admit_scheduled_task_run_personal_resources() '
      || 'SET search_path = pg_catalog, %1$I, pg_temp',
    data_schema
  );
END
$fixed_search_paths$;
REVOKE ALL ON FUNCTION freeze_scheduled_task_personal_resources(uuid, uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_scheduled_task_run_personal_resources() FROM PUBLIC;
COMMENT ON FUNCTION list_self_user_resource_authorities(uuid) IS
  'Owner-only opaque generic user-resource authority/grant lifecycle listing.';
COMMENT ON FUNCTION issue_self_user_resource_grant(uuid, uuid, uuid, text, text, text, uuid, boolean) IS
  'Owner-only idempotent user-resource grant issue with server-derived owner/session fences.';
COMMENT ON FUNCTION revoke_self_user_resource_grant(uuid, uuid) IS
  'Owner-only immediate idempotent user-resource grant revocation.';
