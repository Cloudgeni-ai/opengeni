-- deployment-mode: maintenance
-- Stop old runtimes: installed Skill reads now resolve the registry head.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF to_regclass('pg_temp.skill_metadata_0426') IS NULL THEN
    RAISE EXCEPTION '0426 requires the parser-backed TypeScript migration runner' USING ERRCODE='55000';
  END IF;
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) r WHERE jsonb_typeof(r) <> 'string' OR length(btrim(r #>> '{}')) NOT BETWEEN 1 AND 63)
  THEN RAISE EXCEPTION '0426 requires explicit application database roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON a.usename = r.value
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid())
  THEN RAISE EXCEPTION '0426 requires drained application sessions' USING ERRCODE = '55000'; END IF;
END $drain$;

-- NULL means the historical single content file. Never rewrite old hashes or snapshots.
ALTER TABLE preference_registry_revisions ADD COLUMN skill_files jsonb;
ALTER TABLE preference_registry_revisions ADD COLUMN skill_activation_mode text
  CHECK (skill_activation_mode IN ('workspace_managed','session_selected'));
-- Description is the full SKILL.md metadata projection, not a shortened summary.
-- Revalidate the wider shape without rewriting immutable historical values.
ALTER TABLE preference_registry_revisions DROP CONSTRAINT preference_registry_revisions_text_chk;
ALTER TABLE preference_registry_revisions ADD CONSTRAINT preference_registry_revisions_text_chk CHECK (
  length(btrim(title)) BETWEEN 1 AND 120
  AND length(btrim(description)) BETWEEN 1 AND 1024
  AND length(btrim(content)) > 0 AND length(content) <= 262144
);
ALTER TABLE preference_registry_revisions DROP CONSTRAINT preference_registry_revisions_provenance_chk;
ALTER TABLE preference_registry_revisions ADD CONSTRAINT preference_registry_revisions_provenance_chk CHECK (
  provenance_source IN ('human','onboarding','knowledge_proposal','imported_document','slack','meeting_transcript','call_transcript','agent','portable_skill')
  AND trust IN ('untrusted_proposal','personal','workspace_managed','organization_managed')
  AND (provenance_source_id IS NULL OR length(provenance_source_id) BETWEEN 1 AND 512)
  AND (provenance_source IN ('human','onboarding') OR provenance_source_id IS NOT NULL)
);

CREATE FUNCTION skill_files_valid(files jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog AS $$
DECLARE f jsonb; paths text[] := '{}'; total integer := 0; bytes integer;
BEGIN
  IF files IS NULL OR jsonb_typeof(files) <> 'array' OR jsonb_array_length(files) NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(files) LOOP
    IF jsonb_typeof(f) <> 'object' OR jsonb_typeof(f->'path') IS DISTINCT FROM 'string'
      OR (f - 'path' - 'content') <> '{}'::jsonb
      OR jsonb_typeof(f->'content') IS DISTINCT FROM 'string' OR length(f->>'path') NOT BETWEEN 1 AND 512
      OR f->>'path' ~ '(^/|\\|(^|/)\.\.?(/|$)|//|/$|[[:cntrl:]]|:)'
      OR f->>'path' = ANY(paths)
      OR EXISTS (SELECT 1 FROM unnest(paths) existing WHERE starts_with(f->>'path', existing||'/') OR starts_with(existing, (f->>'path')||'/'))
      THEN RETURN false; END IF;
    bytes := octet_length(convert_to(f->>'content', 'UTF8'));
    IF bytes > 262144 THEN RETURN false; END IF;
    total := total + bytes; paths := array_append(paths, f->>'path');
  END LOOP;
  RETURN total <= 1048576 AND 'SKILL.md' = ANY(paths)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(files) entry WHERE entry->>'path' = 'SKILL.md' AND length(btrim(entry->>'content')) > 0);
END $$;
ALTER TABLE preference_registry_revisions ADD CONSTRAINT preference_registry_skill_files_chk CHECK (
  skill_files IS NULL OR (skill_files_valid(skill_files) AND content = (
    jsonb_path_query_first(skill_files, '$[*] ? (@.path == "SKILL.md").content') #>> '{}'))
);

CREATE TABLE skill_source_bindings (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  plugin_id uuid NOT NULL REFERENCES capability_plugins(id) ON DELETE RESTRICT,
  facet_key text NOT NULL,
  preference_id uuid NOT NULL,
  skill_facet_id uuid NOT NULL REFERENCES capability_skill_facets(facet_id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, plugin_id, facet_key),
  UNIQUE (preference_id),
  FOREIGN KEY (account_id, preference_id) REFERENCES preference_registry_preferences(account_id,id) ON DELETE RESTRICT
);
CREATE TABLE skill_write_receipts (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL,
  fingerprint text NOT NULL,
  actor jsonb NOT NULL,
  receipt jsonb NOT NULL,
  activation_event_id uuid REFERENCES preference_registry_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, operation_id)
);
CREATE TRIGGER skill_write_receipts_immutable BEFORE UPDATE OR DELETE ON skill_write_receipts
FOR EACH ROW EXECUTE FUNCTION preference_registry_reject_history_mutation();

-- Maintenance audit only: never a current Skill/content authority. Original
-- JSON survives source replacement, but not deletion of its owning workspace.
CREATE TABLE skill_config_conversion_receipts (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('session','workspace-pack')),
  source_id uuid NOT NULL,
  conversion_version text NOT NULL DEFAULT '0426-v1' CHECK (conversion_version='0426-v1'),
  actor text NOT NULL DEFAULT 'service:skill-migration:0426' CHECK (actor='service:skill-migration:0426'),
  original_configuration jsonb NOT NULL,
  original_hash text NOT NULL CHECK (original_hash=encode(sha256(convert_to(original_configuration::text,'UTF8')),'hex')),
  replacement_hash text NOT NULL CHECK (replacement_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,source_kind,source_id,conversion_version),
  FOREIGN KEY (workspace_id,account_id) REFERENCES workspaces(id,account_id) ON DELETE CASCADE
);
CREATE FUNCTION opengeni_private.reject_skill_config_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Same workspace-retention boundary as 0339 document migration receipts:
  -- only a parent referential cascade may remove otherwise immutable evidence.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Skill configuration receipts are immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION opengeni_private.reject_skill_config_receipt_mutation() FROM PUBLIC;
CREATE TRIGGER skill_config_conversion_receipts_immutable BEFORE UPDATE OR DELETE ON skill_config_conversion_receipts
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_skill_config_receipt_mutation();

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skill_source_bindings','skill_write_receipts','skill_config_conversion_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY skill_workspace_scope ON %I USING (account_id = nullif(current_setting(''opengeni.account_id'', true), '''')::uuid AND workspace_id = nullif(current_setting(''opengeni.workspace_id'', true), '''')::uuid)', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $rls$;

-- Override any deployment default grants: archived Session JSON can be private.
DO $config_receipt_grants$
DECLARE runtime_role text;
BEGIN
  FOR runtime_role IN SELECT jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('REVOKE ALL ON skill_config_conversion_receipts FROM %I',runtime_role);
    END IF;
  END LOOP;
END $config_receipt_grants$;

-- This is a separate truthful agent lifecycle, not a human-session impersonation.
-- Used only at publication boundaries, never to reinterpret historical snapshots.
CREATE FUNCTION skill_source_has_effective_owner(p_account_id uuid,p_workspace_id uuid,p_facet_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM capability_facet_installations fi
    JOIN capability_plugin_installations child ON child.id=fi.plugin_installation_id
    JOIN capability_component_owners owner ON owner.facet_installation_id=fi.id
      AND owner.account_id=fi.account_id AND owner.workspace_id=fi.workspace_id
    WHERE fi.account_id=p_account_id AND fi.workspace_id=p_workspace_id AND fi.facet_id=p_facet_id
      AND fi.status='active' AND child.status='active'
      AND (owner.owner_kind NOT IN ('pack','plugin')
        OR (owner.owner_kind='pack' AND (owner.owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR EXISTS(SELECT 1 FROM pack_installations parent WHERE parent.id::text=owner.owner_id
            AND parent.account_id=p_account_id AND parent.workspace_id=p_workspace_id AND parent.status='active')))
        OR (owner.owner_kind='plugin' AND EXISTS(SELECT 1 FROM capability_plugin_installations parent
          WHERE parent.id::text=owner.owner_id AND parent.account_id=p_account_id AND parent.workspace_id=p_workspace_id AND parent.status='active')))
  )
$$;
REVOKE ALL ON FUNCTION skill_source_has_effective_owner(uuid,uuid,uuid) FROM PUBLIC;

-- The caller supplies trusted HTTP identity or host-bound exact attempt claims.
-- Machine credentials may install sources only, under workspace Learning mode.
CREATE FUNCTION skill_apply_lifecycle(p_account_id uuid, p_workspace_id uuid, p_actor jsonb, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
<<lifecycle>>
DECLARE
  actor_subject text; mode text := 'automatic'; operation text := p_request->>'operation';
  operation_id uuid := (p_request->>'operationId')::uuid;
  skill_id uuid := (p_request->>'skillId')::uuid;
  revision_id uuid; activation_event_id uuid; files jsonb := p_request->'files'; main_content text;
  head preference_registry_preferences%ROWTYPE; rev preference_registry_revisions%ROWTYPE;
  source record; binding skill_source_bindings%ROWTYPE;
  prior skill_write_receipts%ROWTYPE; result jsonb; fingerprint text;
  scope text := coalesce(p_request->>'scope','workspace'); next_event integer;
  title text := p_request->>'title'; description text := p_request->>'description';
  stable_key text := p_request->>'stableKey'; outcome text; source_id text;
  activation_mode text := 'workspace_managed';
  deferred_publication jsonb; source_effective boolean := true;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid
    OR p_account_id IS NULL OR p_workspace_id IS NULL OR operation_id IS NULL
    OR operation NOT IN ('save','install','approve','restore') OR operation IS NULL
  THEN RAISE EXCEPTION 'Skill lifecycle requires exact tenant context' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM workspaces WHERE id=p_workspace_id AND account_id=p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill workspace unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-publication:'||p_workspace_id,0));
  IF p_actor->>'kind' = 'agent' THEN
    IF scope <> 'workspace' OR operation = 'approve' THEN
      RAISE EXCEPTION 'Agents manage workspace Skills only and cannot approve' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM sessions s JOIN session_turns t ON t.id=s.active_turn_id AND t.session_id=s.id
      JOIN session_turn_attempts a ON a.id=t.active_attempt_id AND a.turn_id=t.id
      WHERE s.id=(p_actor->>'sessionId')::uuid AND s.account_id=p_account_id AND s.workspace_id=p_workspace_id
        AND t.id=(p_actor->>'turnId')::uuid AND t.account_id=p_account_id AND t.workspace_id=p_workspace_id
        AND t.status IN ('running','requires_action','recovering','waiting_capacity')
        AND a.id=(p_actor->>'attemptId')::uuid AND a.account_id=p_account_id AND a.workspace_id=p_workspace_id
        AND a.session_id=s.id AND a.execution_generation=(p_actor->>'executionGeneration')::integer
        AND t.execution_generation=a.execution_generation AND a.state IN ('claimed','running')
        AND NOT EXISTS (SELECT 1 FROM session_attempt_interruptions i WHERE i.workspace_id=p_workspace_id
          AND i.attempt_id=a.id AND i.state IN ('pending','delivered','acknowledged'))
      FOR SHARE OF s,t,a;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill write requires exact live attempt' USING ERRCODE='42501'; END IF;
    actor_subject := 'service:skill-attempt:' || (p_actor->>'attemptId');
  ELSIF p_actor->>'kind' = 'human' AND p_actor->>'principalKind' = 'human_session'
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'')
    AND current_setting('opengeni.principal_kind',true) = 'human_session' THEN
    actor_subject := p_actor->>'subjectId';
  ELSIF p_actor->>'kind' = 'service' AND operation = 'install' AND scope = 'workspace'
    AND p_actor->>'principalKind' IN ('service','api_key','configured_key')
    AND p_actor->>'subjectId' = nullif(current_setting('opengeni.subject_id',true),'')
    AND p_actor->>'principalKind' = current_setting('opengeni.principal_kind',true) THEN
    actor_subject := p_actor->>'subjectId';
  ELSE RAISE EXCEPTION 'Skill lifecycle actor is not authorized' USING ERRCODE='42501'; END IF;

  fingerprint := encode(sha256(convert_to(jsonb_build_array(p_actor,p_request)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-operation:'||p_workspace_id||':'||operation_id,0));
  SELECT * INTO prior FROM skill_write_receipts r WHERE r.workspace_id=p_workspace_id AND r.operation_id=lifecycle.operation_id;
  IF FOUND THEN
    IF prior.fingerprint <> fingerprint OR prior.account_id <> p_account_id THEN
      RAISE EXCEPTION 'Skill operation key reused with different input' USING ERRCODE='23505'; END IF;
    RETURN (prior.receipt - 'portableInstall' - 'deferredPublication') || jsonb_build_object('replayed',true);
  END IF;
  IF p_actor->>'kind' IN ('agent','service') THEN
    SELECT r.workspace_mode INTO mode FROM workspace_learning_policy_heads h
      JOIN workspace_learning_policy_revisions r ON r.id=h.revision_id AND r.account_id=h.account_id
      WHERE h.account_id=p_account_id AND h.workspace_id=p_workspace_id FOR SHARE OF h;
    mode := coalesce(mode,'suggest');
    IF mode = 'off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
  END IF;

  IF operation = 'install' THEN
    SELECT f.facet_key, f.activation_mode, v.plugin_id, sf.*, coalesce(jsonb_agg(jsonb_build_object('path',ff.path,'content',ff.content) ORDER BY ff.path)
      FILTER (WHERE ff.id IS NOT NULL),'[]'::jsonb) AS files INTO source
      FROM capability_skill_facets sf JOIN capability_facets f ON f.id=sf.facet_id
      JOIN capability_plugin_versions v ON v.id=f.plugin_version_id
      JOIN capability_plugin_installations i ON i.plugin_version_id=v.id AND i.plugin_id=v.plugin_id
      JOIN capability_facet_installations fi ON fi.plugin_installation_id=i.id AND fi.facet_id=f.id AND fi.status='active'
      LEFT JOIN capability_skill_files ff ON ff.skill_facet_id=sf.facet_id
      WHERE sf.facet_id=(p_request->>'skillFacetId')::uuid AND i.account_id=p_account_id
        AND i.workspace_id=p_workspace_id AND i.status='active'
      GROUP BY f.facet_key,f.activation_mode,v.plugin_id,sf.facet_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Skill source is not installed in this workspace' USING ERRCODE='42501'; END IF;
    source_effective := skill_source_has_effective_owner(p_account_id,p_workspace_id,source.facet_id);
    PERFORM pg_advisory_xact_lock(hashtextextended('skill-source:'||p_workspace_id||':'||source.plugin_id||':'||source.facet_key,0));
    SELECT * INTO binding FROM skill_source_bindings b WHERE b.workspace_id=p_workspace_id
      AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
    skill_id := coalesce(binding.preference_id,gen_random_uuid());
    files := source.files; title := p_request->>'title'; description := p_request->>'description';
    stable_key := 'installed-'||replace(skill_id::text,'-',''); source_id := source.facet_id::text;
    activation_mode := source.activation_mode;
  END IF;
  SELECT * INTO head FROM preference_registry_preferences h WHERE h.id=skill_id AND h.account_id=p_account_id FOR UPDATE;
  IF FOUND THEN
    scope := head.scope;
    IF operation <> 'install' THEN
      SELECT coalesce(r.skill_activation_mode,'workspace_managed') INTO activation_mode
        FROM preference_registry_revisions r WHERE r.preference_id=head.id
        ORDER BY (r.id=head.active_revision_id) DESC NULLS LAST,r.revision DESC LIMIT 1;
    END IF;
    IF (p_actor->>'kind' IN ('agent','service') AND (head.scope <> 'workspace' OR head.scope_workspace_id <> p_workspace_id))
      OR (p_actor->>'kind' = 'human' AND NOT opengeni_private.preference_registry_scope_visible(
        head.account_id,head.scope,head.scope_workspace_id,head.scope_subject_id)) THEN
      RAISE EXCEPTION 'Skill is outside authorized scope' USING ERRCODE='42501'; END IF;
    IF operation = 'install' THEN
      SELECT * INTO rev FROM preference_registry_revisions WHERE id=head.active_revision_id;
      IF head.active_revision_id IS NOT NULL AND (rev.provenance_source <> 'portable_skill' OR rev.provenance_source_id=source_id) THEN
        revision_id := head.active_revision_id; outcome := 'preserved';
      END IF;
    ELSIF head.active_revision_id IS DISTINCT FROM (p_request->>'expectedRevisionId')::uuid
      OR head.scope_version IS DISTINCT FROM (p_request->>'expectedScopeVersion')::integer THEN
      RAISE EXCEPTION 'Skill head changed' USING ERRCODE='40001';
    END IF;
    IF head.status IN ('rejected','superseded') THEN RAISE EXCEPTION 'Skill head is retired' USING ERRCODE='23514'; END IF;
  ELSE
    IF operation NOT IN ('save','install') OR (p_request->>'expectedRevisionId') IS NOT NULL
      OR (operation='save' AND (p_request->>'expectedScopeVersion')::integer IS DISTINCT FROM 1) THEN
      RAISE EXCEPTION 'Skill head missing or changed' USING ERRCODE='40001'; END IF;
    INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,scope_subject_id,created_by_subject_id)
      VALUES(skill_id,p_account_id,stable_key,scope,CASE WHEN scope='workspace' THEN p_workspace_id END,
        CASE WHEN scope='user' THEN actor_subject END,actor_subject) RETURNING * INTO head;
  END IF;

  IF outcome IS NULL THEN
    IF operation IN ('approve','restore') THEN
      SELECT * INTO rev FROM preference_registry_revisions r WHERE r.id=(p_request->>'revisionId')::uuid
        AND r.account_id=p_account_id AND r.preference_id=skill_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Skill revision unavailable' USING ERRCODE='42501'; END IF;
      files := coalesce(rev.skill_files,jsonb_build_array(jsonb_build_object('path','SKILL.md','content',rev.content)));
      title := p_request->>'title'; description := p_request->>'description';
      activation_mode := coalesce(rev.skill_activation_mode,'workspace_managed');
      IF operation='approve' AND rev.provenance_source='portable_skill' AND EXISTS(
        SELECT 1 FROM skill_source_bindings b WHERE b.preference_id=skill_id AND b.account_id=p_account_id
          AND NOT skill_source_has_effective_owner(p_account_id,b.workspace_id,rev.provenance_source_id::uuid)) THEN
        RAISE EXCEPTION 'Skill approval requires a finalized source owner' USING ERRCODE='42501';
      END IF;
    END IF;
    IF NOT skill_files_valid(files) THEN RAISE EXCEPTION 'Invalid Skill text folder' USING ERRCODE='22023'; END IF;
    SELECT f->>'content' INTO main_content FROM jsonb_array_elements(files) f WHERE f->>'path'='SKILL.md';
    IF operation = 'approve' THEN revision_id := rev.id;
    ELSE
      INSERT INTO preference_registry_revisions(account_id,preference_id,title,description,content,content_hash,
        conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id,corrects_revision_id,skill_files,skill_activation_mode)
      VALUES(p_account_id,skill_id,title,description,main_content,encode(sha256(convert_to(main_content,'UTF8')),'hex'),
        'override',CASE WHEN operation='install' THEN 'portable_skill' WHEN p_actor->>'kind'='agent' THEN 'agent' ELSE 'human' END,
        CASE WHEN operation='install' THEN source_id WHEN p_actor->>'kind'='agent' THEN p_actor->>'attemptId' END,
        CASE WHEN p_actor->>'kind' IN ('agent','service') THEN 'untrusted_proposal' WHEN scope='user' THEN 'personal'
          WHEN scope='organization' THEN 'organization_managed' ELSE 'workspace_managed' END,
        actor_subject,head.active_revision_id,files,activation_mode) RETURNING id INTO revision_id;
    END IF;
    SELECT coalesce(max(e.version),0)+1 INTO next_event FROM preference_registry_events e WHERE e.preference_id=skill_id;
    IF next_event=1 THEN
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,new_subject_id,actor_subject_id,reason)
      VALUES(p_account_id,skill_id,'proposal_created',next_event,revision_id,head.scope,head.scope_workspace_id,head.scope_subject_id,actor_subject,p_request->>'reason');
      next_event := next_event+1;
    END IF;
    IF mode='automatic' AND operation='install' AND NOT source_effective THEN
      deferred_publication := jsonb_build_object('expectedRevisionId',head.active_revision_id,
        'expectedScopeVersion',head.scope_version,'sourceFacetId',source.facet_id);
    END IF;
    IF mode='automatic' AND deferred_publication IS NULL THEN
      PERFORM set_config('opengeni.preference_lifecycle_head_id',skill_id::text,true);
      PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
      UPDATE preference_registry_preferences h SET status='active',active_revision_id=revision_id,
        active_revision=r.revision,active_content_hash=r.content_hash,activation_version=h.activation_version+1,updated_at=clock_timestamp()
        FROM preference_registry_revisions r WHERE h.id=skill_id AND r.id=revision_id;
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,new_revision_id,actor_subject_id,reason)
        VALUES(p_account_id,skill_id,'activated',next_event,head.active_revision_id,revision_id,actor_subject,p_request->>'reason') RETURNING id INTO activation_event_id;
      outcome := 'applied';
    ELSE outcome := 'pending'; END IF;
    IF operation='install' THEN
      INSERT INTO skill_source_bindings VALUES(p_account_id,p_workspace_id,source.plugin_id,source.facet_key,skill_id,source.facet_id)
      ON CONFLICT(workspace_id,plugin_id,facet_key) DO UPDATE SET skill_facet_id=excluded.skill_facet_id;
    END IF;
  END IF;
  IF operation='install' AND outcome='preserved' THEN
    UPDATE skill_source_bindings b SET skill_facet_id=source.facet_id
      WHERE b.workspace_id=p_workspace_id AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
  END IF;
  result := jsonb_build_object('operationId',operation_id,'skillId',skill_id,'revisionId',revision_id,'outcome',outcome,'replayed',false);
  IF deferred_publication IS NOT NULL THEN result := result || jsonb_build_object('pendingReason','source_finalization'); END IF;
  INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt,activation_event_id)
    VALUES(p_account_id,p_workspace_id,operation_id,fingerprint,p_actor,
      (CASE WHEN operation='install' AND p_request ? 'portableInstall'
        THEN result || jsonb_build_object('portableInstall',p_request->'portableInstall') ELSE result END)
      || CASE WHEN deferred_publication IS NOT NULL THEN jsonb_build_object('deferredPublication',deferred_publication) ELSE '{}'::jsonb END,
      activation_event_id);
  RETURN result;
END $body$;

DO $secure$
BEGIN
  EXECUTE format('ALTER FUNCTION skill_apply_lifecycle(uuid,uuid,jsonb,jsonb) SET search_path = %I, pg_catalog, pg_temp',current_schema());
  REVOKE ALL ON FUNCTION skill_apply_lifecycle(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
END $secure$;

-- Parent status and these immutable completion receipts commit in one transaction.
-- There is intentionally no runtime EXECUTE grant for this publication capability.
CREATE FUNCTION skill_publish_finalized_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  publication_owner_kind text := CASE TG_TABLE_NAME WHEN 'pack_installations' THEN 'pack' ELSE 'plugin' END;
  pending record; head preference_registry_preferences%ROWTYPE; revision preference_registry_revisions%ROWTYPE;
  publication_id uuid; publication_hash text; publication_operation uuid; expected_fingerprint text; event_id uuid;
  next_event integer; result jsonb; disposition text; current_mode text; parent_target text;
  publication_actor jsonb := jsonb_build_object('kind','service','subjectId','service:skill-publication','principalKind','service');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-publication:'||NEW.workspace_id,0));
  FOR pending IN
    SELECT DISTINCT receipt.* FROM skill_write_receipts receipt
    JOIN skill_source_bindings binding ON binding.preference_id=(receipt.receipt->>'skillId')::uuid
      AND binding.account_id=receipt.account_id AND binding.workspace_id=receipt.workspace_id
    JOIN capability_facet_installations fi ON fi.facet_id=binding.skill_facet_id
      AND fi.account_id=binding.account_id AND fi.workspace_id=binding.workspace_id
    JOIN capability_component_owners owner ON owner.facet_installation_id=fi.id
      AND owner.account_id=fi.account_id AND owner.workspace_id=fi.workspace_id
    WHERE receipt.account_id=NEW.account_id AND receipt.workspace_id=NEW.workspace_id
      AND receipt.receipt ? 'deferredPublication' AND owner.owner_kind=publication_owner_kind AND owner.owner_id=NEW.id::text
    ORDER BY receipt.created_at,receipt.operation_id
  LOOP
    publication_hash := md5('skill-publication:'||pending.operation_id);
    publication_id := (substr(publication_hash,1,12)||'5'||substr(publication_hash,14,3)||'a'||substr(publication_hash,18,15))::uuid;
    expected_fingerprint := encode(sha256(convert_to('skill-publication:'||pending.fingerprint,'UTF8')),'hex');
    IF EXISTS(SELECT 1 FROM skill_write_receipts existing WHERE existing.workspace_id=NEW.workspace_id AND existing.operation_id=publication_id) THEN
      IF NOT EXISTS(SELECT 1 FROM skill_write_receipts existing WHERE existing.workspace_id=NEW.workspace_id AND existing.operation_id=publication_id
        AND existing.fingerprint=expected_fingerprint AND existing.receipt->>'sourceOperationId'=pending.operation_id::text) THEN
        RAISE EXCEPTION 'Skill publication operation identity collision' USING ERRCODE='23505';
      END IF;
      CONTINUE;
    END IF;
    publication_operation := nullif(current_setting('opengeni.skill_publication_operation_id',true),'')::uuid;
    IF publication_owner_kind='pack' THEN parent_target := NEW.pack_id;
    ELSE SELECT plugin_key INTO parent_target FROM capability_plugins WHERE id=NEW.plugin_id; END IF;
    IF publication_operation IS NULL OR NOT EXISTS(SELECT 1 FROM capability_operations operation
      WHERE operation.id=publication_operation AND operation.account_id=NEW.account_id AND operation.workspace_id=NEW.workspace_id
        AND operation.target_kind=publication_owner_kind AND operation.target_id=parent_target AND operation.status='running') THEN
      RAISE EXCEPTION 'Skill publication requires a claimed parent finalization' USING ERRCODE='42501';
    END IF;
    SELECT * INTO head FROM preference_registry_preferences WHERE id=(pending.receipt->>'skillId')::uuid AND account_id=NEW.account_id FOR UPDATE;
    SELECT * INTO revision FROM preference_registry_revisions WHERE id=(pending.receipt->>'revisionId')::uuid AND account_id=NEW.account_id;
    disposition := 'preserved'; event_id := NULL; current_mode := 'automatic';
    IF pending.actor->>'kind' <> 'human' THEN
      SELECT policy.workspace_mode INTO current_mode FROM workspace_learning_policy_heads policy_head
      JOIN workspace_learning_policy_revisions policy ON policy.id=policy_head.revision_id AND policy.account_id=policy_head.account_id
      WHERE policy_head.account_id=NEW.account_id AND policy_head.workspace_id=NEW.workspace_id FOR SHARE OF policy_head;
      current_mode := coalesce(current_mode,'suggest');
    END IF;
    IF pending.actor->>'kind'='agent' THEN
      PERFORM 1 FROM sessions session JOIN session_turns turn ON turn.id=session.active_turn_id AND turn.session_id=session.id
        JOIN session_turn_attempts attempt ON attempt.id=turn.active_attempt_id AND attempt.turn_id=turn.id
      WHERE session.id=(pending.actor->>'sessionId')::uuid AND session.account_id=NEW.account_id AND session.workspace_id=NEW.workspace_id
        AND turn.id=(pending.actor->>'turnId')::uuid AND turn.account_id=NEW.account_id AND turn.workspace_id=NEW.workspace_id
        AND turn.status IN ('running','requires_action','recovering','waiting_capacity')
        AND attempt.id=(pending.actor->>'attemptId')::uuid AND attempt.account_id=NEW.account_id AND attempt.workspace_id=NEW.workspace_id
        AND attempt.session_id=session.id AND attempt.execution_generation=(pending.actor->>'executionGeneration')::integer
        AND turn.execution_generation=attempt.execution_generation AND attempt.state IN ('claimed','running')
        AND NOT EXISTS(SELECT 1 FROM session_attempt_interruptions interruption WHERE interruption.workspace_id=NEW.workspace_id
          AND interruption.attempt_id=attempt.id AND interruption.state IN ('pending','delivered','acknowledged'))
      FOR SHARE OF session,turn,attempt;
      IF NOT FOUND THEN current_mode := 'suggest'; END IF;
    END IF;
    IF head.status NOT IN ('rejected','superseded') AND head.scope='workspace' AND head.scope_workspace_id=NEW.workspace_id
      AND head.scope_version=(pending.receipt->'deferredPublication'->>'expectedScopeVersion')::integer
      AND head.active_revision_id IS NOT DISTINCT FROM (pending.receipt->'deferredPublication'->>'expectedRevisionId')::uuid
      AND revision.revision=(SELECT max(r.revision) FROM preference_registry_revisions r WHERE r.preference_id=head.id)
      AND (revision.expires_at IS NULL OR revision.expires_at>clock_timestamp())
      AND EXISTS(SELECT 1 FROM skill_source_bindings binding WHERE binding.preference_id=head.id
        AND binding.skill_facet_id=(pending.receipt->'deferredPublication'->>'sourceFacetId')::uuid)
      AND skill_source_has_effective_owner(NEW.account_id,NEW.workspace_id,(pending.receipt->'deferredPublication'->>'sourceFacetId')::uuid)
    THEN
      IF current_mode='automatic' THEN
        PERFORM set_config('opengeni.preference_lifecycle_head_id',head.id::text,true);
        PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
        UPDATE preference_registry_preferences SET status='active',active_revision_id=revision.id,
          active_revision=revision.revision,active_content_hash=revision.content_hash,activation_version=activation_version+1,updated_at=clock_timestamp()
          WHERE id=head.id;
        SELECT coalesce(max(version),0)+1 INTO next_event FROM preference_registry_events WHERE preference_id=head.id;
        INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,new_revision_id,actor_subject_id,reason)
          VALUES(NEW.account_id,head.id,'activated',next_event,head.active_revision_id,revision.id,'service:skill-publication',
            'Publish previously authorized Skill after composite owner finalization') RETURNING id INTO event_id;
        disposition := 'applied';
      ELSE disposition := 'pending'; END IF;
    END IF;
    result := jsonb_build_object('operationId',publication_id,'sourceOperationId',pending.operation_id,
      'skillId',pending.receipt->>'skillId','revisionId',pending.receipt->>'revisionId','outcome',disposition,
      'activationEventId',event_id,'replayed',false,'publicationOperationId',publication_operation);
    IF disposition='pending' THEN result := result || jsonb_build_object('pendingReason','approval'); END IF;
    INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt,activation_event_id)
      VALUES(NEW.account_id,NEW.workspace_id,publication_id,expected_fingerprint,publication_actor,result,event_id);
  END LOOP;
  RETURN NEW;
END $$;
DO $publication_secure$
BEGIN
  EXECUTE format('ALTER FUNCTION skill_source_has_effective_owner(uuid,uuid,uuid) SET search_path = %I, pg_catalog, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION skill_publish_finalized_owner() SET search_path = %I, pg_catalog, pg_temp',current_schema());
  REVOKE ALL ON FUNCTION skill_publish_finalized_owner() FROM PUBLIC;
END $publication_secure$;
CREATE TRIGGER skill_publish_pack_owner AFTER UPDATE OF status ON pack_installations
FOR EACH ROW WHEN (NEW.status='active' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION skill_publish_finalized_owner();
CREATE TRIGGER skill_publish_plugin_owner AFTER UPDATE OF status ON capability_plugin_installations
FOR EACH ROW WHEN (NEW.status='active' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION skill_publish_finalized_owner();

-- Backfill by immutable portable identity, never by matching names or bytes.
-- Distribution owners/manifests/files remain untouched and keep their upstream history.
-- FORCE RLS also binds the non-superuser migration owner. Relax only that owner
-- for every source/target read (including head-validation/event triggers).
ALTER TABLE capability_plugin_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_skill_facets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_skill_files NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_component_owners NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facet_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_source_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_config_conversion_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_packs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_run_event_links NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pack_installations NO FORCE ROW LEVEL SECURITY;
-- The runner invokes the shared contracts parser here, inside this transaction.
-- Raw SQL execution fails closed below without its owner-local staging table.
-- opengeni:skill-metadata-stage-v1
DO $backfill$
DECLARE source record; legacy record; skill_id uuid; revision_id uuid; main_content text; next_event bigint;
BEGIN
  FOR source IN
    SELECT i.account_id,i.workspace_id,i.plugin_id,f.facet_key,f.activation_mode,sf.facet_id,
      metadata.files,metadata.name,metadata.description
    FROM capability_plugin_installations i JOIN capability_facets f ON f.plugin_version_id=i.plugin_version_id
    JOIN capability_skill_facets sf ON sf.facet_id=f.id
    JOIN pg_temp.skill_metadata_0426 metadata ON metadata.source_kind='installed' AND metadata.source_id=sf.facet_id
      AND metadata.account_id=i.account_id AND metadata.workspace_id=i.workspace_id
    WHERE i.status='active'
  LOOP
    IF NOT skill_files_valid(source.files) THEN RAISE EXCEPTION 'Installed Skill % has invalid text folder; repair before cutover',source.facet_id USING ERRCODE='22023'; END IF;
    IF NOT skill_source_has_effective_owner(source.account_id,source.workspace_id,source.facet_id) THEN
      RAISE EXCEPTION '0426 requires completing or disabling unfinished composite Skill source %',source.facet_id USING ERRCODE='55000';
    END IF;
    skill_id := gen_random_uuid(); revision_id := gen_random_uuid();
    SELECT f->>'content' INTO main_content FROM jsonb_array_elements(source.files) f WHERE f->>'path'='SKILL.md';
    INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,created_by_subject_id)
      VALUES(skill_id,source.account_id,'installed-'||replace(skill_id::text,'-',''),'workspace',source.workspace_id,'service:skill-migration:0426');
    INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,
      conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id,skill_files,skill_activation_mode)
      VALUES(revision_id,source.account_id,skill_id,source.name,source.description,main_content,
        encode(sha256(convert_to(main_content,'UTF8')),'hex'),'override','portable_skill',source.facet_id::text,
        'workspace_managed','service:skill-migration:0426',source.files,source.activation_mode);
    INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,actor_subject_id,reason)
      VALUES(source.account_id,skill_id,'proposal_created',1,revision_id,'workspace',source.workspace_id,
        'service:skill-migration:0426','Preserve installed portable Skill at unified lifecycle cutover');
    PERFORM set_config('opengeni.preference_lifecycle_head_id',skill_id::text,true);
    PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
    UPDATE preference_registry_preferences h SET status='active',active_revision_id=revision_id,
      active_revision=r.revision,active_content_hash=r.content_hash,activation_version=1
      FROM preference_registry_revisions r WHERE h.id=skill_id AND r.id=revision_id;
    INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,actor_subject_id,reason)
      VALUES(source.account_id,skill_id,'activated',2,revision_id,'service:skill-migration:0426','Preserve existing installation activation');
    INSERT INTO skill_source_bindings VALUES(source.account_id,source.workspace_id,source.plugin_id,source.facet_key,skill_id,source.facet_id);
  END LOOP;
  FOR legacy IN
    SELECT h.id,h.account_id,h.active_revision_id,h.activation_version,r.precedence_rank,r.conflict_strategy,
      r.conflicts_with,r.provenance_source,r.provenance_source_id,r.trust,r.expires_at,
      coalesce(r.skill_activation_mode,'workspace_managed') AS activation_mode,metadata.files,metadata.name,metadata.description
    FROM preference_registry_preferences h JOIN preference_registry_revisions r ON r.id=h.active_revision_id
      AND r.preference_id=h.id AND r.account_id=h.account_id
    JOIN pg_temp.skill_metadata_0426 metadata ON metadata.source_kind='authored' AND metadata.source_id=h.id
      AND metadata.account_id=h.account_id
    WHERE h.status='active'
  LOOP
    revision_id := gen_random_uuid();
    SELECT f->>'content' INTO main_content FROM jsonb_array_elements(legacy.files) f WHERE f->>'path'='SKILL.md';
    INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,
      precedence_rank,conflict_strategy,conflicts_with,provenance_source,provenance_source_id,trust,expires_at,
      created_by_subject_id,corrects_revision_id,skill_files,skill_activation_mode)
      VALUES(revision_id,legacy.account_id,legacy.id,legacy.name,legacy.description,main_content,
        encode(sha256(convert_to(main_content,'UTF8')),'hex'),legacy.precedence_rank,legacy.conflict_strategy,
        legacy.conflicts_with,legacy.provenance_source,legacy.provenance_source_id,legacy.trust,legacy.expires_at,
        'service:skill-migration:0426',legacy.active_revision_id,legacy.files,legacy.activation_mode);
    PERFORM set_config('opengeni.preference_lifecycle_head_id',legacy.id::text,true);
    PERFORM set_config('opengeni.preference_lifecycle_operation','correct',true);
    UPDATE preference_registry_preferences h SET active_revision_id=revision_id,active_revision=r.revision,
      active_content_hash=r.content_hash,activation_version=legacy.activation_version+1
      FROM preference_registry_revisions r WHERE h.id=legacy.id AND r.id=revision_id;
    SELECT coalesce(max(e.version),0)+1 INTO next_event FROM preference_registry_events e WHERE e.preference_id=legacy.id;
    INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,new_revision_id,actor_subject_id,reason)
      VALUES(legacy.account_id,legacy.id,'corrected',next_event,legacy.active_revision_id,revision_id,
        'service:skill-migration:0426','Derive canonical Skill metadata; retain original immutable revision');
  END LOOP;
