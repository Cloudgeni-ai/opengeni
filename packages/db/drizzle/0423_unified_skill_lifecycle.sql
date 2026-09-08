-- deployment-mode: maintenance
-- Stop old runtimes: installed Skill reads now resolve the registry head.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) r WHERE jsonb_typeof(r) <> 'string' OR length(btrim(r #>> '{}')) NOT BETWEEN 1 AND 63)
  THEN RAISE EXCEPTION '0423 requires explicit application database roles' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON a.usename = r.value
    WHERE a.datname = current_database() AND a.pid <> pg_backend_pid())
  THEN RAISE EXCEPTION '0423 requires drained application sessions' USING ERRCODE = '55000'; END IF;
END $drain$;

-- NULL means the historical single content file. Never rewrite old hashes or snapshots.
ALTER TABLE preference_registry_revisions ADD COLUMN skill_files jsonb;
ALTER TABLE preference_registry_revisions ADD COLUMN skill_activation_mode text
  CHECK (skill_activation_mode IN ('workspace_managed','session_selected'));
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

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['skill_source_bindings','skill_write_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY skill_workspace_scope ON %I USING (account_id = nullif(current_setting(''opengeni.account_id'', true), '''')::uuid AND workspace_id = nullif(current_setting(''opengeni.workspace_id'', true), '''')::uuid)', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $rls$;

-- This is a separate truthful agent lifecycle, not a human-session impersonation.
-- The caller supplies trusted HTTP human identity or host-bound exact attempt claims.
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
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id',true),'')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id',true),'')::uuid
    OR p_account_id IS NULL OR p_workspace_id IS NULL OR operation_id IS NULL
    OR operation NOT IN ('save','install','approve','restore') OR operation IS NULL
  THEN RAISE EXCEPTION 'Skill lifecycle requires exact tenant context' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM workspaces WHERE id=p_workspace_id AND account_id=p_account_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Skill workspace unavailable' USING ERRCODE='42501'; END IF;
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
  ELSE RAISE EXCEPTION 'Skill lifecycle actor is not authorized' USING ERRCODE='42501'; END IF;

  fingerprint := encode(sha256(convert_to(jsonb_build_array(p_actor,p_request)::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('skill-operation:'||p_workspace_id||':'||operation_id,0));
  SELECT * INTO prior FROM skill_write_receipts r WHERE r.workspace_id=p_workspace_id AND r.operation_id=lifecycle.operation_id;
  IF FOUND THEN
    IF prior.fingerprint <> fingerprint OR prior.account_id <> p_account_id THEN
      RAISE EXCEPTION 'Skill operation key reused with different input' USING ERRCODE='23505'; END IF;
    RETURN (prior.receipt - 'portableInstall') || jsonb_build_object('replayed',true);
  END IF;
  IF p_actor->>'kind' = 'agent' THEN
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
    PERFORM pg_advisory_xact_lock(hashtextextended('skill-source:'||p_workspace_id||':'||source.plugin_id||':'||source.facet_key,0));
    SELECT * INTO binding FROM skill_source_bindings b WHERE b.workspace_id=p_workspace_id
      AND b.plugin_id=source.plugin_id AND b.facet_key=source.facet_key;
    skill_id := coalesce(binding.preference_id,gen_random_uuid());
    files := source.files; title := left(source.name,120); description := left(source.description,240);
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
    IF (p_actor->>'kind' = 'agent' AND (head.scope <> 'workspace' OR head.scope_workspace_id <> p_workspace_id))
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
      title := rev.title; description := rev.description;
      activation_mode := coalesce(rev.skill_activation_mode,'workspace_managed');
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
        CASE WHEN p_actor->>'kind'='agent' THEN 'untrusted_proposal' WHEN scope='user' THEN 'personal'
          WHEN scope='organization' THEN 'organization_managed' ELSE 'workspace_managed' END,
        actor_subject,head.active_revision_id,files,activation_mode) RETURNING id INTO revision_id;
    END IF;
    SELECT coalesce(max(e.version),0)+1 INTO next_event FROM preference_registry_events e WHERE e.preference_id=skill_id;
    IF next_event=1 THEN
      INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,new_subject_id,actor_subject_id,reason)
      VALUES(p_account_id,skill_id,'proposal_created',next_event,revision_id,head.scope,head.scope_workspace_id,head.scope_subject_id,actor_subject,p_request->>'reason');
      next_event := next_event+1;
    END IF;
    IF mode='automatic' THEN
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
  INSERT INTO skill_write_receipts(account_id,workspace_id,operation_id,fingerprint,actor,receipt,activation_event_id)
    VALUES(p_account_id,p_workspace_id,operation_id,fingerprint,p_actor,
      CASE WHEN operation='install' AND p_request ? 'portableInstall'
        THEN result || jsonb_build_object('portableInstall',p_request->'portableInstall') ELSE result END,
      activation_event_id);
  RETURN result;
END $body$;

DO $secure$
BEGIN
  EXECUTE format('ALTER FUNCTION skill_apply_lifecycle(uuid,uuid,jsonb,jsonb) SET search_path = %I, pg_catalog, pg_temp',current_schema());
  REVOKE ALL ON FUNCTION skill_apply_lifecycle(uuid,uuid,jsonb,jsonb) FROM PUBLIC;
