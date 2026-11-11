-- deployment-mode: rolling
-- Opengeni baseline part 18 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE document_default_collection_backfill_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_migration_audit_read ON document_authority_reclassifications FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND document_migration_audit_capability_active('reclassification_audit'::text)));

CREATE POLICY document_migration_audit_read ON document_default_collection_backfill_operations FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND document_migration_audit_capability_active('default_backfill_audit'::text)));

CREATE POLICY document_migration_audit_read ON document_default_collection_backfill_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND document_migration_audit_capability_active('default_backfill_audit'::text)));

CREATE POLICY document_migration_audit_read ON document_default_collection_backfill_runs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND document_migration_audit_capability_active('default_backfill_audit'::text)));

CREATE POLICY document_migration_lifecycle ON document_authority_reclassifications USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_authority_reclassifications'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_authority_reclassifications'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END)));

CREATE POLICY document_migration_lifecycle ON document_default_collection_backfill_operations USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_default_collection_backfill_operations'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_default_collection_backfill_operations'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END)));

CREATE POLICY document_migration_lifecycle ON document_default_collection_backfill_receipts USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_default_collection_backfill_receipts'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_default_collection_backfill_receipts'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END)));

CREATE POLICY document_migration_lifecycle ON document_default_collection_backfill_runs USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_default_collection_backfill_runs'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active(
CASE
    WHEN ('document_default_collection_backfill_runs'::text = 'document_authority_reclassifications'::text) THEN 'reclassify'::text
    ELSE 'default_backfill'::text
END)));

CREATE POLICY document_reclassification_actor_read ON document_authority_reclassifications FOR SELECT USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (request_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (actor_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

CREATE POLICY document_reclassification_lifecycle ON document_chunks USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text)));

CREATE POLICY document_reclassification_lifecycle ON documents USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text)));

CREATE POLICY document_reclassification_lifecycle ON organization_user_resource_authorities USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text)));

CREATE POLICY document_reclassification_lifecycle ON organization_user_resource_grants USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('reclassify'::text)));

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_blob_refs ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_idempotency_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_live_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY editable_artifact_live_ticket_owner ON editable_artifact_live_tickets USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE editable_artifact_live_tickets ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_materialization_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_materialization_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY editable_artifact_materializer_owner ON editable_artifact_blob_refs USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY editable_artifact_materializer_owner ON editable_artifact_idempotency_receipts FOR SELECT USING ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY editable_artifact_materializer_owner ON editable_artifact_materialization_jobs USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY editable_artifact_materializer_owner ON editable_artifact_materialization_results USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY editable_artifact_materializer_owner ON editable_artifact_sequence_checkpoints FOR SELECT USING ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY editable_artifact_materializer_owner ON editable_artifact_versions FOR SELECT USING ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE editable_artifact_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY editable_artifact_outbox_dispatcher ON editable_artifact_live_outbox USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE editable_artifact_replica_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY editable_artifact_scope_authority_owner ON editable_artifact_scope_authorization_heads USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE editable_artifact_scope_authorization_heads ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_sequence_checkpoints ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_session_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_transactions ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_undo_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifact_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE editable_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE enrollment_token_redemptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;

ALTER TABLE event_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_source_feed_maintenance_owner ON event_source_feeds USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('event_source_feeds'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('event_source_feeds'::regclass)::oid))));

ALTER TABLE event_source_feeds ENABLE ROW LEVEL SECURITY;

ALTER TABLE event_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY event_trigger_maintenance_owner ON event_deliveries USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('event_deliveries'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('event_deliveries'::regclass)::oid))));

CREATE POLICY event_trigger_maintenance_owner ON inbound_events USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('inbound_events'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('inbound_events'::regclass)::oid))));

CREATE POLICY event_trigger_maintenance_owner ON scheduled_task_event_settings USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('scheduled_task_event_settings'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('scheduled_task_event_settings'::regclass)::oid))));

ALTER TABLE event_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY exhausted_schedule_inventory_read ON scheduled_task_event_occurrences FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY exhausted_schedule_inventory_read ON scheduled_task_event_settings FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY exhausted_schedule_inventory_read ON scheduled_task_runs FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY exhausted_schedule_inventory_read ON scheduled_task_schedule_outbox FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY exhausted_schedule_inventory_read ON scheduled_tasks FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

