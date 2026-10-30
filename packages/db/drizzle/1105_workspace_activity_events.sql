-- deployment-mode: rolling
-- Opengeni's own events become automation triggers through the "This
-- workspace" event source (docs/design/opengeni-events-as-triggers.md).
--
-- - workspace_activity_events: one small row per fact a trigger can listen
--   for: a chat finished, failed, was stopped, waits for an approval, asked a
--   question or sent a notification, and usage thresholds. Rows are kept 24
--   hours; the "This workspace" feed reads them as the source's owner, so row
--   security decides who sees what: chat facts follow the chat's visibility,
--   a member's usage fact reaches only that member, workspace usage reaches
--   administrators.
-- - An AFTER INSERT trigger on session_events writes chat facts in the same
--   transaction. It fires only for the six offered types (its WHEN clause),
--   writes only for workspaces where someone has a "This workspace" source,
--   and a failure is a warning that never aborts the insert.
-- - An AFTER INSERT trigger on the usage allowance notices writes usage facts
--   where the usage webhooks are produced.
-- - Chain depth: inbound_events.chain_depth (0 unless an automation run
--   caused the event) and scheduled_task_runs.chain_depth (1 for scheduled
--   and manual runs; an event run is one more than the deepest event it
--   carries, filled by a BEFORE INSERT trigger). The dispatcher leaves out
--   events that would start a run deeper than the limit and records a
--   skipped run with reason chain_limit, which the refusal guard now allows.
-- - Event intake retention also removes facts older than 24 hours.
--
-- The previous release never reads the new table or columns; both new
-- columns have constant defaults, so its inserts keep working. All new
-- routines are SECURITY INVOKER; the two changed definers keep their
-- signatures and grants.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE inbound_events ADD COLUMN chain_depth smallint NOT NULL DEFAULT 0;
ALTER TABLE scheduled_task_runs ADD COLUMN chain_depth smallint NOT NULL DEFAULT 1;

CREATE TABLE workspace_activity_events (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  account_id uuid NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  session_id uuid,
  turn_id uuid,
  subject_id text,
  automation_id uuid,
  automation_run_id uuid,
  chain_depth smallint NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT workspace_activity_events_pkey PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_activity_events_workspace_fkey FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT workspace_activity_events_values_chk CHECK (
    octet_length(type) BETWEEN 1 AND 128
    AND (subject_id IS NULL OR octet_length(subject_id) BETWEEN 1 AND 1024)
    AND chain_depth >= 0
    AND jsonb_typeof(data) = 'object'
    AND octet_length(data::text) <= 8192
  )
);
CREATE INDEX workspace_activity_events_feed_idx
  ON workspace_activity_events (workspace_id, created_at, id);
CREATE INDEX workspace_activity_events_created_idx
  ON workspace_activity_events (created_at);

ALTER TABLE workspace_activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_activity_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE workspace_activity_events FROM PUBLIC;
-- Chat facts: whoever may see the chat. Usage facts: the member they are
-- about, or for workspace-wide usage, the workspace's administrators.
CREATE POLICY workspace_activity_read ON workspace_activity_events
  FOR SELECT
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      (session_id IS NOT NULL AND session_reference_visible(account_id, workspace_id, session_id))
      OR (session_id IS NULL AND (
        subject_id = opengeni_private.current_subject_id()
        OR (subject_id IS NULL AND EXISTS (
          SELECT 1 FROM workspace_memberships member
          WHERE member.account_id = workspace_activity_events.account_id
            AND member.workspace_id = workspace_activity_events.workspace_id
            AND member.subject_id = opengeni_private.current_subject_id()
            AND opengeni_private.workspace_membership_administers(member.role, member.permissions)))
      ))
    )
  );
CREATE POLICY workspace_activity_insert ON workspace_activity_events
  FOR INSERT
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- Usage facts are written by the usage maintenance definer and retention by
-- the intake prune definer, both as the table owner.
CREATE POLICY workspace_activity_maintenance_owner ON workspace_activity_events
  USING (CURRENT_USER = (SELECT pg_get_userbyid(relation.relowner) FROM pg_class relation
    WHERE relation.oid = 'workspace_activity_events'::regclass))
  WITH CHECK (CURRENT_USER = (SELECT pg_get_userbyid(relation.relowner) FROM pg_class relation
    WHERE relation.oid = 'workspace_activity_events'::regclass));

