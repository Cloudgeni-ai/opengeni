-- deployment-mode: rolling
-- Opengeni baseline part 19 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE organization_private_session_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_private_session_settings_lifecycle ON organization_private_session_settings USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_private_session_settings'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_private_session_settings'::text));

CREATE POLICY organization_private_session_settings_membership_lock ON organization_memberships FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_private_session_settings'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

CREATE POLICY organization_private_session_settings_membership_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_private_session_settings'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

CREATE POLICY organization_private_session_settings_scoped_read ON organization_private_session_settings FOR SELECT USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

ALTER TABLE organization_profile_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_approvals ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_command_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_custodian_acceptances ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_custodians ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_approvals USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_command_receipts USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_custodian_acceptances USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_custodians USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_events USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_notification_attempts USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_notification_outbox USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_operations USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_policies USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

CREATE POLICY organization_recovery_lifecycle ON organization_recovery_policy_heads USING ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.organization_recovery_lifecycle'::text, true) = 'active'::text));

ALTER TABLE organization_recovery_notification_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_notification_outbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_recovery_policy_heads ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON organization_codex_rotation_settings USING (opengeni_private.codex_organization_scope_visible(account_id)) WITH CHECK (opengeni_private.codex_organization_scope_visible(account_id));

CREATE POLICY organization_scope_delete ON claude_rotation_settings FOR DELETE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_delete ON claude_subscription_credentials FOR DELETE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_delete ON codex_subscription_credentials FOR DELETE USING (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_delete ON xai_rotation_settings FOR DELETE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_delete ON xai_subscription_credentials FOR DELETE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_insert ON claude_rotation_settings FOR INSERT WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_insert ON claude_subscription_credentials FOR INSERT WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_insert ON codex_subscription_credentials FOR INSERT WITH CHECK (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_insert ON xai_rotation_settings FOR INSERT WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_insert ON xai_subscription_credentials FOR INSERT WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_select ON claude_rotation_settings FOR SELECT USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_select ON claude_subscription_credentials FOR SELECT USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_select ON codex_subscription_credentials FOR SELECT USING (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_select ON xai_rotation_settings FOR SELECT USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_select ON xai_subscription_credentials FOR SELECT USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_update ON claude_rotation_settings FOR UPDATE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id))) WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_update ON claude_subscription_credentials FOR UPDATE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id))) WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_update ON xai_rotation_settings FOR UPDATE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id))) WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_update ON xai_subscription_credentials FOR UPDATE USING (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id))) WITH CHECK (((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

CREATE POLICY organization_scope_update_admin ON codex_subscription_credentials FOR UPDATE USING (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND opengeni_private.codex_organization_admin_visible(account_id))) WITH CHECK (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND opengeni_private.codex_organization_admin_visible(account_id)));

CREATE POLICY organization_scope_update_runtime ON codex_subscription_credentials FOR UPDATE USING (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND (opengeni_private.current_workspace_id() IS NOT NULL) AND opengeni_private.codex_organization_scope_visible(account_id))) WITH CHECK (((authority_scope = 'organization'::text) AND (organization_id = account_id) AND (opengeni_private.current_workspace_id() IS NOT NULL) AND opengeni_private.codex_organization_scope_visible(account_id)));

ALTER TABLE organization_service_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_service_accounts_isolation ON organization_service_accounts USING (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_api_key_hash() IS NULL))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_api_key_hash() IS NULL)));

ALTER TABLE organization_shared_workspace_administration_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_shared_workspace_administration_capability_owner ON organization_shared_workspace_administration_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY organization_tenancy_inventory_capability_read ON codex_subscription_credentials FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON connections FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON documents FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON enrollments FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON rigs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON sandbox_retained_processes FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON sandbox_workspace_mutation_admissions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON sessions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_inventory_capability_read ON workspace_variable_sets FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_inventory_capability_active()));

CREATE POLICY organization_tenancy_lifecycle ON organization_invitation_binding_events USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_membership_invitations USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_membership_lifecycle_events USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_membership_operation_receipts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_memberships USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'session_visibility_activation'::text, 'organization_membership_lifecycle'::text, 'personal_resource_grant_management'::text]))) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'session_visibility_activation'::text, 'organization_membership_lifecycle'::text, 'personal_resource_grant_management'::text])));

