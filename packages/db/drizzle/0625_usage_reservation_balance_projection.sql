-- deployment-mode: maintenance
-- Transactional reservation projection. The ledger remains authoritative;
-- settled source tombstones stay out of the partial read indexes. Account
-- balances retain cross-workspace source grouping. Workspace balances retain
-- per-session visibility before grouping, including partial/negative releases.
-- Drain API/control/turn writers before installation and resume only the
-- projection-aware binary: older posture checks reject the new owner-only
-- internal routines. The ledger/projection update itself remains transactional.
-- Installation briefly serializes ledger writers; lock/statement timeout aborts
-- atomically rather than installing an incomplete projection.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
LOCK TABLE usage_events IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE opengeni_private.usage_reservation_balances (
  account_id uuid NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('account','workspace')),
  scope_id uuid NOT NULL,
  event_type text NOT NULL,
  source_key text NOT NULL,
  session_key text NOT NULL,
  session_id uuid,
  net_quantity numeric NOT NULL,
  PRIMARY KEY(account_id,scope_kind,scope_id,event_type,source_key,session_key)
);
CREATE INDEX usage_reservation_balances_open_idx
  ON opengeni_private.usage_reservation_balances(account_id,scope_kind,scope_id,event_type)
  INCLUDE(source_key,session_id,net_quantity) WHERE net_quantity <> 0;
ALTER TABLE opengeni_private.usage_reservation_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.usage_reservation_balances FORCE ROW LEVEL SECURITY;
DO $owner_policy$
BEGIN
  EXECUTE format('CREATE POLICY reservation_balances_owner ON opengeni_private.usage_reservation_balances USING (current_user = %L) WITH CHECK (current_user = %L)', current_user, current_user);
END $owner_policy$;
REVOKE ALL ON TABLE opengeni_private.usage_reservation_balances FROM PUBLIC;

CREATE FUNCTION opengeni_private.adjust_usage_reservation_balance(
  p_account uuid,p_workspace uuid,p_session uuid,p_event_type text,p_source text,p_delta numeric
) RETURNS void LANGUAGE sql
SET search_path=pg_catalog
AS $fn$
  INSERT INTO opengeni_private.usage_reservation_balances
    (account_id,scope_kind,scope_id,event_type,source_key,session_key,session_id,net_quantity)
  VALUES
    (p_account,'account',p_account,p_event_type,jsonb_build_array(p_source)::text,'account',null,p_delta),
    (p_account,'workspace',p_workspace,p_event_type,jsonb_build_array(p_source)::text,
      coalesce(p_session::text,'none'),p_session,p_delta)
  ON CONFLICT(account_id,scope_kind,scope_id,event_type,source_key,session_key)
  DO UPDATE SET net_quantity=opengeni_private.usage_reservation_balances.net_quantity+EXCLUDED.net_quantity;
$fn$;
REVOKE ALL ON FUNCTION opengeni_private.adjust_usage_reservation_balance(uuid,uuid,uuid,text,text,numeric) FROM PUBLIC;

DO $trigger_function$
DECLARE data_schema text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.project_usage_reservation_balance()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog
    AS $fn$
    BEGIN
      IF TG_TABLE_SCHEMA <> %1$L OR TG_TABLE_NAME <> 'usage_events' THEN
        RAISE EXCEPTION 'Reservation projection requires the authoritative ledger' USING ERRCODE='42501';
      END IF;
      IF TG_OP='UPDATE' AND ROW(OLD.account_id,OLD.workspace_id,OLD.session_id,OLD.event_type,OLD.source_resource_id)
        IS NOT DISTINCT FROM ROW(NEW.account_id,NEW.workspace_id,NEW.session_id,NEW.event_type,NEW.source_resource_id)
      THEN
        IF NEW.event_type LIKE '%%.reserved' AND NEW.quantity <> OLD.quantity THEN
          PERFORM opengeni_private.adjust_usage_reservation_balance(NEW.account_id,NEW.workspace_id,NEW.session_id,
            NEW.event_type,NEW.source_resource_id,NEW.quantity::numeric-OLD.quantity::numeric);
        END IF;
        RETURN NEW;
      END IF;
      IF TG_OP <> 'INSERT' AND OLD.event_type LIKE '%%.reserved' THEN
        PERFORM opengeni_private.adjust_usage_reservation_balance(OLD.account_id,OLD.workspace_id,OLD.session_id,
          OLD.event_type,OLD.source_resource_id,-OLD.quantity::numeric);
      END IF;
      IF TG_OP <> 'DELETE' AND NEW.event_type LIKE '%%.reserved' THEN
        PERFORM opengeni_private.adjust_usage_reservation_balance(NEW.account_id,NEW.workspace_id,NEW.session_id,
          NEW.event_type,NEW.source_resource_id,NEW.quantity::numeric);
      END IF;
      RETURN coalesce(NEW,OLD);
    END
    $fn$;
  $ddl$,data_schema);
