-- deployment-mode: rolling
-- Allowances are admission policy, not prepaid account credits. Every actual
-- negative ledger INSERT advances counters, including inserts by old binaries.
-- No historical events or ledger rows are summed or replayed at activation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Preserve the immutable 0539 refusal lifecycle, adding only the allowance
-- reason. Exact anchoring refuses an unexpected deployed guard definition.
DO $scheduled_allowance_refusal$
DECLARE
  definition text:=pg_get_functiondef('opengeni_private.guard_scheduled_admission_refusal()'::regprocedure);
  anchor text:='''insufficient_credits'', ''monthly_model_cost_limit'', ''monthly_agent_run_limit'')';
BEGIN
  IF strpos(definition,anchor)=0 OR strpos(substr(definition,strpos(definition,anchor)+length(anchor)),anchor)>0 THEN
    RAISE EXCEPTION '0542 unexpected scheduled refusal guard definition' USING ERRCODE='55000';
  END IF;
  EXECUTE replace(definition,anchor,
    '''insufficient_credits'', ''monthly_model_cost_limit'', ''monthly_agent_run_limit'', ''allowance_exhausted'')');
END $scheduled_allowance_refusal$;

CREATE TABLE workspace_usage_allowances (
  workspace_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  config jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  actor_subject_id text NOT NULL,
  actor_type text NOT NULL,
  active_period_key text,
  active_start_at timestamptz,
  active_end_at timestamptz,
  maintenance_next_at timestamptz NOT NULL DEFAULT now(),
  maintenance_cursor text,
  maintenance_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CHECK (octet_length(actor_subject_id) BETWEEN 1 AND 1024),
  CHECK (octet_length(actor_type) BETWEEN 1 AND 128)
);
CREATE TABLE workspace_member_allowances (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  subject_id text NOT NULL CHECK (octet_length(subject_id) BETWEEN 1 AND 1024),
  rule jsonb,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  actor_subject_id text NOT NULL,
  actor_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX workspace_usage_allowances_maintenance_due ON workspace_usage_allowances
  (maintenance_next_at,workspace_id) WHERE config IS NOT NULL;
CREATE TABLE workspace_allowance_grants (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 1 AND 256),
  credits bigint NOT NULL CHECK (credits > 0 AND credits <= 9007199254740991),
  remaining bigint NOT NULL CHECK (remaining >= 0 AND remaining <= credits),
  expires_at timestamptz,
  actor_subject_id text NOT NULL,
  actor_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX workspace_allowance_grants_fefo ON workspace_allowance_grants
  (workspace_id, expires_at, created_at, operation_id) WHERE remaining > 0;
CREATE TABLE workspace_allowance_counters (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  period_key text NOT NULL,
  subject_id text NOT NULL DEFAULT '',
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  included_used bigint NOT NULL DEFAULT 0 CHECK (included_used >= 0),
  grants_used bigint NOT NULL DEFAULT 0 CHECK (grants_used >= 0),
  PRIMARY KEY (workspace_id, period_key, subject_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE TABLE workspace_allowance_periods (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  period_key text NOT NULL,
  config jsonb,
  start_at timestamptz,
  end_at timestamptz,
  grants_remaining bigint NOT NULL DEFAULT 0,
  grants_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  member_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  member_count integer NOT NULL DEFAULT 0,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,period_key),
  FOREIGN KEY (workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE
);
CREATE TABLE workspace_allowance_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  period_key text NOT NULL,
  subject_id text NOT NULL,
  threshold numeric NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, period_key, subject_id, threshold),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
ALTER TABLE workspace_webhooks DROP CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 16 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'usage.threshold_reached','usage.exhausted','usage.period_reset'
  ]::text[]
);
CREATE TABLE opengeni_private.usage_allowance_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  data_schema text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id, data_schema, workspace_id)
);
REVOKE ALL ON TABLE opengeni_private.usage_allowance_capabilities FROM PUBLIC;

CREATE FUNCTION usage_allowance_capability_active(p_account uuid, p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT EXISTS (SELECT 1 FROM opengeni_private.usage_allowance_capabilities c
    WHERE c.backend_pid = pg_backend_pid()
      AND c.transaction_id = pg_current_xact_id_if_assigned()
      AND c.data_schema = (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE t.oid='workspace_usage_allowances'::regclass)
      AND ((c.account_id = p_account AND (p_workspace IS NULL OR c.workspace_id = p_workspace))
        OR (p_account IS NULL AND p_workspace IS NULL
          AND c.account_id='00000000-0000-0000-0000-000000000000'::uuid
          AND c.workspace_id='00000000-0000-0000-0000-000000000000'::uuid)))
$$;
-- A value-free predicate cannot mint the private transaction capability.
GRANT EXECUTE ON FUNCTION usage_allowance_capability_active(uuid, uuid) TO PUBLIC;

DO $policies$
DECLARE t text; target_schema text := current_schema(); owner_name text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_usage_allowances','workspace_member_allowances',
    'workspace_allowance_grants','workspace_allowance_counters','workspace_allowance_notifications','workspace_allowance_periods']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY usage_allowance_owner ON %I FOR ALL USING
      (current_user = %L AND %I.usage_allowance_capability_active(account_id, workspace_id))
      WITH CHECK (current_user = %L AND %I.usage_allowance_capability_active(account_id, workspace_id))',
      t, owner_name, target_schema, owner_name, target_schema);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', t);
  END LOOP;
  EXECUTE format('CREATE POLICY usage_allowance_maintenance_inventory ON workspace_usage_allowances
    FOR SELECT USING (current_user=%L AND %I.usage_allowance_capability_active(NULL::uuid,NULL::uuid))',
    owner_name,target_schema);
  -- Exact read-only authority for immutable debit attribution and identity
  -- projection. No locking reads are used against these SELECT-only policies.
  FOREACH t IN ARRAY ARRAY['session_turns','scheduled_task_runs','sandbox_leases','usage_events']
  LOOP
    EXECUTE format('CREATE POLICY usage_allowance_owner_read ON %I FOR SELECT USING
      (current_user = %L AND %I.usage_allowance_capability_active(account_id, workspace_id))',
      t, owner_name, target_schema);
  END LOOP;
  EXECUTE format('CREATE POLICY usage_allowance_owner_read ON external_identities FOR SELECT USING
    (current_user = %L AND %I.usage_allowance_capability_active(account_id, NULL::uuid))',
    owner_name, target_schema);
  EXECUTE format('CREATE POLICY usage_allowance_owner_read ON organization_memberships FOR SELECT USING
    (current_user = %L AND %I.usage_allowance_capability_active(account_id,NULL::uuid))',
    owner_name,target_schema);
  FOREACH t IN ARRAY ARRAY['knowledge_index_jobs','knowledge_entries'] LOOP
    EXECUTE format('CREATE POLICY usage_allowance_owner_read ON %I FOR SELECT USING
      (current_user=%L AND %I.usage_allowance_capability_active(account_id,NULL::uuid))',
      t,owner_name,target_schema);
  END LOOP;
