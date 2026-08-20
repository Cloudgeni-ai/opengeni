-- deployment-mode: maintenance
-- Migration 0306: bind personal Variable Set/Rig issuance to one accepted
-- logical turn. Old workers select/consume `once` at attempt claim and cannot
-- safely recover that turn, so every API/control/turn worker must be stopped
-- before this cutover and no pre-0306 worker may restart afterwards.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $atomic_personal_resource_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0306 atomic personal-resource activation requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0306 atomic personal-resource activation received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0306 atomic personal-resource activation received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0306 atomic personal-resource activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$atomic_personal_resource_writer_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turns IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turn_attempts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organization_user_resource_grants IN ACCESS EXCLUSIVE MODE;

DO $atomic_personal_resource_writer_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0306 atomic personal-resource activation requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$atomic_personal_resource_writer_drain_after_lock$;

DO $atomic_personal_resource_work_drain$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM session_turns turn_value
    JOIN sessions session_value
      ON session_value.id = turn_value.session_id
     AND session_value.account_id = turn_value.account_id
     AND session_value.workspace_id = turn_value.workspace_id
    WHERE turn_value.status IN (
      'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
    )
      AND (
        EXISTS (
          SELECT 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.id = session_value.variable_set_id
            AND variable_set.authority_scope = 'user'
        )
        OR EXISTS (
          SELECT 1 FROM rigs rig
          WHERE rig.id = session_value.rig_id AND rig.authority_scope = 'user'
        )
        OR EXISTS (
          SELECT 1
          FROM rig_versions version_value
          CROSS JOIN LATERAL jsonb_array_elements_text(
            version_value.default_variable_set_ids
          ) default_id(value)
          JOIN workspace_variable_sets variable_set
            ON variable_set.id = default_id.value::uuid
           AND variable_set.authority_scope = 'user'
          WHERE version_value.id = session_value.rig_version_id
            AND version_value.rig_id = session_value.rig_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      '0306 requires all executable turns with personal Variable Set/Rig resources to be drained'
      USING ERRCODE = '55000';
  END IF;
END
$atomic_personal_resource_work_drain$;

-- No active legacy once grant has an accepted logical-turn owner. Settle them
-- before activating the new protocol so no new turn can adopt ambiguous work.
ALTER TABLE organization_user_resource_grants NO FORCE ROW LEVEL SECURITY;
UPDATE organization_user_resource_grants
SET status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp()),
    generation = generation + 1, updated_at = clock_timestamp()
WHERE status = 'active' AND mode = 'once';
ALTER TABLE organization_user_resource_grants FORCE ROW LEVEL SECURITY;

ALTER TABLE sessions ADD COLUMN "initial_personal_resource_attachment_intent" jsonb;
ALTER TABLE session_turns
  ADD COLUMN "personal_resource_attachment_summary" jsonb,
  ADD COLUMN "personal_resource_protocol_version" integer NOT NULL DEFAULT 0;
ALTER TABLE session_turn_attempts
  ADD COLUMN "personal_resource_protocol_version" integer NOT NULL DEFAULT 0;

ALTER TABLE session_turns ADD CONSTRAINT "session_turns_personal_resource_protocol_chk"
  CHECK (personal_resource_protocol_version IN (0, 1));
ALTER TABLE session_turn_attempts
  ADD CONSTRAINT "session_turn_attempts_personal_resource_protocol_chk"
  CHECK (personal_resource_protocol_version IN (0, 1));

CREATE TABLE turn_personal_resource_attachment_receipts (
  turn_id uuid PRIMARY KEY REFERENCES session_turns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  initiating_human_subject_id text NOT NULL,
  owner_organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  session_visibility text NOT NULL,
  session_authority_epoch integer NOT NULL,
  grant_mode text NOT NULL,
  shared_output_warning_version integer NOT NULL,
  shared_output_acknowledged boolean NOT NULL,
  request_digest bytea NOT NULL,
  resource_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT turn_personal_resource_attachment_receipts_identity_chk CHECK (
    octet_length(initiating_human_subject_id) BETWEEN 1 AND 512
    AND membership_authorization_revision > 0
    AND session_authority_epoch > 0
    AND grant_mode IN ('once', 'session', 'always')
    AND session_visibility IN ('user_private', 'workspace_shared')
    AND shared_output_warning_version = 1
    AND resource_count BETWEEN 1 AND 27
    AND (session_visibility <> 'workspace_shared' OR shared_output_acknowledged IS TRUE)
  ),
  CONSTRAINT turn_personal_resource_attachment_receipts_workspace_turn_fk
    FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE turn_personal_resource_snapshots (
  turn_id uuid NOT NULL REFERENCES turn_personal_resource_attachment_receipts(turn_id)
    ON DELETE CASCADE,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  resource_version_id uuid,
  selection_sources text[] NOT NULL,
  action text NOT NULL,
  origin_workspace_id uuid NOT NULL,
  owner_organization_membership_id uuid NOT NULL,
  membership_authorization_revision bigint NOT NULL,
  authority_id uuid NOT NULL,
  authority_generation bigint NOT NULL,
  grant_id uuid NOT NULL,
  grant_generation bigint NOT NULL,
  grant_mode text NOT NULL,
  grant_context text NOT NULL,
  grant_session_id uuid,
  grant_authority_epoch integer,
  canonical_delegation jsonb NOT NULL,
  snapshot_digest bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (turn_id, resource_kind, resource_id),
  CONSTRAINT turn_personal_resource_snapshots_kind_chk CHECK (
    (resource_kind = 'variable_set' AND action = 'variable_set.use'
      AND resource_version_id IS NULL)
    OR (resource_kind = 'rig' AND action = 'rig.use'
      AND resource_version_id IS NOT NULL)
  ),
  CONSTRAINT turn_personal_resource_snapshots_generation_chk CHECK (
    membership_authorization_revision > 0
    AND authority_generation > 0 AND grant_generation > 0
    AND cardinality(selection_sources) BETWEEN 1 AND 26
  ),
  CONSTRAINT turn_personal_resource_snapshots_grant_chk CHECK (
    grant_mode IN ('once', 'session', 'always')
    AND grant_context IN ('user_private', 'workspace_shared')
    AND ((grant_mode = 'always' AND grant_session_id IS NULL
      AND grant_authority_epoch IS NULL)
      OR (grant_mode IN ('once', 'session') AND grant_session_id = session_id
        AND grant_authority_epoch > 0))
  )
);
CREATE INDEX turn_personal_resource_snapshots_authority_idx
  ON turn_personal_resource_snapshots(authority_id);
CREATE INDEX turn_personal_resource_snapshots_grant_idx
  ON turn_personal_resource_snapshots(grant_id);

CREATE TABLE turn_personal_resource_once_receipts (
  grant_id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES turn_personal_resource_attachment_receipts(turn_id)
    ON DELETE CASCADE,
  account_id uuid NOT NULL,
  authority_id uuid NOT NULL,
  authority_generation bigint NOT NULL,
  grant_generation bigint NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT turn_personal_resource_once_receipts_generation_chk CHECK (
    authority_generation > 0 AND grant_generation > 0
  )
);

ALTER TABLE turn_personal_resource_attachment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_personal_resource_attachment_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE turn_personal_resource_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_personal_resource_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE turn_personal_resource_once_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_personal_resource_once_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY turn_personal_resource_attachment_internal
  ON turn_personal_resource_attachment_receipts
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'personal_resource_grant_management'
    OR EXISTS (
      SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability
      WHERE capability.backend_pid = pg_backend_pid()
        AND capability.transaction_id = pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('admit', 'resolve')
    )
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'personal_resource_grant_management'
    OR EXISTS (
      SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability
      WHERE capability.backend_pid = pg_backend_pid()
        AND capability.transaction_id = pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'admit'
    )
  );
CREATE POLICY turn_personal_resource_snapshot_internal
  ON turn_personal_resource_snapshots
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'personal_resource_grant_management'
    OR EXISTS (
      SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability
      WHERE capability.backend_pid = pg_backend_pid()
        AND capability.transaction_id = pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('admit', 'resolve')
    )
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'personal_resource_grant_management'
  );
