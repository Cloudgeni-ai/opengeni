-- deployment-mode: rolling
-- Add an organization-owner policy for agent-authored company-profile changes.
-- Existing organizations default to `suggest`, preserving the exact bound
-- human-confirmation path. `automatic` replaces only that per-change prompt:
-- the live turn must still be initiated by the active organization owner, and
-- activation still uses the company-profile CAS lifecycle. `off` creates no
-- new proposal. The policy is organization-scoped and cannot be changed by a
-- workspace administrator.
--
-- Rolling compatibility: the v1 proposal function remains review-only for old
-- API processes, but now records the frozen policy and refuses `off`. New API
-- processes call v2, which consumes an `automatic` snapshot and records a
-- distinct automatic-activation receipt. Thus old processes can be stricter
-- during rollout but can never gain autonomous authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_company_profile_agent_policies (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'suggest',
  version bigint NOT NULL DEFAULT 0,
  updated_by_membership_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_company_profile_agent_policies_membership_fk
    FOREIGN KEY (updated_by_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_company_profile_agent_policies_mode_check
    CHECK (mode IN ('off', 'suggest', 'automatic')),
  CONSTRAINT organization_company_profile_agent_policies_version_check CHECK (version >= 0)
);

CREATE TABLE organization_company_profile_agent_policy_events (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  actor_membership_id uuid NOT NULL,
  requested_mode text NOT NULL,
  expected_version bigint NOT NULL,
  result_mode text NOT NULL,
  result_version bigint NOT NULL,
  result_updated_at timestamptz NOT NULL,
  changed boolean NOT NULL,
  CONSTRAINT organization_company_profile_agent_policy_events_membership_fk
    FOREIGN KEY (actor_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT organization_company_profile_agent_policy_events_mode_check CHECK (
    requested_mode IN ('off', 'suggest', 'automatic')
    AND result_mode IN ('off', 'suggest', 'automatic')
  ),
  CONSTRAINT organization_company_profile_agent_policy_events_version_check CHECK (
    expected_version >= 0 AND result_version > 0
  )
);
CREATE INDEX organization_company_profile_agent_policy_events_account_idx
  ON organization_company_profile_agent_policy_events (account_id, result_version);

ALTER TABLE organization_company_profile_agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_company_profile_agent_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_company_profile_agent_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_company_profile_agent_policy_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_company_profile_agent_policies FROM PUBLIC;
REVOKE ALL ON TABLE organization_company_profile_agent_policy_events FROM PUBLIC;
CREATE POLICY organization_company_profile_agent_policy_lifecycle
  ON organization_company_profile_agent_policies
  USING (current_setting('opengeni.company_profile_agent_policy_lifecycle', true)
    = 'company_profile_agent_policy')
  WITH CHECK (current_setting('opengeni.company_profile_agent_policy_lifecycle', true)
    = 'company_profile_agent_policy');
CREATE POLICY organization_company_profile_agent_policy_lifecycle
  ON organization_company_profile_agent_policy_events
  USING (current_setting('opengeni.company_profile_agent_policy_lifecycle', true)
    = 'company_profile_agent_policy')
  WITH CHECK (current_setting('opengeni.company_profile_agent_policy_lifecycle', true)
    = 'company_profile_agent_policy');
CREATE FUNCTION initialize_company_profile_agent_policy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.company_profile_agent_policy_lifecycle',
    'company_profile_agent_policy', true
  );
  INSERT INTO organization_company_profile_agent_policies (
    account_id, mode, version, updated_by_membership_id, updated_at
  ) VALUES (NEW.id, 'suggest', 0, NULL, NEW.created_at)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION initialize_company_profile_agent_policy() FROM PUBLIC;
CREATE TRIGGER managed_accounts_initialize_company_profile_agent_policy
  AFTER INSERT ON managed_accounts
  FOR EACH ROW EXECUTE FUNCTION initialize_company_profile_agent_policy();

CREATE FUNCTION company_profile_agent_policy_events_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM managed_accounts account WHERE account.id = OLD.account_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'company-profile agent policy events are immutable'
    USING ERRCODE = '55000';
END
$body$;
CREATE TRIGGER organization_company_profile_agent_policy_events_immutable
  BEFORE UPDATE OR DELETE ON organization_company_profile_agent_policy_events
  FOR EACH ROW EXECUTE FUNCTION company_profile_agent_policy_events_immutable();

SELECT pg_catalog.set_config(
  'opengeni.company_profile_agent_policy_lifecycle',
  'company_profile_agent_policy', true
);
INSERT INTO organization_company_profile_agent_policies (
  account_id, mode, version, updated_by_membership_id, updated_at
)
SELECT account.id, 'suggest', 0, NULL, account.created_at
FROM managed_accounts account
ON CONFLICT (account_id) DO NOTHING;

CREATE FUNCTION get_company_profile_agent_policy(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  context_account_id uuid := nullif(current_setting('opengeni.account_id', true), '')::uuid;
  context_workspace_id uuid := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
  context_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  context_principal_kind text := nullif(current_setting('opengeni.principal_kind', true), '');
  actor organization_memberships%ROWTYPE;
  policy organization_company_profile_agent_policies%ROWTYPE;
BEGIN
  IF context_account_id IS DISTINCT FROM p_account_id
    OR context_workspace_id IS DISTINCT FROM p_workspace_id
    OR context_subject_id IS DISTINCT FROM p_actor_subject_id
    OR context_principal_kind IS DISTINCT FROM 'human_session'
  THEN
    RAISE EXCEPTION 'organization owner authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.company_profile_agent_policy_lifecycle',
    'company_profile_agent_policy', true
  );
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT membership.* INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
    AND membership.role = 'owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization owner authority required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO policy FROM organization_company_profile_agent_policies candidate
  WHERE candidate.account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile agent policy is unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'mode', policy.mode,
    'version', policy.version,
    'updatedAt', policy.updated_at
  );