END $policies$;

-- A permissive read policy alone cannot bypass the separate restrictive
-- Only-me boundary. Attribute private turns without exposing their content:
-- admit only SELECT while this exact owner-held tenant capability is live.
-- Every write keeps its original restrictive predicate unchanged.
DO $private_turn_reads$
DECLARE
  t text; target_schema text:=current_schema(); owner_name text:=current_user;
  original_using text; original_check text; original_command "char"; expression text;
BEGIN
  FOREACH t IN ARRAY ARRAY['session_turns','scheduled_task_runs','usage_events'] LOOP
    SELECT pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid),p.polcmd
      INTO original_using,original_check,original_command FROM pg_policy p
      WHERE p.polrelid=format('%I.%I',target_schema,t)::regclass AND p.polname='session_visibility_isolation';
    IF original_using IS NULL OR original_command NOT IN ('*','r') THEN
      RAISE EXCEPTION '0542 unexpected restrictive visibility policy on %',t USING ERRCODE='55000';
    END IF;
    expression:=format('CASE WHEN current_user=%L AND %I.usage_allowance_capability_active(account_id,workspace_id)
      THEN true ELSE (%s) END',owner_name,target_schema,original_using);
    IF original_command='r' THEN
      EXECUTE format('ALTER POLICY session_visibility_isolation ON %I USING (%s)',t,expression);
    ELSE
      EXECUTE format('DROP POLICY session_visibility_isolation ON %I',t);
      EXECUTE format('CREATE POLICY session_visibility_isolation ON %I AS RESTRICTIVE FOR SELECT USING (%s)',t,expression);
      EXECUTE format('CREATE POLICY session_visibility_insert_isolation ON %I AS RESTRICTIVE FOR INSERT WITH CHECK (%s)',t,coalesce(original_check,original_using));
      EXECUTE format('CREATE POLICY session_visibility_update_isolation ON %I AS RESTRICTIVE FOR UPDATE USING (%s) WITH CHECK (%s)',t,original_using,coalesce(original_check,original_using));
      EXECUTE format('CREATE POLICY session_visibility_delete_isolation ON %I AS RESTRICTIVE FOR DELETE USING (%s)',t,original_using);
    END IF;
  END LOOP;
  SELECT pg_get_expr(p.polqual,p.polrelid) INTO original_using FROM pg_policy p
    WHERE p.polrelid='usage_events'::regclass AND p.polname='organization_usage_expected_visibility';
  IF original_using IS NULL THEN
    RAISE EXCEPTION '0542 missing usage receipt visibility policy' USING ERRCODE='55000';
  END IF;
  EXECUTE format('ALTER POLICY organization_usage_expected_visibility ON usage_events USING
    (CASE WHEN current_user=%L AND %I.usage_allowance_capability_active(account_id,workspace_id)
      THEN true ELSE (%s) END)',owner_name,target_schema,original_using);
END $private_turn_reads$;

CREATE FUNCTION usage_allowance_period(p_config jsonb, p_at timestamptz)
RETURNS TABLE (period_key text, start_at timestamptz, end_at timestamptz)
LANGUAGE plpgsql STABLE SET search_path FROM CURRENT AS $$
DECLARE
  month_start timestamp := date_trunc('month', p_at AT TIME ZONE 'UTC');
  anchor integer := coalesce((p_config->>'anchorDay')::integer, 1);
  first_start timestamp;
BEGIN
  IF p_config->>'period' = 'none' THEN
    RETURN QUERY SELECT '*', NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  first_start := month_start + make_interval(days => least(anchor,
    extract(day FROM month_start + interval '1 month - 1 day')::integer) - 1);
  IF p_at AT TIME ZONE 'UTC' < first_start THEN
    month_start := month_start - interval '1 month';
  END IF;
  RETURN QUERY SELECT to_char(month_start, 'YYYY-MM'),
    (month_start + make_interval(days => least(anchor,
      extract(day FROM month_start + interval '1 month - 1 day')::integer) - 1)) AT TIME ZONE 'UTC',
    (month_start + interval '1 month' + make_interval(days => least(anchor,
      extract(day FROM month_start + interval '2 months - 1 day')::integer) - 1)) AT TIME ZONE 'UTC';
END $$;

-- Canonical eligible-human set. Organization status is live; a Personal
-- workspace derives its owner from the explicit active membership pointer,
-- never creator/current-access/default-workspace labels.
CREATE FUNCTION usage_allowance_members(p_account uuid,p_workspace uuid)
RETURNS TABLE(subject_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  SELECT om.subject_id FROM organization_memberships om
  WHERE om.account_id=p_account AND om.status='active'
    AND om.subject_id !~ '^(service:|agent:|api[_-]?key:)'
    AND (om.subject_id LIKE 'user:%' OR EXISTS (
      SELECT 1 FROM external_identities e WHERE e.account_id=om.account_id
        AND e.subject_id=om.subject_id AND e.status='active'))
    AND (om.personal_workspace_id=p_workspace OR EXISTS (
      SELECT 1 FROM workspace_memberships m WHERE m.account_id=p_account
        AND m.workspace_id=p_workspace AND m.subject_id=om.subject_id))
  UNION SELECT 'dev' WHERE EXISTS (SELECT 1 FROM managed_accounts a
    JOIN workspace_memberships m ON m.account_id=a.id AND m.workspace_id=p_workspace AND m.subject_id='dev'
    WHERE a.id=p_account AND a.external_source='opengeni:local' AND a.external_id='default')
$$;

CREATE FUNCTION usage_allowance_effective_period(p_workspace uuid,p_config jsonb,p_at timestamptz)
RETURNS TABLE(period_key text,start_at timestamptz,end_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE saved workspace_usage_allowances%ROWTYPE; calculated record;
BEGIN
  SELECT * INTO saved FROM workspace_usage_allowances WHERE workspace_id=p_workspace;
  IF saved.active_period_key IS NOT NULL AND p_config->>'period'='none' THEN
    RETURN QUERY SELECT saved.active_period_key,saved.active_start_at,NULL::timestamptz;
    RETURN;
  END IF;
  IF saved.active_period_key IS NOT NULL AND saved.active_end_at IS NULL AND p_config->>'period'='monthly' THEN
    SELECT * INTO calculated FROM usage_allowance_period(p_config,p_at);
    RETURN QUERY SELECT saved.active_period_key,saved.active_start_at,calculated.end_at;
    RETURN;
  END IF;
  IF saved.active_period_key IS NOT NULL AND (saved.active_end_at IS NULL OR p_at<saved.active_end_at) THEN
    RETURN QUERY SELECT saved.active_period_key,saved.active_start_at,saved.active_end_at;
  ELSE
    SELECT * INTO calculated FROM usage_allowance_period(p_config,p_at);
    -- An anchor edit can make the next calculated month overlap the current
    -- accounting key. Extend that window instead of clearing its counters.
    RETURN QUERY SELECT calculated.period_key,
      CASE WHEN calculated.period_key=saved.active_period_key THEN saved.active_start_at ELSE calculated.start_at END,
      calculated.end_at;
  END IF;
END $$;

CREATE FUNCTION validate_usage_allowance_rule(p_rule jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
BEGIN
  IF p_rule IS NULL OR p_rule='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(p_rule)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rule))<>1 THEN RETURN false; END IF;
  IF p_rule ? 'credits' THEN
    RETURN jsonb_typeof(p_rule->'credits')='number' AND (p_rule->>'credits')::numeric BETWEEN 0 AND 9007199254740991
      AND trunc((p_rule->>'credits')::numeric)=(p_rule->>'credits')::numeric;
  END IF;
  RETURN coalesce(p_rule ? 'share' AND jsonb_typeof(p_rule->'share')='number' AND (p_rule->>'share')::numeric>=0,false);
END $$;
CREATE FUNCTION validate_usage_allowance_config(p_config jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE thresholds jsonb; threshold_item jsonb; default_rule jsonb;
BEGIN
  IF p_config IS NULL OR jsonb_typeof(p_config)<>'object' OR octet_length(p_config::text)>8192
    OR jsonb_typeof(p_config->'includedCredits') IS DISTINCT FROM 'number'
    OR coalesce(p_config->>'period','') NOT IN ('monthly','none') THEN RETURN false; END IF;
  IF NOT validate_usage_allowance_rule(jsonb_build_object('credits',p_config->'includedCredits')) THEN RETURN false; END IF;
  IF p_config ? 'anchorDay' AND (jsonb_typeof(p_config->'anchorDay')<>'number'
    OR (p_config->>'anchorDay')::numeric NOT BETWEEN 1 AND 31
    OR trunc((p_config->>'anchorDay')::numeric)<>(p_config->>'anchorDay')::numeric) THEN RETURN false; END IF;
  default_rule:=p_config->'memberDefault';
  IF default_rule IS NOT NULL AND default_rule NOT IN ('"none"'::jsonb,'"equal_share"'::jsonb)
    AND (default_rule='null'::jsonb OR NOT validate_usage_allowance_rule(default_rule)) THEN RETURN false; END IF;
  IF p_config ? 'thresholds' THEN
    IF jsonb_typeof(p_config->'thresholds')<>'object' THEN RETURN false; END IF;
    FOR thresholds IN SELECT item.value FROM jsonb_each(p_config->'thresholds') item LOOP
      IF jsonb_typeof(thresholds)<>'array' OR jsonb_array_length(thresholds)>16 THEN RETURN false; END IF;
      FOR threshold_item IN SELECT jsonb_array_elements(thresholds) LOOP
        IF jsonb_typeof(threshold_item)<>'number' OR (threshold_item#>>'{}')::numeric<=0 OR (threshold_item#>>'{}')::numeric>1 THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION capture_usage_allowance_period(p_account uuid,p_workspace uuid,p_config jsonb,p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE period_row record;
BEGIN
  SELECT * INTO period_row FROM usage_allowance_effective_period(p_workspace,p_config,p_at);
  INSERT INTO workspace_allowance_periods
    (account_id,workspace_id,period_key,config,start_at,end_at,grants_remaining,member_count,grants_snapshot,member_rules)
  SELECT p_account,p_workspace,period_row.period_key,p_config,period_row.start_at,period_row.end_at,
    coalesce((SELECT sum(remaining) FROM workspace_allowance_grants WHERE workspace_id=p_workspace
      AND (expires_at IS NULL OR expires_at>p_at)),0),
    (SELECT count(*) FROM usage_allowance_members(p_account,p_workspace)),
    coalesce((SELECT jsonb_agg(jsonb_build_object('remaining',remaining,'expiresAt',expires_at))
      FROM workspace_allowance_grants WHERE workspace_id=p_workspace AND remaining>0),'[]'::jsonb),
    coalesce((SELECT jsonb_object_agg(m.subject_id,jsonb_build_object('rule',rules.rule,'version',coalesce(rules.version,0)))
      FROM usage_allowance_members(p_account,p_workspace) m LEFT JOIN workspace_member_allowances rules
        ON rules.workspace_id=p_workspace AND rules.subject_id=m.subject_id),'{}'::jsonb)
  ON CONFLICT (workspace_id,period_key) DO UPDATE SET config=excluded.config,
    start_at=excluded.start_at,end_at=excluded.end_at,grants_remaining=excluded.grants_remaining,
    member_count=excluded.member_count,grants_snapshot=excluded.grants_snapshot,
    member_rules=excluded.member_rules,updated_at=now()
    WHERE workspace_allowance_periods.closed_at IS NULL;
END $$;

CREATE FUNCTION emit_usage_allowance_notifications(p_account uuid,p_workspace uuid,p_config jsonb,p_period text,p_end timestamptz,p_subject text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE c record; threshold_value numeric; member_rule jsonb; pool bigint; grant_remaining bigint;
  member_count integer; cap numeric; event_name text; payload_value jsonb; receipt_id uuid; event_id_value uuid;
BEGIN
  IF p_config IS NULL THEN RETURN; END IF;
  SELECT coalesce(sum(remaining),0) INTO grant_remaining FROM workspace_allowance_grants
    WHERE workspace_id=p_workspace AND (expires_at IS NULL OR expires_at>clock_timestamp());
  SELECT count(*) INTO member_count FROM usage_allowance_members(p_account,p_workspace);
  pool:=(p_config->>'includedCredits')::bigint+grant_remaining;
  IF p_config->>'period'='monthly' AND EXISTS (SELECT 1 FROM workspace_allowance_periods
    WHERE workspace_id=p_workspace AND period_key<>p_period AND closed_at IS NOT NULL) THEN
    payload_value:=jsonb_build_object('workspaceId',p_workspace,'period',p_period,'resetsAt',p_end);
    INSERT INTO workspace_allowance_notifications (account_id,workspace_id,period_key,subject_id,threshold,payload)
      VALUES (p_account,p_workspace,p_period,'',-1,payload_value)
      ON CONFLICT DO NOTHING RETURNING id INTO receipt_id;
    IF receipt_id IS NOT NULL THEN
      INSERT INTO workspace_webhook_deliveries (account_id,workspace_id,webhook_id,event_id,event_type,payload)
      SELECT p_account,p_workspace,h.id,receipt_id,'usage.period_reset',
        jsonb_build_object('id',receipt_id,'type','usage.period_reset','workspaceId',p_workspace,
          'occurredAt',clock_timestamp(),'data',payload_value)
      FROM workspace_webhooks h WHERE h.workspace_id=p_workspace AND h.enabled AND 'usage.period_reset'=ANY(h.event_types)
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  FOR c IN SELECT counter.*,rules.rule FROM workspace_allowance_counters counter
    LEFT JOIN workspace_member_allowances rules ON rules.workspace_id=counter.workspace_id AND rules.subject_id=counter.subject_id
    WHERE counter.workspace_id=p_workspace AND counter.period_key=p_period
      AND counter.subject_id IN ('',coalesce(p_subject,''))
      AND (counter.subject_id='' OR EXISTS (SELECT 1 FROM usage_allowance_members(p_account,p_workspace) m
        WHERE m.subject_id=counter.subject_id))
  LOOP
    IF c.subject_id='' THEN
      cap:=pool+c.grants_used;
    ELSE
      member_rule:=coalesce(c.rule,p_config->'memberDefault','"none"'::jsonb);
      IF member_rule='"none"'::jsonb THEN CONTINUE; END IF;
      cap:=CASE WHEN member_rule='"equal_share"'::jsonb THEN floor(pool/greatest(member_count,1)::numeric)
        WHEN member_rule ? 'credits' THEN (member_rule->>'credits')::numeric
        ELSE floor(pool*(member_rule->>'share')::numeric) END;
    END IF;
    FOR threshold_value IN SELECT DISTINCT threshold FROM (
      SELECT (t#>>'{}')::numeric threshold FROM jsonb_array_elements(
        coalesce(p_config#>ARRAY['thresholds',CASE WHEN c.subject_id='' THEN 'workspace' ELSE 'member' END],'[0.8,1]'::jsonb)) t
      UNION SELECT 1::numeric
    ) thresholds
    LOOP
      IF c.used < cap*threshold_value THEN CONTINUE; END IF;
      receipt_id:=NULL;
      event_name:=CASE WHEN threshold_value=1 THEN 'usage.exhausted' ELSE 'usage.threshold_reached' END;
      payload_value:=jsonb_build_object('scope',CASE WHEN c.subject_id='' THEN 'workspace' ELSE 'member' END,
        'subjectId',nullif(c.subject_id,''),'period',p_period,'limit',cap,'used',c.used,
        'fraction',CASE WHEN cap=0 THEN 1 ELSE c.used/cap END,'threshold',threshold_value,'resetsAt',p_end);
      INSERT INTO workspace_allowance_notifications (account_id,workspace_id,period_key,subject_id,threshold,payload)
        VALUES (p_account,p_workspace,p_period,c.subject_id,threshold_value,payload_value)
        ON CONFLICT DO NOTHING RETURNING id INTO receipt_id;
      IF receipt_id IS NOT NULL THEN
        INSERT INTO workspace_webhook_deliveries (account_id,workspace_id,webhook_id,event_id,event_type,payload)
        SELECT p_account,p_workspace,h.id,receipt_id,event_name,
          jsonb_build_object('id',receipt_id,'type',event_name,'workspaceId',p_workspace,
            'occurredAt',clock_timestamp(),'data',payload_value)
        FROM workspace_webhooks h WHERE h.workspace_id=p_workspace AND h.enabled AND event_name=ANY(h.event_types)
        ON CONFLICT DO NOTHING;
        IF threshold_value=1 THEN
          event_id_value:=gen_random_uuid();
          INSERT INTO workspace_webhook_deliveries (account_id,workspace_id,webhook_id,event_id,event_type,payload)
          SELECT p_account,p_workspace,h.id,event_id_value,'usage.threshold_reached',
            jsonb_build_object('id',event_id_value,'type','usage.threshold_reached','workspaceId',p_workspace,
              'occurredAt',clock_timestamp(),'data',payload_value)
          FROM workspace_webhooks h WHERE h.workspace_id=p_workspace AND h.enabled AND 'usage.threshold_reached'=ANY(h.event_types);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE FUNCTION usage_allowance_command(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  a uuid := (p_input->>'accountId')::uuid;
  w uuid := (p_input->>'workspaceId')::uuid;
  action text := p_input->>'action';
  subject text := p_input->>'subjectId';
  expected bigint := (p_input->>'expectedVersion')::bigint;
  prior workspace_usage_allowances%ROWTYPE;
  member_prior workspace_member_allowances%ROWTYPE;
  grant_prior workspace_allowance_grants%ROWTYPE;
  v bigint;
  opened integer;
  result jsonb;
  period_row record;
  as_of timestamptz := clock_timestamp();
  read_config jsonb; historical workspace_allowance_periods%ROWTYPE;
  historical_read boolean:=false;
  data_schema text := (SELECT n.nspname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE t.oid='workspace_usage_allowances'::regclass);
BEGIN
  IF opengeni_private.workspace_rls_visible(a, w) IS DISTINCT FROM true OR a IS NULL OR w IS NULL THEN
    RAISE EXCEPTION 'allowance workspace scope denied' USING ERRCODE = '42501';
  END IF;
  IF action IN ('set','clear','member','grant') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:'||a::text,0));
    IF p_input->>'actorType' NOT IN ('subject','human_session','api_key')
      OR p_input->>'actorSubjectId' IS DISTINCT FROM opengeni_private.current_subject_id() THEN
      RAISE EXCEPTION 'allowance actor scope denied' USING ERRCODE='42501';
    END IF;
    IF (action<>'member' OR p_input->>'actorSubjectId' LIKE 'api_key:%') AND NOT
      (p_input->>'actorSubjectId'='dev' AND p_input->>'actorType' IN ('subject','human_session')
        AND EXISTS (SELECT 1 FROM managed_accounts local_account WHERE local_account.id=a
          AND local_account.external_source='opengeni:local' AND local_account.external_id='default')) THEN
      PERFORM opengeni_private.assert_organization_administrator(a,p_input->>'actorSubjectId');
      IF p_input->>'actorSubjectId' LIKE 'api_key:%' AND NOT EXISTS (
        SELECT 1 FROM api_keys k WHERE k.account_id=a AND 'api_key:'||k.id::text=p_input->>'actorSubjectId'
          AND k.credential_kind='organization' AND k.workspace_id IS NULL AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
          AND k.permissions ? 'workspace:admin' AND k.permissions ? 'api_keys:manage'
      ) THEN RAISE EXCEPTION 'full organization key required' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  -- Preserve the canonical workspace-prefix order before the FK pins taken
  -- by counter/policy inserts. Otherwise a workspace writer waiting for this
  -- fence can deadlock with a policy writer waiting for its workspace pin.
  PERFORM 1 FROM workspaces WHERE id=w AND account_id=a FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'allowance workspace not found' USING ERRCODE='23503'; END IF;
  -- One fence shared by policy mutations, reads and ledger counters.
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:' || w::text, 0));
  INSERT INTO opengeni_private.usage_allowance_capabilities
    VALUES (pg_backend_pid(), pg_current_xact_id(), data_schema, a, w)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  SELECT * INTO prior FROM workspace_usage_allowances WHERE workspace_id = w AND account_id = a;
  IF action='member' AND p_input->>'actorSubjectId' NOT LIKE 'api_key:%'
    AND NOT (p_input->>'actorSubjectId'='dev' AND EXISTS (SELECT 1 FROM managed_accounts local_account
      WHERE local_account.id=a AND local_account.external_source='opengeni:local' AND local_account.external_id='default'))
    AND NOT EXISTS (SELECT 1 FROM organization_memberships personal_owner
      WHERE personal_owner.account_id=a AND personal_owner.status='active'
        AND personal_owner.subject_id=p_input->>'actorSubjectId' AND personal_owner.personal_workspace_id=w)
    AND NOT EXISTS (
    SELECT 1 FROM workspace_memberships m JOIN organization_memberships om
      ON om.account_id=m.account_id AND om.subject_id=m.subject_id AND om.status='active'
    WHERE m.workspace_id=w AND m.subject_id=p_input->>'actorSubjectId'
      AND (m.role IN ('owner','admin') OR m.permissions ? 'workspace:admin')
  ) THEN RAISE EXCEPTION 'workspace administrator required' USING ERRCODE='42501'; END IF;
  -- Snapshot the pre-edit period before changing an anchor/config/pool.
  IF action IN ('set','clear','member','grant') AND prior.config IS NOT NULL THEN
    PERFORM capture_usage_allowance_period(a,w,prior.config,as_of);
  END IF;
  IF action IN ('set','clear','member','grant') THEN
    IF octet_length(coalesce(p_input->>'actorSubjectId','')) NOT BETWEEN 1 AND 1024
      OR octet_length(coalesce(p_input->>'actorType','')) NOT BETWEEN 1 AND 128 THEN
      RAISE EXCEPTION 'allowance actor required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = w AND account_id = a) THEN
      RAISE EXCEPTION 'allowance workspace not found' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF action IN ('set','clear') THEN
    IF action='set' AND validate_usage_allowance_config(p_input->'config') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'invalid allowance config' USING ERRCODE='22023';
    END IF;
    IF expected IS NULL OR expected < 0 OR
      (action='clear' AND expected=0) OR
      (expected = 0 AND prior.version IS NOT NULL) OR
      (expected <> 0 AND expected <> coalesce(prior.version, 0)) THEN
      RAISE EXCEPTION 'allowance version conflict' USING ERRCODE = '40001';
    END IF;
    v := coalesce(prior.version, 0) + 1;
    INSERT INTO workspace_usage_allowances
      (workspace_id, account_id, config, version, actor_subject_id, actor_type)
    VALUES (w, a, CASE WHEN action = 'set' THEN p_input->'config' END, v,
      p_input->>'actorSubjectId', p_input->>'actorType')
    ON CONFLICT (workspace_id) DO UPDATE SET config = excluded.config,
      version = excluded.version, actor_subject_id = excluded.actor_subject_id,
      actor_type = excluded.actor_type, updated_at = now();
    result := CASE WHEN action = 'set'
      THEN (p_input->'config') || jsonb_build_object('version', v)
      ELSE jsonb_build_object('version', v) END;
  ELSIF action = 'member' THEN
    IF p_input ? 'externalIdentity' THEN
      IF subject IS NOT NULL OR jsonb_typeof(p_input->'externalIdentity') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'ambiguous allowance member identity' USING ERRCODE='22023';
      END IF;
      SELECT identity.subject_id INTO subject FROM external_identities identity
        JOIN usage_allowance_members(a,w) eligible ON eligible.subject_id=identity.subject_id
      WHERE identity.account_id=a AND identity.source=p_input#>>'{externalIdentity,source}'
        AND identity.external_id=p_input#>>'{externalIdentity,externalId}'
        AND identity.status='active';
      IF NOT FOUND THEN RAISE EXCEPTION 'active allowance member not found' USING ERRCODE='23503'; END IF;
    END IF;
    IF validate_usage_allowance_rule(p_input->'rule') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'invalid member allowance rule' USING ERRCODE='22023';
    END IF;
    IF octet_length(coalesce(subject,'')) NOT BETWEEN 1 AND 1024 THEN
      RAISE EXCEPTION 'allowance subject required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM usage_allowance_members(a,w) eligible WHERE eligible.subject_id=subject)
    THEN RAISE EXCEPTION 'active allowance member required' USING ERRCODE='23503'; END IF;
    SELECT * INTO member_prior FROM workspace_member_allowances WHERE workspace_id = w AND subject_id = subject;
    IF expected IS NULL OR expected <> coalesce(member_prior.version, 0) THEN
      RAISE EXCEPTION 'member allowance version conflict' USING ERRCODE = '40001';
    END IF;
    v := coalesce(member_prior.version, 0) + 1;
    INSERT INTO workspace_member_allowances
      (workspace_id, account_id, subject_id, rule, version, actor_subject_id, actor_type)
    VALUES (w, a, subject, nullif(p_input->'rule','null'::jsonb), v,
      p_input->>'actorSubjectId', p_input->>'actorType')
    ON CONFLICT (workspace_id, subject_id) DO UPDATE SET rule = excluded.rule,
      version = excluded.version, actor_subject_id = excluded.actor_subject_id,
      actor_type = excluded.actor_type, updated_at = now();
    result := jsonb_build_object('subjectId', subject, 'rule', p_input->'rule', 'version', v);
  ELSIF action = 'grant' THEN
    IF coalesce(p_input->>'operationId','')='' OR
      validate_usage_allowance_rule(jsonb_build_object('credits',p_input->'credits')) IS DISTINCT FROM true
      OR (p_input->>'credits')::numeric<=0 THEN
      RAISE EXCEPTION 'invalid allowance grant' USING ERRCODE='22023';
    END IF;
    SELECT * INTO grant_prior FROM workspace_allowance_grants
      WHERE workspace_id = w AND operation_id = p_input->>'operationId';
    IF FOUND THEN
      IF grant_prior.credits <> (p_input->>'credits')::bigint
        OR grant_prior.expires_at IS DISTINCT FROM (p_input->>'expiresAt')::timestamptz THEN
        RAISE EXCEPTION 'allowance grant operation conflict' USING ERRCODE = '23505';
      END IF;
    ELSE
      INSERT INTO workspace_allowance_grants
        (workspace_id, account_id, operation_id, credits, remaining, expires_at, actor_subject_id, actor_type)
      VALUES (w, a, p_input->>'operationId', (p_input->>'credits')::bigint,
        (p_input->>'credits')::bigint, (p_input->>'expiresAt')::timestamptz,
        p_input->>'actorSubjectId', p_input->>'actorType')
      RETURNING * INTO grant_prior;
    END IF;
    result := jsonb_build_object('operationId', grant_prior.operation_id,
      'credits', grant_prior.credits, 'remaining', grant_prior.remaining, 'expiresAt', grant_prior.expires_at);
  ELSIF action = 'get' THEN
    result := CASE WHEN prior.config IS NULL THEN NULL ELSE prior.config || jsonb_build_object('version', prior.version) END;
  ELSIF action IN ('usage','check') THEN
    read_config:=prior.config;
    historical_read:=coalesce(p_input->>'period','current')<>'current' AND
      p_input->>'period' IS DISTINCT FROM (SELECT period_key FROM usage_allowance_effective_period(w,prior.config,clock_timestamp()));
    IF coalesce(p_input->>'period','current') <> 'current' THEN
      IF p_input->>'period' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION 'invalid allowance period' USING ERRCODE = '22023';
      END IF;
      IF historical_read THEN
        as_of := ((p_input->>'period') || '-01')::timestamp AT TIME ZONE 'UTC'
          + make_interval(days => least(coalesce((prior.config->>'anchorDay')::integer,1),
            extract(day FROM ((p_input->>'period') || '-01')::timestamp + interval '1 month - 1 day')::integer) - 1);
      END IF;
    END IF;
    SELECT * INTO period_row FROM usage_allowance_effective_period(w,prior.config, as_of);
    IF historical_read THEN
      SELECT * INTO historical FROM workspace_allowance_periods WHERE workspace_id=w
        AND period_key=p_input->>'period';
      read_config:=historical.config;
      IF FOUND THEN
        period_row.start_at:=historical.start_at; period_row.end_at:=historical.end_at;
        period_row.period_key:=historical.period_key;
      ELSE
        read_config:=NULL;
        -- Missing history is unknown, never the active accounting window.
        -- In particular a current nonrenewing pot must not answer an old
        -- YYYY-MM request with today's counters.
        period_row.period_key:=p_input->>'period';
        period_row.start_at:=NULL;
        period_row.end_at:=NULL;
      END IF;
    END IF;
    SELECT jsonb_build_object(
      'config', read_config, 'period', jsonb_build_object('start',period_row.start_at,'end',period_row.end_at),
      'used', coalesce((SELECT used FROM workspace_allowance_counters WHERE workspace_id=w AND period_key=period_row.period_key AND subject_id=''),0),
      'includedUsed', coalesce((SELECT included_used FROM workspace_allowance_counters WHERE workspace_id=w AND period_key=period_row.period_key AND subject_id=''),0),
      'grantsUsed', coalesce((SELECT grants_used FROM workspace_allowance_counters WHERE workspace_id=w AND period_key=period_row.period_key AND subject_id=''),0),
      'grantsRemaining', CASE WHEN historical_read THEN coalesce((SELECT sum((g->>'remaining')::bigint)
        FROM jsonb_array_elements(historical.grants_snapshot) g WHERE g->>'expiresAt' IS NULL
          OR (g->>'expiresAt')::timestamptz>coalesce(historical.end_at,historical.updated_at)),0)
        ELSE coalesce((SELECT sum(remaining) FROM workspace_allowance_grants WHERE workspace_id=w AND (expires_at IS NULL OR expires_at > clock_timestamp())),0) END,
      'memberCount', CASE WHEN historical_read THEN coalesce(historical.member_count,0)
        ELSE (SELECT count(*) FROM usage_allowance_members(a,w)) END,
      'members', coalesce((SELECT jsonb_agg(row_data ORDER BY row_data->>'subjectId') FROM (
        SELECT jsonb_build_object('subjectId', subjects.subject_id,
          'rule', CASE WHEN historical_read THEN historical.member_rules#>ARRAY[subjects.subject_id,'rule'] ELSE rules.rule END,
          'version', CASE WHEN historical_read THEN coalesce((historical.member_rules#>>ARRAY[subjects.subject_id,'version'])::bigint,0)
            ELSE coalesce(rules.version,0) END, 'used',coalesce(counter.used,0),
          'externalIdentity', CASE WHEN action='check' THEN NULL ELSE (SELECT jsonb_build_object('source',e.source,'externalId',e.external_id)
            FROM external_identities e WHERE e.account_id=a AND e.subject_id=subjects.subject_id) END) row_data
        FROM (
          SELECT eligible.subject_id FROM usage_allowance_members(a,w) eligible WHERE action<>'check' AND NOT historical_read
          UNION SELECT subject WHERE subject IS NOT NULL AND EXISTS (
            SELECT 1 FROM usage_allowance_members(a,w) eligible WHERE eligible.subject_id=subject)
          UNION SELECT jsonb_object_keys(historical.member_rules) WHERE historical_read AND action<>'check'
          UNION SELECT subject_id FROM workspace_allowance_counters WHERE workspace_id=w
            AND period_key=period_row.period_key AND subject_id<>'' AND historical_read AND action<>'check'
        ) subjects
        LEFT JOIN workspace_member_allowances rules ON rules.workspace_id=w AND rules.subject_id=subjects.subject_id
        LEFT JOIN workspace_allowance_counters counter ON counter.workspace_id=w AND counter.period_key=period_row.period_key AND counter.subject_id=subjects.subject_id
        WHERE (subject IS NULL OR subjects.subject_id=subject)
          AND (p_input->>'cursor' IS NULL OR subjects.subject_id > p_input->>'cursor')
        ORDER BY subjects.subject_id LIMIT least(greatest(coalesce((p_input->>'limit')::integer,100),1),500)+1
      ) page), '[]'::jsonb)
    ) INTO result;
  ELSE
    RAISE EXCEPTION 'invalid allowance action' USING ERRCODE = '22023';
  END IF;
  IF action IN ('set','grant','member') THEN
    SELECT config INTO read_config FROM workspace_usage_allowances WHERE workspace_id=w;
    IF read_config IS NOT NULL THEN
      SELECT * INTO period_row FROM usage_allowance_effective_period(w,read_config,clock_timestamp());
      IF prior.active_period_key IS NOT NULL AND prior.active_period_key IS DISTINCT FROM period_row.period_key THEN
        UPDATE workspace_allowance_periods SET closed_at=coalesce(prior.active_end_at,clock_timestamp())
          WHERE workspace_id=w AND period_key=prior.active_period_key AND closed_at IS NULL;
      END IF;
      UPDATE workspace_usage_allowances SET
        active_period_key=period_row.period_key,active_start_at=period_row.start_at,active_end_at=period_row.end_at,
        maintenance_next_at=clock_timestamp(),maintenance_cursor=NULL WHERE workspace_id=w;
      PERFORM capture_usage_allowance_period(a,w,read_config,clock_timestamp());
    END IF;
  END IF;
  IF opened = 1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities WHERE backend_pid=pg_backend_pid()
      AND transaction_id=pg_current_xact_id_if_assigned()
      AND usage_allowance_capabilities.data_schema=usage_allowance_command.data_schema AND workspace_id=w;
  END IF;
  RETURN result;
END $$;

-- Cross-workspace periodic maintenance is an EXECUTE-only capability. Inventory
-- uses an owner-only global stamp; each mutation uses its own exact tenant stamp.
-- Failed notification pages roll back their receipts and retry later, not skip.
CREATE FUNCTION maintain_usage_allowances(p_limit integer,p_member_limit integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  target record; saved workspace_usage_allowances%ROWTYPE; p record; member_row record;
  opened integer; tenant_opened integer; processed integer:=0; seen integer;
  last_subject text; previous_account text:=current_setting('opengeni.account_id',true);
  previous_workspace text:=current_setting('opengeni.workspace_id',true);
  data_schema text:=(SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid='workspace_usage_allowances'::regclass);
  member_limit integer:=greatest(1,least(coalesce(p_member_limit,100),200));
BEGIN
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES(pg_backend_pid(),pg_current_xact_id(),
    data_schema,'00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened=ROW_COUNT;
  FOR target IN SELECT account_id,workspace_id FROM workspace_usage_allowances
    WHERE config IS NOT NULL AND maintenance_next_at<=clock_timestamp()
    ORDER BY maintenance_next_at,workspace_id LIMIT greatest(1,least(coalesce(p_limit,20),100))
  LOOP
    PERFORM set_config('opengeni.account_id',target.account_id::text,true);
    PERFORM set_config('opengeni.workspace_id',target.workspace_id::text,true);
    PERFORM 1 FROM workspaces WHERE id=target.workspace_id AND account_id=target.account_id FOR KEY SHARE;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:'||target.workspace_id::text,0));
    INSERT INTO opengeni_private.usage_allowance_capabilities VALUES(pg_backend_pid(),pg_current_xact_id(),
      data_schema,target.account_id,target.workspace_id) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS tenant_opened=ROW_COUNT;
    BEGIN
      SELECT * INTO saved FROM workspace_usage_allowances WHERE workspace_id=target.workspace_id;
      IF saved.config IS NOT NULL AND saved.maintenance_next_at<=clock_timestamp() THEN
        SELECT * INTO p FROM usage_allowance_effective_period(target.workspace_id,saved.config,clock_timestamp());
        IF saved.active_period_key IS DISTINCT FROM p.period_key THEN
          UPDATE workspace_allowance_periods SET closed_at=coalesce(saved.active_end_at,clock_timestamp())
            WHERE workspace_id=target.workspace_id AND period_key=saved.active_period_key AND closed_at IS NULL;
          saved.maintenance_cursor:=NULL;
        END IF;
        UPDATE workspace_usage_allowances SET active_period_key=p.period_key,active_start_at=p.start_at,
          active_end_at=p.end_at WHERE workspace_id=target.workspace_id;
        PERFORM capture_usage_allowance_period(target.account_id,target.workspace_id,saved.config,clock_timestamp());
        INSERT INTO workspace_allowance_counters(account_id,workspace_id,period_key,subject_id)
          VALUES(target.account_id,target.workspace_id,p.period_key,'') ON CONFLICT DO NOTHING;
        PERFORM emit_usage_allowance_notifications(target.account_id,target.workspace_id,saved.config,p.period_key,p.end_at,NULL);
        seen:=0; last_subject:=NULL;
        FOR member_row IN SELECT subject_id FROM usage_allowance_members(target.account_id,target.workspace_id)
          WHERE saved.maintenance_cursor IS NULL OR subject_id>saved.maintenance_cursor
          ORDER BY subject_id LIMIT member_limit+1
        LOOP
          seen:=seen+1;
          EXIT WHEN seen>member_limit;
          INSERT INTO workspace_allowance_counters(account_id,workspace_id,period_key,subject_id)
            VALUES(target.account_id,target.workspace_id,p.period_key,member_row.subject_id) ON CONFLICT DO NOTHING;
          PERFORM emit_usage_allowance_notifications(target.account_id,target.workspace_id,saved.config,
            p.period_key,p.end_at,member_row.subject_id);
          last_subject:=member_row.subject_id;
        END LOOP;
        UPDATE workspace_usage_allowances SET maintenance_cursor=CASE WHEN seen>member_limit THEN last_subject END,
          maintenance_next_at=clock_timestamp()+CASE WHEN seen>member_limit THEN interval '1 second' ELSE interval '1 minute' END,
          maintenance_error=NULL WHERE workspace_id=target.workspace_id;
        processed:=processed+1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE workspace_usage_allowances SET maintenance_next_at=clock_timestamp()+interval '1 minute',
        maintenance_error=SQLSTATE WHERE workspace_id=target.workspace_id;
    END;
    IF tenant_opened=1 THEN DELETE FROM opengeni_private.usage_allowance_capabilities
      WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
        AND usage_allowance_capabilities.data_schema=maintain_usage_allowances.data_schema
        AND workspace_id=target.workspace_id; END IF;
  END LOOP;
  IF opened=1 THEN DELETE FROM opengeni_private.usage_allowance_capabilities
    WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
      AND usage_allowance_capabilities.data_schema=maintain_usage_allowances.data_schema
      AND workspace_id='00000000-0000-0000-0000-000000000000'::uuid; END IF;
  PERFORM set_config('opengeni.account_id',coalesce(previous_account,''),true);
  PERFORM set_config('opengeni.workspace_id',coalesce(previous_workspace,''),true);
  RETURN processed;
END $$;

CREATE FUNCTION count_workspace_allowance_debit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  cfg jsonb; p record; c workspace_allowance_counters%ROWTYPE; g record;
  human text; candidate text; amount bigint := -NEW.amount_micros;
  attribution jsonb; billing_workspace uuid;
  included bigint := 0; grant_used bigint := 0; pending bigint;
  opened integer;
BEGIN
  IF NEW.workspace_id IS NULL OR NEW.amount_micros >= 0 THEN RETURN NULL; END IF;
  PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id AND account_id=NEW.account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'allowance debit workspace mismatch' USING ERRCODE='23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('usage-allowance:' || NEW.workspace_id::text,0));
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES
    (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,NEW.account_id,NEW.workspace_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;
  SELECT config INTO cfg FROM workspace_usage_allowances WHERE workspace_id=NEW.workspace_id;
  -- Settlement time, not caller-supplied occurred_at, decides pool expiry and
  -- period. Late settlements cannot spend an already expired historical pool.
  SELECT * INTO p FROM usage_allowance_effective_period(NEW.workspace_id,cfg, clock_timestamp());
  SELECT * INTO c FROM workspace_allowance_counters
    WHERE workspace_id=NEW.workspace_id AND period_key=p.period_key AND subject_id='';
  IF cfg IS NOT NULL THEN
    included := least(amount,greatest(0,(cfg->>'includedCredits')::bigint-
      (coalesce(c.used,0)-coalesce(c.grants_used,0))));
    pending := amount-included;
    FOR g IN SELECT * FROM workspace_allowance_grants WHERE workspace_id=NEW.workspace_id
      AND remaining>0 AND (expires_at IS NULL OR expires_at>clock_timestamp())
      ORDER BY expires_at NULLS LAST,created_at,operation_id
    LOOP
      EXIT WHEN pending=0;
      UPDATE workspace_allowance_grants SET remaining=remaining-least(pending,g.remaining)
        WHERE workspace_id=NEW.workspace_id AND operation_id=g.operation_id;
      grant_used := grant_used+least(pending,g.remaining);
      pending := pending-least(pending,g.remaining);
    END LOOP;
  END IF;
  INSERT INTO workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used,included_used,grants_used)
    VALUES (NEW.workspace_id,NEW.account_id,p.period_key,'',amount,included,grant_used)
  ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET
    used=workspace_allowance_counters.used+excluded.used,
    included_used=workspace_allowance_counters.included_used+excluded.included_used,
    grants_used=workspace_allowance_counters.grants_used+excluded.grants_used;
  -- Exact source receipts take precedence over caller metadata. to_jsonb
  -- allows 0542 to coexist with old writers until 0543 adds the immutable
  -- attribution column; absent legacy receipts remain workspace-only.
  IF NEW.source_type='knowledge_query' THEN
    SELECT receipt.initiator_context->'creditDebitAttribution' INTO attribution FROM usage_events receipt
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.source_resource_type='knowledge_query' AND receipt.source_resource_id=NEW.source_id
      AND receipt.event_type='document.query_embedding_cost'
      AND receipt.idempotency_key='knowledge.query_cost:'||NEW.source_id
      AND receipt.quantity=amount;
  ELSIF NEW.source_type='knowledge_revision' AND NEW.source_id ~* '^[0-9a-f-]{36}$' THEN
    SELECT to_jsonb(j)->'billing_attribution',
      CASE WHEN e.scope='personal' THEN coalesce(
        (SELECT om.personal_workspace_id FROM organization_memberships om
          WHERE om.account_id=e.account_id AND om.subject_id=e.scope_subject_id AND om.status='active'),
        e.origin_workspace_id) ELSE e.origin_workspace_id END
      INTO attribution,billing_workspace
    FROM knowledge_index_jobs j JOIN knowledge_entries e
      ON e.id=j.entry_id AND e.account_id=j.account_id
    WHERE j.account_id=NEW.account_id AND j.revision_id=NEW.source_id::uuid;
    IF billing_workspace IS DISTINCT FROM NEW.workspace_id THEN attribution:=NULL; END IF;
  ELSIF NEW.source_type='sandbox_lease' AND split_part(NEW.source_id,':',1) ~* '^[0-9a-f-]{36}$'
    AND split_part(NEW.source_id,':',2) ~ '^[0-9]+$' THEN
    SELECT lease.resume_state#>'{opengeniWarmBilling,attribution}' INTO attribution
    FROM sandbox_leases lease WHERE lease.account_id=NEW.account_id AND lease.workspace_id=NEW.workspace_id
      AND lease.sandbox_group_id=split_part(NEW.source_id,':',1)::uuid
      AND lease.lease_epoch=split_part(NEW.source_id,':',2)::integer;
  END IF;
  -- Verified source receipts freeze the causal human alongside the turn.
  -- Personal Knowledge can outlive/rebind away from the turn's workspace;
  -- its retained receipt remains authoritative without widening turn reads.
  IF attribution->>'kind' IN ('human','turn') THEN human:=attribution->>'initiatingHumanSubjectId'; END IF;
  candidate := CASE WHEN attribution->>'kind'='turn' THEN attribution->>'turnId'
    WHEN attribution IS NOT NULL THEN NULL
    WHEN NEW.source_type IN ('session_turn','model_response')
    THEN split_part(NEW.source_id,':',1) ELSE NEW.metadata->>'turnId' END;
  IF human IS NULL AND candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT initiating_human_subject_id INTO human FROM session_turns
      WHERE id=candidate::uuid AND workspace_id=NEW.workspace_id AND account_id=NEW.account_id;
  END IF;
  IF human IS NULL AND NEW.source_type='scheduled_task_run'
    AND NEW.source_id ~* '^[0-9a-f-]{36}$' THEN
    SELECT run.accepted_execution_snapshot->>'causalHumanSubjectId' INTO human FROM scheduled_task_runs run
      WHERE run.id=NEW.source_id::uuid AND run.workspace_id=NEW.workspace_id;
  END IF;
  IF human IS NOT NULL THEN
    INSERT INTO workspace_allowance_counters (workspace_id,account_id,period_key,subject_id,used)
      VALUES (NEW.workspace_id,NEW.account_id,p.period_key,human,amount)
    ON CONFLICT (workspace_id,period_key,subject_id) DO UPDATE SET used=workspace_allowance_counters.used+excluded.used;
  END IF;
  PERFORM capture_usage_allowance_period(NEW.account_id,NEW.workspace_id,cfg,clock_timestamp());
  UPDATE workspace_usage_allowances SET maintenance_next_at=least(maintenance_next_at,clock_timestamp())
    WHERE workspace_id=NEW.workspace_id;
  IF opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities WHERE backend_pid=pg_backend_pid()
      AND transaction_id=pg_current_xact_id_if_assigned() AND data_schema=TG_TABLE_SCHEMA AND workspace_id=NEW.workspace_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER credit_ledger_allowance_debit AFTER INSERT ON credit_ledger_entries
FOR EACH ROW WHEN (NEW.amount_micros < 0 AND NEW.workspace_id IS NOT NULL)
EXECUTE FUNCTION count_workspace_allowance_debit();

REVOKE ALL ON FUNCTION usage_allowance_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION usage_allowance_period(jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION count_workspace_allowance_debit() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_usage_allowance_rule(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_usage_allowance_config(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION usage_allowance_members(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION usage_allowance_effective_period(uuid,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION maintain_usage_allowances(integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION capture_usage_allowance_period(uuid,uuid,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION emit_usage_allowance_notifications(uuid,uuid,jsonb,text,timestamptz,text) FROM PUBLIC;
-- Strip hostile defaults for every internal table/routine, and grant the
-- additive command to the exact existing ledger writers during rolling deploy.
DO $acl$
DECLARE role_name text; object_name text; function_name text; target_schema text := current_schema();
BEGIN
  FOREACH function_name IN ARRAY ARRAY['usage_allowance_command(jsonb)',
    'usage_allowance_period(jsonb,timestamptz)','count_workspace_allowance_debit()',
    'validate_usage_allowance_rule(jsonb)','validate_usage_allowance_config(jsonb)',
    'capture_usage_allowance_period(uuid,uuid,jsonb,timestamptz)',
    'usage_allowance_members(uuid,uuid)','usage_allowance_effective_period(uuid,jsonb,timestamptz)',
    'maintain_usage_allowances(integer,integer)',
    'emit_usage_allowance_notifications(uuid,uuid,jsonb,text,timestamptz,text)',
    'usage_allowance_capability_active(uuid,uuid)']
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',target_schema,function_name,target_schema);
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee
      WHERE p.oid=format('%I.%s',target_schema,function_name)::regprocedure AND acl.grantee<>p.proowner
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',target_schema,function_name,role_name); END LOOP;
  END LOOP;
  FOR object_name IN SELECT c.oid::regclass::text FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname=current_schema() AND c.relname IN ('workspace_usage_allowances',
      'workspace_member_allowances','workspace_allowance_grants','workspace_allowance_counters','workspace_allowance_notifications','workspace_allowance_periods'))
      OR (n.nspname='opengeni_private' AND c.relname='usage_allowance_capabilities')
  LOOP
    FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c,
      LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE c.oid=object_name::regclass AND acl.grantee<>c.relowner
    LOOP EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',object_name,role_name); END LOOP;
  END LOOP;
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_class c,
    LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE c.oid='credit_ledger_entries'::regclass AND acl.privilege_type='INSERT' AND acl.grantee<>c.relowner
  LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION usage_allowance_command(jsonb), maintain_usage_allowances(integer,integer) TO %I',role_name); END LOOP;
END $acl$;