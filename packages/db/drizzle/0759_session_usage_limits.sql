-- deployment-mode: rolling
-- Per-task (root session) API-equivalent usage limits (OPE-798).
--
-- Accounting facts only: one durable receipt per settled model response,
-- keyed by the canonical producer identity (`<turnId>:<sourceKey>` for agent
-- turns), and one counter row per task root. No prompt/response content is
-- stored. Limits are admission policy, never reservations: a request that is
-- already admitted may finish and take recorded usage above the limit.
--
-- Rolling-safe: additive private tables, EXECUTE-only routines and one AFTER
-- INSERT trigger on sessions that seeds the counter of a NEW root as
-- `complete`. Roots that predate this migration have no counter row; the first
-- read, write or settlement creates it as `preparing` and the bounded,
-- resumable maintenance import converges it to `legacy_partial`. Nothing is
-- backfilled here, so no FORCE-RLS window or table rewrite is needed.
--
-- Lock order: callers that also append session events take the canonical
-- workspace/session event-write prefix first; these routines then lock only
-- the private root counter row. Settlement touches only private rows.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.session_usage_limit_roots (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  root_session_id uuid NOT NULL,
  limit_micros bigint CHECK (limit_micros IS NULL OR limit_micros BETWEEN 0 AND 10000000000000),
  config_version bigint NOT NULL DEFAULT 0 CHECK (config_version >= 0),
  usage_revision bigint NOT NULL DEFAULT 0 CHECK (usage_revision >= 0),
  known_micros bigint NOT NULL DEFAULT 0 CHECK (known_micros BETWEEN 0 AND 9007199254740991),
  priced_calls bigint NOT NULL DEFAULT 0 CHECK (priced_calls >= 0),
  free_calls bigint NOT NULL DEFAULT 0 CHECK (free_calls >= 0),
  unpriced_calls bigint NOT NULL DEFAULT 0 CHECK (unpriced_calls >= 0),
  conflict_count bigint NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  history_state text NOT NULL CHECK (history_state IN ('complete','preparing','legacy_partial')),
  import_cursor jsonb CHECK (import_cursor IS NULL OR jsonb_typeof(import_cursor) = 'object'),
  import_imported bigint NOT NULL DEFAULT 0 CHECK (import_imported >= 0),
  import_error text CHECK (import_error IS NULL OR octet_length(import_error) <= 64),
  import_next_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, root_session_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  -- Quiescent root-tree deletion removes the task's accounting with it.
  FOREIGN KEY (root_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK ((history_state = 'preparing') = (import_next_at IS NOT NULL))
);
CREATE INDEX session_usage_limit_roots_import_due
  ON opengeni_private.session_usage_limit_roots (import_next_at, workspace_id, root_session_id)
  WHERE history_state = 'preparing';

-- One receipt per canonical producer identity. The source session is kept as an
-- opaque identifier without a foreign key so deleting a quiescent child never
-- refunds or erases the surviving root's spend.
CREATE TABLE opengeni_private.session_usage_limit_receipts (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  root_session_id uuid NOT NULL,
  source_id text NOT NULL CHECK (octet_length(source_id) BETWEEN 1 AND 1100),
  source_session_id uuid NOT NULL,
  turn_id uuid,
  status text NOT NULL CHECK (status IN ('priced','free','unpriced')),
  amount_micros bigint,
  pricing_source text CHECK (pricing_source IS NULL
    OR pricing_source IN ('configured_list_price','gateway_reported')),
  model text CHECK (model IS NULL OR octet_length(model) BETWEEN 1 AND 512),
  origin text NOT NULL CHECK (origin IN ('live','legacy')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_id),
  FOREIGN KEY (workspace_id, root_session_id)
    REFERENCES opengeni_private.session_usage_limit_roots(workspace_id, root_session_id) ON DELETE CASCADE,
  CHECK ((status = 'priced' AND amount_micros > 0 AND pricing_source IS NOT NULL)
    OR (status = 'free' AND amount_micros = 0 AND pricing_source IS NOT NULL)
    OR (status = 'unpriced' AND amount_micros IS NULL))
);
CREATE INDEX session_usage_limit_receipts_root
  ON opengeni_private.session_usage_limit_receipts (workspace_id, root_session_id, recorded_at);

-- Exact CAS/idempotency receipt and audit record for every authorized change.
CREATE TABLE opengeni_private.session_usage_limit_config_receipts (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  root_session_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 1 AND 256),
  expected_version bigint NOT NULL CHECK (expected_version >= 0),
  previous_limit_micros bigint,
  limit_micros bigint CHECK (limit_micros IS NULL OR limit_micros BETWEEN 0 AND 10000000000000),
  result_version bigint NOT NULL CHECK (result_version > 0),
  actor_subject_id text NOT NULL CHECK (octet_length(actor_subject_id) BETWEEN 1 AND 1024),
  actor_type text NOT NULL CHECK (actor_type IN ('human','host')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, root_session_id, operation_id),
  FOREIGN KEY (workspace_id, root_session_id)
    REFERENCES opengeni_private.session_usage_limit_roots(workspace_id, root_session_id) ON DELETE CASCADE
);

