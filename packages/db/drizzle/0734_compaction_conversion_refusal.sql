-- deployment-mode: rolling
-- Dormant preparation only; existing writers and session modes remain unchanged.
ALTER TABLE sessions ADD COLUMN compaction_conversion_refused_at timestamptz;

CREATE TABLE session_compaction_conversion_chunks (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  snapshot_id text NOT NULL CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  chunk_key text NOT NULL CHECK (chunk_key ~ '^[0-9a-f]{64}$'),
  operation_id uuid NOT NULL,
  target_provider text NOT NULL,
  target_model text NOT NULL,
  target_connection_id uuid NOT NULL,
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, snapshot_id, chunk_key),
  UNIQUE (account_id, operation_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, operation_id) REFERENCES subscription_operation_leases(account_id, operation_id) ON DELETE RESTRICT
);
ALTER TABLE session_compaction_conversion_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_compaction_conversion_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON session_compaction_conversion_chunks
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY session_visibility_isolation ON session_compaction_conversion_chunks AS RESTRICTIVE
  USING (session_reference_visible(account_id, workspace_id, session_id))
  WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

-- No definer and no private-table grants. Direct INSERT has the same physical
-- custody/exact attempt boundary; typed installation independently verifies the
-- complete source/child graph. Entries are append-only, never updated in place.
CREATE FUNCTION guard_compaction_conversion_chunk() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $guard$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('workspace-control:' || NEW.workspace_id::text, 0));
  PERFORM 1 FROM workspace_inference_controls WHERE workspace_id=NEW.workspace_id FOR SHARE;
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND account_id=NEW.account_id FOR KEY SHARE;
  PERFORM 1 FROM sessions WHERE id=NEW.session_id AND workspace_id=NEW.workspace_id FOR NO KEY UPDATE;
  PERFORM 1 FROM session_event_cursors WHERE session_id=NEW.session_id AND workspace_id=NEW.workspace_id FOR UPDATE;
  PERFORM 1 FROM session_turns WHERE id=NEW.turn_id AND workspace_id=NEW.workspace_id FOR UPDATE;
  PERFORM 1 FROM session_turn_attempts WHERE id=NEW.attempt_id AND workspace_id=NEW.workspace_id FOR UPDATE;
  -- Same strict newer-override rule as the ordinary attempt admission fence.
  -- The workspace-control lock above prevents Pause/Resume changing ancestry
  -- control facts while the checkpoint is admitted. Missing ancestry denies.
  IF NOT EXISTS (
    WITH RECURSIVE ancestry AS (
      SELECT s.id, s.parent_session_id, s.direct_control_state, s.direct_pause_revision,
        s.subtree_run_override_revision, 0 AS depth
      FROM sessions s WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.session_id
      UNION ALL
      SELECT p.id, p.parent_session_id, p.direct_control_state, p.direct_pause_revision,
        p.subtree_run_override_revision, c.depth+1
      FROM ancestry c JOIN sessions p ON p.id=c.parent_session_id AND p.workspace_id=NEW.workspace_id
      WHERE c.depth<10000
    )
    SELECT 1 FROM workspace_inference_controls w WHERE w.workspace_id=NEW.workspace_id
      AND EXISTS (SELECT 1 FROM ancestry WHERE parent_session_id IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM ancestry a WHERE a.direct_control_state='paused'
          AND (a.direct_pause_revision IS NULL OR NOT EXISTS (
            SELECT 1 FROM ancestry o WHERE o.depth<a.depth AND o.subtree_run_override_revision>a.direct_pause_revision)))
      AND (w.workspace_state<>'paused' OR (w.workspace_pause_revision IS NOT NULL AND EXISTS (
        SELECT 1 FROM ancestry o WHERE o.subtree_run_override_revision>w.workspace_pause_revision)))
  ) THEN RAISE EXCEPTION 'conversion checkpoint control unavailable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sessions s JOIN session_turns t ON t.id=s.active_turn_id AND t.session_id=s.id
      JOIN session_turn_attempts a ON a.id=t.active_attempt_id AND a.turn_id=t.id
    WHERE s.account_id=NEW.account_id AND s.workspace_id=NEW.workspace_id AND s.id=NEW.session_id
      AND t.id=NEW.turn_id AND t.execution_generation=NEW.generation
      AND t.workspace_id=NEW.workspace_id AND t.account_id=NEW.account_id
      AND a.id=NEW.attempt_id AND a.execution_generation=NEW.generation
      AND a.workspace_id=NEW.workspace_id AND a.account_id=NEW.account_id AND a.session_id=NEW.session_id
      AND t.status IN ('running', 'requires_action') AND a.state IN ('claimed', 'running')
      AND a.authority_epoch=s.authority_epoch AND a.authority_visibility=s.visibility
      AND a.authority_owner_organization_membership_id IS NOT DISTINCT FROM s.owner_organization_membership_id
      AND s.content_archive_state IS NULL AND s.imported_archive_import_id IS NULL
      AND s.codex_compaction_mode='remote_v2' AND s.compaction_conversion_refused_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions i WHERE i.attempt_id=a.id AND i.state IN ('pending','delivered','acknowledged'))
  ) OR NOT EXISTS (
    SELECT 1 FROM subscription_operation_leases r
    WHERE r.account_id=NEW.account_id AND r.workspace_id=NEW.workspace_id AND r.session_id=NEW.session_id
      AND r.turn_id=NEW.turn_id AND r.attempt_id=NEW.attempt_id AND r.generation=NEW.generation
      AND r.operation_id=NEW.operation_id AND r.operation_kind='model'
      AND r.provider=NEW.target_provider AND r.connection_id=NEW.target_connection_id
      AND r.request_outcome='response_received' AND r.request_observed_at IS NOT NULL
      AND r.transport_attempt=1
      AND r.request_id='compaction-conversion:' || NEW.snapshot_id || ':' || NEW.chunk_key
  ) THEN RAISE EXCEPTION 'conversion checkpoint lacks exact settled request/attempt' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $guard$;
REVOKE ALL ON FUNCTION guard_compaction_conversion_chunk() FROM PUBLIC;
CREATE TRIGGER compaction_conversion_chunk_fence BEFORE INSERT ON session_compaction_conversion_chunks
  FOR EACH ROW EXECUTE FUNCTION guard_compaction_conversion_chunk();

DO $grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
    EXECUTE format('GRANT SELECT, INSERT ON %I.session_compaction_conversion_chunks TO opengeni_app', current_schema());
  END IF;
END $grants$;
