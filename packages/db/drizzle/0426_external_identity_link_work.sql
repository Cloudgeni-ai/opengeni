-- deployment-mode: maintenance
-- Link provenance is separate from ownership and from historical creator audit.
-- An inherited revoked link remains attached: omission must never turn old work
-- into an unrestricted native-user operation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' THEN
    RAISE EXCEPTION '0426 requires application database roles' USING ERRCODE = '55000';
  END IF;
  IF jsonb_array_length(roles) NOT BETWEEN 1 AND 16 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}')
      OR octet_length(item #>> '{}') > 63
  ) THEN RAISE EXCEPTION '0426 invalid application roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0426 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;

CREATE TABLE external_link_turn_authorities (
  turn_id uuid PRIMARY KEY REFERENCES session_turns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  link_id uuid NOT NULL REFERENCES external_identity_links(id),
  link_revision bigint NOT NULL CHECK (link_revision BETWEEN 1 AND 9007199254740991),
  canonical_snapshot jsonb NOT NULL CHECK (jsonb_typeof(canonical_snapshot) = 'object' AND octet_length(canonical_snapshot::text) <= 65536),
  source_kind text NOT NULL CHECK (source_kind IN ('direct','causal','child','scheduled')),
  source_turn_id uuid REFERENCES session_turns(id),
  source_task_id uuid REFERENCES scheduled_tasks(id),
  source_task_revision bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id),
  CHECK ((source_kind = 'direct' AND source_turn_id IS NULL AND source_task_id IS NULL AND source_task_revision IS NULL)
    OR (source_kind IN ('causal','child') AND source_turn_id IS NOT NULL AND source_task_id IS NULL AND source_task_revision IS NULL)
    OR (source_kind = 'scheduled' AND source_turn_id IS NULL AND source_task_id IS NOT NULL AND source_task_revision > 0))
);
CREATE TABLE external_link_task_authorities (
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  task_revision bigint NOT NULL CHECK (task_revision BETWEEN 1 AND 9007199254740991),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  link_id uuid NOT NULL REFERENCES external_identity_links(id),
  link_revision bigint NOT NULL CHECK (link_revision BETWEEN 1 AND 9007199254740991),
  canonical_snapshot jsonb NOT NULL CHECK (jsonb_typeof(canonical_snapshot) = 'object' AND octet_length(canonical_snapshot::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, task_revision),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id)
);
ALTER TABLE external_link_turn_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_link_turn_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE external_link_task_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_link_task_authorities FORCE ROW LEVEL SECURITY;
CREATE POLICY external_link_turn_authorities_scope ON external_link_turn_authorities
  USING (account_id = opengeni_private.current_account_id() AND workspace_id = opengeni_private.current_workspace_id())
  WITH CHECK (account_id = opengeni_private.current_account_id() AND workspace_id = opengeni_private.current_workspace_id());
CREATE POLICY external_link_task_authorities_scope ON external_link_task_authorities
  USING (account_id = opengeni_private.current_account_id() AND workspace_id = opengeni_private.current_workspace_id())
  WITH CHECK (account_id = opengeni_private.current_account_id() AND workspace_id = opengeni_private.current_workspace_id());

CREATE FUNCTION opengeni_private.guard_external_link_work_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
DECLARE
  l external_identity_links%ROWTYPE;
  t session_turns%ROWTYPE;
  s sessions%ROWTYPE;
  source_snapshot jsonb;
  revision_authority jsonb;