ALTER TABLE external_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY external_identity_lifecycle ON external_identities USING (((account_id = opengeni_private.current_account_id()) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'external_identity_provisioning'::text))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'external_identity_provisioning'::text)));

ALTER TABLE external_identity_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY external_identity_links_account_scope ON external_identity_links USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

CREATE POLICY external_identity_provisioning ON organization_memberships USING (((account_id = opengeni_private.current_account_id()) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'external_identity_provisioning'::text))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'external_identity_provisioning'::text)));

ALTER TABLE external_link_task_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY external_link_task_authorities_scope ON external_link_task_authorities USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE external_link_turn_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY external_link_turn_authorities_scope ON external_link_turn_authorities USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

CREATE POLICY feedback_author ON feedback_submissions USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()) AND ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions s
  WHERE ((s.workspace_id = feedback_submissions.workspace_id) AND (s.id = feedback_submissions.session_id))))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()) AND ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions s
  WHERE ((s.workspace_id = feedback_submissions.workspace_id) AND (s.id = feedback_submissions.session_id))))) AND ((turn_id IS NULL) OR (EXISTS ( SELECT 1
   FROM session_turns t
  WHERE ((t.workspace_id = feedback_submissions.workspace_id) AND (t.session_id = feedback_submissions.session_id) AND (t.id = feedback_submissions.turn_id)))))));

ALTER TABLE feedback_submissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE file_uploads ENABLE ROW LEVEL SECURITY;

ALTER TABLE files ENABLE ROW LEVEL SECURITY;

CREATE POLICY files_personal_owner ON files AS RESTRICTIVE FOR SELECT USING (((private_owner_subject_ids IS NULL) OR (NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text) = ANY (private_owner_subject_ids)) OR opengeni_private.session_file_read_allowed(account_id, workspace_id, id)));

CREATE POLICY files_personal_owner_delete ON files AS RESTRICTIVE FOR DELETE USING (((private_owner_subject_ids IS NULL) OR (NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text) = ANY (private_owner_subject_ids))));

CREATE POLICY files_personal_owner_insert ON files AS RESTRICTIVE FOR INSERT WITH CHECK (((private_owner_subject_ids IS NULL) OR (NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text) = ANY (private_owner_subject_ids))));

CREATE POLICY files_personal_owner_update ON files AS RESTRICTIVE FOR UPDATE USING (((private_owner_subject_ids IS NULL) OR (NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text) = ANY (private_owner_subject_ids)))) WITH CHECK (((private_owner_subject_ids IS NULL) OR (NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text) = ANY (private_owner_subject_ids))));

CREATE POLICY files_personal_read ON files FOR SELECT USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text) = ANY (private_owner_subject_ids))));

ALTER TABLE generated_image_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE generated_video_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE github_installation_repositories ENABLE ROW LEVEL SECURITY;

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;

CREATE POLICY global_catalog_import_batches ON import_batches USING (true) WITH CHECK (true);

CREATE POLICY google_drive_object_acl_capability_read ON connections FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('connections'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON files FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('files'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON google_drive_object_acl_evidence FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('google_drive_object_acl_evidence'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON google_drive_object_acl_principals FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('google_drive_object_acl_principals'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON knowledge_document_versions FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('knowledge_document_versions'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON knowledge_providers FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('knowledge_providers'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON knowledge_source_objects FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('knowledge_source_objects'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON knowledge_source_sync_index_obligations FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('knowledge_source_sync_index_obligations'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON knowledge_source_sync_states FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('knowledge_source_sync_states'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

CREATE POLICY google_drive_object_acl_capability_read ON knowledge_sources FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('knowledge_sources'::regclass)::oid)))) AND opengeni_private.google_drive_object_acl_capability_active()));

ALTER TABLE google_drive_object_acl_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY google_drive_object_acl_evidence_workspace_isolation ON google_drive_object_acl_evidence USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE google_drive_object_acl_principals ENABLE ROW LEVEL SECURITY;

CREATE POLICY google_drive_object_acl_principals_workspace_isolation ON google_drive_object_acl_principals USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE governed_learning_activation_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY governed_learning_activation_receipts_subject ON governed_learning_activation_receipts AS RESTRICTIVE USING ((initiating_human_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))) WITH CHECK ((initiating_human_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)));

CREATE POLICY governed_learning_activation_receipts_tenant ON governed_learning_activation_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE governed_learning_activation_undo_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY governed_learning_activation_undo_receipts_subject ON governed_learning_activation_undo_receipts AS RESTRICTIVE USING ((initiating_human_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))) WITH CHECK ((initiating_human_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)));

