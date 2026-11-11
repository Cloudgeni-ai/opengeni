-- deployment-mode: rolling
-- Opengeni baseline part 21 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE POLICY subscription_person_preferences_owner_insert ON subscription_person_preferences FOR INSERT WITH CHECK (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id));

CREATE POLICY subscription_person_preferences_owner_read ON subscription_person_preferences FOR SELECT USING (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id));

CREATE POLICY subscription_person_preferences_owner_update ON subscription_person_preferences FOR UPDATE USING (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id)) WITH CHECK (opengeni_private.subscription_person_preference_owned(account_id, organization_membership_id));

CREATE POLICY subscription_person_preferences_scope ON subscription_person_preferences USING (opengeni_private.subscription_person_preference_visible(account_id, organization_membership_id, NULLIF(current_setting('opengeni.session_owner_subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.turn_human_subject_id'::text, true), ''::text))) WITH CHECK (opengeni_private.subscription_person_preference_visible(account_id, organization_membership_id, NULLIF(current_setting('opengeni.session_owner_subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.turn_human_subject_id'::text, true), ''::text)));

CREATE POLICY subscription_plan_maintenance_inventory_read ON credit_ledger_entries FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, NULL::uuid, true));

CREATE POLICY subscription_plan_maintenance_inventory_read ON managed_accounts FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, NULL::uuid, true));

CREATE POLICY subscription_plan_maintenance_inventory_read ON organization_plans FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, NULL::uuid, true));

CREATE POLICY subscription_plan_maintenance_inventory_read ON plan_credit_periods FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, NULL::uuid, true));

ALTER TABLE subscription_provider_cutovers ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_provider_cutovers_admin ON subscription_provider_cutovers FOR SELECT USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_provider_cutovers_admin_insert ON subscription_provider_cutovers FOR INSERT WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_provider_cutovers_admin_update ON subscription_provider_cutovers FOR UPDATE USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_provider_cutovers_receipt_insert ON subscription_provider_cutovers AS RESTRICTIVE FOR INSERT WITH CHECK (opengeni_private.subscription_provider_cutover_committed(provider));

CREATE POLICY subscription_provider_cutovers_receipt_update ON subscription_provider_cutovers AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK (((NOT enabled) OR opengeni_private.subscription_provider_cutover_committed(provider)));

CREATE POLICY subscription_provider_cutovers_scope ON subscription_provider_cutovers FOR SELECT USING (((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)));

CREATE POLICY subscription_provider_cutovers_seed ON subscription_provider_cutovers FOR INSERT WITH CHECK ((enabled AND opengeni_private.subscription_provider_cutover_committed(provider) AND (CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_provider_cutovers'::regclass)::oid)))) AND (current_setting('opengeni.subscription_cutover_seed'::text, true) = (account_id)::text)));

ALTER TABLE subscription_session_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE subscription_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_settings_lock_guard_read ON subscription_settings FOR SELECT USING (((workspace_id IS NULL) AND (CURRENT_USER = pg_get_userbyid(( SELECT proc.proowner
   FROM pg_proc proc
  WHERE (proc.oid = ('opengeni_private.guard_subscription_settings_locked_overrides()'::regprocedure)::oid)))) AND ((account_id)::text = NULLIF(current_setting('opengeni.subscription_settings_lock_probe'::text, true), ''::text))));

CREATE POLICY subscription_settings_manager ON subscription_settings USING (((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)) OR ((workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (EXISTS ( SELECT 1
   FROM workspace_memberships grant_row
  WHERE ((grant_row.account_id = subscription_settings.account_id) AND (grant_row.workspace_id = subscription_settings.workspace_id) AND (grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions))))))) WITH CHECK (((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)) OR ((workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (cardinality(locked_settings) = 0) AND (EXISTS ( SELECT 1
   FROM workspace_memberships grant_row
  WHERE ((grant_row.account_id = subscription_settings.account_id) AND (grant_row.workspace_id = subscription_settings.workspace_id) AND (grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions)))))));

CREATE POLICY subscription_settings_scope ON subscription_settings FOR SELECT USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id IS NULL) OR ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)))));

