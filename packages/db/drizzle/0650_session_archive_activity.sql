-- deployment-mode: rolling
-- Idle-session archive: judge activity by turns, not by sessions.updated_at or
-- the newest event. Bulk maintenance touches updated_at on every row, and
-- infrastructure bookkeeping appends events to idle sessions (visibility
-- changes, machine link restored), so either would keep long-idle sessions
-- live for another full idle period after each such operation. Every message,
-- steer, child result or scheduled wake creates or advances a turn; creation
-- time still guards brand-new sessions without turns. Direct children follow
-- the same rule.
CREATE OR REPLACE FUNCTION opengeni_private.session_archive_candidates(
  p_idle_seconds bigint,
  p_limit integer,
  p_session_id uuid DEFAULT NULL
)
RETURNS TABLE (account_id uuid, workspace_id uuid, session_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: data tables live in the caller-selected schema, matching the
-- existing global-reaper convention; opengeni_private is absolute.
AS $$
  WITH params AS (
    SELECT clock_timestamp() - make_interval(secs => greatest(p_idle_seconds, 3600)) AS cutoff
  )
  SELECT S.account_id, S.workspace_id, S.id
  FROM sessions S, params P
  WHERE S.content_archive_state IS NULL
    AND (p_session_id IS NULL OR S.id = p_session_id)
    AND NOT S.keep_live
    AND S.imported_archive_import_id IS NULL
    AND S.status IN ('idle', 'failed', 'cancelled')
    AND S.active_turn_id IS NULL
    AND S.input_wait_until IS NULL
    AND S.created_at < P.cutoff
    AND NOT EXISTS (
      SELECT 1 FROM session_turns T
      WHERE T.workspace_id = S.workspace_id AND T.session_id = S.id
        AND (T.status IN ('queued', 'running', 'requires_action', 'recovering', 'waiting_capacity')
          OR greatest(T.created_at, T.updated_at) >= P.cutoff))
    AND NOT EXISTS (
      SELECT 1 FROM session_human_input_requests H
      WHERE H.workspace_id = S.workspace_id AND H.session_id = S.id AND H.status = 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM session_goals G
      WHERE G.workspace_id = S.workspace_id AND G.session_id = S.id AND G.status = 'active')
    AND NOT EXISTS (
      SELECT 1 FROM session_system_updates U
      WHERE U.workspace_id = S.workspace_id AND U.session_id = S.id AND U.state = 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM session_system_update_outbox O
      WHERE O.workspace_id = S.workspace_id AND O.target_session_id = S.id
        AND O.status = 'pending')
    AND NOT EXISTS (
      SELECT 1 FROM session_background_commands B
      WHERE B.workspace_id = S.workspace_id AND B.session_id = S.id
        AND B.state IN ('running', 'stopping'))
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_tasks K
      WHERE K.workspace_id = S.workspace_id AND K.reusable_session_id = S.id
        AND K.deleted_at IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM site_auth_connections A
      WHERE A.workspace_id = S.workspace_id AND A.maintenance_session_id = S.id)
    AND NOT EXISTS (
      SELECT 1 FROM sessions C
      WHERE C.workspace_id = S.workspace_id AND C.parent_session_id = S.id
        AND C.content_archive_state IS NULL
        AND (C.status NOT IN ('idle', 'failed', 'cancelled')
          OR C.created_at >= P.cutoff
          OR EXISTS (
            SELECT 1 FROM session_turns CT
            WHERE CT.workspace_id = C.workspace_id AND CT.session_id = C.id
              AND greatest(CT.created_at, CT.updated_at) >= P.cutoff)))
  ORDER BY S.created_at, S.id
  LIMIT least(greatest(p_limit, 0), 100);
$$;
