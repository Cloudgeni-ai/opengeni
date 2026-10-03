-- deployment-mode: rolling
-- Endpoint-first read-only capability. No rollup/table/function dependency.
-- Billing amounts and authorization policies are unchanged. Forward class costs
-- are nullable annotations on the existing frozen provider total, not debits.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10min';
ALTER TABLE model_call_facts
  ADD COLUMN list_uncached_input_cost_micros bigint CHECK(list_uncached_input_cost_micros>=0),
  ADD COLUMN list_cache_read_cost_micros bigint CHECK(list_cache_read_cost_micros>=0),
  ADD COLUMN list_cache_write_cost_micros bigint CHECK(list_cache_write_cost_micros>=0),
  ADD COLUMN list_output_cost_micros bigint CHECK(list_output_cost_micros>=0),
  ADD COLUMN list_cost_is_approx boolean,
  ADD CONSTRAINT model_call_facts_list_classes_check CHECK(
    (list_uncached_input_cost_micros IS NULL AND list_cache_read_cost_micros IS NULL
      AND list_cache_write_cost_micros IS NULL AND list_output_cost_micros IS NULL)
    OR (estimated_provider_cost_micros IS NOT NULL AND list_cost_is_approx IS NOT NULL
      AND list_uncached_input_cost_micros IS NOT NULL AND list_cache_read_cost_micros IS NOT NULL
      AND list_cache_write_cost_micros IS NOT NULL AND list_output_cost_micros IS NOT NULL
      AND estimated_provider_cost_micros::numeric=list_uncached_input_cost_micros::numeric
        +list_cache_read_cost_micros::numeric+list_cache_write_cost_micros::numeric+list_output_cost_micros::numeric));