CREATE POLICY governed_learning_activation_undo_receipts_tenant ON governed_learning_activation_undo_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE governed_learning_decision_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY governed_learning_decision_receipts_tenant ON governed_learning_decision_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE host_export_config ENABLE ROW LEVEL SECURITY;

ALTER TABLE host_export_consumers ENABLE ROW LEVEL SECURITY;

ALTER TABLE host_export_cursor_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE host_export_dead_letters ENABLE ROW LEVEL SECURITY;

ALTER TABLE host_export_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_export_owner ON host_export_config USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY host_export_owner ON host_export_consumers USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY host_export_owner ON host_export_cursor_state USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY host_export_owner ON host_export_dead_letters USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY host_export_owner ON host_export_outbox USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY host_export_system_only ON host_export_config USING (false) WITH CHECK (false);

CREATE POLICY host_export_system_only ON host_export_consumers USING (false) WITH CHECK (false);

CREATE POLICY host_export_system_only ON host_export_cursor_state USING (false) WITH CHECK (false);

CREATE POLICY host_export_system_only ON host_export_dead_letters USING (false) WITH CHECK (false);

CREATE POLICY host_export_system_only ON host_export_outbox USING (false) WITH CHECK (false);

ALTER TABLE host_mcp_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_mcp_bindings_owner_scope ON host_mcp_bindings USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id())));

ALTER TABLE host_mcp_delegations ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_mcp_delegations_owner_scope ON host_mcp_delegations USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id())));

ALTER TABLE host_mcp_resolver_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_mcp_resolver_operations_account ON host_mcp_resolver_operations USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE host_mcp_resolvers ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_mcp_resolvers_account ON host_mcp_resolvers USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE host_mcp_task_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_mcp_task_authorities_owner_scope ON host_mcp_task_authorities USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id())));

ALTER TABLE host_mcp_turn_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY host_mcp_turn_authorities_owner_scope ON host_mcp_turn_authorities USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (owner_subject_id = opengeni_private.current_subject_id())));

ALTER TABLE image_generation_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE inbound_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE integration_facet_binding_owners ENABLE ROW LEVEL SECURITY;

ALTER TABLE integration_facet_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE integration_facet_definitions ENABLE ROW LEVEL SECURITY;

ALTER TABLE integration_oauth_pending_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY integration_oauth_pending_states_scope ON integration_oauth_pending_states USING ((((workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)) OR ((workspace_id IS NULL) AND (opengeni_private.current_workspace_id() IS NULL) AND opengeni_private.organization_model_provider_scope_visible(account_id)))) WITH CHECK ((((workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)) OR ((workspace_id IS NULL) AND (opengeni_private.current_workspace_id() IS NULL) AND opengeni_private.organization_model_provider_scope_visible(account_id))));

ALTER TABLE integration_oauth_state_nonces ENABLE ROW LEVEL SECURITY;

ALTER TABLE integration_spec_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE integration_tools ENABLE ROW LEVEL SECURITY;

ALTER TABLE interaction_interventions ENABLE ROW LEVEL SECURITY;

ALTER TABLE interaction_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE interaction_resource_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_change_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_claim_evidence ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_claim_relations ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_claim_reviews ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_document_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entities ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entity_aliases ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entry_decisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entry_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entry_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entry_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entry_search ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_entry_vectors ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_index_dispatcher ON knowledge_index_jobs USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('knowledge_index_jobs'::regclass)::oid)))) AND (current_setting('opengeni.knowledge_index_dispatcher'::text, true) = '1'::text)));

ALTER TABLE knowledge_index_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_legacy_confirmation_lock ON knowledge_change_proposals FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (scope_kind = 'workspace'::text) AND (account_id = (current_setting('opengeni.account_id'::text, true))::uuid) AND (scope_workspace_id = (current_setting('opengeni.workspace_id'::text, true))::uuid) AND ((claim_id)::text = current_setting('opengeni.knowledge_legacy_lock_claim'::text, true)))) WITH CHECK (false);

