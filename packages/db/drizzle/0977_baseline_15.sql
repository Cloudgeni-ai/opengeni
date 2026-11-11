-- deployment-mode: rolling
-- Opengeni baseline part 15 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY opengeni_private.automatic_session_title_fanout_outbox_v1
    ADD CONSTRAINT automatic_title_fanout_workspace_event_fk FOREIGN KEY (workspace_id, event_id) REFERENCES session_events(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_authority_nonces
    ADD CONSTRAINT pr_review_managed_github_authority_nonces_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_authority_nonces
    ADD CONSTRAINT pr_review_managed_github_authority_nonces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_authority_nonces
    ADD CONSTRAINT pr_review_managed_github_authority_nonces_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES pr_review_repository_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_registration_fk FOREIGN KEY (workspace_id, registration_id) REFERENCES pr_review_app_registrations(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES automation_sources(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_material_confirmation_receipt_id_fkey FOREIGN KEY (confirmation_receipt_id) REFERENCES remember_knowledge_confirmation_receipts(id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_materializations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_materializations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_materializations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_materializations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_login_binding_fk FOREIGN KEY (login_binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_session_sets
    ADD CONSTRAINT managed_auth_session_sets_installation_id_fkey FOREIGN KEY (installation_id) REFERENCES managed_auth_browser_installations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_session_set_id_fkey FOREIGN KEY (session_set_id) REFERENCES managed_auth_session_sets(id) ON DELETE CASCADE;

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES auth_sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_login_binding_id_fkey FOREIGN KEY (login_binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_session_sets
    ADD CONSTRAINT managed_auth_session_sets_selected_slot_fk FOREIGN KEY (selected_slot_id, id) REFERENCES managed_auth_login_slots(id, session_set_id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_return_intents
    ADD CONSTRAINT managed_auth_login_return_intents_session_set_id_fkey FOREIGN KEY (session_set_id) REFERENCES managed_auth_session_sets(id) ON DELETE CASCADE;

ALTER TABLE ONLY managed_auth_login_transactions
    ADD CONSTRAINT managed_auth_login_transactions_session_set_id_fkey FOREIGN KEY (session_set_id) REFERENCES managed_auth_session_sets(id) ON DELETE CASCADE;

ALTER TABLE ONLY managed_auth_login_transactions
    ADD CONSTRAINT managed_auth_login_transactions_target_slot_id_fkey FOREIGN KEY (target_slot_id) REFERENCES managed_auth_login_slots(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_transactions
    ADD CONSTRAINT managed_auth_login_transactions_expected_identity_id_fkey FOREIGN KEY (expected_identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_transactions
    ADD CONSTRAINT managed_auth_login_transactions_expected_login_binding_id_fkey FOREIGN KEY (expected_login_binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_login_transactions
    ADD CONSTRAINT managed_auth_login_transactions_return_intent_id_fkey FOREIGN KEY (return_intent_id) REFERENCES managed_auth_login_return_intents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_managed_auth_login_transaction_id_fkey FOREIGN KEY (managed_auth_login_transaction_id) REFERENCES managed_auth_login_transactions(id) ON DELETE SET NULL;

ALTER TABLE ONLY managed_auth_session_set_operations
    ADD CONSTRAINT managed_auth_session_set_operations_session_set_id_fkey FOREIGN KEY (session_set_id) REFERENCES managed_auth_session_sets(id) ON DELETE RESTRICT;

ALTER TABLE ONLY managed_auth_actor_mutation_leases
    ADD CONSTRAINT managed_auth_actor_mutation_leases_session_set_id_fkey FOREIGN KEY (session_set_id) REFERENCES managed_auth_session_sets(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_recovery_policies
    ADD CONSTRAINT organization_recovery_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_recovery_policies
    ADD CONSTRAINT organization_recovery_policies_configured_by_identity_id_fkey FOREIGN KEY (configured_by_identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_policies
    ADD CONSTRAINT organization_recovery_policies_membership_fk FOREIGN KEY (configured_by_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_policy_heads
    ADD CONSTRAINT organization_recovery_policy_heads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_recovery_policy_heads
    ADD CONSTRAINT organization_recovery_policy_heads_policy_fk FOREIGN KEY (current_policy_id, account_id) REFERENCES organization_recovery_policies(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_canonical_identity_id_fkey FOREIGN KEY (canonical_identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_policy_fk FOREIGN KEY (policy_id, account_id) REFERENCES organization_recovery_policies(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_membership_fk FOREIGN KEY (membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_custodian_acceptances_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_custodian_acceptanc_login_binding_id_fkey FOREIGN KEY (login_binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_custodian_accept_reauth_operation_id_fkey FOREIGN KEY (reauth_operation_id) REFERENCES managed_auth_session_set_operations(operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_acceptances_policy_fk FOREIGN KEY (policy_id, account_id) REFERENCES organization_recovery_policies(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_acceptances_custodian_fk FOREIGN KEY (custodian_id, policy_id) REFERENCES organization_recovery_custodians(id, policy_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_acceptances_membership_fk FOREIGN KEY (membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_target_identity_id_fkey FOREIGN KEY (target_identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_target_auth_user_id_fkey FOREIGN KEY (target_auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_started_by_identity_id_fkey FOREIGN KEY (started_by_identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_policy_fk FOREIGN KEY (policy_id, account_id) REFERENCES organization_recovery_policies(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_target_fk FOREIGN KEY (target_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_starter_fk FOREIGN KEY (started_by_custodian_id, policy_id) REFERENCES organization_recovery_custodians(id, policy_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_login_binding_id_fkey FOREIGN KEY (login_binding_id) REFERENCES canonical_human_login_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_custodian_acceptance_id_fkey FOREIGN KEY (custodian_acceptance_id) REFERENCES organization_recovery_custodian_acceptances(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_reauth_operation_id_fkey FOREIGN KEY (reauth_operation_id) REFERENCES managed_auth_session_set_operations(operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES organization_recovery_operations(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_custodian_fk FOREIGN KEY (custodian_id, policy_id) REFERENCES organization_recovery_custodians(id, policy_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_membership_fk FOREIGN KEY (membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_command_receipts
    ADD CONSTRAINT organization_recovery_command_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_recovery_command_receipts
    ADD CONSTRAINT organization_recovery_receipts_membership_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_command_receipts
    ADD CONSTRAINT organization_recovery_receipts_identity_fk FOREIGN KEY (actor_identity_id) REFERENCES canonical_human_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_events
    ADD CONSTRAINT organization_recovery_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_recovery_events
    ADD CONSTRAINT organization_recovery_events_policy_fk FOREIGN KEY (policy_id, account_id) REFERENCES organization_recovery_policies(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_events
    ADD CONSTRAINT organization_recovery_events_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES organization_recovery_operations(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_events
    ADD CONSTRAINT organization_recovery_events_membership_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_notification_outbox
    ADD CONSTRAINT organization_recovery_outbox_policy_fk FOREIGN KEY (policy_id, account_id) REFERENCES organization_recovery_policies(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_notification_outbox
    ADD CONSTRAINT organization_recovery_outbox_operation_fk FOREIGN KEY (operation_id, account_id) REFERENCES organization_recovery_operations(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_notification_outbox
    ADD CONSTRAINT organization_recovery_outbox_recipient_fk FOREIGN KEY (recipient_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_recovery_notification_attempts
    ADD CONSTRAINT organization_recovery_notification_attempts_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES organization_recovery_notification_outbox(id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_work_claims
    ADD CONSTRAINT session_work_claims_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_work_claims
    ADD CONSTRAINT session_work_claims_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_work_claims
    ADD CONSTRAINT session_work_claims_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_claim_fk FOREIGN KEY (workspace_id, claim_id) REFERENCES session_work_claims(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_event_cursors
    ADD CONSTRAINT session_event_cursors_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_event_cursors
    ADD CONSTRAINT session_event_cursors_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_event_cursors
    ADD CONSTRAINT session_event_cursors_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_event_cursors
    ADD CONSTRAINT session_event_cursors_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_event_cursors
    ADD CONSTRAINT session_event_cursors_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_company_profile_agent_policies
    ADD CONSTRAINT organization_company_profile_agent_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_company_profile_agent_policies
    ADD CONSTRAINT organization_company_profile_agent_policies_membership_fk FOREIGN KEY (updated_by_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY organization_company_profile_agent_policy_events
    ADD CONSTRAINT organization_company_profile_agent_policy_event_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_company_profile_agent_policy_events
    ADD CONSTRAINT organization_company_profile_agent_policy_events_membership_fk FOREIGN KEY (actor_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activation_rece_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, activation_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_revision_fk FOREIGN KEY (proposal_revision_id, account_id) REFERENCES company_profile_revisions(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_membership_fk FOREIGN KEY (initiating_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activations_event_fk FOREIGN KEY (activation_event_id, account_id) REFERENCES company_profile_activation_events(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY codex_subscription_credentials
    ADD CONSTRAINT codex_subscription_credentials_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_codex_subscription_preferences
    ADD CONSTRAINT workspace_codex_subscription_preferences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_codex_subscription_preferences
    ADD CONSTRAINT workspace_codex_subscription_preferences_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_codex_subscription_preferences
    ADD CONSTRAINT workspace_codex_subscription_preferences_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_codex_rotation_settings
    ADD CONSTRAINT organization_codex_rotation_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_codex_rotation_settings
    ADD CONSTRAINT organization_codex_rotation_settings_active_fk FOREIGN KEY (active_credential_id) REFERENCES codex_subscription_credentials(id) ON DELETE SET NULL;

ALTER TABLE ONLY codex_credential_leases
    ADD CONSTRAINT codex_credential_leases_account_credential_fk FOREIGN KEY (account_id, credential_id) REFERENCES codex_subscription_credentials(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_gateway_custom_models
    ADD CONSTRAINT workspace_gateway_custom_models_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_gateway_custom_models
    ADD CONSTRAINT workspace_gateway_custom_models_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_gateway_custom_models
    ADD CONSTRAINT workspace_gateway_custom_models_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_model_provider_connections
    ADD CONSTRAINT organization_model_provider_connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_model_provider_connection_operations
    ADD CONSTRAINT organization_model_provider_connection_operatio_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_model_provider_custom_models
    ADD CONSTRAINT organization_model_provider_custom_models_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.context_compaction_pending_observations
    ADD CONSTRAINT context_compaction_pending_observations_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creatio_organization_membership_id_fkey FOREIGN KEY (organization_membership_id) REFERENCES organization_memberships(id) ON DELETE RESTRICT;

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_rec_personal_workspace_id_fkey FOREIGN KEY (personal_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_recei_shared_workspace_id_fkey FOREIGN KEY (shared_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organization_activat_account_id_fkey FOREIGN KEY (account_id) REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organizat_creation_operation_id_fkey FOREIGN KEY (creation_operation_id) REFERENCES additional_organization_creation_receipts(operation_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_org_boundary_witness_account_id_fkey FOREIGN KEY (boundary_witness_account_id) REFERENCES session_tenancy_activations(account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organi_private_setting_event_id_fkey FOREIGN KEY (private_setting_event_id) REFERENCES organization_private_session_setting_events(id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organization_personal_workspace_fk FOREIGN KEY (personal_workspace_id) REFERENCES additional_organization_creation_receipts(personal_workspace_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organization_shared_workspace_fk FOREIGN KEY (shared_workspace_id) REFERENCES additional_organization_creation_receipts(shared_workspace_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organization_membership_fk FOREIGN KEY (organization_membership_id) REFERENCES additional_organization_creation_receipts(organization_membership_id) ON DELETE RESTRICT;

ALTER TABLE ONLY session_attempt_model_context_snapshots
    ADD CONSTRAINT session_attempt_model_context_snapshots_attempt_owner_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_client_id_fkey FOREIGN KEY (client_id) REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_client_id_fkey FOREIGN KEY (client_id) REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY tool_gateway_approval_capabilities
    ADD CONSTRAINT tool_gateway_approval_capabilities_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY tool_gateway_approval_capabilities
    ADD CONSTRAINT tool_gateway_approval_capabilities_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY tool_gateway_approval_capabilities
    ADD CONSTRAINT tool_gateway_approval_capabilities_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_uploads
    ADD CONSTRAINT workspace_artifact_uploads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_uploads
    ADD CONSTRAINT workspace_artifact_uploads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_uploads
    ADD CONSTRAINT workspace_artifact_uploads_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_rotation_settings
    ADD CONSTRAINT xai_rotation_settings_active_credential_fk FOREIGN KEY (account_id, active_credential_id) REFERENCES xai_subscription_credentials(account_id, id) ON DELETE SET NULL (active_credential_id);

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_credential_fk FOREIGN KEY (account_id, credential_id) REFERENCES xai_subscription_credentials(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_pinned_credential_fk FOREIGN KEY (account_id, pinned_credential_id) REFERENCES xai_subscription_credentials(account_id, id) ON DELETE SET NULL (pinned_credential_id);

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_last_credential_fk FOREIGN KEY (account_id, last_credential_id) REFERENCES xai_subscription_credentials(account_id, id) ON DELETE SET NULL (last_credential_id);

ALTER TABLE ONLY feedback_submissions
    ADD CONSTRAINT feedback_submissions_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY feedback_submissions
    ADD CONSTRAINT feedback_submissions_workspace_id_session_id_fkey FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY feedback_submissions
    ADD CONSTRAINT feedback_submissions_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY skill_config_conversion_receipts
    ADD CONSTRAINT skill_config_conversion_receipts_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_preferences
    ADD CONSTRAINT preference_registry_preferences_scope_workspace_id_fkey FOREIGN KEY (scope_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_revisions
    ADD CONSTRAINT preference_registry_revisions_preference_fk FOREIGN KEY (account_id, preference_id) REFERENCES preference_registry_preferences(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_preference_fk FOREIGN KEY (account_id, preference_id) REFERENCES preference_registry_preferences(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_preferences
    ADD CONSTRAINT preference_registry_preferences_active_revision_fk FOREIGN KEY (id, active_revision_id) REFERENCES preference_registry_revisions(preference_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY preference_registry_preferences
    ADD CONSTRAINT preference_registry_preferences_superseded_by_fk FOREIGN KEY (account_id, superseded_by_preference_id) REFERENCES preference_registry_preferences(account_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY preference_registry_revisions
    ADD CONSTRAINT preference_registry_revisions_corrects_revision_id_fkey FOREIGN KEY (corrects_revision_id) REFERENCES preference_registry_revisions(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_old_revision_fk FOREIGN KEY (preference_id, old_revision_id) REFERENCES preference_registry_revisions(preference_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_new_revision_fk FOREIGN KEY (preference_id, new_revision_id) REFERENCES preference_registry_revisions(preference_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_related_fk FOREIGN KEY (account_id, related_preference_id) REFERENCES preference_registry_preferences(account_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY skill_source_bindings
    ADD CONSTRAINT skill_source_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY skill_source_bindings
    ADD CONSTRAINT skill_source_bindings_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES capability_plugins(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY skill_source_bindings
    ADD CONSTRAINT skill_source_bindings_skill_facet_id_fkey FOREIGN KEY (skill_facet_id) REFERENCES capability_skill_facets(facet_id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY skill_source_bindings
    ADD CONSTRAINT skill_source_bindings_account_id_preference_id_fkey FOREIGN KEY (account_id, preference_id) REFERENCES preference_registry_preferences(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY skill_write_receipts
    ADD CONSTRAINT skill_write_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_preference_fk FOREIGN KEY (preference_id) REFERENCES preference_registry_preferences(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_revision_fk FOREIGN KEY (revision_id) REFERENCES preference_registry_revisions(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_creation_event_fk FOREIGN KEY (creation_event_id) REFERENCES preference_registry_events(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_turn_fk FOREIGN KEY (turn_id) REFERENCES session_turns(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_pref_receipts_attempt_fk FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY connect_attempts
    ADD CONSTRAINT connect_attempts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connect_attempts
    ADD CONSTRAINT connect_attempts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY external_identities
    ADD CONSTRAINT external_identities_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_identities
    ADD CONSTRAINT external_identities_organization_membership_id_account_id_fkey FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id);

ALTER TABLE ONLY external_identities
    ADD CONSTRAINT external_identities_personal_workspace_id_account_id_fkey FOREIGN KEY (personal_workspace_id, account_id) REFERENCES workspaces(id, account_id);

ALTER TABLE ONLY host_mcp_bindings
    ADD CONSTRAINT host_mcp_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_bindings
    ADD CONSTRAINT host_mcp_bindings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_delegations
    ADD CONSTRAINT host_mcp_delegations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_delegations
    ADD CONSTRAINT host_mcp_delegations_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES host_mcp_bindings(id) DEFERRABLE;

ALTER TABLE ONLY host_mcp_delegations
    ADD CONSTRAINT host_mcp_delegations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES host_mcp_bindings(id) DEFERRABLE;

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES host_mcp_delegations(id) DEFERRABLE;

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_task_authorities
    ADD CONSTRAINT host_mcp_task_authorities_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_task_authorities
    ADD CONSTRAINT host_mcp_task_authorities_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_task_authorities
    ADD CONSTRAINT host_mcp_task_authorities_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES host_mcp_bindings(id) DEFERRABLE;

ALTER TABLE ONLY host_mcp_task_authorities
    ADD CONSTRAINT host_mcp_task_authorities_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES host_mcp_delegations(id) DEFERRABLE;

ALTER TABLE ONLY host_mcp_task_authorities
    ADD CONSTRAINT host_mcp_task_authorities_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY external_identity_links
    ADD CONSTRAINT external_identity_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_identity_links
    ADD CONSTRAINT external_identity_links_external_identity_id_fkey FOREIGN KEY (external_identity_id) REFERENCES external_identities(id);

ALTER TABLE ONLY external_identity_links
    ADD CONSTRAINT external_identity_links_account_id_external_subject_id_fkey FOREIGN KEY (account_id, external_subject_id) REFERENCES external_identities(account_id, subject_id);

ALTER TABLE ONLY external_identity_links
    ADD CONSTRAINT external_identity_links_native_membership_id_account_id_fkey FOREIGN KEY (native_membership_id, account_id) REFERENCES organization_memberships(id, account_id);

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_link_id_fkey FOREIGN KEY (link_id) REFERENCES external_identity_links(id);

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_source_turn_id_fkey FOREIGN KEY (source_turn_id) REFERENCES session_turns(id) DEFERRABLE;

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_source_task_id_fkey FOREIGN KEY (source_task_id) REFERENCES scheduled_tasks(id) DEFERRABLE;

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE;

ALTER TABLE ONLY external_link_task_authorities
    ADD CONSTRAINT external_link_task_authorities_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY external_link_task_authorities
    ADD CONSTRAINT external_link_task_authorities_link_id_fkey FOREIGN KEY (link_id) REFERENCES external_identity_links(id);

ALTER TABLE ONLY external_link_task_authorities
    ADD CONSTRAINT external_link_task_authorities_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE;

ALTER TABLE ONLY host_mcp_bindings
    ADD CONSTRAINT host_mcp_bindings_member_owner_fk FOREIGN KEY (account_id, owner_subject_id) REFERENCES organization_memberships(account_id, subject_id);

ALTER TABLE ONLY host_mcp_delegations
    ADD CONSTRAINT host_mcp_delegations_member_owner_fk FOREIGN KEY (account_id, owner_subject_id) REFERENCES organization_memberships(account_id, subject_id);

ALTER TABLE ONLY mcp_operations
    ADD CONSTRAINT mcp_operations_source_fk FOREIGN KEY (account_id, workspace_id, session_id, source_turn_id, source_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY files
    ADD CONSTRAINT files_retention_workspace_account_fk FOREIGN KEY (retention_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_learning_revisions
    ADD CONSTRAINT agent_learning_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_learning_revisions
    ADD CONSTRAINT agent_learning_revisions_owner_workspace_id_account_id_fkey FOREIGN KEY (owner_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_learning_snapshots
    ADD CONSTRAINT agent_learning_snapshots_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_learning_snapshots
    ADD CONSTRAINT agent_learning_snapshots_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_scope_workspace_id_account_id_fkey FOREIGN KEY (scope_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_review_batches
    ADD CONSTRAINT knowledge_review_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_account_id_entry_id_fkey FOREIGN KEY (account_id, entry_id) REFERENCES knowledge_entries(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_account_id_entry_id_previous_rev_fkey FOREIGN KEY (account_id, entry_id, previous_revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_account_id_entry_id_restored_fro_fkey FOREIGN KEY (account_id, entry_id, restored_from_revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_account_id_review_batch_id_fkey FOREIGN KEY (account_id, review_batch_id) REFERENCES knowledge_review_batches(account_id, id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_published_fk FOREIGN KEY (account_id, id, published_revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_latest_fk FOREIGN KEY (account_id, id, latest_revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY knowledge_entry_links
    ADD CONSTRAINT knowledge_entry_links_account_id_entry_id_revision_id_fkey FOREIGN KEY (account_id, entry_id, revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entry_links
    ADD CONSTRAINT knowledge_entry_links_account_id_target_entry_id_fkey FOREIGN KEY (account_id, target_entry_id) REFERENCES knowledge_entries(account_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_entry_links
    ADD CONSTRAINT knowledge_entry_links_account_id_target_entry_id_target_re_fkey FOREIGN KEY (account_id, target_entry_id, target_revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) DEFERRABLE;

ALTER TABLE ONLY knowledge_entry_decisions
    ADD CONSTRAINT knowledge_entry_decisions_account_id_entry_id_revision_id_fkey FOREIGN KEY (account_id, entry_id, revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entry_operations
    ADD CONSTRAINT knowledge_entry_operations_account_id_entry_id_fkey FOREIGN KEY (account_id, entry_id) REFERENCES knowledge_entries(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_instruction_operations
    ADD CONSTRAINT agent_instruction_operations_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES workspace_instruction_policy_revisions(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_instruction_operations
    ADD CONSTRAINT agent_instruction_operations_origin_workspace_id_account_i_fkey FOREIGN KEY (origin_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_index_jobs
    ADD CONSTRAINT knowledge_index_jobs_account_id_entry_id_revision_id_fkey FOREIGN KEY (account_id, entry_id, revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entry_vectors
    ADD CONSTRAINT knowledge_entry_vectors_account_id_entry_id_revision_id_fkey FOREIGN KEY (account_id, entry_id, revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_entry_search
    ADD CONSTRAINT knowledge_entry_search_account_id_entry_id_revision_id_fkey FOREIGN KEY (account_id, entry_id, revision_id) REFERENCES knowledge_entry_revisions(account_id, entry_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_resolvers
    ADD CONSTRAINT host_mcp_resolvers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY host_mcp_resolver_operations
    ADD CONSTRAINT host_mcp_resolver_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.sandbox_file_publications
    ADD CONSTRAINT sandbox_file_publications_file_fk FOREIGN KEY (account_id, workspace_id, file_id) REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.sandbox_file_publications
    ADD CONSTRAINT sandbox_file_publications_session_fk FOREIGN KEY (workspace_id, source_session_id) REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (source_session_id);

ALTER TABLE ONLY organization_integration_policies
    ADD CONSTRAINT organization_integration_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_integration_policy_operations
    ADD CONSTRAINT organization_integration_policy_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY managed_sign_in_method_operations
    ADD CONSTRAINT managed_sign_in_method_operations_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY skill_write_receipts
    ADD CONSTRAINT skill_write_receipts_activation_event_id_fkey FOREIGN KEY (activation_event_id) REFERENCES preference_registry_events(id) ON DELETE SET NULL;

ALTER TABLE ONLY codex_turn_source_bindings
    ADD CONSTRAINT codex_turn_source_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_turn_source_bindings
    ADD CONSTRAINT codex_turn_source_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_turn_source_bindings
    ADD CONSTRAINT codex_turn_source_bindings_workspace_id_turn_id_fkey FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_turn_source_bindings
    ADD CONSTRAINT codex_turn_source_bindings_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_file_attachments
    ADD CONSTRAINT session_file_attachments_account_id_workspace_id_file_id_fkey FOREIGN KEY (account_id, workspace_id, file_id) REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_file_attachments
    ADD CONSTRAINT session_file_attachments_workspace_id_session_id_fkey FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_oauth_pending_states
    ADD CONSTRAINT integration_oauth_pending_states_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_oauth_pending_states
    ADD CONSTRAINT integration_oauth_pending_states_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.scheduled_slack_bot_messages
    ADD CONSTRAINT scheduled_slack_bot_messages_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.scheduled_slack_bot_messages
    ADD CONSTRAINT scheduled_slack_bot_messages_connection_fk FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.slack_file_upload_operations
    ADD CONSTRAINT slack_file_upload_operations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.slack_file_upload_operations
    ADD CONSTRAINT slack_file_upload_operations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.slack_file_upload_operations
    ADD CONSTRAINT slack_file_upload_operations_interaction_fk FOREIGN KEY (account_id, workspace_id, interaction_id) REFERENCES slack_interactions(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.slack_file_upload_operations
    ADD CONSTRAINT slack_file_upload_operations_file_fk FOREIGN KEY (account_id, workspace_id, file_id) REFERENCES files(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_credential_providers
    ADD CONSTRAINT workspace_credential_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_credential_providers
    ADD CONSTRAINT workspace_credential_providers_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_webhooks
    ADD CONSTRAINT workspace_webhooks_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_webhooks
    ADD CONSTRAINT workspace_webhooks_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_webhook_deliveries
    ADD CONSTRAINT workspace_webhook_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_webhook_deliveries
    ADD CONSTRAINT workspace_webhook_deliveries_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_webhook_deliveries
    ADD CONSTRAINT workspace_webhook_deliveries_webhook_fk FOREIGN KEY (workspace_id, webhook_id) REFERENCES workspace_webhooks(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_credential_providers
    ADD CONSTRAINT organization_credential_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_webhooks
    ADD CONSTRAINT organization_webhooks_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_webhook_deliveries
    ADD CONSTRAINT organization_webhook_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_webhook_deliveries
    ADD CONSTRAINT organization_webhook_deliveries_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_webhook_deliveries
    ADD CONSTRAINT organization_webhook_deliveries_webhook_fk FOREIGN KEY (account_id, webhook_id) REFERENCES organization_webhooks(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_usage_allowances
    ADD CONSTRAINT workspace_usage_allowances_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_member_allowances
    ADD CONSTRAINT workspace_member_allowances_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_allowance_clear_receipts
    ADD CONSTRAINT workspace_allowance_clear_receipts_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_allowance_grants
    ADD CONSTRAINT workspace_allowance_grants_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_allowance_counters
    ADD CONSTRAINT workspace_allowance_counters_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_allowance_periods
    ADD CONSTRAINT workspace_allowance_periods_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_allowance_notifications
    ADD CONSTRAINT workspace_allowance_notifications_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.usage_allowance_attribution_receipts
    ADD CONSTRAINT usage_allowance_attribution_receip_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_video_allowance_allocations
    ADD CONSTRAINT workspace_video_allowance_allocati_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_video_allowance_allocations
    ADD CONSTRAINT workspace_video_allowance_allocations_debit_fk FOREIGN KEY (ledger_id) REFERENCES credit_ledger_entries(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.workspace_video_allowance_allocations
    ADD CONSTRAINT workspace_video_allowance_allocations_refund_fk FOREIGN KEY (reversed_by_ledger_id) REFERENCES credit_ledger_entries(id);

ALTER TABLE ONLY opengeni_private.session_import_batches
    ADD CONSTRAINT session_import_batches_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_import_batches
    ADD CONSTRAINT session_import_batches_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_import_batches
    ADD CONSTRAINT session_import_batches_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_import_batches
    ADD CONSTRAINT session_import_batches_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.session_import_batches
    ADD CONSTRAINT session_import_batches_workspace_id_session_id_fkey FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.organization_signup_use_cases
    ADD CONSTRAINT organization_signup_use_cases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_subscription_credentials
    ADD CONSTRAINT claude_subscription_credentials_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_subscription_credentials
    ADD CONSTRAINT claude_subscription_credentials_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY claude_subscription_credentials
    ADD CONSTRAINT claude_subscription_credentials_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_subscription_credentials
    ADD CONSTRAINT claude_subscription_credentials_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_rotation_settings
    ADD CONSTRAINT claude_rotation_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_rotation_settings
    ADD CONSTRAINT claude_rotation_settings_active_credential_fk FOREIGN KEY (account_id, active_credential_id) REFERENCES claude_subscription_credentials(account_id, id) ON DELETE SET NULL (active_credential_id);

ALTER TABLE ONLY claude_rotation_settings
    ADD CONSTRAINT claude_rotation_settings_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY claude_rotation_settings
    ADD CONSTRAINT claude_rotation_settings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_rotation_settings
    ADD CONSTRAINT claude_rotation_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_credential_fk FOREIGN KEY (account_id, credential_id) REFERENCES claude_subscription_credentials(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_last_credential_fk FOREIGN KEY (account_id, last_credential_id) REFERENCES claude_subscription_credentials(account_id, id) ON DELETE SET NULL (last_credential_id);

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_pinned_credential_fk FOREIGN KEY (account_id, pinned_credential_id) REFERENCES claude_subscription_credentials(account_id, id) ON DELETE SET NULL (pinned_credential_id);

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_goal_fk FOREIGN KEY (workspace_id, goal_id) REFERENCES session_goals(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_owner_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_turn_fk FOREIGN KEY (workspace_id, blocked_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_subscription_account_usage
    ADD CONSTRAINT claude_subscription_account_usage_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES claude_subscription_credentials(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_subscription_account_usage
    ADD CONSTRAINT claude_subscription_account_usage_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY claude_subscription_account_usage
    ADD CONSTRAINT claude_subscription_account_usage_account_fk FOREIGN KEY (account_id, credential_id) REFERENCES claude_subscription_credentials(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_api_key_workspaces
    ADD CONSTRAINT organization_api_key_workspaces_key_account_fk FOREIGN KEY (api_key_id, account_id) REFERENCES api_keys(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_api_key_workspaces
    ADD CONSTRAINT organization_api_key_workspaces_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY organization_service_accounts
    ADD CONSTRAINT organization_service_accounts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_service_account_fk FOREIGN KEY (service_account_id, account_id) REFERENCES organization_service_accounts(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_execution_context_turn_id_fkey FOREIGN KEY (execution_context_turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_execution_context_turn_id_fkey FOREIGN KEY (execution_context_turn_id) REFERENCES session_turns(id) DEFERRABLE;

ALTER TABLE ONLY opengeni_private.artifact_catalog_pins
    ADD CONSTRAINT artifact_catalog_pins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY credit_debit_allocations
    ADD CONSTRAINT credit_debit_allocations_debit_entry_id_account_id_fkey FOREIGN KEY (debit_entry_id, account_id) REFERENCES credit_ledger_entries(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY credit_debit_allocations
    ADD CONSTRAINT credit_debit_allocations_grant_entry_id_account_id_fkey FOREIGN KEY (grant_entry_id, account_id) REFERENCES credit_ledger_entries(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_codemode_calls
    ADD CONSTRAINT session_attempt_codemode_calls_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES connector_action_requests(id) DEFERRABLE;

ALTER TABLE ONLY session_attempt_codemode_calls
    ADD CONSTRAINT session_codemode_execution_catalog_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, execution_attempt_id, execution_attempt_generation, execution_catalog_digest) REFERENCES session_attempt_tool_catalogs(account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation, digest) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.organization_slack_bot_access
    ADD CONSTRAINT organization_slack_bot_access_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.organization_slack_bot_access
    ADD CONSTRAINT organization_slack_bot_access_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.organization_slack_bot_access
    ADD CONSTRAINT organization_slack_bot_access_home_workspace_id_fkey FOREIGN KEY (home_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.native_push_devices
    ADD CONSTRAINT native_push_devices_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY opengeni_private.native_push_deliveries
    ADD CONSTRAINT native_push_deliveries_auth_session_id_fkey FOREIGN KEY (auth_session_id) REFERENCES opengeni_private.native_push_devices(auth_session_id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_subscription_credentials
    ADD CONSTRAINT codex_credentials_subscription_resource_fk FOREIGN KEY (organization_user_resource_authority_id, account_id, owner_organization_membership_id, organization_user_resource_kind, id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id, resource_kind, resource_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ONLY claude_subscription_credentials
    ADD CONSTRAINT claude_credentials_subscription_resource_fk FOREIGN KEY (organization_user_resource_authority_id, account_id, owner_organization_membership_id, organization_user_resource_kind, id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id, resource_kind, resource_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ONLY xai_subscription_credentials
    ADD CONSTRAINT xai_credentials_subscription_resource_fk FOREIGN KEY (organization_user_resource_authority_id, account_id, owner_organization_membership_id, organization_user_resource_kind, id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id, resource_kind, resource_id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE ONLY subscription_connections
    ADD CONSTRAINT subscription_connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connections
    ADD CONSTRAINT subscription_connections_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY subscription_connections
    ADD CONSTRAINT subscription_connections_workspace_fk FOREIGN KEY (managed_by_workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE SET NULL (managed_by_workspace_id);

ALTER TABLE ONLY subscription_connections
    ADD CONSTRAINT subscription_connections_authority_fk FOREIGN KEY (authority_id, account_id, owner_organization_membership_id, authority_resource_kind, id) REFERENCES organization_user_resource_authorities(id, account_id, organization_membership_id, resource_kind, resource_id) ON DELETE RESTRICT;

ALTER TABLE ONLY subscription_connection_workspaces
    ADD CONSTRAINT subscription_connection_workspace_account_id_connection_id_fkey FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_workspaces
    ADD CONSTRAINT subscription_connection_workspaces_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_people
    ADD CONSTRAINT subscription_connection_people_account_id_connection_id_fkey FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_people
    ADD CONSTRAINT subscription_connection_peopl_organization_membership_id_a_fkey FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_aliases
    ADD CONSTRAINT subscription_connection_alias_account_id_provider_connecti_fkey FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_connection_quota
    ADD CONSTRAINT subscription_connection_quota_account_id_connection_id_fkey FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_person_preferences
    ADD CONSTRAINT subscription_person_preferenc_organization_membership_id_a_fkey FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_session_bindings
    ADD CONSTRAINT subscription_session_bindings_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_session_bindings
    ADD CONSTRAINT subscription_session_bindings_account_id_session_id_fkey FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY subscription_session_bindings
    ADD CONSTRAINT subscription_session_bindings_account_id_provider_connecti_fkey FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE SET NULL (connection_id);
