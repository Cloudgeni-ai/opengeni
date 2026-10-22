-- deployment-mode: rolling
-- A person's turn in an ownerless session places on shared Codex capacity.
--
-- An ownerless session is shared-only. A scheduled task that opens a new
-- session per run creates such a session, but its turn still records the
-- person it runs for. Ownerless access and the lease guards required that turn
-- to have no person, so placement saw the turn as not visible and the turn
-- could never start. The access grant itself is unchanged: it records no owner
-- and no person, so it carries no personal authority, and the caller must
-- still act without a person.
DO $ownerless_person_turns$
DECLARE definition text; anchor text; guard regprocedure;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.authorize_subscription_ownerless_session_access(uuid, uuid, uuid, uuid)'::regprocedure);
  anchor := $old$AND turn.id = p_turn_id AND turn.initiating_human_subject_id IS NULL$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'Ownerless subscription access source changed';
  END IF;
  EXECUTE replace(definition, anchor, $new$AND turn.id = p_turn_id$new$);

  anchor := $old$IF turn_human IS NOT NULL OR NOT opengeni_private.authorize_subscription_ownerless_session_access($old$;
  FOREACH guard IN ARRAY ARRAY[
    'opengeni_private.guard_subscription_connection_reference()'::regprocedure,
    'opengeni_private.guard_subscription_operation_lease_reference()'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(guard);
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'Ownerless subscription guard source changed: %', guard;
    END IF;
    EXECUTE replace(definition, anchor,
      $new$IF NOT opengeni_private.authorize_subscription_ownerless_session_access($new$);
  END LOOP;
END
$ownerless_person_turns$;
