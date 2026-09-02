-- deployment-mode: rolling
-- Project exact-attempt automatic compaction starts into one content-free,
-- restart-safe aggregate. Prometheus labels must never carry tenant/session ids,
-- while process-local start/completion timestamps cannot correlate concurrent
-- activities or survive the worker whose provider call became stuck.

CREATE TABLE opengeni_private.context_compaction_pending_observations (
  workspace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  started_at timestamp with time zone NOT NULL,
  PRIMARY KEY (workspace_id, attempt_id),
  CONSTRAINT context_compaction_pending_observations_attempt_fk
    FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES session_turn_attempts (workspace_id, id)
    ON DELETE CASCADE
);

REVOKE ALL ON TABLE opengeni_private.context_compaction_pending_observations FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.project_context_compaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $project_context_compaction_event$
BEGIN
  IF NEW.turn_attempt_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.type = 'session.context.compaction.started'
    AND NEW.payload ->> 'trigger' = 'auto'
  THEN
    INSERT INTO opengeni_private.context_compaction_pending_observations (
      workspace_id,
      attempt_id,
      started_at
    ) VALUES (
      NEW.workspace_id,
      NEW.turn_attempt_id,
      NEW.occurred_at
    )
    ON CONFLICT (workspace_id, attempt_id) DO UPDATE
      SET started_at = EXCLUDED.started_at;
  ELSIF NEW.type IN (
    'session.context.compacted',
    'session.context.compaction.skipped'
  ) THEN
    DELETE FROM opengeni_private.context_compaction_pending_observations pending
    WHERE pending.workspace_id = NEW.workspace_id
      AND pending.attempt_id = NEW.turn_attempt_id;
  END IF;

  RETURN NEW;
END
$project_context_compaction_event$;

REVOKE ALL ON FUNCTION opengeni_private.project_context_compaction_event() FROM PUBLIC;

CREATE TRIGGER session_events_project_context_compaction_pending
AFTER INSERT ON session_events
FOR EACH ROW
WHEN (
  NEW.type IN (
    'session.context.compaction.started',
    'session.context.compacted',
    'session.context.compaction.skipped'
  )
)
EXECUTE FUNCTION opengeni_private.project_context_compaction_event();

CREATE OR REPLACE FUNCTION opengeni_private.clear_context_compaction_pending_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $clear_context_compaction_pending_attempt$
BEGIN
  IF OLD.state <> 'closed' AND NEW.state = 'closed' THEN
    DELETE FROM opengeni_private.context_compaction_pending_observations pending
    WHERE pending.workspace_id = NEW.workspace_id
      AND pending.attempt_id = NEW.id;
  END IF;
  RETURN NEW;
END
$clear_context_compaction_pending_attempt$;

REVOKE ALL ON FUNCTION opengeni_private.clear_context_compaction_pending_attempt() FROM PUBLIC;

CREATE TRIGGER session_turn_attempts_clear_context_compaction_pending
AFTER UPDATE OF state ON session_turn_attempts
FOR EACH ROW
WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION opengeni_private.clear_context_compaction_pending_attempt();

CREATE OR REPLACE FUNCTION opengeni_private.clear_context_compaction_pending_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $clear_context_compaction_pending_turn$
BEGIN
  IF OLD.active_attempt_id IS NOT NULL
    AND OLD.active_attempt_id IS DISTINCT FROM NEW.active_attempt_id
  THEN
    DELETE FROM opengeni_private.context_compaction_pending_observations pending
    WHERE pending.workspace_id = NEW.workspace_id
      AND pending.attempt_id = OLD.active_attempt_id;
  END IF;
  RETURN NEW;
END
$clear_context_compaction_pending_turn$;

REVOKE ALL ON FUNCTION opengeni_private.clear_context_compaction_pending_turn() FROM PUBLIC;

CREATE TRIGGER session_turns_clear_context_compaction_pending
AFTER UPDATE OF active_attempt_id ON session_turns
FOR EACH ROW
WHEN (OLD.active_attempt_id IS DISTINCT FROM NEW.active_attempt_id)
EXECUTE FUNCTION opengeni_private.clear_context_compaction_pending_turn();

-- The migration owner is bound by FORCE RLS in production. Open the standard
-- owner-only posture window while reconstructing any automatic provider call
-- already in flight when this rolling migration lands.
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;

WITH latest_landmark AS (
  SELECT DISTINCT ON (event.workspace_id, event.turn_attempt_id)
    event.workspace_id,
    event.turn_attempt_id,
    event.type,
    event.payload,
    event.occurred_at
  FROM session_events event
  WHERE event.turn_attempt_id IS NOT NULL
    AND event.type IN (
      'session.context.compaction.started',
      'session.context.compacted',
      'session.context.compaction.skipped'
    )
  ORDER BY
    event.workspace_id,
    event.turn_attempt_id,
    event.sequence DESC,
    event.id DESC
)
INSERT INTO opengeni_private.context_compaction_pending_observations (
  workspace_id,
  attempt_id,
  started_at
)
SELECT
  landmark.workspace_id,
  landmark.turn_attempt_id,
  landmark.occurred_at
FROM latest_landmark landmark
JOIN session_turn_attempts attempt
  ON attempt.workspace_id = landmark.workspace_id
 AND attempt.id = landmark.turn_attempt_id
JOIN session_turns turn
  ON turn.workspace_id = attempt.workspace_id
 AND turn.id = attempt.turn_id
 AND turn.active_attempt_id = attempt.id
WHERE landmark.type = 'session.context.compaction.started'
  AND landmark.payload ->> 'trigger' = 'auto'
  AND attempt.state IN ('claimed', 'running')
ON CONFLICT (workspace_id, attempt_id) DO UPDATE
  SET started_at = EXCLUDED.started_at;

ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION opengeni_private.context_compaction_pending_summary()
RETURNS TABLE (pending_count bigint, oldest_started_at timestamp with time zone)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $context_compaction_pending_summary$
  SELECT
    count(*)::bigint AS pending_count,
    min(pending.started_at) AS oldest_started_at
  FROM opengeni_private.context_compaction_pending_observations pending
$context_compaction_pending_summary$;

REVOKE ALL ON FUNCTION opengeni_private.context_compaction_pending_summary() FROM PUBLIC;

DO $context_compaction_observability_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.context_compaction_pending_summary()
      TO opengeni_app;
  END IF;
END
$context_compaction_observability_grants$;