END $backfill$;
-- Flush creation-event validation while its exact event is owner-visible, and
-- deferred head/revision foreign keys before ALTER TABLE restores protection.
-- Pending FK trigger events otherwise reject the ALTER even with valid rows.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE capability_plugin_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facets FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_skill_facets FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_skill_files FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_component_owners FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facet_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_source_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_config_conversion_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_packs FORCE ROW LEVEL SECURITY;
ALTER TABLE session_turns FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_run_event_links FORCE ROW LEVEL SECURITY;
ALTER TABLE pack_installations FORCE ROW LEVEL SECURITY;

-- All new writes use files after cutover, including formerly legacy CREATE.
-- Keep historical rows/hashes unchanged; explicit restore creates a new folder revision.
CREATE FUNCTION skill_guard_legacy_revision() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.skill_files IS NULL THEN
    RAISE EXCEPTION 'Skill folder saves require the unified file lifecycle' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_guard_legacy_revision BEFORE INSERT ON preference_registry_revisions
FOR EACH ROW EXECUTE FUNCTION skill_guard_legacy_revision();

-- INSERT protection alone cannot stop legacy activation of a pre-cutover revision.
CREATE FUNCTION skill_guard_legacy_activation() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.active_revision_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.active_revision_id IS DISTINCT FROM OLD.active_revision_id)
    AND EXISTS(SELECT 1 FROM preference_registry_revisions target JOIN skill_source_bindings binding
      ON binding.preference_id=target.preference_id AND binding.account_id=target.account_id
      WHERE target.id=NEW.active_revision_id AND target.provenance_source='portable_skill'
        AND NOT skill_source_has_effective_owner(binding.account_id,binding.workspace_id,target.provenance_source_id::uuid)) THEN
    RAISE EXCEPTION 'Skill activation requires a finalized source owner' USING ERRCODE='42501';
  END IF;
  IF NEW.active_revision_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM preference_registry_revisions target
      WHERE target.account_id=NEW.account_id AND target.preference_id=NEW.id
        AND target.id=NEW.active_revision_id AND target.skill_files IS NULL)
    THEN
    RAISE EXCEPTION 'Skill folder activation requires a files-bearing revision; use unified restore' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_guard_legacy_activation BEFORE INSERT OR UPDATE ON preference_registry_preferences
