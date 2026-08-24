-- deployment-mode: rolling
-- Add an explicit, exact-attempt organization-administration path for company
-- profile proposals. Agents may stage one immutable proposal only for the live
-- turn's initiating human when that human is the organization's active owner
-- (the same authority the manual `account:admin` route requires); activation
-- requires that same human's canonical structured-input confirmation and
-- records a dedicated receipt.
--
-- Lock order (AGENTS.md canonical event-write prefix, migration 0299):
--   workspaces FOR KEY SHARE
--   -> organization_memberships FOR KEY SHARE (the 0299 membership seam takes
--      workspaces, then memberships, then sessions)
--   -> sessions / session_turns / session_turn_attempts FOR SHARE
--   -> managed_accounts: propose takes FOR KEY SHARE only; confirm reaches the
--      organization row FOR UPDATE solely through the nested
--      company_profile_apply_activation call, AFTER the session prefix.
-- No lock stronger than managed_accounts FOR KEY SHARE may precede the session
-- prefix: the canonical event writer holds sessions FOR NO KEY UPDATE and then
-- reaches managed_accounts FOR KEY SHARE through the session_events account FK,
-- so an organization-row FOR UPDATE taken before the session rows would form an
-- ABBA cycle with every concurrent same-session event append.
-- Residual: the nested company_profile_apply_activation (0201) still takes
-- managed_accounts FOR UPDATE after the session/turn/attempt FOR SHARE rows,
-- while the post-0299 membership seam (0263 suspend/offboard) opens
-- managed_accounts FOR KEY SHARE and then locks the target human's sessions FOR
-- NO KEY UPDATE; an owner confirming while being suspended/offboarded can
-- therefore be deadlock-detected (40P01, both sides retry-safe). The fix is
-- downgrading company_profile_apply_activation to KEY SHARE plus the
-- organization advisory key in the 0299 style (follow-up).
--
-- Idempotency: the propose/confirm input hashes bind account, workspace,
-- session, logical turn, operation id, content/proposal identity, and the
-- initiating membership, never the attempt id or execution generation (those
-- are persisted on the receipt rows). A replacement attempt of the same logical
-- turn re-issuing the same operation id therefore replays; a confirm retry
-- under a fresh operation id after a successful activation replays the
-- existing confirmation for that proposal instead of failing the head CAS.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE company_profile_revisions
  ADD CONSTRAINT company_profile_revisions_id_account_uq UNIQUE (id, account_id);
ALTER TABLE company_profile_activation_events
  ADD CONSTRAINT company_profile_events_id_account_uq UNIQUE (id, account_id);
ALTER TABLE company_profile_revisions
  DROP CONSTRAINT company_profile_revisions_provenance_chk;
ALTER TABLE company_profile_revisions
  ADD CONSTRAINT company_profile_revisions_provenance_chk CHECK (
    provenance_source IN ('human', 'agent_admin', 'durable_learning', 'migration')
    AND (
      provenance_source_id IS NULL
      OR length(provenance_source_id) BETWEEN 1 AND 512
    )
  ) NOT VALID;
ALTER TABLE company_profile_revisions
  VALIDATE CONSTRAINT company_profile_revisions_provenance_chk;

CREATE TABLE company_profile_agent_proposal_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  input_hash text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  creation_attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  initiating_human_subject_id text NOT NULL,
  initiating_membership_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  expected_current_revision_id uuid,
  expected_activation_version bigint NOT NULL,
  reason text NOT NULL,
  human_input jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT company_profile_agent_proposals_workspace_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_proposals_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_proposals_turn_fk
    FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_proposals_attempt_fk
    FOREIGN KEY (account_id, workspace_id, session_id, turn_id, creation_attempt_id)
    REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id)
    ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_proposals_membership_fk
    FOREIGN KEY (initiating_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_proposals_revision_fk
    FOREIGN KEY (revision_id, account_id)
    REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_proposals_expected_revision_fk
    FOREIGN KEY (expected_current_revision_id, account_id)
    REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_proposals_input_hash_check CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT company_profile_agent_proposals_generation_check CHECK (
    execution_generation > 0 AND expected_activation_version >= 0
  ),
  CONSTRAINT company_profile_agent_proposals_subject_check CHECK (
    octet_length(btrim(initiating_human_subject_id)) BETWEEN 1 AND 1024
  ),
  CONSTRAINT company_profile_agent_proposals_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 4096
    AND octet_length(convert_to(btrim(reason), 'UTF8')) <= 16384
  ),
  CONSTRAINT company_profile_agent_proposals_human_input_check CHECK (
    jsonb_typeof(human_input) = 'object'
    AND jsonb_array_length(human_input->'questions') = 1
    AND human_input->>'allowSkip' = 'false'
    AND octet_length(human_input::text) <= 49152
  )
);
CREATE UNIQUE INDEX company_profile_agent_proposals_account_operation_uq
  ON company_profile_agent_proposal_receipts (account_id, operation_id);
