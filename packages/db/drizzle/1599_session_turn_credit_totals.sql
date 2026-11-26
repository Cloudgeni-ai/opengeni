-- deployment-mode: rolling
-- Running per-turn credit totals, so writing a turn's terminal event no longer
-- re-reads every model call of the turn.
--
-- attach_session_turn_credit_usage_v1 (1497, bounded by 1514) adds `usage` to
-- turn.completed/failed/cancelled/superseded. It summed, on every terminal
-- insert, each agent.model.usage event of the turn (and fenced attempts'
-- turn.event.rejected_late audits of them), each `.cost`/`.refund` usage row,
-- and a ledger probe per call without recorded charges. Every row costs a heap
-- fetch plus a per-row session-visibility check under runtime RLS, so a long
-- turn paid thousands of buffers at its end (production: 80 ms mean, 38 s max,
-- about 51k buffers per terminal insert).
--
-- Now the turn's records keep two small rows in session_turn_credit_totals
-- (`events`, kept by session_events writers; `usage`, kept by usage_events
-- writers, so the two writer families never wait on one shared row) and one
-- row per model call in session_turn_credit_calls (what decides the call's
-- price: its first recorded usage by sequence, and the largest model.cost
-- row). The triggers apply every change's exact delta in the writer's own
-- transaction:
--   * session_events BEFORE INSERT, row level: a BEFORE trigger is what the
--     terminal trigger can see, because a statement's earlier rows are visible
--     to its later rows' BEFORE triggers and its later rows are not. Inserts
--     here never skip rows after BEFORE triggers (no ON CONFLICT writer), and
--     the name sorts after the sequence/source-key fill triggers.
--   * usage_events AFTER INSERT, row level (fires only for rows an
--     ON CONFLICT DO NOTHING actually inserted).
--   * session_turns AFTER INSERT: a turn created from now on starts with
--     ready rows, since all its records come later.
--   * an UPDATE or DELETE of a counted row, which no writer issues today,
--     marks the turn inexact (permanently recounted), and a TRUNCATE of
--     either source table clears every kept row.
-- Probes that depend on rows outside the turn's own records stay live at
-- terminal time, exactly as before: the own-key fee ledger row of a call
-- without recorded charges and the hosted-search usage row of a call that
-- owes one, from session_turn_credit_calls' probe index. A turn with a
-- `.refund` usage row (its ledger row decides the amount) is recounted.
--
-- Readers: the terminal trigger uses the kept rows when both are ready and
-- exact (session_turn_credit_usage_kept_v1) and otherwise the previous full
-- sum, unchanged (session_turn_credit_usage_full_v1, 1514's query). The two
-- give the same `usage` for every turn; a sampled worker check compares them
-- (opengeni_session_turn_credit_totals_mismatched_turns).
--
-- Rollout: a turn that existed before this migration gets not-ready rows on
-- its first later change (deltas apply from then on); 1600 completes them
-- online, one turn per transaction. A pre-existing turn with no later change
-- has no rows and keeps the full sum.
--
-- Locks: a writer locks its side's totals row, then the call row. Session
-- event writers already serialize per session on the event cursor, so the
-- events row adds no wait for them; usage writers of one turn now serialize
-- on the usage row until commit. The only new cross-family edge is the call
-- row of one model call, whose usage event commits before its settlement.
--
-- Nobody sets a total directly: every routine is SECURITY INVOKER with a
-- pinned search_path (a definer trigger needs an earlier binary's contract),
-- the runtime's INSERT and UPDATE policies admit its own account's rows only
-- from inside a trigger (pg_trigger_depth() > 0), and the owner policy serves
-- foreign-key cascades and the backfill.
--
-- Rolling: new FORCE RLS tables (runtime SELECT, INSERT, UPDATE), invoker
-- routines and triggers. The previous release writes the same records and
-- keeps the totals current through the triggers; the replaced terminal
-- function returns the same `usage`.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE session_turn_credit_totals (
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  -- 'events': kept by session_events writers; 'usage': by usage_events writers.
  side text NOT NULL CHECK (side IN ('events', 'usage')),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  -- Holds the turn's whole records (new turns; 1600 for earlier ones).
  ready boolean NOT NULL DEFAULT false,
  -- False once a counted row was updated or deleted: recount from then on.
  exact boolean NOT NULL DEFAULT true,
  -- Calls with no price (credits are then unknown, never a false 0).
  unpriced_calls bigint NOT NULL DEFAULT 0,
  -- Calls whose fee or owed hosted search is probed at terminal time.
  probe_calls bigint NOT NULL DEFAULT 0,
  model_micros numeric NOT NULL DEFAULT 0,
  -- Own-key platform fees recorded with the call's charges.
  fee_micros numeric NOT NULL DEFAULT 0,
  input_tokens numeric NOT NULL DEFAULT 0,
  output_tokens numeric NOT NULL DEFAULT 0,
  web_search_micros numeric NOT NULL DEFAULT 0,
  image_generation_micros numeric NOT NULL DEFAULT 0,
  other_micros numeric NOT NULL DEFAULT 0,
  -- `.refund` usage rows: their ledger row decides the amount, so recount.
  refund_rows bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, side)
);
COMMENT ON TABLE session_turn_credit_totals IS
  'Running per-turn credit sums behind terminal turn usage, kept exact by triggers on session_events and usage_events (1599); readers recount a turn whose rows are not ready and exact.';
-- The 1600 backfill's queue and the sampled drift check.
CREATE INDEX session_turn_credit_totals_pending_idx ON session_turn_credit_totals (turn_id)
  WHERE side = 'events' AND NOT ready AND exact;
CREATE INDEX session_turn_credit_totals_account_idx ON session_turn_credit_totals (account_id, turn_id)
  WHERE side = 'events';

CREATE TABLE session_turn_credit_calls (
  turn_id uuid NOT NULL REFERENCES session_turns(id) ON DELETE CASCADE,
  -- turn_id || ':' || sourceKey for a recorded call; a model.cost row's
  -- source_resource_id otherwise.
  source_id text NOT NULL,
  account_id uuid NOT NULL,
  -- The first recorded usage of the call, by session sequence; null until one.
  call_sequence integer,
  has_settlement boolean,
  charges_credits boolean,
  settlement_credit_micros numeric,
  settlement_fee_micros numeric,
  priced_micros numeric,
  hosted_credit_micros numeric,
  input_tokens numeric NOT NULL DEFAULT 0,
  output_tokens numeric NOT NULL DEFAULT 0,
  -- A model.cost usage row exists; charged is the largest one.
  has_cost boolean NOT NULL DEFAULT false,
  charged_micros numeric,
  PRIMARY KEY (turn_id, source_id)
);
COMMENT ON TABLE session_turn_credit_calls IS
  'Per model call state behind session_turn_credit_totals (1599): the first recorded usage and the largest model.cost row.';
CREATE INDEX session_turn_credit_calls_probe_idx ON session_turn_credit_calls (turn_id)
  WHERE ((call_sequence IS NOT NULL OR has_cost) AND has_settlement IS NOT TRUE)
    OR hosted_credit_micros IS NOT NULL;

ALTER TABLE session_turn_credit_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_turn_credit_totals FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turn_credit_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_turn_credit_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY session_turn_credit_totals_account_read ON session_turn_credit_totals
  FOR SELECT USING (account_id = opengeni_private.current_account_id());
CREATE POLICY session_turn_credit_totals_trigger_insert ON session_turn_credit_totals
  FOR INSERT WITH CHECK (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0);
CREATE POLICY session_turn_credit_totals_trigger_update ON session_turn_credit_totals
  FOR UPDATE USING (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0)
  WITH CHECK (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0);
CREATE POLICY session_turn_credit_calls_account_read ON session_turn_credit_calls
  FOR SELECT USING (account_id = opengeni_private.current_account_id());
CREATE POLICY session_turn_credit_calls_trigger_insert ON session_turn_credit_calls
  FOR INSERT WITH CHECK (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0);
CREATE POLICY session_turn_credit_calls_trigger_update ON session_turn_credit_calls
  FOR UPDATE USING (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0)
  WITH CHECK (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0);
REVOKE ALL ON TABLE session_turn_credit_totals FROM PUBLIC;
REVOKE ALL ON TABLE session_turn_credit_calls FROM PUBLIC;

DO $session_turn_credit_totals$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  -- Cascades from session_turns, owner writes and the 1600 backfill.
  EXECUTE format(
    'CREATE POLICY session_turn_credit_totals_owner ON %1$I.session_turn_credit_totals '
    'TO %2$I USING (CURRENT_USER = %3$L::name) WITH CHECK (CURRENT_USER = %3$L::name)',
    data_schema, owner_name, owner_name);
  EXECUTE format(
    'CREATE POLICY session_turn_credit_calls_owner ON %1$I.session_turn_credit_calls '
    'TO %2$I USING (CURRENT_USER = %3$L::name) WITH CHECK (CURRENT_USER = %3$L::name)',
    data_schema, owner_name, owner_name);

  -- What a recorded usage payload says about its call's price. The same
  -- expressions as 1514's lookup_keys/priced, so a payload of any shape gives
  -- the same terms and none raises.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_call_fields(recorded jsonb,
      OUT has_settlement boolean, OUT charges_credits boolean,
      OUT settlement_credit_micros numeric, OUT settlement_fee_micros numeric,
      OUT priced_micros numeric, OUT hosted_credit_micros numeric,
      OUT input_tokens numeric, OUT output_tokens numeric)
    LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
      SELECT settled.has_settlement,
        CASE WHEN settled.has_settlement
          THEN (recorded -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean END,
        CASE WHEN jsonb_typeof(recorded -> 'settlement' -> 'charges' -> 'creditCostMicros') = 'number'
          THEN (recorded -> 'settlement' -> 'charges' ->> 'creditCostMicros')::numeric END,
        CASE WHEN jsonb_typeof(recorded -> 'settlement' -> 'charges' -> 'byokPlatformFeeMicros') = 'number'
          THEN (recorded -> 'settlement' -> 'charges' -> 'byokPlatformFeeMicros')::numeric END,
        CASE WHEN jsonb_typeof(recorded -> 'pricedCostMicros') = 'number'
          THEN (recorded ->> 'pricedCostMicros')::numeric END,
        CASE WHEN settled.has_settlement
          AND (recorded -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
          AND jsonb_typeof(recorded -> 'settlement' -> 'charges' -> 'hostedWebSearch' -> 'creditMicros') = 'number'
          THEN (recorded -> 'settlement' -> 'charges' -> 'hostedWebSearch' ->> 'creditMicros')::numeric END,
        CASE WHEN jsonb_typeof(recorded -> 'inputTokens') = 'number'
          THEN (recorded ->> 'inputTokens')::numeric ELSE 0 END,
        CASE WHEN jsonb_typeof(recorded -> 'outputTokens') = 'number'
          THEN (recorded ->> 'outputTokens')::numeric ELSE 0 END
      FROM (SELECT coalesce(jsonb_typeof(recorded -> 'settlement') = 'object'
          AND jsonb_typeof(recorded -> 'settlement' -> 'chargesOpenGeniCredits') = 'boolean'
          AND jsonb_typeof(recorded -> 'settlement' -> 'charges') = 'object', false) AS has_settlement) settled
    $body$;
  $create$, data_schema);

  -- One call's share of the kept sums. A call exists once it has a recorded
  -- usage or a model.cost row (1514's FULL JOIN of calls and model_costs).
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_call_terms(p_call %1$I.session_turn_credit_calls,
      OUT unpriced_calls bigint, OUT probe_calls bigint, OUT model_micros numeric,
      OUT fee_micros numeric, OUT input_tokens numeric, OUT output_tokens numeric)
    LANGUAGE sql IMMUTABLE PARALLEL SAFE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
      SELECT
        CASE WHEN NOT priced.present THEN 0 WHEN priced.model_micros IS NULL THEN 1 ELSE 0 END,
        CASE WHEN priced.present AND ((p_call).has_settlement IS NOT TRUE
          OR (p_call).hosted_credit_micros IS NOT NULL) THEN 1 ELSE 0 END,
        CASE WHEN priced.present THEN coalesce(priced.model_micros, 0) ELSE 0 END,
        CASE WHEN priced.present AND (p_call).has_settlement AND NOT (p_call).charges_credits
          THEN coalesce((p_call).settlement_fee_micros, 0) ELSE 0 END,
        CASE WHEN priced.present THEN (p_call).input_tokens ELSE 0 END,
        CASE WHEN priced.present THEN (p_call).output_tokens ELSE 0 END
      FROM (SELECT ((p_call).call_sequence IS NOT NULL OR (p_call).has_cost) AS present,
          coalesce((p_call).charged_micros,
            CASE WHEN (p_call).has_settlement THEN
              CASE WHEN (p_call).charges_credits AND (p_call).settlement_credit_micros IS NOT NULL
                THEN (p_call).settlement_credit_micros
              WHEN NOT (p_call).charges_credits THEN 0 END
            END,
            (p_call).priced_micros) AS model_micros) priced
    $body$;
  $create$, data_schema);

  -- The turn's two rows, locked, for a writer of `side`: created not ready
  -- (with the turn's own scope) when the turn predates the triggers. Null
  -- when the turn is not visible here: it then has no kept rows to keep.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_totals_lock(p_turn_id uuid, p_side text)
    RETURNS %1$I.session_turn_credit_totals
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE total %1$I.session_turn_credit_totals;
    BEGIN
      SELECT * INTO total FROM %1$I.session_turn_credit_totals
      WHERE turn_id = p_turn_id AND side = p_side FOR UPDATE;
      IF FOUND THEN RETURN total; END IF;
      INSERT INTO %1$I.session_turn_credit_totals (turn_id, side, account_id, workspace_id, session_id)
      SELECT turn.id, sides.side, turn.account_id, turn.workspace_id, turn.session_id
      FROM %1$I.session_turns turn CROSS JOIN (VALUES ('events'), ('usage')) sides(side)
      WHERE turn.id = p_turn_id AND turn.account_id = opengeni_private.current_account_id()
      ORDER BY sides.side
      ON CONFLICT (turn_id, side) DO NOTHING;
      SELECT * INTO total FROM %1$I.session_turn_credit_totals
      WHERE turn_id = p_turn_id AND side = p_side FOR UPDATE;
      RETURN total;
    END $body$;
  $create$, data_schema);

  -- Changes call `p_source_id` of the turn with `p_change` (a recorded usage
  -- or a model.cost row) and adds the call's change of terms to the locked
  -- `p_side` row. The caller holds that row's lock.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_apply_call(p_turn_id uuid, p_side text,
      p_source_id text, p_account_id uuid, p_sequence integer, p_recorded jsonb, p_cost numeric)
    RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE prior %1$I.session_turn_credit_calls; next %1$I.session_turn_credit_calls;
      was record; now record; fields record;
    BEGIN
      INSERT INTO %1$I.session_turn_credit_calls (turn_id, source_id, account_id)
      VALUES (p_turn_id, p_source_id, p_account_id) ON CONFLICT (turn_id, source_id) DO NOTHING;
      SELECT * INTO prior FROM %1$I.session_turn_credit_calls
      WHERE turn_id = p_turn_id AND source_id = p_source_id FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      next := prior;
      IF p_recorded IS NOT NULL THEN
        -- 1514 counts a call's first recorded usage by sequence.
        IF prior.call_sequence IS NOT NULL AND prior.call_sequence <= p_sequence THEN RETURN; END IF;
        fields := opengeni_private.session_turn_credit_call_fields(p_recorded);
        next.call_sequence := p_sequence;
        next.has_settlement := fields.has_settlement;
        next.charges_credits := fields.charges_credits;
        next.settlement_credit_micros := fields.settlement_credit_micros;
        next.settlement_fee_micros := fields.settlement_fee_micros;
        next.priced_micros := fields.priced_micros;
        next.hosted_credit_micros := fields.hosted_credit_micros;
        next.input_tokens := fields.input_tokens;
        next.output_tokens := fields.output_tokens;
      ELSE
        IF prior.has_cost AND prior.charged_micros >= p_cost THEN RETURN; END IF;
        next.has_cost := true;
        next.charged_micros := greatest(prior.charged_micros, p_cost);
      END IF;
      UPDATE %1$I.session_turn_credit_calls SET call_sequence = next.call_sequence,
        has_settlement = next.has_settlement, charges_credits = next.charges_credits,
        settlement_credit_micros = next.settlement_credit_micros,
        settlement_fee_micros = next.settlement_fee_micros, priced_micros = next.priced_micros,
        hosted_credit_micros = next.hosted_credit_micros, input_tokens = next.input_tokens,
        output_tokens = next.output_tokens, has_cost = next.has_cost, charged_micros = next.charged_micros
      WHERE turn_id = p_turn_id AND source_id = p_source_id;
      was := opengeni_private.session_turn_credit_call_terms(prior);
      now := opengeni_private.session_turn_credit_call_terms(next);
      UPDATE %1$I.session_turn_credit_totals SET
        unpriced_calls = unpriced_calls + now.unpriced_calls - was.unpriced_calls,
        probe_calls = probe_calls + now.probe_calls - was.probe_calls,
        model_micros = model_micros + now.model_micros - was.model_micros,
        fee_micros = fee_micros + now.fee_micros - was.fee_micros,
        input_tokens = input_tokens + now.input_tokens - was.input_tokens,
        output_tokens = output_tokens + now.output_tokens - was.output_tokens
      WHERE turn_id = p_turn_id AND side = p_side;
    END $body$;
  $create$, data_schema);

  -- session_events BEFORE INSERT: a recorded model call of the turn, exactly
  -- the rows 1514 reads (its `recorded` and `calls` filters).
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_record_event() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE recorded jsonb; total %1$I.session_turn_credit_totals;
    BEGIN
      IF NEW.type = 'agent.model.usage' THEN
        IF NEW.turn_association IS NOT NULL AND NEW.turn_association <> 'current' THEN RETURN NEW; END IF;
        recorded := NEW.payload;
      ELSIF NEW.payload ->> 'rejectedType' = 'agent.model.usage' THEN
        recorded := NEW.payload -> 'rejectedPayload';
      ELSE
        RETURN NEW;
      END IF;
      IF jsonb_typeof(recorded) IS DISTINCT FROM 'object'
        OR jsonb_typeof(recorded -> 'sourceKey') IS DISTINCT FROM 'string' THEN RETURN NEW; END IF;
      total := opengeni_private.session_turn_credit_totals_lock(NEW.turn_id, 'events');
      IF total.turn_id IS NULL OR total.workspace_id IS DISTINCT FROM NEW.workspace_id
        OR total.session_id IS DISTINCT FROM NEW.session_id THEN RETURN NEW; END IF;
      PERFORM opengeni_private.session_turn_credit_apply_call(NEW.turn_id, 'events',
        NEW.turn_id::text || ':' || (recorded ->> 'sourceKey'), total.account_id, NEW.sequence, recorded, NULL);
      RETURN NEW;
    END $body$;
  $create$, data_schema);

  -- usage_events AFTER INSERT: a `.cost` or `.refund` usage row of the turn,
  -- exactly the rows 1514's turn_costs reads.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_record_usage() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE total %1$I.session_turn_credit_totals;
    BEGIN
      total := opengeni_private.session_turn_credit_totals_lock(NEW.turn_id, 'usage');
      IF total.turn_id IS NULL OR total.workspace_id IS DISTINCT FROM NEW.workspace_id
        OR total.session_id IS DISTINCT FROM NEW.session_id THEN RETURN NULL; END IF;
      IF NEW.event_type LIKE '%%.refund' THEN
        UPDATE %1$I.session_turn_credit_totals SET refund_rows = refund_rows + 1
        WHERE turn_id = NEW.turn_id AND side = 'usage';
      ELSIF NEW.event_type = 'model.cost' THEN
        IF NEW.source_resource_id IS NOT NULL THEN
          PERFORM opengeni_private.session_turn_credit_apply_call(NEW.turn_id, 'usage',
            NEW.source_resource_id, total.account_id, NULL, NULL, NEW.quantity::numeric);
        END IF;
      ELSE
        UPDATE %1$I.session_turn_credit_totals SET
          web_search_micros = web_search_micros
            + CASE WHEN NEW.event_type = 'web_search.cost' THEN NEW.quantity ELSE 0 END,
          image_generation_micros = image_generation_micros
            + CASE WHEN NEW.event_type = 'image_generation.cost' THEN NEW.quantity ELSE 0 END,
          other_micros = other_micros
            + CASE WHEN NEW.event_type IN ('web_search.cost', 'image_generation.cost') THEN 0 ELSE NEW.quantity END
        WHERE turn_id = NEW.turn_id AND side = 'usage';
      END IF;
      RETURN NULL;
    END $body$;
  $create$, data_schema);

  -- A new turn: its records come later (nothing references turn_id with a
  -- foreign key, so check), and its rows start ready. A turn with records
  -- written before it (skipped then: no turn to keep) starts not ready and
  -- keeps the full sum.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_start_turn() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE earlier boolean;
    BEGIN
      -- A writer outside the turn's account scope cannot keep its rows; the
      -- turn then has none and is recounted.
      IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
        AND CURRENT_USER <> %2$L::name THEN RETURN NULL; END IF;
      earlier := EXISTS (SELECT 1 FROM %1$I.session_events e
          WHERE e.workspace_id = NEW.workspace_id AND e.turn_id = NEW.id
            AND e.type IN ('agent.model.usage', 'turn.event.rejected_late'))
        OR EXISTS (SELECT 1 FROM %1$I.usage_events u
          WHERE u.workspace_id = NEW.workspace_id AND u.turn_id = NEW.id);
      INSERT INTO %1$I.session_turn_credit_totals (turn_id, side, account_id, workspace_id, session_id, ready)
      VALUES (NEW.id, 'events', NEW.account_id, NEW.workspace_id, NEW.session_id, NOT earlier),
        (NEW.id, 'usage', NEW.account_id, NEW.workspace_id, NEW.session_id, NOT earlier)
      ON CONFLICT (turn_id, side) DO NOTHING;
      RETURN NULL;
    END $body$;
  $create$, data_schema, owner_name);

  -- An update or delete of a counted row: no exact delta, so recount the turn.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_mark_inexact() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    BEGIN
      UPDATE %1$I.session_turn_credit_totals SET exact = false, ready = false
      WHERE turn_id IN (OLD.turn_id, CASE WHEN TG_OP = 'UPDATE' THEN NEW.turn_id END) AND exact;
      RETURN NULL;
    END $body$;
  $create$, data_schema);

  -- A TRUNCATE of a source: no kept row holds its sums any more.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.clear_session_turn_credit_totals() RETURNS trigger
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    BEGIN
      DELETE FROM %1$I.session_turn_credit_calls;
      DELETE FROM %1$I.session_turn_credit_totals;
      RETURN NULL;
    END $body$;
  $create$, data_schema);

  -- 1514's terminal sum, unchanged, as a function of the turn: the fallback
  -- for a turn without ready, exact kept rows and the drift check's recount.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_usage_full_v1(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE usage_value jsonb;
    BEGIN
      WITH recorded AS (
        SELECT e.sequence,
          CASE WHEN e.type = 'agent.model.usage' THEN e.payload ELSE e.payload -> 'rejectedPayload' END AS payload
        FROM session_events e
        WHERE e.workspace_id = p_workspace_id AND e.turn_id = p_turn_id AND e.session_id = p_session_id
          AND ((e.type = 'agent.model.usage'
              AND (e.turn_association IS NULL OR e.turn_association = 'current'))
            OR (e.type = 'turn.event.rejected_late' AND e.payload ->> 'rejectedType' = 'agent.model.usage'))
      ),
      calls AS (
        SELECT DISTINCT ON (payload ->> 'sourceKey')
          p_turn_id::text || ':' || (payload ->> 'sourceKey') AS source_id, payload
        FROM recorded
        WHERE jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'sourceKey') = 'string'
        ORDER BY payload ->> 'sourceKey', sequence
      ),
      turn_costs AS MATERIALIZED (
        SELECT u.event_type, u.source_resource_id, u.quantity,
          CASE WHEN u.event_type LIKE '%%.refund'
            THEN 'credit:' || replace(u.event_type, '.', '_') || ':' || u.source_resource_id
          END AS refund_key
        FROM usage_events u
        WHERE u.workspace_id = p_workspace_id AND u.turn_id = p_turn_id AND u.session_id = p_session_id
          AND u.unit = 'usd_micros'
          AND (u.event_type LIKE '%%.cost' OR (u.event_type LIKE '%%.refund' AND u.event_type <> 'model.refund'))
      ),
      costs AS (
        SELECT
          CASE WHEN u.event_type LIKE '%%.refund'
            THEN left(u.event_type, length(u.event_type) - length('.refund')) || '.cost'
            ELSE u.event_type END AS event_type,
          u.source_resource_id,
          CASE WHEN u.event_type LIKE '%%.refund' THEN -coalesce((
              SELECT l.amount_micros::numeric FROM credit_ledger_entries l
              WHERE l.idempotency_key = u.refund_key
                AND l.account_id = p_account_id AND l.amount_micros >= 0
            ), u.quantity::numeric)
          ELSE u.quantity::numeric END AS quantity
        FROM turn_costs u
      ),
      model_costs AS (
        SELECT source_resource_id, max(quantity) AS quantity FROM costs
        WHERE event_type = 'model.cost' AND source_resource_id IS NOT NULL
        GROUP BY source_resource_id
      ),
      model_calls AS (
        SELECT coalesce(c.source_id, m.source_resource_id) AS source_id, c.payload,
          m.quantity AS charged,
          (jsonb_typeof(c.payload -> 'settlement') = 'object'
            AND jsonb_typeof(c.payload -> 'settlement' -> 'chargesOpenGeniCredits') = 'boolean'
            AND jsonb_typeof(c.payload -> 'settlement' -> 'charges') = 'object') AS has_settlement
        FROM calls c FULL JOIN model_costs m ON m.source_resource_id = c.source_id
      ),
      lookup_keys AS MATERIALIZED (
        SELECT mc.payload, mc.charged, mc.has_settlement,
          CASE WHEN mc.has_settlement IS NOT TRUE
            THEN 'credit:byok_platform_fee:' || mc.source_id END AS fee_key,
          CASE WHEN mc.has_settlement
            AND (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
            AND jsonb_typeof(mc.payload -> 'settlement' -> 'charges' -> 'hostedWebSearch' -> 'creditMicros') = 'number'
            THEN 'usage:web_search.cost:hosted:' || mc.source_id END AS hosted_search_key
        FROM model_calls mc
      ),
      priced AS (
        SELECT
          coalesce(
            mc.charged,
            CASE WHEN mc.has_settlement THEN
              CASE WHEN (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
                AND jsonb_typeof(mc.payload -> 'settlement' -> 'charges' -> 'creditCostMicros') = 'number'
              THEN (mc.payload -> 'settlement' -> 'charges' ->> 'creditCostMicros')::numeric
              WHEN NOT (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean THEN 0
              END
            END,
            CASE WHEN jsonb_typeof(mc.payload -> 'pricedCostMicros') = 'number'
              THEN (mc.payload ->> 'pricedCostMicros')::numeric END
          ) AS model_micros,
          CASE
            WHEN mc.has_settlement THEN
              CASE WHEN NOT (mc.payload -> 'settlement' ->> 'chargesOpenGeniCredits')::boolean
                AND jsonb_typeof(mc.payload -> 'settlement' -> 'charges' -> 'byokPlatformFeeMicros') = 'number'
              THEN (mc.payload -> 'settlement' -> 'charges' -> 'byokPlatformFeeMicros')::numeric ELSE 0 END
            ELSE coalesce((
              SELECT -l.amount_micros::numeric FROM credit_ledger_entries l
              WHERE l.idempotency_key = mc.fee_key
                AND l.account_id = p_account_id AND l.amount_micros < 0
            ), 0)
          END AS fee_micros,
          CASE WHEN mc.hosted_search_key IS NOT NULL THEN
            CASE WHEN (
              SELECT true FROM usage_events hosted
              WHERE hosted.idempotency_key = mc.hosted_search_key
            ) IS NULL THEN (mc.payload -> 'settlement' -> 'charges' -> 'hostedWebSearch' ->> 'creditMicros')::numeric
            ELSE 0 END
          ELSE 0 END AS owed_search_micros,
          CASE WHEN jsonb_typeof(mc.payload -> 'inputTokens') = 'number'
            THEN (mc.payload ->> 'inputTokens')::numeric ELSE 0 END AS input_tokens,
          CASE WHEN jsonb_typeof(mc.payload -> 'outputTokens') = 'number'
            THEN (mc.payload ->> 'outputTokens')::numeric ELSE 0 END AS output_tokens
        FROM lookup_keys mc
      ),
      totals AS (
        SELECT
          bool_or(model_micros IS NULL) AS unpriced,
          coalesce(sum(model_micros), 0) AS model,
          coalesce(sum(fee_micros), 0) AS fees,
          coalesce(sum(owed_search_micros), 0) AS owed_search,
          coalesce(sum(input_tokens), 0) AS input_tokens,
          coalesce(sum(output_tokens), 0) AS output_tokens
        FROM priced
      ),
      tools AS (
        SELECT
          greatest(coalesce(sum(quantity) FILTER (WHERE event_type = 'web_search.cost'), 0), 0) AS web_search,
          greatest(coalesce(sum(quantity) FILTER (WHERE event_type = 'image_generation.cost'), 0), 0) AS image_generation,
          greatest(coalesce(sum(quantity) FILTER (
            WHERE event_type NOT IN ('model.cost', 'web_search.cost', 'image_generation.cost')
          ), 0), 0) AS other
        FROM costs
      )
      SELECT jsonb_build_object(
        'creditsMicros', CASE WHEN coalesce(t.unpriced, false) THEN NULL
          ELSE (t.model + tools.web_search + t.owed_search + tools.image_generation + tools.other + t.fees)::bigint END,
        'tokens', jsonb_build_object('input', t.input_tokens::bigint, 'output', t.output_tokens::bigint),
        'breakdown', jsonb_build_object(
          'model', t.model::bigint,
          'webSearch', (tools.web_search + t.owed_search)::bigint,
          'imageGeneration', tools.image_generation::bigint,
          'other', (tools.other + t.fees)::bigint
        )
      ) INTO usage_value
      FROM totals t CROSS JOIN tools;
      RETURN usage_value;
    END $body$;
  $create$, data_schema);

  -- The 1600 backfill's recount of one not-ready turn, as the owner in the
  -- turn's tenant scope. It locks the events row (waiting for its writer),
  -- then the usage row without waiting (a writer of both families could hold
  -- it and wait for the events row; the backfill then retries the turn), so
  -- no writer of the turn runs until commit. Each statement after the locks
  -- reads a snapshot that holds every committed record of the turn, rebuilds
  -- its call rows and returns the absolute sums: the events side gets every
  -- call's terms, the usage side the tool sums. `locked` without `counted`:
  -- the turn is not visible here (or lost a row) and is left to the full sum.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_totals_recount(p_turn_id uuid,
      OUT locked boolean, OUT counted boolean, OUT unpriced_calls bigint, OUT probe_calls bigint,
      OUT model_micros numeric, OUT fee_micros numeric, OUT input_tokens numeric,
      OUT output_tokens numeric, OUT web_search_micros numeric,
      OUT image_generation_micros numeric, OUT other_micros numeric, OUT refund_rows bigint)
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE scope %1$I.session_turn_credit_totals;
    BEGIN
      locked := false;
      counted := false;
      SELECT * INTO scope FROM %1$I.session_turn_credit_totals
      WHERE turn_id = p_turn_id AND side = 'events' AND NOT ready AND exact FOR UPDATE;
      IF NOT FOUND THEN RETURN; END IF;
      PERFORM 1 FROM %1$I.session_turn_credit_totals
      WHERE turn_id = p_turn_id AND side = 'usage' FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        -- Busy: retried. Missing: left to the full sum.
        locked := NOT EXISTS (SELECT 1 FROM %1$I.session_turn_credit_totals
          WHERE turn_id = p_turn_id AND side = 'usage');
        RETURN;
      END IF;
      locked := true;
      IF NOT EXISTS (SELECT 1 FROM %1$I.session_turns turn WHERE turn.id = p_turn_id
          AND turn.session_id = scope.session_id AND turn.workspace_id = scope.workspace_id
          AND turn.account_id = scope.account_id) THEN
        RETURN;
      END IF;
      DELETE FROM %1$I.session_turn_credit_calls WHERE turn_id = p_turn_id;
      WITH recorded AS (
        SELECT e.sequence,
          CASE WHEN e.type = 'agent.model.usage' THEN e.payload ELSE e.payload -> 'rejectedPayload' END AS payload
        FROM %1$I.session_events e
        WHERE e.workspace_id = scope.workspace_id AND e.turn_id = p_turn_id AND e.session_id = scope.session_id
          AND ((e.type = 'agent.model.usage'
              AND (e.turn_association IS NULL OR e.turn_association = 'current'))
            OR (e.type = 'turn.event.rejected_late' AND e.payload ->> 'rejectedType' = 'agent.model.usage'))
      ),
      calls AS (
        SELECT DISTINCT ON (payload ->> 'sourceKey')
          p_turn_id::text || ':' || (payload ->> 'sourceKey') AS source_id, sequence, payload
        FROM recorded
        WHERE jsonb_typeof(payload) = 'object' AND jsonb_typeof(payload -> 'sourceKey') = 'string'
        ORDER BY payload ->> 'sourceKey', sequence
      ),
      model_costs AS (
        SELECT u.source_resource_id, max(u.quantity::numeric) AS quantity
        FROM %1$I.usage_events u
        WHERE u.workspace_id = scope.workspace_id AND u.turn_id = p_turn_id AND u.session_id = scope.session_id
          AND u.unit = 'usd_micros' AND u.event_type = 'model.cost' AND u.source_resource_id IS NOT NULL
        GROUP BY u.source_resource_id
      )
      INSERT INTO %1$I.session_turn_credit_calls (turn_id, source_id, account_id, call_sequence,
        has_settlement, charges_credits, settlement_credit_micros, settlement_fee_micros,
        priced_micros, hosted_credit_micros, input_tokens, output_tokens, has_cost, charged_micros)
      SELECT p_turn_id, coalesce(c.source_id, m.source_resource_id), scope.account_id, c.sequence,
        f.has_settlement, f.charges_credits, f.settlement_credit_micros, f.settlement_fee_micros,
        f.priced_micros, f.hosted_credit_micros, coalesce(f.input_tokens, 0), coalesce(f.output_tokens, 0),
        m.source_resource_id IS NOT NULL, m.quantity
      FROM calls c
      FULL JOIN model_costs m ON m.source_resource_id = c.source_id
      LEFT JOIN LATERAL opengeni_private.session_turn_credit_call_fields(c.payload) f ON c.payload IS NOT NULL;
      SELECT coalesce(sum(terms.unpriced_calls), 0), coalesce(sum(terms.probe_calls), 0),
        coalesce(sum(terms.model_micros), 0), coalesce(sum(terms.fee_micros), 0),
        coalesce(sum(terms.input_tokens), 0), coalesce(sum(terms.output_tokens), 0)
      INTO unpriced_calls, probe_calls, model_micros, fee_micros, input_tokens, output_tokens
      FROM %1$I.session_turn_credit_calls kc
      CROSS JOIN LATERAL opengeni_private.session_turn_credit_call_terms(kc) terms
      WHERE kc.turn_id = p_turn_id;
      SELECT coalesce(sum(u.quantity) FILTER (WHERE u.event_type = 'web_search.cost'), 0),
        coalesce(sum(u.quantity) FILTER (WHERE u.event_type = 'image_generation.cost'), 0),
        coalesce(sum(u.quantity) FILTER (WHERE u.event_type LIKE '%%.cost'
          AND u.event_type NOT IN ('model.cost', 'web_search.cost', 'image_generation.cost')), 0),
        count(*) FILTER (WHERE u.event_type LIKE '%%.refund' AND u.event_type <> 'model.refund')
      INTO web_search_micros, image_generation_micros, other_micros, refund_rows
      FROM %1$I.usage_events u
      WHERE u.workspace_id = scope.workspace_id AND u.turn_id = p_turn_id AND u.session_id = scope.session_id
        AND u.unit = 'usd_micros';
      counted := true;
    END $body$;
  $create$, data_schema);

  -- The same `usage` from the kept rows, or null when the turn has no ready,
  -- exact rows (or a refund row) and must be recounted. The fee and owed
  -- hosted-search probes read exactly what 1514 reads, for only those calls.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_turn_credit_usage_kept_v1(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid)
    RETURNS jsonb
    LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE kept record; probed_fees numeric := 0; probed_search numeric := 0;
    BEGIN
      SELECT count(*) AS sides, bool_and(total.ready AND total.exact) AS usable,
        bool_and(total.account_id = p_account_id AND total.workspace_id = p_workspace_id
          AND total.session_id = p_session_id) AS same_turn,
        sum(total.refund_rows) AS refund_rows, sum(total.unpriced_calls) AS unpriced_calls,
        sum(total.probe_calls) AS probe_calls, sum(total.model_micros) AS model,
        sum(total.fee_micros) AS fees, sum(total.input_tokens) AS input_tokens,
        sum(total.output_tokens) AS output_tokens,
        greatest(sum(total.web_search_micros), 0) AS web_search,
        greatest(sum(total.image_generation_micros), 0) AS image_generation,
        greatest(sum(total.other_micros), 0) AS other
      INTO kept
      FROM session_turn_credit_totals total WHERE total.turn_id = p_turn_id;
      IF kept.sides <> 2 OR NOT kept.usable OR NOT kept.same_turn OR kept.refund_rows <> 0 THEN
        RETURN NULL;
      END IF;
      IF kept.probe_calls > 0 THEN
        -- Materialize the lookup key before probing under RLS (as 1514).
        WITH lookup_keys AS MATERIALIZED (
          SELECT kc.hosted_credit_micros,
            CASE WHEN kc.has_settlement IS NOT TRUE
              THEN 'credit:byok_platform_fee:' || kc.source_id END AS fee_key,
            CASE WHEN kc.hosted_credit_micros IS NOT NULL
              THEN 'usage:web_search.cost:hosted:' || kc.source_id END AS hosted_search_key
          FROM session_turn_credit_calls kc
          WHERE kc.turn_id = p_turn_id
            AND (((kc.call_sequence IS NOT NULL OR kc.has_cost) AND kc.has_settlement IS NOT TRUE)
              OR kc.hosted_credit_micros IS NOT NULL)
        )
        SELECT
          coalesce(sum(CASE WHEN keys.fee_key IS NOT NULL THEN coalesce((
              SELECT -l.amount_micros::numeric FROM credit_ledger_entries l
              WHERE l.idempotency_key = keys.fee_key
                AND l.account_id = p_account_id AND l.amount_micros < 0
            ), 0) ELSE 0 END), 0),
          coalesce(sum(CASE WHEN keys.hosted_search_key IS NOT NULL THEN
            CASE WHEN (
              SELECT true FROM usage_events hosted
              WHERE hosted.idempotency_key = keys.hosted_search_key
            ) IS NULL THEN keys.hosted_credit_micros ELSE 0 END
          ELSE 0 END), 0)
        INTO probed_fees, probed_search
        FROM lookup_keys keys;
      END IF;
      RETURN jsonb_build_object(
        'creditsMicros', CASE WHEN kept.unpriced_calls > 0 THEN NULL
          ELSE (kept.model + kept.web_search + probed_search + kept.image_generation + kept.other
            + kept.fees + probed_fees)::bigint END,
        'tokens', jsonb_build_object('input', kept.input_tokens::bigint, 'output', kept.output_tokens::bigint),
        'breakdown', jsonb_build_object(
          'model', kept.model::bigint,
          'webSearch', (kept.web_search + probed_search)::bigint,
          'imageGeneration', kept.image_generation::bigint,
          'other', (kept.other + kept.fees + probed_fees)::bigint
        )
      );
    END $body$;
  $create$, data_schema);

  -- The terminal trigger: same scope rules and failure handling as 1514; the
  -- kept rows when they hold the turn, else the full sum.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.attach_session_turn_credit_usage_v1()
    RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp
    AS $attach$
    DECLARE usage_value jsonb;
    BEGIN
      IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' THEN RETURN NEW; END IF;
      IF NEW.account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR NEW.workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR NOT EXISTS (
          SELECT 1 FROM session_turns
          WHERE id = NEW.turn_id AND session_id = NEW.session_id AND workspace_id = NEW.workspace_id
        )
      THEN RETURN NEW; END IF;
      BEGIN
        usage_value := opengeni_private.session_turn_credit_usage_kept_v1(
          NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id);
        IF usage_value IS NULL THEN
          usage_value := opengeni_private.session_turn_credit_usage_full_v1(
            NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'turn %% credit usage was not attached (SQLSTATE %%)', NEW.turn_id, SQLSTATE;
        usage_value := NULL;
      END;
      IF usage_value IS NOT NULL THEN
        NEW.payload := NEW.payload || jsonb_build_object('usage', usage_value);
      END IF;
      RETURN NEW;
    END $attach$;
  $create$, data_schema);
