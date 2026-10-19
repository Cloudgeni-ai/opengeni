-- deployment-mode: rolling
-- Content-free cleanup ownership outlives attempts, sessions and transport
-- generations. No cascading FK may discard an unresolved erasure obligation.
SET LOCAL lock_timeout = '5s';

CREATE TABLE connected_secret_file_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  execution_generation integer NOT NULL,
  control_workspace_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  pubkey text NOT NULL,
  connection_instance_id text NOT NULL,
  scope text NOT NULL CHECK (scope ~ '^[A-Za-z0-9_-]{1,128}$'),
  close_requested_at timestamptz,
  retry_after timestamptz NOT NULL DEFAULT now(),
  claim_id uuid,
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (control_workspace_id, enrollment_id, scope)
);
CREATE INDEX connected_secret_file_scopes_due ON connected_secret_file_scopes(retry_after);
CREATE INDEX connected_secret_file_scopes_attempt ON connected_secret_file_scopes(attempt_id);
ALTER TABLE connected_secret_file_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_secret_file_scopes FORCE ROW LEVEL SECURITY;

DO $install$
DECLARE data_schema text := current_schema(); owner_name text := current_user; schema_oid oid := current_schema()::regnamespace;
BEGIN
  EXECUTE format('CREATE POLICY private_cleanup_inventory ON %1$I.connected_secret_file_scopes
    USING (%1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,true))
    WITH CHECK (%1$I.session_tenancy_fence_owner_policy_active(current_user,%2$L,%3$s::oid,workspace_id,true))', data_schema, owner_name, schema_oid);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.register_connected_secret_scope(
      a uuid, w uuid, s uuid, t uuid, attempt uuid, generation integer,
      control_w uuid, enrollment uuid, instance text, scope_name text)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE inventory uuid; result_id uuid; machine_key text;
    BEGIN
      IF a IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR w IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Secret scope registration requires exact tenant context' USING ERRCODE='42501';
      END IF;
      -- The caller holds the canonical attempt write fence. Recheck immutable
      -- ownership and live state inside this private insertion boundary too.
      IF NOT EXISTS (SELECT 1 FROM %1$I.session_turn_attempts x WHERE x.id=attempt
        AND x.account_id=a AND x.workspace_id=w AND x.session_id=s AND x.turn_id=t
        AND x.execution_generation=generation AND x.closed_at IS NULL) THEN
        RAISE EXCEPTION 'Secret scope owner is not live' USING ERRCODE='42501';
      END IF;
      inventory := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      PERFORM set_config('opengeni.workspace_id',control_w::text,true);
      SELECT e.pubkey INTO machine_key FROM %1$I.enrollments e
        WHERE e.id=enrollment AND e.workspace_id=control_w AND e.account_id=a
          AND e.status='active' AND e.connection_instance_id=instance
          AND e.connection_lease_expires_at > now()
          AND e.agent_capabilities->>'secretFileFencing'='true';
      PERFORM set_config('opengeni.workspace_id',w::text,true);
      IF machine_key IS NULL THEN RAISE EXCEPTION 'Secret scope machine changed or lacks fencing' USING ERRCODE='42501'; END IF;
      INSERT INTO %1$I.connected_secret_file_scopes
        (account_id,workspace_id,session_id,turn_id,attempt_id,execution_generation,
         control_workspace_id,enrollment_id,pubkey,connection_instance_id,scope)
      VALUES (a,w,s,t,attempt,generation,control_w,enrollment,machine_key,instance,scope_name)
      ON CONFLICT (control_workspace_id,enrollment_id,scope) DO NOTHING;
      SELECT x.id INTO result_id FROM %1$I.connected_secret_file_scopes x
        WHERE x.control_workspace_id=control_w AND x.enrollment_id=enrollment AND x.scope=scope_name
          AND x.account_id=a AND x.workspace_id=w AND x.session_id=s AND x.attempt_id=attempt
          AND x.execution_generation=generation AND x.pubkey=machine_key AND x.close_requested_at IS NULL;
      IF result_id IS NULL THEN RAISE EXCEPTION 'Secret scope already closed or owned elsewhere' USING ERRCODE='42501'; END IF;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
      RETURN result_id;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory); RAISE;
    END $fn$;

    CREATE FUNCTION opengeni_private.connected_secret_scopes_due()
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
    DECLARE inventory uuid; result boolean;
    BEGIN
      inventory := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      SELECT EXISTS (SELECT 1 FROM %1$I.connected_secret_file_scopes x
        WHERE x.retry_after <= now() AND (x.claimed_at IS NULL OR x.claimed_at < now()-interval '5 minutes')
          AND (x.close_requested_at IS NOT NULL OR NOT EXISTS
            (SELECT 1 FROM %1$I.session_turn_attempts a WHERE a.id=x.attempt_id AND a.closed_at IS NULL))) INTO result;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory); RAISE;
    END $fn$;

    CREATE FUNCTION opengeni_private.claim_connected_secret_scopes(claim uuid, batch integer, ttl_ms integer)
    RETURNS SETOF %1$I.connected_secret_file_scopes
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    DECLARE inventory uuid;
    BEGIN
      IF claim IS NULL OR batch < 1 OR batch > 1000 OR ttl_ms < 1000 THEN RAISE EXCEPTION 'Invalid cleanup claim'; END IF;
      inventory := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      RETURN QUERY WITH due AS (
        SELECT x.id FROM %1$I.connected_secret_file_scopes x
        WHERE x.retry_after <= now() AND (x.claimed_at IS NULL OR x.claimed_at < now()-ttl_ms*interval '1 millisecond')
          AND (x.close_requested_at IS NOT NULL OR NOT EXISTS
            (SELECT 1 FROM %1$I.session_turn_attempts a WHERE a.id=x.attempt_id AND a.closed_at IS NULL))
        ORDER BY x.retry_after,x.id LIMIT batch FOR UPDATE OF x SKIP LOCKED
      ) UPDATE %1$I.connected_secret_file_scopes x SET claim_id=claim,claimed_at=now(),
          close_requested_at=coalesce(x.close_requested_at,now()), attempts=x.attempts+1
        FROM due WHERE x.id=due.id RETURNING x.*;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory); RAISE;
    END $fn$;

    CREATE FUNCTION opengeni_private.update_connected_secret_scope(scope_id uuid, claim uuid, action text, retry_ms integer)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
    DECLARE inventory uuid;
    BEGIN
      inventory := opengeni_private.open_session_tenancy_fence_inventory(%1$I.session_tenancy_fence_target_schema());
      IF claim IS NULL AND NOT EXISTS (SELECT 1 FROM %1$I.connected_secret_file_scopes x
        WHERE x.id=scope_id AND x.account_id=nullif(current_setting('opengeni.account_id',true),'')::uuid
          AND x.workspace_id=nullif(current_setting('opengeni.workspace_id',true),'')::uuid) THEN
        PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory); RETURN;
      END IF;
      IF action='close' AND claim IS NULL THEN
        UPDATE %1$I.connected_secret_file_scopes SET close_requested_at=coalesce(close_requested_at,now()), retry_after=least(retry_after,now()) WHERE id=scope_id;
      ELSIF action='complete' THEN
        DELETE FROM %1$I.connected_secret_file_scopes WHERE id=scope_id AND close_requested_at IS NOT NULL AND (claim IS NULL OR claim_id=claim);
      ELSIF action='retry' AND claim IS NOT NULL AND retry_ms >= 0 THEN
        UPDATE %1$I.connected_secret_file_scopes SET claim_id=NULL,claimed_at=NULL,retry_after=now()+retry_ms*interval '1 millisecond' WHERE id=scope_id AND claim_id=claim;
      ELSE RAISE EXCEPTION 'Invalid cleanup transition'; END IF;
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
    EXCEPTION WHEN OTHERS THEN
      PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory); RAISE;
    END $fn$;
  $ddl$, data_schema);
END $install$;

REVOKE ALL ON FUNCTION opengeni_private.register_connected_secret_scope(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.connected_secret_scopes_due() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.claim_connected_secret_scopes(uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.update_connected_secret_scope(uuid,uuid,text,integer) FROM PUBLIC;
DO $grant$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
  GRANT EXECUTE ON FUNCTION opengeni_private.register_connected_secret_scope(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,text,text) TO opengeni_app;
  GRANT EXECUTE ON FUNCTION opengeni_private.connected_secret_scopes_due() TO opengeni_app;
  GRANT EXECUTE ON FUNCTION opengeni_private.claim_connected_secret_scopes(uuid,integer,integer) TO opengeni_app;
  GRANT EXECUTE ON FUNCTION opengeni_private.update_connected_secret_scope(uuid,uuid,text,integer) TO opengeni_app;
 END IF;
END $grant$;