CREATE POLICY subscription_settings_seed ON subscription_settings FOR INSERT WITH CHECK (((workspace_id IS NULL) AND (CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_settings'::regclass)::oid)))) AND (current_setting('opengeni.subscription_cutover_seed'::text, true) = (account_id)::text)));

ALTER TABLE subscription_turn_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_note_capability_owner ON task_note_write_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE task_note_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_note_events_lifecycle_only ON task_note_events AS RESTRICTIVE USING ((EXISTS ( SELECT 1
   FROM task_note_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.task_note_write_capability'::text, true), ''::text))::uuid))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM task_note_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.task_note_write_capability'::text, true), ''::text))::uuid)))));

CREATE POLICY task_note_events_tenant ON task_note_events USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE task_note_knowledge_promotion_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_note_knowledge_promotion_capability_owner ON task_note_knowledge_promotion_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE task_note_replacement_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_note_replacement_receipts_owner ON task_note_replacement_receipts USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE task_note_write_capabilities ENABLE ROW LEVEL SECURITY;

ALTER TABLE task_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_notes_lifecycle_only ON task_notes AS RESTRICTIVE USING ((EXISTS ( SELECT 1
   FROM task_note_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.task_note_write_capability'::text, true), ''::text))::uuid))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM task_note_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.task_note_write_capability'::text, true), ''::text))::uuid)))));

CREATE POLICY task_notes_tenant ON task_notes USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE teams_bot_inbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE teams_bot_installations ENABLE ROW LEVEL SECURITY;

ALTER TABLE teams_bot_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE teams_bot_outbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE teams_bot_proofs ENABLE ROW LEVEL SECURITY;

ALTER TABLE teams_bot_routes ENABLE ROW LEVEL SECURITY;

CREATE POLICY teams_installation_directory ON teams_bot_installations FOR SELECT USING (true);

ALTER TABLE temporal_schedule_cleanup_outbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenancy_backfill_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenancy_backfill_unresolved_rows ENABLE ROW LEVEL SECURITY;

ALTER TABLE tool_gateway_approval_capabilities ENABLE ROW LEVEL SECURITY;

ALTER TABLE transcription_recording_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY transcription_recording_chunks_subject_isolation ON transcription_recording_chunks USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

ALTER TABLE transcription_recording_objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY transcription_recording_objects_subject_isolation ON transcription_recording_objects USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

ALTER TABLE transcription_recording_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY transcription_recording_segments_subject_isolation ON transcription_recording_segments USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

ALTER TABLE transcription_recordings ENABLE ROW LEVEL SECURITY;

CREATE POLICY transcription_recordings_subject_isolation ON transcription_recordings USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

ALTER TABLE turn_connection_authority_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY turn_personal_resource_attachment_internal ON turn_personal_resource_attachment_receipts USING (((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'personal_resource_grant_management'::text) OR (EXISTS ( SELECT 1
   FROM opengeni_private.personal_resource_delegation_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id_if_assigned()) AND (capability.capability_kind = ANY (ARRAY['admit'::text, 'resolve'::text]))))))) WITH CHECK (((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'personal_resource_grant_management'::text) OR (EXISTS ( SELECT 1
   FROM opengeni_private.personal_resource_delegation_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id_if_assigned()) AND (capability.capability_kind = 'admit'::text))))));

ALTER TABLE turn_personal_resource_attachment_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY turn_personal_resource_once_internal ON turn_personal_resource_once_receipts USING (((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'personal_resource_grant_management'::text) OR (EXISTS ( SELECT 1
   FROM opengeni_private.personal_resource_delegation_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id_if_assigned()) AND (capability.capability_kind = ANY (ARRAY['admit'::text, 'resolve'::text]))))))) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'personal_resource_grant_management'::text));

ALTER TABLE turn_personal_resource_once_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY turn_personal_resource_snapshot_internal ON turn_personal_resource_snapshots USING (((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'personal_resource_grant_management'::text) OR (EXISTS ( SELECT 1
   FROM opengeni_private.personal_resource_delegation_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id_if_assigned()) AND (capability.capability_kind = ANY (ARRAY['admit'::text, 'resolve'::text]))))))) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'personal_resource_grant_management'::text));

