-- deployment-mode: rolling
-- Explicit operation_read only. No mutation lease, retry queue, maintenance
-- scanner, credential storage, event append, or autonomous wake is introduced.
CREATE TABLE mcp_operations (
  operation_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  source_turn_id uuid NOT NULL,
  source_attempt_id uuid NOT NULL,
  source_execution_generation integer NOT NULL CHECK (source_execution_generation > 0),
  source_call_id text CHECK (octet_length(source_call_id) BETWEEN 1 AND 1024),
  principal_kind text NOT NULL CHECK (principal_kind IN ('subject', 'service')),
  principal_id text NOT NULL CHECK (octet_length(principal_id) BETWEEN 1 AND 1024),
  principal_membership_id uuid,
  principal_membership_revision bigint,
  server_id text NOT NULL CHECK (octet_length(server_id) BETWEEN 1 AND 512),
  original_tool text NOT NULL CHECK (octet_length(original_tool) BETWEEN 1 AND 512),
  observer_tool text NOT NULL CHECK (octet_length(observer_tool) BETWEEN 1 AND 512),
  argument_digest text NOT NULL CHECK (argument_digest ~ '^[a-f0-9]{64}$'),
  destination_digest text NOT NULL CHECK (destination_digest ~ '^[a-f0-9]{64}$'),
  authority_digest text NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
  original_outcome text NOT NULL DEFAULT 'captured' CHECK (original_outcome IN ('captured', 'completed', 'outcome_unknown')),
  original_result jsonb,
  original_result_codec_version integer CHECK (original_result_codec_version = 1),
  observation_result jsonb,
  observation_result_codec_version integer CHECK (observation_result_codec_version = 1),
  receipt_revision text CHECK (octet_length(receipt_revision) BETWEEN 1 AND 1024),
  receipt_digest text CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  observation_claim_id uuid,
  observation_claim_attempt_id uuid,
  observation_claim_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  observed_at timestamptz,
  CONSTRAINT mcp_operations_observer_check CHECK (original_tool <> observer_tool),
  CONSTRAINT mcp_operations_source_fk FOREIGN KEY
    (account_id, workspace_id, session_id, source_turn_id, source_attempt_id)
    REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE,
  CONSTRAINT mcp_operations_original_check CHECK (
    (original_outcome = 'completed') = (original_result IS NOT NULL)
    AND (original_result IS NULL OR (jsonb_typeof(original_result) = 'object' AND octet_length(original_result::text) <= 16777216))),
  CONSTRAINT mcp_operations_receipt_check CHECK (
    (observation_result IS NULL AND receipt_revision IS NULL AND receipt_digest IS NULL AND observed_at IS NULL)
    OR (jsonb_typeof(observation_result) = 'object' AND receipt_revision IS NOT NULL AND receipt_digest IS NOT NULL
      AND observed_at IS NOT NULL AND octet_length(observation_result::text) <= 16777216)),
  CONSTRAINT mcp_operations_claim_check CHECK (
    (observation_claim_id IS NULL AND observation_claim_attempt_id IS NULL AND observation_claim_expires_at IS NULL)
    OR (observation_claim_id IS NOT NULL AND observation_claim_attempt_id IS NOT NULL AND observation_claim_expires_at IS NOT NULL))
);
CREATE INDEX mcp_operations_source_idx ON mcp_operations(workspace_id, session_id, source_turn_id, source_call_id);
ALTER TABLE mcp_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON mcp_operations
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE FUNCTION opengeni_private.guard_mcp_operation_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['original_outcome','original_result','original_result_codec_version',
      'observation_result','observation_result_codec_version','receipt_revision','receipt_digest','observed_at',
      'observation_claim_id','observation_claim_attempt_id','observation_claim_expires_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['original_outcome','original_result','original_result_codec_version',
      'observation_result','observation_result_codec_version','receipt_revision','receipt_digest','observed_at',
      'observation_claim_id','observation_claim_attempt_id','observation_claim_expires_at'])
    OR (OLD.original_outcome<>'captured' AND
      (NEW.original_outcome,NEW.original_result,NEW.original_result_codec_version)
        IS DISTINCT FROM (OLD.original_outcome,OLD.original_result,OLD.original_result_codec_version))
    OR (OLD.receipt_digest IS NOT NULL AND
      (NEW.observation_result,NEW.observation_result_codec_version,NEW.receipt_revision,NEW.receipt_digest,NEW.observed_at,
        NEW.observation_claim_id,NEW.observation_claim_attempt_id,NEW.observation_claim_expires_at)
      IS DISTINCT FROM (OLD.observation_result,OLD.observation_result_codec_version,OLD.receipt_revision,OLD.receipt_digest,OLD.observed_at,
        OLD.observation_claim_id,OLD.observation_claim_attempt_id,OLD.observation_claim_expires_at))
  THEN RAISE EXCEPTION 'MCP operation identity and settled outcomes are immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.guard_mcp_operation_immutable() FROM PUBLIC;
