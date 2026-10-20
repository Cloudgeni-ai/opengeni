-- deployment-mode: rolling
-- Private telemetry only: no new data-schema grants or admission behavior.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE opengeni_private.subscription_usage_readings (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES subscription_connections(id) ON DELETE CASCADE,
  window_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  used_percent double precision CHECK (used_percent >= 0 AND used_percent < 'Infinity'::float8),
  resets_at timestamptz,
  PRIMARY KEY (connection_id, window_id, observed_at)
);
CREATE INDEX subscription_usage_readings_retention ON opengeni_private.subscription_usage_readings(observed_at);

-- A content-free projection, not a second billing ledger. Keeping the precise
-- call time lets calibration use only calls between two actual observations.
CREATE TABLE opengeni_private.subscription_usage_calls (
  fact_id uuid PRIMARY KEY REFERENCES model_call_facts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES subscription_connections(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  units bigint NOT NULL CHECK (units >= 0)
);
CREATE INDEX subscription_usage_calls_connection_time ON opengeni_private.subscription_usage_calls(connection_id, occurred_at);
CREATE INDEX subscription_usage_calls_retention ON opengeni_private.subscription_usage_calls(occurred_at);

DO $functions$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.append_usage_reading(p_account uuid, p_connection uuid, reading jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $fn$
    DECLARE item jsonb; observed timestamptz; used double precision;
    BEGIN
      IF reading IS NULL OR jsonb_typeof(reading->'windows') IS DISTINCT FROM 'array' THEN RETURN; END IF;
      observed := to_timestamp((reading->>'observedAt')::double precision / 1000);
      IF observed IS NULL OR NOT isfinite(observed) OR observed < clock_timestamp() - interval '30 days'
        OR observed > clock_timestamp() + interval '5 minutes' THEN RETURN; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(reading->'windows') LOOP
        IF coalesce(jsonb_typeof(item->'usedPercent'), '') NOT IN ('number', 'null') OR nullif(item->>'id', '') IS NULL THEN CONTINUE; END IF;
        used := (item->>'usedPercent')::double precision;
        IF used < 0 OR used >= 'Infinity'::double precision THEN CONTINUE; END IF;
        INSERT INTO opengeni_private.subscription_usage_readings
          (account_id, connection_id, window_id, observed_at, used_percent, resets_at)
        VALUES (p_account, p_connection, item->>'id', observed, used,
          CASE WHEN jsonb_typeof(item->'resetsAt') = 'number'
            THEN to_timestamp((item->>'resetsAt')::double precision / 1000) ELSE NULL END)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END $fn$;

    CREATE FUNCTION opengeni_subscription_internal.capture_usage_reading() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $fn$
    DECLARE reading jsonb;
    BEGIN
      reading := NEW.quota->'usageReading';
      IF reading IS NULL AND NEW.quota->>'source' = 'usage_endpoint' THEN
        reading := jsonb_build_object('windows', NEW.quota->'windows',
          'observedAt', extract(epoch FROM NEW.updated_at) * 1000);
      END IF;
      PERFORM opengeni_subscription_internal.append_usage_reading(NEW.account_id, NEW.connection_id, reading);
      RETURN NULL;
    END $fn$;

    CREATE FUNCTION opengeni_private.append_subscription_usage_reading(p_account uuid, p_connection uuid, p_provider text, p_reading jsonb)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp AS $fn$
    DECLARE provider_id text; workspace_id uuid; subject_id text;
    BEGIN
      IF p_account IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Subscription history scope mismatch' USING ERRCODE = '42501';
      END IF;
      SELECT c.provider INTO provider_id FROM subscription_connections c
        WHERE c.id = p_connection AND c.account_id = p_account AND c.provider = p_provider
          AND c.ownership = 'shared' AND c.disconnected_at IS NULL;
      IF provider_id IS NULL THEN
        workspace_id := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
        subject_id := nullif(current_setting('opengeni.subject_id', true), '');
        IF workspace_id IS NOT NULL AND subject_id IS NOT NULL THEN
          SELECT p_provider INTO provider_id FROM opengeni_private.subscription_core_personal_connections(
            p_provider, p_account, workspace_id, subject_id) c WHERE c.id = p_connection;
        END IF;
      END IF;
      IF provider_id IS NULL THEN RAISE EXCEPTION 'Subscription history connection not visible' USING ERRCODE = '42501'; END IF;
      PERFORM opengeni_subscription_internal.append_usage_reading(p_account, p_connection, p_reading);
    END $fn$;

    CREATE FUNCTION opengeni_subscription_internal.capture_usage_call() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $fn$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        DELETE FROM opengeni_private.subscription_usage_calls WHERE fact_id = OLD.id;
      END IF;
      IF TG_OP <> 'DELETE' AND NEW.connection_id IS NOT NULL
        AND NEW.estimated_provider_cost_micros IS NOT NULL
        AND NEW.occurred_at >= clock_timestamp() - interval '30 days' THEN
        INSERT INTO opengeni_private.subscription_usage_calls
          (fact_id, account_id, connection_id, occurred_at, units)
        VALUES (NEW.id, NEW.account_id, NEW.connection_id, NEW.occurred_at, NEW.estimated_provider_cost_micros)
        ON CONFLICT (fact_id) DO UPDATE SET connection_id = EXCLUDED.connection_id,
          occurred_at = EXCLUDED.occurred_at, units = EXCLUDED.units;
      END IF;
      RETURN NULL;
    END $fn$;

    CREATE FUNCTION opengeni_private.read_subscription_usage_history(
      p_account uuid, p_workspace uuid, p_subject text, p_provider text, p_connections uuid[]
    ) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp AS $fn$
    DECLARE visible uuid[]; result jsonb;
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
        SELECT c.id FROM subscription_connections c
          WHERE c.account_id = p_account AND c.provider = p_provider
            AND c.id = ANY(p_connections) AND c.disconnected_at IS NULL
            AND c.ownership = 'shared'
        UNION
        SELECT c.id FROM opengeni_private.subscription_core_personal_connections(
          p_provider, p_account, p_workspace, p_subject) c
          WHERE p_workspace IS NOT NULL AND c.id = ANY(p_connections)
      ) allowed;
      SELECT jsonb_build_object(
        'readings', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'connectionId', r.connection_id, 'window', r.window_id,
          'usedPercent', r.used_percent, 'resetsAt', extract(epoch FROM r.resets_at) * 1000,
          'observedAt', extract(epoch FROM r.observed_at) * 1000) ORDER BY r.observed_at)
          FROM opengeni_private.subscription_usage_readings r
          WHERE r.account_id = p_account AND r.connection_id = ANY(visible)
            AND r.observed_at >= statement_timestamp() - interval '14 days'), '[]'::jsonb),
        'calls', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'connectionId', c.connection_id, 'at', extract(epoch FROM c.occurred_at) * 1000,
          'units', c.units) ORDER BY c.occurred_at)
          FROM opengeni_private.subscription_usage_calls c
          WHERE c.account_id = p_account AND c.connection_id = ANY(visible)
            AND c.occurred_at >= statement_timestamp() - interval '14 days'), '[]'::jsonb)
      ) INTO result;
      RETURN result;
    END $fn$;

    -- Fixed retention; callers cannot choose a cutoff or remove current data.
    CREATE FUNCTION opengeni_private.prune_subscription_usage_history() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp AS $fn$
    DECLARE n integer; total integer;
    BEGIN
      DELETE FROM opengeni_private.subscription_usage_readings WHERE ctid IN (
        SELECT ctid FROM opengeni_private.subscription_usage_readings
        WHERE observed_at < statement_timestamp() - interval '30 days' ORDER BY observed_at LIMIT 10000
        FOR UPDATE SKIP LOCKED);
      GET DIAGNOSTICS total = ROW_COUNT;
      DELETE FROM opengeni_private.subscription_usage_calls WHERE fact_id IN (
        SELECT fact_id FROM opengeni_private.subscription_usage_calls
        WHERE occurred_at < statement_timestamp() - interval '30 days' ORDER BY occurred_at LIMIT 10000
        FOR UPDATE SKIP LOCKED);
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN total + n;
    END $fn$;
    CREATE FUNCTION opengeni_private.subscription_usage_history_prune_due() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp AS $fn$
      SELECT EXISTS (SELECT 1 FROM opengeni_private.subscription_usage_readings
        WHERE observed_at < statement_timestamp() - interval '30 days')
        OR EXISTS (SELECT 1 FROM opengeni_private.subscription_usage_calls
        WHERE occurred_at < statement_timestamp() - interval '30 days')
    $fn$;
  $ddl$, current_schema());