CREATE FUNCTION opengeni_private.insights_usage_payer(provider text,billing text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN billing='opengeni_credits' THEN 'opengeni_credits'
    WHEN provider IN('codex-subscription','supergrok-subscription','workspace-claude-subscription','organization-claude-subscription')
    THEN 'subscription' ELSE 'own_key' END
$$;
CREATE FUNCTION opengeni_private.insights_usage_filter(p jsonb,q jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS(SELECT 1 FROM jsonb_each(q) f WHERE f.key IN
    ('workspaceId','provider','model','payer','projectId','person','rootSessionId','scheduleId') AND
    ((p->>'kind' IN('private','personal')) OR NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements_text(f.value) requested(value) WHERE value=CASE f.key
        WHEN 'model' THEN(p->>'provider')||'/'||(p->>'model')
        WHEN 'projectId' THEN CASE WHEN p->>'kind'='item' AND p->>'rootSessionId' IS NOT NULL THEN coalesce(p->>'projectId','unfiled') END
        ELSE p->>f.key END)))
$$;

DO $inputs$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_raw_amount_inputs(a uuid,w uuid,lo timestamptz,hi timestamptz)
    RETURNS TABLE(session_id uuid,provider text,model text,payer text,scheduled_task_id uuid,
      occurred_at timestamptz,recorded_at timestamptz,m jsonb,charge_row boolean)
    LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp AS $fn$
    BEGIN
      -- EXECUTE alone must never expose an intermediate private identity or
      -- per-call amount. The approved definer calls this as the schema owner.
      IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='%1$I.model_call_facts'::regclass)) THEN
        RAISE EXCEPTION 'Insights input is owner-invoked only' USING ERRCODE='42501';END IF;
      RETURN QUERY SELECT f.session_id,f.provider,f.model,opengeni_private.insights_usage_payer(f.provider,f.billing_path),
        f.scheduled_task_id,f.occurred_at,f.recorded_at,jsonb_build_object(
        'calls',1,'tokenKnownCalls',CASE WHEN f.total_tokens IS NOT NULL THEN 1 ELSE 0 END,
        'cacheKnownCalls',CASE WHEN f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL THEN 1 ELSE 0 END,
        'cacheWriteKnownCalls',CASE WHEN f.cache_write_tokens IS NOT NULL THEN 1 ELSE 0 END,
        'listClassKnownCalls',CASE WHEN f.list_uncached_input_cost_micros IS NOT NULL THEN 1 ELSE 0 END,
        'uncachedInput',CASE WHEN f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL AND f.cache_write_tokens IS NOT NULL
          AND f.input_tokens>=0 AND f.cached_tokens>=0 AND f.cache_write_tokens>=0
          AND f.cached_tokens::numeric+f.cache_write_tokens::numeric<=f.input_tokens::numeric
          THEN f.input_tokens-f.cached_tokens-f.cache_write_tokens ELSE 0 END,
        'cacheRead',coalesce(f.cached_tokens,0),'cacheWrite',coalesce(f.cache_write_tokens,0),'output',coalesce(f.output_tokens,0),
        'reasoning',coalesce(f.reasoning_tokens,0),'chargedMicros',0,'listMicros',coalesce(f.estimated_provider_cost_micros,0),
        'pricedCalls',CASE WHEN f.estimated_provider_cost_micros IS NOT NULL THEN 1 ELSE 0 END,
        'listApproxCalls',CASE WHEN f.list_cost_is_approx THEN 1 ELSE 0 END,
        'listUncachedInput',coalesce(f.list_uncached_input_cost_micros,0),'listCacheRead',coalesce(f.list_cache_read_cost_micros,0),
        'listCacheWrite',coalesce(f.list_cache_write_cost_micros,0),'listOutput',coalesce(f.list_output_cost_micros,0)),false
      FROM %1$I.model_call_facts f WHERE f.account_id=a AND f.workspace_id=w AND f.occurred_at>=lo AND f.occurred_at<hi;
      RETURN QUERY SELECT coalesce(f.session_id,CASE WHEN c.metadata->>'sessionId'~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN(c.metadata->>'sessionId')::uuid END),
        f.provider,f.model,'opengeni_credits',f.scheduled_task_id,c.occurred_at,null::timestamptz,
        jsonb_build_object('calls',0,'tokenKnownCalls',0,'cacheKnownCalls',0,'cacheWriteKnownCalls',0,'listClassKnownCalls',0,
          'uncachedInput',0,'cacheRead',0,'cacheWrite',0,'output',0,'reasoning',0,'chargedMicros',-c.amount_micros,
          'listMicros',0,'pricedCalls',0,'listApproxCalls',0,'listUncachedInput',0,'listCacheRead',0,'listCacheWrite',0,'listOutput',0),true
      FROM %1$I.credit_ledger_entries c LEFT JOIN %1$I.model_call_facts f ON f.account_id=c.account_id AND f.workspace_id=c.workspace_id
        AND f.turn_id=CASE WHEN c.source_id~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:.' THEN left(c.source_id,36)::uuid END
        AND f.source_key=substr(c.source_id,38)
      WHERE c.account_id=a AND c.workspace_id IS NOT DISTINCT FROM w AND c.type='model_usage_debit'
        AND c.source_type='model_response' AND c.amount_micros<0 AND c.occurred_at>=lo AND c.occurred_at<hi;
    END
    $fn$;
  $ddl$,current_schema());
END
$inputs$;