CREATE POLICY turn_personal_resource_once_internal
  ON turn_personal_resource_once_receipts
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'personal_resource_grant_management'
    OR EXISTS (
      SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability
      WHERE capability.backend_pid = pg_backend_pid()
        AND capability.transaction_id = pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('admit', 'resolve')
    )
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      = 'personal_resource_grant_management'
  );

CREATE FUNCTION digest_turn_personal_resource_snapshot(
  p_snapshot turn_personal_resource_snapshots
) RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path FROM CURRENT
AS $body$
  SELECT digest(convert_to(
    (to_jsonb(p_snapshot) - 'snapshot_digest' - 'created_at')::text,
    'UTF8'
  ), 'sha256')
$body$;

CREATE FUNCTION stamp_turn_personal_resource_snapshot_digest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  NEW.snapshot_digest := digest_turn_personal_resource_snapshot(NEW);
  RETURN NEW;
END
$body$;

CREATE TRIGGER turn_personal_resource_snapshots_digest
BEFORE INSERT ON turn_personal_resource_snapshots
FOR EACH ROW EXECUTE FUNCTION stamp_turn_personal_resource_snapshot_digest();

CREATE FUNCTION reject_turn_personal_resource_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  RAISE EXCEPTION 'accepted turn personal-resource evidence is immutable'
    USING ERRCODE = '42501';
END
$body$;

CREATE TRIGGER turn_personal_resource_attachment_receipts_immutable
BEFORE UPDATE ON turn_personal_resource_attachment_receipts
FOR EACH ROW EXECUTE FUNCTION reject_turn_personal_resource_snapshot_update();
CREATE TRIGGER turn_personal_resource_snapshots_immutable
BEFORE UPDATE ON turn_personal_resource_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_turn_personal_resource_snapshot_update();
CREATE TRIGGER turn_personal_resource_once_receipts_immutable
BEFORE UPDATE ON turn_personal_resource_once_receipts
FOR EACH ROW EXECUTE FUNCTION reject_turn_personal_resource_snapshot_update();

CREATE FUNCTION fence_turn_personal_resource_protocol_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF OLD.personal_resource_protocol_version = 1 AND (
    NEW.personal_resource_protocol_version IS DISTINCT FROM OLD.personal_resource_protocol_version
    OR NEW.personal_resource_attachment_summary
      IS DISTINCT FROM OLD.personal_resource_attachment_summary
  ) THEN
    RAISE EXCEPTION 'accepted turn personal-resource binding is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER session_turns_personal_resource_binding_immutable
BEFORE UPDATE ON session_turns
FOR EACH ROW EXECUTE FUNCTION fence_turn_personal_resource_protocol_update();

