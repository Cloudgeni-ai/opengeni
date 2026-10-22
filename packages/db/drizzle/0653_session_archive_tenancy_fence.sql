-- deployment-mode: rolling
-- The archive purge and abandon routines mutate session-tenancy hot tables
-- (sessions, session_system_updates, session_pending_tool_calls). Like every
-- other definer mutator of those tables, take the workspace's session-tenancy
-- fence before the first row lock, so they serialize with visibility and
-- tenancy transitions. Bodies are otherwise unchanged from 0649.
CREATE OR REPLACE FUNCTION opengeni_private.purge_archived_session_content(
  p_workspace_id uuid,
  p_session_id uuid,
  p_table text,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  archive_state text;
  archive_locator jsonb;
  batch integer := least(greatest(p_limit, 1), 10000);
  deleted integer := 0;
BEGIN
  PERFORM acquire_session_tenancy_fence(p_workspace_id);
  SELECT content_archive_state, content_archive INTO archive_state, archive_locator
  FROM sessions WHERE workspace_id = p_workspace_id AND id = p_session_id
  FOR NO KEY UPDATE;
  IF archive_state IS DISTINCT FROM 'archived'
    OR archive_locator IS NULL OR archive_locator->>'sha256' IS NULL THEN
    RAISE EXCEPTION 'session content is not archived' USING ERRCODE = '55000';
  END IF;
  CASE p_table
  WHEN 'session_realtime_entries' THEN
    DELETE FROM session_realtime_entries WHERE ctid IN (
      SELECT ctid FROM session_realtime_entries
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_system_updates' THEN
    DELETE FROM session_system_updates WHERE ctid IN (
      SELECT ctid FROM session_system_updates
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_history_items' THEN
    DELETE FROM session_history_items WHERE ctid IN (
      SELECT ctid FROM session_history_items
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_attempt_codemode_calls' THEN
    DELETE FROM session_attempt_codemode_calls WHERE ctid IN (
      SELECT ctid FROM session_attempt_codemode_calls
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_attempt_tool_catalogs' THEN
    DELETE FROM session_attempt_tool_catalogs WHERE ctid IN (
      SELECT ctid FROM session_attempt_tool_catalogs
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_attempt_model_context_snapshots' THEN
    DELETE FROM session_attempt_model_context_snapshots WHERE ctid IN (
      SELECT ctid FROM session_attempt_model_context_snapshots
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_content_blobs' THEN
    DELETE FROM session_content_blobs WHERE ctid IN (
      SELECT ctid FROM session_content_blobs
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_pending_tool_calls' THEN
    DELETE FROM session_pending_tool_calls WHERE ctid IN (
      SELECT ctid FROM session_pending_tool_calls
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id LIMIT batch);
  WHEN 'session_events' THEN
    -- Only originals and duplicates of retained types reference each other
    -- (duplicates are agent.model.usage, which stays), so order is irrelevant.
    DELETE FROM session_events WHERE ctid IN (
      SELECT ctid FROM session_events
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND type IN (SELECT opengeni_private.archived_session_event_types())
      LIMIT batch);
  ELSE
    RAISE EXCEPTION 'unsupported archived session table' USING ERRCODE = '22023';
  END CASE;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.abandon_session_content_archive(
  p_workspace_id uuid,
  p_session_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  target record;
  planned_key text;
BEGIN
  PERFORM acquire_session_tenancy_fence(p_workspace_id);
  SELECT account_id, content_archive_state, content_archive INTO target
  FROM sessions WHERE workspace_id = p_workspace_id AND id = p_session_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR target.content_archive_state IS DISTINCT FROM 'archiving' THEN
    RETURN false;
  END IF;
  FOR planned_key IN
    SELECT value FROM jsonb_array_elements_text(
      coalesce(target.content_archive->'objectKeys', '[]'::jsonb))
  LOOP
    INSERT INTO opengeni_private.session_archive_object_deletions
      (object_key, account_id, workspace_id, session_id)
    VALUES (planned_key, target.account_id, p_workspace_id, p_session_id)
    ON CONFLICT (object_key) DO NOTHING;
  END LOOP;
  UPDATE sessions
  SET content_archive_state = NULL, content_archive_started_at = NULL, content_archive = NULL
  WHERE workspace_id = p_workspace_id AND id = p_session_id;
  RETURN true;
END;
$$;