DO $readers$
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.insights_scoped_usage_rows(
      p_account uuid,p_workspace uuid,p_since timestamptz,p_until timestamptz,p_granularity text,p_details uuid[],p_shared boolean
    ) RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp SET jit=off SET enable_nestloop=off SET plan_cache_mode=force_custom_plan AS $fn$
    DECLARE a uuid;prior_workspace text:=current_setting('opengeni.workspace_id',true);prior_lifecycle text;
      subject_value text:=nullif(current_setting('opengeni.subject_id',true),'');human_value text:=nullif(current_setting('opengeni.initiating_human_subject_id',true),'');
      w record;personal_ids uuid[]:='{}';personal_owners text[]:='{}';shared_ids uuid[]:='{}';owner_index int;owner_key text;
      detail_allowed boolean;inventory uuid;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN a:=nullif(current_setting('opengeni.account_id',true),'')::uuid;
        IF nullif(prior_workspace,'')::uuid IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Insights usage requires exact scope' USING ERRCODE='42501';END IF;
      EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Insights usage scope malformed' USING ERRCODE='42501';END;
      IF a IS NULL OR a IS DISTINCT FROM p_account THEN RAISE EXCEPTION 'Insights usage account mismatch' USING ERRCODE='42501';END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_until<p_since
        OR p_until-p_since>interval '370 days' OR p_granularity IS NULL OR p_granularity NOT IN('day','hour')
        OR(p_granularity='hour' AND p_until-p_since>interval '1 day') OR p_details IS NULL OR p_shared IS NULL
      THEN RAISE EXCEPTION 'Insights usage window invalid' USING ERRCODE='22023';END IF;
      IF p_until=p_since THEN RETURN;END IF;
      IF p_workspace IS NULL THEN
        SELECT coalesce(array_agg(workspace_id),'{}') INTO shared_ids FROM %1$I.list_organization_workspace_ids(a);
      END IF;
      prior_lifecycle:=current_setting('opengeni.organization_tenancy_lifecycle',true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
      BEGIN
        SELECT coalesce(array_agg(m.personal_workspace_id ORDER BY m.id),'{}'),coalesce(array_agg(m.subject_id ORDER BY m.id),'{}')
        INTO personal_ids,personal_owners FROM %1$I.organization_memberships m JOIN %1$I.workspaces pw
          ON pw.id=m.personal_workspace_id AND pw.account_id=a WHERE m.account_id=a AND m.personal_workspace_id IS NOT NULL;
      EXCEPTION WHEN OTHERS THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);RAISE;END;
      PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
      IF p_workspace IS NOT NULL AND NOT p_workspace=ANY(personal_ids) THEN shared_ids:=ARRAY[p_workspace];END IF;
      BEGIN
        FOR w IN SELECT id,name FROM %1$I.workspaces WHERE account_id=a AND(p_workspace IS NULL OR id=p_workspace) ORDER BY id LOOP
          PERFORM set_config('opengeni.workspace_id',w.id::text,true);
          owner_index:=array_position(personal_ids,w.id);
          owner_key:=CASE WHEN owner_index IS NOT NULL THEN encode(sha256(convert_to(a::text||':'||personal_owners[owner_index],'UTF8')),'hex') END;
          detail_allowed:=(w.id=ANY(p_details) OR p_shared AND w.id=ANY(shared_ids))
            AND(owner_index IS NULL OR personal_owners[owner_index]=subject_value OR personal_owners[owner_index]=human_value);
          inventory:=opengeni_private.open_session_tenancy_fence_inventory(%2$s::oid);
          PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
          INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
            (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
          VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',a,w.id,subject_value,human_value);
          BEGIN
            RETURN QUERY WITH inventory_sessions AS MATERIALIZED(
              SELECT s.id,s.root_session_id,s.title,s.channel_id,s.owner_subject_id,s.owner_organization_membership_id,s.visibility,
                (subject_value IS NULL OR s.visibility='workspace_shared' OR %1$I.session_private_actor_visible(
                  s.account_id,s.workspace_id,s.owner_organization_membership_id,s.owner_subject_id)) AS actor_visible
              FROM %1$I.sessions s WHERE s.account_id=a AND s.workspace_id=w.id
            ), classified AS MATERIALIZED(
              SELECT f.*,s.id AS leaf_id,s.owner_subject_id,s.owner_organization_membership_id,s.root_session_id,
                CASE WHEN p_workspace IS NULL AND owner_index IS NOT NULL AND NOT detail_allowed THEN 'personal'
                  WHEN s.id IS NOT NULL AND s.visibility='user_private' AND(NOT s.actor_visible OR NOT detail_allowed) THEN 'private'
                  WHEN s.id IS NOT NULL AND NOT detail_allowed THEN 'restricted'
                  WHEN f.charge_row AND f.provider IS NULL THEN 'restricted'
                  WHEN s.id IS NULL OR r.id IS NULL THEN 'deleted'
                  WHEN NOT s.actor_visible OR NOT r.actor_visible THEN 'restricted' ELSE 'item' END AS kind
              FROM opengeni_private.insights_raw_amount_inputs(a,w.id,p_since,p_until) f
              LEFT JOIN inventory_sessions s ON s.id=f.session_id LEFT JOIN inventory_sessions r ON r.id=s.root_session_id
            ), projected AS MATERIALIZED(
              SELECT jsonb_build_object('kind',f.kind,'occurredAt',f.occurred_at,'recordedAt',CASE WHEN f.kind='item' THEN f.recorded_at END,
                'workspaceId',CASE WHEN f.kind='item' OR(f.kind IN('restricted','service','deleted') AND w.id=ANY(shared_ids)) THEN w.id END,
                'workspaceName',CASE WHEN f.kind='item' OR(f.kind IN('restricted','service','deleted') AND w.id=ANY(shared_ids)) THEN w.name END,
                'personal',owner_index IS NOT NULL,'provider',CASE WHEN f.kind='item' THEN f.provider END,
                'model',CASE WHEN f.kind='item' THEN f.model END,'payer',f.payer,
                'rootSessionId',CASE WHEN f.kind='item' THEN f.root_session_id END,'rootTitle',CASE WHEN f.kind='item' THEN root.title END,
                'projectId',CASE WHEN f.kind='item' THEN project.id END,'projectName',CASE WHEN f.kind='item' THEN project.name END,
                'scheduleId',CASE WHEN f.kind='item' THEN task.id END,'scheduleName',CASE WHEN f.kind='item' THEN task.name END,
                'person',CASE WHEN f.kind='personal' THEN owner_key WHEN f.kind IN('item','private')
                  AND coalesce(f.owner_subject_id,f.owner_organization_membership_id::text) IS NOT NULL THEN
                    encode(sha256(convert_to(a::text||':'||coalesce(f.owner_subject_id,f.owner_organization_membership_id::text),'UTF8')),'hex') END,
                'personName',CASE WHEN f.kind IN('item','private') THEN coalesce(u.name,access.subject_label) END,
                'you',CASE WHEN f.kind='personal' THEN personal_owners[owner_index]=subject_value
                  WHEN f.kind='item' THEN f.owner_subject_id=subject_value ELSE false END,'m',f.m) AS p
              FROM classified f LEFT JOIN inventory_sessions root ON f.kind='item' AND root.id=f.root_session_id
              LEFT JOIN %1$I.channels project ON project.id=root.channel_id AND project.account_id=a AND project.workspace_id=w.id
              LEFT JOIN %1$I.scheduled_tasks task ON f.kind='item' AND task.id=f.scheduled_task_id AND task.account_id=a AND task.workspace_id=w.id
              LEFT JOIN %1$I.workspace_memberships access ON access.account_id=a AND access.workspace_id=w.id AND access.subject_id=f.owner_subject_id
              LEFT JOIN %1$I.auth_users u ON access.subject_id='user:'||u.id
            ), hidden_fields AS(
              SELECT p->>'kind' AS kind,p->>'person' AS person,p->>'payer' AS payer,p->>'workspaceId' AS workspace,
                date_trunc(p_granularity,(p->>'occurredAt')::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
                max(p->>'workspaceName') AS workspace_name,max(p->>'personName') AS name,bool_or(coalesce((p->>'you')::boolean,false)) AS you,
                field.key,sum(field.value::bigint)::bigint AS amount
              FROM projected CROSS JOIN LATERAL jsonb_each_text(p->'m') field WHERE p->>'kind'<>'item' GROUP BY 1,2,3,4,5,field.key
            ) SELECT p FROM projected WHERE p->>'kind'='item'
              UNION ALL SELECT jsonb_build_object('kind',kind,'person',person,'personName',max(name),'you',bool_or(you),
                'payer',payer,'workspaceId',workspace,'workspaceName',max(workspace_name),'occurredAt',bucket,'recordedAt',null,
                'm',jsonb_object_agg(key,amount)) FROM hidden_fields GROUP BY kind,person,payer,workspace,bucket;
            DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
              AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
            PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
            PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
          EXCEPTION WHEN OTHERS THEN
            DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
              AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
            PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory);
            PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);RAISE;
          END;
        END LOOP;
        IF p_workspace IS NULL THEN RETURN QUERY
          SELECT jsonb_build_object('kind','restricted','payer','opengeni_credits','occurredAt',bucket,'m',jsonb_object_agg(key,amount))
          FROM(SELECT date_trunc(p_granularity,occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
            field.key,sum(field.value::bigint)::bigint AS amount FROM opengeni_private.insights_raw_amount_inputs(a,null,p_since,p_until)
            CROSS JOIN LATERAL jsonb_each_text(m) field GROUP BY 1,field.key) unassigned GROUP BY bucket;END IF;
        PERFORM set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      EXCEPTION WHEN OTHERS THEN PERFORM set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);RAISE;END;
    END
    $fn$;

    CREATE FUNCTION opengeni_private.insights_scoped_calls_rows(
      p_account uuid,p_workspace uuid,p_since timestamptz,p_until timestamptz,p_query jsonb,p_cursor_at timestamptz,p_cursor_id uuid,p_limit int,
      p_details uuid[],p_shared boolean
    ) RETURNS TABLE(payload jsonb) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,opengeni_private,pg_temp SET jit=off SET enable_nestloop=on SET plan_cache_mode=force_custom_plan AS $fn$
    DECLARE a uuid;prior_workspace text:=current_setting('opengeni.workspace_id',true);prior_lifecycle text;
      subject_value text:=nullif(current_setting('opengeni.subject_id',true),'');human_value text:=nullif(current_setting('opengeni.initiating_human_subject_id',true),'');
      shared_ids uuid[]:='{}';personal_ids uuid[]:='{}';personal_owners text[]:='{}';owner_index int;w record;
    BEGIN
      PERFORM opengeni_private.session_variable_set_attachments_protocol_v1_active();
      BEGIN a:=nullif(current_setting('opengeni.account_id',true),'')::uuid;
        IF nullif(prior_workspace,'')::uuid IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'Insights calls scope mismatch' USING ERRCODE='42501';END IF;
      EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Insights calls scope malformed' USING ERRCODE='42501';END;
      IF a IS NULL OR a IS DISTINCT FROM p_account THEN RAISE EXCEPTION 'Insights calls account mismatch' USING ERRCODE='42501';END IF;
      IF p_since IS NULL OR p_until IS NULL OR NOT isfinite(p_since) OR NOT isfinite(p_until) OR p_until<p_since OR p_until-p_since>interval '370 days'
        OR p_limit IS NULL OR p_limit<1 OR p_limit>101 OR(p_cursor_at IS NULL)<>(p_cursor_id IS NULL)
        OR(p_cursor_at IS NOT NULL AND NOT isfinite(p_cursor_at)) OR p_query IS NULL OR jsonb_typeof(p_query)<>'object'
        OR p_details IS NULL OR p_shared IS NULL THEN RAISE EXCEPTION 'Insights calls input invalid' USING ERRCODE='22023';END IF;
      IF p_until=p_since THEN RETURN;END IF;
      IF p_workspace IS NULL THEN
        SELECT coalesce(array_agg(workspace_id),'{}') INTO shared_ids FROM %1$I.list_organization_workspace_ids(a);
      END IF;
      prior_lifecycle:=current_setting('opengeni.organization_tenancy_lifecycle',true);
      PERFORM set_config('opengeni.organization_tenancy_lifecycle','organization_membership_lifecycle',true);
      BEGIN SELECT coalesce(array_agg(m.personal_workspace_id ORDER BY m.id),'{}'),coalesce(array_agg(m.subject_id ORDER BY m.id),'{}')
        INTO personal_ids,personal_owners FROM %1$I.organization_memberships m WHERE m.account_id=a AND m.personal_workspace_id IS NOT NULL;
      EXCEPTION WHEN OTHERS THEN PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);RAISE;END;
      PERFORM set_config('opengeni.organization_tenancy_lifecycle',coalesce(prior_lifecycle,''),true);
      IF p_workspace IS NOT NULL AND NOT p_workspace=ANY(personal_ids) THEN shared_ids:=ARRAY[p_workspace];END IF;
      BEGIN
        FOR w IN SELECT id FROM %1$I.workspaces WHERE account_id=a AND(p_workspace IS NULL OR id=p_workspace)
          AND(id=ANY(p_details) OR p_shared AND id=ANY(shared_ids))
          AND(NOT p_query?'workspaceId' OR id::text IN(SELECT jsonb_array_elements_text(p_query->'workspaceId'))) ORDER BY id LOOP
          owner_index:=array_position(personal_ids,w.id);
          IF owner_index IS NOT NULL AND personal_owners[owner_index] IS DISTINCT FROM subject_value
            AND personal_owners[owner_index] IS DISTINCT FROM human_value THEN CONTINUE;END IF;
          PERFORM set_config('opengeni.workspace_id',w.id::text,true);
          INSERT INTO opengeni_private.insights_fact_read_runtime_capabilities
            (backend_pid,transaction_id,capability_kind,account_id,workspace_id,subject_id,initiating_human_subject_id)
          VALUES(pg_backend_pid(),pg_current_xact_id(),'model_call_facts',a,w.id,subject_value,human_value);
          RETURN QUERY SELECT jsonb_build_object('id',f.id,'occurredAt',to_char(f.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'workspaceId',w.id,
            'sessionId',leaf.id,'sessionTitle',leaf.title,'sessionKind','visible','personKey',meta->>'person',
            'provider',f.provider,'model',f.model,'payer',meta->>'payer','tokens',CASE WHEN
              f.input_tokens IS NOT NULL AND f.cached_tokens IS NOT NULL AND f.cache_write_tokens IS NOT NULL
              AND f.output_tokens IS NOT NULL AND f.reasoning_tokens IS NOT NULL
              AND f.input_tokens>=0 AND f.cached_tokens>=0 AND f.cache_write_tokens>=0 AND f.output_tokens>=0
              AND f.reasoning_tokens>=0 AND f.reasoning_tokens<=f.output_tokens
              AND f.cached_tokens::numeric+f.cache_write_tokens::numeric<=f.input_tokens::numeric THEN jsonb_build_object(
              'uncachedInput',f.input_tokens-f.cached_tokens-f.cache_write_tokens,'cacheRead',f.cached_tokens,
              'cacheWrite',f.cache_write_tokens,'output',f.output_tokens,'reasoning',f.reasoning_tokens) END,
            'chargedMicros',(SELECT coalesce(-sum(c.amount_micros),0) FROM %1$I.credit_ledger_entries c
              WHERE c.account_id=a AND c.workspace_id=w.id AND c.type='model_usage_debit' AND c.source_type='model_response'
                AND c.amount_micros<0 AND c.source_id=f.turn_id::text||':'||f.source_key),
            'listMicros',f.estimated_provider_cost_micros,'listByClassMicros',CASE WHEN f.list_uncached_input_cost_micros IS NOT NULL THEN jsonb_build_object(
              'uncachedInput',f.list_uncached_input_cost_micros,'cacheRead',f.list_cache_read_cost_micros,
              'cacheWrite',f.list_cache_write_cost_micros,'output',f.list_output_cost_micros) END)
          FROM %1$I.model_call_facts f JOIN %1$I.sessions leaf ON leaf.id=f.session_id AND leaf.account_id=a AND leaf.workspace_id=w.id
          LEFT JOIN %1$I.sessions root ON root.id=leaf.root_session_id AND root.account_id=a AND root.workspace_id=w.id
          LEFT JOIN %1$I.channels project ON project.id=root.channel_id AND project.account_id=a AND project.workspace_id=w.id
          LEFT JOIN %1$I.scheduled_tasks task ON task.id=f.scheduled_task_id AND task.account_id=a AND task.workspace_id=w.id
          CROSS JOIN LATERAL(SELECT jsonb_build_object('kind','item','workspaceId',w.id,'provider',f.provider,'model',f.model,
            'payer',opengeni_private.insights_usage_payer(f.provider,f.billing_path),'rootSessionId',CASE WHEN root.visibility='workspace_shared'
              OR subject_value IS NULL OR %1$I.session_private_actor_visible(root.account_id,root.workspace_id,root.owner_organization_membership_id,root.owner_subject_id) THEN root.id END,
            'projectId',CASE WHEN root.visibility='workspace_shared' OR subject_value IS NULL OR %1$I.session_private_actor_visible(
              root.account_id,root.workspace_id,root.owner_organization_membership_id,root.owner_subject_id) THEN project.id END,
            'scheduleId',task.id,'person',CASE WHEN coalesce(leaf.owner_subject_id,leaf.owner_organization_membership_id::text) IS NOT NULL THEN
              encode(sha256(convert_to(a::text||':'||coalesce(leaf.owner_subject_id,leaf.owner_organization_membership_id::text),'UTF8')),'hex') END) AS meta) metadata
          WHERE f.account_id=a AND f.workspace_id=w.id AND f.occurred_at>=p_since AND f.occurred_at<p_until
            AND(p_cursor_at IS NULL OR(f.occurred_at,f.id)<(p_cursor_at,p_cursor_id))
            AND(subject_value IS NULL OR leaf.visibility='workspace_shared' OR %1$I.session_private_actor_visible(
              leaf.account_id,leaf.workspace_id,leaf.owner_organization_membership_id,leaf.owner_subject_id))
            AND opengeni_private.insights_usage_filter(meta,p_query)
          ORDER BY f.occurred_at DESC,f.id DESC LIMIT p_limit;
          DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
            AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
        END LOOP;
        PERFORM set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.insights_fact_read_runtime_capabilities WHERE backend_pid=pg_backend_pid()
          AND transaction_id=pg_current_xact_id_if_assigned() AND capability_kind='model_call_facts';
        PERFORM set_config('opengeni.workspace_id',coalesce(prior_workspace,''),true);RAISE;
      END;
    END
    $fn$;
  $ddl$,current_schema(),(SELECT oid FROM pg_namespace WHERE nspname=current_schema()));
END
$readers$;

DO $acl$
DECLARE routine regprocedure;role_name text;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='opengeni_private' AND p.proname IN('insights_usage_payer','insights_usage_filter','insights_raw_amount_inputs',
      'insights_scoped_usage_rows','insights_scoped_calls_rows') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',routine);
    FOR role_name IN SELECT r.rolname FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      JOIN pg_roles r ON r.oid=acl.grantee WHERE p.oid=routine AND acl.grantee<>p.proowner LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_name);END LOOP;
    FOR role_name IN SELECT r.rolname FROM jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) configured(value)
      JOIN pg_roles r ON r.rolname=configured.value WHERE has_table_privilege(r.rolname,format('%I.model_call_facts',current_schema()),'SELECT')
      AND has_table_privilege(r.rolname,format('%I.usage_events',current_schema()),'SELECT') LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',routine,role_name);END LOOP;
  END LOOP;
END
$acl$;
RESET statement_timeout;
RESET lock_timeout;