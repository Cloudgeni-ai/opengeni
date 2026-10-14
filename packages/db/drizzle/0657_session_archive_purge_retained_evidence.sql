-- deployment-mode: rolling
-- The archive purge must leave rows that other invariants keep:
-- scheduled-occurrence evidence in session_system_updates is immutable (0275),
-- and history items those retained updates delivered are protected by
-- session_system_updates_history_item_fk. Pending tool calls that still hold
-- their exact event output need the v1-aware settlement flag to be deleted;
-- the archive bundle already preserved that output. Retained rows are small
-- audit facts and stay with the session row, like its turns.
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
    -- Scheduled-occurrence evidence is immutable; it stays.
    DELETE FROM session_system_updates WHERE ctid IN (
      SELECT ctid FROM session_system_updates
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND scheduled_task_run_id IS NULL
      LIMIT batch);
  WHEN 'session_history_items' THEN
    -- Items a retained update delivered stay (session_system_updates_history_item_fk).
    DELETE FROM session_history_items WHERE ctid IN (
      SELECT H.ctid FROM session_history_items H
      WHERE H.workspace_id = p_workspace_id AND H.session_id = p_session_id
        AND NOT EXISTS (
          SELECT 1 FROM session_system_updates U
          WHERE U.workspace_id = p_workspace_id AND U.delivered_history_item_id = H.id)
      LIMIT batch);
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
    -- The bundle already preserved any exact event output these rows held.
    PERFORM set_config('opengeni.pending_tool_event_output_v1', '1', true);
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
