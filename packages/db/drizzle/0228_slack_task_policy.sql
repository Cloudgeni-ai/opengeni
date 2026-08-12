-- deployment-mode: rolling
-- Add an immutable, workspace-owned authority for shared Slack conversation
-- participation and result publication. No existing non-shared Slack path is
-- changed by this migration.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE SEQUENCE slack_task_policy_revision_seq AS bigint;

CREATE OR REPLACE FUNCTION slack_task_policy_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  key text;
  ids jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 7
    OR NOT (
      value ? 'allowedTeamIds'
      AND value ? 'allowedConversationIds'
      AND value ? 'allowGuestInitiators'
      AND value ? 'allowExternalInitiators'
      AND value ? 'allowMpim'
      AND value ? 'sharedConversationMode'
      AND value ? 'resultPublicationMode'
    )
    OR jsonb_typeof(value->'allowedTeamIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'allowedConversationIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(value->'allowedTeamIds') > 256
    OR jsonb_array_length(value->'allowedConversationIds') > 256
    OR jsonb_typeof(value->'allowGuestInitiators') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'allowExternalInitiators') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'allowMpim') IS DISTINCT FROM 'boolean'
    OR value->>'sharedConversationMode' NOT IN ('deny', 'private_handoff')
    OR value->>'resultPublicationMode' NOT IN ('never', 'approval_required', 'allow')
    OR octet_length(convert_to(value::text, 'UTF8')) > 65536
  THEN
    RETURN false;
  END IF;

  FOREACH key IN ARRAY ARRAY['allowedTeamIds', 'allowedConversationIds'] LOOP
    ids := value->key;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(ids) item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
        OR length(btrim(item #>> '{}')) NOT BETWEEN 1 AND 128
        OR item #>> '{}' IS DISTINCT FROM btrim(item #>> '{}')
    ) OR (
      SELECT count(DISTINCT item #>> '{}') FROM jsonb_array_elements(ids) item
    ) <> jsonb_array_length(ids) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION slack_task_policy_hash(policy jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array('slack_task_policy', 1, policy)::text, 'UTF8')), 'hex');
$$;

REVOKE ALL ON FUNCTION slack_task_policy_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION slack_task_policy_hash(jsonb) FROM PUBLIC;

CREATE TABLE slack_task_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT nextval('slack_task_policy_revision_seq'),
  policy jsonb NOT NULL,
  policy_hash text NOT NULL,
  supersedes_revision_id uuid,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_task_policy_revisions_revision_chk CHECK (revision > 0),
  CONSTRAINT slack_task_policy_revisions_policy_chk CHECK (
    slack_task_policy_valid(policy) AND policy_hash = slack_task_policy_hash(policy)
  ),
  CONSTRAINT slack_task_policy_revisions_receipt_chk CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_task_policy_revisions_actor_chk CHECK (
    length(btrim(created_by_subject_id)) BETWEEN 1 AND 1024
  ),
  CONSTRAINT slack_task_policy_revisions_workspace_operation_uq UNIQUE (workspace_id, operation_id),
  CONSTRAINT slack_task_policy_revisions_workspace_revision_uq UNIQUE (workspace_id, revision),
  CONSTRAINT slack_task_policy_revisions_workspace_identity_uq UNIQUE (account_id, workspace_id, id),
  CONSTRAINT slack_task_policy_revisions_supersedes_fk
    FOREIGN KEY (account_id, workspace_id, supersedes_revision_id)
    REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX slack_task_policy_revisions_workspace_history_idx
  ON slack_task_policy_revisions(workspace_id, revision DESC);

