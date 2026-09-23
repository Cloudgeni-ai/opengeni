-- deployment-mode: maintenance
-- Destructive feature removal. Drain all API/control/turn workers before this
-- cutover and start only matching binaries. No Pack data is migrated forward.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) r WHERE jsonb_typeof(r) <> 'string' OR length(btrim(r #>> '{}')) NOT BETWEEN 1 AND 63)
  THEN RAISE EXCEPTION 'Pack removal requires explicit application database roles' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON a.usename=r.value
    WHERE a.datname=current_database() AND a.pid<>pg_backend_pid())
  THEN RAISE EXCEPTION 'Pack removal requires drained application sessions' USING ERRCODE='55000'; END IF;
END $drain$;

-- The migration owner is NOSUPERUSER/NOBYPASSRLS. Temporarily lift FORCE,
-- never policies, only while the drained owner performs this atomic cutover.
LOCK TABLE workspace_packs, pack_installations, pack_installation_components,
  capability_operations, capability_component_owners, capability_facet_installations,
  capability_plugin_installations, integration_facet_binding_owners, integration_facet_bindings,
  skill_source_bindings, preference_registry_preferences, preference_registry_revisions,
  preference_registry_events, automation_sources, automation_triggers, automation_runs,
  automation_trigger_revisions, automation_trigger_events, automation_run_event_links,
  automation_webhook_endpoints
  IN ACCESS EXCLUSIVE MODE;
ALTER TABLE workspace_packs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pack_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pack_installation_components NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_operations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_component_owners NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facet_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_plugin_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_facet_binding_owners NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_facet_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_source_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_run_event_links NO FORCE ROW LEVEL SECURITY;

-- Capture only installations whose last owner is the removed feature. Shared
-- direct, Plugin and migration ownership remains untouched.
CREATE TEMP TABLE removed_pack_facets ON COMMIT DROP AS
SELECT fi.* FROM capability_facet_installations fi
WHERE EXISTS (SELECT 1 FROM capability_component_owners o WHERE o.facet_installation_id=fi.id AND o.owner_kind='pack')
  AND NOT EXISTS (SELECT 1 FROM capability_component_owners o WHERE o.facet_installation_id=fi.id AND o.owner_kind<>'pack');
CREATE TEMP TABLE removed_pack_bindings ON COMMIT DROP AS
SELECT binding.id FROM integration_facet_bindings binding
WHERE EXISTS (SELECT 1 FROM integration_facet_binding_owners o WHERE o.binding_id=binding.id AND o.owner_kind='pack')
  AND NOT EXISTS (SELECT 1 FROM integration_facet_binding_owners o WHERE o.binding_id=binding.id AND o.owner_kind<>'pack');
CREATE TEMP TABLE removed_pack_sources ON COMMIT DROP AS
SELECT id FROM automation_sources
WHERE pack_installation_id IS NOT NULL AND adapter_id<>'source-control.pull-request.v1';
CREATE TEMP TABLE removed_pack_triggers ON COMMIT DROP AS
SELECT trigger.id FROM automation_triggers trigger JOIN automation_sources source ON source.id=trigger.source_id
WHERE source.adapter_id<>'source-control.pull-request.v1'
  AND (trigger.pack_installation_id IS NOT NULL OR source.id IN (SELECT id FROM removed_pack_sources));
CREATE TEMP TABLE removed_pack_events ON COMMIT DROP AS
SELECT event.id FROM automation_trigger_events event
WHERE event.source_id IN (SELECT id FROM removed_pack_sources)
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(event.matched_trigger_revisions) matched
    JOIN removed_pack_triggers removed ON removed.id::text=matched->>'triggerId');

DO $preflight$
BEGIN
  -- Historical rows can violate the former application-only source/trigger
  -- ownership invariant. Remove exclusively Pack events, but never erase an
  -- event that also records independent work. Refuse that ambiguous cutover.
  IF EXISTS (SELECT 1 FROM automation_trigger_events event
    WHERE event.id IN (SELECT id FROM removed_pack_events) AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(event.matched_trigger_revisions) matched
        WHERE NOT EXISTS (SELECT 1 FROM removed_pack_triggers removed WHERE removed.id::text=matched->>'triggerId'))
      OR EXISTS (SELECT 1 FROM automation_runs run WHERE run.event_id=event.id
        AND run.trigger_id NOT IN (SELECT id FROM removed_pack_triggers))
      OR EXISTS (SELECT 1 FROM automation_run_event_links link JOIN automation_runs run ON run.id=link.run_id
        WHERE link.event_id=event.id AND run.trigger_id NOT IN (SELECT id FROM removed_pack_triggers))))
  THEN RAISE EXCEPTION 'Resolve mixed Pack and independent automation events before removal' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM capability_operations
    WHERE status IN ('pending','running','outcome_unknown')
      AND (target_kind='pack' OR (target_kind='facet_binding' AND target_id IN (SELECT id::text FROM removed_pack_bindings))))
  THEN RAISE EXCEPTION 'Settle Pack-related capability operations before Pack removal' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM automation_runs
    WHERE (source_id IN (SELECT id FROM removed_pack_sources) OR trigger_id IN (SELECT id FROM removed_pack_triggers))
      AND status IN ('queued','dispatching'))
  THEN RAISE EXCEPTION 'Settle Pack automation runs before Pack removal' USING ERRCODE='55000'; END IF;