END $functions$;

CREATE TRIGGER subscription_usage_reading_capture AFTER INSERT OR UPDATE OF quota, updated_at
  ON subscription_connection_quota FOR EACH ROW
  EXECUTE FUNCTION opengeni_subscription_internal.capture_usage_reading();
CREATE TRIGGER subscription_usage_call_capture AFTER INSERT OR UPDATE OR DELETE
  ON model_call_facts FOR EACH ROW
  EXECUTE FUNCTION opengeni_subscription_internal.capture_usage_call();

-- Strip inherited default grants, then grant only the runtime routine boundary.
DO $acl$
DECLARE obj record; grantee record; application_role text;
BEGIN
  FOR obj IN
    SELECT c.relowner AS owner, format('TABLE %s', c.oid::regclass) AS target, c.relacl AS acl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'opengeni_private' AND c.relname IN ('subscription_usage_readings','subscription_usage_calls')
    UNION ALL SELECT p.proowner, format('FUNCTION %s', p.oid::regprocedure), p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE (n.nspname = 'opengeni_subscription_internal' AND p.proname IN ('capture_usage_reading','capture_usage_call','append_usage_reading'))
      OR (n.nspname = 'opengeni_private' AND p.proname IN ('read_subscription_usage_history',
        'append_subscription_usage_reading','prune_subscription_usage_history','subscription_usage_history_prune_due'))
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', obj.target);
    FOR grantee IN SELECT DISTINCT r.rolname FROM aclexplode(obj.acl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE a.grantee <> obj.owner LOOP
      EXECUTE format('REVOKE ALL ON %s FROM %I', obj.target, grantee.rolname);
    END LOOP;
  END LOOP;
  FOR application_role IN
    SELECT r.rolname FROM jsonb_array_elements_text(coalesce(nullif(
      current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb) configured(value)
      JOIN pg_roles r ON r.rolname = configured.value
    UNION SELECT 'opengeni_app' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.read_subscription_usage_history(uuid,uuid,text,text,uuid[]),
      opengeni_private.append_subscription_usage_reading(uuid,uuid,text,jsonb),
      opengeni_private.prune_subscription_usage_history(), opengeni_private.subscription_usage_history_prune_due() TO %I', application_role);
  END LOOP;
END $acl$;
