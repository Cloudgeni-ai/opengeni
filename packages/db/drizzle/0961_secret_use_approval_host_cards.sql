-- deployment-mode: rolling
-- A blocked "ask before each use" secret use now reaches its person through
-- Opengeni itself: the resolver posts the host's own approval card as a
-- human-input request with origin 'secret_use_approval', instead of handing
-- the card to the agent to relay. The card does not hold the turn, so it
-- outlives it: turn-end closure skips it in the inbox, and the person's
-- answer reaches the agent as a 'secret_use_approval_decided' machine input.
-- Every existing row keeps origin 'tool_call'. During rollout an older worker
-- may still cancel a card when its turn ends; the next blocked use of the
-- same request posts it again.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "session_human_input_requests"
  ADD COLUMN "origin" text NOT NULL DEFAULT 'tool_call';

ALTER TABLE "session_human_input_requests"
  ADD CONSTRAINT "session_human_input_requests_origin_check"
  CHECK ("origin" IN ('tool_call', 'secret_use_approval')) NOT VALID;

ALTER TABLE "session_system_updates"
  DROP CONSTRAINT "system_updates_kind_check";

ALTER TABLE "session_system_updates"
  ADD CONSTRAINT "system_updates_kind_check" CHECK (
    "kind" IN (
      'scheduled_occurrence',
      'goal_continuation',
      'agent_message',
      'agent_steer_instruction',
      'session_wait_timeout',
      'background_command_result',
      'child_terminal_result',
      'media_generation_result',
      'child_requires_action',
      'child_requires_action_resolved',
      'child_paused',
      'child_waiting_capacity',
      'child_progress',
      'secret_use_approval_decided'
    )
  ) NOT VALID;

-- A finished turn still closes its own questions and approvals, but not a
-- pending host approval card: it stays answerable after the turn.
DO $inbox$
DECLARE
  definition text;
  anchor text := $old$      -- A finished turn can no longer take an answer or a decision.
      PERFORM opengeni_private.close_inbox_items_v1(
        NEW.session_id, ARRAY['question', 'approval'], NULL, 'resolved');$old$;
  replacement text := $new$      -- A finished turn can no longer take an answer or a decision,
      -- except Opengeni's own secret approval cards, which outlive it.
      UPDATE opengeni_private.inbox_items item
      SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE item.session_id = NEW.session_id
        AND item.kind IN ('question', 'approval')
        AND item.status IN ('open', 'dismissed')
        AND NOT (item.kind = 'question' AND EXISTS (
          SELECT 1 FROM session_human_input_requests request
          WHERE request.session_id = NEW.session_id
            AND request.id::text = item.source_key
            AND request.origin = 'secret_use_approval'
            AND request.status = 'pending'));$new$;
BEGIN
  definition := pg_get_functiondef('opengeni_private.project_inbox_for_session_event_v1()'::regprocedure);
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'inbox turn-end closure anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $inbox$;

-- The person's decision starts a turn like any other immediate input, so the
-- idle command-containment screen counts it (the worker's set pins this).
DO $containment$
DECLARE
  definition text;
  anchor text := $old$'media_generation_result')$old$;
  replacement text := $new$'media_generation_result', 'secret_use_approval_decided')$new$;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.list_command_containment_candidates(integer, bigint)'::regprocedure);
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'command containment update-kind anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $containment$;

RESET statement_timeout;
RESET lock_timeout;