ALTER TABLE turn_personal_resource_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_allowance_owner_read ON external_identities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, NULL::uuid)));

CREATE POLICY usage_allowance_owner_read ON knowledge_entries FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, NULL::uuid)));

CREATE POLICY usage_allowance_owner_read ON knowledge_index_jobs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, NULL::uuid)));

CREATE POLICY usage_allowance_owner_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, NULL::uuid)));

CREATE POLICY usage_allowance_owner_read ON sandbox_leases FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_events_account_workspace_isolation ON usage_events USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));

CREATE POLICY variable_set_authority_capability_delete ON organization_user_resource_authorities FOR DELETE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_delete ON organization_user_resource_grants FOR DELETE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_delete ON workspace_variable_set_variables FOR DELETE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_delete ON workspace_variable_sets FOR DELETE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_insert ON organization_user_resource_grants FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_insert ON workspace_variable_set_variables FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_insert ON workspace_variable_sets FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON organization_user_resource_grants FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON rig_versions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON scheduled_tasks FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON session_attempt_interruptions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON session_turn_attempts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON session_turns FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON sessions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON workspace_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON workspace_variable_set_variables FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_read ON workspace_variable_sets FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active()));

CREATE POLICY variable_set_authority_capability_update ON organization_user_resource_authorities FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_update ON organization_user_resource_grants FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_update ON workspace_variable_set_variables FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY variable_set_authority_capability_update ON workspace_variable_sets FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_insert ON audit_events FOR INSERT TO {{owner}} WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_insert ON organization_user_resource_authorities FOR INSERT TO {{owner}} WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_read ON connections FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON managed_accounts FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON organization_memberships FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON organization_user_resource_authorities FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON scheduled_task_runs FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON scheduled_tasks FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON session_attempt_interruptions FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON session_turn_attempts FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON session_turns FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON sessions FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vault_field_versions FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vault_item_fields FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vault_item_name_aliases FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vault_items FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vault_name_aliases FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vault_passkey_leases FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON vaults FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON workspace_memberships FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_read ON workspaces FOR SELECT TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active()));

CREATE POLICY vault_authority_capability_update ON organization_user_resource_authorities FOR UPDATE TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_update ON sessions FOR UPDATE TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vault_field_versions TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vault_item_fields TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vault_item_name_aliases TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vault_items TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vault_name_aliases TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vault_passkey_leases TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

CREATE POLICY vault_authority_capability_write ON vaults TO {{owner}} USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.vault_authority_capability_active('write'::text)));

ALTER TABLE vault_field_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE vault_item_fields ENABLE ROW LEVEL SECURITY;

ALTER TABLE vault_item_name_aliases ENABLE ROW LEVEL SECURITY;

ALTER TABLE vault_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE vault_name_aliases ENABLE ROW LEVEL SECURITY;

ALTER TABLE vault_passkey_leases ENABLE ROW LEVEL SECURITY;

ALTER TABLE vaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY video_allowance_owner_read ON credit_ledger_entries FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

ALTER TABLE video_generation_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE video_generation_references ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_artifact_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_artifact_uploads ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_artifact_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_captures ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_codex_subscription_preferences ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_control_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_credential_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_credential_providers_workspace_scope ON workspace_credential_providers USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE workspace_gateway_custom_models ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_inference_controls ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_instruction_policy_activation_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_instruction_policy_deactivation_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_instruction_policy_heads ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_instruction_policy_onboarding_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_instruction_policy_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_instruction_policy_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_interaction_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON agent_run_states USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON attached_browser_devices USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON attached_browser_inventories USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON auth_runs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON automation_templates USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_identities USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_revision_components USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_session_associations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_session_retained_downloads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_sessions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_state_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON browser_state_uploads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON capability_catalog_items USING ((((account_id IS NULL) AND (workspace_id IS NULL)) OR opengeni_private.workspace_rls_visible(account_id, workspace_id))) WITH CHECK ((((account_id IS NULL) AND (workspace_id IS NULL)) OR opengeni_private.workspace_rls_visible(account_id, workspace_id)));

