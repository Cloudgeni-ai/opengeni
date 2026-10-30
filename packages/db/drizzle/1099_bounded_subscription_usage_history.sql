-- deployment-mode: rolling
-- The subscription usage pools read failed for heavily used organizations: it
-- returned every usage reading and call of the last 14 days as one jsonb value,
-- which passes Postgres's 256 MB limit for one value at around a million of
-- them.
--
-- Now it returns what the pool forecast uses, bounded by how often usage
-- changes rather than how many model calls ran:
-- - Readings: each window's first and last reading, every reading whose value
--   differs from the one before it, and the first reading in each five-minute
--   slot. The forecast samples usage from a slot's first reading to the first
--   reading two or more slots later, and restarts at a change, so it samples
--   these readings exactly as it would every reading.
-- - Calls: totals of a connection's calls between two consecutive returned
--   readings within one UTC hour, with their count and the time of the last
--   one. The forecast assigns calls to the stretch between two readings and to
--   an hour, so the totals land where the single calls did.
-- - Start: the earliest reading or call, which totals no longer show.
--
-- Same signature and grants. The previous release reads the same keys and
-- takes each total as one call, so both can run against this schema.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $reader$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.read_subscription_usage_history(
      p_account uuid, p_workspace uuid, p_subject text, p_provider text, p_connections uuid[])
    RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      visible uuid[];
      since timestamptz := statement_timestamp() - interval '14 days';
      result jsonb;
    BEGIN
      IF p_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject IS DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
        OR cardinality(p_connections) > 1000 THEN
        RAISE EXCEPTION 'Subscription history scope mismatch' USING ERRCODE = '42501';
      END IF;
      -- RLS on the canonical account row is still the authority. The owner-only
      -- reader is the same seam the personal Models listing uses.
      SELECT array_agg(id) INTO visible FROM (
        SELECT c.id FROM %1$I.subscription_connections c
          WHERE c.account_id = p_account AND c.provider = p_provider
            AND c.id = ANY(p_connections) AND c.disconnected_at IS NULL
            AND c.ownership = 'shared'
        UNION
        SELECT c.id FROM opengeni_private.subscription_core_personal_connections(
          p_provider, p_account, p_workspace, p_subject) c
          WHERE p_workspace IS NOT NULL AND c.id = ANY(p_connections)
      ) allowed;
      WITH ordered AS (
        SELECT r.connection_id, r.window_id, r.observed_at, r.used_percent, r.resets_at,
          lag(r.observed_at) OVER w AS previous_at,
          lag(r.used_percent) OVER w AS previous_used,
          lag(r.resets_at) OVER w AS previous_resets,
          lead(r.observed_at) OVER w AS next_at
        FROM opengeni_private.subscription_usage_readings r
        WHERE r.account_id = p_account AND r.connection_id = ANY(visible)
          AND r.observed_at >= since
        WINDOW w AS (PARTITION BY r.connection_id, r.window_id ORDER BY r.observed_at)
      ), readings AS (
        SELECT o.connection_id, o.window_id, o.observed_at, o.used_percent, o.resets_at
        FROM ordered o
        WHERE o.previous_at IS NULL OR o.next_at IS NULL
          OR (o.used_percent, o.resets_at) IS DISTINCT FROM (o.previous_used, o.previous_resets)
          OR date_bin('5 minutes', o.observed_at, timestamptz 'epoch')
            <> date_bin('5 minutes', o.previous_at, timestamptz 'epoch')
      ), calls AS (
        SELECT c.connection_id, c.occurred_at, c.units
        FROM opengeni_private.subscription_usage_calls c
        WHERE c.account_id = p_account AND c.connection_id = ANY(visible)
          AND c.occurred_at >= since
      ), stream AS (
        -- A call at a reading's own time belongs to the stretch that reading ends.
        SELECT s.connection_id, s.at, s.units, s.reading,
          count(*) FILTER (WHERE s.reading) OVER (PARTITION BY s.connection_id
            ORDER BY s.at, s.reading ROWS UNBOUNDED PRECEDING) AS stretch
        FROM (
          SELECT r.connection_id, r.observed_at AS at, NULL::bigint AS units, true AS reading
          FROM readings r
          UNION ALL
          SELECT c.connection_id, c.occurred_at, c.units, false FROM calls c
        ) s
      ), call_totals AS (
        SELECT s.connection_id, max(s.at) AS at, sum(s.units) AS units, count(*) AS count
        FROM stream s
        WHERE NOT s.reading
        GROUP BY s.connection_id, s.stretch, date_bin('1 hour', s.at, timestamptz 'epoch')
      )
      SELECT jsonb_build_object(
        'readings', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'connectionId', r.connection_id, 'window', r.window_id,
          'usedPercent', r.used_percent, 'resetsAt', extract(epoch FROM r.resets_at) * 1000,
          'observedAt', extract(epoch FROM r.observed_at) * 1000) ORDER BY r.observed_at)
          FROM readings r), '[]'::jsonb),
        'calls', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'connectionId', t.connection_id, 'at', extract(epoch FROM t.at) * 1000,
          'units', t.units, 'count', t.count) ORDER BY t.at)
          FROM call_totals t), '[]'::jsonb),
        'start', extract(epoch FROM least(
          (SELECT min(r.observed_at) FROM readings r),
          (SELECT min(c.occurred_at) FROM calls c))) * 1000
      ) INTO result;
      RETURN result;
    END
    $body$;
  $create$, data_schema);
END $reader$;