CREATE POLICY knowledge_legacy_confirmation_lock ON knowledge_claim_evidence FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (scope_kind = 'workspace'::text) AND (account_id = (current_setting('opengeni.account_id'::text, true))::uuid) AND (scope_workspace_id = (current_setting('opengeni.workspace_id'::text, true))::uuid) AND ((claim_id)::text = current_setting('opengeni.knowledge_legacy_lock_claim'::text, true)))) WITH CHECK (false);

CREATE POLICY knowledge_legacy_confirmation_lock ON knowledge_claim_reviews FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (scope_kind = 'workspace'::text) AND (account_id = (current_setting('opengeni.account_id'::text, true))::uuid) AND (scope_workspace_id = (current_setting('opengeni.workspace_id'::text, true))::uuid) AND ((claim_id)::text = current_setting('opengeni.knowledge_legacy_lock_claim'::text, true)))) WITH CHECK (false);

CREATE POLICY knowledge_legacy_confirmation_lock ON knowledge_claims FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (scope_kind = 'workspace'::text) AND (account_id = (current_setting('opengeni.account_id'::text, true))::uuid) AND (scope_workspace_id = (current_setting('opengeni.workspace_id'::text, true))::uuid) AND ((id)::text = current_setting('opengeni.knowledge_legacy_lock_claim'::text, true)))) WITH CHECK (false);

ALTER TABLE knowledge_lifecycle_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_memories ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_memory_lifecycle_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_memory_relationships ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_operation_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_providers ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_review_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_source_acl_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_source_objects ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_source_sync_index_obligations ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_source_sync_index_obligations_workspace_isolation ON knowledge_source_sync_index_obligations USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE knowledge_source_sync_item_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_source_sync_item_outcomes_workspace_isolation ON knowledge_source_sync_item_outcomes USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE knowledge_source_sync_object_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_source_sync_object_observations_workspace_isolation ON knowledge_source_sync_object_observations USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE knowledge_source_sync_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_source_sync_states_workspace_isolation ON knowledge_source_sync_states USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE knowledge_source_sync_wakes ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_source_sync_wakes_workspace_isolation ON knowledge_source_sync_wakes USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_tenant ON agent_instruction_operations USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON agent_learning_revisions USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON agent_learning_snapshots USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entries USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entry_decisions USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entry_links USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entry_operations USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entry_revisions USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entry_search USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_entry_vectors USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_index_jobs USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY knowledge_tenant ON knowledge_review_batches USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY lifecycle_backfill_read ON additional_organization_creation_receipts FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON claude_subscription_credentials FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON codex_subscription_credentials FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON connections FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON credit_ledger_entries FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON enrollments FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON organization_memberships FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON organization_model_provider_connection_operations FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON organization_model_provider_connections FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON preference_registry_preferences FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON scheduled_tasks FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON self_service_organization_setup_receipts FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON skill_source_bindings FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON slack_bot_user_links FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

CREATE POLICY lifecycle_backfill_read ON xai_subscription_credentials FOR SELECT USING (( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active));

ALTER TABLE machine_metrics_latest ENABLE ROW LEVEL SECURITY;

ALTER TABLE machine_metrics_series ENABLE ROW LEVEL SECURITY;

