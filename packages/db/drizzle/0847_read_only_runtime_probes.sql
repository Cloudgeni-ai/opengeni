-- deployment-mode: rolling
-- Authorization probes read durable facts; they need no durable grant of their
-- own. Keep transaction capabilities for accepted authority and fenced writes.
SET LOCAL lock_timeout = '5s';

DO $install$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  -- The existing admin predicate already accepts this exact account/subject
  -- context. Only a definer can see the row: the app still has no table grants.
  -- This does not expose another subject or give the owner a mutation policy.
  EXECUTE format('CREATE POLICY subscription_admin_self_read ON %I.organization_memberships
    FOR SELECT USING (current_user=%L
      AND account_id::text=NULLIF(pg_catalog.current_setting(''opengeni.account_id'',true),'''')
      AND subject_id=NULLIF(pg_catalog.current_setting(''opengeni.subject_id'',true),'''')
      AND status=''active'' AND revoked_at IS NULL AND role IN (''owner'',''admin''))',
    data_schema,owner_name);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION opengeni_private.subscription_organization_admin(p_account_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,pg_temp AS $body$
      SELECT coalesce(p_account_id::text = nullif(current_setting('opengeni.account_id',true),'')
        AND nullif(current_setting('opengeni.subject_id',true),'') IS NOT NULL
        AND EXISTS (SELECT 1 FROM %1$I.organization_memberships membership
          WHERE membership.account_id=p_account_id
            AND membership.subject_id=nullif(current_setting('opengeni.subject_id',true),'')
            AND membership.status='active' AND membership.revoked_at IS NULL
            AND membership.role IN ('owner','admin')),false)
    $body$;
  $definition$,data_schema);
  -- CREATE OR REPLACE preserves the function owner and exact EXECUTE grants.
END $install$;

-- Scope-only reads do not mint mutation capabilities. These tables remain
-- private and FORCE-RLS; only their existing definer entry points can reach
-- them. Locking reads and DML retain the original capability-backed policies.
DO $scoped_reads$
DECLARE
  data_schema text := current_schema(); owner_name text := current_user;
  table_name text; definition text; anchor text; replacement text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_usage_allowances',
    'session_usage_limit_roots','session_usage_limit_receipts']
  LOOP
    EXECUTE format('CREATE POLICY scoped_owner_read ON opengeni_private.%I
      FOR SELECT USING (current_user=%L
        AND pg_catalog.to_regclass(''workspaces'')=%L::regclass
        AND opengeni_private.workspace_rls_visible(account_id,workspace_id))',
      table_name,owner_name,format('%I.workspaces',data_schema));
  END LOOP;

  definition:=pg_get_functiondef(format('%I.usage_allowance_command(jsonb)',data_schema)::regprocedure);
  anchor:='  PERFORM 1 FROM workspaces WHERE id=w AND account_id=a FOR KEY SHARE;';
  replacement:=$new$  IF action IN ('get','state') THEN
    PERFORM 1 FROM workspaces WHERE id=w AND account_id=a;
  ELSE
    PERFORM 1 FROM workspaces WHERE id=w AND account_id=a FOR KEY SHARE;
  END IF;$new$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance workspace fence definition';
  END IF;
  definition:=replace(definition,anchor,replacement);
  anchor:=$old$  INSERT INTO opengeni_private.usage_allowance_capabilities
    VALUES (pg_backend_pid(), pg_current_xact_id(), v_data_schema, a, w)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;$old$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance capability definition';
  END IF;
  EXECUTE replace(definition,anchor,'  opened := 0;
  IF action NOT IN (''get'',''state'') THEN
'||anchor||'
  END IF;');

  definition:=pg_get_functiondef(format('%I.session_usage_limit_command(jsonb)',data_schema)::regprocedure);
  anchor:=$old$  INSERT INTO opengeni_private.session_usage_limit_capabilities
    VALUES (pg_backend_pid(), pg_current_xact_id(), v_data_schema, a, w)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS opened = ROW_COUNT;$old$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected session usage capability definition';
  END IF;
  definition:=replace(definition,anchor,'  opened := 0;
  IF action <> ''read'' OR coalesce((p_input->>''prepare'')::boolean,false)
    OR p_input ? ''openSourceId'' THEN
'||anchor||'
  END IF;');
  -- A legacy root may be absent. Its initialization is real work, so acquire
  -- the unchanged write capability before the first INSERT or locking read.
  replacement:='  IF root_row.root_session_id IS NULL THEN
    IF opened=0 THEN
'||anchor||'
    END IF;';
  anchor:='  IF root_row.root_session_id IS NULL THEN';
  -- The second occurrence handles a failed initialization; replace only the
  -- first, whose following comment identifies the initialization boundary.
  anchor:=anchor||E'\n    -- Roots created before this feature are initialized lazily and imported.';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected session usage initialization definition';
  END IF;
  EXECUTE replace(definition,anchor,replacement||E'\n    -- Roots created before this feature are initialized lazily and imported.');
END $scoped_reads$;

-- A private scheduling index contains no authority or user content. Like the
-- existing capability storage, it has no runtime grants and needs no RLS:
-- its only readers/writers are pinned owner functions. Source rows still own
-- all business state; triggers maintain this index in the same transaction.
CREATE TABLE opengeni_private.usage_maintenance_due (
  data_schema name NOT NULL,
  kind text NOT NULL CHECK (kind IN ('allowance','session_import','session_receipt')),
  workspace_id uuid NOT NULL,
  source_id text NOT NULL,
  due_at timestamptz,
  account_id uuid NOT NULL,
  seen_membership_revision bigint NOT NULL DEFAULT 0,
  membership_ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY (data_schema,kind,workspace_id,source_id)
);
CREATE INDEX usage_maintenance_due_time ON opengeni_private.usage_maintenance_due
  (data_schema,kind,due_at);
REVOKE ALL ON TABLE opengeni_private.usage_maintenance_due FROM PUBLIC;

CREATE FUNCTION opengeni_private.sync_usage_maintenance_due()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  old_row jsonb; new_row jsonb; old_id text; new_id text;
  old_workspace uuid; new_workspace uuid; due_time timestamptz;
  keep_projection boolean := false;
  index_kind text := TG_ARGV[1]; schema_name name := TG_ARGV[0];
BEGIN
  IF TG_OP<>'INSERT' THEN
    old_row:=to_jsonb(OLD); old_workspace:=(old_row->>'workspace_id')::uuid;
    old_id:=CASE index_kind WHEN 'allowance' THEN old_row->>'workspace_id'
      WHEN 'session_import' THEN old_row->>'root_session_id' ELSE old_row->>'source_id' END;
  END IF;
  IF TG_OP<>'DELETE' THEN
    new_row:=to_jsonb(NEW); new_workspace:=(new_row->>'workspace_id')::uuid;
    new_id:=CASE index_kind WHEN 'allowance' THEN new_row->>'workspace_id'
      WHEN 'session_import' THEN new_row->>'root_session_id' ELSE new_row->>'source_id' END;
    due_time:=CASE index_kind
      WHEN 'allowance' THEN CASE WHEN new_row->'config'<>'null'::jsonb
        THEN (new_row->>'maintenance_next_at')::timestamptz END
      WHEN 'session_import' THEN CASE WHEN new_row->>'history_state'='preparing'
        THEN (new_row->>'import_next_at')::timestamptz END
      -- Keep this deadline identical to maintain_session_usage_limits' lost
      -- receipt predicate introduced in 0773 (recorded_at + 30 minutes).
      ELSE CASE WHEN new_row->>'status'='pending'
        THEN (new_row->>'recorded_at')::timestamptz+interval '30 minutes' END END;
    keep_projection:=due_time IS NOT NULL OR (index_kind='allowance' AND new_row->'config'<>'null'::jsonb);
  END IF;
  IF old_id IS NOT NULL AND (NOT keep_projection OR old_id IS DISTINCT FROM new_id
    OR old_workspace IS DISTINCT FROM new_workspace) THEN
    DELETE FROM opengeni_private.usage_maintenance_due
      WHERE data_schema=schema_name AND kind=index_kind
        AND workspace_id=old_workspace AND source_id=old_id;
  END IF;
  IF keep_projection THEN
    INSERT INTO opengeni_private.usage_maintenance_due(data_schema,kind,workspace_id,source_id,due_at,
      account_id,seen_membership_revision,membership_ready)
      VALUES(schema_name,index_kind,new_workspace,new_id,due_time,(new_row->>'account_id')::uuid,
        coalesce((new_row->>'maintenance_membership_revision')::bigint,0),
        index_kind='allowance' AND new_row->>'maintenance_error' IS NULL)
    ON CONFLICT(data_schema,kind,workspace_id,source_id) DO UPDATE SET due_at=excluded.due_at,
      account_id=excluded.account_id,seen_membership_revision=excluded.seen_membership_revision,
      membership_ready=excluded.membership_ready
      WHERE (usage_maintenance_due.due_at,usage_maintenance_due.account_id,
        usage_maintenance_due.seen_membership_revision,usage_maintenance_due.membership_ready)
        IS DISTINCT FROM (excluded.due_at,excluded.account_id,excluded.seen_membership_revision,excluded.membership_ready);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION opengeni_private.sync_usage_maintenance_due() FROM PUBLIC;

DO $maintenance_index$
<<maintenance_index>>
DECLARE
  data_schema text := current_schema(); definition text; anchor text;
  allowance_opened integer; session_opened integer;
BEGIN
  EXECUTE format('CREATE TRIGGER usage_maintenance_due_sync AFTER INSERT OR UPDATE OR DELETE
    ON opengeni_private.workspace_usage_allowances FOR EACH ROW
    EXECUTE FUNCTION opengeni_private.sync_usage_maintenance_due(%L,''allowance'')',data_schema);
  EXECUTE format('CREATE TRIGGER usage_maintenance_due_sync AFTER INSERT OR UPDATE OR DELETE
    ON opengeni_private.session_usage_limit_roots FOR EACH ROW
    EXECUTE FUNCTION opengeni_private.sync_usage_maintenance_due(%L,''session_import'')',data_schema);
  EXECUTE format('CREATE TRIGGER usage_maintenance_due_sync AFTER INSERT OR UPDATE OR DELETE
    ON opengeni_private.session_usage_limit_receipts FOR EACH ROW
    EXECUTE FUNCTION opengeni_private.sync_usage_maintenance_due(%L,''session_receipt'')',data_schema);

  -- Use the existing owner-only inventory capabilities for the one-time
  -- backfill, including strict non-BYPASSRLS migration owners.
  INSERT INTO opengeni_private.usage_allowance_capabilities VALUES(pg_backend_pid(),pg_current_xact_id(),
    data_schema,'00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS allowance_opened=ROW_COUNT;
  INSERT INTO opengeni_private.session_usage_limit_capabilities VALUES(pg_backend_pid(),pg_current_xact_id(),
    data_schema,'00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000')
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS session_opened=ROW_COUNT;
  INSERT INTO opengeni_private.usage_maintenance_due(data_schema,kind,workspace_id,source_id,due_at,account_id,membership_ready)
    SELECT data_schema,'allowance',workspace_id,workspace_id::text,maintenance_next_at,account_id,maintenance_error IS NULL
    FROM opengeni_private.workspace_usage_allowances WHERE config IS NOT NULL AND maintenance_next_at IS NOT NULL;
  INSERT INTO opengeni_private.usage_maintenance_due(data_schema,kind,workspace_id,source_id,due_at,account_id)
    SELECT data_schema,'session_import',workspace_id,root_session_id::text,import_next_at,account_id
    FROM opengeni_private.session_usage_limit_roots WHERE history_state='preparing' AND import_next_at IS NOT NULL;
  INSERT INTO opengeni_private.usage_maintenance_due(data_schema,kind,workspace_id,source_id,due_at,account_id)
    SELECT data_schema,'session_receipt',workspace_id,source_id,recorded_at+interval '30 minutes',account_id
    FROM opengeni_private.session_usage_limit_receipts WHERE status='pending';
  IF allowance_opened=1 THEN
    DELETE FROM opengeni_private.usage_allowance_capabilities c WHERE c.backend_pid=pg_backend_pid()
      AND c.transaction_id=pg_current_xact_id_if_assigned() AND c.data_schema=maintenance_index.data_schema
      AND c.workspace_id='00000000-0000-0000-0000-000000000000'::uuid;
  END IF;
  IF session_opened=1 THEN
    DELETE FROM opengeni_private.session_usage_limit_capabilities c WHERE c.backend_pid=pg_backend_pid()
      AND c.transaction_id=pg_current_xact_id_if_assigned() AND c.data_schema=maintenance_index.data_schema
      AND c.workspace_id='00000000-0000-0000-0000-000000000000'::uuid;
  END IF;

  definition:=pg_get_functiondef(format('%I.maintain_usage_allowances(integer,integer)',data_schema)::regprocedure);
  anchor:=E'BEGIN\n  INSERT INTO opengeni_private.usage_allowance_capabilities';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance maintenance entry';
  END IF;
  EXECUTE replace(definition,anchor,$new$BEGIN
  IF NOT EXISTS (SELECT 1 FROM opengeni_private.usage_maintenance_due
    WHERE data_schema=v_data_schema AND kind='allowance' AND due_at<=clock_timestamp()) THEN
    RETURN 0;
  END IF;
  INSERT INTO opengeni_private.usage_allowance_capabilities$new$);

  definition:=pg_get_functiondef(format('%I.maintain_session_usage_limits(integer,integer)',data_schema)::regprocedure);
  anchor:=E'BEGIN\n  INSERT INTO opengeni_private.session_usage_limit_capabilities';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected session usage maintenance entry';
  END IF;
  EXECUTE replace(definition,anchor,$new$BEGIN
  IF NOT EXISTS (SELECT 1 FROM opengeni_private.usage_maintenance_due
    WHERE data_schema=v_data_schema AND kind IN ('session_import','session_receipt')
      AND due_at<=clock_timestamp()) THEN
    RETURN jsonb_build_object('processed',0,'failed',0,'errors','{}'::jsonb,'resolvedLost',0);
  END IF;
  INSERT INTO opengeni_private.session_usage_limit_capabilities$new$);
END $maintenance_index$;

-- Polling an unchanged policy is not work. Counter/config writers already arm
-- maintenance; membership facts arm it below. The only remaining clock-driven
-- events are a period boundary and an unspent grant's expiry.
ALTER TABLE opengeni_private.workspace_usage_allowances
  ALTER COLUMN maintenance_next_at DROP NOT NULL;
ALTER TABLE opengeni_private.workspace_usage_allowances
  ADD COLUMN membership_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN maintenance_membership_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE opengeni_private.usage_allowance_membership_changes (
  data_schema name NOT NULL,
  account_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(data_schema,account_id)
);
REVOKE ALL ON TABLE opengeni_private.usage_allowance_membership_changes FROM PUBLIC;
DO $event_deadlines$
DECLARE definition text; anchor text; data_schema text:=current_schema();
BEGIN
  definition:=pg_get_functiondef(format('%I.maintain_usage_allowances(integer,integer)',data_schema)::regprocedure);
  anchor:=$old$maintenance_next_at=clock_timestamp()+CASE WHEN seen>member_limit THEN interval '1 second' ELSE interval '1 minute' END,$old$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance maintenance deadline';
  END IF;
  EXECUTE replace(definition,anchor,$new$maintenance_next_at=CASE WHEN seen>member_limit
            THEN clock_timestamp()+interval '1 second'
            ELSE least(p.end_at,(SELECT min(expires_at)
              FROM opengeni_private.workspace_allowance_grants
              WHERE workspace_id=target.workspace_id AND remaining>0 AND expires_at>clock_timestamp())) END,$new$);
END $event_deadlines$;

-- Bulk membership changes arm each affected account only once. Only changes
-- to eligibility fields matter: labels, roles and permissions do not change
-- the canonical allowance member predicate. Transition tables avoid per-row
-- catalog scans during imports. No new authorization window is introduced.
DO $membership_arming$
DECLARE data_schema text:=current_schema(); source_table text;
BEGIN
  EXECUTE format($definition$
    CREATE FUNCTION opengeni_private.arm_usage_allowances_for_membership()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,%1$I,pg_temp AS $body$
    DECLARE
      affected uuid[];
      v_data_schema text:=%2$L;
      projection text:='jsonb_build_array(to_jsonb(row)->''account_id'',to_jsonb(row)->''subject_id'',
        to_jsonb(row)->''workspace_id'',to_jsonb(row)->''personal_workspace_id'',to_jsonb(row)->''status'',
        to_jsonb(row)->''external_source'',to_jsonb(row)->''external_id'')';
      account_column text:='account_id';
    BEGIN
      IF TG_TABLE_NAME='managed_accounts' THEN
        account_column:='id';
        IF TG_OP='DELETE' THEN
          DELETE FROM opengeni_private.usage_allowance_membership_changes
            WHERE data_schema=v_data_schema AND account_id=OLD.id;
          RETURN NULL;
        END IF;
      END IF;
      IF TG_OP='INSERT' THEN
        EXECUTE format('SELECT array_agg(DISTINCT %%I ORDER BY %%I) FROM new_members',account_column,account_column) INTO affected;
      ELSIF TG_OP='DELETE' THEN
        SELECT array_agg(DISTINCT account_id ORDER BY account_id) INTO affected FROM old_members;
      ELSE
        EXECUTE 'SELECT array_agg(DISTINCT account_id ORDER BY account_id) FROM (
          (SELECT '||account_column||' AS account_id,'||projection||' AS fact FROM new_members row
            EXCEPT SELECT '||account_column||','||projection||' AS fact FROM old_members row)
          UNION
          (SELECT '||account_column||','||projection||' AS fact FROM old_members row
            EXCEPT SELECT '||account_column||','||projection||' AS fact FROM new_members row)
          ) changed' INTO affected;
      END IF;
      IF affected IS NULL THEN RETURN NULL; END IF;
      -- Never acquire allowance-row locks from a membership transaction: a
      -- bounded maintenance batch can hold several rows in deadline order.
      -- A monotonic marker also preserves a re-arm racing maintenance.
      INSERT INTO opengeni_private.usage_allowance_membership_changes(data_schema,account_id)
        SELECT v_data_schema,id FROM unnest(affected) id ORDER BY id
      ON CONFLICT(data_schema,account_id) DO UPDATE
        SET revision=usage_allowance_membership_changes.revision+1,changed_at=clock_timestamp();
      RETURN NULL;
    END $body$;
  $definition$,data_schema,data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.arm_usage_allowances_for_membership() FROM PUBLIC;
  FOREACH source_table IN ARRAY ARRAY['organization_memberships','workspace_memberships','external_identities','managed_accounts'] LOOP
    EXECUTE format('CREATE TRIGGER allowance_membership_insert AFTER INSERT ON %I.%I
      REFERENCING NEW TABLE AS new_members FOR EACH STATEMENT
      EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership()',data_schema,source_table);
    EXECUTE format('CREATE TRIGGER allowance_membership_update AFTER UPDATE ON %I.%I
      REFERENCING OLD TABLE AS old_members NEW TABLE AS new_members FOR EACH STATEMENT
      EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership()',data_schema,source_table);
    IF source_table='managed_accounts' THEN
      -- Cascaded membership statement triggers can run after the parent
      -- statement trigger. Clean up only after that entire queue has drained.
      EXECUTE format('CREATE CONSTRAINT TRIGGER allowance_membership_delete AFTER DELETE ON %I.%I
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership()',data_schema,source_table);
    ELSE
      EXECUTE format('CREATE TRIGGER allowance_membership_delete AFTER DELETE ON %I.%I
        REFERENCING OLD TABLE AS old_members FOR EACH STATEMENT
        EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership()',data_schema,source_table);
    END IF;
  END LOOP;
END $membership_arming$;

DO $membership_maintenance$
DECLARE definition text; anchor text; replacement text; data_schema text:=current_schema();
BEGIN
  definition:=pg_get_functiondef(format('%I.maintain_usage_allowances(integer,integer)',data_schema)::regprocedure);
  anchor:=$old$WHERE data_schema=v_data_schema AND kind='allowance' AND due_at<=clock_timestamp()) THEN$old$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance maintenance probe';
  END IF;
  definition:=replace(definition,anchor,$new$WHERE data_schema=v_data_schema AND kind='allowance' AND due_at<=clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM opengeni_private.usage_maintenance_due projection
      JOIN opengeni_private.usage_allowance_membership_changes changes
        ON changes.data_schema=projection.data_schema AND changes.account_id=projection.account_id
      WHERE projection.data_schema=v_data_schema AND projection.kind='allowance'
        AND projection.membership_ready AND changes.revision>projection.seen_membership_revision) THEN$new$);
  anchor:=$old$FOR target IN SELECT account_id,workspace_id FROM opengeni_private.workspace_usage_allowances
    WHERE config IS NOT NULL AND maintenance_next_at<=clock_timestamp()
    ORDER BY maintenance_next_at,workspace_id LIMIT greatest(1,least(coalesce(p_limit,20),100))$old$;
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance maintenance inventory';
  END IF;
  definition:=replace(definition,anchor,$new$FOR target IN SELECT policy.account_id,policy.workspace_id,
      coalesce(changes.revision,0) AS membership_target_revision
    FROM opengeni_private.workspace_usage_allowances policy
    LEFT JOIN opengeni_private.usage_allowance_membership_changes changes
      ON changes.data_schema=v_data_schema AND changes.account_id=policy.account_id
    WHERE policy.config IS NOT NULL AND (policy.maintenance_next_at<=clock_timestamp()
      OR (policy.maintenance_error IS NULL AND policy.maintenance_membership_revision<coalesce(changes.revision,0)))
    ORDER BY least(policy.maintenance_next_at,CASE WHEN policy.maintenance_error IS NULL
      AND policy.maintenance_membership_revision<coalesce(changes.revision,0) THEN changes.changed_at END),
      policy.workspace_id LIMIT greatest(1,least(coalesce(p_limit,20),100))$new$);
  anchor:='IF saved.config IS NOT NULL AND saved.maintenance_next_at<=clock_timestamp() THEN';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance maintenance recheck';
  END IF;
  definition:=replace(definition,anchor,$new$IF saved.config IS NOT NULL AND (saved.maintenance_next_at<=clock_timestamp()
        OR (saved.maintenance_error IS NULL AND saved.maintenance_membership_revision<target.membership_target_revision)) THEN
        IF saved.maintenance_membership_revision<target.membership_target_revision THEN
          saved.maintenance_cursor:=NULL;
        END IF;$new$);
  anchor:='UPDATE opengeni_private.workspace_usage_allowances SET maintenance_cursor=CASE';
  IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
    RAISE EXCEPTION 'unexpected allowance maintenance completion';
  END IF;
  definition:=replace(definition,anchor,'UPDATE opengeni_private.workspace_usage_allowances SET membership_revision=CASE WHEN seen>member_limit THEN saved.membership_revision ELSE greatest(saved.membership_revision,target.membership_target_revision) END,
          maintenance_membership_revision=greatest(saved.maintenance_membership_revision,target.membership_target_revision),
          maintenance_cursor=CASE');
  -- Never write account markers while holding workspace locks. The source-row
  -- trigger checkpoints the observed revision in the private projection.
  EXECUTE definition;
END $membership_maintenance$;
