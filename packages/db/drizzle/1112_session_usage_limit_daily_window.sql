-- deployment-mode: rolling
-- A task usage limit can recur: with a window (`period: "day"` in an IANA
-- time zone) the limit applies to the usage recorded since the current
-- window started, and a new window reopens admission. Without a window the
-- limit is the lifetime total, exactly as before.
--
-- The root keeps a second counter for the current window. A trigger rolls it
-- whenever the lifetime counter grows, so every writer (live settlement,
-- custody fill, the old-writer event trigger) feeds it unchanged. Admission
-- still reads one row. Setting a window starts the counter from the receipts
-- already recorded in the current window.
--
-- The previous release never sets a window; its writes send no `window` key,
-- which keeps the current window, and its reads ignore the new state field.
SET LOCAL lock_timeout = '5s';

ALTER TABLE opengeni_private.session_usage_limit_roots
  ADD COLUMN IF NOT EXISTS window_period text,
  ADD COLUMN IF NOT EXISTS window_time_zone text,
  ADD COLUMN IF NOT EXISTS window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS window_known_micros bigint NOT NULL DEFAULT 0;
ALTER TABLE opengeni_private.session_usage_limit_config_receipts
  ADD COLUMN IF NOT EXISTS window_period text,
  ADD COLUMN IF NOT EXISTS window_time_zone text;

CREATE OR REPLACE FUNCTION opengeni_private.session_usage_limit_roll_window()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  window_start timestamptz := date_trunc('day', clock_timestamp() AT TIME ZONE NEW.window_time_zone)
    AT TIME ZONE NEW.window_time_zone;
BEGIN
  IF NEW.window_started_at IS NULL OR NEW.window_started_at < window_start THEN
    NEW.window_started_at := window_start;
    NEW.window_known_micros := NEW.known_micros - OLD.known_micros;
  ELSE
    NEW.window_known_micros := NEW.window_known_micros + (NEW.known_micros - OLD.known_micros);
  END IF;
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.session_usage_limit_roll_window() FROM PUBLIC;

DROP TRIGGER IF EXISTS session_usage_limit_window ON opengeni_private.session_usage_limit_roots;
CREATE TRIGGER session_usage_limit_window
  BEFORE UPDATE OF known_micros ON opengeni_private.session_usage_limit_roots
  FOR EACH ROW WHEN (NEW.window_period IS NOT NULL AND NEW.known_micros > OLD.known_micros)
  EXECUTE FUNCTION opengeni_private.session_usage_limit_roll_window();