ALTER TABLE machine_removal_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY maintenance_checkpoint_gc_delete ON sandbox_checkpoint_artifacts FOR DELETE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_gc'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_gc_select ON rig_changes FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_gc'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_gc_select ON rig_versions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_gc'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_gc_select ON sandbox_checkpoint_artifacts FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_gc'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_gc_select ON sandbox_leases FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_gc'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_gc_update ON sandbox_checkpoint_artifacts FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_gc'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_validate_select ON sandbox_checkpoint_artifacts FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_validate'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_checkpoint_validate_select ON sandbox_leases FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'checkpoint_validate'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_ended_epoch_select ON sandbox_leases FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_ended_epoch_select ON sandbox_retained_processes FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_ended_epoch_select ON sandbox_workspace_mutation_admissions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_ended_epoch_select ON session_turn_attempts FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_ended_epoch_select ON session_turns FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_ended_epoch_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON sandbox_lease_holders FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON sandbox_leases FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON sandbox_retained_processes FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON sandbox_workspace_mutation_admissions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON session_background_commands FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON session_turn_attempts FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON session_turns FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_inventory_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_output_release_select ON enrollments FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'output_release'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_schedule_cleanup_delete ON temporal_schedule_cleanup_outbox FOR DELETE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'schedule_cleanup'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_schedule_cleanup_select ON temporal_schedule_cleanup_outbox FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'schedule_cleanup'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_schedule_cleanup_update ON temporal_schedule_cleanup_outbox FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'schedule_cleanup'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_insert ON workspace_interaction_revisions FOR INSERT WITH CHECK (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_select ON auth_runs FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_select ON site_auth_connections FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_select ON workspace_interaction_revisions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_update ON site_auth_connections FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_site_auth_update ON workspace_interaction_revisions FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_snapshots_delete ON session_list_snapshots FOR DELETE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'snapshots'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_snapshots_select ON session_list_snapshots FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'snapshots'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_snapshots_update ON session_list_snapshots FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'snapshots'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_titles_select ON session_events FOR SELECT USING (
CASE
    WHEN ( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'titles'::text) AS maintenance_claim_active) THEN opengeni_private.maintenance_title_event_visible((CURRENT_USER)::text, id)
    ELSE false
END);

CREATE POLICY maintenance_titles_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'titles'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_updates_select ON session_system_update_outbox FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_updates_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_updates_update ON session_system_update_outbox FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_select ON session_attempt_interruptions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_select ON session_turn_attempts FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_select ON session_workflow_wake_outbox FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_select ON workspace_inference_controls FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_update ON session_workflow_wake_outbox FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_update ON sessions FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_wakes_update ON workspace_inference_controls FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_workspace_commands_delete ON session_background_commands FOR DELETE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_workspace_commands_select ON session_background_commands FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_workspace_commands_select ON sessions FOR SELECT USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text) AS maintenance_claim_active));

CREATE POLICY maintenance_workspace_commands_update ON session_background_commands FOR UPDATE USING (( SELECT opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text) AS maintenance_claim_active));

ALTER TABLE managed_auth_actor_mutation_leases ENABLE ROW LEVEL SECURITY;

ALTER TABLE managed_auth_browser_installations ENABLE ROW LEVEL SECURITY;

ALTER TABLE managed_auth_login_return_intents ENABLE ROW LEVEL SECURITY;

ALTER TABLE managed_auth_login_slots ENABLE ROW LEVEL SECURITY;

ALTER TABLE managed_auth_login_transaction_rate_limits ENABLE ROW LEVEL SECURITY;

ALTER TABLE managed_auth_login_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_actor_mutation_leases USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_browser_installations USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_login_return_intents USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_login_slots USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_login_transaction_rate_limits USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_login_transactions USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_session_set_operations USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

CREATE POLICY managed_auth_session_set_lifecycle ON managed_auth_session_sets USING ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.managed_auth_session_set_lifecycle'::text, true) = 'active'::text));

ALTER TABLE managed_auth_session_set_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE managed_auth_session_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY managed_sign_in_method_lifecycle ON managed_sign_in_method_operations USING ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text));

ALTER TABLE managed_sign_in_method_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcp_event_subscription_maintenance_owner ON mcp_event_subscriptions USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('mcp_event_subscriptions'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('mcp_event_subscriptions'::regclass)::oid))));

ALTER TABLE mcp_event_subscriptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE mcp_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE memory_slack_publication_configurations ENABLE ROW LEVEL SECURITY;

ALTER TABLE memory_slack_publication_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE memory_slack_publications ENABLE ROW LEVEL SECURITY;

CREATE POLICY modal_inventory_owner_read ON sandbox_leases FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND modal_inventory_read_capability_active()));

CREATE POLICY modal_native_origin_member_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND modal_native_origin_member_read_active(account_id, subject_id)));

ALTER TABLE model_call_fact_reconciliation_candidates ENABLE ROW LEVEL SECURITY;

ALTER TABLE model_call_fact_reconciliation_progress ENABLE ROW LEVEL SECURITY;

ALTER TABLE model_call_facts ENABLE ROW LEVEL SECURITY;