END $preflight$;

-- This is maintenance deactivation, not an invented human approval. Keep all
-- immutable Skill revisions/events and preserve customized/re-scoped heads.
DO $release_skills$
DECLARE head record; next_event integer;
BEGIN
  FOR head IN
    SELECT DISTINCT p.* FROM preference_registry_preferences p
    JOIN preference_registry_revisions r ON r.id=p.active_revision_id AND r.preference_id=p.id
    JOIN skill_source_bindings b ON b.preference_id=p.id AND b.account_id=p.account_id
    JOIN removed_pack_facets fi ON fi.facet_id=b.skill_facet_id AND fi.workspace_id=b.workspace_id AND fi.account_id=b.account_id
    WHERE p.status='active' AND r.provenance_source='portable_skill'
      AND p.scope='workspace' AND p.scope_workspace_id=b.workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM skill_source_bindings other
        JOIN capability_facet_installations installed ON installed.facet_id=other.skill_facet_id
          AND installed.account_id=other.account_id AND installed.workspace_id=other.workspace_id
        JOIN capability_component_owners owner ON owner.facet_installation_id=installed.id
        WHERE other.preference_id=p.id AND owner.owner_kind<>'pack'
      )
    ORDER BY p.id
  LOOP
    PERFORM set_config('opengeni.preference_lifecycle_head_id',head.id::text,true);
    PERFORM set_config('opengeni.preference_lifecycle_operation','deactivate',true);
    UPDATE preference_registry_preferences SET status='inactive',active_revision_id=NULL,
      active_revision=NULL,active_content_hash=NULL,activation_version=activation_version+1,updated_at=clock_timestamp()
      WHERE id=head.id;
    SELECT coalesce(max(version),0)+1 INTO next_event FROM preference_registry_events WHERE preference_id=head.id;
    INSERT INTO preference_registry_events(account_id,preference_id,type,version,old_revision_id,actor_subject_id,reason)
      VALUES(head.account_id,head.id,'deactivated',next_event,head.active_revision_id,
        'service:remove-packs:0482','Removed the last distribution owner during Pack removal');
  END LOOP;
END $release_skills$;

DELETE FROM integration_facet_binding_owners WHERE owner_kind='pack';
DELETE FROM capability_component_owners WHERE owner_kind='pack';
DELETE FROM integration_facet_bindings WHERE id IN (SELECT id FROM removed_pack_bindings);
DELETE FROM skill_source_bindings binding USING removed_pack_facets removed
WHERE binding.skill_facet_id=removed.facet_id AND binding.account_id=removed.account_id
  AND binding.workspace_id=removed.workspace_id
  AND NOT EXISTS (SELECT 1 FROM capability_facet_installations surviving
    WHERE surviving.facet_id=removed.facet_id AND surviving.account_id=removed.account_id
      AND surviving.workspace_id=removed.workspace_id AND surviving.id NOT IN (SELECT id FROM removed_pack_facets));
DELETE FROM capability_facet_installations WHERE id IN (SELECT id FROM removed_pack_facets);
DELETE FROM capability_plugin_installations installation
WHERE installation.id IN (SELECT plugin_installation_id FROM removed_pack_facets)
  AND NOT EXISTS (SELECT 1 FROM capability_facet_installations fi WHERE fi.plugin_installation_id=installation.id)
  AND NOT EXISTS (SELECT 1 FROM capability_component_owners owner WHERE owner.owner_kind='plugin' AND owner.owner_id=installation.id::text)
  AND NOT EXISTS (SELECT 1 FROM integration_facet_binding_owners owner WHERE owner.owner_kind='plugin' AND owner.owner_id=installation.id::text);

-- PR Review already uses the independent source/trigger/registration system.
-- Keep its IDs, credentials, revisions and history; remove only the obsolete
-- ownership columns. Other Pack automations are removed, not converted.
-- Remove completed Pack execution records in FK order. Sessions referenced by
-- those records are independent history and are never deleted here.
DELETE FROM automation_run_event_links WHERE run_id IN (
  SELECT id FROM automation_runs WHERE source_id IN (SELECT id FROM removed_pack_sources)
    OR trigger_id IN (SELECT id FROM removed_pack_triggers)
) OR event_id IN (SELECT id FROM removed_pack_events);
DELETE FROM automation_runs WHERE source_id IN (SELECT id FROM removed_pack_sources)
  OR trigger_id IN (SELECT id FROM removed_pack_triggers);