CREATE POLICY organization_tenancy_lifecycle ON organization_profile_events USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_resource_authorities USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'organization_membership_lifecycle'::text, 'personal_resource_grant_management'::text]))) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'organization_membership_lifecycle'::text, 'personal_resource_grant_management'::text])));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_resource_grants USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'session_visibility_activation'::text, 'organization_membership_lifecycle'::text, 'personal_resource_grant_management'::text]))) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'session_visibility_activation'::text, 'organization_membership_lifecycle'::text, 'personal_resource_grant_management'::text])));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_retention_deletion_events USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_retention_deletions USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_retention_object_deletion_receipts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_retention_object_obligations USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_retention_policies USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'organization_membership_lifecycle'::text]))) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = ANY (ARRAY['managed_human_provisioning'::text, 'organization_membership_lifecycle'::text])));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_setup_deliveries USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_setup_delivery_attempts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_user_setup_intents USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_workspace_lifecycle_events USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON organization_workspace_operation_receipts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON self_service_organization_setup_receipts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text));

CREATE POLICY organization_tenancy_lifecycle ON tenancy_backfill_receipts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'tenancy_backfill_ledger'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'tenancy_backfill_ledger'::text));

CREATE POLICY organization_tenancy_lifecycle ON tenancy_backfill_unresolved_rows USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'tenancy_backfill_ledger'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'tenancy_backfill_ledger'::text));

CREATE POLICY organization_tenancy_parity_capability_read ON canonical_human_identities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON canonical_human_identity_subjects FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON canonical_human_login_bindings FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON codex_subscription_credentials FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON connection_use_audit_facts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON connections FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON documents FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON enrollments FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON organization_user_resource_grants FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON rigs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON sandbox_retained_processes FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON sandbox_workspace_mutation_admissions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON sessions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

CREATE POLICY organization_tenancy_parity_capability_read ON workspace_variable_sets FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.organization_tenancy_parity_capability_active()));

ALTER TABLE organization_user_resource_authorities ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_resource_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_retention_deletion_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_retention_deletions ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_retention_object_deletion_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_retention_object_obligations ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_retention_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_setup_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_setup_delivery_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_user_setup_intents ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_webhook_deliveries_account_scope ON organization_webhook_deliveries USING (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_workspace_id() IS NULL))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_workspace_id() IS NULL)));

CREATE POLICY organization_webhook_deliveries_dispatcher_owner ON organization_webhook_deliveries USING ((CURRENT_USER = ( SELECT pg_get_userbyid(pg_class.relowner) AS pg_get_userbyid
   FROM pg_class
  WHERE (pg_class.oid = ('organization_webhook_deliveries'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(pg_class.relowner) AS pg_get_userbyid
   FROM pg_class
  WHERE (pg_class.oid = ('organization_webhook_deliveries'::regclass)::oid))));

ALTER TABLE organization_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_webhooks_account_scope ON organization_webhooks USING (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_workspace_id() IS NULL))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (opengeni_private.current_workspace_id() IS NULL)));

CREATE POLICY organization_webhooks_dispatcher_owner ON organization_webhooks FOR SELECT USING ((CURRENT_USER = ( SELECT pg_get_userbyid(pg_class.relowner) AS pg_get_userbyid
   FROM pg_class
  WHERE (pg_class.oid = ('organization_webhooks'::regclass)::oid))));

ALTER TABLE organization_workspace_lifecycle_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE organization_workspace_operation_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_isolation ON site_session_access AS RESTRICTIVE USING ((owner_subject_id = ANY (ARRAY[NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.initiating_human_subject_id'::text, true), ''::text)]))) WITH CHECK (((owner_subject_id = ANY (ARRAY[NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.initiating_human_subject_id'::text, true), ''::text)])) AND (EXISTS ( SELECT 1
   FROM (sessions s
     JOIN workspace_artifacts a ON ((a.workspace_id = s.workspace_id)))
  WHERE ((s.workspace_id = site_session_access.workspace_id) AND (s.id = site_session_access.session_id) AND (a.id = site_session_access.site_id) AND (a.visibility = 'user_private'::text) AND (s.site_access_root_id IS NULL) AND (s.owner_subject_id = site_session_access.owner_subject_id) AND (a.owner_subject_id = site_session_access.owner_subject_id))))));