END $secure$;

-- Backfill by immutable portable identity, never by matching names or bytes.
-- Distribution owners/manifests/files remain untouched and keep their upstream history.
DO $backfill$
DECLARE source record; skill_id uuid; revision_id uuid; main_content text;
BEGIN
  FOR source IN
    SELECT i.account_id,i.workspace_id,i.plugin_id,f.facet_key,f.activation_mode,sf.*,
      jsonb_agg(jsonb_build_object('path',ff.path,'content',ff.content) ORDER BY ff.path) AS files
    FROM capability_plugin_installations i JOIN capability_facets f ON f.plugin_version_id=i.plugin_version_id
    JOIN capability_skill_facets sf ON sf.facet_id=f.id JOIN capability_skill_files ff ON ff.skill_facet_id=sf.facet_id
    WHERE i.status='active'
    GROUP BY i.account_id,i.workspace_id,i.plugin_id,f.facet_key,f.activation_mode,sf.facet_id
  LOOP
    IF NOT skill_files_valid(source.files) THEN RAISE EXCEPTION 'Installed Skill % has invalid text folder; repair before cutover',source.facet_id USING ERRCODE='22023'; END IF;
    skill_id := gen_random_uuid(); revision_id := gen_random_uuid();
    SELECT f->>'content' INTO main_content FROM jsonb_array_elements(source.files) f WHERE f->>'path'='SKILL.md';
    INSERT INTO preference_registry_preferences(id,account_id,stable_key,scope,scope_workspace_id,created_by_subject_id)
      VALUES(skill_id,source.account_id,'installed-'||replace(skill_id::text,'-',''),'workspace',source.workspace_id,'service:skill-migration:0423');
    INSERT INTO preference_registry_revisions(id,account_id,preference_id,title,description,content,content_hash,
      conflict_strategy,provenance_source,provenance_source_id,trust,created_by_subject_id,skill_files,skill_activation_mode)
      VALUES(revision_id,source.account_id,skill_id,left(source.name,120),left(source.description,240),main_content,
        encode(sha256(convert_to(main_content,'UTF8')),'hex'),'override','portable_skill',source.facet_id::text,
        'workspace_managed','service:skill-migration:0423',source.files,source.activation_mode);
    INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,new_scope,new_workspace_id,actor_subject_id,reason)
      VALUES(source.account_id,skill_id,'proposal_created',1,revision_id,'workspace',source.workspace_id,
        'service:skill-migration:0423','Preserve installed portable Skill at unified lifecycle cutover');
    PERFORM set_config('opengeni.preference_lifecycle_head_id',skill_id::text,true);
    PERFORM set_config('opengeni.preference_lifecycle_operation','activate',true);
    UPDATE preference_registry_preferences h SET status='active',active_revision_id=revision_id,
      active_revision=r.revision,active_content_hash=r.content_hash,activation_version=1
      FROM preference_registry_revisions r WHERE h.id=skill_id AND r.id=revision_id;
    INSERT INTO preference_registry_events(account_id,preference_id,type,version,new_revision_id,actor_subject_id,reason)
      VALUES(source.account_id,skill_id,'activated',2,revision_id,'service:skill-migration:0423','Preserve existing installation activation');
    INSERT INTO skill_source_bindings VALUES(source.account_id,source.workspace_id,source.plugin_id,source.facet_key,skill_id,source.facet_id);
  END LOOP;
END $backfill$;

-- An old single-text editor cannot silently drop a bound Skill's supporting files.
CREATE FUNCTION skill_guard_legacy_revision() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.skill_files IS NULL AND EXISTS(SELECT 1 FROM skill_source_bindings b WHERE b.preference_id=NEW.preference_id) THEN
    RAISE EXCEPTION 'Installed Skill saves require the unified file lifecycle' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_guard_legacy_revision BEFORE INSERT ON preference_registry_revisions
FOR EACH ROW EXECUTE FUNCTION skill_guard_legacy_revision();

-- Activation metadata is bound to the exact event, so a later legacy human
-- activation cannot inherit an earlier Automatic receipt for the same revision.
CREATE FUNCTION skill_revision_activation_authority(p_revision_id uuid, p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT CASE r.actor->>'kind' WHEN 'agent' THEN 'automatic' ELSE 'human_confirmed' END
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
    RAISE EXCEPTION '0423 snapshot activation projection has drifted' USING ERRCODE='55000';
  END IF;
  definition := replace(replace(definition,old_expression,new_expression),old_end,new_end);
  EXECUTE replace(definition,state_filter,state_filter || $new$ AND coalesce(revision.skill_activation_mode,'workspace_managed')='workspace_managed'$new$);
  EXECUTE format('ALTER FUNCTION preference_registry_activation_authority(uuid,uuid[]) SET search_path = pg_catalog, %I, pg_temp',current_schema());
  EXECUTE format('ALTER FUNCTION skill_revision_activation_authority(uuid,timestamptz) SET search_path = pg_catalog, %I, pg_temp',current_schema());
  REVOKE ALL ON FUNCTION preference_registry_activation_authority(uuid,uuid[]) FROM PUBLIC;
END $snapshot_authority$;