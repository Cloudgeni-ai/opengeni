-- deployment-mode: rolling
-- Opengeni baseline part 14 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY integration_facet_binding_owners
    ADD CONSTRAINT integration_facet_binding_owners_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_facet_binding_owners
    ADD CONSTRAINT integration_facet_binding_owners_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES integration_facet_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_operations
    ADD CONSTRAINT capability_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_operations
    ADD CONSTRAINT capability_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_memberships
    ADD CONSTRAINT organization_memberships_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_memberships
    ADD CONSTRAINT organization_memberships_personal_workspace_account_fk FOREIGN KEY (personal_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_retention_policies
    ADD CONSTRAINT organization_user_retention_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_retention_policies
    ADD CONSTRAINT organization_user_retention_policies_updater_fk FOREIGN KEY (updated_by_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_resource_authorities
    ADD CONSTRAINT organization_user_resource_authorities_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_resource_authorities
    ADD CONSTRAINT organization_user_resource_authorities_membership_fk FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_resource_authorities
    ADD CONSTRAINT organization_user_resource_authorities_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_owner_organization_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_forked_by_organization_membership_fk FOREIGN KEY (forked_by_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_authority_fk FOREIGN KEY (authority_id, account_id) REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_authority_owner_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY channels
    ADD CONSTRAINT channels_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY channels
    ADD CONSTRAINT channels_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY channels
    ADD CONSTRAINT channels_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_attempts
    ADD CONSTRAINT session_turn_attempts_authority_owner_fk FOREIGN KEY (authority_owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_channel_id_fk FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_owner_subject_account_fk FOREIGN KEY (account_id, owner_subject_id) REFERENCES organization_memberships(account_id, subject_id) ON DELETE RESTRICT;

ALTER TABLE ONLY codex_subscription_credentials
    ADD CONSTRAINT codex_credentials_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_interaction_fk FOREIGN KEY (account_id, workspace_id, interaction_id) REFERENCES slack_interactions(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_update_operations
    ADD CONSTRAINT slack_bot_update_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_update_operations
    ADD CONSTRAINT slack_bot_update_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_update_operations
    ADD CONSTRAINT slack_bot_update_operations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_task_policy_heads
    ADD CONSTRAINT slack_task_policy_heads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_task_policy_heads
    ADD CONSTRAINT slack_task_policy_heads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_task_policy_activation_events
    ADD CONSTRAINT slack_task_policy_activation_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_task_policy_activation_events
    ADD CONSTRAINT slack_task_policy_activation_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_interaction_fk FOREIGN KEY (account_id, workspace_id, interaction_id) REFERENCES slack_interactions(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_variable_sets
    ADD CONSTRAINT workspace_variable_sets_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY workspace_variable_sets
    ADD CONSTRAINT workspace_variable_sets_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id);

ALTER TABLE ONLY rigs
    ADD CONSTRAINT rigs_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY rigs
    ADD CONSTRAINT rigs_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id);

ALTER TABLE ONLY xai_subscription_credentials
    ADD CONSTRAINT xai_subscription_credentials_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_subscription_credentials
    ADD CONSTRAINT xai_subscription_credentials_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_subscription_credentials
    ADD CONSTRAINT xai_subscription_credentials_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_subscription_credentials
    ADD CONSTRAINT xai_subscription_credentials_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY xai_rotation_settings
    ADD CONSTRAINT xai_rotation_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_rotation_settings
    ADD CONSTRAINT xai_rotation_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_rotation_settings
    ADD CONSTRAINT xai_rotation_settings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_rotation_settings
    ADD CONSTRAINT xai_rotation_settings_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_turn_fk FOREIGN KEY (workspace_id, blocked_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_goal_fk FOREIGN KEY (workspace_id, goal_id) REFERENCES session_goals(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_identity_subjects
    ADD CONSTRAINT canonical_human_identity_subjects_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_identity_subjects
    ADD CONSTRAINT canonical_human_identity_subjects_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_login_bindings
    ADD CONSTRAINT canonical_human_login_bindings_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_identities
    ADD CONSTRAINT canonical_human_identities_active_binding_fk FOREIGN KEY (active_login_binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_identity_operations
    ADD CONSTRAINT canonical_human_identity_operations_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_identity_operations
    ADD CONSTRAINT canonical_human_identity_operations_actor_auth_user_id_fkey FOREIGN KEY (actor_auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY canonical_human_identity_operations
    ADD CONSTRAINT canonical_human_identity_operations_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_canonical_identity_fk FOREIGN KEY (identity_id) REFERENCES canonical_human_identities(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_notes
    ADD CONSTRAINT task_notes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY task_notes
    ADD CONSTRAINT task_notes_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_notes
    ADD CONSTRAINT task_notes_created_by_session_fk FOREIGN KEY (workspace_id, created_by_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_note_fk FOREIGN KEY (workspace_id, note_id) REFERENCES task_notes(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_resource_admissions
    ADD CONSTRAINT session_attempt_personal_resource_admissions_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_resource_admissions
    ADD CONSTRAINT session_attempt_personal_resource_admissions_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_resource_admissions
    ADD CONSTRAINT session_attempt_personal_resource_admissions_owner_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_attempt_personal_resource_snapshots
    ADD CONSTRAINT session_attempt_personal_resource_snapshots_admission_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation) REFERENCES session_attempt_personal_resource_admissions(account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_resource_snapshots
    ADD CONSTRAINT session_attempt_personal_resource_snapshots_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY personal_resource_once_consumption_receipts
    ADD CONSTRAINT personal_resource_once_consumption_receipts_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation) REFERENCES session_attempt_personal_resource_admissions(account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_source_id_fkey FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidenc_knowledge_source_object_id_fkey FOREIGN KEY (knowledge_source_object_id) REFERENCES knowledge_source_objects(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evide_knowledge_document_version_i_fkey FOREIGN KEY (knowledge_document_version_id) REFERENCES knowledge_document_versions(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_index_obligation_id_fkey FOREIGN KEY (index_obligation_id) REFERENCES knowledge_source_sync_index_obligations(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_principals
    ADD CONSTRAINT google_drive_object_acl_principals_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES google_drive_object_acl_evidence(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_principals
    ADD CONSTRAINT google_drive_object_acl_principals_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY google_drive_object_acl_principals
    ADD CONSTRAINT google_drive_object_acl_principals_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_drive_acl_fk FOREIGN KEY (google_drive_acl_evidence_id) REFERENCES google_drive_object_acl_evidence(id) ON DELETE SET NULL;

ALTER TABLE ONLY slack_app_home_refreshes
    ADD CONSTRAINT slack_app_home_refreshes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_app_home_refreshes
    ADD CONSTRAINT slack_app_home_refreshes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_app_home_refreshes
    ADD CONSTRAINT slack_app_home_refreshes_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_app_home_refreshes
    ADD CONSTRAINT slack_app_home_refreshes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_personal_resource_authorities
    ADD CONSTRAINT scheduled_task_personal_resource_authorities_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_personal_resource_authorities
    ADD CONSTRAINT scheduled_task_personal_resource_authorities_owner_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_personal_resource_snapshots_authority_header_fk FOREIGN KEY (task_id, task_authority_revision) REFERENCES scheduled_task_personal_resource_authorities(task_id, task_authority_revision) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_personal_resource_snapshots_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_run_personal_resource_admissions
    ADD CONSTRAINT scheduled_task_run_personal_resource_admissions_run_id_fkey FOREIGN KEY (run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_run_personal_resource_admissions
    ADD CONSTRAINT scheduled_task_run_personal_resource_admissions_owner_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_run_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_run_personal_resource_snapshots_admission_fk FOREIGN KEY (run_id) REFERENCES scheduled_task_run_personal_resource_admissions(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_run_personal_resource_once_receipts
    ADD CONSTRAINT scheduled_task_run_personal_resource_once_receipts_run_fk FOREIGN KEY (run_id) REFERENCES scheduled_task_run_personal_resource_admissions(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_preference_proposal_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY connection_use_once_consumption_receipts
    ADD CONSTRAINT connection_use_once_consumption_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_use_once_consumption_receipts
    ADD CONSTRAINT connection_once_receipts_authority_fk FOREIGN KEY (authority_id, account_id) REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_use_once_consumption_receipts
    ADD CONSTRAINT connection_once_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_user_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_user_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_attempt_personal_document_admissions
    ADD CONSTRAINT session_attempt_personal_document_admissions_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_document_admissions
    ADD CONSTRAINT session_attempt_personal_document_admissions_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_document_admissions
    ADD CONSTRAINT session_attempt_personal_document_admissions_owner_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_attempt_personal_document_snapshots
    ADD CONSTRAINT session_attempt_personal_document_snapshots_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_document_snapshots
    ADD CONSTRAINT session_attempt_personal_document_snapshots_admission_fk FOREIGN KEY (attempt_id) REFERENCES session_attempt_personal_document_admissions(attempt_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_personal_document_snapshots
    ADD CONSTRAINT session_attempt_personal_document_snapshots_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY personal_document_once_consumption_receipts
    ADD CONSTRAINT personal_document_once_consumption_receipts_snapshot_fk FOREIGN KEY (attempt_id, document_id) REFERENCES session_attempt_personal_document_snapshots(attempt_id, document_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_turn_context_snapshots
    ADD CONSTRAINT company_brain_turn_context_snapshot_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_turn_context_snapshots
    ADD CONSTRAINT company_brain_turn_context_snapshot_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_turn_context_snapshots
    ADD CONSTRAINT company_brain_turn_context_snapshot_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_turn_context_snapshots
    ADD CONSTRAINT company_brain_turn_context_snapshot_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_attempt_fk FOREIGN KEY (workspace_id, created_by_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_turn_context_snapshot_fk FOREIGN KEY (workspace_id, turn_context_snapshot_id) REFERENCES company_brain_turn_context_snapshots(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_replaced_note_fk FOREIGN KEY (workspace_id, replaced_note_id) REFERENCES task_notes(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_replacement_note_fk FOREIGN KEY (workspace_id, replacement_note_id) REFERENCES task_notes(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY enrollments
    ADD CONSTRAINT enrollments_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY enrollments
    ADD CONSTRAINT enrollments_origin_workspace_fk FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE SET NULL (origin_workspace_id);

ALTER TABLE ONLY session_attempt_connected_machine_authorizations
    ADD CONSTRAINT session_attempt_connected_machine_authorization_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_connected_machine_authorizations
    ADD CONSTRAINT session_attempt_connected_machine_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_connected_machine_authorizations
    ADD CONSTRAINT session_attempt_connected_machine_owner_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_attempt_connected_machine_authorizations
    ADD CONSTRAINT session_attempt_connected_machine_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_membership_invitations
    ADD CONSTRAINT organization_membership_invitations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_membership_invitations
    ADD CONSTRAINT organization_membership_invitations_creator_fk FOREIGN KEY (created_by_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_membership_invitations
    ADD CONSTRAINT organization_membership_invitations_accepted_membership_fk FOREIGN KEY (accepted_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_membership_operation_receipts
    ADD CONSTRAINT organization_membership_operation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_membership_lifecycle_events
    ADD CONSTRAINT organization_membership_lifecycle_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_membership_lifecycle_events
    ADD CONSTRAINT organization_membership_lifecycle_events_actor_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_membership_lifecycle_events
    ADD CONSTRAINT organization_membership_lifecycle_events_target_fk FOREIGN KEY (target_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_retention_deletions
    ADD CONSTRAINT organization_user_retention_deletions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_retention_deletions
    ADD CONSTRAINT organization_user_retention_deletions_membership_fk FOREIGN KEY (membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_retention_object_obligations
    ADD CONSTRAINT organization_retention_object_obligations_deletion_fk FOREIGN KEY (account_id, membership_id) REFERENCES organization_user_retention_deletions(account_id, membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_retention_object_deletion_receipts
    ADD CONSTRAINT organization_retention_object_deletions_obligation_fk FOREIGN KEY (account_id, membership_id, object_kind, source_id, object_bucket) REFERENCES organization_user_retention_object_obligations(account_id, membership_id, object_kind, source_id, object_bucket) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_retention_deletion_events
    ADD CONSTRAINT organization_user_retention_deletion_events_membership_fk FOREIGN KEY (membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY turn_connection_authority_snapshots
    ADD CONSTRAINT turn_connection_authority_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY turn_connection_authority_snapshots
    ADD CONSTRAINT turn_connection_authority_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY turn_connection_authority_snapshots
    ADD CONSTRAINT turn_connection_authority_authority_fk FOREIGN KEY (authority_id, account_id) REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_snapshot_fk FOREIGN KEY (policy_snapshot_id) REFERENCES workspace_learning_policy_snapshots(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_proposal_fk FOREIGN KEY (proposal_id) REFERENCES knowledge_change_proposals(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_claim_fk FOREIGN KEY (claim_id) REFERENCES knowledge_claims(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_evidence_fk FOREIGN KEY (evidence_id) REFERENCES knowledge_claim_evidence(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_undo_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_undo_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_deactivation_events
    ADD CONSTRAINT workspace_instruction_policy_deactivation_event_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_deactivation_events
    ADD CONSTRAINT workspace_instruction_policy_deactivation_eve_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_confirmation_receipts
    ADD CONSTRAINT remember_knowledge_confirmation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_confirmation_receipts
    ADD CONSTRAINT remember_knowledge_confirmation_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_revision_authorities
    ADD CONSTRAINT scheduled_task_revision_authorities_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_revision_authorities
    ADD CONSTRAINT scheduled_task_revision_authorities_membership_fk FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT session_system_updates_scheduled_run_fk FOREIGN KEY (workspace_id, scheduled_task_run_id) REFERENCES scheduled_task_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_scheduled_run_fk FOREIGN KEY (workspace_id, scheduled_task_run_id) REFERENCES scheduled_task_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY scheduled_task_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_connection_authority_snapshots_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_connection_aut_owner_organization_membershi_fkey FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_connection_authorit_authority_id_account_id_fkey FOREIGN KEY (authority_id, account_id) REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_run_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_run_connection_authority_snapshots_run_id_fkey FOREIGN KEY (run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_run_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_run_connection_owner_organization_membershi_fkey FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_run_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_run_connection_auth_authority_id_account_id_fkey FOREIGN KEY (authority_id, account_id) REFERENCES organization_user_resource_authorities(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_task_reusable_connection_materialization_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_task_reusable_connection_materializations_run_id_fkey FOREIGN KEY (run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_task_reusable_connection_materializat_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_task_reusable_connection_materializ_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_task_reusable_connection_materializat_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_initiator_membership_fk FOREIGN KEY (initiator_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_authority_owner_fk FOREIGN KEY (authority_owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sandbox_retained_processes
    ADD CONSTRAINT sandbox_retained_processes_initiator_membership_fk FOREIGN KEY (initiator_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sandbox_retained_processes
    ADD CONSTRAINT sandbox_retained_processes_authority_owner_fk FOREIGN KEY (authority_owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenancy_backfill_receipts
    ADD CONSTRAINT tenancy_backfill_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenancy_backfill_unresolved_rows
    ADD CONSTRAINT tenancy_backfill_unresolved_rows_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES tenancy_backfill_receipts(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenancy_backfill_unresolved_rows
    ADD CONSTRAINT tenancy_backfill_unresolved_rows_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_tenancy_activations
    ADD CONSTRAINT session_tenancy_activations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY turn_personal_resource_attachment_receipts
    ADD CONSTRAINT turn_personal_resource_attachment_receipts_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY turn_personal_resource_attachment_receipts
    ADD CONSTRAINT turn_personal_resource_attachment_receipts_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY turn_personal_resource_snapshots
    ADD CONSTRAINT turn_personal_resource_snapshots_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES turn_personal_resource_attachment_receipts(turn_id) ON DELETE CASCADE;

ALTER TABLE ONLY turn_personal_resource_once_receipts
    ADD CONSTRAINT turn_personal_resource_once_receipts_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES turn_personal_resource_attachment_receipts(turn_id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_profile_events
    ADD CONSTRAINT organization_profile_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_profile_events
    ADD CONSTRAINT organization_profile_events_actor_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_parent_fk FOREIGN KEY (workspace_id, parent_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_attempts
    ADD CONSTRAINT session_turn_attempts_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_command_receipts
    ADD CONSTRAINT session_command_receipts_target_session_fk FOREIGN KEY (workspace_id, target_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_control_events
    ADD CONSTRAINT workspace_control_events_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_interruptions
    ADD CONSTRAINT session_attempt_interruptions_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_invitation_binding_events
    ADD CONSTRAINT organization_invitation_binding_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_invitation_binding_events
    ADD CONSTRAINT organization_invitation_binding_events_invitation_fk FOREIGN KEY (invitation_id, account_id) REFERENCES organization_membership_invitations(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY personal_github_repository_selection_heads
    ADD CONSTRAINT personal_github_repository_selection_heads_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY personal_github_repository_selection_heads
    ADD CONSTRAINT personal_github_repository_selection_heads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY personal_github_repository_selection_heads
    ADD CONSTRAINT personal_github_repository_selection_h_origin_workspace_id_fkey FOREIGN KEY (origin_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY personal_github_repository_selections
    ADD CONSTRAINT personal_github_repository_selections_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY personal_github_repository_selections
    ADD CONSTRAINT personal_github_repository_selections_origin_workspace_id_fkey FOREIGN KEY (origin_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY personal_github_repository_selections
    ADD CONSTRAINT personal_github_repository_selections_head_fk FOREIGN KEY (account_id, origin_workspace_id, owner_subject_id, connection_id) REFERENCES personal_github_repository_selection_heads(account_id, origin_workspace_id, owner_subject_id, connection_id) ON DELETE CASCADE;

ALTER TABLE ONLY personal_github_repository_selection_operations
    ADD CONSTRAINT personal_github_repository_selection_operations_head_fk FOREIGN KEY (account_id, origin_workspace_id, owner_subject_id, connection_id) REFERENCES personal_github_repository_selection_heads(account_id, origin_workspace_id, owner_subject_id, connection_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_startup_milestones
    ADD CONSTRAINT session_turn_startup_milestones_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_startup_milestones
    ADD CONSTRAINT session_turn_startup_milestones_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_startup_milestones
    ADD CONSTRAINT session_turn_startup_milestones_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_sources
    ADD CONSTRAINT automation_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_sources
    ADD CONSTRAINT automation_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_sources
    ADD CONSTRAINT automation_sources_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_webhook_endpoints
    ADD CONSTRAINT automation_webhook_endpoints_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_webhook_endpoints
    ADD CONSTRAINT automation_webhook_endpoints_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_webhook_endpoints
    ADD CONSTRAINT automation_webhook_endpoints_source_id_fkey FOREIGN KEY (source_id) REFERENCES automation_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_webhook_endpoints
    ADD CONSTRAINT automation_webhook_endpoints_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_triggers
    ADD CONSTRAINT automation_triggers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_triggers
    ADD CONSTRAINT automation_triggers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_triggers
    ADD CONSTRAINT automation_triggers_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_triggers
    ADD CONSTRAINT automation_triggers_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_revisions
    ADD CONSTRAINT automation_trigger_revisions_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES automation_triggers(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_revisions
    ADD CONSTRAINT automation_trigger_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_events
    ADD CONSTRAINT automation_trigger_events_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_trigger_events
    ADD CONSTRAINT automation_trigger_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_event_links
    ADD CONSTRAINT automation_run_event_links_run_id_fkey FOREIGN KEY (run_id) REFERENCES automation_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_event_links
    ADD CONSTRAINT automation_run_event_links_event_id_fkey FOREIGN KEY (event_id) REFERENCES automation_trigger_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_event_links
    ADD CONSTRAINT automation_run_event_links_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_event_links
    ADD CONSTRAINT automation_run_event_links_run_fk FOREIGN KEY (workspace_id, trigger_id, run_id) REFERENCES automation_runs(workspace_id, trigger_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_run_event_links
    ADD CONSTRAINT automation_run_event_links_event_fk FOREIGN KEY (workspace_id, source_id, event_id) REFERENCES automation_trigger_events(workspace_id, source_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_app_registrations
    ADD CONSTRAINT pr_review_app_registrations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_app_registrations
    ADD CONSTRAINT pr_review_app_registrations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_app_registrations
    ADD CONSTRAINT pr_review_app_registrations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_app_registrations
    ADD CONSTRAINT pr_review_app_registrations_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_repository_bindings
    ADD CONSTRAINT pr_review_repository_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_repository_bindings
    ADD CONSTRAINT pr_review_repository_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_repository_bindings
    ADD CONSTRAINT pr_review_repository_bindings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_repository_bindings
    ADD CONSTRAINT pr_review_repository_bindings_trigger_fk FOREIGN KEY (workspace_id, trigger_id) REFERENCES automation_triggers(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_repository_bindings
    ADD CONSTRAINT pr_review_repository_bindings_registration_fk FOREIGN KEY (workspace_id, registration_id, provider) REFERENCES pr_review_app_registrations(workspace_id, id, provider) ON DELETE CASCADE;

ALTER TABLE ONLY organization_private_session_settings
    ADD CONSTRAINT organization_private_session_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_private_session_settings
    ADD CONSTRAINT organization_private_session_settings_updater_fk FOREIGN KEY (updated_by_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_private_session_setting_events
    ADD CONSTRAINT organization_private_session_setting_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_private_session_setting_events
    ADD CONSTRAINT organization_private_session_setting_events_actor_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposal_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, creation_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_membership_fk FOREIGN KEY (initiating_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_revision_fk FOREIGN KEY (revision_id, account_id) REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_expected_revision_fk FOREIGN KEY (expected_current_revision_id, account_id) REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, confirmation_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_revision_fk FOREIGN KEY (proposal_revision_id, account_id) REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_human_input_fk FOREIGN KEY (human_input_request_id) REFERENCES session_human_input_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_membership_fk FOREIGN KEY (approver_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmations_event_fk FOREIGN KEY (activation_event_id, account_id) REFERENCES company_profile_activation_events(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_background_commands
    ADD CONSTRAINT session_background_commands_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_background_commands
    ADD CONSTRAINT session_background_commands_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_background_commands
    ADD CONSTRAINT session_background_commands_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_target_workspace_account_fk FOREIGN KEY (target_workspace_id, target_account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_target_workspace_id_fkey FOREIGN KEY (target_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_target_workspace_account_fk FOREIGN KEY (target_workspace_id, target_account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_candidate_account_id_fkey FOREIGN KEY (candidate_account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_candidate_workspace_id_fkey FOREIGN KEY (candidate_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_prompt_fk FOREIGN KEY (account_id, workspace_id, prompt_id) REFERENCES slack_route_prompts(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_candidate_workspace_account_fk FOREIGN KEY (candidate_workspace_id, candidate_account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY document_authority_reclassifications
    ADD CONSTRAINT document_authority_reclassifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_authority_reclassifications
    ADD CONSTRAINT document_authority_reclassifications_workspace_fk FOREIGN KEY (request_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY document_default_collection_backfill_runs
    ADD CONSTRAINT document_default_collection_backfill_runs_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_default_collection_backfill_operations
    ADD CONSTRAINT document_default_collection_backfill_operations_run_id_fkey FOREIGN KEY (run_id) REFERENCES document_default_collection_backfill_runs(run_id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_default_collection_backfill_operations
    ADD CONSTRAINT document_default_collection_backfill_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_default_collection_backfill_receipts
    ADD CONSTRAINT document_default_collection_backfill_receipts_run_id_fkey FOREIGN KEY (run_id) REFERENCES document_default_collection_backfill_runs(run_id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_default_collection_backfill_receipts
    ADD CONSTRAINT document_default_collection_backfill_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY document_default_collection_backfill_receipts
    ADD CONSTRAINT document_default_collection_backfill_receipts_base_id_fkey FOREIGN KEY (base_id) REFERENCES document_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_default_collection_backfill_receipts
    ADD CONSTRAINT document_default_collection_backfill_receipts_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_receipts_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_rece_personal_workspace_id_fkey FOREIGN KEY (personal_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_organization_membership_id_fkey FOREIGN KEY (organization_membership_id) REFERENCES organization_memberships(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_setup_intents
    ADD CONSTRAINT organization_user_setup_intents_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_setup_intents
    ADD CONSTRAINT organization_user_setup_intents_completed_auth_user_id_fkey FOREIGN KEY (completed_auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_setup_intents
    ADD CONSTRAINT organization_user_setup_intents_invitation_fk FOREIGN KEY (invitation_id, account_id) REFERENCES organization_membership_invitations(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_evidence_account_id_fkey FOREIGN KEY (account_id) REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_e_setup_auth_user_id_fkey FOREIGN KEY (setup_auth_user_id) REFERENCES self_service_organization_setup_receipts(auth_user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_e_setup_operation_id_fkey FOREIGN KEY (setup_operation_id) REFERENCES self_service_organization_setup_receipts(operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activatio_personal_workspace_id_fkey FOREIGN KEY (personal_workspace_id) REFERENCES self_service_organization_setup_receipts(personal_workspace_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_acti_organization_membership_id_fkey FOREIGN KEY (organization_membership_id) REFERENCES self_service_organization_setup_receipts(organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_act_boundary_witness_account_id_fkey FOREIGN KEY (boundary_witness_account_id) REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activa_private_setting_event_id_fkey FOREIGN KEY (private_setting_event_id) REFERENCES organization_private_session_setting_events(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_workspace_operation_receipts
    ADD CONSTRAINT organization_workspace_operation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_workspace_lifecycle_events
    ADD CONSTRAINT organization_workspace_lifecycle_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_workspace_lifecycle_events
    ADD CONSTRAINT organization_workspace_lifecycle_events_actor_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_workspace_lifecycle_events
    ADD CONSTRAINT organization_workspace_lifecycle_events_target_fk FOREIGN KEY (target_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_setup_intent_id_fkey FOREIGN KEY (setup_intent_id) REFERENCES organization_user_setup_intents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_invitation_fk FOREIGN KEY (invitation_id, account_id) REFERENCES organization_membership_invitations(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_creator_fk FOREIGN KEY (created_by_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_user_setup_delivery_attempts
    ADD CONSTRAINT organization_user_setup_delivery_attempts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_user_setup_delivery_attempts
    ADD CONSTRAINT organization_user_setup_delivery_attempts_delivery_fk FOREIGN KEY (delivery_id, account_id) REFERENCES organization_user_setup_deliveries(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_variable_set_id_fkey FOREIGN KEY (variable_set_id) REFERENCES workspace_variable_sets(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.automatic_session_title_fanout_outbox_v1
    ADD CONSTRAINT automatic_title_fanout_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.automatic_session_title_fanout_outbox_v1
    ADD CONSTRAINT automatic_title_fanout_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;
