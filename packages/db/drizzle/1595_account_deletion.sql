-- deployment-mode: rolling
-- Old binaries keep all existing grants. New runtime-callable definers are
-- deliberately withheld until a deployed previous binary declares them.
SET LOCAL lock_timeout = '5s';

CREATE TABLE account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text NOT NULL UNIQUE REFERENCES auth_users(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES canonical_human_identities(id) ON DELETE RESTRICT,
  subject_id text NOT NULL,
  operation_id uuid NOT NULL,
  admission_session_id text,
  email text,
  plan jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','blocked','completed')),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  retention_operations jsonb NOT NULL DEFAULT '{}'::jsonb,
  workspace_cleanup jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocked_step text,
  blocked_reason text,
  blocked_since timestamptz,
  terminal_failure boolean NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_progress_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  next_dispatch_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  workflow_finished_at timestamptz,
  completed_at timestamptz,
  worker_ticket uuid NOT NULL DEFAULT gen_random_uuid(),
  CHECK (subject_id = 'user:' || auth_user_id),
  CHECK ((completed_at IS NOT NULL) = (status = 'completed')),
  CHECK (completed_at IS NULL OR (email IS NULL AND admission_session_id IS NULL))
);
CREATE INDEX account_deletion_dispatch_idx ON account_deletion_requests (next_dispatch_check_at, id)
  WHERE workflow_finished_at IS NULL AND NOT terminal_failure;
ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY account_deletion_owner ON account_deletion_requests TO CURRENT_USER USING (true);
REVOKE ALL ON account_deletion_requests FROM PUBLIC;
DO $access$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT rolname FROM pg_roles WHERE rolname = 'opengeni_app'
      OR rolname IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb))
  LOOP
    EXECUTE format('REVOKE ALL ON account_deletion_requests FROM %I', application_role);
  END LOOP;
END $access$;

CREATE OR REPLACE FUNCTION opengeni_private.organization_membership_history_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'organization_membership_operation_receipts' THEN
    IF CURRENT_USER = (SELECT pg_get_userbyid(relowner) FROM pg_class
      WHERE oid = to_regclass(format('%I.account_deletion_requests', TG_TABLE_SCHEMA)))
    AND OLD.action = 'invite' AND OLD.result->>'targetEmail' = current_setting('opengeni.account_deletion_invitation_email', true)
    AND to_jsonb(OLD) - 'result' = to_jsonb(NEW) - 'result'
    AND NEW.result - ARRAY['targetName', 'targetEmail'] = OLD.result - ARRAY['targetName', 'targetEmail']
    AND NEW.result->>'targetEmail' LIKE 'deleted-%@account.invalid' AND NOT NEW.result ? 'targetName'
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'organization membership history is immutable' USING ERRCODE = '55000';
END $$;

-- Only the owner routine can inventory personal file keys in an organization
-- that is closing. The runtime setting alone cannot cross the file policy.
DO $policies$
DECLARE
  existing_expression text;
BEGIN
  SELECT pg_get_expr(polqual, polrelid) INTO STRICT existing_expression
  FROM pg_policy WHERE polrelid = 'files'::regclass AND polname = 'files_personal_owner';
  EXECUTE format('ALTER POLICY files_personal_owner ON files USING ((%s) OR
    (CURRENT_USER = %L AND workspace_id::text = current_setting(''opengeni.account_deletion_file_inventory'', true)))',
    existing_expression, CURRENT_USER);
END $policies$;

-- The two back edges keep full referential integrity at commit while allowing
-- the retention eraser to remove the entire graph in one transaction.
ALTER TABLE editable_artifacts
  DROP CONSTRAINT editable_artifacts_current_snapshot_fk,
  ADD CONSTRAINT editable_artifacts_current_snapshot_fk
    FOREIGN KEY (account_id, workspace_id, id, current_snapshot_id)
    REFERENCES editable_artifact_snapshots(account_id, workspace_id, artifact_id, id)
    DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE editable_artifact_sequence_checkpoints
  DROP CONSTRAINT editable_artifact_sequence_checkpoints_transaction_fk,
  ADD CONSTRAINT editable_artifact_sequence_checkpoints_transaction_fk
    FOREIGN KEY (account_id, workspace_id, artifact_id, transaction_id)
    REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id)
    DEFERRABLE INITIALLY DEFERRED NOT VALID;