CREATE TABLE slack_task_policy_heads (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  revision bigint NOT NULL,
  policy_hash text NOT NULL,
  activation_version bigint NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_task_policy_heads_revision_fk
    FOREIGN KEY (account_id, workspace_id, revision_id)
    REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT slack_task_policy_heads_version_chk CHECK (
    revision > 0 AND activation_version > 0 AND policy_hash ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX slack_task_policy_heads_account_idx ON slack_task_policy_heads(account_id);

CREATE TABLE slack_task_policy_activation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  request_fingerprint text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  activation_version bigint NOT NULL,
  old_revision_id uuid,
  old_revision bigint,
  old_policy_hash text,
  new_revision_id uuid NOT NULL,
  new_revision bigint NOT NULL,
  new_policy_hash text NOT NULL,
  actor_subject_id text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_task_policy_events_old_revision_chk CHECK (
    (old_revision_id IS NULL AND old_revision IS NULL AND old_policy_hash IS NULL)
    OR (old_revision_id IS NOT NULL AND old_revision > 0 AND old_policy_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT slack_task_policy_events_new_revision_chk CHECK (
    new_revision > 0 AND new_policy_hash ~ '^[0-9a-f]{64}$' AND activation_version > 0
  ),
  CONSTRAINT slack_task_policy_events_receipt_chk CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT slack_task_policy_events_audit_chk CHECK (
    length(btrim(actor_subject_id)) BETWEEN 1 AND 1024
    AND length(btrim(reason)) BETWEEN 1 AND 4096
  ),
  CONSTRAINT slack_task_policy_events_workspace_operation_uq UNIQUE (workspace_id, operation_id),
  CONSTRAINT slack_task_policy_events_workspace_version_uq UNIQUE (workspace_id, activation_version),
  CONSTRAINT slack_task_policy_events_new_revision_fk
    FOREIGN KEY (account_id, workspace_id, new_revision_id)
    REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX slack_task_policy_events_workspace_time_idx
  ON slack_task_policy_activation_events(workspace_id, created_at DESC, id);

CREATE TABLE slack_shared_task_origins (
  interaction_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  slack_team_id text NOT NULL,
  source_channel_id text NOT NULL,
  source_thread_ts text NOT NULL,
  initiating_slack_user_id text NOT NULL,
  policy_revision_id uuid NOT NULL,
  policy_hash text NOT NULL,
  policy_activation_version bigint NOT NULL,
  publication_mode text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_shared_task_origins_interaction_fk
    FOREIGN KEY (account_id, workspace_id, interaction_id)
    REFERENCES slack_interactions(account_id, workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT slack_shared_task_origins_policy_fk
    FOREIGN KEY (account_id, workspace_id, policy_revision_id)
    REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT slack_shared_task_origins_identity_uq UNIQUE (workspace_id, session_id),
  CONSTRAINT slack_shared_task_origins_bounds_chk CHECK (
    length(slack_team_id) BETWEEN 1 AND 128
    AND length(source_channel_id) BETWEEN 1 AND 128
    AND length(source_thread_ts) BETWEEN 1 AND 64
    AND length(initiating_slack_user_id) BETWEEN 1 AND 128
    AND policy_hash ~ '^[0-9a-f]{64}$'
    AND policy_activation_version > 0
    AND publication_mode IN ('never', 'approval_required', 'allow')
  )
);

CREATE OR REPLACE FUNCTION slack_shared_task_origin_forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Slack shared task origin is immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER slack_shared_task_origins_immutable
  BEFORE UPDATE OR DELETE ON slack_shared_task_origins
  FOR EACH ROW EXECUTE FUNCTION slack_shared_task_origin_forbid_mutation();

ALTER TABLE slack_interaction_action_handles
  DROP CONSTRAINT slack_interaction_action_handles_bounds_check;
ALTER TABLE slack_interaction_action_handles
  ADD CONSTRAINT slack_interaction_action_handles_bounds_check CHECK (
    session_event_sequence >= 0
    AND octet_length(action_kind) BETWEEN 1 AND 64
    AND octet_length(action_key) BETWEEN 1 AND 512
    AND (target_id IS NULL OR octet_length(target_id) BETWEEN 1 AND 512)
    AND (target_value IS NULL OR octet_length(target_value) BETWEEN 1 AND 1024)
    AND octet_length(authorized_subject_id) BETWEEN 1 AND 512
    AND octet_length(authorized_slack_user_id) BETWEEN 1 AND 64
    AND action_kind IN (
      'approval_approve', 'approval_reject', 'human_input_select',
      'human_input_skip', 'session_status', 'session_pause', 'session_resume',
      'shared_result_publish'
    )
    AND status IN ('pending', 'completed', 'stale')
    AND (result IS NULL OR octet_length(result) BETWEEN 1 AND 64)
    AND (
      (status = 'pending' AND result IS NULL AND completed_at IS NULL)
      OR (status IN ('completed', 'stale') AND result IS NOT NULL AND completed_at IS NOT NULL)
    )
  ) NOT VALID;
ALTER TABLE slack_interaction_action_handles
  VALIDATE CONSTRAINT slack_interaction_action_handles_bounds_check;

CREATE OR REPLACE FUNCTION slack_task_policy_forbid_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Slack task policy history is immutable' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER slack_task_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON slack_task_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION slack_task_policy_forbid_mutation();
CREATE TRIGGER slack_task_policy_events_immutable
  BEFORE UPDATE OR DELETE ON slack_task_policy_activation_events
  FOR EACH ROW EXECUTE FUNCTION slack_task_policy_forbid_mutation();

CREATE OR REPLACE FUNCTION slack_task_policy_guard_head_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_workspace_id text;
BEGIN
  expected_workspace_id := current_setting('opengeni.slack_task_policy_lifecycle_workspace_id', true);
  IF expected_workspace_id IS NULL OR expected_workspace_id = ''
    OR expected_workspace_id IS DISTINCT FROM coalesce(NEW.workspace_id, OLD.workspace_id)::text
  THEN
    RAISE EXCEPTION 'Slack task policy head mutation is lifecycle-only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER slack_task_policy_heads_lifecycle_only
  BEFORE INSERT OR UPDATE OR DELETE ON slack_task_policy_heads
  FOR EACH ROW EXECUTE FUNCTION slack_task_policy_guard_head_mutation();

CREATE OR REPLACE FUNCTION slack_task_policy_update(
  p_operation_id uuid,
  p_request_fingerprint text,
  p_account_id uuid,
  p_workspace_id uuid,
  p_policy jsonb,
  p_expected_current_revision_id uuid,
  p_expected_activation_version bigint,
  p_actor_subject_id text,
  p_reason text
) RETURNS TABLE (revision_id uuid, event_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  current_head slack_task_policy_heads%ROWTYPE;
  existing_revision slack_task_policy_revisions%ROWTYPE;
  existing_event slack_task_policy_activation_events%ROWTYPE;
  created_revision slack_task_policy_revisions%ROWTYPE;
  next_version bigint;
  accepted_at timestamptz;
BEGIN
  IF NULLIF(current_setting('opengeni.account_id', true), '')::uuid IS DISTINCT FROM p_account_id
    OR NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid IS DISTINCT FROM p_workspace_id
    OR NULLIF(current_setting('opengeni.subject_id', true), '') IS DISTINCT FROM p_actor_subject_id
    OR NULLIF(current_setting('opengeni.principal_kind', true), '') IS DISTINCT FROM 'human_session'
  THEN
    RAISE EXCEPTION 'Slack task policy update requires exact human workspace authority'
      USING ERRCODE = '42501';
  END IF;
  IF p_request_fingerprint !~ '^[0-9a-f]{64}$'
    OR p_expected_activation_version < 0
    OR NOT slack_task_policy_valid(p_policy)
    OR length(btrim(p_actor_subject_id)) NOT BETWEEN 1 AND 1024
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4096
  THEN
    RAISE EXCEPTION 'Slack task policy update input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM workspaces
  WHERE id = p_workspace_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace was not found' USING ERRCODE = '42501'; END IF;

  SELECT * INTO existing_revision FROM slack_task_policy_revisions
  WHERE workspace_id = p_workspace_id AND operation_id = p_operation_id;
  SELECT * INTO existing_event FROM slack_task_policy_activation_events
  WHERE workspace_id = p_workspace_id AND operation_id = p_operation_id;
  IF existing_revision.id IS NOT NULL OR existing_event.id IS NOT NULL THEN
    IF existing_revision.id IS NULL OR existing_event.id IS NULL
      OR existing_revision.request_fingerprint IS DISTINCT FROM p_request_fingerprint
      OR existing_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint
    THEN
      RAISE EXCEPTION 'Slack task policy operation id was reused' USING ERRCODE = 'P1471';
    END IF;
    revision_id := existing_revision.id;
    event_id := existing_event.id;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO current_head FROM slack_task_policy_heads
  WHERE workspace_id = p_workspace_id FOR UPDATE;
  IF coalesce(current_head.activation_version, 0) IS DISTINCT FROM p_expected_activation_version
    OR current_head.revision_id IS DISTINCT FROM p_expected_current_revision_id
  THEN
    RAISE EXCEPTION 'Slack task policy active revision changed' USING ERRCODE = '40001';
  END IF;

  accepted_at := clock_timestamp();
  INSERT INTO slack_task_policy_revisions (
    operation_id, request_fingerprint, account_id, workspace_id, policy, policy_hash,
    supersedes_revision_id, created_by_subject_id, created_at
  ) VALUES (
    p_operation_id, p_request_fingerprint, p_account_id, p_workspace_id, p_policy,
    slack_task_policy_hash(p_policy), current_head.revision_id, p_actor_subject_id, accepted_at
  ) RETURNING * INTO created_revision;

  next_version := coalesce(current_head.activation_version, 0) + 1;
  PERFORM set_config('opengeni.slack_task_policy_lifecycle_workspace_id', p_workspace_id::text, true);
  INSERT INTO slack_task_policy_heads (
    account_id, workspace_id, revision_id, revision, policy_hash, activation_version, activated_at
  ) VALUES (
    p_account_id, p_workspace_id, created_revision.id, created_revision.revision,
    created_revision.policy_hash, next_version, accepted_at
  ) ON CONFLICT (workspace_id) DO UPDATE SET
    revision_id = excluded.revision_id,
    revision = excluded.revision,
    policy_hash = excluded.policy_hash,
    activation_version = excluded.activation_version,
    activated_at = excluded.activated_at;
  PERFORM set_config('opengeni.slack_task_policy_lifecycle_workspace_id', '', true);

  INSERT INTO slack_task_policy_activation_events (
    operation_id, request_fingerprint, account_id, workspace_id, activation_version,
    old_revision_id, old_revision, old_policy_hash,
    new_revision_id, new_revision, new_policy_hash,
    actor_subject_id, reason, created_at
  ) VALUES (
    p_operation_id, p_request_fingerprint, p_account_id, p_workspace_id, next_version,
    current_head.revision_id, current_head.revision, current_head.policy_hash,
    created_revision.id, created_revision.revision, created_revision.policy_hash,
    p_actor_subject_id, p_reason, accepted_at
  ) RETURNING id INTO event_id;
  revision_id := created_revision.id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION slack_task_policy_update(uuid,text,uuid,uuid,jsonb,uuid,bigint,text,text) FROM PUBLIC;

ALTER TABLE slack_task_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_task_policy_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_task_policy_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_task_policy_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_task_policy_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_task_policy_activation_events FORCE ROW LEVEL SECURITY;
ALTER TABLE slack_shared_task_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_shared_task_origins FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON slack_task_policy_revisions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON slack_task_policy_heads
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON slack_task_policy_activation_events
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON slack_shared_task_origins
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE slack_task_policy_revisions FROM PUBLIC;
REVOKE ALL ON TABLE slack_task_policy_heads FROM PUBLIC;
REVOKE ALL ON TABLE slack_task_policy_activation_events FROM PUBLIC;
REVOKE ALL ON TABLE slack_shared_task_origins FROM PUBLIC;
REVOKE ALL ON SEQUENCE slack_task_policy_revision_seq FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT ON TABLE slack_task_policy_revisions TO opengeni_app;
    GRANT SELECT ON TABLE slack_task_policy_heads TO opengeni_app;
    GRANT SELECT ON TABLE slack_task_policy_activation_events TO opengeni_app;
    GRANT SELECT, INSERT ON TABLE slack_shared_task_origins TO opengeni_app;
    GRANT EXECUTE ON FUNCTION slack_task_policy_update(uuid,text,uuid,uuid,jsonb,uuid,bigint,text,text)
      TO opengeni_app;
  END IF;
END $grants$;