CREATE TRIGGER mcp_operation_immutable BEFORE UPDATE ON mcp_operations FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.guard_mcp_operation_immutable();

-- The only runtime entry point is an EXECUTE-only, pinned-search-path writer.
-- Scope is checked even for a superuser-owned definer; no subject GUC is set.
DO $install$
DECLARE target_schema text := current_schema(); role_name text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.mcp_operation_command_scoped(p_scope jsonb, p_action text, p_payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE
      v_account uuid := (p_scope->>'accountId')::uuid;
      v_workspace uuid := (p_scope->>'workspaceId')::uuid;
      v_session uuid := (p_scope->>'sessionId')::uuid;
      v_turn uuid := (p_scope->>'turnId')::uuid;
      v_attempt uuid := (p_scope->>'attemptId')::uuid;
      v_generation integer := (p_scope->>'executionGeneration')::integer;
      v_principal_id text; v_principal_kind text;
      v_op uuid := (p_payload->>'operationId')::uuid;
      v_row mcp_operations%%ROWTYPE;
      v_ids uuid[];
      v_digest text;
      v_claim uuid;
      v_operation jsonb;
      v_membership jsonb; v_external_membership jsonb;
      v_principal_membership uuid; v_principal_revision bigint;
      v_link_snapshot jsonb; v_link external_identity_links%%ROWTYPE;
      v_run uuid;
      v_control workspace_inference_controls%%ROWTYPE;
      v_control_active boolean;
    BEGIN
      IF v_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true),'')::uuid
        OR v_workspace IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true),'')::uuid
        OR v_generation IS NULL OR v_generation < 1
        OR jsonb_typeof(p_scope) IS DISTINCT FROM 'object'
        OR p_scope - ARRAY['accountId','workspaceId','sessionId','turnId','attemptId','executionGeneration'] <> '{}'::jsonb
        OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
      THEN RAISE EXCEPTION 'MCP operation scope mismatch' USING ERRCODE='42501'; END IF;

      IF p_action IS NULL OR p_action NOT IN ('capture','read','settle_original','claim_read','release_read','settle_observation')
      THEN RAISE EXCEPTION 'unknown MCP ledger action'; END IF;

      -- Membership lifecycle precedes tenancy/control/session locks. Scheduled
      -- run validation follows the session lock, matching canonical claim/resume.
      -- p_scope is authenticated by the calling worker; these checks validate
      -- canonical authority, never authenticate arbitrary request JSON.
      PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || v_account::text,0));
      SELECT coalesce(nullif(t.initiating_human_subject_id,''),t.initiator_subject_id),
        CASE WHEN nullif(t.initiating_human_subject_id,'') IS NOT NULL THEN 'subject' ELSE t.initiator_kind END
        INTO v_principal_id,v_principal_kind
      FROM session_turns t WHERE t.id=v_turn AND t.account_id=v_account AND t.workspace_id=v_workspace AND t.session_id=v_session;
      IF v_principal_id IS NULL OR v_principal_id IN ('','unattributed-legacy')
      THEN RAISE EXCEPTION 'MCP operation canonical principal missing' USING ERRCODE='42501'; END IF;
      -- Only the immutable turn chooses the subject. The outer definer restores
      -- these settings on success/error, so this cannot become a subject oracle.
      PERFORM set_config('opengeni.subject_id',v_principal_id,true);
      PERFORM set_config('opengeni.initiating_human_subject_id',CASE WHEN v_principal_kind='subject' THEN v_principal_id ELSE '' END,true);
      IF v_principal_kind='subject' THEN
        IF v_principal_id LIKE 'user:%%' OR v_principal_id LIKE 'external_user:%%' THEN
          SELECT value INTO v_membership FROM jsonb_array_elements(list_self_organization_memberships(v_principal_id))
            WHERE value->>'organizationId'=v_account::text;
          -- An absent organization membership preserves an explicit legacy
          -- workspace grant; a present inactive membership revokes it.
          IF v_membership IS NOT NULL AND v_membership->>'status'<>'active' THEN
            RAISE EXCEPTION 'MCP operation principal membership revoked' USING ERRCODE='42501'; END IF;
          v_principal_membership := (v_membership->>'id')::uuid;
          v_principal_revision := (v_membership->>'authorizationRevision')::bigint;
        END IF;
        -- Same stated-workspace rule as subjectHasLiveWorkspaceAuthorityInScope:
        -- explicit membership OR exact active Personal pointer, never a default.
        IF NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE account_id=v_account
          AND workspace_id=v_workspace AND subject_id=v_principal_id)
          AND (v_membership IS NULL OR v_membership->>'personalWorkspaceId' IS DISTINCT FROM v_workspace::text)
        THEN RAISE EXCEPTION 'MCP operation workspace membership revoked' USING ERRCODE='42501'; END IF;
      END IF;

      SELECT canonical_snapshot INTO v_link_snapshot FROM external_link_turn_authorities
        WHERE account_id=v_account AND workspace_id=v_workspace AND session_id=v_session AND turn_id=v_turn;
      IF v_link_snapshot IS NOT NULL THEN
        SELECT * INTO v_link FROM external_identity_links WHERE id=(v_link_snapshot#>>'{actor,linkId}')::uuid
          AND account_id=v_account FOR SHARE;
        IF NOT FOUND OR v_link.status<>'active' OR (v_link.expires_at IS NOT NULL AND v_link.expires_at<=clock_timestamp())
          OR v_link.revision IS DISTINCT FROM (v_link_snapshot#>>'{actor,linkRevision}')::bigint
          OR v_link.native_subject_id IS DISTINCT FROM v_principal_id
          OR v_link.native_membership_id IS DISTINCT FROM v_principal_membership
          OR v_link.native_authorization_revision IS DISTINCT FROM v_principal_revision
          OR v_link.external_identity_id::text IS DISTINCT FROM v_link_snapshot#>>'{actor,externalIdentityId}'
          OR v_link.external_subject_id IS DISTINCT FROM v_link_snapshot#>>'{actor,externalSubjectId}'
          OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_link_snapshot->'permissions') permission
            WHERE NOT (v_link.permissions ? permission) AND NOT(permission<>'secrets:read' AND v_link.permissions ? 'workspace:admin'))
        THEN RAISE EXCEPTION 'MCP operation linked authority revoked' USING ERRCODE='42501'; END IF;
        PERFORM set_config('opengeni.subject_id',v_link.external_subject_id,true);
        SELECT value INTO v_external_membership FROM jsonb_array_elements(list_self_organization_memberships(v_link.external_subject_id))
          WHERE value->>'organizationId'=v_account::text;
        PERFORM set_config('opengeni.subject_id',v_principal_id,true);
        IF v_external_membership IS NULL OR v_external_membership->>'status'<>'active'
          OR (v_external_membership->>'authorizationRevision')::bigint IS DISTINCT FROM v_link.external_authorization_revision
          OR v_link.external_authorization_revision IS DISTINCT FROM (v_link_snapshot#>>'{actor,externalAuthorizationRevision}')::bigint
        THEN RAISE EXCEPTION 'MCP operation external membership revoked' USING ERRCODE='42501'; END IF;
      END IF;

      PERFORM pg_advisory_xact_lock_shared(hashtextextended('session-tenancy:' || v_workspace::text,0));
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('workspace-control:' || v_workspace::text,0));
      SELECT * INTO v_control FROM workspace_inference_controls WHERE workspace_id=v_workspace AND account_id=v_account FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'MCP operation workspace control missing' USING ERRCODE='42501'; END IF;
      -- Canonical effective-control algebra from session-control.ts: only a
      -- strictly newer DESCENDANT override defeats a session pause; any newer
      -- path override defeats workspace pause. Same 10,000 ancestry bound.
      WITH RECURSIVE ancestry AS (
        SELECT id,parent_session_id,direct_control_state,direct_pause_revision,subtree_run_override_revision,0 AS depth
          FROM sessions WHERE id=v_session AND workspace_id=v_workspace AND account_id=v_account
        UNION ALL SELECT p.id,p.parent_session_id,p.direct_control_state,p.direct_pause_revision,p.subtree_run_override_revision,c.depth+1
          FROM ancestry c JOIN sessions p ON p.id=c.parent_session_id AND p.workspace_id=v_workspace AND p.account_id=v_account
          WHERE c.depth<10000
      ), path AS (SELECT *,max(subtree_run_override_revision) OVER(ORDER BY depth ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS descendant_override FROM ancestry)
      SELECT EXISTS(SELECT 1 FROM path WHERE parent_session_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM path WHERE depth>=10000 AND parent_session_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM path WHERE direct_control_state='paused' AND direct_pause_revision IS NOT NULL
          AND (descendant_override IS NULL OR descendant_override<=direct_pause_revision))
        AND (v_control.workspace_state<>'paused' OR (v_control.workspace_pause_revision IS NOT NULL
          AND EXISTS(SELECT 1 FROM path WHERE subtree_run_override_revision>v_control.workspace_pause_revision)))
        INTO v_control_active;
      IF NOT v_control_active THEN RAISE EXCEPTION 'MCP operation effective control paused or unavailable' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM workspaces WHERE id=v_workspace AND account_id=v_account FOR KEY SHARE;
      PERFORM 1 FROM sessions WHERE id=v_session AND workspace_id=v_workspace AND account_id=v_account FOR SHARE;
      -- Canonical claim/resume owns control/session before scheduled run rows.
      -- Taking a run first can deadlock a stale read against replacement claim.
      -- Include inherited host-MCP scheduled origin, not only direct run turns.
      FOR v_run IN SELECT t.scheduled_task_run_id FROM session_turns t WHERE t.id=v_turn
        AND t.account_id=v_account AND t.workspace_id=v_workspace AND t.scheduled_task_run_id IS NOT NULL
        UNION SELECT (h.canonical_snapshot#>>'{scheduledOrigin,runId}')::uuid FROM host_mcp_turn_authorities h
          WHERE h.account_id=v_account AND h.workspace_id=v_workspace AND h.turn_id=v_turn
            AND h.canonical_snapshot#>>'{scheduledOrigin,runId}' IS NOT NULL
      LOOP
        IF validate_scheduled_agent_run_live_authority(v_account,v_workspace,v_run) IS NOT NULL
        THEN RAISE EXCEPTION 'MCP operation scheduled authority revoked' USING ERRCODE='42501'; END IF;
      END LOOP;
      PERFORM 1 FROM session_turns WHERE id=v_turn AND workspace_id=v_workspace AND account_id=v_account FOR SHARE;
      SELECT coalesce(nullif(t.initiating_human_subject_id,''),t.initiator_subject_id),
        CASE WHEN nullif(t.initiating_human_subject_id,'') IS NOT NULL THEN 'subject' ELSE t.initiator_kind END
        INTO v_principal_id,v_principal_kind
      FROM sessions s JOIN session_turns t ON t.id=s.active_turn_id AND t.session_id=s.id
        AND t.workspace_id=s.workspace_id AND t.account_id=s.account_id
      JOIN session_turn_attempts a ON a.id=t.active_attempt_id AND a.turn_id=t.id
        AND a.session_id=s.id AND a.account_id=s.account_id AND a.workspace_id=s.workspace_id
      WHERE s.account_id=v_account AND s.workspace_id=v_workspace AND s.id=v_session
        AND t.id=v_turn AND t.status='running'
        AND a.id=v_attempt AND a.execution_generation=v_generation AND t.execution_generation=v_generation
        AND a.state IN ('claimed','running') AND a.closed_at IS NULL AND a.quiesced_at IS NULL
        AND a.authority_epoch=s.authority_epoch AND a.authority_visibility=s.visibility
        AND a.authority_owner_organization_membership_id IS NOT DISTINCT FROM s.owner_organization_membership_id
        AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions i
          WHERE i.account_id=v_account AND i.workspace_id=v_workspace AND i.session_id=v_session
            AND i.attempt_id=a.id AND i.state IN ('pending','delivered','acknowledged'))
      FOR UPDATE OF a;
      IF v_principal_id IS NULL OR v_principal_id IN ('','unattributed-legacy') OR v_principal_kind NOT IN ('subject','service')
      THEN RAISE EXCEPTION 'MCP operation requires exact live canonical attempt' USING ERRCODE='42501'; END IF;

      IF p_action='capture' THEN
        IF v_op IS NULL OR p_payload - ARRAY['operationId','sourceCallId','serverId','originalTool','observerTool',
          'argumentDigest','destinationDigest','authorityDigest'] <> '{}'::jsonb
        THEN RAISE EXCEPTION 'invalid MCP capture metadata'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('mcp-operation:' || v_op::text,0));
        SELECT * INTO v_row FROM mcp_operations WHERE operation_id=v_op FOR UPDATE;
        IF FOUND THEN
          IF (v_row.account_id,v_row.workspace_id,v_row.session_id,v_row.source_turn_id,v_row.source_attempt_id,
              v_row.source_execution_generation,v_row.principal_kind,v_row.principal_id,v_row.principal_membership_id,v_row.principal_membership_revision,v_row.source_call_id,
              v_row.server_id,v_row.original_tool,v_row.observer_tool,v_row.argument_digest,v_row.destination_digest,v_row.authority_digest)
            IS DISTINCT FROM (v_account,v_workspace,v_session,v_turn,v_attempt,v_generation,v_principal_kind,v_principal_id,v_principal_membership,v_principal_revision,
              p_payload->>'sourceCallId',p_payload->>'serverId',p_payload->>'originalTool',p_payload->>'observerTool',
              p_payload->>'argumentDigest',p_payload->>'destinationDigest',p_payload->>'authorityDigest')
          THEN RAISE EXCEPTION 'MCP operation immutable identity conflict' USING ERRCODE='23505'; END IF;
          RETURN '"existing"'::jsonb;
        END IF;
        INSERT INTO mcp_operations(operation_id,account_id,workspace_id,session_id,source_turn_id,source_attempt_id,
          source_execution_generation,principal_kind,principal_id,principal_membership_id,principal_membership_revision,source_call_id,server_id,original_tool,observer_tool,
          argument_digest,destination_digest,authority_digest)
        VALUES(v_op,v_account,v_workspace,v_session,v_turn,v_attempt,v_generation,v_principal_kind,v_principal_id,v_principal_membership,v_principal_revision,
          p_payload->>'sourceCallId',p_payload->>'serverId',p_payload->>'originalTool',p_payload->>'observerTool',
          p_payload->>'argumentDigest',p_payload->>'destinationDigest',p_payload->>'authorityDigest');
        RETURN '"created"'::jsonb;
      END IF;

      IF p_action='read' AND v_op IS NULL THEN
        IF p_payload - ARRAY['sourceTurnId','sourceCallId'] <> '{}'::jsonb
          OR p_payload->>'sourceTurnId' IS NULL OR coalesce(p_payload->>'sourceCallId','')=''
        THEN RAISE EXCEPTION 'invalid exact MCP operation selector'; END IF;
        SELECT array_agg(operation_id) INTO v_ids FROM (
          SELECT operation_id FROM mcp_operations WHERE account_id=v_account AND workspace_id=v_workspace
            AND session_id=v_session AND principal_kind=v_principal_kind AND principal_id=v_principal_id
            AND source_turn_id=(p_payload->>'sourceTurnId')::uuid AND source_call_id=p_payload->>'sourceCallId'
          LIMIT 2) candidates;
        IF cardinality(v_ids)>1 THEN RETURN jsonb_build_object('status','ambiguous'); END IF;
        v_op := v_ids[1];
      ELSIF p_action='read' AND p_payload - ARRAY['operationId'] <> '{}'::jsonb THEN
        RAISE EXCEPTION 'invalid exact MCP operation selector';
      END IF;
      SELECT * INTO v_row FROM mcp_operations WHERE operation_id=v_op AND account_id=v_account
        AND workspace_id=v_workspace AND session_id=v_session
        AND principal_kind=v_principal_kind AND principal_id=v_principal_id FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
      IF v_row.principal_membership_id IS DISTINCT FROM v_principal_membership
        OR v_row.principal_membership_revision IS DISTINCT FROM v_principal_revision
      THEN RAISE EXCEPTION 'MCP operation original membership authority changed' USING ERRCODE='42501'; END IF;
      IF p_action='settle_original' THEN
        IF v_row.source_turn_id<>v_turn OR v_row.source_attempt_id<>v_attempt
          OR v_row.source_execution_generation<>v_generation
        THEN RAISE EXCEPTION 'original MCP settlement requires source attempt' USING ERRCODE='42501'; END IF;
        IF p_payload->>'outcome' NOT IN ('completed','outcome_unknown')
          OR p_payload->>'outcome' IS NULL
          OR (p_payload->>'outcome'='completed' AND jsonb_typeof(p_payload->'result') IS DISTINCT FROM 'object')
          OR (p_payload->>'outcome'='outcome_unknown' AND p_payload ? 'result')
        THEN RAISE EXCEPTION 'invalid original MCP outcome'; END IF;
        IF v_row.original_outcome<>'captured' THEN
          IF v_row.original_outcome IS DISTINCT FROM p_payload->>'outcome'
            OR v_row.original_result IS DISTINCT FROM p_payload->'result'
            OR v_row.original_result_codec_version IS DISTINCT FROM (p_payload->>'resultCodecVersion')::integer
          THEN RAISE EXCEPTION 'original MCP outcome is immutable'; END IF;
        ELSE
          UPDATE mcp_operations SET original_outcome=p_payload->>'outcome', original_result=p_payload->'result',
            original_result_codec_version=(p_payload->>'resultCodecVersion')::integer
            WHERE operation_id=v_op;
        END IF;
        RETURN jsonb_build_object('status','settled');
      ELSIF p_action='claim_read' THEN
        IF v_row.receipt_digest IS NOT NULL OR v_row.original_outcome='completed' THEN RETURN jsonb_build_object('status','terminal'); END IF;
        IF v_row.observation_claim_expires_at>clock_timestamp() THEN RETURN jsonb_build_object('status','busy'); END IF;
        v_claim := gen_random_uuid();
        UPDATE mcp_operations SET observation_claim_id=v_claim,observation_claim_attempt_id=v_attempt,
          observation_claim_expires_at=clock_timestamp()+interval '30 seconds' WHERE operation_id=v_op;
        RETURN jsonb_build_object('status','claimed','claimId',v_claim);
      ELSIF p_action='release_read' THEN
        IF v_row.receipt_digest IS NOT NULL THEN RETURN jsonb_build_object('status','terminal'); END IF;
        IF v_row.observation_claim_id IS DISTINCT FROM (p_payload->>'claimId')::uuid
          OR v_row.observation_claim_attempt_id IS DISTINCT FROM v_attempt
        THEN RETURN jsonb_build_object('status','stale_claim'); END IF;
        UPDATE mcp_operations SET observation_claim_id=NULL,observation_claim_attempt_id=NULL,observation_claim_expires_at=NULL WHERE operation_id=v_op;
        RETURN jsonb_build_object('status','released');
      ELSIF p_action='settle_observation' THEN
        IF v_row.original_outcome='completed' THEN RETURN jsonb_build_object('status','original_completed'); END IF;
        IF v_row.observation_claim_id IS DISTINCT FROM (p_payload->>'claimId')::uuid
          OR v_row.observation_claim_attempt_id IS DISTINCT FROM v_attempt
        THEN RETURN jsonb_build_object('status','stale_claim'); END IF;
        IF jsonb_typeof(p_payload->'result') IS DISTINCT FROM 'object'
          OR octet_length((p_payload->'result')::text)>16777216
          OR coalesce(octet_length(p_payload->>'receiptRevision'),0) NOT BETWEEN 1 AND 1024
        THEN RAISE EXCEPTION 'invalid terminal MCP receipt'; END IF;
        -- PostgreSQL canonical jsonb representation; revision is part of identity.
        v_digest := encode(sha256(convert_to(jsonb_build_object('version',1,'codecVersion',p_payload->'resultCodecVersion','revision',p_payload->>'receiptRevision',
          'result',p_payload->'result')::text,'UTF8')),'hex');
        IF v_row.receipt_digest IS NOT NULL THEN
          RETURN jsonb_build_object('status',CASE WHEN v_row.receipt_digest=v_digest THEN 'existing' ELSE 'conflict' END,
            'receiptDigest',v_row.receipt_digest);
        END IF;
        IF v_row.observation_claim_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','stale_claim'); END IF;
        UPDATE mcp_operations SET observation_result=p_payload->'result',receipt_revision=p_payload->>'receiptRevision',
          observation_result_codec_version=(p_payload->>'resultCodecVersion')::integer,
          receipt_digest=v_digest,observed_at=clock_timestamp() WHERE operation_id=v_op;
        RETURN jsonb_build_object('status','settled','receiptDigest',v_digest);
      ELSIF p_action<>'read' THEN RAISE EXCEPTION 'unknown MCP ledger action'; END IF;

      v_operation := jsonb_build_object('operationId',v_row.operation_id,'sourceCallId',v_row.source_call_id,
        'accountId',v_row.account_id,'workspaceId',v_row.workspace_id,'sessionId',v_row.session_id,
        'sourceTurnId',v_row.source_turn_id,'sourceAttemptId',v_row.source_attempt_id,
        'sourceExecutionGeneration',v_row.source_execution_generation,'principalKind',v_row.principal_kind,
        'principalId',v_row.principal_id,'serverId',v_row.server_id,'originalTool',v_row.original_tool,
        'observerTool',v_row.observer_tool,'argumentDigest',v_row.argument_digest,'destinationDigest',v_row.destination_digest,
        'authorityDigest',v_row.authority_digest,'originalOutcome',v_row.original_outcome,'originalResult',v_row.original_result,
        'originalResultCodecVersion',v_row.original_result_codec_version,
        'observationResultCodecVersion',v_row.observation_result_codec_version,
        'observationResult',v_row.observation_result,'receiptRevision',v_row.receipt_revision,'receiptDigest',v_row.receipt_digest);
      RETURN jsonb_build_object('status','found','operation',v_operation);
    END $body$;
  $definition$,target_schema);
  EXECUTE format($definition$
    CREATE FUNCTION %1$I.mcp_operation_command(p_scope jsonb,p_action text,p_payload jsonb)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,%1$I,pg_temp AS $body$
    DECLARE result jsonb;
      prior_subject text := current_setting('opengeni.subject_id',true);
      prior_human text := current_setting('opengeni.initiating_human_subject_id',true);
      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle',true);
    BEGIN
      result := opengeni_private.mcp_operation_command_scoped(p_scope,p_action,p_payload);
      PERFORM set_config('opengeni.subject_id',coalesce(prior_subject,''),true);
      PERFORM set_config('opengeni.initiating_human_subject_id',coalesce(prior_human,''),true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('opengeni.subject_id',coalesce(prior_subject,''),true);
      PERFORM set_config('opengeni.initiating_human_subject_id',coalesce(prior_human,''),true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
      RAISE;
    END $body$;
  $definition$,target_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.mcp_operation_command(jsonb,text,jsonb) FROM PUBLIC',target_schema);
  EXECUTE format('REVOKE ALL ON TABLE %I.mcp_operations FROM PUBLIC',target_schema);
  -- Strip inherited default grants. Provisioning must explicitly register the
  -- EXECUTE-only routine; the table must never enter an app DML allowlist.
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname=target_schema AND c.relname='mcp_operations' AND acl.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE %I.mcp_operations FROM %I',target_schema,role_name); END LOOP;
  -- Remove inherited/default EXECUTE grants, not merely PUBLIC. Only exact
  -- production role provisioning grants the outer capability afterwards.
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl JOIN pg_roles r ON r.oid=acl.grantee
    WHERE acl.grantee<>p.proowner AND ((n.nspname=target_schema AND p.proname='mcp_operation_command')
      OR (n.nspname='opengeni_private' AND p.proname IN ('mcp_operation_command_scoped','guard_mcp_operation_immutable')))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.mcp_operation_command(jsonb,text,jsonb) FROM %I',target_schema,role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.mcp_operation_command_scoped(jsonb,text,jsonb) FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.guard_mcp_operation_immutable() FROM %I',role_name);
  END LOOP;
  REVOKE ALL ON FUNCTION opengeni_private.mcp_operation_command_scoped(jsonb,text,jsonb) FROM PUBLIC;
END $install$;