CREATE POLICY model_call_facts_account_workspace_isolation ON model_call_facts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY model_connection_workspace_access ON claude_subscription_credentials AS RESTRICTIVE FOR SELECT USING ((
CASE
    WHEN (account_id IS DISTINCT FROM opengeni_private.current_account_id()) THEN false
    WHEN (NOT (authority_scope = 'organization'::text)) THEN true
    WHEN (opengeni_private.current_workspace_id() IS NULL) THEN opengeni_private.codex_organization_admin_visible(account_id)
    ELSE
    CASE
        WHEN (get_workspace_kind(account_id, opengeni_private.current_workspace_id()) = 'personal'::text) THEN allow_personal_workspaces
        ELSE ((allowed_workspace_ids IS NULL) OR (opengeni_private.current_workspace_id() = ANY (allowed_workspace_ids)))
    END
END OR ( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active)));

CREATE POLICY model_connection_workspace_access ON codex_subscription_credentials AS RESTRICTIVE FOR SELECT USING ((
CASE
    WHEN (account_id IS DISTINCT FROM opengeni_private.current_account_id()) THEN false
    WHEN (NOT (authority_scope = 'organization'::text)) THEN true
    WHEN (opengeni_private.current_workspace_id() IS NULL) THEN opengeni_private.codex_organization_admin_visible(account_id)
    ELSE
    CASE
        WHEN (get_workspace_kind(account_id, opengeni_private.current_workspace_id()) = 'personal'::text) THEN allow_personal_workspaces
        ELSE ((allowed_workspace_ids IS NULL) OR (opengeni_private.current_workspace_id() = ANY (allowed_workspace_ids)))
    END
END OR ( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active)));

CREATE POLICY model_connection_workspace_access ON organization_model_provider_connections AS RESTRICTIVE FOR SELECT USING ((
CASE
    WHEN (account_id IS DISTINCT FROM opengeni_private.current_account_id()) THEN false
    WHEN (NOT true) THEN true
    WHEN (opengeni_private.current_workspace_id() IS NULL) THEN opengeni_private.codex_organization_admin_visible(account_id)
    ELSE
    CASE
        WHEN (get_workspace_kind(account_id, opengeni_private.current_workspace_id()) = 'personal'::text) THEN allow_personal_workspaces
        ELSE ((allowed_workspace_ids IS NULL) OR (opengeni_private.current_workspace_id() = ANY (allowed_workspace_ids)))
    END
END OR ( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active)));

CREATE POLICY model_connection_workspace_access ON xai_subscription_credentials AS RESTRICTIVE FOR SELECT USING ((
CASE
    WHEN (account_id IS DISTINCT FROM opengeni_private.current_account_id()) THEN false
    WHEN (NOT (authority_scope = 'organization'::text)) THEN true
    WHEN (opengeni_private.current_workspace_id() IS NULL) THEN opengeni_private.codex_organization_admin_visible(account_id)
    ELSE
    CASE
        WHEN (get_workspace_kind(account_id, opengeni_private.current_workspace_id()) = 'personal'::text) THEN allow_personal_workspaces
        ELSE ((allowed_workspace_ids IS NULL) OR (opengeni_private.current_workspace_id() = ANY (allowed_workspace_ids)))
    END
END OR ( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active)));

ALTER TABLE network_routes ENABLE ROW LEVEL SECURITY;

ALTER TABLE new_session_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY new_session_drafts_project_provenance_backfill_v1 ON new_session_drafts USING (((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('new_session_drafts'::regclass)::oid))) AND (current_setting('opengeni.new_session_draft_project_provenance_backfill_v1'::text, true) = '1'::text))) WITH CHECK (((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('new_session_drafts'::regclass)::oid))) AND (current_setting('opengeni.new_session_draft_project_provenance_backfill_v1'::text, true) = '1'::text)));

ALTER TABLE organization_agent_admin_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_agent_admin_access_account ON organization_agent_admin_access USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE organization_api_key_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_api_key_workspaces_read ON organization_api_key_workspaces FOR SELECT USING (((account_id = opengeni_private.current_account_id()) AND ((opengeni_private.current_api_key_hash() IS NULL) OR (EXISTS ( SELECT 1
   FROM api_keys k
  WHERE ((k.id = organization_api_key_workspaces.api_key_id) AND (k.account_id = organization_api_key_workspaces.account_id) AND (k.key_hash = opengeni_private.current_api_key_hash())))))));

CREATE POLICY organization_api_key_workspaces_write ON organization_api_key_workspaces USING (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_api_key_hash() IS NULL))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_api_key_hash() IS NULL)));

