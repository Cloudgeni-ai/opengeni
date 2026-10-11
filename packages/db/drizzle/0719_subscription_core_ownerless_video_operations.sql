-- deployment-mode: rolling
-- A video in an ownerless session reconciles on shared subscription capacity.
--
-- A subscription-funded video job outlives its turn: after the provider's
-- cutover, its submission and polling run under a session-bound `video`
-- operation lease on the canonical connection the turn admitted it on. An
-- owned session carries its owner's context; an ownerless session (a
-- scheduled task that opens a new session per run) has none, and the lease
-- guard admitted only its realtime operation, so such a video could never
-- be submitted. The ownerless rule is otherwise unchanged: no person stands
-- behind the lease, and the connection must be an organization- or
-- workspace-scoped shared connection.
DO $ownerless_video_operations$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.guard_subscription_operation_lease_reference()'::regprocedure);
  anchor := $old$IF NEW.operation_kind <> 'realtime'
            OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NOT NULL$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'Ownerless subscription operation guard source changed';
  END IF;
  EXECUTE replace(definition, anchor,
    $new$IF NEW.operation_kind NOT IN ('realtime', 'video')
            OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NOT NULL$new$);
END
$ownerless_video_operations$;