END $trigger_function$;
REVOKE ALL ON FUNCTION opengeni_private.project_usage_reservation_balance() FROM PUBLIC;
CREATE TRIGGER usage_reservation_balance_projection
  AFTER INSERT OR UPDATE OR DELETE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.project_usage_reservation_balance();

-- Owner-only posture window; app roles retain all existing RLS policies.
ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;
INSERT INTO opengeni_private.usage_reservation_balances
  (account_id,scope_kind,scope_id,event_type,source_key,session_key,session_id,net_quantity)
SELECT account_id,'account',account_id,event_type,jsonb_build_array(source_resource_id)::text,
  'account',null,sum(quantity)
FROM usage_events WHERE event_type LIKE '%.reserved'
GROUP BY account_id,event_type,source_resource_id
UNION ALL
SELECT account_id,'workspace',workspace_id,event_type,jsonb_build_array(source_resource_id)::text,
  coalesce(session_id::text,'none'),session_id,sum(quantity)
FROM usage_events WHERE event_type LIKE '%.reserved'
GROUP BY account_id,workspace_id,event_type,source_resource_id,session_id;
DO $backfill_convergence$
BEGIN
  IF EXISTS (
    WITH expected(account_id,scope_kind,scope_id,event_type,source_key,session_key,session_id,net_quantity) AS (SELECT account_id,'account',account_id,event_type,jsonb_build_array(source_resource_id)::text,
  'account',null,sum(quantity)
FROM usage_events WHERE event_type LIKE '%.reserved'
GROUP BY account_id,event_type,source_resource_id
UNION ALL
SELECT account_id,'workspace',workspace_id,event_type,jsonb_build_array(source_resource_id)::text,
  coalesce(session_id::text,'none'),session_id,sum(quantity)
FROM usage_events WHERE event_type LIKE '%.reserved'
GROUP BY account_id,workspace_id,event_type,source_resource_id,session_id), actual AS (
      SELECT account_id,scope_kind,scope_id,event_type,source_key,session_key,session_id,net_quantity
      FROM opengeni_private.usage_reservation_balances
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION 'Reservation balance backfill did not converge' USING ERRCODE='55000';
  END IF;
END $backfill_convergence$;

ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;

-- Replace only the read, preserving the exact account-only context, capability
-- lifecycle, function signature, ownership, and ACL installed by 0623.
DO $account_read$
DECLARE
  data_schema text:=current_schema();
  definition text:=pg_get_functiondef('opengeni_private.account_open_usage_reservations(uuid,text,timestamptz,timestamptz)'::regprocedure);
  anchor text;
  replacement text;
BEGIN
  anchor:=format($query$SELECT coalesce(sum(
          greatest(g.net, 0)
        ), 0) INTO total
        FROM (
          SELECT sum(usage_row.quantity) AS net
          FROM %I.usage_events usage_row
          WHERE usage_row.account_id = p_account_id
            AND usage_row.event_type = p_event_type
          GROUP BY usage_row.source_resource_id
        ) g;$query$,data_schema);
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION 'Reservation projection refuses an unknown account aggregate' USING ERRCODE='55000';
  END IF;
  replacement:=$query$IF p_event_type LIKE '%.reserved' THEN
          SELECT coalesce(sum(greatest(net_quantity,0)),0) INTO total
          FROM opengeni_private.usage_reservation_balances
          WHERE account_id=p_account_id AND scope_kind='account' AND scope_id=p_account_id
            AND event_type=p_event_type AND net_quantity <> 0;
        ELSE $query$ || anchor || ' END IF;';
  EXECUTE replace(definition,anchor,replacement);
END $account_read$;

DO $workspace_read$
DECLARE data_schema text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.workspace_open_usage_reservations(p_account_id uuid,p_workspace_id uuid,p_event_type text)
    RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp
    AS $fn$
    DECLARE total numeric; context_account uuid; context_workspace uuid;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN
        context_account:=nullif(current_setting('opengeni.account_id',true),'')::uuid;
        context_workspace:=nullif(current_setting('opengeni.workspace_id',true),'')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'Workspace reservation context is malformed' USING ERRCODE='42501';
      END;
      IF context_account IS NULL OR context_workspace IS NULL
        OR context_account IS DISTINCT FROM p_account_id OR context_workspace IS DISTINCT FROM p_workspace_id THEN
        RAISE EXCEPTION 'Workspace reservation requires the exact tenant context' USING ERRCODE='42501';
      END IF;
      IF p_event_type IS NULL OR octet_length(p_event_type)=0 THEN
        RAISE EXCEPTION 'Workspace reservation event type is invalid' USING ERRCODE='22023';
      END IF;
      IF p_event_type LIKE '%%.reserved' THEN
        SELECT coalesce(sum(greatest(g.net,0)),0) INTO total FROM (
          SELECT source_key,sum(net_quantity) AS net
          FROM opengeni_private.usage_reservation_balances
          WHERE account_id=p_account_id AND scope_kind='workspace' AND scope_id=p_workspace_id
            AND event_type=p_event_type AND net_quantity <> 0
            AND %1$I.session_reference_visible(p_account_id,p_workspace_id,session_id)
          GROUP BY source_key
        ) g;
      ELSE
        -- Preserve the existing generic API for non-reservation event types.
        SELECT coalesce(sum(greatest(g.net,0)),0) INTO total FROM (
          SELECT sum(quantity) AS net FROM %1$I.usage_events
          WHERE account_id=p_account_id AND workspace_id=p_workspace_id AND event_type=p_event_type
          GROUP BY source_resource_id
        ) g;
      END IF;
      RETURN total;
    END $fn$;
  $ddl$,data_schema);
END $workspace_read$;
REVOKE ALL ON FUNCTION opengeni_private.workspace_open_usage_reservations(uuid,uuid,text) FROM PUBLIC;

-- Default ACLs can grant newly created objects before the explicit revoke.
DO $acl$
DECLARE role_name text; data_schema text:=current_schema();
BEGIN
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    JOIN pg_roles r ON r.oid=a.grantee
    WHERE c.oid='opengeni_private.usage_reservation_balances'::regclass AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.usage_reservation_balances FROM %I',role_name);
  END LOOP;
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    JOIN pg_roles r ON r.oid=a.grantee
    WHERE p.oid IN (
      'opengeni_private.adjust_usage_reservation_balance(uuid,uuid,uuid,text,text,numeric)'::regprocedure,
      'opengeni_private.project_usage_reservation_balance()'::regprocedure,
      'opengeni_private.workspace_open_usage_reservations(uuid,uuid,text)'::regprocedure
    ) AND a.grantee<>p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.adjust_usage_reservation_balance(uuid,uuid,uuid,text,text,numeric) FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.project_usage_reservation_balance() FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.workspace_open_usage_reservations(uuid,uuid,text) FROM %I',role_name);
  END LOOP;
  FOR role_name IN
    SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
    JOIN pg_roles r ON r.rolname=configured.value
    WHERE has_table_privilege(r.rolname,format('%I.usage_events',data_schema),'SELECT')
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I',role_name);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.workspace_open_usage_reservations(uuid,uuid,text) TO %I',role_name);
  END LOOP;
END $acl$;