DELETE FROM automation_trigger_events WHERE id IN (SELECT id FROM removed_pack_events);
DELETE FROM automation_trigger_revisions WHERE trigger_id IN (SELECT id FROM removed_pack_triggers);
DELETE FROM automation_triggers WHERE id IN (SELECT id FROM removed_pack_triggers);
DELETE FROM automation_webhook_endpoints WHERE source_id IN (SELECT id FROM removed_pack_sources);
DELETE FROM automation_sources WHERE id IN (SELECT id FROM removed_pack_sources);
ALTER TABLE automation_sources DROP CONSTRAINT automation_sources_pack_installation_fk;
ALTER TABLE automation_sources DROP CONSTRAINT automation_sources_shape_chk;
ALTER TABLE automation_sources DROP COLUMN pack_installation_id, DROP COLUMN pack_connector_id;
ALTER TABLE automation_sources ADD CONSTRAINT automation_sources_shape_chk CHECK (
  status IN ('active','disabled') AND version>0 AND octet_length(name) BETWEEN 1 AND 512
  AND octet_length(adapter_id) BETWEEN 1 AND 128 AND octet_length(created_by_subject_id) BETWEEN 1 AND 4096
  AND jsonb_typeof(configuration)='object'
);
ALTER TABLE automation_triggers DROP CONSTRAINT automation_triggers_pack_installation_fk;
ALTER TABLE automation_triggers DROP CONSTRAINT automation_triggers_shape_chk;
ALTER TABLE automation_triggers DROP COLUMN pack_installation_id, DROP COLUMN pack_template_id;
ALTER TABLE automation_triggers ADD CONSTRAINT automation_triggers_shape_chk CHECK (
  status IN ('active','paused','disabled') AND current_revision>0
  AND octet_length(name) BETWEEN 1 AND 512 AND octet_length(created_by_subject_id) BETWEEN 1 AND 4096
);

DELETE FROM capability_operations WHERE target_kind='pack';
ALTER TABLE capability_component_owners DROP CONSTRAINT capability_component_owners_kind_chk;
ALTER TABLE capability_component_owners ADD CONSTRAINT capability_component_owners_kind_chk CHECK (owner_kind IN ('direct','plugin','migration'));
ALTER TABLE integration_facet_binding_owners DROP CONSTRAINT integration_facet_binding_owners_kind_chk;
ALTER TABLE integration_facet_binding_owners ADD CONSTRAINT integration_facet_binding_owners_kind_chk CHECK (owner_kind IN ('direct','plugin','migration'));
ALTER TABLE capability_operations DROP CONSTRAINT capability_operations_target_chk;
ALTER TABLE capability_operations ADD CONSTRAINT capability_operations_target_chk CHECK (
  target_kind IN ('plugin','integration','skill','facet_binding') AND length(target_id) BETWEEN 1 AND 512
);

