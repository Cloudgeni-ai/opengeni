-- deployment-mode: rolling
-- Deleting a workspace must remove everything it owns. The scoped-knowledge
-- tables from 0154 and the Memory lifecycle event and relationship tables from
-- 0152 reference their workspace ON DELETE RESTRICT, so a workspace that ever
-- held one of their rows could never be deleted. No application code reads or
-- writes these tables any more, and a row scoped to a workspace belongs to that
-- workspace alone, so the workspace foreign keys now cascade.
--
-- Their immutability guards still reject every direct UPDATE and DELETE. They
-- admit only the nested DELETE a cascade issues once the owning workspace row
-- is gone, the same rule historical Memory already uses (0461).
--
-- Rolling: only delete actions and guard functions change. No release reads or
-- writes these rows, and every other mutation is still rejected. The foreign
-- keys are re-added NOT VALID and validated by 0928.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE knowledge_change_proposals
  DROP CONSTRAINT knowledge_change_proposals_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_change_proposals_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_change_proposals_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_change_proposals_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_claim_evidence
  DROP CONSTRAINT knowledge_claim_evidence_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_claim_evidence_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_claim_evidence_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_claim_evidence_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_claim_relations
  DROP CONSTRAINT knowledge_claim_relations_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_claim_relations_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_claim_relations_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_claim_relations_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_claim_reviews
  DROP CONSTRAINT knowledge_claim_reviews_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_claim_reviews_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_claim_reviews_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_claim_reviews_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_claims
  DROP CONSTRAINT knowledge_claims_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_claims_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_claims_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_claims_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_document_versions
  DROP CONSTRAINT knowledge_document_versions_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_document_versions_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_document_versions_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_document_versions_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_entities
  DROP CONSTRAINT knowledge_entities_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_entities_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_entities_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_entities_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_entity_aliases
  DROP CONSTRAINT knowledge_entity_aliases_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_entity_aliases_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_entity_aliases_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_entity_aliases_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_facts
  DROP CONSTRAINT knowledge_facts_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_facts_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_facts_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_facts_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_lifecycle_events
  DROP CONSTRAINT knowledge_lifecycle_events_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_lifecycle_events_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_lifecycle_events_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_lifecycle_events_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_memory_lifecycle_events
  DROP CONSTRAINT knowledge_memory_lifecycle_events_workspace_account_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_memory_relationships
  DROP CONSTRAINT knowledge_memory_relationships_workspace_account_fk,
  ADD CONSTRAINT knowledge_memory_relationships_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_operation_receipts
  DROP CONSTRAINT knowledge_operation_receipts_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_operation_receipts_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_operation_receipts_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_operation_receipts_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_providers
  DROP CONSTRAINT knowledge_providers_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_providers_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_providers_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_providers_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_source_acl_versions
  DROP CONSTRAINT knowledge_source_acl_versions_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_source_acl_versions_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_source_acl_versions_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_source_acl_versions_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_source_objects
  DROP CONSTRAINT knowledge_source_objects_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_source_objects_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_source_objects_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_source_objects_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_sources
  DROP CONSTRAINT knowledge_sources_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_sources_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_sources_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_sources_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE knowledge_sync_runs
  DROP CONSTRAINT knowledge_sync_runs_scope_workspace_account_fk,
  ADD CONSTRAINT knowledge_sync_runs_scope_workspace_account_fk FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT knowledge_sync_runs_scope_workspace_id_fkey,
  ADD CONSTRAINT knowledge_sync_runs_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;

DO $workspace_cascade_guards$
DECLARE
  data_schema text := pg_catalog.current_schema();
  target record;
  definition text;
  anchor text := E'\nBEGIN\n';
  guard text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      (pg_catalog.format('%I.scoped_knowledge_reject_immutable_mutation()', data_schema), 'scope_workspace_id'),
      (pg_catalog.format('%I.scoped_knowledge_guard_provider_mutation()', data_schema), 'scope_workspace_id'),
      (pg_catalog.format('%I.scoped_knowledge_guard_source_mutation()', data_schema), 'scope_workspace_id'),
      (pg_catalog.format('%I.scoped_knowledge_guard_object_mutation()', data_schema), 'scope_workspace_id'),
      (pg_catalog.format('%I.scoped_knowledge_guard_sync_mutation()', data_schema), 'scope_workspace_id'),
      ('opengeni_private.immutable_memory_lifecycle_event()', 'workspace_id'),
      ('opengeni_private.knowledge_memory_relationship_guard()', 'workspace_id')
    ) AS guarded(function_signature, workspace_column)
  LOOP
    definition := pg_catalog.pg_get_functiondef(target.function_signature::regprocedure);
    IF pg_catalog.regexp_count(definition, anchor) <> 1 THEN
      RAISE EXCEPTION 'workspace cascade guard anchor mismatch in %', target.function_signature;
    END IF;
    guard := pg_catalog.format(
      E'\nBEGIN\n'
      || E'  -- The owning workspace is being deleted: admit only its cascade.\n'
      || E'  IF TG_OP = ''DELETE'' AND pg_catalog.pg_trigger_depth() > 1\n'
      || E'    AND OLD.%1$I IS NOT NULL\n'
      || E'    AND NOT EXISTS (SELECT 1 FROM %2$I.workspaces w WHERE w.id = OLD.%1$I)\n'
      || E'  THEN\n'
      || E'    RETURN OLD;\n'
      || E'  END IF;\n',
      target.workspace_column, data_schema);
    EXECUTE pg_catalog.replace(definition, anchor, guard);
  END LOOP;
END
$workspace_cascade_guards$;
