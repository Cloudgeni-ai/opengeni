-- deployment-mode: rolling
-- Event triggers for automations (scheduled tasks). An event source delivers
-- events into a workspace: a webhook endpoint someone pastes into another app,
-- an app Opengeni receives events from directly, or an MCP connection. Every
-- raw delivery is stored, verified and deduplicated, then normalized into
-- events. Matching an event against active triggers queues it in its
-- automation's inbox in the same transaction; the dispatcher turns inbox rows
-- into occurrences, each of which becomes one ordinary scheduled-task run with
-- trigger type `event`.
--
-- New tables only, plus `event` as an accepted run trigger type. Older
-- binaries never read or write the tables and never pass `event`.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE event_sources (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('webhook', 'github', 'slack', 'gmail', 'mcp')),
  -- Webhook sources only: how deliveries are verified and read.
  adapter text CHECK (adapter IS NULL OR adapter IN ('standard', 'linear', 'sentry')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- The person the source belongs to; NULL for workspace app sources.
  owner_subject_id text CHECK (owner_subject_id IS NULL
    OR octet_length(owner_subject_id) BETWEEN 1 AND 4096),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'workspace')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'blocked')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 500),
  -- Webhook sources: the encrypted signing secret.
  secret_encrypted text,
  -- App sources: the provider identity deliveries are routed by (a GitHub
  -- installation id, a Slack team id, a Gmail address).
  external_key text CHECK (external_key IS NULL OR octet_length(external_key) BETWEEN 1 AND 512),
  -- MCP and Gmail sources: the server and the owner's connection.
  mcp_server_id text CHECK (mcp_server_id IS NULL OR octet_length(mcp_server_id) BETWEEN 1 AND 256),
  connection_id uuid,
  last_delivery_at timestamptz,
  created_by_subject_id text NOT NULL CHECK (octet_length(created_by_subject_id) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_sources_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT event_sources_shape_chk CHECK (
    ((kind = 'webhook') = (adapter IS NOT NULL))
    AND (kind <> 'webhook' OR secret_encrypted IS NOT NULL)
    AND ((kind = 'mcp') = (mcp_server_id IS NOT NULL))
    AND (kind NOT IN ('github', 'slack', 'gmail') OR external_key IS NOT NULL)
    AND (kind NOT IN ('webhook', 'gmail', 'mcp') OR owner_subject_id IS NOT NULL)
    AND ((status = 'active') = (status_reason IS NULL))
  )
);
CREATE UNIQUE INDEX event_sources_workspace_id_uq ON event_sources(workspace_id, id);
-- One source per app installation, mailbox or MCP connection.
CREATE UNIQUE INDEX event_sources_app_uq ON event_sources(workspace_id, kind, external_key)
  WHERE kind IN ('github', 'slack', 'gmail');
CREATE UNIQUE INDEX event_sources_mcp_uq
  ON event_sources(workspace_id, owner_subject_id, mcp_server_id, connection_id) NULLS NOT DISTINCT
  WHERE kind = 'mcp';

-- Credential-free routing. A webhook URL carries only a random route id; app
-- receivers find their sources by provider identity. The FORCE-RLS source row
-- and its encrypted secret still authenticate every delivery.
CREATE TABLE event_ingress_routes (
  route_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('webhook', 'github', 'slack', 'gmail', 'mcp')),
  external_key text CHECK (external_key IS NULL OR octet_length(external_key) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_ingress_routes_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX event_ingress_routes_source_idx ON event_ingress_routes(source_id);
CREATE INDEX event_ingress_routes_external_idx ON event_ingress_routes(kind, external_key)
  WHERE external_key IS NOT NULL;

CREATE TABLE event_deliveries (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('accepted', 'ignored', 'rejected', 'failed')),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  -- The sender's delivery identity, or a digest of the body when it has none.
  dedupe_key text NOT NULL CHECK (octet_length(dedupe_key) BETWEEN 1 AND 512),
  -- Verified raw body, kept a few days so a delivery can be replayed.
  body bytea,
  body_bytes integer NOT NULL CHECK (body_bytes >= 0),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- The few non-secret headers an adapter reads, kept with the body.
  headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers) = 'object'
    AND octet_length(headers::text) <= 8192),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  last_duplicate_at timestamptz,
  replay_of_delivery_id uuid,
  CONSTRAINT event_deliveries_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT event_deliveries_body_chk CHECK (body IS NULL OR octet_length(body) = body_bytes)
);
CREATE UNIQUE INDEX event_deliveries_dedupe_uq ON event_deliveries(source_id, dedupe_key)
  WHERE replay_of_delivery_id IS NULL;