CREATE FUNCTION fence_attempt_personal_resource_protocol_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF NEW.personal_resource_protocol_version
    IS DISTINCT FROM OLD.personal_resource_protocol_version
  THEN
    RAISE EXCEPTION 'attempt personal-resource protocol version is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER session_turn_attempts_personal_resource_protocol_immutable
BEFORE UPDATE ON session_turn_attempts
FOR EACH ROW EXECUTE FUNCTION fence_attempt_personal_resource_protocol_update();

CREATE FUNCTION fence_session_initial_personal_resource_intent_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF NEW.initial_personal_resource_attachment_intent
    IS DISTINCT FROM OLD.initial_personal_resource_attachment_intent
  THEN
    RAISE EXCEPTION 'initial personal-resource attachment intent is immutable'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER sessions_initial_personal_resource_intent_immutable
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION fence_session_initial_personal_resource_intent_update();

REVOKE ALL ON turn_personal_resource_attachment_receipts FROM PUBLIC;
REVOKE ALL ON turn_personal_resource_snapshots FROM PUBLIC;
REVOKE ALL ON turn_personal_resource_once_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION digest_turn_personal_resource_snapshot(
  turn_personal_resource_snapshots
) FROM PUBLIC;
REVOKE ALL ON FUNCTION stamp_turn_personal_resource_snapshot_digest() FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_turn_personal_resource_snapshot_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_turn_personal_resource_protocol_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_attempt_personal_resource_protocol_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION fence_session_initial_personal_resource_intent_update() FROM PUBLIC;