CREATE TABLE opengeni_private.session_usage_limit_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, data_schema, workspace_id)
);
REVOKE ALL ON TABLE opengeni_private.session_usage_limit_capabilities FROM PUBLIC;

CREATE FUNCTION session_usage_limit_capability_active(p_account uuid, p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (SELECT 1 FROM opengeni_private.session_usage_limit_capabilities c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.transaction_id = pg_current_xact_id_if_assigned()
      AND c.data_schema = (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE t.oid='workspaces'::regclass)
      AND ((c.account_id = p_account AND c.workspace_id = p_workspace)
        OR (p_account IS NULL AND p_workspace IS NULL
          AND c.account_id='00000000-0000-0000-0000-000000000000'::uuid
          AND c.workspace_id='00000000-0000-0000-0000-000000000000'::uuid)))
$$;
-- A value-free predicate cannot mint the private transaction capability.
GRANT EXECUTE ON FUNCTION session_usage_limit_capability_active(uuid, uuid) TO PUBLIC;

DO $policies$
DECLARE t text; target_schema text := current_schema(); owner_name text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_usage_limit_roots','session_usage_limit_receipts',
    'session_usage_limit_config_receipts']
  LOOP
    EXECUTE format('ALTER TABLE opengeni_private.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE opengeni_private.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY session_usage_limit_owner ON opengeni_private.%I FOR ALL USING
      (current_user = %L AND %I.session_usage_limit_capability_active(account_id, workspace_id))
      WITH CHECK (current_user = %L AND %I.session_usage_limit_capability_active(account_id, workspace_id))',
      t, owner_name, target_schema, owner_name, target_schema);
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.%I FROM PUBLIC', t);
  END LOOP;
  -- Global, id-only import inventory for the maintenance routine.
  EXECUTE format('CREATE POLICY session_usage_limit_import_inventory ON opengeni_private.session_usage_limit_roots
    FOR SELECT USING (current_user=%L AND %I.session_usage_limit_capability_active(NULL::uuid,NULL::uuid))',
    owner_name, target_schema);
END $policies$;