CREATE INDEX event_deliveries_source_received_idx
  ON event_deliveries(workspace_id, source_id, received_at DESC, id DESC);
CREATE INDEX event_deliveries_received_idx ON event_deliveries(received_at);
CREATE INDEX event_deliveries_retained_body_idx ON event_deliveries(received_at)
  WHERE body IS NOT NULL;

CREATE TABLE inbound_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  delivery_id uuid REFERENCES event_deliveries(id) ON DELETE SET NULL,
  -- The sender's own event id, when it has one; unique per source and stream.
  external_id text CHECK (external_id IS NULL OR octet_length(external_id) BETWEEN 1 AND 512),
  -- The stream inside a source an event arrived on (an MCP subscription).
  stream_key text NOT NULL DEFAULT '' CHECK (octet_length(stream_key) <= 512),
  type text NOT NULL CHECK (octet_length(type) BETWEEN 1 AND 200),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 300),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 500),
  url text CHECK (url IS NULL OR octet_length(url) <= 2048),
  actor_kind text NOT NULL DEFAULT 'unknown'
    CHECK (actor_kind IN ('person', 'bot', 'opengeni', 'unknown')),
  actor_name text CHECK (actor_name IS NULL OR char_length(actor_name) <= 200),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'
    AND octet_length(data::text) <= 98304),
  data_truncated boolean NOT NULL DEFAULT false,
  gap_before boolean NOT NULL DEFAULT false,
  CONSTRAINT inbound_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX inbound_events_external_uq ON inbound_events(source_id, stream_key, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX inbound_events_source_received_idx
  ON inbound_events(workspace_id, source_id, received_at DESC, id DESC);
CREATE INDEX inbound_events_workspace_received_idx
  ON inbound_events(workspace_id, received_at DESC, id DESC);
CREATE INDEX inbound_events_delivery_idx ON inbound_events(delivery_id);
CREATE INDEX inbound_events_received_idx ON inbound_events(received_at);

CREATE TABLE event_triggers (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 15),
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 32),
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array'
    AND jsonb_array_length(conditions) <= 16 AND octet_length(conditions::text) <= 32768),
  include_own_events boolean NOT NULL DEFAULT false,
  -- MCP subscription arguments, validated against the event type's inputSchema.
  arguments jsonb CHECK (arguments IS NULL OR (jsonb_typeof(arguments) = 'object'
    AND octet_length(arguments::text) <= 16384)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'disabled')),
  status_reason text CHECK (status_reason IS NULL OR char_length(status_reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_triggers_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT event_triggers_position_uq UNIQUE (task_id, position),
  CONSTRAINT event_triggers_status_chk CHECK ((status = 'active') = (status_reason IS NULL))
);
CREATE INDEX event_triggers_source_idx ON event_triggers(workspace_id, source_id)
  WHERE status = 'active';
CREATE INDEX event_triggers_task_idx ON event_triggers(workspace_id, task_id);

-- The event run policy of an automation that has event triggers. The
-- scheduled task row stays untouched: its execution digest covers the whole
-- row, and triggers are not execution configuration.
CREATE TABLE scheduled_task_event_settings (
  task_id uuid PRIMARY KEY REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Storm guard: at most this many event runs in a rolling hour.
  max_runs_per_hour integer NOT NULL DEFAULT 30 CHECK (max_runs_per_hour BETWEEN 1 AND 1000),
  -- Finish after the first run, whichever trigger fires first.
  once boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  -- When `once` was last armed: a run created after it finishes the automation.
  armed_at timestamptz NOT NULL DEFAULT now(),
  -- When the dispatcher should next look at this automation's inbox; NULL
  -- when nothing waits.
  dispatch_due_at timestamptz,
  -- When the storm guard started holding events back, and whether the owner
  -- has been told about this episode.
  throttled_since timestamptz,
  throttle_notified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_task_event_settings_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT scheduled_task_event_settings_completion_chk CHECK (once OR completed_at IS NULL)
);
CREATE INDEX scheduled_task_event_settings_due_idx
  ON scheduled_task_event_settings(dispatch_due_at, task_id)
  WHERE dispatch_due_at IS NOT NULL;
CREATE INDEX scheduled_task_event_settings_workspace_idx
  ON scheduled_task_event_settings(workspace_id, task_id);

-- One batch of events that becomes exactly one run. The run's producer key is
-- `event-occurrence:<id>`, so a retried start converges on the same run.
CREATE TABLE scheduled_task_event_occurrences (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  trigger_ids uuid[] NOT NULL CHECK (cardinality(trigger_ids) BETWEEN 1 AND 16),
  -- Every event the batch accounts for, and the ones it carries to the agent.
  event_count integer NOT NULL CHECK (event_count >= 1),
  event_ids uuid[] NOT NULL CHECK (cardinality(event_ids) BETWEEN 1 AND 50),
  -- Bounded event summaries kept with the run after the events expire.
  events jsonb NOT NULL CHECK (jsonb_typeof(events) = 'array'
    AND octet_length(events::text) <= 65536),
  gap_before boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'started')),
  start_attempts integer NOT NULL DEFAULT 0 CHECK (start_attempts >= 0),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  CONSTRAINT scheduled_task_event_occurrences_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT scheduled_task_event_occurrences_status_chk CHECK ((status = 'started') = (started_at IS NOT NULL))
);
CREATE INDEX scheduled_task_event_occurrences_task_idx
  ON scheduled_task_event_occurrences(workspace_id, task_id, created_at DESC);