CREATE UNIQUE INDEX company_profile_agent_proposals_account_revision_uq
  ON company_profile_agent_proposal_receipts (account_id, revision_id);
ALTER TABLE company_profile_agent_proposal_receipts
  ADD CONSTRAINT company_profile_agent_proposals_id_account_uq UNIQUE (id, account_id);
CREATE INDEX company_profile_agent_proposals_turn_idx
  ON company_profile_agent_proposal_receipts (
    workspace_id, session_id, turn_id, execution_generation
  );

CREATE TABLE company_profile_agent_confirmation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  input_hash text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  confirmation_attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  proposal_receipt_id uuid NOT NULL,
  proposal_revision_id uuid NOT NULL,
  human_input_request_id uuid NOT NULL,
  approver_subject_id text NOT NULL,
  approver_membership_id uuid NOT NULL,
  activation_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT company_profile_agent_confirmations_workspace_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_confirmations_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_confirmations_turn_fk
    FOREIGN KEY (workspace_id, turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_confirmations_attempt_fk
    FOREIGN KEY (account_id, workspace_id, session_id, turn_id, confirmation_attempt_id)
    REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id)
    ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_confirmations_proposal_fk
    FOREIGN KEY (proposal_receipt_id, account_id)
    REFERENCES company_profile_agent_proposal_receipts(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_confirmations_revision_fk
    FOREIGN KEY (proposal_revision_id, account_id)
    REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_confirmations_human_input_fk
    FOREIGN KEY (human_input_request_id)
    REFERENCES session_human_input_requests(id) ON DELETE CASCADE,
  CONSTRAINT company_profile_agent_confirmations_membership_fk
    FOREIGN KEY (approver_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_confirmations_event_fk
    FOREIGN KEY (activation_event_id, account_id)
    REFERENCES company_profile_activation_events(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT company_profile_agent_confirmations_input_hash_check CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT company_profile_agent_confirmations_generation_check CHECK (
    execution_generation > 0
  ),
  CONSTRAINT company_profile_agent_confirmations_subject_check CHECK (
    octet_length(btrim(approver_subject_id)) BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX company_profile_agent_confirmations_account_operation_uq
  ON company_profile_agent_confirmation_receipts (account_id, operation_id);
CREATE UNIQUE INDEX company_profile_agent_confirmations_proposal_uq
  ON company_profile_agent_confirmation_receipts (account_id, proposal_receipt_id);
CREATE UNIQUE INDEX company_profile_agent_confirmations_event_uq
  ON company_profile_agent_confirmation_receipts (account_id, activation_event_id);

ALTER TABLE company_profile_agent_proposal_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profile_agent_proposal_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE company_profile_agent_confirmation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profile_agent_confirmation_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE company_profile_agent_proposal_receipts FROM PUBLIC;
REVOKE ALL ON TABLE company_profile_agent_confirmation_receipts FROM PUBLIC;
CREATE POLICY company_profile_agent_admin_lifecycle
  ON company_profile_agent_proposal_receipts
  USING (current_setting('opengeni.company_profile_agent_admin_lifecycle', true)
    = 'company_profile_agent_admin')
  WITH CHECK (current_setting('opengeni.company_profile_agent_admin_lifecycle', true)
    = 'company_profile_agent_admin');
CREATE POLICY company_profile_agent_admin_lifecycle
  ON company_profile_agent_confirmation_receipts
  USING (current_setting('opengeni.company_profile_agent_admin_lifecycle', true)
    = 'company_profile_agent_admin')
  WITH CHECK (current_setting('opengeni.company_profile_agent_admin_lifecycle', true)
    = 'company_profile_agent_admin');
CREATE POLICY session_visibility_isolation
  ON company_profile_agent_proposal_receipts AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));
CREATE POLICY session_visibility_isolation
  ON company_profile_agent_confirmation_receipts AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

CREATE FUNCTION company_profile_agent_receipts_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM managed_accounts account WHERE account.id = OLD.account_id)
      OR NOT EXISTS (
        SELECT 1 FROM sessions session
        WHERE session.account_id = OLD.account_id
          AND session.workspace_id = OLD.workspace_id
          AND session.id = OLD.session_id
      )
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'company-profile agent administration receipts are immutable'
    USING ERRCODE = '55000';
END
$body$;
CREATE TRIGGER company_profile_agent_proposals_immutable
  BEFORE UPDATE OR DELETE ON company_profile_agent_proposal_receipts
  FOR EACH ROW EXECUTE FUNCTION company_profile_agent_receipts_immutable();
CREATE TRIGGER company_profile_agent_confirmations_immutable
  BEFORE UPDATE OR DELETE ON company_profile_agent_confirmation_receipts
  FOR EACH ROW EXECUTE FUNCTION company_profile_agent_receipts_immutable();

CREATE FUNCTION company_profile_agent_confirmation_summary(p_content_json text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $body$
DECLARE
  profile jsonb := p_content_json::jsonb;
  summary text;
  list_name text;
  list_text text;
BEGIN
  summary := 'Identity: ' || coalesce(nullif(btrim(profile->>'identity'), ''), '(none)')
    || E'\nMission: ' || coalesce(nullif(btrim(profile->>'mission'), ''), '(none)');
  FOREACH list_name IN ARRAY ARRAY['products', 'customers', 'goals', 'constraints'] LOOP
    SELECT string_agg('- ' || (item->>'key') || ': ' || (item->>'content'), E'\n'
      ORDER BY entries.ordinality)
    INTO list_text
    FROM jsonb_array_elements(coalesce(profile->list_name, '[]'::jsonb))
      WITH ORDINALITY AS entries(item, ordinality);
    summary := summary || E'\n' || initcap(list_name) || ':' || E'\n'
      || coalesce(list_text, '- (none)');
  END LOOP;
  -- HumanInputQuestion.helpText is capped at 2048 UTF-16 code units; the
  -- revision/hash prefix uses under 100. Bound the rendered bytes (a UTF-16 unit
  -- never needs more bytes than it needs units) without splitting a character.
  IF octet_length(summary) > 1800 THEN
    WHILE octet_length(summary) > 1797 LOOP
      summary := left(
        summary,
        length(summary) - greatest(1, (octet_length(summary) - 1797) / 4)
      );
    END LOOP;
    summary := summary || '...';
  END IF;
  RETURN summary;
END
$body$;
REVOKE ALL ON FUNCTION company_profile_agent_confirmation_summary(text) FROM PUBLIC;

CREATE FUNCTION company_profile_agent_confirmation_prompt(
  p_revision_id uuid,
  p_revision bigint,
  p_content_hash text,
  p_content_json text
) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $body$
  SELECT jsonb_build_object(
    'questions', jsonb_build_array(jsonb_build_object(
      'id', 'company-profile:' || p_revision_id::text,
      'kind', 'single_select',
      'prompt', 'Activate this organization company profile and strategic goals?',
      'label', 'Company profile',
      'helpText', 'Revision ' || p_revision::text || '; SHA-256 ' || p_content_hash
        || E'.\n\n' || company_profile_agent_confirmation_summary(p_content_json),
      'options', jsonb_build_array(
        jsonb_build_object('id', 'activate', 'label', 'Activate'),
        jsonb_build_object('id', 'skip', 'label', 'Do not activate')
      ),
      'required', true,
      -- The stock runtime exposes Other on every choice question. Keep the
      -- persisted contract byte-for-byte stable across that normalization;
      -- confirmation below still accepts only the exact `activate` value.
      'allowOther', true
    )),
    'allowSkip', false
  )
$body$;
REVOKE ALL ON FUNCTION company_profile_agent_confirmation_prompt(uuid, bigint, text, text)
  FROM PUBLIC;

CREATE FUNCTION propose_company_profile_for_attempt(
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

  -- Resolve the exact logical turn's initiating human with a plain read; no
  -- row lock may precede the canonical workspace/session prefix below.
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

  -- Canonical prefix: workspaces FOR KEY SHARE, then the membership row FOR KEY
  -- SHARE (the 0299 membership seam orders workspaces -> memberships ->
  -- sessions), then the exact session/turn/attempt rows FOR SHARE.
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

  -- Organization row AFTER the session prefix, FOR KEY SHARE only: compatible
  -- with every ordinary writer's FK check, while the manual route's FOR UPDATE
  -- (held across its head mutation) cannot interleave with the head read below.
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization account is unavailable' USING ERRCODE = '42501';
  END IF;

  -- The hash binds the logical turn, never the attempt id or execution
  -- generation: a replacement attempt re-issuing the same operation id replays.
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
    expected_current_revision_id, expected_activation_version, reason, human_input
  ) VALUES (
    new_receipt_id, p_operation_id, input_hash_value, p_account_id, p_workspace_id,
    p_session_id, p_turn_id, p_attempt_id, p_execution_generation,
    actor_membership.subject_id, actor_membership.id, inserted_revision.id,
    active_head.revision_id, coalesce(active_head.activation_version, 0),
    normalized_reason, prompt
  );
  receipt_id := new_receipt_id;
  revision_id := inserted_revision.id;
  human_input := prompt;
  replayed := false;
  RETURN NEXT;
END
$body$;

CREATE FUNCTION confirm_company_profile_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_proposal_receipt_id uuid,
  p_human_input_request_id uuid
) RETURNS TABLE (
  receipt_id uuid,
  activation_event_id uuid,
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
  proposal company_profile_agent_proposal_receipts%ROWTYPE;
  proposal_revision company_profile_revisions%ROWTYPE;
  human_input_row session_human_input_requests%ROWTYPE;
  active_head company_profile_heads%ROWTYPE;
  prior company_profile_agent_confirmation_receipts%ROWTYPE;
  input_hash_value text;
  event_id_value uuid;
  new_receipt_id uuid := gen_random_uuid();
  question_id text;
BEGIN
  IF context_account_id IS DISTINCT FROM p_account_id
    OR context_workspace_id IS DISTINCT FROM p_workspace_id
    OR context_subject_id IS NULL
    OR context_principal_kind IS DISTINCT FROM 'agent_attempt'
    OR p_execution_generation < 1
    OR p_operation_id IS NULL
    OR p_proposal_receipt_id IS NULL
    OR p_human_input_request_id IS NULL
  THEN
    RAISE EXCEPTION 'company-profile agent confirmation is invalid' USING ERRCODE = '22023';
  END IF;

  -- Resolve the exact logical turn's initiating human with a plain read; no
  -- row lock may precede the canonical workspace/session prefix below.
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
      'company-profile confirmation requires the exact live turn of the active organization owner'
      USING ERRCODE = '42501';
  END IF;

  -- Canonical prefix: workspaces FOR KEY SHARE, then the membership row FOR KEY
  -- SHARE (the 0299 membership seam orders workspaces -> memberships ->
  -- sessions), then the exact session/turn/attempt rows FOR SHARE.
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
      'company-profile confirmation requires the exact live turn of the active organization owner'
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
      'company-profile confirmation requires the exact live turn of the active organization owner'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config(
    'opengeni.company_profile_agent_admin_lifecycle',
    'company_profile_agent_admin', true
  );
  SELECT * INTO proposal FROM company_profile_agent_proposal_receipts receipt
  WHERE receipt.id = p_proposal_receipt_id
    AND receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.session_id = p_session_id
    AND receipt.turn_id = p_turn_id
  FOR SHARE;
  IF NOT FOUND
    OR proposal.initiating_human_subject_id IS DISTINCT FROM actor_membership.subject_id
    OR proposal.initiating_membership_id IS DISTINCT FROM actor_membership.id
  THEN
    RAISE EXCEPTION 'company-profile proposal is unavailable for this authority'
      USING ERRCODE = '42501';
  END IF;

  -- The hash binds the logical turn, never the execution generation: a
  -- replacement attempt re-issuing the same operation id replays.
  input_hash_value := encode(sha256(convert_to(jsonb_build_array(
    'company-profile-agent-confirmation', 1, p_account_id, p_workspace_id,
    p_session_id, p_turn_id, p_operation_id,
    proposal.id, proposal.revision_id, p_human_input_request_id,
    actor_membership.id, actor_membership.subject_id
  )::text, 'UTF8')), 'hex');
  SELECT * INTO prior FROM company_profile_agent_confirmation_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.operation_id = p_operation_id;
  IF FOUND THEN
    IF prior.input_hash IS DISTINCT FROM input_hash_value THEN
      RAISE EXCEPTION 'company-profile agent confirmation operation id was reused'
        USING ERRCODE = 'P1851';
    END IF;
    receipt_id := prior.id;
    activation_event_id := prior.activation_event_id;
    replayed := true;
    RETURN NEXT;
    RETURN;
  END IF;
  -- A proposal activates at most once (company_profile_agent_confirmations_
  -- proposal_uq). A retry under a fresh operation id after a successful
  -- activation, for the same proposal and the same bound human-input request,
  -- replays the existing confirmation instead of failing the head CAS below.
  SELECT * INTO prior FROM company_profile_agent_confirmation_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.proposal_receipt_id = proposal.id;
  IF FOUND THEN
    IF prior.human_input_request_id IS DISTINCT FROM p_human_input_request_id THEN
      RAISE EXCEPTION
        'company-profile proposal was already activated through a different human confirmation'
        USING ERRCODE = '42501';
    END IF;
    receipt_id := prior.id;
    activation_event_id := prior.activation_event_id;
    replayed := true;
    RETURN NEXT;
    RETURN;
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
  question_id := 'company-profile:' || proposal_revision.id::text;
  SELECT * INTO human_input_row FROM session_human_input_requests request
  WHERE request.id = p_human_input_request_id
    AND request.account_id = p_account_id
    AND request.workspace_id = p_workspace_id
    AND request.session_id = p_session_id
    AND request.turn_id = p_turn_id
    AND proposal.execution_generation <= request.turn_generation
    AND request.turn_generation < p_execution_generation
    AND request.status = 'answered'
    AND request.responded_by = actor_membership.subject_id
    AND request.allow_skip = false
    AND request.questions = proposal.human_input->'questions'
    AND request.response->>'outcome' = 'answered'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(request.response->'answers') answer(value)
      WHERE answer.value->>'questionId' = question_id
        AND answer.value->'values' = '["activate"]'::jsonb
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'human confirmation for this company profile is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO active_head FROM company_profile_heads head
  WHERE head.account_id = p_account_id;
  IF active_head.revision_id IS DISTINCT FROM proposal.expected_current_revision_id
    OR coalesce(active_head.activation_version, 0)
      IS DISTINCT FROM proposal.expected_activation_version
  THEN
    RAISE EXCEPTION 'company profile changed after the proposal was reviewed'
      USING ERRCODE = '40001';
  END IF;

  -- The nested lifecycle function takes managed_accounts FOR UPDATE and then
  -- company_profile_heads FOR UPDATE; both happen after the session prefix
  -- above, matching the canonical event writer's sessions -> managed_accounts
  -- direction.
  PERFORM set_config('opengeni.subject_id', actor_membership.subject_id, true);
  PERFORM set_config('opengeni.principal_kind', 'human_session', true);
  SELECT activation.event_id INTO event_id_value
  FROM company_profile_apply_activation(
    p_operation_id, input_hash_value, p_account_id, p_workspace_id,
    proposal_revision.id, proposal.expected_current_revision_id,
    proposal.expected_activation_version, 'activate',
    actor_membership.subject_id, 'human_session', proposal.reason
  ) activation;
  IF event_id_value IS NULL THEN
    RAISE EXCEPTION 'company-profile activation returned no event' USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('opengeni.subject_id', context_subject_id, true);
  PERFORM set_config('opengeni.principal_kind', context_principal_kind, true);

  INSERT INTO company_profile_agent_confirmation_receipts (
    id, operation_id, input_hash, account_id, workspace_id, session_id, turn_id,
    confirmation_attempt_id, execution_generation, proposal_receipt_id,
    proposal_revision_id, human_input_request_id, approver_subject_id,
    approver_membership_id, activation_event_id
  ) VALUES (
    new_receipt_id, p_operation_id, input_hash_value, p_account_id, p_workspace_id,
    p_session_id, p_turn_id, p_attempt_id, p_execution_generation, proposal.id,
    proposal_revision.id, human_input_row.id, actor_membership.subject_id,
    actor_membership.id, event_id_value
  );
  receipt_id := new_receipt_id;
  activation_event_id := event_id_value;
  replayed := false;
  RETURN NEXT;
END
$body$;

REVOKE ALL ON FUNCTION propose_company_profile_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_company_profile_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid
) FROM PUBLIC;

DO $company_profile_agent_admin_hardening$
DECLARE
  target_schema text := current_schema();
  runtime_role text := nullif(current_setting('opengeni.runtime_role', true), '');
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.company_profile_agent_receipts_immutable() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.company_profile_agent_confirmation_summary(text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.company_profile_agent_confirmation_prompt(uuid,bigint,text,text) '
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
    'ALTER FUNCTION %I.confirm_company_profile_for_attempt('
      || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  IF runtime_role IS NULL AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app'
  ) THEN
    runtime_role := 'opengeni_app';
  END IF;
  IF runtime_role IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.propose_company_profile_for_attempt('
        || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text) TO %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.confirm_company_profile_for_attempt('
        || 'uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid) TO %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.company_profile_agent_proposal_receipts FROM %I',
      target_schema, runtime_role
    );
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.company_profile_agent_confirmation_receipts FROM %I',
      target_schema, runtime_role
    );
  END IF;
END
$company_profile_agent_admin_hardening$;