FOR EACH ROW EXECUTE FUNCTION skill_guard_legacy_activation();

-- Activation metadata is bound to the exact event, so a later legacy human
-- activation cannot inherit an earlier Automatic receipt for the same revision.
CREATE FUNCTION skill_revision_activation_authority(p_revision_id uuid, p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT CASE WHEN r.actor->>'kind'='human' OR EXISTS(
    SELECT 1 FROM skill_write_receipts original WHERE original.account_id=r.account_id AND original.workspace_id=r.workspace_id
      AND original.operation_id::text=r.receipt->>'sourceOperationId' AND original.actor->>'kind'='human'
      AND original.receipt ? 'deferredPublication' AND original.receipt->>'revisionId'=revision.id::text
  ) THEN 'human_confirmed' ELSE 'automatic' END
  FROM preference_registry_revisions revision
  JOIN LATERAL (
    SELECT e.id,e.new_revision_id FROM preference_registry_events e
    WHERE e.preference_id=revision.preference_id AND e.account_id=revision.account_id AND e.created_at<=p_at
      AND e.type IN ('proposal_created','activated','corrected','rejected','deactivated','superseded')
    ORDER BY e.created_at DESC,e.version DESC,e.id DESC LIMIT 1
  ) latest ON latest.new_revision_id=revision.id
  JOIN skill_write_receipts r ON r.activation_event_id=latest.id AND r.account_id=revision.account_id
  WHERE revision.id=p_revision_id
$$;

CREATE OR REPLACE FUNCTION preference_registry_activation_authority(p_workspace_id uuid,p_revision_ids uuid[])
RETURNS TABLE(revision_id uuid,authority_kind text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $$
  WITH candidates AS (
    SELECT revision.id AS revision_id,skill_revision_activation_authority(revision.id,transaction_timestamp()) AS authority_kind,1 AS priority
    FROM preference_registry_revisions revision
    JOIN preference_registry_preferences h ON h.id=revision.preference_id AND h.account_id=revision.account_id
    WHERE revision.id=ANY(p_revision_ids)
      AND opengeni_private.workspace_rls_visible(revision.account_id,p_workspace_id)
      AND opengeni_private.preference_registry_scope_visible(h.account_id,h.scope,h.scope_workspace_id,h.scope_subject_id)
    UNION ALL
    (SELECT DISTINCT ON (receipt.destination_revision_id) receipt.destination_revision_id,receipt.authority_kind,2
    FROM governed_learning_activation_receipts receipt
    WHERE receipt.workspace_id=p_workspace_id AND receipt.destination='preference'
      AND receipt.destination_revision_id=ANY(p_revision_ids)
      AND opengeni_private.workspace_rls_visible(receipt.account_id,receipt.workspace_id)
      AND NOT EXISTS(SELECT 1 FROM governed_learning_activation_undo_receipts undo WHERE undo.account_id=receipt.account_id AND undo.activation_receipt_id=receipt.id)
    ORDER BY receipt.destination_revision_id,receipt.created_at DESC,receipt.id DESC)
  ) SELECT DISTINCT ON (revision_id) revision_id,authority_kind FROM candidates
    WHERE authority_kind IS NOT NULL ORDER BY revision_id,priority
$$;

-- Match-count-checked catalog replacement follows the existing forward-migration
-- convention (0416); keep the historical canonical projection otherwise exact.
DO $snapshot_authority$
DECLARE definition text; old_expression text := $old$'activationAuthority', ($old$;
  new_expression text := $new$'activationAuthority', coalesce(skill_revision_activation_authority(revision.id, p_accepted_at), ($new$;
  old_end text := $old$LIMIT 1
      ),
      'expiresAt'$old$;
  new_end text := $new$LIMIT 1
      )),
      'expiresAt'$new$;
  state_filter text := $old$WHERE state.type IN ('activated', 'corrected')$old$;
BEGIN
  definition := pg_get_functiondef('preference_registry_canonical_snapshot_at(uuid,uuid,text,timestamp with time zone)'::regprocedure);
  IF (length(definition)-length(replace(definition,old_expression,'')))/length(old_expression) <> 1
    OR (length(definition)-length(replace(definition,old_end,'')))/length(old_end) <> 1
    OR (length(definition)-length(replace(definition,state_filter,'')))/length(state_filter) <> 1 THEN
    RAISE EXCEPTION '0426 snapshot activation projection has drifted' USING ERRCODE='55000';
  END IF;
  definition := replace(replace(definition,old_expression,new_expression),old_end,new_end);
  EXECUTE replace(definition,state_filter,state_filter || $new$ AND coalesce(revision.skill_activation_mode,'workspace_managed')='workspace_managed'$new$);
  EXECUTE format('ALTER FUNCTION preference_registry_activation_authority(uuid,uuid[]) SET search_path = pg_catalog, %I, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION skill_revision_activation_authority(uuid,timestamptz) SET search_path = pg_catalog, %I, pg_temp',current_schema());
  REVOKE ALL ON FUNCTION preference_registry_activation_authority(uuid,uuid[]) FROM PUBLIC;
END $snapshot_authority$;

-- Restore pre-cutover workspace deletion for portable-origin Skills only.
-- Authored-origin heads and historical snapshots keep their existing retention
-- boundary. Direct head/history deletion remains forbidden even to runtime
-- callers that can delete their owning workspace.
ALTER TABLE preference_registry_preferences DROP CONSTRAINT preference_registry_preferences_scope_workspace_id_fkey;
ALTER TABLE preference_registry_preferences ADD CONSTRAINT preference_registry_preferences_scope_workspace_id_fkey
  FOREIGN KEY(scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

CREATE FUNCTION opengeni_private.guard_portable_skill_parent_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE old_account text := current_setting('opengeni.account_id',true);
  old_workspace text := current_setting('opengeni.workspace_id',true);
  original_portable boolean;
BEGIN
  IF TG_OP <> 'DELETE' OR pg_trigger_depth() <= 1 OR OLD.scope <> 'workspace' THEN
    RAISE EXCEPTION 'preference registry heads cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF (nullif(old_account,'') IS NOT NULL AND old_account::uuid IS DISTINCT FROM OLD.account_id)
    OR (nullif(old_workspace,'') IS NOT NULL AND old_workspace::uuid IS DISTINCT FROM OLD.scope_workspace_id) THEN
    RAISE EXCEPTION 'Skill parent cascade tenant context mismatch' USING ERRCODE='42501';
  END IF;
  -- Trigger-only authority, not a caller-set capability. Exact OLD tenancy is
  -- needed for FORCE-RLS reads even when the owner has no caller tenant GUCs.
  PERFORM set_config('opengeni.account_id',OLD.account_id::text,true);
  PERFORM set_config('opengeni.workspace_id',OLD.scope_workspace_id::text,true);
  SELECT r.provenance_source='portable_skill' AND r.skill_files IS NOT NULL
    AND e.new_scope='workspace' AND e.new_workspace_id=OLD.scope_workspace_id
    INTO original_portable
    FROM preference_registry_events e JOIN preference_registry_revisions r
      ON r.account_id=e.account_id AND r.preference_id=e.preference_id AND r.id=e.new_revision_id
    WHERE e.account_id=OLD.account_id AND e.preference_id=OLD.id
      AND e.type='proposal_created' AND e.version=1;
  IF original_portable IS DISTINCT FROM true OR EXISTS(
    SELECT 1 FROM preference_registry_events e WHERE e.account_id=OLD.account_id
      AND e.preference_id=OLD.id AND e.type='scope_changed') THEN
    RAISE EXCEPTION 'authored or scope-moved Skill history retains its workspace' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('opengeni.account_id',coalesce(old_account,''),true);
  PERFORM set_config('opengeni.workspace_id',coalesce(old_workspace,''),true);
  RETURN OLD;
END $$;
DO $portable_delete_search_path$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_portable_skill_parent_delete() SET search_path = pg_catalog, %I, pg_temp',current_schema());
END $portable_delete_search_path$;
REVOKE ALL ON FUNCTION opengeni_private.guard_portable_skill_parent_delete() FROM PUBLIC;
DROP TRIGGER preference_registry_preferences_lifecycle_only ON preference_registry_preferences;
CREATE TRIGGER preference_registry_preferences_lifecycle_only BEFORE UPDATE ON preference_registry_preferences
  FOR EACH ROW EXECUTE FUNCTION preference_registry_guard_head_mutation();
CREATE TRIGGER preference_registry_preferences_guard_delete BEFORE DELETE ON preference_registry_preferences
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_portable_skill_parent_delete();

-- Only these parent relationships cascade. Cross-Skill references and snapshots
-- remain restrictive; deleting one workspace must never erase another scope.
ALTER TABLE preference_registry_revisions DROP CONSTRAINT preference_registry_revisions_preference_fk;
ALTER TABLE preference_registry_revisions ADD CONSTRAINT preference_registry_revisions_preference_fk
  FOREIGN KEY(account_id,preference_id) REFERENCES preference_registry_preferences(account_id,id) ON DELETE CASCADE;
ALTER TABLE preference_registry_events DROP CONSTRAINT preference_registry_events_preference_fk;
ALTER TABLE preference_registry_events ADD CONSTRAINT preference_registry_events_preference_fk
  FOREIGN KEY(account_id,preference_id) REFERENCES preference_registry_preferences(account_id,id) ON DELETE CASCADE;

-- A single parent delete removes the whole eligible graph. NO ACTION at commit
-- preserves referential integrity without depending on sibling trigger order.
ALTER TABLE preference_registry_preferences DROP CONSTRAINT preference_registry_preferences_active_revision_fk;
ALTER TABLE preference_registry_preferences ADD CONSTRAINT preference_registry_preferences_active_revision_fk
  FOREIGN KEY(id,active_revision_id) REFERENCES preference_registry_revisions(preference_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE preference_registry_revisions DROP CONSTRAINT preference_registry_revisions_corrects_revision_id_fkey;
ALTER TABLE preference_registry_revisions ADD CONSTRAINT preference_registry_revisions_corrects_revision_id_fkey
  FOREIGN KEY(corrects_revision_id) REFERENCES preference_registry_revisions(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE preference_registry_events DROP CONSTRAINT preference_registry_events_old_revision_fk;
ALTER TABLE preference_registry_events ADD CONSTRAINT preference_registry_events_old_revision_fk
  FOREIGN KEY(preference_id,old_revision_id) REFERENCES preference_registry_revisions(preference_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE preference_registry_events DROP CONSTRAINT preference_registry_events_new_revision_fk;
ALTER TABLE preference_registry_events ADD CONSTRAINT preference_registry_events_new_revision_fk
  FOREIGN KEY(preference_id,new_revision_id) REFERENCES preference_registry_revisions(preference_id,id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION opengeni_private.guard_skill_history_parent_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'preference registry history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION opengeni_private.guard_skill_history_parent_delete() FROM PUBLIC;
DROP TRIGGER preference_registry_revisions_immutable ON preference_registry_revisions;
CREATE TRIGGER preference_registry_revisions_immutable BEFORE UPDATE OR DELETE ON preference_registry_revisions
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_skill_history_parent_delete();
DROP TRIGGER preference_registry_events_immutable ON preference_registry_events;
CREATE TRIGGER preference_registry_events_immutable BEFORE UPDATE OR DELETE ON preference_registry_events
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_skill_history_parent_delete();
DROP TRIGGER skill_write_receipts_immutable ON skill_write_receipts;
CREATE TRIGGER skill_write_receipts_immutable BEFORE UPDATE OR DELETE ON skill_write_receipts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_skill_history_parent_delete();

ALTER TABLE skill_source_bindings DROP CONSTRAINT skill_source_bindings_workspace_id_fkey;
ALTER TABLE skill_source_bindings ADD CONSTRAINT skill_source_bindings_workspace_id_fkey
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE skill_source_bindings DROP CONSTRAINT skill_source_bindings_plugin_id_fkey;
ALTER TABLE skill_source_bindings ADD CONSTRAINT skill_source_bindings_plugin_id_fkey
  FOREIGN KEY(plugin_id) REFERENCES capability_plugins(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE skill_source_bindings DROP CONSTRAINT skill_source_bindings_skill_facet_id_fkey;
ALTER TABLE skill_source_bindings ADD CONSTRAINT skill_source_bindings_skill_facet_id_fkey
  FOREIGN KEY(skill_facet_id) REFERENCES capability_skill_facets(facet_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE skill_source_bindings DROP CONSTRAINT skill_source_bindings_account_id_preference_id_fkey;
ALTER TABLE skill_source_bindings ADD CONSTRAINT skill_source_bindings_account_id_preference_id_fkey
  FOREIGN KEY(account_id,preference_id) REFERENCES preference_registry_preferences(account_id,id) ON DELETE CASCADE;
ALTER TABLE skill_write_receipts DROP CONSTRAINT skill_write_receipts_workspace_id_fkey;
ALTER TABLE skill_write_receipts ADD CONSTRAINT skill_write_receipts_workspace_id_fkey
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE skill_write_receipts DROP CONSTRAINT skill_write_receipts_activation_event_id_fkey;
ALTER TABLE skill_write_receipts ADD CONSTRAINT skill_write_receipts_activation_event_id_fkey
  FOREIGN KEY(activation_event_id) REFERENCES preference_registry_events(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;