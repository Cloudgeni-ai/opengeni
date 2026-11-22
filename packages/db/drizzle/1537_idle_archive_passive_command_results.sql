-- deployment-mode: rolling
-- An idle chat with no input wait cannot start a turn from a command result
-- alone (peekSessionWork / claimSessionWorkForAttempt). The existing wait
-- guard still protects results that can wake a chat. Other kinds can be
-- claimed by a live workflow even when their producer does not send a wake.
-- Keep idle results intact for the archive bundle and any later restore.
-- A manually requested archive still runs its existing stop-work step.
DO $archive_command_results$
DECLARE
  definition text := pg_get_functiondef(
    'opengeni_private.session_archive_candidates(bigint, integer, uuid)'::regprocedure);
  anchor constant text := $anchor$      WHERE U.workspace_id = S.workspace_id AND U.session_id = S.id AND U.state = 'pending')
$anchor$;
  replacement constant text := $replacement$      WHERE U.workspace_id = S.workspace_id AND U.session_id = S.id AND U.state = 'pending'
        AND (U.kind <> 'background_command_result' OR S.archived_at IS NOT NULL))
$replacement$;
BEGIN
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'session_archive_candidates pending update anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$archive_command_results$;