CREATE INDEX scheduled_task_event_occurrences_pending_idx
  ON scheduled_task_event_occurrences(task_id, created_at)
  WHERE status = 'pending';

-- Events that matched an automation and wait for, or were folded into, an
-- occurrence. An event matching several triggers of one automation is one row.
CREATE TABLE scheduled_task_event_inbox (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES inbound_events(id) ON DELETE CASCADE,
  trigger_ids uuid[] NOT NULL CHECK (cardinality(trigger_ids) BETWEEN 1 AND 16),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'batched', 'skipped')),
  occurrence_id uuid REFERENCES scheduled_task_event_occurrences(id) ON DELETE SET NULL,
  CONSTRAINT scheduled_task_event_inbox_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT scheduled_task_event_inbox_event_uq UNIQUE (task_id, event_id)
);
CREATE INDEX scheduled_task_event_inbox_pending_idx
  ON scheduled_task_event_inbox(task_id, occurred_at, id)
  WHERE status = 'pending';
CREATE INDEX scheduled_task_event_inbox_workspace_idx
  ON scheduled_task_event_inbox(workspace_id, task_id);
CREATE INDEX scheduled_task_event_inbox_event_idx ON scheduled_task_event_inbox(event_id);

ALTER TABLE event_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE event_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_events FORCE ROW LEVEL SECURITY;
ALTER TABLE event_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_event_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_event_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_event_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_event_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_event_inbox FORCE ROW LEVEL SECURITY;