-- Content-free projection of one counter row. `usedMicros` is null while the
-- history is still preparing: an incomplete import is never presented as $0.
CREATE FUNCTION session_usage_limit_state(p_root opengeni_private.session_usage_limit_roots,
  p_inherited boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT jsonb_build_object(
    'basis','model_api_equivalent_v1',
    'rootSessionId',p_root.root_session_id,
    'inherited',p_inherited,
    'status',CASE WHEN p_root.history_state='preparing' THEN 'preparing'
      WHEN p_root.limit_micros IS NULL THEN 'unlimited'
      WHEN p_root.known_micros >= p_root.limit_micros THEN 'reached'
      ELSE 'within' END,
    'limitMicros',p_root.limit_micros,
    'usedMicros',CASE WHEN p_root.history_state='preparing' THEN NULL ELSE p_root.known_micros END,
    'version',p_root.config_version,
    'usageRevision',p_root.usage_revision,
    'history',p_root.history_state,
    'coverage',CASE WHEN p_root.history_state='complete' AND p_root.unpriced_calls=0
      THEN 'complete' ELSE 'partial' END,
    'pricedCalls',p_root.priced_calls,
    'freeCalls',p_root.free_calls,
    'unpricedCalls',p_root.unpriced_calls,
    'conflicts',p_root.conflict_count,
    'updatedAt',to_char(p_root.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- Apply one receipt to a locked root row. Exactly-once per (workspace,
-- source): a duplicate is a no-op, an unknown receipt may be filled once with
-- a known amount, and a conflicting known amount is counted and rejected,
-- never debited twice. Returns the outcome label.
CREATE FUNCTION session_usage_limit_apply_receipt(p_account uuid, p_workspace uuid, p_root uuid,
  p_source_id text, p_source_session uuid, p_turn uuid, p_amount bigint, p_pricing_source text,
  p_model text, p_origin text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  v_status text;
  v_pricing text := CASE WHEN p_pricing_source IN ('configured_list_price','gateway_reported')
    THEN p_pricing_source END;
  existing opengeni_private.session_usage_limit_receipts%ROWTYPE;
BEGIN
  IF p_amount IS NOT NULL AND (p_amount < 0 OR p_amount > 9007199254740991) THEN
    RAISE EXCEPTION 'invalid session usage amount' USING ERRCODE='22023';
  END IF;
  v_status := CASE WHEN p_amount IS NULL OR v_pricing IS NULL THEN 'unpriced'
    WHEN p_amount = 0 THEN 'free' ELSE 'priced' END;
  INSERT INTO opengeni_private.session_usage_limit_receipts(account_id,workspace_id,root_session_id,
    source_id,source_session_id,turn_id,status,amount_micros,pricing_source,model,origin)
  VALUES (p_account,p_workspace,p_root,p_source_id,p_source_session,p_turn,v_status,
    CASE WHEN v_status='unpriced' THEN NULL ELSE p_amount END,
    CASE WHEN v_status='unpriced' THEN NULL ELSE v_pricing END,
    nullif(left(p_model,512),''),p_origin)
  ON CONFLICT (workspace_id, source_id) DO NOTHING;
  IF FOUND THEN
    UPDATE opengeni_private.session_usage_limit_roots SET
      known_micros = known_micros + coalesce(CASE WHEN v_status='unpriced' THEN 0 ELSE p_amount END,0),
      priced_calls = priced_calls + (v_status='priced')::int,
      free_calls = free_calls + (v_status='free')::int,
      unpriced_calls = unpriced_calls + (v_status='unpriced')::int,
      usage_revision = usage_revision + 1, updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace AND root_session_id = p_root;
    RETURN 'recorded';
  END IF;
  SELECT * INTO existing FROM opengeni_private.session_usage_limit_receipts
    WHERE workspace_id = p_workspace AND source_id = p_source_id;
  IF existing.root_session_id IS DISTINCT FROM p_root THEN
    -- Root lineage is immutable; a different root for one producer identity
    -- is never redirected or double-counted.
    UPDATE opengeni_private.session_usage_limit_roots SET conflict_count = conflict_count + 1
      WHERE workspace_id = p_workspace AND root_session_id = p_root;
    RETURN 'conflict';
  END IF;
  IF existing.status = v_status AND existing.amount_micros IS NOT DISTINCT FROM
    (CASE WHEN v_status='unpriced' THEN NULL ELSE p_amount END) THEN
    RETURN 'duplicate';
  END IF;
  IF v_status = 'unpriced' THEN
    -- A known amount is never replaced by a later unknown observation.
    RETURN 'duplicate';
  END IF;
  IF existing.status = 'unpriced' THEN
    UPDATE opengeni_private.session_usage_limit_receipts SET status = v_status,
      amount_micros = p_amount, pricing_source = v_pricing
    WHERE workspace_id = p_workspace AND source_id = p_source_id;
    UPDATE opengeni_private.session_usage_limit_roots SET
      known_micros = known_micros + p_amount,
      priced_calls = priced_calls + (v_status='priced')::int,
      free_calls = free_calls + (v_status='free')::int,
      unpriced_calls = unpriced_calls - 1,
      usage_revision = usage_revision + 1, updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace AND root_session_id = p_root;
    RETURN 'filled';
  END IF;
  UPDATE opengeni_private.session_usage_limit_roots SET conflict_count = conflict_count + 1
    WHERE workspace_id = p_workspace AND root_session_id = p_root;
  RETURN 'conflict';
END $$;

-- Import one bounded page of stored per-call cost snapshots for a preparing
-- root: authoritative model_call_facts first, then recoverable
-- agent.model.usage events, per tree session in id order, by keyset cursor.
-- Stored rates only; unknown historical amounts stay unknown. Both sources and
-- live receipts share one identity, so nothing is counted twice. Caller holds
-- the root row lock and the tenant capability. Returns true when complete.
CREATE FUNCTION session_usage_limit_import_page(p_account uuid, p_workspace uuid, p_root uuid,
  p_budget integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  cur jsonb; v_session uuid; v_after uuid; v_phase text; v_fact_at timestamptz; v_fact_id uuid;
  v_seq bigint; budget integer := greatest(1, least(coalesce(p_budget, 500), 2000));
  fetched integer; row_fact record; row_event record; imported integer := 0; v_amount bigint;
  v_pricing text; v_outcome text;
BEGIN
  SELECT import_cursor INTO cur FROM opengeni_private.session_usage_limit_roots
    WHERE workspace_id = p_workspace AND root_session_id = p_root;
  cur := coalesce(cur, '{}'::jsonb);
  v_session := nullif(cur->>'session','')::uuid;
  v_after := nullif(cur->>'after','')::uuid;
  v_phase := coalesce(cur->>'phase','facts');
  v_fact_at := coalesce(nullif(cur->>'factAt','')::timestamptz, '-infinity'::timestamptz);
  v_fact_id := coalesce(nullif(cur->>'factId','')::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
  v_seq := coalesce(nullif(cur->>'seq','')::bigint, 0);
  LOOP
    IF v_session IS NULL THEN
      SELECT s.id INTO v_session FROM sessions s
        WHERE s.workspace_id = p_workspace AND s.account_id = p_account AND s.root_session_id = p_root
          AND (v_after IS NULL OR s.id > v_after)
        ORDER BY s.id LIMIT 1;
      IF v_session IS NULL THEN
        UPDATE opengeni_private.session_usage_limit_roots SET import_cursor = NULL,
          import_imported = import_imported + imported
        WHERE workspace_id = p_workspace AND root_session_id = p_root;
        RETURN true;
      END IF;
      v_phase := 'facts'; v_fact_at := '-infinity'; v_fact_id := '00000000-0000-0000-0000-000000000000';
      v_seq := 0;
    END IF;
    IF v_phase = 'facts' THEN
      fetched := 0;
      FOR row_fact IN SELECT f.id, f.occurred_at, f.turn_id, f.source_key, f.model,
          f.estimated_provider_cost_micros, f.pricing_source
        FROM model_call_facts f
        WHERE f.workspace_id = p_workspace AND f.session_id = v_session
          AND (f.occurred_at, f.id) > (v_fact_at, v_fact_id)
        ORDER BY f.occurred_at, f.id LIMIT budget
      LOOP
        fetched := fetched + 1;
        v_outcome := session_usage_limit_apply_receipt(p_account, p_workspace, p_root,
          row_fact.turn_id::text || ':' || row_fact.source_key, v_session, row_fact.turn_id,
          row_fact.estimated_provider_cost_micros, row_fact.pricing_source, row_fact.model, 'legacy');
        IF v_outcome IN ('recorded','filled') THEN imported := imported + 1; END IF;
        v_fact_at := row_fact.occurred_at; v_fact_id := row_fact.id;
      END LOOP;
      budget := budget - fetched;
      IF budget > 0 THEN v_phase := 'events'; v_seq := 0; END IF;
    END IF;
    IF v_phase = 'events' AND budget > 0 THEN
      fetched := 0;
      FOR row_event IN SELECT e.sequence, e.turn_id, e.payload
        FROM session_events e
        WHERE e.workspace_id = p_workspace AND e.session_id = v_session
          AND e.type = 'agent.model.usage' AND e.sequence > v_seq
        ORDER BY e.sequence LIMIT budget
      LOOP
        fetched := fetched + 1;
        v_seq := row_event.sequence;
        -- Malformed or unattributable events are skipped, never valued.
        CONTINUE WHEN row_event.turn_id IS NULL
          OR jsonb_typeof(row_event.payload) IS DISTINCT FROM 'object'
          OR jsonb_typeof(row_event.payload->'sourceKey') IS DISTINCT FROM 'string'
          OR octet_length(row_event.payload->>'sourceKey') NOT BETWEEN 1 AND 1024;
        v_pricing := row_event.payload->>'pricingSource';
        v_amount := CASE WHEN jsonb_typeof(row_event.payload->'estimatedProviderCostMicros') = 'number'
            AND (row_event.payload->>'estimatedProviderCostMicros') ~ '^[0-9]{1,16}$'
          THEN (row_event.payload->>'estimatedProviderCostMicros')::bigint END;
        v_outcome := session_usage_limit_apply_receipt(p_account, p_workspace, p_root,
          row_event.turn_id::text || ':' || (row_event.payload->>'sourceKey'), v_session,
          row_event.turn_id, v_amount, v_pricing,
          CASE WHEN jsonb_typeof(row_event.payload->'model') = 'string'
            THEN row_event.payload->>'model' END, 'legacy');
        IF v_outcome IN ('recorded','filled') THEN imported := imported + 1; END IF;
      END LOOP;
      budget := budget - fetched;
      IF budget > 0 THEN v_after := v_session; v_session := NULL; END IF;
    END IF;
    EXIT WHEN budget <= 0;
  END LOOP;
  UPDATE opengeni_private.session_usage_limit_roots SET
    import_cursor = jsonb_build_object('session', v_session, 'after', v_after, 'phase', v_phase,
      'factAt', v_fact_at, 'factId', v_fact_id, 'seq', v_seq),
    import_imported = import_imported + imported
  WHERE workspace_id = p_workspace AND root_session_id = p_root;
  RETURN false;
END $$;

-- One bounded import step under the caller's locked root row.
CREATE FUNCTION session_usage_limit_import_step(p_account uuid, p_workspace uuid, p_root uuid,
  p_budget integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  IF session_usage_limit_import_page(p_account, p_workspace, p_root, p_budget) THEN
    -- Absence of an older record is not proof of no usage: stay partial.
    UPDATE opengeni_private.session_usage_limit_roots SET history_state = 'legacy_partial',
      import_next_at = NULL, import_error = NULL, usage_revision = usage_revision + 1,
      updated_at = clock_timestamp()
    WHERE workspace_id = p_workspace AND root_session_id = p_root;
    RETURN true;
  END IF;
  UPDATE opengeni_private.session_usage_limit_roots SET import_next_at = clock_timestamp(),
    import_error = NULL
  WHERE workspace_id = p_workspace AND root_session_id = p_root;
  RETURN false;
END $$;

-- Seed new roots as complete in the creating transaction.
CREATE FUNCTION seed_session_usage_limit_root()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE opened integer;
BEGIN
  IF NEW.id IS DISTINCT FROM NEW.root_session_id THEN RETURN NEW; END IF;
  INSERT INTO opengeni_private.session_usage_limit_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  INSERT INTO opengeni_private.session_usage_limit_roots(account_id,workspace_id,root_session_id,history_state)
    VALUES (NEW.account_id,NEW.workspace_id,NEW.id,'complete')
    ON CONFLICT (workspace_id, root_session_id) DO NOTHING;
  IF opened = 1 THEN
    DELETE FROM opengeni_private.session_usage_limit_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND data_schema=TG_TABLE_SCHEMA AND account_id=NEW.account_id AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_usage_limit_root_seed AFTER INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION seed_session_usage_limit_root();

-- The only runtime entry point. Actions:
--   read    {sessionId[, prepare]}           -> {outcome, state}
--   set     {sessionId, limitMicros, expectedVersion, operationId, actorSubjectId,
--            actorType, producerEnabled}     -> {outcome, state, rootSessionId}
--   settle  {sessionId, sourceId, turnId?, amountMicros, pricingSource, model}
--                                            -> {outcome, state}
-- Session visibility is evaluated under the caller's RLS context, so a private
-- or hidden session is indistinguishable from a missing one.
CREATE FUNCTION session_usage_limit_command(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  a uuid := (p_input->>'accountId')::uuid;
  w uuid := (p_input->>'workspaceId')::uuid;
  action text := p_input->>'action';
  v_session uuid := (p_input->>'sessionId')::uuid;
  v_root uuid;
  root_row opengeni_private.session_usage_limit_roots%ROWTYPE;
  prior_receipt opengeni_private.session_usage_limit_config_receipts%ROWTYPE;
  opened integer;
  v_limit bigint;
  v_previous bigint;
  v_expected bigint;
  v_outcome text;
  previous_subject text;
  result jsonb;
  v_data_schema text := (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE t.oid='workspaces'::regclass);
BEGIN
  IF a IS NULL OR w IS NULL OR v_session IS NULL
    OR opengeni_private.workspace_rls_visible(a, w) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'session usage limit scope denied' USING ERRCODE = '42501';
  END IF;
  IF action NOT IN ('read','set','settle') THEN
    RAISE EXCEPTION 'unknown session usage limit action' USING ERRCODE = '22023';
  END IF;
  -- Visibility under the caller's own policies (workspace and private-session).
  SELECT s.root_session_id INTO v_root FROM sessions s
    WHERE s.id = v_session AND s.workspace_id = w AND s.account_id = a;
  IF v_root IS NULL THEN
    RETURN jsonb_build_object('outcome', CASE WHEN action='settle' THEN 'source_gone' ELSE 'not_found' END);
  END IF;
  IF action = 'set' AND v_root <> v_session THEN
    RETURN jsonb_build_object('outcome','not_root','rootSessionId',v_root);
  END IF;
  INSERT INTO opengeni_private.session_usage_limit_capabilities
    VALUES (pg_backend_pid(), pg_current_xact_id(), v_data_schema, a, w)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  IF action = 'read' AND NOT coalesce((p_input->>'prepare')::boolean, false) THEN
    -- Hot admission read: one indexed row, no lock, no event scan.
    SELECT * INTO root_row FROM opengeni_private.session_usage_limit_roots
      WHERE workspace_id = w AND root_session_id = v_root;
  END IF;
  IF root_row.root_session_id IS NULL THEN
    -- Roots created before this feature are initialized lazily and imported.
    INSERT INTO opengeni_private.session_usage_limit_roots(account_id,workspace_id,root_session_id,
      history_state,import_next_at)
    SELECT a, w, v_root, 'preparing', clock_timestamp()
    WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = v_root AND s.workspace_id = w)
    ON CONFLICT (workspace_id, root_session_id) DO NOTHING;
    SELECT * INTO root_row FROM opengeni_private.session_usage_limit_roots
      WHERE workspace_id = w AND root_session_id = v_root FOR NO KEY UPDATE;
    IF root_row.root_session_id IS NULL THEN
      IF opened = 1 THEN
        DELETE FROM opengeni_private.session_usage_limit_capabilities WHERE backend_pid=pg_backend_pid()
          AND transaction_id=pg_current_xact_id_if_assigned() AND data_schema=v_data_schema
          AND workspace_id=w;
      END IF;
      RETURN jsonb_build_object('outcome', CASE WHEN action='settle' THEN 'source_gone' ELSE 'not_found' END);
    END IF;
    IF root_row.history_state = 'preparing' AND coalesce((p_input->>'prepare')::boolean, false) THEN
      -- The content-free import counts every tree session, including private
      -- sessions the caller cannot open; the caller only ever sees the total.
      previous_subject := current_setting('opengeni.subject_id', true);
      PERFORM set_config('opengeni.subject_id', '', true);
      PERFORM session_usage_limit_import_step(a, w, v_root, 500);
      PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
      SELECT * INTO root_row FROM opengeni_private.session_usage_limit_roots
        WHERE workspace_id = w AND root_session_id = v_root;
    END IF;
  END IF;

  IF action = 'read' THEN
    result := jsonb_build_object('outcome','ok',
      'state', session_usage_limit_state(root_row, v_root <> v_session));
  ELSIF action = 'settle' THEN
    v_outcome := session_usage_limit_apply_receipt(a, w, v_root,
      p_input->>'sourceId', v_session, nullif(p_input->>'turnId','')::uuid,
      CASE WHEN jsonb_typeof(p_input->'amountMicros') = 'number'
        THEN (p_input->>'amountMicros')::bigint END,
      p_input->>'pricingSource', p_input->>'model', 'live');
    SELECT * INTO root_row FROM opengeni_private.session_usage_limit_roots
      WHERE workspace_id = w AND root_session_id = v_root;
    result := jsonb_build_object('outcome', v_outcome,
      'state', session_usage_limit_state(root_row, v_root <> v_session));
  ELSE
    IF p_input->>'actorType' NOT IN ('human','host')
      OR octet_length(coalesce(p_input->>'actorSubjectId','')) NOT BETWEEN 1 AND 1024
      OR octet_length(coalesce(p_input->>'operationId','')) NOT BETWEEN 1 AND 256
      OR jsonb_typeof(p_input->'expectedVersion') <> 'number'
      OR (p_input->'limitMicros' <> 'null'::jsonb AND jsonb_typeof(p_input->'limitMicros') <> 'number') THEN
      RAISE EXCEPTION 'invalid session usage limit write' USING ERRCODE = '22023';
    END IF;
    v_limit := CASE WHEN p_input->'limitMicros' = 'null'::jsonb THEN NULL
      ELSE (p_input->>'limitMicros')::bigint END;
    v_expected := (p_input->>'expectedVersion')::bigint;
    IF v_limit IS NOT NULL AND (v_limit < 0 OR v_limit > 10000000000000) THEN
      RAISE EXCEPTION 'invalid session usage limit' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO root_row FROM opengeni_private.session_usage_limit_roots
      WHERE workspace_id = w AND root_session_id = v_root FOR NO KEY UPDATE;
    SELECT * INTO prior_receipt FROM opengeni_private.session_usage_limit_config_receipts
      WHERE workspace_id = w AND root_session_id = v_root AND operation_id = p_input->>'operationId';
    IF FOUND THEN
      IF prior_receipt.expected_version <> v_expected
        OR prior_receipt.limit_micros IS DISTINCT FROM v_limit THEN
        result := jsonb_build_object('outcome','operation_conflict',
          'state', session_usage_limit_state(root_row, false));
      ELSE
        result := jsonb_build_object('outcome','replayed','resultVersion',prior_receipt.result_version,
          'state', session_usage_limit_state(root_row, false));
      END IF;
    ELSIF root_row.config_version <> v_expected THEN
      result := jsonb_build_object('outcome','conflict','state', session_usage_limit_state(root_row, false));
    ELSIF v_limit IS NOT NULL AND root_row.history_state = 'preparing' THEN
      result := jsonb_build_object('outcome','preparing','state', session_usage_limit_state(root_row, false));
    ELSIF v_limit IS NOT NULL AND coalesce((p_input->>'producerEnabled')::boolean, false) IS NOT TRUE THEN
      result := jsonb_build_object('outcome','disabled','state', session_usage_limit_state(root_row, false));
    ELSE
      v_previous := root_row.limit_micros;
      UPDATE opengeni_private.session_usage_limit_roots SET limit_micros = v_limit,
        config_version = config_version + 1, updated_at = clock_timestamp()
      WHERE workspace_id = w AND root_session_id = v_root
      RETURNING * INTO root_row;
      INSERT INTO opengeni_private.session_usage_limit_config_receipts(account_id,workspace_id,
        root_session_id,operation_id,expected_version,previous_limit_micros,limit_micros,result_version,
        actor_subject_id,actor_type)
      VALUES (a, w, v_root, p_input->>'operationId', v_expected,
        v_previous, v_limit,
        root_row.config_version, p_input->>'actorSubjectId', p_input->>'actorType');
      result := jsonb_build_object('outcome','ok','previousLimitMicros', v_previous,
        'state', session_usage_limit_state(root_row, false));
    END IF;
    result := result || jsonb_build_object('rootSessionId', v_root);
  END IF;
  IF opened = 1 THEN
    DELETE FROM opengeni_private.session_usage_limit_capabilities WHERE backend_pid=pg_backend_pid()
      AND transaction_id=pg_current_xact_id_if_assigned() AND data_schema=v_data_schema
      AND workspace_id=w;
  END IF;
  RETURN result;
END $$;

-- Cross-workspace import maintenance. Inventory uses an owner-only global
-- capability; each import step runs under its exact tenant GUC/capability so
-- every source read is evaluated by the ordinary RLS policies. Failures retry
-- later with a bounded error code; they never mark a root complete.
CREATE FUNCTION maintain_session_usage_limits(p_limit integer, p_budget integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target record; opened integer; tenant_opened integer; processed integer := 0;
  previous_account text := current_setting('opengeni.account_id', true);
  previous_workspace text := current_setting('opengeni.workspace_id', true);
  previous_subject text := current_setting('opengeni.subject_id', true);
  v_data_schema text := (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid='workspaces'::regclass);
BEGIN
  INSERT INTO opengeni_private.session_usage_limit_capabilities VALUES(pg_backend_pid(),pg_current_xact_id(),
    v_data_schema,'00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  -- Private-session visibility does not restrict this content-free import.
  PERFORM set_config('opengeni.subject_id', '', true);
  FOR target IN SELECT account_id, workspace_id, root_session_id
    FROM opengeni_private.session_usage_limit_roots
    WHERE history_state = 'preparing' AND import_next_at <= clock_timestamp()
    ORDER BY import_next_at, workspace_id, root_session_id
    LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
  LOOP
    PERFORM set_config('opengeni.account_id', target.account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', target.workspace_id::text, true);
    INSERT INTO opengeni_private.session_usage_limit_capabilities VALUES(pg_backend_pid(),pg_current_xact_id(),
      v_data_schema,target.account_id,target.workspace_id) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS tenant_opened = ROW_COUNT;
    BEGIN
      PERFORM 1 FROM opengeni_private.session_usage_limit_roots
        WHERE workspace_id = target.workspace_id AND root_session_id = target.root_session_id
          AND history_state = 'preparing'
        FOR NO KEY UPDATE SKIP LOCKED;
      IF FOUND THEN
        PERFORM session_usage_limit_import_step(target.account_id, target.workspace_id,
          target.root_session_id, p_budget);
        processed := processed + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE opengeni_private.session_usage_limit_roots SET
        import_next_at = clock_timestamp() + interval '1 minute', import_error = SQLSTATE
      WHERE workspace_id = target.workspace_id AND root_session_id = target.root_session_id
        AND history_state = 'preparing';
    END;
    IF tenant_opened = 1 THEN DELETE FROM opengeni_private.session_usage_limit_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND data_schema=v_data_schema AND workspace_id=target.workspace_id; END IF;
  END LOOP;
  IF opened = 1 THEN DELETE FROM opengeni_private.session_usage_limit_capabilities
    WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
      AND data_schema=v_data_schema
      AND workspace_id='00000000-0000-0000-0000-000000000000'::uuid; END IF;
  PERFORM set_config('opengeni.account_id', coalesce(previous_account, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace, ''), true);
  PERFORM set_config('opengeni.subject_id', coalesce(previous_subject, ''), true);
  RETURN processed;
END $$;

-- Pin search paths, strip default/hostile grants, and grant the two runtime
-- entry points to the exact existing session writers during the rolling deploy.
DO $acl$
DECLARE role_name text; object_name text; function_name text; target_schema text := current_schema();
BEGIN
  FOREACH function_name IN ARRAY ARRAY['session_usage_limit_command(jsonb)',
    'maintain_session_usage_limits(integer,integer)',
    'session_usage_limit_capability_active(uuid,uuid)',
    'session_usage_limit_state(opengeni_private.session_usage_limit_roots,boolean)',
    'session_usage_limit_apply_receipt(uuid,uuid,uuid,text,uuid,uuid,bigint,text,text,text)',
    'session_usage_limit_import_page(uuid,uuid,uuid,integer)',
    'session_usage_limit_import_step(uuid,uuid,uuid,integer)',
    'seed_session_usage_limit_root()']
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',target_schema,function_name,target_schema);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=format('%I.%s',target_schema,function_name)::regprocedure AND acl.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',target_schema,function_name,role_name); END LOOP;
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',target_schema,function_name);
  END LOOP;
  GRANT EXECUTE ON FUNCTION session_usage_limit_capability_active(uuid, uuid) TO PUBLIC;
  FOR object_name IN SELECT c.oid::regclass::text FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='opengeni_private' AND c.relname IN ('session_usage_limit_roots',
      'session_usage_limit_receipts','session_usage_limit_config_receipts',
      'session_usage_limit_capabilities')
  LOOP
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE c.oid=object_name::regclass AND acl.grantee<>c.relowner
    LOOP EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',object_name,role_name); END LOOP;
  END LOOP;
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE c.oid='session_events'::regclass AND acl.privilege_type='INSERT' AND acl.grantee<>c.relowner
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION session_usage_limit_command(jsonb), maintain_session_usage_limits(integer,integer) TO %I',role_name);
  END LOOP;
END $acl$;