CREATE OR REPLACE FUNCTION opengeni_private.reject_editable_artifact_history_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class
      WHERE oid = to_regclass(format('%I.account_deletion_requests', TG_TABLE_SCHEMA)))
    AND OLD.workspace_id::text = current_setting('opengeni.editable_retention_workspace', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is immutable; use an explicit maintenance migration', TG_TABLE_NAME
    USING ERRCODE = '55000';
END $$;

CREATE FUNCTION opengeni_private.erase_editable_workspace_retention_v1(p_workspace uuid)
RETURNS void LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  v_table text;
  previous_scope text := current_setting('opengeni.workspace_id', true);
  previous_authority text := current_setting('opengeni.editable_retention_workspace', true);
BEGIN
  IF p_workspace IS NULL THEN RETURN; END IF;
  PERFORM set_config('opengeni.workspace_id', p_workspace::text, true);
  PERFORM set_config('opengeni.editable_retention_workspace', p_workspace::text, true);
  SET CONSTRAINTS editable_artifacts_current_snapshot_fk, editable_artifact_sequence_checkpoints_transaction_fk DEFERRED;
  FOREACH v_table IN ARRAY ARRAY[
    'editable_artifact_replica_leases', 'editable_artifact_live_outbox',
    'editable_artifact_materialization_results', 'editable_artifact_materialization_jobs',
    'editable_artifact_versions', 'editable_artifact_snapshots',
    'editable_artifact_blob_refs', 'editable_artifact_idempotency_receipts',
    'editable_artifact_operations', 'editable_artifact_undo_claims',
    'editable_artifact_transactions', 'editable_artifact_sequence_checkpoints',
    'editable_artifacts'
  ] LOOP
    EXECUTE format('DELETE FROM %I WHERE workspace_id = $1', v_table) USING p_workspace;
  END LOOP;
  PERFORM set_config('opengeni.editable_retention_workspace', coalesce(previous_authority, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_scope, ''), true);
END $$;
REVOKE ALL ON FUNCTION opengeni_private.erase_editable_workspace_retention_v1(uuid) FROM PUBLIC;

-- The ordinary operator sweep and the targeted account-deletion sweep use the
-- same storage obligations, including Site SQL (an ID, not an object key).
ALTER TABLE organization_user_retention_object_obligations
  DROP CONSTRAINT organization_user_retention_object_obligations_shape_check,
  ADD CONSTRAINT organization_user_retention_object_obligations_shape_check CHECK (
    object_kind IN ('file','session_recording','browser_state_artifact','browser_state_upload',
      'transcription_recording_object','video_staging_reference','workspace_artifact_version',
      'editable_artifact_blob','workspace_capture_manifest','workspace_capture_tree_index',
      'workspace_capture_blob','site_file','site_sql','recording_chunk','app_package_export')
    AND octet_length(source_id) BETWEEN 1 AND 2048
    AND octet_length(convert_to(object_bucket, 'UTF8')) BETWEEN 1 AND 1024
    AND octet_length(convert_to(object_key, 'UTF8')) BETWEEN 1 AND 4096
  ) NOT VALID;

DO $patch$
DECLARE
  definition text := pg_get_functiondef('opengeni_private.organization_retention_object_candidates(uuid,uuid)'::regprocedure);
  anchor constant text := $a$  ORDER BY 1, 2$a$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'account deletion retention storage anchor drift';
  END IF;
  EXECUTE replace(definition, anchor, $body$
  UNION ALL
  SELECT 'site_file', f.id::text, NULL::text, f.object_key
  FROM site_data_files f CROSS JOIN member WHERE f.account_id = p_account_id AND f.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'site_sql', s.site_id::text, NULL::text, s.site_id::text
  FROM site_sql_databases s CROSS JOIN member WHERE s.account_id = p_account_id AND s.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'recording_chunk', r.recording_id::text || ':' || r.track_number || ':' || r.chunk_number, NULL::text, r.object_key
  FROM recording_chunks r CROSS JOIN member WHERE r.account_id = p_account_id AND r.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'app_package_export', x.object_key, NULL::text, x.object_key
  FROM app_package_exports x CROSS JOIN member WHERE x.account_id = p_account_id AND x.workspace_id = member.personal_workspace_id
$body$ || anchor);
END $patch$;

DO $patch$
DECLARE
  definition text := pg_get_functiondef(format('%I.finalize_organization_retention_deletion(uuid,uuid,uuid,text)', current_schema())::regprocedure);
  anchor constant text := $a$  GET DIAGNOSTICS object_count = ROW_COUNT;$a$;
  hash_anchor constant text := $a$digest(candidate.object_key, 'sha256')$a$;
  inventory_anchor constant text := $a$  INSERT INTO organization_user_retention_object_obligations ($a$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor)
    OR length(definition) - length(replace(definition, hash_anchor, '')) <> length(hash_anchor)
    OR length(definition) - length(replace(definition, inventory_anchor, '')) <> length(inventory_anchor) THEN
    RAISE EXCEPTION 'account deletion editable retention anchor drift';
  END IF;
  definition := replace(definition, hash_anchor,
    'pg_catalog.sha256(pg_catalog.convert_to(candidate.object_key, ''UTF8''))');
  definition := replace(definition, inventory_anchor, $body$
  PERFORM set_config('opengeni.workspace_id', coalesce(member.personal_workspace_id::text, ''), true);
  PERFORM 1 FROM site_data_files WHERE workspace_id = member.personal_workspace_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM site_sql_databases WHERE workspace_id = member.personal_workspace_id ORDER BY site_id FOR UPDATE;
  PERFORM 1 FROM recording_chunks WHERE workspace_id = member.personal_workspace_id ORDER BY recording_id, track_number, chunk_number FOR UPDATE;
  PERFORM 1 FROM app_package_exports WHERE workspace_id = member.personal_workspace_id ORDER BY object_key FOR UPDATE;
$body$ || inventory_anchor);
  EXECUTE replace(definition, anchor, anchor || $body$
  IF nullif(current_setting('opengeni.account_deletion_retention_request', true), '') IS NOT NULL THEN
    PERFORM opengeni_private.erase_editable_workspace_retention_v1(member.personal_workspace_id);
  END IF;$body$);
END
$patch$;

DO $patch$
DECLARE
  definition text := pg_get_functiondef(format('%I.record_organization_retention_object_deleted(uuid,uuid,uuid,text,text,text,text)', current_schema())::regprocedure);
  anchor constant text := $a$digest(p_object_key, 'sha256')$a$;
  kinds_anchor constant text := $a$      'workspace_capture_blob'
    )$a$;
  begin_anchor constant text := $a$BEGIN
  IF p_object_kind NOT IN ($a$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor)
    OR length(definition) - length(replace(definition, kinds_anchor, '')) <> length(kinds_anchor)
    OR length(definition) - length(replace(definition, begin_anchor, '')) <> length(begin_anchor) THEN
    RAISE EXCEPTION 'account deletion retention object hash anchor drift';
  END IF;
  definition := replace(definition, anchor, 'pg_catalog.sha256(pg_catalog.convert_to(p_object_key, ''UTF8''))');
  definition := replace(definition, begin_anchor, $r$BEGIN
  IF p_object_kind = 'site_sql' THEN
    IF p_source_id NOT LIKE 'site-sql-confirmed:%' THEN
      RAISE EXCEPTION 'Site SQL cleanup requires an updated retention operator' USING ERRCODE = '22023';
    END IF;
    p_source_id := substr(p_source_id, length('site-sql-confirmed:') + 1);
  END IF;
  IF p_object_kind NOT IN ($r$);
  EXECUTE replace(definition, kinds_anchor, $r$      'workspace_capture_blob', 'site_file', 'site_sql', 'recording_chunk', 'app_package_export'
    )$r$);
END $patch$;

-- Reuse the existing seat trigger's owner context for the organization
-- closure check; previous binaries reject any new callable trigger definer.
DO $patch$
DECLARE
  definition text := pg_get_functiondef('opengeni_private.enforce_organization_plan_seats()'::regprocedure);
  anchor constant text := $a$  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);$a$;
  begin_anchor constant text := $a$BEGIN