CREATE OR REPLACE FUNCTION accept_turn_personal_resource_attachment(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_mode text,
  p_expected_authority_epoch integer,
  p_workspace_shared_acknowledged boolean,
  p_shared_output_warning_version integer
) RETURNS TABLE (
  grant_mode text,
  grant_context text,
  resource_count integer,
  resource_kinds text[],
  shared_output_warning_version integer,
  replay boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
#variable_conflict use_column
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  resource_row record;
  authority_row organization_user_resource_authorities%ROWTYPE;
  grant_row organization_user_resource_grants%ROWTYPE;
  existing_receipt turn_personal_resource_attachment_receipts%ROWTYPE;
  canonical jsonb;
  request_hash bytea;
  selected_resources jsonb := '[]'::jsonb;
  selected_count integer := 0;
  unauthorized_count integer := 0;
  kinds text[] := ARRAY[]::text[];
BEGIN
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'personal_resource_grant_management', true
  );
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR caller_subject IS NULL
    OR p_mode IS NULL OR p_mode NOT IN ('once', 'session', 'always')
    OR p_expected_authority_epoch IS NULL OR p_expected_authority_epoch <= 0
    OR p_shared_output_warning_version IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION 'invalid atomic personal-resource attachment request'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM session_tenancy_activations activation
    WHERE activation.account_id = p_account_id AND activation.activation_version = 1
  ) THEN
    RAISE EXCEPTION 'session tenancy product is not activated' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspace_inference_controls control_row
  WHERE control_row.account_id = p_account_id AND control_row.workspace_id = p_workspace_id
  FOR SHARE;
  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.account_id = p_account_id AND workspace_value.id = p_workspace_id
  FOR KEY SHARE;
  SELECT session_value.* INTO STRICT session_row
  FROM sessions session_value
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id
  FOR NO KEY UPDATE;
  SELECT turn_value.* INTO STRICT turn_row
  FROM session_turns turn_value
  WHERE turn_value.id = p_turn_id
    AND turn_value.account_id = p_account_id
    AND turn_value.workspace_id = p_workspace_id
    AND turn_value.session_id = p_session_id
  FOR UPDATE;

  IF coalesce(nullif(btrim(turn_row.initiating_human_subject_id), ''),
      CASE WHEN turn_row.initiator_kind = 'subject'
        THEN nullif(btrim(turn_row.initiator_subject_id), '') END)
      IS DISTINCT FROM caller_subject
    OR session_row.authority_epoch IS DISTINCT FROM p_expected_authority_epoch
  THEN
    RAISE EXCEPTION 'atomic personal-resource attachment is not exact accepted work'
      USING ERRCODE = '42501';
  END IF;
  IF session_row.visibility = 'workspace_shared'
    AND p_workspace_shared_acknowledged IS NOT TRUE
  THEN
    RAISE EXCEPTION 'workspace-shared personal-resource attachment requires warning acknowledgement'
      USING ERRCODE = '42501';
  END IF;

  request_hash := digest(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'sessionId', p_session_id, 'turnId', p_turn_id, 'mode', p_mode,
    'authorityEpoch', p_expected_authority_epoch,
    'sessionVisibility', session_row.visibility,
    'workspaceSharedAcknowledged', p_workspace_shared_acknowledged IS TRUE,
    'sharedOutputWarningVersion', p_shared_output_warning_version
  )::text, 'UTF8'), 'sha256');

  SELECT receipt.* INTO existing_receipt
  FROM turn_personal_resource_attachment_receipts receipt
  WHERE receipt.turn_id = p_turn_id;
  IF FOUND THEN
    IF existing_receipt.request_digest IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'atomic personal-resource attachment replay changed its request'
        USING ERRCODE = '23505';
    END IF;
    grant_mode := existing_receipt.grant_mode;
    grant_context := existing_receipt.session_visibility;
    resource_count := existing_receipt.resource_count;
    SELECT array_agg(DISTINCT snapshot.resource_kind ORDER BY snapshot.resource_kind)
      INTO resource_kinds
    FROM turn_personal_resource_snapshots snapshot
    WHERE snapshot.turn_id = p_turn_id;
    shared_output_warning_version := existing_receipt.shared_output_warning_version;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF session_row.status = 'cancelled'
    OR turn_row.status <> 'queued'
    OR turn_row.active_attempt_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'personal-resource issuance requires new queued accepted work'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT member_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = caller_subject
    AND membership.status = 'active' AND membership.revoked_at IS NULL
  FOR SHARE;
  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id
    AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = caller_subject
    )
  THEN
    RAISE EXCEPTION 'owner lacks target-workspace access' USING ERRCODE = '42501';
  END IF;

  -- Freeze every row that can change the server-derived closure before
  -- evaluating it. The closure is materialized once below and reused for grant
  -- issuance, so a concurrent resource edit cannot create a mixed snapshot.
  PERFORM 1 FROM rigs rig
  WHERE rig.id = session_row.rig_id AND rig.account_id = p_account_id
  FOR SHARE;
  PERFORM 1 FROM rig_versions version_value
  WHERE version_value.id = session_row.rig_version_id
    AND version_value.rig_id = session_row.rig_id
    AND version_value.account_id = p_account_id
  FOR SHARE;
  PERFORM 1 FROM workspace_variable_sets variable_set
  WHERE variable_set.id = session_row.variable_set_id
    AND variable_set.account_id = p_account_id
  FOR SHARE;
  PERFORM variable_set.id
  FROM rig_versions version_value
  CROSS JOIN LATERAL jsonb_array_elements_text(version_value.default_variable_set_ids)
    default_id(value)
  JOIN workspace_variable_sets variable_set
    ON variable_set.id = default_id.value::uuid
   AND variable_set.account_id = p_account_id
  WHERE version_value.id = session_row.rig_version_id
    AND version_value.rig_id = session_row.rig_id
    AND version_value.account_id = p_account_id
  ORDER BY variable_set.id
  FOR SHARE OF variable_set;

  WITH selected AS (
    SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id,
      NULL::uuid AS resource_version_id, 'variable_set.use'::text AS action,
      'session_variable_set'::text AS selection_source,
      variable_set.origin_workspace_id, variable_set.authority_id,
      variable_set.owner_organization_membership_id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.id = session_row.variable_set_id
      AND variable_set.account_id = p_account_id
      AND variable_set.authority_scope = 'user'
    UNION ALL
    SELECT 'rig', rig.id, session_row.rig_version_id, 'rig.use', 'session_rig',
      rig.origin_workspace_id, rig.authority_id, rig.owner_organization_membership_id
    FROM rigs rig
    WHERE rig.id = session_row.rig_id
      AND rig.account_id = p_account_id AND rig.authority_scope = 'user'
    UNION ALL
    SELECT 'variable_set', variable_set.id, NULL::uuid, 'variable_set.use',
      'rig_default_variable_set:' || default_id.ordinality::text,
      variable_set.origin_workspace_id, variable_set.authority_id,
      variable_set.owner_organization_membership_id
    FROM rig_versions version_value
    CROSS JOIN LATERAL jsonb_array_elements_text(version_value.default_variable_set_ids)
      WITH ORDINALITY default_id(value, ordinality)
    JOIN workspace_variable_sets variable_set
      ON variable_set.id = default_id.value::uuid
     AND variable_set.account_id = p_account_id
     AND variable_set.authority_scope = 'user'
    WHERE version_value.id = session_row.rig_version_id
      AND version_value.rig_id = session_row.rig_id
      AND version_value.account_id = p_account_id
  ), grouped AS (
    SELECT resource_kind, resource_id,
      min(resource_version_id::text)::uuid AS resource_version_id,
      action, array_agg(selection_source ORDER BY selection_source) AS selection_sources,
      min(origin_workspace_id::text)::uuid AS origin_workspace_id,
      min(authority_id::text)::uuid AS authority_id,
      min(owner_organization_membership_id::text)::uuid
        AS owner_organization_membership_id
    FROM selected
    GROUP BY resource_kind, resource_id, action
  )
  SELECT count(*)::integer,
    array_agg(DISTINCT resource_kind ORDER BY resource_kind),
    count(*) FILTER (
      WHERE owner_organization_membership_id IS DISTINCT FROM member_row.id
    )::integer,
    coalesce(jsonb_agg(jsonb_build_object(
      'resource_kind', resource_kind,
      'resource_id', resource_id,
      'resource_version_id', resource_version_id,
      'action', action,
      'selection_sources', selection_sources,
      'origin_workspace_id', origin_workspace_id,
      'authority_id', authority_id,
      'owner_organization_membership_id', owner_organization_membership_id
    ) ORDER BY resource_kind, resource_id), '[]'::jsonb)
  INTO selected_count, kinds, unauthorized_count, selected_resources
  FROM grouped;
  IF selected_count = 0 THEN
    RAISE EXCEPTION 'no personal Variable Set or Rig is selected by this session'
      USING ERRCODE = '22023';
  END IF;
  IF selected_count > 27 THEN
    RAISE EXCEPTION 'personal Variable Set/Rig closure exceeds the accepted-work bound'
      USING ERRCODE = '22023';
  END IF;
  IF unauthorized_count <> 0 THEN
    RAISE EXCEPTION 'a nonowner cannot attach another user''s personal resource'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO turn_personal_resource_attachment_receipts (
    turn_id, account_id, workspace_id, session_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, session_visibility,
    session_authority_epoch, grant_mode, shared_output_warning_version,
    shared_output_acknowledged, request_digest, resource_count
  ) VALUES (
    p_turn_id, p_account_id, p_workspace_id, p_session_id, caller_subject,
    member_row.id, member_row.authorization_revision, session_row.visibility,
    session_row.authority_epoch, p_mode, p_shared_output_warning_version,
    p_workspace_shared_acknowledged IS TRUE, request_hash, selected_count
  );

  FOR resource_row IN
    SELECT * FROM jsonb_to_recordset(selected_resources) AS selected(
      resource_kind text,
      resource_id uuid,
      resource_version_id uuid,
      action text,
      selection_sources text[],
      origin_workspace_id uuid,
      authority_id uuid,
      owner_organization_membership_id uuid
    )
    ORDER BY resource_kind, resource_id
  LOOP
    SELECT authority.* INTO STRICT authority_row
    FROM organization_user_resource_authorities authority
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = resource_row.resource_kind
      AND authority.resource_id = resource_row.resource_id
      AND authority.status = 'active' AND authority.revoked_at IS NULL
    FOR UPDATE;

    UPDATE organization_user_resource_grants grant_value
    SET status = 'expired', updated_at = clock_timestamp()
    WHERE grant_value.account_id = p_account_id
      AND grant_value.authority_id = authority_row.id
      AND grant_value.status = 'active'
      AND grant_value.expires_at IS NOT NULL
      AND grant_value.expires_at <= clock_timestamp();

    INSERT INTO organization_user_resource_grants (
      account_id, authority_id, owner_organization_membership_id, workspace_id,
      session_id, action, mode, context, authority_epoch, generation, status
    ) VALUES (
      p_account_id, authority_row.id, member_row.id, p_workspace_id,
      CASE WHEN p_mode = 'always' THEN NULL ELSE p_session_id END,
      resource_row.action, p_mode, session_row.visibility,
      CASE WHEN p_mode = 'always' THEN NULL ELSE session_row.authority_epoch END,
      1, 'active'
    )
    ON CONFLICT (account_id, authority_id, workspace_id, action, mode, context,
      (coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid)),
      (coalesce(authority_epoch, 0))) WHERE status = 'active'
    DO UPDATE SET updated_at = organization_user_resource_grants.updated_at
    RETURNING * INTO grant_row;

    canonical := jsonb_build_object(
      'authorityId', authority_row.id, 'grantId', grant_row.id,
      'organizationId', p_account_id, 'workspaceId', p_workspace_id,
      'sessionId', grant_row.session_id, 'action', resource_row.action,
      'mode', grant_row.mode, 'context', grant_row.context,
      'authorityEpoch', grant_row.authority_epoch,
      'authorityGeneration', authority_row.generation,
      'grantGeneration', grant_row.generation,
      'resourceVersionId', resource_row.resource_version_id
    );
    canonical := canonical - CASE WHEN resource_row.resource_version_id IS NULL
      THEN 'resourceVersionId' ELSE '__not_present__' END;

    INSERT INTO turn_personal_resource_snapshots (
      turn_id, account_id, workspace_id, session_id, resource_kind, resource_id,
      resource_version_id, selection_sources, action, origin_workspace_id,
      owner_organization_membership_id, membership_authorization_revision,
      authority_id, authority_generation, grant_id, grant_generation, grant_mode,
      grant_context, grant_session_id, grant_authority_epoch,
      canonical_delegation, snapshot_digest
    ) VALUES (
      p_turn_id, p_account_id, p_workspace_id, p_session_id,
      resource_row.resource_kind, resource_row.resource_id,
      resource_row.resource_version_id, resource_row.selection_sources,
      resource_row.action, resource_row.origin_workspace_id, member_row.id,
      member_row.authorization_revision, authority_row.id, authority_row.generation,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch, canonical,
      decode('', 'hex')
    );

    IF p_mode = 'once' THEN
      UPDATE organization_user_resource_grants
      SET status = 'consumed', updated_at = clock_timestamp()
      WHERE id = grant_row.id AND account_id = p_account_id
        AND generation = grant_row.generation AND status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'once grant lost its accepted-turn race' USING ERRCODE = '40001';
      END IF;
      INSERT INTO turn_personal_resource_once_receipts (
        grant_id, turn_id, account_id, authority_id,
        authority_generation, grant_generation
      ) VALUES (
        grant_row.id, p_turn_id, p_account_id, authority_row.id,
        authority_row.generation, grant_row.generation
      );
    END IF;
  END LOOP;

  UPDATE session_turns
  SET personal_resource_attachment_summary = jsonb_build_object(
      'mode', p_mode, 'context', session_row.visibility,
      'resourceCount', selected_count, 'resourceKinds', to_jsonb(kinds),
      'sharedOutputWarningVersion', p_shared_output_warning_version
    ),
    personal_resource_protocol_version = 1,
    updated_at = clock_timestamp()
  WHERE id = p_turn_id AND account_id = p_account_id AND workspace_id = p_workspace_id;

  INSERT INTO audit_events (
    account_id, workspace_id, subject_id, action, target_type, target_id,
    metadata, metadata_codec_version
  ) VALUES (
    p_account_id, p_workspace_id, caller_subject,
    'session.personal_resources.attach', 'session_turn', p_turn_id::text,
    jsonb_build_object(
      'sessionId', p_session_id, 'turnId', p_turn_id, 'mode', p_mode,
      'context', session_row.visibility, 'authorityEpoch', session_row.authority_epoch,
      'sharedOutputWarningVersion', p_shared_output_warning_version,
      'sharedOutputAcknowledged', p_workspace_shared_acknowledged IS TRUE,
      'resourceCount', selected_count, 'resourceKinds', to_jsonb(kinds)
    ), 1
  );

  grant_mode := p_mode;
  grant_context := session_row.visibility;
  resource_count := selected_count;
  resource_kinds := kinds;
  shared_output_warning_version := p_shared_output_warning_version;
  replay := false;
  RETURN NEXT;