-- The state a reader and admission see: with a window, `usedMicros` is the
-- current window's usage (zero once the window has passed) and `window`
-- names its bounds. Without one, the projection is unchanged.
DO $state$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION %1$I.session_usage_limit_state(p_root_json jsonb, p_inherited boolean)
    RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
  SELECT jsonb_build_object(
    'basis','model_api_equivalent_v1',
    'rootSessionId',p_root.root_session_id,
    'inherited',p_inherited,
    'status',CASE WHEN p_root.history_state='preparing' THEN 'preparing'
      WHEN p_root.limit_micros IS NULL THEN 'unlimited'
      WHEN used.micros >= p_root.limit_micros THEN 'reached'
      ELSE 'within' END,
    'limitMicros',p_root.limit_micros,
    'usedMicros',CASE WHEN p_root.history_state='preparing' THEN NULL ELSE used.micros END,
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
  || CASE WHEN p_root.window_period IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('window',
    jsonb_build_object('period',p_root.window_period,'timeZone',p_root.window_time_zone,
      'startedAt',to_char(bounds.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'resetsAt',to_char(bounds.resets_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    END
  FROM jsonb_populate_record(NULL::opengeni_private.session_usage_limit_roots, p_root_json) AS p_root
  CROSS JOIN LATERAL (
    SELECT date_trunc('day', now() AT TIME ZONE p_root.window_time_zone) AS local_start
  ) local_day
  CROSS JOIN LATERAL (
    SELECT local_day.local_start AT TIME ZONE p_root.window_time_zone AS started_at,
      (local_day.local_start + interval '1 day') AT TIME ZONE p_root.window_time_zone AS resets_at
  ) bounds
  CROSS JOIN LATERAL (
    SELECT CASE WHEN p_root.window_period IS NULL THEN p_root.known_micros
      WHEN p_root.window_started_at >= bounds.started_at THEN p_root.window_known_micros
      ELSE 0 END AS micros
  ) used
    $body$;
  $create$, data_schema);
END
$state$;

-- The command: a custody marker opens only while the state is `within` (or
-- unlimited or preparing), so it follows the window; `set` accepts an
-- optional `window` (absent keeps the current one, null removes it, and
-- clearing the limit removes it too) and records it with the operation.
DO $migration$
DECLARE
  definition text;
  edit text[];
  edits text[] := ARRAY[
    ARRAY[$a$  v_state jsonb;$a$, $a$  v_state jsonb;
  v_window jsonb := p_input->'window';
  v_window_period text;
  v_window_tz text;
  v_window_start timestamptz;$a$],
    ARRAY[$a$OR root_row.known_micros < root_row.limit_micros) THEN$a$,
      $a$OR v_state ->> 'status' = 'within') THEN$a$],
    ARRAY[$a$OR (p_input->'limitMicros' <> 'null'::jsonb AND jsonb_typeof(p_input->'limitMicros') <> 'number') THEN$a$,
      $a$OR (p_input->'limitMicros' <> 'null'::jsonb AND jsonb_typeof(p_input->'limitMicros') <> 'number')
      OR (coalesce(v_window, 'null'::jsonb) <> 'null'::jsonb AND (
        jsonb_typeof(v_window) <> 'object'
        OR v_window - 'period' - 'timeZone' <> '{}'::jsonb
        OR v_window->>'period' IS DISTINCT FROM 'day'
        OR p_input->'limitMicros' = 'null'::jsonb
        OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names zone
          WHERE zone.name = v_window->>'timeZone'))) THEN$a$],
    ARRAY[$a$    SELECT * INTO prior_receipt FROM opengeni_private.session_usage_limit_config_receipts$a$,
      $a$    v_window_period := CASE WHEN v_limit IS NULL THEN NULL
      WHEN p_input ? 'window' THEN v_window->>'period' ELSE root_row.window_period END;
    v_window_tz := CASE WHEN v_window_period IS NULL THEN NULL
      WHEN p_input ? 'window' THEN v_window->>'timeZone' ELSE root_row.window_time_zone END;
    SELECT * INTO prior_receipt FROM opengeni_private.session_usage_limit_config_receipts$a$],
    ARRAY[$a$OR prior_receipt.limit_micros IS DISTINCT FROM v_limit THEN$a$,
      $a$OR prior_receipt.limit_micros IS DISTINCT FROM v_limit
        OR (p_input ? 'window' AND (prior_receipt.window_period IS DISTINCT FROM v_window_period
          OR prior_receipt.window_time_zone IS DISTINCT FROM v_window_tz)) THEN$a$],
    ARRAY[$a$root_row.limit_micros := prior_receipt.limit_micros;$a$,
      $a$root_row.limit_micros := prior_receipt.limit_micros;
        root_row.window_period := prior_receipt.window_period;
        root_row.window_time_zone := prior_receipt.window_time_zone;$a$],
    ARRAY[$a$UPDATE opengeni_private.session_usage_limit_roots SET limit_micros = v_limit,$a$,
      $a$IF v_window_period IS NOT NULL AND (root_row.window_period IS DISTINCT FROM v_window_period
        OR root_row.window_time_zone IS DISTINCT FROM v_window_tz) THEN
        v_window_start := date_trunc('day', clock_timestamp() AT TIME ZONE v_window_tz)
          AT TIME ZONE v_window_tz;
        root_row.window_started_at := v_window_start;
        root_row.window_known_micros := (SELECT coalesce(sum(r.amount_micros), 0)
          FROM opengeni_private.session_usage_limit_receipts r
          WHERE r.workspace_id = w AND r.root_session_id = v_root
            AND r.origin = 'live' AND r.status IN ('priced','free')
            AND r.recorded_at >= v_window_start);
      ELSIF v_window_period IS NULL THEN
        root_row.window_started_at := NULL;
        root_row.window_known_micros := 0;
      END IF;
      UPDATE opengeni_private.session_usage_limit_roots SET limit_micros = v_limit,
        window_period = v_window_period, window_time_zone = v_window_tz,
        window_started_at = root_row.window_started_at,
        window_known_micros = root_row.window_known_micros,$a$],
    ARRAY[$a$actor_subject_id,actor_type)$a$, $a$actor_subject_id,actor_type,window_period,window_time_zone)$a$],
    ARRAY[$a$root_row.config_version, p_input->>'actorSubjectId', p_input->>'actorType');$a$,
      $a$root_row.config_version, p_input->>'actorSubjectId', p_input->>'actorType',
        v_window_period, v_window_tz);$a$]
  ];
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.session_usage_limit_command(jsonb)', pg_catalog.current_schema())::regprocedure);
  IF strpos(definition, 'v_window_period') > 0 THEN
    RETURN;
  END IF;
  FOREACH edit SLICE 1 IN ARRAY edits LOOP
    IF (length(definition) - length(replace(definition, edit[1], ''))) / length(edit[1]) <> 1 THEN
      RAISE EXCEPTION '1112 session usage limit command drift at %', edit[1]
        USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, edit[1], edit[2]);
  END LOOP;
  EXECUTE definition;
END
$migration$;