CREATE POLICY parent_api_visibility ON integration_spec_revisions USING ((EXISTS ( SELECT 1
   FROM capability_api_facets a
  WHERE (a.facet_id = integration_spec_revisions.api_facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (((capability_api_facets a
     JOIN capability_facets f ON ((f.id = a.facet_id)))
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((a.facet_id = integration_spec_revisions.api_facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_facet_visibility ON capability_api_facets USING ((EXISTS ( SELECT 1
   FROM capability_facets f
  WHERE (f.id = capability_api_facets.facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ((capability_facets f
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((f.id = capability_api_facets.facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_facet_visibility ON capability_integration_facets USING ((EXISTS ( SELECT 1
   FROM capability_facets f
  WHERE (f.id = capability_integration_facets.facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ((capability_facets f
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((f.id = capability_integration_facets.facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_facet_visibility ON capability_mcp_facets USING ((EXISTS ( SELECT 1
   FROM capability_facets f
  WHERE (f.id = capability_mcp_facets.facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ((capability_facets f
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((f.id = capability_mcp_facets.facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_facet_visibility ON capability_skill_facets USING ((EXISTS ( SELECT 1
   FROM capability_facets f
  WHERE (f.id = capability_skill_facets.facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ((capability_facets f
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((f.id = capability_skill_facets.facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_facet_visibility ON integration_tools USING ((EXISTS ( SELECT 1
   FROM capability_facets f
  WHERE (f.id = integration_tools.facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ((capability_facets f
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((f.id = integration_tools.facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_integration_visibility ON integration_facet_definitions USING ((EXISTS ( SELECT 1
   FROM capability_integration_facets i
  WHERE (i.facet_id = integration_facet_definitions.integration_facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (((capability_integration_facets i
     JOIN capability_facets f ON ((f.id = i.facet_id)))
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((i.facet_id = integration_facet_definitions.integration_facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_plugin_visibility ON capability_facets USING ((EXISTS ( SELECT 1
   FROM capability_plugin_versions v
  WHERE (v.id = capability_facets.plugin_version_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (capability_plugin_versions v
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((v.id = capability_facets.plugin_version_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_plugin_visibility ON capability_plugin_versions USING ((EXISTS ( SELECT 1
   FROM capability_plugins p
  WHERE (p.id = capability_plugin_versions.plugin_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM capability_plugins p
  WHERE ((p.id = capability_plugin_versions.plugin_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY parent_skill_visibility ON capability_skill_files USING ((EXISTS ( SELECT 1
   FROM capability_skill_facets s
  WHERE (s.facet_id = capability_skill_files.skill_facet_id)))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (((capability_skill_facets s
     JOIN capability_facets f ON ((f.id = s.facet_id)))
     JOIN capability_plugin_versions v ON ((v.id = f.plugin_version_id)))
     JOIN capability_plugins p ON ((p.id = v.plugin_id)))
  WHERE ((s.facet_id = capability_skill_files.skill_facet_id) AND (p.workspace_id IS NOT NULL) AND opengeni_private.workspace_rls_visible(p.account_id, p.workspace_id)))));

CREATE POLICY personal_document_authority_capability_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('write'::text)));

CREATE POLICY personal_document_authority_capability_insert ON personal_document_once_consumption_receipts FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('admit'::text)));

CREATE POLICY personal_document_authority_capability_insert ON session_attempt_personal_document_admissions FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('admit'::text)));

CREATE POLICY personal_document_authority_capability_insert ON session_attempt_personal_document_snapshots FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('admit'::text)));

CREATE POLICY personal_document_authority_capability_read ON documents FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON files FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON organization_user_resource_grants FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON personal_document_once_consumption_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON session_attempt_interruptions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON session_attempt_personal_document_admissions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON session_attempt_personal_document_snapshots FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON session_turn_attempts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON session_turns FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON sessions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_read ON workspace_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

CREATE POLICY personal_document_authority_capability_update ON organization_user_resource_authorities FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('write'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('write'::text)));

CREATE POLICY personal_document_authority_capability_update ON session_attempt_personal_document_admissions FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('admit'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active('admit'::text)));

CREATE POLICY personal_document_grant_capability_update ON organization_user_resource_grants FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active())) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_document_authority_capability_active()));

ALTER TABLE personal_document_once_consumption_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE personal_github_repository_selection_heads ENABLE ROW LEVEL SECURITY;

CREATE POLICY personal_github_repository_selection_heads_owner_isolation ON personal_github_repository_selection_heads USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (origin_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (owner_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (origin_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (owner_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

ALTER TABLE personal_github_repository_selection_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY personal_github_repository_selection_operations_owner_isolation ON personal_github_repository_selection_operations USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (origin_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (owner_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (origin_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (owner_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

ALTER TABLE personal_github_repository_selections ENABLE ROW LEVEL SECURITY;

CREATE POLICY personal_github_repository_selections_owner_isolation ON personal_github_repository_selections USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (origin_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (owner_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (origin_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (owner_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

CREATE POLICY personal_resource_delegation_capability_insert ON personal_resource_once_consumption_receipts FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active('admit'::text)));

CREATE POLICY personal_resource_delegation_capability_insert ON session_attempt_personal_resource_admissions FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active('admit'::text)));

CREATE POLICY personal_resource_delegation_capability_insert ON session_attempt_personal_resource_snapshots FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active('admit'::text)));

CREATE POLICY personal_resource_delegation_capability_read ON personal_resource_once_consumption_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_capability_read ON session_attempt_personal_resource_admissions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_capability_read ON session_attempt_personal_resource_snapshots FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_grant_read ON organization_user_resource_grants FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_grant_update ON organization_user_resource_grants FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active('admit'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active('admit'::text)));

CREATE POLICY personal_resource_delegation_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_read ON rig_versions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_read ON rigs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

CREATE POLICY personal_resource_delegation_read ON workspace_variable_sets FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.personal_resource_delegation_capability_active()));

ALTER TABLE personal_resource_once_consumption_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE plan_credit_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_credit_periods_account_isolation ON plan_credit_periods USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

ALTER TABLE pr_review_app_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY pr_review_app_registrations_tenant ON pr_review_app_registrations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE pr_review_managed_github_authority_nonces ENABLE ROW LEVEL SECURITY;

CREATE POLICY pr_review_managed_github_authority_nonces_tenant ON pr_review_managed_github_authority_nonces USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE pr_review_repository_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY pr_review_repository_bindings_tenant ON pr_review_repository_bindings USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE preference_registry_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE preference_registry_preferences ENABLE ROW LEVEL SECURITY;

ALTER TABLE preference_registry_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY preference_registry_scope_isolation ON preference_registry_events USING ((EXISTS ( SELECT 1
   FROM preference_registry_preferences preference
  WHERE ((preference.id = preference_registry_events.preference_id) AND (preference.account_id = preference_registry_events.account_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM preference_registry_preferences preference
  WHERE ((preference.id = preference_registry_events.preference_id) AND (preference.account_id = preference_registry_events.account_id)))));

CREATE POLICY preference_registry_scope_isolation ON preference_registry_preferences USING (opengeni_private.preference_registry_scope_visible(account_id, scope, scope_workspace_id, scope_subject_id)) WITH CHECK (opengeni_private.preference_registry_scope_visible(account_id, scope, scope_workspace_id, scope_subject_id));

CREATE POLICY preference_registry_scope_isolation ON preference_registry_revisions USING (((EXISTS ( SELECT 1
   FROM preference_registry_preferences preference
  WHERE ((preference.id = preference_registry_revisions.preference_id) AND (preference.account_id = preference_registry_revisions.account_id)))) OR (EXISTS ( SELECT 1
   FROM preference_registry_snapshots snapshot
  WHERE ((snapshot.account_id = preference_registry_revisions.account_id) AND (snapshot.workspace_id = opengeni_private.current_workspace_id()) AND (snapshot.initiating_human_subject_id = opengeni_private.current_subject_id()) AND (snapshot.descriptors @> jsonb_build_array(jsonb_build_object('id', (preference_registry_revisions.preference_id)::text, 'revisionId', (preference_registry_revisions.id)::text, 'contentHash', preference_registry_revisions.content_hash)))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM preference_registry_preferences preference
  WHERE ((preference.id = preference_registry_revisions.preference_id) AND (preference.account_id = preference_registry_revisions.account_id)))));

CREATE POLICY preference_registry_snapshot_isolation ON preference_registry_snapshots USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (initiating_human_subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (initiating_human_subject_id = opengeni_private.current_subject_id())));

ALTER TABLE preference_registry_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE private_session_create_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY private_session_create_capability_owner ON private_session_create_capabilities USING ((current_setting('opengeni.private_session_create_lifecycle'::text, true) = 'private_session_create'::text)) WITH CHECK ((current_setting('opengeni.private_session_create_lifecycle'::text, true) = 'private_session_create'::text));

CREATE POLICY private_session_create_membership_lock ON organization_memberships FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'private_session_create_authority'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY private_session_create_membership_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'private_session_create_authority'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (subject_id = opengeni_private.current_subject_id())));

ALTER TABLE recording_chunks ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_live_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY recording_maintenance_owner ON recording_chunks USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recording_chunks'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recording_chunks'::regclass)::oid))));

CREATE POLICY recording_maintenance_owner ON recording_tracks USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recording_tracks'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recording_tracks'::regclass)::oid))));

CREATE POLICY recording_maintenance_owner ON recording_transcript_versions USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recording_transcript_versions'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recording_transcript_versions'::regclass)::oid))));

CREATE POLICY recording_maintenance_owner ON recordings USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recordings'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('recordings'::regclass)::oid))));

ALTER TABLE recording_notes ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_people ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_segment_edits ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_speaker_assignments ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_speaker_voices ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_tracks ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_transcript_segments ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_transcript_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_voice_rejections ENABLE ROW LEVEL SECURITY;

ALTER TABLE recording_voiceprints ENABLE ROW LEVEL SECURITY;

ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;

ALTER TABLE remember_knowledge_confirmation_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY remember_knowledge_confirmation_receipts_tenant ON remember_knowledge_confirmation_receipts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE remember_knowledge_memory_materializations ENABLE ROW LEVEL SECURITY;

CREATE POLICY remember_knowledge_memory_materializations_tenant ON remember_knowledge_memory_materializations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY resource_classification_capability_read ON enrollments FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.resource_classification_capability_active()));

CREATE POLICY resource_classification_capability_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.resource_classification_capability_active()));

CREATE POLICY resource_classification_capability_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.resource_classification_capability_active()));

CREATE POLICY resource_classification_capability_read ON rigs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.resource_classification_capability_active()));

CREATE POLICY resource_classification_capability_read ON workspace_variable_sets FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.resource_classification_capability_active()));

ALTER TABLE retained_screenshot_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE rig_changes ENABLE ROW LEVEL SECURITY;

ALTER TABLE rig_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE rigs ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_checkpoint_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_lease_holders ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_leases ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_pty_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_retained_processes ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_session_envelopes ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandbox_workspace_mutation_admissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE sandboxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY scheduled_personal_resource_attempt_receipt_delete ON personal_resource_once_consumption_receipts FOR DELETE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active('attempt_match'::text)));

CREATE POLICY scheduled_personal_resource_attempt_receipt_read ON personal_resource_once_consumption_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active('attempt_match'::text)));

CREATE POLICY scheduled_personal_resource_capability_insert ON scheduled_task_personal_resource_authorities FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_insert ON scheduled_task_personal_resource_snapshots FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_insert ON scheduled_task_run_personal_resource_admissions FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_insert ON scheduled_task_run_personal_resource_once_receipts FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_insert ON scheduled_task_run_personal_resource_snapshots FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_read ON scheduled_task_personal_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_read ON scheduled_task_personal_resource_snapshots FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_read ON scheduled_task_run_personal_resource_admissions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_read ON scheduled_task_run_personal_resource_once_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_capability_read ON scheduled_task_run_personal_resource_snapshots FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_grant_update ON organization_user_resource_grants FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active())) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_read ON organization_user_resource_grants FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_read ON rig_versions FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_read ON rigs FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_read ON workspace_variable_sets FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active()));

CREATE POLICY scheduled_personal_resource_run_rebind_update ON scheduled_task_run_personal_resource_admissions FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active('run_admit'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active('run_admit'::text)));

CREATE POLICY scheduled_personal_resource_run_rebind_update ON scheduled_task_run_personal_resource_snapshots FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active('run_admit'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.scheduled_personal_resource_capability_active('run_admit'::text)));

ALTER TABLE scheduled_task_blocker_reviews ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_connection_authority_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_event_inbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_event_occurrences ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_event_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_personal_resource_authorities ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_personal_resource_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_reusable_connection_materializations ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_revision_authorities ENABLE ROW LEVEL SECURITY;

CREATE POLICY scheduled_task_revision_authorities_workspace_isolation ON scheduled_task_revision_authorities USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid))) WITH CHECK (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE scheduled_task_run_connection_authority_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_run_personal_resource_admissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_run_personal_resource_once_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_run_personal_resource_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_task_schedule_outbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY scoped_compute_capability_insert ON enrollments FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON organization_user_resource_grants FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON rig_versions FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON rigs FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON sandboxes FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON session_attempt_connected_machine_authorizations FOR INSERT WITH CHECK (opengeni_private.scoped_compute_capability_active('write'::text));

CREATE POLICY scoped_compute_capability_insert ON session_attempt_machine_consents FOR INSERT WITH CHECK (opengeni_private.scoped_compute_capability_active('write'::text));

CREATE POLICY scoped_compute_capability_insert ON session_turn_machine_consents FOR INSERT WITH CHECK (opengeni_private.scoped_compute_capability_active('write'::text));

CREATE POLICY scoped_compute_capability_insert ON sessions FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_insert ON workspace_session_activity_revisions FOR INSERT WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_lock ON organization_memberships FOR UPDATE USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND ( SELECT scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text) AS scoped_compute_policy_capability_active))) WITH CHECK (false);

CREATE POLICY scoped_compute_capability_lock ON session_turn_attempts FOR UPDATE USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND ( SELECT scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text) AS scoped_compute_policy_capability_active))) WITH CHECK (false);

CREATE POLICY scoped_compute_capability_lock ON session_turns FOR UPDATE USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND ( SELECT scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text) AS scoped_compute_policy_capability_active))) WITH CHECK (false);

CREATE POLICY scoped_compute_capability_lock ON workspace_memberships FOR UPDATE USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND ( SELECT scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text) AS scoped_compute_policy_capability_active))) WITH CHECK (false);

CREATE POLICY scoped_compute_capability_read ON enrollments FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON organization_memberships FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON organization_user_resource_authorities FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON organization_user_resource_grants FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON personal_resource_once_consumption_receipts FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON rig_changes FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON rig_versions FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON rigs FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON sandboxes FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON scheduled_task_runs FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON session_attempt_connected_machine_authorizations FOR SELECT USING (opengeni_private.scoped_compute_capability_active());

CREATE POLICY scoped_compute_capability_read ON session_attempt_interruptions FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON session_attempt_machine_consents FOR SELECT USING (opengeni_private.scoped_compute_capability_active());

CREATE POLICY scoped_compute_capability_read ON session_attempt_personal_resource_admissions FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON session_attempt_personal_resource_snapshots FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON session_background_commands FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON session_turn_attempts FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON session_turn_machine_consents FOR SELECT USING (opengeni_private.scoped_compute_capability_active());

CREATE POLICY scoped_compute_capability_read ON session_turns FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON sessions FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON workspace_memberships FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_read ON workspace_session_activity_revisions FOR SELECT USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, NULL::text));

CREATE POLICY scoped_compute_capability_update ON enrollments FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON organization_user_resource_authorities FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON organization_user_resource_grants FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON rig_versions FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON rigs FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON sandboxes FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON session_attempt_connected_machine_authorizations FOR UPDATE USING (opengeni_private.scoped_compute_capability_active('write'::text)) WITH CHECK (opengeni_private.scoped_compute_capability_active('write'::text));

CREATE POLICY scoped_compute_capability_update ON sessions FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_compute_capability_update ON workspace_session_activity_revisions FOR UPDATE USING (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text)) WITH CHECK (scoped_compute_policy_capability_active((CURRENT_USER)::text, '{{owner}}'::text, 'write'::text));

CREATE POLICY scoped_knowledge_insert ON knowledge_change_proposals FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_claim_evidence FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_claim_relations FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_claim_reviews FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_claims FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_document_versions FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_entities FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_entity_aliases FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_facts FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_lifecycle_events FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_operation_receipts FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_providers FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_source_acl_versions FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_source_objects FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_sources FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_insert ON knowledge_sync_runs FOR INSERT WITH CHECK ((opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id) AND opengeni_private.scoped_knowledge_actor_authorized(actor_kind, actor_subject_id, initiating_human_subject_id)));

CREATE POLICY scoped_knowledge_select ON knowledge_change_proposals FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_claim_evidence FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_claim_relations FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_claim_reviews FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_claims FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_document_versions FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_entities FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_entity_aliases FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_facts FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_lifecycle_events FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_operation_receipts FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_providers FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_source_acl_versions FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_source_objects FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_sources FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_select ON knowledge_sync_runs FOR SELECT USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_update ON knowledge_providers FOR UPDATE USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id)) WITH CHECK (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_update ON knowledge_source_objects FOR UPDATE USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id)) WITH CHECK (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_update ON knowledge_sources FOR UPDATE USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id)) WITH CHECK (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

CREATE POLICY scoped_knowledge_update ON knowledge_sync_runs FOR UPDATE USING (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id)) WITH CHECK (opengeni_private.scoped_knowledge_scope_visible(account_id, scope_kind, scope_workspace_id, scope_subject_id));

ALTER TABLE secret_approval_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE secret_use_approvals ENABLE ROW LEVEL SECURITY;