$a$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor)
    OR length(definition) - length(replace(definition, begin_anchor, '')) <> length(begin_anchor) THEN
    RAISE EXCEPTION 'account deletion seat fence anchor drift';
  END IF;
  definition := replace(definition, begin_anchor, begin_anchor || $body$
  IF TG_TABLE_NAME = 'billing_customers' THEN
    IF NOT EXISTS (SELECT FROM managed_accounts account WHERE account.id = NEW.account_id
      AND account.closed_by_account_deletion IS NOT NULL) THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext(NEW.account_id::text));
    IF EXISTS (SELECT FROM managed_accounts account WHERE account.id = NEW.account_id
      AND account.closed_by_account_deletion IS NOT NULL) THEN RETURN NULL; END IF;
    RETURN NEW;
  END IF;
$body$);
  EXECUTE replace(definition, anchor, anchor || $body$
  IF NEW.status IN ('active','suspended','pending','provisioning') THEN
  IF coalesce(to_jsonb(NEW)->>'subject_id', to_jsonb(NEW)->>'target_subject_id') LIKE 'user:%'
    AND NOT pg_try_advisory_xact_lock_shared(hashtextextended('canonical-human-user:' ||
      substr(coalesce(to_jsonb(NEW)->>'subject_id', to_jsonb(NEW)->>'target_subject_id'), 6), 0)) THEN
    RAISE EXCEPTION 'person account is busy' USING ERRCODE = '55P03';
  END IF;
  IF EXISTS (SELECT 1 FROM managed_accounts WHERE id = NEW.account_id
      AND closed_by_account_deletion IS NOT NULL)
    OR EXISTS (SELECT 1 FROM account_deletion_requests
      WHERE subject_id = coalesce(to_jsonb(NEW)->>'subject_id', to_jsonb(NEW)->>'target_subject_id')) THEN
    RAISE EXCEPTION 'organization or account is being deleted' USING ERRCODE = '42501';
  END IF;
  END IF;$body$);
END
$patch$;
CREATE TRIGGER ignore_closed_organization_billing_customer
  BEFORE INSERT ON billing_customers FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.enforce_organization_plan_seats();

DO $patch$
DECLARE
  definition text := pg_get_functiondef(format('%I.managed_auth_session_exact_binding_stamp()', current_schema())::regprocedure);
  anchor constant text := $a$      IF NEW.login_binding_id IS NULL THEN$a$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'account deletion sign-in fence anchor drift';
  END IF;
  EXECUTE replace(definition, anchor, $body$      IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('canonical-human-user:' || NEW.user_id, 0)) THEN
        RAISE EXCEPTION 'person account is busy' USING ERRCODE = '55P03';
      END IF;
      IF EXISTS (SELECT 1 FROM account_deletion_requests WHERE auth_user_id = NEW.user_id) THEN
        RAISE EXCEPTION 'account is being deleted' USING ERRCODE = '42501';
      END IF;
$body$ || anchor);
END
$patch$;