BEGIN
  IF TG_OP <> 'INSERT' OR NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id() THEN
    RAISE EXCEPTION 'external link work scope unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO l FROM external_identity_links WHERE id = NEW.link_id AND account_id = NEW.account_id;
  IF NOT FOUND OR l.native_subject_id IS NULL
    OR NEW.canonical_snapshot #>> '{actor,accountId}' IS DISTINCT FROM NEW.account_id::text
    OR NEW.canonical_snapshot #>> '{actor,linkId}' IS DISTINCT FROM NEW.link_id::text
    OR NEW.canonical_snapshot #>> '{actor,linkRevision}' IS DISTINCT FROM NEW.link_revision::text
    OR NEW.canonical_snapshot #>> '{actor,actingMode}' IS DISTINCT FROM 'linked_native'
    OR NEW.canonical_snapshot #>> '{actor,effectiveSubjectId}' IS DISTINCT FROM l.native_subject_id
    OR NEW.canonical_snapshot #>> '{actor,externalIdentityId}' IS DISTINCT FROM l.external_identity_id::text
    OR NEW.canonical_snapshot #>> '{actor,externalSubjectId}' IS DISTINCT FROM l.external_subject_id
    OR NEW.canonical_snapshot #>> '{actor,externalAuthorizationRevision}' IS DISTINCT FROM l.external_authorization_revision::text
    OR jsonb_typeof(NEW.canonical_snapshot -> 'permissions') IS DISTINCT FROM 'array'
    OR NOT (NEW.canonical_snapshot -> 'permissions') <@ l.permissions THEN
    RAISE EXCEPTION 'invalid external link work snapshot' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'external_link_task_authorities' THEN
    IF NOT EXISTS (SELECT 1 FROM scheduled_tasks task WHERE task.id = NEW.task_id
      AND task.account_id = NEW.account_id AND task.workspace_id = NEW.workspace_id
      AND task.authority_revision = NEW.task_revision) THEN
      RAISE EXCEPTION 'external link task revision unavailable' USING ERRCODE = '42501';
    END IF;
    revision_authority := scheduled_task_revision_authority_snapshot(NEW.account_id, NEW.workspace_id, NEW.task_id, NEW.task_revision);
    IF revision_authority IS NULL OR revision_authority ->> 'subjectId' IS DISTINCT FROM l.native_subject_id
      OR revision_authority ->> 'organizationMembershipId' IS DISTINCT FROM l.native_membership_id::text
      OR revision_authority ->> 'membershipAuthorizationRevision' IS DISTINCT FROM l.native_authorization_revision::text THEN
      RAISE EXCEPTION 'external link task owner changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO t FROM session_turns WHERE id = NEW.turn_id AND session_id = NEW.session_id
    AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id;
  SELECT * INTO s FROM sessions WHERE id = NEW.session_id AND account_id = NEW.account_id AND workspace_id = NEW.workspace_id;
  IF t.id IS NULL OR s.id IS NULL OR t.initiating_human_subject_id IS DISTINCT FROM l.native_subject_id
    OR EXISTS (SELECT 1 FROM session_turn_attempts a WHERE a.turn_id = t.id) THEN
    RAISE EXCEPTION 'external link turn admission unavailable' USING ERRCODE = '42501';
  END IF;
  IF NEW.source_kind = 'direct' THEN
    IF t.source NOT IN ('user','api') OR t.status <> 'queued' OR t.active_attempt_id IS NOT NULL
      OR l.status <> 'active' OR l.revision <> NEW.link_revision
      OR (l.expires_at IS NOT NULL AND l.expires_at <= clock_timestamp()) THEN
      RAISE EXCEPTION 'external link direct admission unavailable' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.source_kind IN ('causal','child') THEN
    SELECT a.canonical_snapshot INTO source_snapshot FROM external_link_turn_authorities a
      WHERE a.turn_id = NEW.source_turn_id AND a.account_id = NEW.account_id AND a.workspace_id = NEW.workspace_id;
    IF source_snapshot IS DISTINCT FROM NEW.canonical_snapshot THEN
      RAISE EXCEPTION 'external link source snapshot changed' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_kind = 'child' AND (s.parent_turn_id IS DISTINCT FROM NEW.source_turn_id OR t.status <> 'queued') THEN
      RAISE EXCEPTION 'external link child source unavailable' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_kind = 'child' AND NOT EXISTS (SELECT 1 FROM session_turns source
      WHERE source.id = NEW.source_turn_id AND source.session_id = s.parent_session_id) THEN
      RAISE EXCEPTION 'external link child parent mismatch' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_kind = 'causal' AND (t.source NOT IN ('goal','system') OR t.status <> 'running'
      OR NOT EXISTS (SELECT 1 FROM session_turns source WHERE source.id = NEW.source_turn_id AND source.session_id = t.session_id)) THEN
      RAISE EXCEPTION 'external link causal source unavailable' USING ERRCODE = '42501';
    END IF;
    IF NEW.source_kind = 'causal' AND NOT EXISTS (SELECT 1 FROM session_system_updates u
      WHERE u.account_id = NEW.account_id AND u.workspace_id = NEW.workspace_id AND u.session_id = NEW.session_id
        AND u.delivered_turn_id = NEW.turn_id AND u.state = 'delivered' AND u.delivered_history_item_id IS NOT NULL
        AND ((u.kind = 'goal_continuation' AND u.lineage ->> 'causalTurnId' = NEW.source_turn_id::text)
          OR (u.kind IN ('child_terminal_result','child_requires_action','child_requires_action_resolved','child_paused','child_waiting_capacity','child_progress')
            AND u.lineage ->> 'parentTurnId' = NEW.source_turn_id::text))) THEN
      RAISE EXCEPTION 'external link exact causal delivery unavailable' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT a.canonical_snapshot INTO source_snapshot FROM external_link_task_authorities a
      WHERE a.task_id = NEW.source_task_id AND a.task_revision = NEW.source_task_revision
        AND a.account_id = NEW.account_id AND a.workspace_id = NEW.workspace_id;
    IF source_snapshot IS DISTINCT FROM NEW.canonical_snapshot OR t.source <> 'system' OR t.status <> 'running' THEN
      RAISE EXCEPTION 'external link scheduled source unavailable' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM scheduled_task_runs r WHERE r.id = t.scheduled_task_run_id
      AND r.task_id = NEW.source_task_id AND r.task_authority_revision = NEW.source_task_revision
      AND r.account_id = NEW.account_id AND r.workspace_id = NEW.workspace_id AND r.session_id = NEW.session_id
      AND r.accepted_execution #>> '{causalHuman,subjectId}' = l.native_subject_id) THEN
      RAISE EXCEPTION 'external link scheduled run mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER external_link_turn_snapshot_guard BEFORE INSERT OR UPDATE ON external_link_turn_authorities
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_external_link_work_snapshot();
CREATE TRIGGER external_link_task_snapshot_guard BEFORE INSERT OR UPDATE ON external_link_task_authorities
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_external_link_work_snapshot();
REVOKE ALL ON TABLE external_link_turn_authorities, external_link_task_authorities FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.guard_external_link_work_snapshot() FROM PUBLIC;
DO $drain$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_stat_activity a
    JOIN jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) r ON r = a.usename
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION '0426 requires stopped application sessions' USING ERRCODE = '55000';
  END IF;
END
$drain$;