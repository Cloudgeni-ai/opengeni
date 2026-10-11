-- deployment-mode: rolling
-- A stateless chat completion is a sessionless Codex operation, like
-- transcription: it runs for an explicit subject in a workspace context on a
-- shared organization- or workspace-scoped connection, under its own
-- operation lease and request reservations. Older binaries never write the
-- new label, so widening the accepted labels is safe while they still run.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $completion_operations$
DECLARE definition text; anchor text;
BEGIN
  ALTER TABLE subscription_operation_leases DROP CONSTRAINT subscription_operation_leases_kind_chk;
  ALTER TABLE subscription_operation_leases ADD CONSTRAINT subscription_operation_leases_kind_chk
    CHECK (operation_kind IN ('image', 'realtime', 'transcription', 'model', 'credential_request', 'apps', 'completion')
      AND (operation_kind IN ('image', 'realtime', 'transcription') OR provider = 'codex'));
  ALTER TABLE subscription_operation_leases DROP CONSTRAINT subscription_operation_leases_reference_chk;
  ALTER TABLE subscription_operation_leases ADD CONSTRAINT subscription_operation_leases_reference_chk
    CHECK ((turn_id IS NULL OR session_id IS NOT NULL)
      AND (session_id IS NOT NULL OR (turn_id IS NULL AND operation_kind IN ('transcription', 'credential_request', 'apps', 'completion')))
      AND (operation_kind <> 'model' OR turn_id IS NOT NULL));
  -- Retain the authorization guard exactly, widening only its sessionless
  -- labels. A completion carries the same explicit subject and initiating
  -- human context as transcription.
  definition := pg_get_functiondef('opengeni_private.guard_subscription_operation_lease_reference()'::regprocedure);
  anchor := $old$IF NEW.operation_kind NOT IN ('transcription', 'credential_request', 'apps')$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'operation authority source changed';
  END IF;
  EXECUTE replace(definition, anchor,
    $new$IF NEW.operation_kind NOT IN ('transcription', 'credential_request', 'apps', 'completion')$new$);
END
$completion_operations$;