CREATE POLICY workspace_isolation ON capability_component_owners USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON capability_facet_installations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON capability_installations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON capability_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON capability_plugin_installations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON channels USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON codex_apps_settings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON codex_capacity_waiters USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON codex_credential_leases USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON codex_reset_redemption_attempts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON codex_rotation_settings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON codex_subscription_credentials USING (((authority_scope = ANY (ARRAY['workspace'::text, 'user'::text])) AND (workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(account_id, workspace_id))) WITH CHECK (((authority_scope = ANY (ARRAY['workspace'::text, 'user'::text])) AND (workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)));

CREATE POLICY workspace_isolation ON codex_turn_source_bindings FOR SELECT USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON company_brain_preference_proposal_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON company_profile_snapshots USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON composer_drafts USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY workspace_isolation ON computer_session_associations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON computer_sessions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON connections USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((subject_id IS NULL) OR (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((subject_id IS NULL) OR (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))));

CREATE POLICY workspace_isolation ON device_enrollment_requests USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON document_bases USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_blob_refs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_idempotency_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_live_outbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_materialization_jobs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_materialization_results USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_replica_leases USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_scope_authorization_heads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_sequence_checkpoints USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_session_links USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_snapshots USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_transactions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_undo_claims USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifact_versions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON editable_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON enrollment_token_redemptions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON enrollments USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON event_deliveries USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON event_source_feeds USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON event_sources USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON event_triggers USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON file_uploads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON files USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON generated_image_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON generated_video_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON github_installation_repositories USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON github_installations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON image_generation_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON inbound_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON integration_facet_binding_owners USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON integration_facet_bindings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON integration_oauth_state_nonces USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON interaction_interventions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON interaction_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON interaction_resource_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON knowledge_memories USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND opengeni_private.memory_scope_visible(scope_type, scope_subject_id, scope_role_key, scope_session_id, valid_from, valid_until))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND opengeni_private.memory_scope_visible(scope_type, scope_subject_id, scope_role_key, scope_session_id, valid_from, valid_until)));

CREATE POLICY workspace_isolation ON knowledge_memory_lifecycle_events USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (actor_kind = opengeni_private.current_memory_actor_kind()) AND (actor_subject_id = opengeni_private.current_memory_actor_id())));

CREATE POLICY workspace_isolation ON knowledge_memory_relationships USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM knowledge_memories source
  WHERE ((source.workspace_id = knowledge_memory_relationships.workspace_id) AND (source.id = knowledge_memory_relationships.source_memory_id)))) AND (EXISTS ( SELECT 1
   FROM knowledge_memories target
  WHERE ((target.workspace_id = knowledge_memory_relationships.workspace_id) AND (target.id = knowledge_memory_relationships.target_memory_id))))));

CREATE POLICY workspace_isolation ON machine_metrics_latest USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON machine_metrics_series USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON machine_removal_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON mcp_event_subscriptions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON mcp_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON memory_slack_publication_configurations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON memory_slack_publication_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON memory_slack_publications USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON model_call_fact_reconciliation_candidates USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON model_call_fact_reconciliation_progress USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON network_routes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON new_session_drafts USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY workspace_isolation ON recording_chunks USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_chunks.workspace_id) AND (parent.id = recording_chunks.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_chunks.workspace_id) AND (parent.id = recording_chunks.recording_id))))));

CREATE POLICY workspace_isolation ON recording_events USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((visibility = 'workspace_shared'::text) OR (owner_subject_id = opengeni_private.current_subject_id())))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((visibility = 'workspace_shared'::text) OR (owner_subject_id = opengeni_private.current_subject_id()))));

CREATE POLICY workspace_isolation ON recording_live_segments USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_live_segments.workspace_id) AND (parent.id = recording_live_segments.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_live_segments.workspace_id) AND (parent.id = recording_live_segments.recording_id))))));

CREATE POLICY workspace_isolation ON recording_notes USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_notes.workspace_id) AND (parent.id = recording_notes.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_notes.workspace_id) AND (parent.id = recording_notes.recording_id))))));