-- Map leave to the same durable offboard audit and wire events. The original
-- input (including action 'leave') still participates in the receipt hash.
-- Preparation, the wrapper and the command must agree on this normalization.
DO $patch$
DECLARE
  signature text;
  definition text;
  anchor text;
  replacement text;
  n integer;
  expected integer;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'organization_membership_command(jsonb)',
    'organization_membership_command_0263(jsonb)',
    'prepare_organization_membership_protocol_settlements(jsonb)'
  ] LOOP
    definition := pg_get_functiondef(format('%I.%s', current_schema(), signature)::regprocedure);
    FOR anchor, replacement, expected IN SELECT a, r, CASE signature
      WHEN 'organization_membership_command(jsonb)' THEN wrapper_count
      WHEN 'organization_membership_command_0263(jsonb)' THEN command_count
      ELSE prepare_count END FROM (VALUES
      ($a$  action_name text := p_command ->> 'action';$a$,
       $r$  self_leave boolean := p_command ->> 'action' = 'leave';
  action_name text := CASE WHEN self_leave THEN 'offboard' ELSE p_command ->> 'action' END;$r$, 1, 1, 1),
      ($a$  IF actor.role = 'admin' AND target.role <> 'member' THEN$a$,
       $r$  IF self_leave AND (service_authorized OR actor.id IS DISTINCT FROM target.id OR actor_subject NOT LIKE 'user:%') THEN
        RAISE EXCEPTION 'only the person leaving may use self-offboard' USING ERRCODE = '42501';
      END IF;
      IF NOT self_leave AND actor.role = 'admin' AND target.role <> 'member' THEN$r$, 0, 1, 1),
      ($a$IF NOT service_authorized AND (NOT FOUND OR actor.status <> 'active') THEN$a$,
       $r$IF NOT service_authorized AND (NOT FOUND OR (actor.status <> 'active'
      AND NOT (self_leave AND actor.status = 'suspended'))) THEN$r$, 0, 1, 0),
      ($a$IF NOT service_authorized AND actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_id := nullif(p_command ->> 'membershipId', '')::uuid;$a$,
       $r$IF NOT self_leave AND NOT service_authorized AND actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_id := nullif(p_command ->> 'membershipId', '')::uuid;$r$, 0, 1, 0),
      ($a$IF NOT service_authorized AND (actor.id IS NULL OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin')) THEN$a$,
       $r$IF NOT service_authorized AND (actor.id IS NULL OR
    (self_leave AND actor.status NOT IN ('active','suspended')) OR
    (NOT self_leave AND (actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin')))) THEN$r$, 0, 0, 1),
      ($a$RAISE EXCEPTION 'cannot remove the last active organization owner'$a$,
       $r$IF NOT (self_leave AND NOT EXISTS (
          SELECT 1 FROM organization_memberships other
          WHERE other.account_id = account_id_value AND other.id <> target.id AND other.status <> 'revoked'
        ) AND EXISTS (
          SELECT 1 FROM account_deletion_requests pending
          WHERE pending.subject_id = actor_subject AND pending.status = 'pending'
            AND pending.plan @> jsonb_build_array(jsonb_build_object('membershipId', target.id, 'kind', 'close'))
        )) THEN
          RAISE EXCEPTION 'cannot remove the last active organization owner' USING ERRCODE = '55000';
        END IF;
        PERFORM 1$r$, 0, 1, 1)
    ) AS anchors(a,r,wrapper_count,command_count,prepare_count) LOOP
      n := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
      IF n <> expected THEN
        RAISE EXCEPTION 'account deletion leave anchor drift in %: % (expected %, found %)', signature, anchor, expected, n;
      END IF;
      IF n = 1 THEN definition := replace(definition, anchor, replacement); END IF;
    END LOOP;
    IF regexp_count(definition, 'PERFORM 1[[:space:]]+USING ERRCODE = ''55000'';') <>
      (CASE WHEN signature = 'organization_membership_command(jsonb)' THEN 0 ELSE 1 END) THEN
      RAISE EXCEPTION 'account deletion leave suffix drift in %', signature;
    END IF;
    -- The original RAISE's suffix is not legal on the no-op branch.
    definition := regexp_replace(definition, 'PERFORM 1[[:space:]]+USING ERRCODE = ''55000'';', 'PERFORM 1;');
    EXECUTE definition;
  END LOOP;
END
$patch$;

-- Optional targeted filtering never widens the old eligibility rules, and
-- ordinary sweeps see the original query and ordering.
DO $patch$
DECLARE
  definition text := pg_get_functiondef(format('%I.claim_organization_retention_deletion(uuid,uuid,uuid[])', current_schema())::regprocedure);
  anchor constant text := $a$    AND NOT (membership.id = ANY(p_excluded_membership_ids))$a$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'account deletion targeted claim anchor drift';
  END IF;
  EXECUTE replace(definition, anchor, anchor || $r$
    AND membership.id = coalesce(nullif(current_setting('opengeni.retention_target_membership', true), '')::uuid, membership.id)$r$);
END
$patch$;

CREATE FUNCTION opengeni_private.account_deletion_receipt_v1(p_row account_deletion_requests)
RETURNS jsonb LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object('id', p_row.id, 'operationId', p_row.operation_id,
    'status', p_row.status, 'requestedAt', p_row.requested_at, 'completedAt', p_row.completed_at)
$$;

CREATE FUNCTION opengeni_private.account_deletion_user_v1(p_action text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  user_value text := p_args->>'authUserId';
  session_value text := p_args->>'authSessionId';
  subject_value text := 'user:' || user_value;
  operation_value uuid := (p_args->>'operationId')::uuid;
  identity_value uuid;
  existing account_deletion_requests%ROWTYPE;
  candidate jsonb;
  plan_value jsonb;
  workspace_value uuid;
  original_lock_timeout text := current_setting('lock_timeout');
BEGIN
  IF nullif(user_value, '') IS NULL OR nullif(session_value, '') IS NULL
    OR p_action NOT IN ('preview','start','seal') THEN
    RAISE EXCEPTION 'invalid account deletion admission' USING ERRCODE = '22023';
  END IF;
  IF p_action <> 'preview' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('canonical-human-user:' || user_value, 0));
  END IF;
  SELECT * INTO existing FROM account_deletion_requests WHERE auth_user_id = user_value;
  IF existing.id IS NOT NULL THEN
    IF p_action = 'seal' AND existing.operation_id = operation_value
      AND existing.admission_session_id = session_value AND existing.status = 'pending' THEN
      PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
      FOR candidate IN SELECT value FROM jsonb_array_elements(existing.plan) LOOP
        IF candidate->>'kind' = 'close' THEN
          IF EXISTS (SELECT 1 FROM organization_memberships
              WHERE account_id = (candidate->>'organizationId')::uuid AND status <> 'revoked') THEN
            RAISE EXCEPTION 'cannot close organization with remaining members' USING ERRCODE = '55000';
          END IF;
          PERFORM set_config('opengeni.account_id', candidate->>'organizationId', true);
          PERFORM set_config('lock_timeout', '2s', true);
          PERFORM pg_advisory_xact_lock(hashtext(candidate->>'organizationId'));
          PERFORM set_config('lock_timeout', original_lock_timeout, true);
          FOR workspace_value IN SELECT id FROM workspaces WHERE account_id = (candidate->>'organizationId')::uuid ORDER BY id LOOP
            PERFORM set_config('opengeni.workspace_id', workspace_value::text, true);
            UPDATE scheduled_tasks SET status = 'paused', updated_at = clock_timestamp()
              WHERE workspace_id = workspace_value AND status <> 'paused';
            UPDATE event_triggers SET status = 'disabled', status_reason = 'Organization closed',
              status_reason_code = 'organization_closed', status_reason_detail = NULL, updated_at = clock_timestamp()
              WHERE workspace_id = workspace_value AND status <> 'disabled';
          END LOOP;
          PERFORM set_config('opengeni.workspace_id', '', true);
          UPDATE billing_auto_top_up_settings SET enabled = false, updated_at = clock_timestamp()
            WHERE account_id = (candidate->>'organizationId')::uuid;
          UPDATE api_keys SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
            WHERE account_id = (candidate->>'organizationId')::uuid AND revoked_at IS NULL;
          -- An empty organization is no longer a retaining controller. Do
          -- not change the deadline under a live or finalized storage claim.
          UPDATE organization_memberships membership SET personal_retention_until = clock_timestamp()
          WHERE account_id = (candidate->>'organizationId')::uuid AND status = 'revoked'
            AND (personal_retention_until IS NULL OR personal_retention_until > clock_timestamp())
            AND NOT EXISTS (SELECT 1 FROM organization_user_retention_deletions d
              WHERE d.account_id = membership.account_id AND d.membership_id = membership.id);
        END IF;
      END LOOP;
      -- All membership, workspace and schedule accesses happen before taking
      -- the stronger managed-account row locks, including across organizations.
      FOR candidate IN SELECT value FROM jsonb_array_elements(existing.plan) LOOP
        IF candidate->>'kind' = 'close' THEN
          PERFORM set_config('opengeni.account_id', candidate->>'organizationId', true);
          UPDATE managed_accounts SET closed_by_account_deletion = existing.id
            WHERE id = (candidate->>'organizationId')::uuid;
        END IF;
      END LOOP;
      IF EXISTS (SELECT 1 FROM organization_memberships
          WHERE subject_id = subject_value AND status <> 'revoked') THEN
        RAISE EXCEPTION 'account still has live memberships' USING ERRCODE = '40001';
      END IF;
      UPDATE canonical_human_identities SET status = 'disabled', recovery_state = 'disabled',
        active_login_binding_id = NULL, auth_revision = auth_revision + 1, updated_at = clock_timestamp()
      WHERE id = existing.identity_id;
      UPDATE canonical_human_identity_subjects SET status = 'revoked', revision = revision + 1,
        updated_at = clock_timestamp() WHERE auth_user_id = user_value;
      DELETE FROM auth_sessions WHERE user_id = user_value;
    ELSIF p_action <> 'start' OR existing.admission_session_id IS DISTINCT FROM session_value
      OR existing.operation_id IS DISTINCT FROM operation_value THEN
      RAISE EXCEPTION 'live account session required' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('request', opengeni_private.account_deletion_receipt_v1(existing));
  END IF;
  IF p_action = 'seal' OR NOT validate_canonical_human_session(session_value, user_value)
    OR NOT EXISTS (SELECT 1 FROM auth_sessions WHERE id = session_value AND user_id = user_value
      AND expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'live account session required' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF p_action = 'start' THEN
    -- Keep the ordinary membership fence across acceptance and self-offboard.
    -- Sort to prevent two multi-organization deletions from inverting locks.
    FOR candidate IN SELECT jsonb_build_object('id', account_id) FROM organization_memberships
      WHERE subject_id = subject_value ORDER BY account_id LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || (candidate->>'id'), 0));
    END LOOP;
  END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY item->>'organizationId'), '[]'::jsonb) INTO plan_value
  FROM (
    SELECT jsonb_build_object('organizationId', membership.account_id, 'name', account.name,
      'membershipId', membership.id, 'revision', membership.authorization_revision,
      'retention', jsonb_build_object('mode', coalesce(policy.mode, 'retain'), 'days', policy.retention_days),
      'kind', CASE
        WHEN membership.status = 'revoked' THEN 'revoked'
        WHEN NOT coalesce(peers.has_peer, false) THEN 'close'
        WHEN membership.role = 'owner' AND NOT coalesce(peers.has_owner, false) THEN 'block'
        ELSE 'leave' END) AS item
    FROM organization_memberships membership
    JOIN managed_accounts account ON account.id = membership.account_id
    LEFT JOIN organization_user_retention_policies policy ON policy.account_id = membership.account_id
    CROSS JOIN LATERAL (
      SELECT bool_or(other.status <> 'revoked') has_peer,
             bool_or(other.status = 'active' AND other.role = 'owner') has_owner
        FROM organization_memberships other WHERE other.account_id = membership.account_id AND other.id <> membership.id
    ) peers
    WHERE membership.subject_id = subject_value
  ) candidates;
  IF p_action = 'preview' OR plan_value @> '[{"kind":"block"}]'::jsonb THEN
    RETURN jsonb_build_object('plan', plan_value);
  END IF;
  IF operation_value IS NULL THEN RAISE EXCEPTION 'operation id required' USING ERRCODE = '22023'; END IF;
  SELECT identity_id INTO STRICT identity_value FROM auth_sessions
    WHERE id = session_value AND user_id = user_value AND expires_at > clock_timestamp();
  INSERT INTO account_deletion_requests (auth_user_id, identity_id, subject_id, operation_id, admission_session_id, email, plan)
    SELECT user_value, identity_value, subject_value, operation_value, session_value, email,
      coalesce((SELECT jsonb_agg(value - 'name') FROM jsonb_array_elements(plan_value)), '[]'::jsonb)
    FROM auth_users WHERE id = user_value RETURNING * INTO STRICT existing;
  RETURN jsonb_build_object('plan', plan_value, 'request', opengeni_private.account_deletion_receipt_v1(existing));
END
$$;

CREATE FUNCTION opengeni_private.account_deletion_work_v1(p_action text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  request_value uuid := (p_args->>'requestId')::uuid;
  organization_value uuid := (p_args->>'organizationId')::uuid;
  membership_value uuid := (p_args->>'membershipId')::uuid;
  operation_value uuid;
  row_value account_deletion_requests%ROWTYPE;
  result_value jsonb;
  tombstone text;
  workspace_value uuid := (p_args->>'workspaceId')::uuid;
  configured_bucket text := nullif(p_args->>'bucket', '');
BEGIN
  IF p_action = 'due' THEN
    WITH eligible AS (
      SELECT id FROM account_deletion_requests
      WHERE workflow_finished_at IS NULL AND NOT terminal_failure AND next_dispatch_check_at <= clock_timestamp()
      ORDER BY next_dispatch_check_at, id LIMIT 50 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE account_deletion_requests request SET next_dispatch_check_at = clock_timestamp() + interval '2 minutes'
      FROM eligible WHERE request.id = eligible.id RETURNING request.id
    ) SELECT coalesce(jsonb_agg(id), '[]'::jsonb) INTO result_value FROM claimed;
    RETURN result_value;
  END IF;
  IF p_action = 'metrics' THEN
    SELECT jsonb_build_object(
      'blocked', count(*) FILTER (WHERE blocked_step IS NOT NULL),
      'terminal', count(*) FILTER (WHERE terminal_failure),
      'overdue', count(*) FILTER (WHERE completed_at IS NULL AND requested_at < clock_timestamp() - interval '30 days'),
      'stalled', count(*) FILTER (WHERE (completed_at IS NULL OR blocked_step IS NOT NULL)
        AND last_progress_at < clock_timestamp() - interval '24 hours')
    ) INTO result_value FROM account_deletion_requests WHERE workflow_finished_at IS NULL OR terminal_failure;
    RETURN result_value;
  END IF;
  IF p_action = 'dispatched' THEN
    UPDATE account_deletion_requests SET dispatched_at = clock_timestamp()
      WHERE id = request_value AND dispatched_at IS NULL;
    RETURN NULL;
  END IF;
  SELECT * INTO row_value FROM account_deletion_requests WHERE id = request_value FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_action = 'ticket' THEN RETURN to_jsonb(row_value.worker_ticket); END IF;
  IF (p_args->>'ticket')::uuid IS DISTINCT FROM row_value.worker_ticket THEN RETURN NULL; END IF;
  IF p_action = 'open' THEN
    RETURN jsonb_build_object('id', row_value.id, 'status', row_value.status,
      'authUserId', row_value.auth_user_id, 'email', row_value.email, 'subjectId', row_value.subject_id,
      'plan', row_value.plan, 'progress', row_value.progress, 'terminalFailure', row_value.terminal_failure,
      'stalledSince', row_value.blocked_since, 'blockedStep', row_value.blocked_step);
  END IF;
  IF p_action = 'apple_needed' THEN
    RETURN to_jsonb(EXISTS (SELECT FROM auth_identities WHERE user_id = row_value.auth_user_id AND provider_id = 'apple'));
  END IF;
  IF p_action = 'block' THEN
    UPDATE account_deletion_requests SET status = CASE WHEN completed_at IS NULL THEN 'blocked' ELSE status END,
      blocked_since = CASE WHEN blocked_step IS DISTINCT FROM p_args->>'step' THEN clock_timestamp()
        ELSE coalesce(blocked_since, clock_timestamp()) END,
      blocked_step = left(p_args->>'step', 160), blocked_reason = left(p_args->>'reason', 80),
      terminal_failure = terminal_failure OR coalesce(p_args->>'terminal' = 'true', false),
      last_progress_at = clock_timestamp() WHERE id = request_value;
    RETURN NULL;
  END IF;
  IF p_action = 'progress' THEN
    UPDATE account_deletion_requests SET progress = progress || jsonb_build_object(p_args->>'step', true),
      status = CASE WHEN completed_at IS NULL THEN 'running' ELSE status END,
      blocked_step = NULL, blocked_reason = NULL, blocked_since = NULL, last_progress_at = clock_timestamp()
    WHERE id = request_value;
    RETURN NULL;
  END IF;
  IF p_action = 'workflow_finished' THEN
    UPDATE account_deletion_requests SET workflow_finished_at = clock_timestamp(),
      blocked_step = NULL, blocked_reason = NULL, blocked_since = NULL
      WHERE id = request_value AND completed_at IS NOT NULL AND NOT terminal_failure;
    RETURN NULL;
  END IF;
  IF p_action = 'resume_blocked' THEN
    UPDATE account_deletion_requests SET terminal_failure = false, next_dispatch_check_at = clock_timestamp(),
      blocked_since = NULL, blocked_step = NULL, blocked_reason = NULL, last_progress_at = clock_timestamp()
      WHERE id = request_value AND terminal_failure;
    RETURN to_jsonb(FOUND);
  END IF;
  IF p_action = 'finish' THEN
    UPDATE account_deletion_requests SET status = 'completed', completed_at = clock_timestamp(),
      email = NULL, admission_session_id = NULL, blocked_step = NULL, blocked_reason = NULL, blocked_since = NULL,
      last_progress_at = clock_timestamp()
    WHERE id = request_value AND completed_at IS NULL AND progress @> '{"identity":true,"email":true,"apple":true}'
      AND workspace_cleanup = '{}'::jsonb
      AND NOT EXISTS (SELECT FROM jsonb_array_elements(plan) AS org
        WHERE org->>'kind' = 'close' AND NOT progress ? ('organization:' || (org->>'organizationId')));
    RETURN to_jsonb(FOUND OR row_value.completed_at IS NOT NULL);
  END IF;
  IF p_action = 'identity' THEN
    IF row_value.progress @> '{"identity":true}' THEN RETURN NULL; END IF;
    IF NOT row_value.progress @> '{"apple":true}' THEN
      RAISE EXCEPTION 'Apple revocation has not been recorded' USING ERRCODE = '55000';
    END IF;
    PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
    PERFORM set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
    PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
    -- Consent is delivered independently. Keep old installations with no
    -- consent table working; the consent policy scopes the delete to this user.
    IF to_regclass('ai_processing_consents') IS NOT NULL THEN
      PERFORM set_config('opengeni.subject_id', row_value.subject_id, true);
      EXECUTE 'DELETE FROM ai_processing_consents WHERE auth_user_id = $1' USING row_value.auth_user_id;
    END IF;
    tombstone := 'deleted-' || request_value || '@account.invalid';
    -- Remove unreferenced invitations outright. References with independent
    -- audit obligations keep only a revoked, pseudonymous invitation stub.
    DELETE FROM organization_membership_invitations invite
    WHERE invite.status = 'pending' AND (invite.target_email = lower(row_value.email) OR invite.target_subject_id = row_value.subject_id)
      AND NOT EXISTS (SELECT FROM organization_invitation_binding_events e WHERE e.invitation_id = invite.id)
      AND NOT EXISTS (SELECT FROM organization_user_setup_intents i WHERE i.invitation_id = invite.id)
      AND NOT EXISTS (SELECT FROM organization_user_setup_deliveries d WHERE d.invitation_id = invite.id);
    UPDATE organization_membership_invitations invite
      SET target_email = tombstone, target_name = NULL, target_subject_id = NULL,
        status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END,
        revision = revision + 1, updated_at = clock_timestamp()
      WHERE invite.target_email = lower(row_value.email) OR invite.target_subject_id = row_value.subject_id;
    UPDATE organization_user_setup_deliveries SET recipient_email = tombstone, recipient_name = NULL,
      updated_at = clock_timestamp() WHERE recipient_email = lower(row_value.email);
    PERFORM set_config('opengeni.account_deletion_invitation_email', lower(row_value.email), true);
    UPDATE organization_membership_operation_receipts SET result = (result - 'targetName') || jsonb_build_object('targetEmail', tombstone)
      WHERE action = 'invite' AND result->>'targetEmail' = lower(row_value.email);
    PERFORM set_config('opengeni.account_deletion_invitation_email', '', true);
    DELETE FROM auth_sessions WHERE user_id = row_value.auth_user_id;
    DELETE FROM auth_passkeys WHERE user_id = row_value.auth_user_id;
    DELETE FROM auth_identities WHERE user_id = row_value.auth_user_id;
    DELETE FROM auth_verifications WHERE identifier IN (row_value.email, row_value.auth_user_id)
      OR opengeni_private.account_deletion_verification_subject_v1(identifier, value) = row_value.auth_user_id;
    DELETE FROM managed_sign_in_method_operations WHERE auth_user_id = row_value.auth_user_id;
    UPDATE managed_auth_login_slots SET verified_email = tombstone, display_name = 'Deleted account',
      status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp()), updated_at = clock_timestamp()
      WHERE auth_user_id = row_value.auth_user_id;
    -- Recovery and audit FKs still point at bindings. Leave opaque, revoked
    -- stubs rather than retaining provider identifiers or a sign-in method.
    UPDATE canonical_human_login_bindings SET provider_account_id = 'deleted:' || id,
      status = 'revoked', revoked_at = coalesce(revoked_at, clock_timestamp()), updated_at = clock_timestamp()
      WHERE identity_id = row_value.identity_id;
    UPDATE canonical_human_identity_operations SET provider_account_id = NULL
      WHERE identity_id = row_value.identity_id;
    UPDATE canonical_human_identities SET display_name = 'Deleted account', updated_at = clock_timestamp()
      WHERE id = row_value.identity_id;
    UPDATE auth_users SET name = 'Deleted account', email = tombstone, email_verified = false,
      image = NULL, updated_at = clock_timestamp() WHERE id = row_value.auth_user_id;
    UPDATE account_deletion_requests SET progress = progress || '{"identity":true}', last_progress_at = clock_timestamp() WHERE id = request_value;
    RETURN NULL;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
  IF p_action = 'retention' THEN
    -- Due personal retention in surviving organizations applies only to the
    -- departing member. For closed organizations every revoked member is due.
    SELECT coalesce(jsonb_agg(jsonb_build_object('organizationId', m.account_id, 'membershipId', m.id,
      'dueAt', m.personal_retention_until) ORDER BY m.personal_retention_until, m.id), '[]'::jsonb)
    INTO result_value
    FROM organization_memberships m
    JOIN managed_accounts account ON account.id = m.account_id
    LEFT JOIN organization_user_retention_deletions d ON d.account_id = m.account_id AND d.membership_id = m.id
    WHERE m.status = 'revoked' AND m.personal_retention_until IS NOT NULL
      AND d.state IS DISTINCT FROM 'completed'
      AND (m.subject_id = row_value.subject_id OR account.closed_by_account_deletion = request_value);
    RETURN result_value;
  END IF;
  IF p_action = 'cleanup_inventory' THEN
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId', key, 'organizationId', value->>'organizationId') ORDER BY key)
      FROM jsonb_each(row_value.workspace_cleanup)), '[]'::jsonb);
  END IF;
  IF organization_value IS NULL OR NOT (
    row_value.plan @> jsonb_build_array(jsonb_build_object('organizationId', organization_value))
  ) THEN RAISE EXCEPTION 'account deletion organization mismatch' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('opengeni.account_id', organization_value::text, true);
  IF p_action = 'claim' THEN
    IF NOT EXISTS (SELECT 1 FROM organization_memberships membership JOIN managed_accounts account
      ON account.id = membership.account_id
      WHERE membership.account_id = organization_value AND membership.id = membership_value
        AND (membership.subject_id = row_value.subject_id OR account.closed_by_account_deletion = request_value))
    THEN RAISE EXCEPTION 'account deletion membership mismatch' USING ERRCODE = '42501'; END IF;
    SELECT claim_operation_id INTO operation_value FROM organization_user_retention_deletions
      WHERE account_id = organization_value AND membership_id = membership_value
        AND state = 'claimed' AND claim_expires_at > clock_timestamp();
    IF operation_value IS NOT NULL AND operation_value::text IS DISTINCT FROM
      row_value.retention_operations->>membership_value::text THEN RETURN NULL; END IF;
    operation_value := coalesce(operation_value, gen_random_uuid());
    PERFORM set_config('opengeni.retention_target_membership', membership_value::text, true);
    result_value := claim_organization_retention_deletion(organization_value, operation_value, ARRAY[]::uuid[]);
    IF result_value IS NOT NULL THEN
      UPDATE account_deletion_requests SET retention_operations = retention_operations ||
        jsonb_build_object(membership_value::text, operation_value), last_progress_at = clock_timestamp() WHERE id = request_value;
    END IF;
    RETURN result_value;
  END IF;
  IF p_action = 'finalize_retention' THEN
    operation_value := (p_args->>'operationId')::uuid;
    IF operation_value::text IS DISTINCT FROM row_value.retention_operations->>membership_value::text THEN
      RAISE EXCEPTION 'account deletion retention operation mismatch' USING ERRCODE = '42501';
    END IF;
    SELECT personal_workspace_id INTO workspace_value FROM organization_memberships
      WHERE id = membership_value AND account_id = organization_value;
    PERFORM set_config('opengeni.workspace_id', coalesce(workspace_value::text, ''), true);
    PERFORM set_config('opengeni.account_deletion_file_inventory', coalesce(workspace_value::text, ''), true);
    PERFORM set_config('opengeni.account_deletion_retention_request', request_value::text, true);
    PERFORM finalize_organization_retention_deletion(organization_value, membership_value, operation_value, configured_bucket);
    PERFORM set_config('opengeni.account_deletion_retention_request', '', true);
    PERFORM set_config('opengeni.account_deletion_file_inventory', '', true);
    RETURN NULL;
  END IF;
  IF p_action NOT IN ('cleanup_workspace', 'record_workspace_cleanup') AND NOT EXISTS (SELECT 1 FROM managed_accounts WHERE id = organization_value
    AND closed_by_account_deletion = request_value) THEN
    RAISE EXCEPTION 'account deletion closure mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_action = 'authorize_workspace_quiesce' THEN
    RETURN to_jsonb(EXISTS (SELECT FROM workspaces WHERE id = workspace_value AND account_id = organization_value));
  END IF;
  IF p_action = 'freeze_workspace' THEN
    PERFORM set_config('opengeni.workspace_id', workspace_value::text, true);
    PERFORM 1 FROM workspaces WHERE id = workspace_value AND account_id = organization_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'closure workspace missing' USING ERRCODE = 'P0002'; END IF;
    PERFORM set_config('opengeni.account_deletion_file_inventory', workspace_value::text, true);
    PERFORM 1 FROM site_data_files WHERE workspace_id = workspace_value ORDER BY id FOR UPDATE;
    PERFORM 1 FROM site_sql_databases WHERE workspace_id = workspace_value ORDER BY site_id FOR UPDATE;
    -- The caller holds the ordinary workspace deletion fences; this inventory
    -- and the cascade commit together. Retain exact addresses, not prefixes.
    SELECT coalesce(jsonb_agg(item ORDER BY item->>'kind', item->>'key'), '[]'::jsonb) INTO result_value
    FROM (SELECT DISTINCT jsonb_build_object('kind', source.kind, 'key', source.key, 'bucket', source.bucket) AS item
      FROM (
        SELECT 'object'::text kind, object_key key, bucket FROM files WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', storage_key, configured_bucket FROM session_recordings WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', object_key, configured_bucket FROM recording_chunks WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', object_key, configured_bucket FROM browser_state_artifacts WHERE workspace_id = workspace_value AND state <> 'deleted'
        UNION ALL SELECT 'object', object_key, configured_bucket FROM browser_state_uploads WHERE workspace_id = workspace_value AND state <> 'deleted'
        UNION ALL SELECT 'object', staging_object_key, configured_bucket FROM video_generation_references WHERE workspace_id = workspace_value AND cleaned_at IS NULL
        UNION ALL SELECT 'object', content_key, configured_bucket FROM workspace_artifact_versions WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', object_reference, configured_bucket FROM editable_artifact_blob_refs WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', manifest_key, configured_bucket FROM workspace_captures WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', tree_index_key, configured_bucket FROM workspace_captures WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', blob, configured_bucket FROM workspace_captures CROSS JOIN LATERAL jsonb_array_elements_text(blob_keys) AS blob WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', object_key, configured_bucket FROM app_package_exports WHERE workspace_id = workspace_value
        UNION ALL SELECT 'object', object_key, configured_bucket FROM site_data_files WHERE workspace_id = workspace_value
        UNION ALL SELECT 'site_sql', site_id::text, NULL FROM site_sql_databases WHERE workspace_id = workspace_value
      ) source WHERE nullif(source.key, '') IS NOT NULL
    ) entries;
    PERFORM set_config('opengeni.account_deletion_file_inventory', '', true);
    IF jsonb_array_length(result_value) > 0 THEN
      UPDATE account_deletion_requests SET workspace_cleanup = workspace_cleanup || jsonb_build_object(workspace_value::text,
        jsonb_build_object('organizationId', organization_value, 'items', result_value))
        WHERE id = request_value;
    END IF;
    PERFORM opengeni_private.erase_editable_workspace_retention_v1(workspace_value);
    RETURN NULL;
  END IF;
  IF p_action = 'cleanup_workspace' THEN
    IF row_value.workspace_cleanup->workspace_value::text->>'organizationId' IS DISTINCT FROM organization_value::text
      OR EXISTS (SELECT FROM workspaces WHERE id = workspace_value) THEN RETURN '[]'::jsonb; END IF;
    RETURN coalesce((SELECT jsonb_agg(value) FROM (SELECT value FROM jsonb_array_elements(row_value.workspace_cleanup->workspace_value::text->'items') LIMIT 10) batch), '[]'::jsonb);
  END IF;
  IF p_action = 'record_workspace_cleanup' THEN
    IF row_value.workspace_cleanup->workspace_value::text->>'organizationId' IS DISTINCT FROM organization_value::text
      OR EXISTS (SELECT FROM workspaces WHERE id = workspace_value) THEN RETURN NULL; END IF;
    SELECT coalesce(jsonb_agg(value), '[]'::jsonb) INTO result_value
    FROM jsonb_array_elements(row_value.workspace_cleanup->workspace_value::text->'items')
    WHERE value IS DISTINCT FROM jsonb_build_object('kind', p_args->>'kind', 'key', p_args->>'key', 'bucket', p_args->>'bucket');
    UPDATE account_deletion_requests SET workspace_cleanup = CASE WHEN jsonb_array_length(result_value) = 0
      THEN workspace_cleanup - workspace_value::text ELSE jsonb_set(workspace_cleanup, ARRAY[workspace_value::text, 'items'], result_value) END,
      last_progress_at = clock_timestamp()
      WHERE id = request_value;
    RETURN NULL;
  END IF;
  IF p_action = 'close_inventory' THEN
    RETURN jsonb_build_object(
      'workspaceIds', coalesce((SELECT jsonb_agg(id ORDER BY id) FROM workspaces WHERE account_id = organization_value), '[]'::jsonb),
      'stripeCustomers', coalesce((SELECT jsonb_agg(jsonb_build_object('provider', provider, 'id', provider_customer_id) ORDER BY provider)
        FROM billing_customers WHERE account_id = organization_value AND provider IN ('stripe','stripe:live','stripe:test')), '[]'::jsonb)
    );
  END IF;
  IF p_action = 'close_finish' THEN
    IF EXISTS (SELECT 1 FROM workspaces WHERE account_id = organization_value)
      OR EXISTS (SELECT FROM jsonb_each(row_value.workspace_cleanup) cleanup
        WHERE cleanup.value->>'organizationId' = organization_value::text) THEN
      RAISE EXCEPTION 'closed organization still has workspaces' USING ERRCODE = '55000';
    END IF;
    DELETE FROM billing_customers WHERE account_id = organization_value AND provider IN ('stripe','stripe:live','stripe:test');
    UPDATE managed_accounts SET name = 'Deleted organization', external_source = NULL,
      external_id = NULL, updated_at = clock_timestamp() WHERE id = organization_value;
    UPDATE account_deletion_requests SET progress = progress || jsonb_build_object('organization:' || organization_value, true),
      last_progress_at = clock_timestamp()
      WHERE id = request_value;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'invalid account deletion work action' USING ERRCODE = '22023';
END
$$;

REVOKE ALL ON FUNCTION opengeni_private.account_deletion_receipt_v1(account_deletion_requests) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.account_deletion_user_v1(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.account_deletion_work_v1(text, jsonb) FROM PUBLIC;

DO $paths$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.account_deletion_user_v1(text,jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.account_deletion_work_v1(text,jsonb) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.erase_editable_workspace_retention_v1(uuid) SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.account_deletion_receipt_v1(account_deletion_requests) SET search_path = pg_catalog, %I, pg_temp', current_schema());
END $paths$;