DO $workspace_activity_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON workspace_activity_events TO opengeni_app;
  END IF;
END
$workspace_activity_grants$;

-- One chat fact. The automation run that caused it is the turn's own run, or
-- for a chat an agent started inside another chat's turn, the run of the
-- nearest such turn up the chain (at most 8 chats up). A fact without a turn
-- is a notice Opengeni posted itself.
CREATE FUNCTION opengeni_private.record_session_activity_event_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_payload jsonb := NEW.payload;
  v_turn uuid := NEW.turn_id;
  v_session uuid := NEW.session_id;
  v_run uuid;
  v_metadata_run text;
  v_initiator_kind text;
  v_subject text;
  v_task uuid;
  v_depth smallint := 0;
  v_hops integer := 0;
  v_data jsonb;
BEGIN
  IF NEW.type = 'turn.completed' AND v_payload ? 'maintenance' THEN RETURN NULL; END IF;
  BEGIN
    -- Nobody in this workspace can listen yet: nothing to keep.
    IF NOT EXISTS (SELECT 1 FROM event_sources source
      WHERE source.workspace_id = NEW.workspace_id AND source.kind = 'workspace'
        AND source.status = 'active') THEN
      RETURN NULL;
    END IF;
    IF v_turn IS NOT NULL THEN
      SELECT turn.scheduled_task_run_id, turn.initiator_kind,
          coalesce(turn.initiating_human_subject_id,
            CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END)
        INTO v_run, v_initiator_kind, v_subject
        FROM session_turns turn
        WHERE turn.id = v_turn AND turn.workspace_id = NEW.workspace_id;
      WHILE v_run IS NULL AND v_session IS NOT NULL AND v_hops < 8 LOOP
        SELECT chat.parent_turn_id, chat.metadata ->> 'scheduledTaskRunId'
          INTO v_turn, v_metadata_run
          FROM sessions chat
          WHERE chat.id = v_session AND chat.workspace_id = NEW.workspace_id;
        -- A later turn Opengeni started in an automation's own chat (not a
        -- person's message) belongs to that automation.
        IF v_hops = 0 AND v_initiator_kind IS DISTINCT FROM 'subject'
          AND v_metadata_run ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          v_run := v_metadata_run::uuid;
          EXIT;
        END IF;
        EXIT WHEN v_turn IS NULL;
        SELECT turn.scheduled_task_run_id, turn.session_id INTO v_run, v_session
          FROM session_turns turn
          WHERE turn.id = v_turn AND turn.workspace_id = NEW.workspace_id;
        v_hops := v_hops + 1;
      END LOOP;
      IF v_run IS NOT NULL THEN
        SELECT run.task_id, run.chain_depth INTO v_task, v_depth
          FROM scheduled_task_runs run
          WHERE run.id = v_run AND run.workspace_id = NEW.workspace_id;
        IF v_task IS NULL THEN v_run := NULL; v_depth := 0; END IF;
      END IF;
    ELSE
      SELECT chat.owner_subject_id INTO v_subject FROM sessions chat
        WHERE chat.id = NEW.session_id AND chat.workspace_id = NEW.workspace_id;
    END IF;
    v_data := CASE NEW.type
      WHEN 'turn.completed' THEN jsonb_build_object('answerExcerpt', left(coalesce(
        CASE WHEN jsonb_typeof(v_payload -> 'output') = 'string'
          THEN nullif(btrim(v_payload ->> 'output'), '') END,
        CASE WHEN jsonb_typeof(v_payload -> 'reply') = 'string'
          THEN nullif(btrim(v_payload ->> 'reply'), '') END, ''), 1000))
      WHEN 'turn.failed' THEN jsonb_build_object('error', jsonb_strip_nulls(jsonb_build_object(
        'code', CASE WHEN jsonb_typeof(v_payload -> 'code') = 'string'
          THEN left(v_payload ->> 'code', 100) END,
        'message', CASE WHEN jsonb_typeof(v_payload -> 'error') = 'string'
          THEN left(v_payload ->> 'error', 300)
          WHEN jsonb_typeof(v_payload #> '{error,message}') = 'string'
          THEN left(v_payload #>> '{error,message}', 300) END)))
      WHEN 'turn.cancelled' THEN jsonb_strip_nulls(jsonb_build_object(
        'reason', CASE WHEN jsonb_typeof(v_payload -> 'reason') = 'string'
          THEN left(v_payload ->> 'reason', 300) END))
      WHEN 'session.requiresAction' THEN jsonb_build_object('tools', coalesce((
        SELECT jsonb_agg(name ORDER BY position) FROM (
          SELECT left(coalesce(nullif(btrim(approval #>> '{display,toolName}'), ''),
              nullif(btrim(approval ->> 'name'), ''), nullif(btrim(approval ->> 'toolName'), ''),
              nullif(btrim(approval #>> '{rawItem,name}'), '')), 200) AS name, position
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_payload -> 'approvals') = 'array'
            THEN v_payload -> 'approvals' ELSE '[]'::jsonb END)
            WITH ORDINALITY AS approvals(approval, position)
          WHERE position <= 10) named WHERE name IS NOT NULL), '[]'::jsonb))
      WHEN 'session.humanInput.requested' THEN jsonb_build_object('questions', coalesce((
        SELECT jsonb_agg(left(question ->> 'prompt', 300) ORDER BY position)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_payload #> '{request,questions}') = 'array'
          THEN v_payload #> '{request,questions}' ELSE '[]'::jsonb END)
          WITH ORDINALITY AS questions(question, position)
        WHERE position <= 5 AND jsonb_typeof(question -> 'prompt') = 'string'), '[]'::jsonb))
      WHEN 'session.notification.posted' THEN jsonb_strip_nulls(jsonb_build_object(
        'title', CASE WHEN jsonb_typeof(v_payload -> 'title') = 'string'
          THEN left(v_payload ->> 'title', 200) END,
        'bodyExcerpt', CASE WHEN jsonb_typeof(v_payload -> 'body') = 'string'
          THEN left(v_payload ->> 'body', 1000) END,
        'recipientSubjectId', CASE WHEN jsonb_typeof(v_payload -> 'recipientSubjectId') = 'string'
          THEN left(v_payload ->> 'recipientSubjectId', 300) END))
      ELSE '{}'::jsonb END;
    INSERT INTO workspace_activity_events (workspace_id, id, account_id, type, occurred_at,
        session_id, turn_id, subject_id, automation_id, automation_run_id, chain_depth, data)
      VALUES (NEW.workspace_id, NEW.id, NEW.account_id, NEW.type, NEW.occurred_at,
        NEW.session_id, NEW.turn_id, nullif(left(v_subject, 1024), ''), v_task, v_run,
        coalesce(v_depth, 0), v_data)
      ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'workspace activity fact skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER session_events_workspace_activity_v1 AFTER INSERT ON session_events
  FOR EACH ROW
  WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type = ANY (ARRAY[
    'turn.completed', 'turn.failed', 'turn.cancelled', 'session.requiresAction',
    'session.humanInput.requested', 'session.notification.posted']))
  EXECUTE FUNCTION opengeni_private.record_session_activity_event_v1();

-- One usage fact per allowance notice. Reaching the limit is both
-- usage.exhausted and usage.threshold_reached, as for workspace webhooks.
CREATE FUNCTION opengeni_private.record_usage_activity_event_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_type text := CASE WHEN NEW.threshold = -1 THEN 'usage.period_reset'
    WHEN NEW.threshold = 1 THEN 'usage.exhausted' ELSE 'usage.threshold_reached' END;
  v_data jsonb;
BEGIN
  BEGIN
    v_data := jsonb_strip_nulls(jsonb_build_object(
      'scope', CASE WHEN NEW.subject_id = '' THEN 'workspace' ELSE 'member' END,
      'threshold', CASE WHEN NEW.threshold >= 0 THEN NEW.threshold END,
      'usedCredits', CASE WHEN jsonb_typeof(NEW.payload -> 'used') = 'number' THEN NEW.payload -> 'used' END,
      'limitCredits', CASE WHEN jsonb_typeof(NEW.payload -> 'limit') = 'number' THEN NEW.payload -> 'limit' END,
      'period', left(NEW.period_key, 64),
      'periodEnd', CASE WHEN jsonb_typeof(NEW.payload -> 'resetsAt') = 'string'
        THEN left(NEW.payload ->> 'resetsAt', 64) END));
    INSERT INTO workspace_activity_events (workspace_id, id, account_id, type, occurred_at,
        subject_id, data)
      VALUES (NEW.workspace_id, NEW.id, NEW.account_id, v_type, NEW.created_at,
        nullif(NEW.subject_id, ''), v_data)
      ON CONFLICT DO NOTHING;
    IF NEW.threshold = 1 THEN
      INSERT INTO workspace_activity_events (workspace_id, id, account_id, type, occurred_at,
          subject_id, data)
        VALUES (NEW.workspace_id, md5(NEW.id::text || ':usage.threshold_reached')::uuid,
          NEW.account_id, 'usage.threshold_reached', NEW.created_at, nullif(NEW.subject_id, ''), v_data)
        ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'workspace activity usage fact skipped for notice %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER workspace_allowance_notifications_activity_v1
  AFTER INSERT ON opengeni_private.workspace_allowance_notifications
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.record_usage_activity_event_v1();

-- An event run is one level deeper than the deepest event it carries.
CREATE FUNCTION opengeni_private.fill_event_run_chain_depth_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_depth integer;
BEGIN
  IF NEW.producer_key !~ '^scheduled-task-event:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT max(event.chain_depth) INTO v_depth
      FROM scheduled_task_event_occurrences occurrence
      JOIN inbound_events event ON event.id = ANY (occurrence.event_ids)
      WHERE occurrence.id = substr(NEW.producer_key, 22)::uuid
        AND occurrence.workspace_id = NEW.workspace_id;
    NEW.chain_depth := least(32767, 1 + coalesce(v_depth, 0));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'event run chain depth not filled for %: %', NEW.producer_key, SQLSTATE;
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER scheduled_task_runs_chain_depth_v1 BEFORE INSERT ON scheduled_task_runs
  FOR EACH ROW WHEN (NEW.trigger_type = 'event' AND NEW.producer_key IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.fill_event_run_chain_depth_v1();

DO $search_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.record_session_activity_event_v1() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.record_usage_activity_event_v1() SET search_path = pg_catalog, %I, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION opengeni_private.fill_event_run_chain_depth_v1() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$search_paths$;
REVOKE ALL ON FUNCTION opengeni_private.record_session_activity_event_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.record_usage_activity_event_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.fill_event_run_chain_depth_v1() FROM PUBLIC;

-- Unchanged from the 0977 baseline apart from the chain_limit reason.
CREATE OR REPLACE FUNCTION opengeni_private.guard_scheduled_admission_refusal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE task_row scheduled_tasks%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.admission_refusal IS DISTINCT FROM OLD.admission_refusal
      OR (OLD.admission_refusal IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
    THEN RAISE EXCEPTION 'scheduled admission refusal is immutable' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.admission_refusal IS NULL THEN RETURN NEW; END IF;
  IF NEW.action_kind IS DISTINCT FROM 'agent_turn'
    OR NEW.admission_diagnostic IS NOT NULL
    OR jsonb_typeof(NEW.admission_refusal) IS DISTINCT FROM 'object'
    OR NEW.admission_refusal - ARRAY['version','reason','retryable'] <> '{}'::jsonb
    OR NEW.admission_refusal -> 'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(NEW.admission_refusal -> 'retryable') IS DISTINCT FROM 'boolean'
    OR coalesce(NEW.admission_refusal ->> 'reason', '') NOT IN (
      'scheduled_authority_unavailable',
      'machine_target_unavailable', 'machine_enrollment_inactive',
      'variable_set_unavailable', 'rig_version_unavailable',
      'insufficient_credits', 'monthly_model_cost_limit', 'monthly_agent_run_limit', 'allowance_exhausted', 'scheduled_model_unavailable', 'session_usage_limit',
      'chain_limit')
    OR NEW.error IS DISTINCT FROM NEW.admission_refusal ->> 'reason'
    OR NEW.status IS DISTINCT FROM (CASE WHEN (NEW.admission_refusal ->> 'retryable')::boolean
      THEN 'skipped' ELSE 'failed' END)
    OR NEW.completed_at IS NULL OR nullif(btrim(NEW.producer_key),'') IS NULL
    OR NEW.session_id IS NOT NULL OR NEW.trigger_event_id IS NOT NULL
    OR NEW.accepted_execution_snapshot IS NOT NULL OR NEW.accepted_execution_digest IS NOT NULL
    OR NEW.knowledge_sync_run_id IS NOT NULL OR NEW.knowledge_summary IS NOT NULL
  THEN RAISE EXCEPTION 'invalid scheduled admission refusal' USING ERRCODE = '22023'; END IF;
  SELECT task.* INTO STRICT task_row FROM scheduled_tasks task
    WHERE task.id = NEW.task_id AND task.workspace_id = NEW.workspace_id
      AND task.account_id = NEW.account_id FOR UPDATE;
  IF task_row.status <> 'active' OR task_row.deleted_at IS NOT NULL
    OR task_row.action ->> 'kind' IS DISTINCT FROM 'agent_turn'
    OR NEW.task_authority_revision IS DISTINCT FROM task_row.authority_revision
    OR NEW.task_execution_digest IS DISTINCT FROM task_row.execution_digest
  THEN RAISE EXCEPTION 'scheduled task changed before refusal recording' USING ERRCODE = '40001'; END IF;
  RETURN NEW;
END $$;

-- Unchanged from the 0977 baseline apart from removing facts after 24 hours.
CREATE OR REPLACE FUNCTION opengeni_private.prune_event_intake_v1(p_body_seconds integer, p_event_seconds integer, p_limit integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  bounded_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  body_cutoff timestamptz := pg_catalog.now() - pg_catalog.make_interval(
    secs => greatest(3600, coalesce(p_body_seconds, 604800)));
  event_cutoff timestamptz := pg_catalog.now() - pg_catalog.make_interval(
    secs => greatest(86400, coalesce(p_event_seconds, 2592000)));
  fact_cutoff timestamptz := pg_catalog.now() - interval '24 hours';
  stripped integer;
  removed_events integer;
  removed_deliveries integer;
  removed_facts integer;
BEGIN
  WITH doomed AS (
    SELECT delivery.id FROM event_deliveries delivery
    WHERE delivery.body IS NOT NULL AND delivery.received_at < body_cutoff
    ORDER BY delivery.received_at LIMIT bounded_limit
  )
  UPDATE event_deliveries delivery SET body = NULL
  FROM doomed WHERE delivery.id = doomed.id;
  GET DIAGNOSTICS stripped = ROW_COUNT;
  WITH doomed AS (
    SELECT event.id FROM inbound_events event
    WHERE event.received_at < event_cutoff
    ORDER BY event.received_at LIMIT bounded_limit
  )
  DELETE FROM inbound_events event USING doomed WHERE event.id = doomed.id;
  GET DIAGNOSTICS removed_events = ROW_COUNT;
  WITH doomed AS (
    SELECT delivery.id FROM event_deliveries delivery
    WHERE delivery.received_at < event_cutoff
    ORDER BY delivery.received_at LIMIT bounded_limit
  )
  DELETE FROM event_deliveries delivery USING doomed WHERE delivery.id = doomed.id;
  GET DIAGNOSTICS removed_deliveries = ROW_COUNT;
  WITH doomed AS (
    SELECT fact.workspace_id, fact.id FROM workspace_activity_events fact
    WHERE fact.created_at < fact_cutoff
    ORDER BY fact.created_at LIMIT bounded_limit
  )
  DELETE FROM workspace_activity_events fact USING doomed
  WHERE fact.workspace_id = doomed.workspace_id AND fact.id = doomed.id;
  GET DIAGNOSTICS removed_facts = ROW_COUNT;
  RETURN stripped + removed_events + removed_deliveries + removed_facts;
END
$$;

DO $definer_search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_scheduled_admission_refusal() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$definer_search_path$;