END
$body$;
REVOKE ALL ON FUNCTION get_company_profile_agent_policy(uuid,uuid,text) FROM PUBLIC;

CREATE FUNCTION update_company_profile_agent_policy(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text,
  p_mode text,
  p_expected_version bigint,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  context_account_id uuid := nullif(current_setting('opengeni.account_id', true), '')::uuid;
  context_workspace_id uuid := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
  context_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  context_principal_kind text := nullif(current_setting('opengeni.principal_kind', true), '');
  actor organization_memberships%ROWTYPE;
  policy organization_company_profile_agent_policies%ROWTYPE;
  prior organization_company_profile_agent_policy_events%ROWTYPE;
  next_version bigint;
  did_change boolean;
BEGIN
  IF context_account_id IS DISTINCT FROM p_account_id
    OR context_workspace_id IS DISTINCT FROM p_workspace_id
    OR context_subject_id IS DISTINCT FROM p_actor_subject_id
    OR context_principal_kind IS DISTINCT FROM 'human_session'
    OR p_mode NOT IN ('off', 'suggest', 'automatic')
    OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_operation_id IS NULL
  THEN
    RAISE EXCEPTION 'company-profile agent policy request is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  PERFORM pg_catalog.set_config(
    'opengeni.company_profile_agent_policy_lifecycle',
    'company_profile_agent_policy', true
  );
  PERFORM 1 FROM managed_accounts account WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT membership.* INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
    AND membership.role = 'owner'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization owner authority required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM organization_company_profile_agent_policy_events event
  WHERE event.id = p_operation_id;
  IF FOUND THEN
    IF prior.account_id IS DISTINCT FROM p_account_id
      OR prior.actor_membership_id IS DISTINCT FROM actor.id
      OR prior.requested_mode IS DISTINCT FROM p_mode
      OR prior.expected_version IS DISTINCT FROM p_expected_version
    THEN
      RAISE EXCEPTION 'company-profile agent policy operation id was reused'
        USING ERRCODE = 'P1851';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'organizationId', p_account_id,
      'mode', prior.result_mode,
      'version', prior.result_version,
      'updatedAt', prior.result_updated_at,
      'changed', prior.changed
    );
  END IF;
  SELECT * INTO policy FROM organization_company_profile_agent_policies candidate
  WHERE candidate.account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile agent policy is unavailable' USING ERRCODE = '55000';
  END IF;
  IF policy.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'company-profile agent policy changed before update'
      USING ERRCODE = '40001';
  END IF;
  did_change := policy.mode IS DISTINCT FROM p_mode;
  next_version := policy.version + 1;
  UPDATE organization_company_profile_agent_policies SET
    mode = p_mode,
    version = next_version,
    updated_by_membership_id = actor.id,
    updated_at = clock_timestamp()
  WHERE account_id = p_account_id
  RETURNING * INTO policy;
  INSERT INTO organization_company_profile_agent_policy_events (
    id, account_id, actor_membership_id, requested_mode, expected_version,
    result_mode, result_version, result_updated_at, changed
  ) VALUES (
    p_operation_id, p_account_id, actor.id, p_mode, p_expected_version,
    policy.mode, policy.version, policy.updated_at, did_change
  );
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'mode', policy.mode,
    'version', policy.version,
    'updatedAt', policy.updated_at,
    'changed', did_change
  );