ALTER TABLE organization_codex_rotation_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_company_profile_agent_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_company_profile_agent_policy_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_company_profile_agent_policy_lifecycle ON organization_company_profile_agent_policies USING ((current_setting('opengeni.company_profile_agent_policy_lifecycle'::text, true) = 'company_profile_agent_policy'::text)) WITH CHECK ((current_setting('opengeni.company_profile_agent_policy_lifecycle'::text, true) = 'company_profile_agent_policy'::text));

CREATE POLICY organization_company_profile_agent_policy_lifecycle ON organization_company_profile_agent_policy_events USING ((current_setting('opengeni.company_profile_agent_policy_lifecycle'::text, true) = 'company_profile_agent_policy'::text)) WITH CHECK ((current_setting('opengeni.company_profile_agent_policy_lifecycle'::text, true) = 'company_profile_agent_policy'::text));

ALTER TABLE organization_credential_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_credential_providers_account_scope ON organization_credential_providers USING (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_workspace_id() IS NULL))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_workspace_id() IS NULL)));

CREATE POLICY organization_credential_providers_resolver_owner ON organization_credential_providers FOR SELECT USING (((account_id = opengeni_private.current_account_id()) AND enabled AND (CURRENT_USER = ( SELECT pg_get_userbyid(pg_class.relowner) AS pg_get_userbyid
   FROM pg_class
  WHERE (pg_class.oid = ('organization_credential_providers'::regclass)::oid))) AND (EXISTS ( SELECT 1
   FROM workspaces workspace
  WHERE ((workspace.id = opengeni_private.current_workspace_id()) AND (workspace.account_id = organization_credential_providers.account_id) AND (get_workspace_kind(workspace.account_id, workspace.id) = 'shared'::text) AND ((organization_credential_providers.workspace_filter IS NULL) OR ((organization_credential_providers.workspace_filter ->> 'externalSource'::text) = workspace.external_source)))))));

ALTER TABLE organization_integration_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_integration_policy_account ON organization_integration_policies USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

CREATE POLICY organization_integration_policy_operation_account ON organization_integration_policy_operations USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE organization_integration_policy_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_invitation_binding_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_isolation ON connection_use_audit_facts USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

CREATE POLICY organization_isolation ON connection_use_once_consumption_receipts USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY organization_isolation ON scheduled_task_connection_authority_snapshots USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY organization_isolation ON scheduled_task_reusable_connection_materializations USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY organization_isolation ON scheduled_task_run_connection_authority_snapshots USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)) WITH CHECK ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

CREATE POLICY organization_isolation ON turn_connection_authority_snapshots USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

CREATE POLICY organization_lease_lifecycle_read ON claude_credential_leases FOR SELECT USING (((authority_scope = 'organization'::text) AND (CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('claude_credential_leases'::regclass)::oid)))) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_lease_lifecycle_read ON xai_credential_leases FOR SELECT USING (((authority_scope = 'organization'::text) AND (CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('xai_credential_leases'::regclass)::oid)))) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_membership_backfill_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_backfill'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

ALTER TABLE organization_membership_invitations ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_membership_lifecycle_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_membership_operation_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_model_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_model_defaults_account ON organization_model_defaults USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE organization_model_provider_connection_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_model_provider_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_model_provider_custom_models ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_model_provider_scope ON organization_model_provider_connection_operations USING (opengeni_private.organization_model_provider_scope_visible(account_id)) WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));

CREATE POLICY organization_model_provider_scope ON organization_model_provider_connections USING (opengeni_private.organization_model_provider_scope_visible(account_id)) WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));

CREATE POLICY organization_model_provider_scope ON organization_model_provider_custom_models USING (opengeni_private.organization_model_provider_scope_visible(account_id)) WITH CHECK (opengeni_private.organization_model_provider_scope_visible(account_id));

CREATE POLICY organization_model_provider_subscription_models_read ON organization_model_provider_custom_models FOR SELECT USING (((provider_kind = 'claude_subscription'::text) AND opengeni_private.organization_subscription_model_scope_visible(account_id)));

ALTER TABLE organization_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_plans_account_isolation ON organization_plans USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

ALTER TABLE organization_privacy_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_privacy_preferences_account ON organization_privacy_preferences USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE organization_private_session_setting_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_private_session_setting_events_lifecycle ON organization_private_session_setting_events USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_private_session_settings'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_private_session_settings'::text));