CREATE POLICY workspace_isolation ON recording_people USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON recording_segment_edits USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_segment_edits.workspace_id) AND (parent.id = recording_segment_edits.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_segment_edits.workspace_id) AND (parent.id = recording_segment_edits.recording_id))))));

CREATE POLICY workspace_isolation ON recording_speaker_assignments USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_speaker_assignments.workspace_id) AND (parent.id = recording_speaker_assignments.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_speaker_assignments.workspace_id) AND (parent.id = recording_speaker_assignments.recording_id))))));

CREATE POLICY workspace_isolation ON recording_speaker_voices USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON recording_tracks USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_tracks.workspace_id) AND (parent.id = recording_tracks.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_tracks.workspace_id) AND (parent.id = recording_tracks.recording_id))))));

CREATE POLICY workspace_isolation ON recording_transcript_segments USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_transcript_segments.workspace_id) AND (parent.id = recording_transcript_segments.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_transcript_segments.workspace_id) AND (parent.id = recording_transcript_segments.recording_id))))));

CREATE POLICY workspace_isolation ON recording_transcript_versions USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_transcript_versions.workspace_id) AND (parent.id = recording_transcript_versions.recording_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM recordings parent
  WHERE ((parent.workspace_id = recording_transcript_versions.workspace_id) AND (parent.id = recording_transcript_versions.recording_id))))));

CREATE POLICY workspace_isolation ON recording_voice_rejections USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON recording_voiceprints USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON recordings USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((visibility = 'workspace_shared'::text) OR (owner_subject_id = opengeni_private.current_subject_id())))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((visibility = 'workspace_shared'::text) OR (owner_subject_id = opengeni_private.current_subject_id()))));

CREATE POLICY workspace_isolation ON retained_screenshot_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON rig_changes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON rig_versions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON rigs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_checkpoint_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_lease_holders USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_leases USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_pty_sessions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_retained_processes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_session_envelopes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandbox_workspace_mutation_admissions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sandboxes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_task_blocker_reviews USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_task_event_inbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_task_event_occurrences USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_task_event_settings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_task_runs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_task_schedule_outbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON scheduled_tasks USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON secret_use_approvals USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_attempt_codemode_calls USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_attempt_interruptions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_attempt_model_context_snapshots USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_attempt_tool_catalogs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_background_commands USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_command_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_content_blobs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_event_cursors USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_goal_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_goals USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_history_items USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_human_input_requests USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_list_snapshots USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY workspace_isolation ON session_mcp_servers USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_message_search_texts FOR SELECT USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_pending_tool_calls USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_pins USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY workspace_isolation ON session_realtime_connections USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_realtime_context_projections USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_realtime_entries USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_realtime_modes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_recordings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_spawn_denials USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_stream_acknowledgments USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_system_update_outbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_system_updates USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_title_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_turn_app_action_grants USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_turn_attempts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_turn_startup_milestones USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_turns USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON session_variable_set_attachments USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) OR opengeni_private.variable_set_authority_capability_active('write'::text))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) OR opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY workspace_isolation ON session_workflow_wake_outbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON sessions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_abuse_reports USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_auth_codes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_auth_connections USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_collections USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_files USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_rate_windows USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_record_values USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_records USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_usage USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_validation_windows USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_data_workspace_validation_windows USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_hostnames USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_limit_profiles USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_opens USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY workspace_isolation ON site_platform_usage USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_publications USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_runtime_conversations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_runtime_rate_windows USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_runtime_usage USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_session_access USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_sidebar_states USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY workspace_isolation ON site_sql_databases USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_sql_migrations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_sql_queries USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_sql_rate_windows USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_sql_usage USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON site_viewer_sessions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_app_home_refreshes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_bot_delete_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_bot_post_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_bot_update_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_bot_user_links USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_channel_routes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_installation_bindings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_interaction_action_handles USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_interaction_inbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_interaction_progress_deliveries USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_interactions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_route_prompt_options USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_route_prompts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_shared_task_origins USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_task_policy_activation_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_task_policy_heads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_task_policy_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_user_dm_routes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON slack_user_link_access_request_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));