END
$body$;
REVOKE ALL ON FUNCTION
  update_company_profile_agent_policy(uuid,uuid,text,text,bigint,uuid) FROM PUBLIC;

ALTER TABLE company_profile_agent_proposal_receipts
  ADD COLUMN policy_mode text NOT NULL DEFAULT 'suggest',
  ADD COLUMN policy_version bigint NOT NULL DEFAULT 0;
ALTER TABLE company_profile_agent_proposal_receipts
  ADD CONSTRAINT company_profile_agent_proposals_policy_mode_check
    CHECK (policy_mode IN ('suggest', 'automatic')),
  ADD CONSTRAINT company_profile_agent_proposals_policy_version_check
    CHECK (policy_version >= 0);

CREATE TABLE company_profile_agent_automatic_activation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  input_hash text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  activation_attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  proposal_receipt_id uuid NOT NULL,
  proposal_revision_id uuid NOT NULL,
  initiating_human_subject_id text NOT NULL,
  initiating_membership_id uuid NOT NULL,
  policy_version bigint NOT NULL,
  activation_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT company_profile_agent_automatic_activations_workspace_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_automatic_activations_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_automatic_activations_turn_fk
    FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_automatic_activations_attempt_fk
    FOREIGN KEY (account_id, workspace_id, session_id, turn_id, activation_attempt_id)
    REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id)
    ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_automatic_activations_proposal_fk
    FOREIGN KEY (proposal_receipt_id, account_id)
    REFERENCES company_profile_agent_proposal_receipts(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_automatic_activations_revision_fk
    FOREIGN KEY (proposal_revision_id, account_id)
    REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_automatic_activations_membership_fk
    FOREIGN KEY (initiating_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_automatic_activations_event_fk
    FOREIGN KEY (activation_event_id, account_id)
    REFERENCES company_profile_activation_events(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_automatic_activations_input_hash_check CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT company_profile_agent_automatic_activations_generation_check CHECK (
    execution_generation > 0 AND policy_version >= 0
  ),
  CONSTRAINT company_profile_agent_automatic_activations_subject_check CHECK (
    octet_length(btrim(initiating_human_subject_id)) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX company_profile_agent_automatic_activations_account_operation_uq
  ON company_profile_agent_automatic_activation_receipts (account_id, operation_id);
CREATE UNIQUE INDEX company_profile_agent_automatic_activations_proposal_uq
  ON company_profile_agent_automatic_activation_receipts (account_id, proposal_receipt_id);
CREATE UNIQUE INDEX company_profile_agent_automatic_activations_event_uq
  ON company_profile_agent_automatic_activation_receipts (account_id, activation_event_id);
CREATE INDEX company_profile_agent_automatic_activations_turn_idx
  ON company_profile_agent_automatic_activation_receipts (
    workspace_id, session_id, turn_id, execution_generation
  );

ALTER TABLE company_profile_agent_automatic_activation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profile_agent_automatic_activation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE company_profile_agent_automatic_activation_receipts FROM PUBLIC;
CREATE POLICY company_profile_agent_admin_lifecycle
  ON company_profile_agent_automatic_activation_receipts
  USING (current_setting('opengeni.company_profile_agent_admin_lifecycle', true)
    = 'company_profile_agent_admin')
  WITH CHECK (current_setting('opengeni.company_profile_agent_admin_lifecycle', true)
    = 'company_profile_agent_admin');
CREATE POLICY session_visibility_isolation
  ON company_profile_agent_automatic_activation_receipts AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
CREATE TRIGGER company_profile_agent_automatic_activations_immutable
  BEFORE UPDATE OR DELETE ON company_profile_agent_automatic_activation_receipts
  FOR EACH ROW EXECUTE FUNCTION company_profile_agent_receipts_immutable();

CREATE OR REPLACE FUNCTION propose_company_profile_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_content_json text,
  p_content_hash text,
  p_reason text
) RETURNS TABLE (
  receipt_id uuid,
  revision_id uuid,
  human_input jsonb,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  context_account_id uuid := nullif(current_setting('opengeni.account_id', true), '')::uuid;
  context_workspace_id uuid := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
  context_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  context_principal_kind text := nullif(current_setting('opengeni.principal_kind', true), '');
  initiating_subject text;
  actor_membership organization_memberships%ROWTYPE;
  active_head company_profile_heads%ROWTYPE;
  policy organization_company_profile_agent_policies%ROWTYPE;
  prior company_profile_agent_proposal_receipts%ROWTYPE;
  inserted_revision company_profile_revisions%ROWTYPE;
  input_hash_value text;
  new_receipt_id uuid := gen_random_uuid();
  new_revision_id uuid := gen_random_uuid();
  normalized_reason text := btrim(p_reason);
  prompt jsonb;
BEGIN
  IF context_account_id IS DISTINCT FROM p_account_id
    OR context_workspace_id IS DISTINCT FROM p_workspace_id
    OR context_subject_id IS NULL
    OR context_principal_kind IS DISTINCT FROM 'agent_attempt'
    OR p_execution_generation < 1
    OR p_operation_id IS NULL
    OR p_content_json IS NULL
    OR p_content_hash !~ '^[0-9a-f]{64}$'
    OR p_content_hash IS DISTINCT FROM encode(sha256(convert_to(p_content_json, 'UTF8')), 'hex')
    OR octet_length(convert_to(p_content_json, 'UTF8')) NOT BETWEEN 1 AND 28672
    OR octet_length(convert_to(normalized_reason, 'UTF8')) NOT BETWEEN 1 AND 16384
  THEN
    RAISE EXCEPTION 'company-profile agent proposal is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(
    turn.initiating_human_subject_id,
    CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
  ) INTO initiating_subject
  FROM session_turns turn
  WHERE turn.account_id = p_account_id
    AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id
    AND turn.id = p_turn_id;
  IF initiating_subject IS NULL THEN
    RAISE EXCEPTION
      'company-profile agent proposals require the exact live turn of the active organization owner'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization workspace is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = initiating_subject
    AND membership.status = 'active'
    AND membership.role = 'owner'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'company-profile agent proposals require the exact live turn of the active organization owner'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1
  FROM sessions session
  JOIN session_turns turn
    ON turn.account_id = session.account_id
    AND turn.workspace_id = session.workspace_id
    AND turn.session_id = session.id
  JOIN session_turn_attempts attempt
    ON attempt.account_id = turn.account_id
    AND attempt.workspace_id = turn.workspace_id
    AND attempt.session_id = turn.session_id
    AND attempt.turn_id = turn.id
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id
    AND session.active_turn_id = p_turn_id
    AND turn.id = p_turn_id
    AND turn.active_attempt_id = p_attempt_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND coalesce(
      turn.initiating_human_subject_id,
      CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
    ) = actor_membership.subject_id
    AND attempt.id = p_attempt_id
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = attempt.workspace_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    )
  FOR SHARE OF session, turn, attempt;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'company-profile agent proposals require the exact live turn of the active organization owner'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM managed_accounts account
  WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization account is unavailable' USING ERRCODE = '42501';
  END IF;

  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'company-profile-agent-proposal', 1, p_account_id, p_workspace_id,
    p_session_id, p_turn_id, p_operation_id, p_content_hash, normalized_reason,
    actor_membership.id, actor_membership.subject_id
  )::text, 'UTF8')), 'hex');
  PERFORM set_config(
    'opengeni.company_profile_agent_admin_lifecycle',
    'company_profile_agent_admin', true
  );
  SELECT * INTO prior FROM company_profile_agent_proposal_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.input_hash IS DISTINCT FROM input_hash_value THEN
      RAISE EXCEPTION 'company-profile agent proposal operation id was reused'
        USING ERRCODE = 'P1851';
    END IF;
    receipt_id := prior.id;
    revision_id := prior.revision_id;
    human_input := prior.human_input;
    replayed := true;
    RETURN NEXT;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM company_profile_revisions revision
    WHERE revision.account_id = p_account_id AND revision.operation_id = p_operation_id
  ) THEN
    RAISE EXCEPTION 'company-profile agent proposal operation id was reused'
      USING ERRCODE = 'P1851';
  END IF;

  PERFORM set_config(
    'opengeni.company_profile_agent_policy_lifecycle',
    'company_profile_agent_policy', true
  );
  SELECT * INTO policy FROM organization_company_profile_agent_policies candidate
  WHERE candidate.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile agent policy is unavailable' USING ERRCODE = '55000';
  END IF;
  IF policy.mode = 'off' THEN
    RAISE EXCEPTION 'company-profile agent changes are disabled by organization policy'
      USING ERRCODE = 'P1852';
  END IF;

  SELECT * INTO active_head FROM company_profile_heads head
  WHERE head.account_id = p_account_id;
  INSERT INTO company_profile_revisions (
    id, operation_id, request_fingerprint, account_id, intent,
    content_json, content_hash, provenance_source, provenance_source_id,
    supersedes_revision_id, created_by_subject_id
  ) VALUES (
    new_revision_id, p_operation_id, input_hash_value, p_account_id, 'proposal',
    p_content_json, p_content_hash, 'agent_admin',
    'agent-admin-proposal:' || new_receipt_id::text,
    active_head.revision_id, context_subject_id
  ) RETURNING * INTO inserted_revision;
  prompt := company_profile_agent_confirmation_prompt(
    inserted_revision.id, inserted_revision.revision,
    inserted_revision.content_hash, inserted_revision.content_json
  );
  INSERT INTO company_profile_agent_proposal_receipts (
    id, operation_id, input_hash, account_id, workspace_id, session_id,
    turn_id, creation_attempt_id, execution_generation,
    initiating_human_subject_id, initiating_membership_id, revision_id,
    expected_current_revision_id, expected_activation_version,
    policy_mode, policy_version, reason, human_input
  ) VALUES (
    new_receipt_id, p_operation_id, input_hash_value, p_account_id, p_workspace_id,
    p_session_id, p_turn_id, p_attempt_id, p_execution_generation,
    actor_membership.subject_id, actor_membership.id, inserted_revision.id,
    active_head.revision_id, coalesce(active_head.activation_version, 0),
    policy.mode, policy.version, normalized_reason, prompt
  );
  receipt_id := new_receipt_id;
  revision_id := inserted_revision.id;
  human_input := prompt;
  replayed := false;
  RETURN NEXT;