END
$body$;

REVOKE ALL ON FUNCTION accept_turn_personal_resource_attachment(
  uuid, uuid, uuid, uuid, text, integer, boolean, integer
) FROM PUBLIC;

-- Keep legacy attempt selection only for version-0 turns. In particular it no
-- longer has any path that can consume an unbound active once grant.
DO $legacy_personal_resource_trigger_fence$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'DROP TRIGGER IF EXISTS session_attempt_personal_resource_admission ON %I.session_turn_attempts',
    data_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_attempt_personal_resource_admission_legacy '
      || 'AFTER INSERT ON %I.session_turn_attempts FOR EACH ROW '
      || 'WHEN (NEW.personal_resource_protocol_version = 0) '
      || 'EXECUTE FUNCTION %I.admit_session_attempt_personal_resources()',
    data_schema, data_schema
  );
END
$legacy_personal_resource_trigger_fence$;

-- The v1 trigger and resolver are appended below after the legacy function is
-- renamed; keeping them in this migration makes the cutover indivisible.

CREATE OR REPLACE FUNCTION admit_session_attempt_personal_resources_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  receipt_row turn_personal_resource_attachment_receipts%ROWTYPE;
  copied_count integer;
  invalid_count integer;
BEGIN
  INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'admit')
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
  SELECT receipt.* INTO STRICT receipt_row
  FROM turn_personal_resource_attachment_receipts receipt
  WHERE receipt.turn_id = NEW.turn_id
    AND receipt.account_id = NEW.account_id
    AND receipt.workspace_id = NEW.workspace_id
    AND receipt.session_id = NEW.session_id;

  IF NEW.execution_generation <= 0
    OR NEW.state NOT IN ('claimed', 'running')
    OR NEW.closed_at IS NOT NULL OR NEW.quiesced_at IS NOT NULL
    OR session_row.active_turn_id IS DISTINCT FROM NEW.turn_id
    OR turn_row.active_attempt_id IS DISTINCT FROM NEW.id
    OR turn_row.execution_generation IS DISTINCT FROM NEW.execution_generation
    OR turn_row.status <> 'running'
    OR turn_row.personal_resource_protocol_version <> 1
    OR NEW.personal_resource_protocol_version <> 1
    OR NEW.authority_visibility IS DISTINCT FROM session_row.visibility
    OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch
    OR NEW.authority_owner_organization_membership_id
      IS DISTINCT FROM session_row.owner_organization_membership_id
    OR receipt_row.session_visibility IS DISTINCT FROM session_row.visibility
    OR receipt_row.session_authority_epoch IS DISTINCT FROM session_row.authority_epoch
    OR receipt_row.initiating_human_subject_id IS DISTINCT FROM coalesce(
      nullif(btrim(turn_row.initiating_human_subject_id), ''),
      CASE WHEN turn_row.initiator_kind = 'subject'
        THEN nullif(btrim(turn_row.initiator_subject_id), '') END
    )
  THEN
    RAISE EXCEPTION 'turn-bound personal-resource admission requires the exact current attempt'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO invalid_count
  FROM turn_personal_resource_snapshots snapshot
  WHERE snapshot.turn_id = NEW.turn_id
    AND NOT (
      snapshot.account_id = NEW.account_id
      AND snapshot.workspace_id = NEW.workspace_id
      AND snapshot.session_id = NEW.session_id
      AND snapshot.owner_organization_membership_id
        = receipt_row.owner_organization_membership_id
      AND snapshot.membership_authorization_revision
        = receipt_row.membership_authorization_revision
      AND snapshot.grant_context = receipt_row.session_visibility
      AND snapshot.grant_mode = receipt_row.grant_mode
      AND EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = snapshot.account_id
          AND membership.subject_id = receipt_row.initiating_human_subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
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
          AND authority.status = 'active' AND authority.revoked_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id
          AND grant_value.account_id = snapshot.account_id
          AND grant_value.authority_id = snapshot.authority_id
          AND grant_value.owner_organization_membership_id
            = snapshot.owner_organization_membership_id
          AND grant_value.workspace_id = snapshot.workspace_id
          AND grant_value.action = snapshot.action
          AND grant_value.mode = snapshot.grant_mode
          AND grant_value.context = snapshot.grant_context
          AND grant_value.generation = snapshot.grant_generation
          AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
          AND grant_value.authority_epoch IS NOT DISTINCT FROM snapshot.grant_authority_epoch
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          AND ((snapshot.grant_mode = 'once' AND grant_value.status = 'consumed'
            AND EXISTS (
              SELECT 1 FROM turn_personal_resource_once_receipts once_receipt
              WHERE once_receipt.grant_id = snapshot.grant_id
                AND once_receipt.turn_id = snapshot.turn_id
                AND once_receipt.account_id = snapshot.account_id
                AND once_receipt.authority_id = snapshot.authority_id
                AND once_receipt.authority_generation = snapshot.authority_generation
                AND once_receipt.grant_generation = snapshot.grant_generation
            )) OR (snapshot.grant_mode IN ('session', 'always')
              AND grant_value.status = 'active'))
      )
      AND snapshot.snapshot_digest = digest_turn_personal_resource_snapshot(snapshot)
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'turn-bound personal-resource snapshot is no longer live'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO session_attempt_personal_resource_admissions (
    attempt_id, account_id, workspace_id, session_id, turn_id,
    execution_generation, initiating_human_subject_id,
    owner_organization_membership_id, membership_authorization_revision,
    session_visibility, session_authority_epoch, resource_count
  ) VALUES (
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
    NEW.execution_generation, receipt_row.initiating_human_subject_id,
    receipt_row.owner_organization_membership_id,
    receipt_row.membership_authorization_revision,
    receipt_row.session_visibility, receipt_row.session_authority_epoch,
    receipt_row.resource_count
  );

  INSERT INTO session_attempt_personal_resource_snapshots (
    attempt_id, account_id, workspace_id, session_id, turn_id,
    execution_generation, resource_kind, resource_id, resource_version_id,
    selection_sources, action, origin_workspace_id,
    owner_organization_membership_id, membership_authorization_revision,
    authority_id, authority_generation, target_workspace_id,
    session_visibility, session_authority_epoch, grant_id, grant_generation,
    grant_mode, grant_context, grant_session_id, grant_authority_epoch
  )
  SELECT NEW.id, snapshot.account_id, snapshot.workspace_id, snapshot.session_id,
    snapshot.turn_id, NEW.execution_generation, snapshot.resource_kind,
    snapshot.resource_id, snapshot.resource_version_id, snapshot.selection_sources,
    snapshot.action, snapshot.origin_workspace_id,
    snapshot.owner_organization_membership_id,
    snapshot.membership_authorization_revision, snapshot.authority_id,
    snapshot.authority_generation, snapshot.workspace_id,
    receipt_row.session_visibility, receipt_row.session_authority_epoch,
    snapshot.grant_id, snapshot.grant_generation, snapshot.grant_mode,
    snapshot.grant_context, snapshot.grant_session_id, snapshot.grant_authority_epoch
  FROM turn_personal_resource_snapshots snapshot
  WHERE snapshot.turn_id = NEW.turn_id
  ORDER BY snapshot.resource_kind, snapshot.resource_id;
  GET DIAGNOSTICS copied_count = ROW_COUNT;
  IF copied_count <> receipt_row.resource_count THEN
    RAISE EXCEPTION 'turn-bound personal-resource snapshot collection is incomplete'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM opengeni_private.personal_resource_delegation_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'admit';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.personal_resource_delegation_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'admit';
  RAISE;