END $session_turn_credit_totals$;

-- The backfill (1600) and the cascade clear run as the owner; the runtime
-- reaches every routine through the triggers and the two readers.
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_call_fields(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_call_terms(session_turn_credit_calls) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_totals_lock(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_apply_call(uuid, text, text, uuid, integer, jsonb, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_record_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_record_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_start_turn() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_mark_inexact() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.clear_session_turn_credit_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_usage_full_v1(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_usage_kept_v1(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_turn_credit_totals_recount(uuid) FROM PUBLIC;

-- Sorts after session_events_fill_* and session_events_normalize_legacy_*:
-- the row's sequence and payload are final when it runs.
CREATE TRIGGER session_events_turn_credit_totals_v1 BEFORE INSERT ON session_events
  FOR EACH ROW WHEN (NEW.turn_id IS NOT NULL
    AND NEW.type IN ('agent.model.usage', 'turn.event.rejected_late'))
  EXECUTE FUNCTION opengeni_private.session_turn_credit_record_event();
CREATE TRIGGER session_events_turn_credit_totals_inexact_v1 AFTER UPDATE ON session_events
  FOR EACH ROW WHEN ((OLD.turn_id IS NOT NULL OR NEW.turn_id IS NOT NULL)
    AND (OLD.type IN ('agent.model.usage', 'turn.event.rejected_late')
      OR NEW.type IN ('agent.model.usage', 'turn.event.rejected_late'))
    AND (OLD.type, OLD.payload, OLD.turn_id, OLD.session_id, OLD.workspace_id, OLD.sequence, OLD.turn_association)
      IS DISTINCT FROM (NEW.type, NEW.payload, NEW.turn_id, NEW.session_id, NEW.workspace_id, NEW.sequence, NEW.turn_association))
  EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
CREATE TRIGGER session_events_turn_credit_totals_delete_v1 AFTER DELETE ON session_events
  FOR EACH ROW WHEN (OLD.turn_id IS NOT NULL
    AND OLD.type IN ('agent.model.usage', 'turn.event.rejected_late'))
  EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
CREATE TRIGGER session_events_turn_credit_totals_truncate_v1 AFTER TRUNCATE ON session_events
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.clear_session_turn_credit_totals();

CREATE TRIGGER usage_events_turn_credit_totals_v1 AFTER INSERT ON usage_events
  FOR EACH ROW WHEN (NEW.turn_id IS NOT NULL AND NEW.unit = 'usd_micros'
    AND (NEW.event_type LIKE '%.cost' OR (NEW.event_type LIKE '%.refund' AND NEW.event_type <> 'model.refund')))
  EXECUTE FUNCTION opengeni_private.session_turn_credit_record_usage();
CREATE TRIGGER usage_events_turn_credit_totals_inexact_v1 AFTER UPDATE ON usage_events
  FOR EACH ROW WHEN ((OLD.turn_id IS NOT NULL OR NEW.turn_id IS NOT NULL)
    AND (OLD.turn_id, OLD.session_id, OLD.workspace_id, OLD.event_type, OLD.unit, OLD.quantity, OLD.source_resource_id)
      IS DISTINCT FROM (NEW.turn_id, NEW.session_id, NEW.workspace_id, NEW.event_type, NEW.unit, NEW.quantity, NEW.source_resource_id))
  EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
CREATE TRIGGER usage_events_turn_credit_totals_delete_v1 AFTER DELETE ON usage_events
  FOR EACH ROW WHEN (OLD.turn_id IS NOT NULL AND OLD.unit = 'usd_micros')
  EXECUTE FUNCTION opengeni_private.session_turn_credit_mark_inexact();
CREATE TRIGGER usage_events_turn_credit_totals_truncate_v1 AFTER TRUNCATE ON usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.clear_session_turn_credit_totals();

CREATE TRIGGER session_turns_credit_totals_start_v1 AFTER INSERT ON session_turns
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_turn_credit_start_turn();

-- Every configured application role, as provisioning does. INSERT and UPDATE
-- serve only the invoker triggers (the policies admit nothing else).
DO $session_turn_credit_totals_grant$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE session_turn_credit_totals, session_turn_credit_calls FROM %I',
      application_role);
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE session_turn_credit_totals, session_turn_credit_calls TO %I',
      application_role);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION '
      'opengeni_private.session_turn_credit_call_fields(jsonb), '
      'opengeni_private.session_turn_credit_call_terms(session_turn_credit_calls), '
      'opengeni_private.session_turn_credit_totals_lock(uuid, text), '
      'opengeni_private.session_turn_credit_apply_call(uuid, text, text, uuid, integer, jsonb, numeric), '
      'opengeni_private.session_turn_credit_usage_full_v1(uuid, uuid, uuid, uuid), '
      'opengeni_private.session_turn_credit_usage_kept_v1(uuid, uuid, uuid, uuid) TO %I', application_role);
  END LOOP;
END $session_turn_credit_totals_grant$;