END
$body$;

CREATE FUNCTION propose_company_profile_for_attempt_v2(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_automatic_activation_operation_id uuid,
  p_content_json text,
  p_content_hash text,
  p_reason text
) RETURNS TABLE (
  receipt_id uuid,
  revision_id uuid,
  human_input jsonb,
  policy_mode text,
  automatic_activation_receipt_id uuid,
  activation_event_id uuid,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  context_subject_id text := nullif(current_setting('opengeni.subject_id', true), '');
  context_principal_kind text := nullif(current_setting('opengeni.principal_kind', true), '');
  base record;
  proposal company_profile_agent_proposal_receipts%ROWTYPE;
  proposal_revision company_profile_revisions%ROWTYPE;
  prior company_profile_agent_automatic_activation_receipts%ROWTYPE;
  input_hash_value text;
  event_id_value uuid;
  new_receipt_id uuid := gen_random_uuid();
  service_actor text := 'service:company-profile-autonomy';
BEGIN
  IF context_subject_id IS NULL
    OR context_principal_kind IS DISTINCT FROM 'agent_attempt'
    OR p_automatic_activation_operation_id IS NULL
    OR p_automatic_activation_operation_id IS NOT DISTINCT FROM p_operation_id
  THEN
    RAISE EXCEPTION 'company-profile automatic activation operation is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT * INTO base FROM propose_company_profile_for_attempt(
    p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
    p_execution_generation, p_operation_id, p_content_json, p_content_hash, p_reason
  );
  IF base.receipt_id IS NULL THEN
    RAISE EXCEPTION 'company-profile proposal returned no receipt' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config(
    'opengeni.company_profile_agent_admin_lifecycle',
    'company_profile_agent_admin', true
  );
  SELECT * INTO proposal FROM company_profile_agent_proposal_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.id = base.receipt_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile proposal receipt is unavailable' USING ERRCODE = '55000';
  END IF;

  receipt_id := proposal.id;
  revision_id := proposal.revision_id;
  human_input := proposal.human_input;
  policy_mode := proposal.policy_mode;
  IF proposal.policy_mode = 'suggest' THEN
    automatic_activation_receipt_id := NULL;
    activation_event_id := NULL;
    replayed := base.replayed;
    RETURN NEXT;
    RETURN;
  END IF;
  IF proposal.policy_mode IS DISTINCT FROM 'automatic' THEN
    RAISE EXCEPTION 'company-profile proposal policy is invalid' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO prior FROM company_profile_agent_automatic_activation_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.proposal_receipt_id = proposal.id;
  IF FOUND THEN
    IF prior.operation_id IS DISTINCT FROM p_automatic_activation_operation_id THEN
      RAISE EXCEPTION 'company-profile automatic activation operation id was reused'
        USING ERRCODE = 'P1851';
    END IF;
    automatic_activation_receipt_id := prior.id;
    activation_event_id := prior.activation_event_id;
    replayed := true;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT * INTO prior FROM company_profile_agent_automatic_activation_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.operation_id = p_automatic_activation_operation_id;
  IF FOUND THEN
    RAISE EXCEPTION 'company-profile automatic activation operation id was reused'
      USING ERRCODE = 'P1851';
  END IF;

  SELECT * INTO proposal_revision FROM company_profile_revisions revision
  WHERE revision.account_id = p_account_id
    AND revision.id = proposal.revision_id
    AND revision.intent = 'proposal'
    AND revision.provenance_source = 'agent_admin'
    AND revision.provenance_source_id = 'agent-admin-proposal:' || proposal.id::text
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile proposal revision is unavailable'
      USING ERRCODE = '42501';
  END IF;

  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'company-profile-agent-automatic-activation', 1,
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_automatic_activation_operation_id, proposal.id, proposal.revision_id,
    proposal.policy_version, proposal.initiating_membership_id,
    proposal.initiating_human_subject_id
  )::text, 'UTF8')), 'hex');

  PERFORM set_config('opengeni.subject_id', service_actor, true);
  PERFORM set_config('opengeni.principal_kind', 'service', true);
  SELECT activation.event_id INTO event_id_value
  FROM company_profile_apply_activation(
    p_automatic_activation_operation_id, input_hash_value,
    p_account_id, p_workspace_id, proposal_revision.id,
    proposal.expected_current_revision_id, proposal.expected_activation_version,
    'activate', service_actor, 'service',
    'Automatically activated under the organization company-profile agent policy'
  ) activation;
  IF event_id_value IS NULL THEN
    RAISE EXCEPTION 'company-profile automatic activation returned no event'
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('opengeni.subject_id', context_subject_id, true);
  PERFORM set_config('opengeni.principal_kind', context_principal_kind, true);

  INSERT INTO company_profile_agent_automatic_activation_receipts (
    id, operation_id, input_hash, account_id, workspace_id, session_id, turn_id,
    activation_attempt_id, execution_generation, proposal_receipt_id,
    proposal_revision_id, initiating_human_subject_id, initiating_membership_id,
    policy_version, activation_event_id
  ) VALUES (
    new_receipt_id, p_automatic_activation_operation_id, input_hash_value,
    p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
    p_execution_generation, proposal.id, proposal.revision_id,
    proposal.initiating_human_subject_id, proposal.initiating_membership_id,
    proposal.policy_version, event_id_value
  );
  automatic_activation_receipt_id := new_receipt_id;
  activation_event_id := event_id_value;
  replayed := false;
  RETURN NEXT;