-- Function definitions below retain Plugin finalization and tenant validation.
-- They are replaced before dropping tables so no active SQL body retains Pack
-- lookups. DROP without CASCADE refuses unaccounted dependencies.
CREATE OR REPLACE FUNCTION capability_v2_validate_component_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "capability_facet_installations" i
    WHERE i."id" = NEW."facet_installation_id"
      AND i."account_id" = NEW."account_id"
      AND i."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'component owner does not match its facet installation tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."owner_kind" = 'plugin' THEN
    IF NEW."owner_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'plugin component owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    ELSIF NOT EXISTS (
        SELECT 1 FROM "capability_plugin_installations" p
        WHERE p."id" = NEW."owner_id"::uuid
          AND p."account_id" = NEW."account_id"
          AND p."workspace_id" = NEW."workspace_id"
      ) THEN
      RAISE EXCEPTION 'plugin component owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION capability_v2_validate_facet_binding_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM integration_facet_bindings binding
    WHERE binding.id = NEW.binding_id
      AND binding.account_id = NEW.account_id
      AND binding.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Facet binding owner does not match its binding tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.owner_kind = 'plugin' THEN
    IF NEW.owner_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Plugin Facet binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    ELSIF NOT EXISTS (
      SELECT 1 FROM capability_plugin_installations plugin
      WHERE plugin.id = NEW.owner_id::uuid
        AND plugin.account_id = NEW.account_id
        AND plugin.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Plugin Facet binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION skill_source_has_effective_owner(p_account_id uuid,p_workspace_id uuid,p_facet_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path FROM CURRENT AS $$
  SELECT EXISTS (
    SELECT 1 FROM capability_facet_installations fi
    JOIN capability_plugin_installations child ON child.id=fi.plugin_installation_id
    JOIN capability_component_owners owner ON owner.facet_installation_id=fi.id
      AND owner.account_id=fi.account_id AND owner.workspace_id=fi.workspace_id
    WHERE fi.account_id=p_account_id AND fi.workspace_id=p_workspace_id AND fi.facet_id=p_facet_id
      AND fi.status='active' AND child.status='active'
      AND (owner.owner_kind IN ('direct','migration')
        OR (owner.owner_kind='plugin' AND EXISTS(SELECT 1 FROM capability_plugin_installations parent
          WHERE parent.id::text=owner.owner_id AND parent.account_id=p_account_id AND parent.workspace_id=p_workspace_id AND parent.status='active')))
  )
$$;

CREATE OR REPLACE FUNCTION skill_publish_finalized_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  publication_owner_kind text := 'plugin';
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
    SELECT plugin_key INTO parent_target FROM capability_plugins WHERE id=NEW.plugin_id;
    IF publication_operation IS NULL OR NOT EXISTS(SELECT 1 FROM capability_operations operation
      WHERE operation.id=publication_operation AND operation.account_id=NEW.account_id AND operation.workspace_id=NEW.workspace_id
        AND operation.target_kind=publication_owner_kind AND operation.target_id=parent_target AND operation.status='running') THEN
      RAISE EXCEPTION 'Skill publication requires a claimed parent finalization' USING ERRCODE='42501';
    END IF;
    SELECT * INTO head FROM preference_registry_preferences WHERE id=(pending.receipt->>'skillId')::uuid AND account_id=NEW.account_id FOR UPDATE;
    SELECT * INTO revision FROM preference_registry_revisions WHERE id=(pending.receipt->>'revisionId')::uuid AND account_id=NEW.account_id;
    disposition := 'preserved'; event_id := NULL; current_mode := 'automatic';
    IF pending.actor->>'kind' <> 'human' THEN
      -- Deferred publication uses its original accepted policy. Historical
      -- receipts receive no new automatic authority during migration.
      current_mode:=coalesce(pending.receipt#>>'{learningPolicy,effective,skills}','review_first');
      IF current_mode='review_first' THEN current_mode:='suggest'; END IF;
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

-- CREATE OR REPLACE resets function-local settings. Preserve the original
-- fixed namespace: planning nested source-owner checks must not inherit the
-- runtime caller's search path or lose the lifecycle guard's resolution.
DO $function_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION skill_source_has_effective_owner(uuid,uuid,uuid) SET search_path = %I, pg_catalog, pg_temp', current_schema());
  EXECUTE format('ALTER FUNCTION skill_publish_finalized_owner() SET search_path = %I, pg_catalog, pg_temp', current_schema());
END $function_paths$;

-- Do not plan the restricted source-owner query for a new, inactive head.
-- A non-bypass migration owner exposes this distinction during runtime INSERT:
-- PostgreSQL may initialize an AND subplan even when active_revision_id is NULL.
-- Active revisions still pass the same source and files-bearing guards.
CREATE OR REPLACE FUNCTION skill_guard_legacy_activation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.active_revision_id IS NOT NULL THEN
    IF (TG_OP='INSERT' OR NEW.active_revision_id IS DISTINCT FROM OLD.active_revision_id)
      AND EXISTS(SELECT 1 FROM preference_registry_revisions target JOIN skill_source_bindings binding
        ON binding.preference_id=target.preference_id AND binding.account_id=target.account_id
        WHERE target.id=NEW.active_revision_id AND target.provenance_source='portable_skill'
          AND NOT skill_source_has_effective_owner(binding.account_id,binding.workspace_id,target.provenance_source_id::uuid)) THEN
      RAISE EXCEPTION 'Skill activation requires a finalized source owner' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM preference_registry_revisions target
      WHERE target.account_id=NEW.account_id AND target.preference_id=NEW.id
        AND target.id=NEW.active_revision_id AND target.skill_files IS NULL) THEN
      RAISE EXCEPTION 'Skill folder activation requires a files-bearing revision; use unified restore' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

SET CONSTRAINTS ALL IMMEDIATE;
DROP TABLE pack_installation_components;
DROP TABLE pack_installations;
DROP TABLE workspace_packs;
DROP FUNCTION pack_v2_validate_installation();
DROP FUNCTION pack_v2_validate_component();

ALTER TABLE capability_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_component_owners FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_facet_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE capability_plugin_installations FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_facet_binding_owners FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_facet_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE skill_source_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE preference_registry_events FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_run_event_links FORCE ROW LEVEL SECURITY;