END
$body$;

DO $v1_personal_resource_trigger_install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'CREATE TRIGGER session_attempt_personal_resource_admission_v1 '
      || 'AFTER INSERT ON %I.session_turn_attempts FOR EACH ROW '
      || 'WHEN (NEW.personal_resource_protocol_version = 1) '
      || 'EXECUTE FUNCTION %I.admit_session_attempt_personal_resources_v1()',
    data_schema, data_schema
  );
END
$v1_personal_resource_trigger_install$;

ALTER FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid)
  RENAME TO resolve_session_attempt_personal_resources_legacy_0305;

CREATE FUNCTION resolve_session_attempt_personal_resources(
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
SET search_path FROM CURRENT
AS $body$
#variable_conflict use_column
DECLARE
  attempt_protocol integer;
  admission_row session_attempt_personal_resource_admissions%ROWTYPE;
  invalid_count integer;
  caller_subject text := coalesce(
    nullif(current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(current_setting('opengeni.subject_id', true), '')
  );
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'personal-resource resolve scope mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT attempt.personal_resource_protocol_version INTO STRICT attempt_protocol
  FROM session_turn_attempts attempt
  WHERE attempt.id = p_attempt_id
    AND attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id;
  IF attempt_protocol = 0 THEN
    RETURN QUERY SELECT * FROM resolve_session_attempt_personal_resources_legacy_0305(
      p_account_id, p_workspace_id, p_attempt_id
    );
    RETURN;
  ELSIF attempt_protocol <> 1 THEN
    RAISE EXCEPTION 'unsupported personal-resource protocol version'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'resolve')
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
  WHERE attempt.id = admission_row.attempt_id
    AND session_value.active_turn_id = admission_row.turn_id
    AND turn_value.active_attempt_id = admission_row.attempt_id
    AND turn_value.execution_generation = admission_row.execution_generation
    AND turn_value.personal_resource_protocol_version = 1
    AND turn_value.status = 'running'
    AND attempt.execution_generation = admission_row.execution_generation
    AND attempt.personal_resource_protocol_version = 1
    AND attempt.state IN ('claimed', 'running')
    AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
    AND attempt.authority_visibility = admission_row.session_visibility
    AND attempt.authority_epoch = admission_row.session_authority_epoch
    AND session_value.visibility = admission_row.session_visibility
    AND session_value.authority_epoch = admission_row.session_authority_epoch
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.account_id = attempt.account_id
        AND interruption.workspace_id = attempt.workspace_id
        AND interruption.session_id = attempt.session_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE OF session_value, turn_value
  FOR UPDATE OF attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal-resource resolve requires the exact current uninterrupted attempt'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO invalid_count
  FROM session_attempt_personal_resource_snapshots snapshot
  JOIN turn_personal_resource_snapshots accepted
    ON accepted.turn_id = snapshot.turn_id
   AND accepted.resource_kind = snapshot.resource_kind
   AND accepted.resource_id = snapshot.resource_id
  WHERE snapshot.attempt_id = admission_row.attempt_id
    AND NOT (
      snapshot.account_id = accepted.account_id
      AND snapshot.workspace_id = accepted.workspace_id
      AND snapshot.session_id = accepted.session_id
      AND snapshot.resource_version_id IS NOT DISTINCT FROM accepted.resource_version_id
      AND snapshot.selection_sources = accepted.selection_sources
      AND snapshot.action = accepted.action
      AND snapshot.origin_workspace_id = accepted.origin_workspace_id
      AND snapshot.owner_organization_membership_id
        = accepted.owner_organization_membership_id
      AND snapshot.membership_authorization_revision
        = accepted.membership_authorization_revision
      AND snapshot.authority_id = accepted.authority_id
      AND snapshot.authority_generation = accepted.authority_generation
      AND snapshot.grant_id = accepted.grant_id
      AND snapshot.grant_generation = accepted.grant_generation
      AND snapshot.grant_mode = accepted.grant_mode
      AND snapshot.grant_context = accepted.grant_context
      AND snapshot.grant_session_id IS NOT DISTINCT FROM accepted.grant_session_id
      AND snapshot.grant_authority_epoch IS NOT DISTINCT FROM accepted.grant_authority_epoch
      AND accepted.snapshot_digest = digest_turn_personal_resource_snapshot(accepted)
      AND EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = accepted.owner_organization_membership_id
          AND membership.account_id = accepted.account_id
          AND membership.subject_id = admission_row.initiating_human_subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND membership.authorization_revision = accepted.membership_authorization_revision
          AND (membership.personal_workspace_id = accepted.workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = membership.account_id
              AND workspace_membership.workspace_id = accepted.workspace_id
              AND workspace_membership.subject_id = membership.subject_id
          ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = accepted.authority_id
          AND authority.account_id = accepted.account_id
          AND authority.organization_membership_id = accepted.owner_organization_membership_id
          AND authority.resource_kind = accepted.resource_kind
          AND authority.resource_id = accepted.resource_id
          AND authority.generation = accepted.authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = accepted.grant_id
          AND grant_value.account_id = accepted.account_id
          AND grant_value.authority_id = accepted.authority_id
          AND grant_value.owner_organization_membership_id
            = accepted.owner_organization_membership_id
          AND grant_value.workspace_id = accepted.workspace_id
          AND grant_value.action = accepted.action
          AND grant_value.mode = accepted.grant_mode
          AND grant_value.context = accepted.grant_context
          AND grant_value.generation = accepted.grant_generation
          AND grant_value.session_id IS NOT DISTINCT FROM accepted.grant_session_id
          AND grant_value.authority_epoch IS NOT DISTINCT FROM accepted.grant_authority_epoch
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          AND ((accepted.grant_mode = 'once' AND grant_value.status = 'consumed'
            AND EXISTS (
              SELECT 1 FROM turn_personal_resource_once_receipts once_receipt
              WHERE once_receipt.grant_id = accepted.grant_id
                AND once_receipt.turn_id = accepted.turn_id
                AND once_receipt.account_id = accepted.account_id
                AND once_receipt.authority_id = accepted.authority_id
                AND once_receipt.authority_generation = accepted.authority_generation
                AND once_receipt.grant_generation = accepted.grant_generation
            )) OR (accepted.grant_mode IN ('session', 'always')
              AND grant_value.status = 'active'))
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
  SELECT snapshot.resource_kind, snapshot.resource_id, snapshot.resource_version_id,
    snapshot.selection_sources, snapshot.action, snapshot.authority_id,
    snapshot.authority_generation, snapshot.grant_id,
    snapshot.grant_generation, snapshot.grant_mode
  FROM session_attempt_personal_resource_snapshots snapshot
  WHERE snapshot.attempt_id = admission_row.attempt_id
  ORDER BY snapshot.resource_kind, snapshot.resource_id;

  DELETE FROM opengeni_private.personal_resource_delegation_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'resolve';
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.personal_resource_delegation_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'resolve';
  RAISE;
END
$body$;

REVOKE ALL ON FUNCTION admit_session_attempt_personal_resources_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_session_attempt_personal_resources_legacy_0305(
  uuid, uuid, uuid
) FROM PUBLIC;

DO $atomic_personal_resource_function_hardening$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.digest_turn_personal_resource_snapshot('
      || '%I.turn_personal_resource_snapshots) '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.stamp_turn_personal_resource_snapshot_digest() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.reject_turn_personal_resource_snapshot_update() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fence_turn_personal_resource_protocol_update() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fence_attempt_personal_resource_protocol_update() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fence_session_initial_personal_resource_intent_update() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.accept_turn_personal_resource_attachment('
      || 'uuid,uuid,uuid,uuid,text,integer,boolean,integer) '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.admit_session_attempt_personal_resources_v1() '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.resolve_session_attempt_personal_resources(uuid,uuid,uuid) '
      || 'SET search_path TO pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.accept_turn_personal_resource_attachment('
        || 'uuid,uuid,uuid,uuid,text,integer,boolean,integer) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.resolve_session_attempt_personal_resources('
        || 'uuid,uuid,uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$atomic_personal_resource_function_hardening$;