END
$body$;

REVOKE ALL ON FUNCTION propose_company_profile_for_attempt_v2(
  uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,text,text,text
) FROM PUBLIC;

DO $autonomous_company_profile_hardening$
DECLARE
  target_schema text := current_schema();
  runtime_role text := nullif(current_setting('opengeni.runtime_role', true), '');
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.initialize_company_profile_agent_policy() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.company_profile_agent_policy_events_immutable() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_company_profile_agent_policy(uuid,uuid,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.update_company_profile_agent_policy(uuid,uuid,text,text,bigint,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.propose_company_profile_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.propose_company_profile_for_attempt_v2('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,text,text,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  IF runtime_role IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.organization_company_profile_agent_policies FROM %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.organization_company_profile_agent_policy_events FROM %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.company_profile_agent_automatic_activation_receipts FROM %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.get_company_profile_agent_policy(uuid,uuid,text) TO %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.update_company_profile_agent_policy('
        || 'uuid,uuid,text,text,bigint,uuid) TO %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.propose_company_profile_for_attempt_v2('
        || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,text,text,text) TO %I',
      target_schema, runtime_role
    );
  END IF;
END
$autonomous_company_profile_hardening$;

COMMENT ON TABLE organization_company_profile_agent_policies IS
  'Organization-owner policy for agent-authored company-profile changes; default suggest preserves per-change confirmation, automatic permits exact owner-initiated turns to activate through the company-profile lifecycle.';
COMMENT ON TABLE company_profile_agent_automatic_activation_receipts IS
  'Immutable exact-attempt receipts for company-profile proposals activated without per-change confirmation under a frozen organization-owner automatic policy.';