DO $event_trigger_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'event_sources', 'event_deliveries', 'inbound_events', 'event_triggers',
    'scheduled_task_event_settings', 'scheduled_task_event_occurrences',
    'scheduled_task_event_inbox'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
        || 'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
        || 'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
  END LOOP;
  -- FORCE RLS also binds the table owner, so the owner-run maintenance
  -- functions below get exact owner-only policies. The runtime role is never
  -- the owner and stays bound to its workspace scope.
  FOREACH table_name IN ARRAY ARRAY[
    'event_deliveries', 'inbound_events', 'scheduled_task_event_settings'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY event_trigger_maintenance_owner ON %1$I '
        || 'USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner) '
        || 'FROM pg_catalog.pg_class relation WHERE relation.oid = %1$L::regclass)) '
        || 'WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner) '
        || 'FROM pg_catalog.pg_class relation WHERE relation.oid = %1$L::regclass))',
      table_name
    );
  END LOOP;
END $event_trigger_policies$;
REVOKE ALL ON TABLE event_ingress_routes FROM PUBLIC;

-- The dispatcher is one cross-workspace loop. It finds automations whose
-- inbox is due through this identity-only function; every read and write of
-- the inbox itself happens under that automation's workspace scope.
CREATE FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(p_limit integer)
RETURNS TABLE (task_id uuid, workspace_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $list_due_event_trigger_tasks$
  SELECT settings.task_id, settings.workspace_id
  FROM scheduled_task_event_settings settings
  WHERE settings.dispatch_due_at IS NOT NULL
    AND settings.dispatch_due_at <= pg_catalog.now()
  ORDER BY settings.dispatch_due_at, settings.task_id
  LIMIT greatest(1, least(coalesce(p_limit, 32), 200));
$list_due_event_trigger_tasks$;

-- Retention: raw delivery bodies after p_body_seconds, deliveries and events
-- after p_event_seconds. Bounded per call; the caller repeats until done.
CREATE FUNCTION opengeni_private.prune_event_intake_v1(
  p_body_seconds integer,
  p_event_seconds integer,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $prune_event_intake$
DECLARE
  bounded_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  body_cutoff timestamptz := pg_catalog.now() - pg_catalog.make_interval(
    secs => greatest(3600, coalesce(p_body_seconds, 604800)));
  event_cutoff timestamptz := pg_catalog.now() - pg_catalog.make_interval(
    secs => greatest(86400, coalesce(p_event_seconds, 2592000)));
  stripped integer;
  removed_events integer;
  removed_deliveries integer;
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
  RETURN stripped + removed_events + removed_deliveries;
END
$prune_event_intake$;

REVOKE ALL ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.prune_event_intake_v1(integer, integer, integer) FROM PUBLIC;

DO $event_trigger_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      event_sources, event_ingress_routes, event_deliveries, inbound_events, event_triggers,
      scheduled_task_event_settings, scheduled_task_event_occurrences, scheduled_task_event_inbox
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.list_due_event_trigger_tasks_v1(integer),
      opengeni_private.prune_event_intake_v1(integer, integer, integer)
      TO opengeni_app;
  END IF;
END $event_trigger_grants$;

-- Event runs are scheduled-task runs with their own trigger type. The body is
-- 0275's, with `event` added to the accepted trigger types.
CREATE OR REPLACE FUNCTION create_scheduled_agent_run_with_admission(
  p_run_id uuid, p_account_id uuid, p_workspace_id uuid, p_task_id uuid,
  p_task_authority_revision bigint, p_task_execution_digest text,
  p_trigger_type text, p_producer_key text, p_scheduled_at timestamptz,
  p_fired_at timestamptz, p_accepted_execution_snapshot jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  inserted_id uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR p_run_id IS NULL OR p_task_id IS NULL
    OR p_task_authority_revision IS NULL
    OR p_task_execution_digest !~ '^[0-9a-f]{64}$'
    OR p_trigger_type NOT IN ('scheduled','manual','initial','provider_event','retry','repair','event')
    OR nullif(btrim(p_producer_key), '') IS NULL
    OR p_accepted_execution_snapshot IS NULL
  THEN
    RAISE EXCEPTION 'scheduled agent run producer admission input is invalid'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scheduled_tasks task
  WHERE task.id = p_task_id AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
    AND task.execution_digest = p_task_execution_digest
    AND task.status = 'active' AND task.deleted_at IS NULL
    AND task.action ->> 'kind' = 'agent_turn'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled agent run task changed before producer admission'
      USING ERRCODE = '40001';
  END IF;

  BEGIN
    INSERT INTO scheduled_task_runs (
      id, account_id, workspace_id, task_id, task_authority_revision,
      task_execution_digest, trigger_type, producer_key, scheduled_at,
      fired_at, status, action_kind, accepted_execution_snapshot,
      accepted_execution_digest
    ) VALUES (
      p_run_id, p_account_id, p_workspace_id, p_task_id,
      p_task_authority_revision, p_task_execution_digest, p_trigger_type,
      p_producer_key, p_scheduled_at, p_fired_at, 'queued', 'agent_turn',
      p_accepted_execution_snapshot,
      encode(digest(convert_to(p_accepted_execution_snapshot::text, 'UTF8'), 'sha256'), 'hex')
    ) ON CONFLICT (workspace_id, producer_key)
      WHERE producer_key IS NOT NULL DO NOTHING
    RETURNING id INTO inserted_id;
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO scheduled_task_runs (
      id, account_id, workspace_id, task_id, task_authority_revision,
      task_execution_digest, trigger_type, producer_key, scheduled_at,
      fired_at, status, action_kind, accepted_execution_snapshot,
      accepted_execution_digest, error, completed_at
    ) VALUES (
      p_run_id, p_account_id, p_workspace_id, p_task_id,
      p_task_authority_revision, p_task_execution_digest, p_trigger_type,
      p_producer_key, p_scheduled_at, p_fired_at, 'failed', 'agent_turn',
      p_accepted_execution_snapshot,
      encode(digest(convert_to(p_accepted_execution_snapshot::text, 'UTF8'), 'sha256'), 'hex'),
      'scheduled_run_authority_proof_rejected', clock_timestamp()
    ) ON CONFLICT (workspace_id, producer_key)
      WHERE producer_key IS NOT NULL DO NOTHING
    RETURNING id INTO inserted_id;
  END;
  IF inserted_id IS NULL THEN
    SELECT run.id INTO STRICT inserted_id
    FROM scheduled_task_runs run
    WHERE run.workspace_id = p_workspace_id
      AND run.producer_key = p_producer_key
      AND run.task_id = p_task_id
      AND run.trigger_type = p_trigger_type;
  END IF;
  RETURN inserted_id;
END
$body$;

-- CREATE OR REPLACE takes the SET clause above; restore the search path the
-- 0275 install gave this definer function. Grants and owner are unchanged.
DO $event_run_admission$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.create_scheduled_agent_run_with_admission(uuid,uuid,uuid,uuid,bigint,text,text,text,timestamp with time zone,timestamp with time zone,jsonb) SET search_path = pg_catalog, %I, public, pg_temp',
    data_schema, data_schema
  );
END $event_run_admission$;

-- An event run's chat update also carries the events that caused it. The
-- occurrence guard keeps proving the update against the accepted run: the
-- events must belong to that run's own occurrence, with its count and gap,
-- each carrying exactly the stored summary in order. Only the bounded data
-- excerpt beside each summary is the worker's.
DO $event_run_occurrence_events$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('validate_scheduled_occurrence_accepted_execution()'::regprocedure);
  anchor := $old$  IF NEW.source_id IS DISTINCT FROM run_row.id::text
$old$;
  replacement := $new$  IF run_row.trigger_type = 'event' AND NEW.payload ? 'events' THEN
    IF NOT coalesce((
      SELECT jsonb_typeof(carried.events) = 'object'
        AND carried.events ?& ARRAY['occurrenceId', 'eventCount', 'events', 'gapBefore']
        AND (SELECT count(*) FROM jsonb_object_keys(carried.events)) = 4
        AND carried.events ->> 'occurrenceId' = occurrence.id::text
        AND carried.events -> 'eventCount' = to_jsonb(occurrence.event_count)
        AND carried.events -> 'gapBefore' = to_jsonb(occurrence.gap_before)
        AND jsonb_typeof(carried.events -> 'events') = 'array'
        AND jsonb_array_length(carried.events -> 'events') <= jsonb_array_length(occurrence.events)
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(carried.events -> 'events') WITH ORDINALITY AS item(event, position)
          WHERE jsonb_typeof(item.event) IS DISTINCT FROM 'object'
            OR jsonb_typeof(item.event -> 'data') IS DISTINCT FROM 'object'
            OR jsonb_typeof(item.event -> 'dataTruncated') IS DISTINCT FROM 'boolean'
            OR (item.event - 'data' - 'dataTruncated')
              IS DISTINCT FROM occurrence.events -> (item.position::integer - 1))
      FROM (SELECT NEW.payload -> 'events' AS events) carried
      JOIN scheduled_task_event_occurrences occurrence
        ON run_row.producer_key = 'scheduled-task-event:' || occurrence.id::text
      WHERE occurrence.task_id = run_row.task_id
        AND occurrence.account_id = run_row.account_id
        AND occurrence.workspace_id = run_row.workspace_id
    ), false) THEN
      RAISE EXCEPTION 'scheduled occurrence events differ from the run''s occurrence'
        USING ERRCODE = '42501';
    END IF;
    expected_payload := expected_payload || jsonb_build_object('events', NEW.payload -> 'events');
  END IF;
  IF NEW.source_id IS DISTINCT FROM run_row.id::text
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'validate_scheduled_occurrence_accepted_execution anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$event_run_occurrence_events$;

-- Event runs are reviewed for their owner like scheduled runs: an automation
-- whose event runs keep failing or being skipped tells its owner once.
DO $event_run_blocker_reviews$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_scheduled_task_blocker_reviews(p_limit integer)
    RETURNS TABLE (id uuid, workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE inventory_id uuid;
    BEGIN
      IF p_limit < 1 OR p_limit > 100 THEN
        RAISE EXCEPTION 'Invalid schedule blocker inventory bound' USING ERRCODE = '22023';
      END IF;
      inventory_id := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY SELECT task.id, task.workspace_id
        FROM %1$I.scheduled_tasks task
        LEFT JOIN %1$I.scheduled_task_blocker_reviews review
          ON review.task_id = task.id AND review.workspace_id = task.workspace_id
        LEFT JOIN LATERAL (
          SELECT run.id, run.status FROM %1$I.scheduled_task_runs run
          WHERE run.workspace_id = task.workspace_id AND run.task_id = task.id
            AND run.account_id = task.account_id
            AND run.trigger_type IN ('scheduled', 'event') AND run.action_kind = 'agent_turn'
          ORDER BY run.created_at DESC, run.id DESC LIMIT 1
        ) latest ON true
        WHERE review.notice_pending IS NOT NULL
          OR (task.deleted_at IS NOT NULL AND review.state IN ('notified', 'paused'))
          OR (task.deleted_at IS NULL AND review.state = 'paused' AND task.status = 'active')
          OR (task.deleted_at IS NULL AND review.state = 'notified' AND task.status <> 'active')
          OR (task.deleted_at IS NULL AND task.status = 'active'
            AND latest.status IN ('succeeded', 'failed', 'skipped')
            AND latest.id IS DISTINCT FROM review.reviewed_run_id
            AND (latest.status <> 'succeeded' OR review.state = 'notified'))
        ORDER BY task.updated_at, task.id LIMIT p_limit;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
      RAISE;
    END
    $body$;
  $create$, data_schema);
END
$event_run_blocker_reviews$;

-- A once-automation finishes after its first run, whichever trigger fired it.
-- It is exhausted like a spent one-time schedule: once its event run exists
-- (or its start has long passed) and no run is pending, the lifecycle
-- inventory pauses it and reconciles its Temporal schedule. The body is
-- 0761's with the completed-once branch added.
CREATE OR REPLACE FUNCTION scheduled_task_is_exhausted(p_task_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT coalesce((SELECT
    NOT EXISTS (SELECT 1 FROM scheduled_task_runs pending
      WHERE pending.task_id = task.id AND pending.account_id = task.account_id
        AND pending.workspace_id = task.workspace_id
        AND pending.status IN ('queued', 'dispatched', 'running'))
    AND (CASE
      WHEN task.schedule->>'type' = 'interval'
        AND pg_input_is_valid(task.schedule->>'endAt', 'timestamptz')
      THEN (task.schedule->>'endAt')::timestamptz + interval '24 hours' < now()
      WHEN task.schedule->>'type' = 'once'
        AND pg_input_is_valid(task.schedule->>'runAt', 'timestamptz')
      THEN (task.schedule->>'runAt')::timestamptz < now() AND (
        (task.schedule->>'runAt')::timestamptz + interval '24 hours' < now()
        OR EXISTS (SELECT 1 FROM scheduled_task_runs consumed
          WHERE consumed.task_id = task.id AND consumed.account_id = task.account_id
            AND consumed.workspace_id = task.workspace_id
            AND consumed.trigger_type = 'scheduled'
            AND consumed.status IN ('succeeded', 'failed', 'skipped')
            AND (consumed.accepted_execution_snapshot->'task'->'schedule' = task.schedule
              OR (consumed.task_authority_revision = task.authority_revision
                AND consumed.task_execution_digest = task.execution_digest))))
      ELSE false
    END
    OR EXISTS (SELECT 1 FROM scheduled_task_event_settings settings
      WHERE settings.task_id = task.id AND settings.account_id = task.account_id
        AND settings.workspace_id = task.workspace_id
        AND settings.once AND settings.completed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM scheduled_task_event_occurrences occurrence
          WHERE occurrence.task_id = task.id AND occurrence.workspace_id = task.workspace_id
            AND (occurrence.status = 'pending'
              OR (occurrence.started_at > now() - interval '1 hour'
                AND NOT EXISTS (SELECT 1 FROM scheduled_task_runs run
                  WHERE run.workspace_id = task.workspace_id AND run.task_id = task.id
                    AND run.producer_key = 'scheduled-task-event:' || occurrence.id::text))))))
    FROM scheduled_tasks task WHERE task.id = p_task_id), false)
$$;
DO $event_once_exhaustion$
DECLARE data_schema text := current_schema(); table_name text;
BEGIN
  EXECUTE format('ALTER FUNCTION %I.scheduled_task_is_exhausted(uuid) SET search_path = pg_catalog, %I, pg_temp', data_schema, data_schema);
  -- The lifecycle inventory reads these through the same exact-owner,
  -- read-only policy 0761 gave scheduled tasks and runs.
  FOREACH table_name IN ARRAY ARRAY['scheduled_task_event_settings', 'scheduled_task_event_occurrences'] LOOP
    EXECUTE format('CREATE POLICY exhausted_schedule_inventory_read ON %I.%I FOR SELECT USING (%I.session_tenancy_fence_owner_policy_active(current_user, %L, %s::oid, workspace_id, true))',
      data_schema, table_name, data_schema, current_user, data_schema::regnamespace::oid);
  END LOOP;
END
$event_once_exhaustion$;
