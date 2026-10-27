-- deployment-mode: rolling
-- Opengeni baseline part 6 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY host_mcp_delegations
    ADD CONSTRAINT host_mcp_delegations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY host_mcp_delegations
    ADD CONSTRAINT host_mcp_delegations_workspace_id_owner_subject_id_operatio_key UNIQUE (workspace_id, owner_subject_id, operation_id);

ALTER TABLE ONLY host_mcp_resolver_operations
    ADD CONSTRAINT host_mcp_resolver_operations_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY host_mcp_resolvers
    ADD CONSTRAINT host_mcp_resolvers_account_id_external_source_key UNIQUE (account_id, external_source);

ALTER TABLE ONLY host_mcp_resolvers
    ADD CONSTRAINT host_mcp_resolvers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY host_mcp_task_authorities
    ADD CONSTRAINT host_mcp_task_authorities_pkey PRIMARY KEY (task_id, task_authority_revision, server_id);

ALTER TABLE ONLY host_mcp_turn_authorities
    ADD CONSTRAINT host_mcp_turn_authorities_pkey PRIMARY KEY (turn_id, server_id);

ALTER TABLE ONLY image_generation_operations
    ADD CONSTRAINT image_generation_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY inbound_events
    ADD CONSTRAINT inbound_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_facet_binding_owners
    ADD CONSTRAINT integration_facet_binding_owners_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_facet_binding_owners
    ADD CONSTRAINT integration_facet_binding_owners_unique_uq UNIQUE (binding_id, owner_kind, owner_id);

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_installation_facet_key_uq UNIQUE (workspace_id, integration_facet_installation_id, facet_definition_id, binding_key);

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_facet_definitions
    ADD CONSTRAINT integration_facet_definitions_integration_facet_uq UNIQUE (integration_facet_id, facet_key);

ALTER TABLE ONLY integration_facet_definitions
    ADD CONSTRAINT integration_facet_definitions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_oauth_clients
    ADD CONSTRAINT integration_oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_oauth_pending_states
    ADD CONSTRAINT integration_oauth_pending_states_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_oauth_state_nonces
    ADD CONSTRAINT integration_oauth_state_nonces_pkey PRIMARY KEY (nonce);

ALTER TABLE ONLY integration_spec_revisions
    ADD CONSTRAINT integration_spec_revisions_facet_digest_uq UNIQUE (api_facet_id, spec_digest);

ALTER TABLE ONLY integration_spec_revisions
    ADD CONSTRAINT integration_spec_revisions_facet_revision_uq UNIQUE (api_facet_id, revision);

ALTER TABLE ONLY integration_spec_revisions
    ADD CONSTRAINT integration_spec_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integration_tools
    ADD CONSTRAINT integration_tools_facet_tool_uq UNIQUE (facet_id, tool_key);

ALTER TABLE ONLY integration_tools
    ADD CONSTRAINT integration_tools_pkey PRIMARY KEY (id);

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY interaction_operations
    ADD CONSTRAINT interaction_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY interaction_operations
    ADD CONSTRAINT interaction_operations_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY interaction_resource_operations
    ADD CONSTRAINT interaction_resource_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY interaction_resource_operations
    ADD CONSTRAINT interaction_resource_operations_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_claim_identity_uq UNIQUE (account_id, id, claim_id, scope_key);

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_natural_identity_uq UNIQUE (relation_type, from_claim_id, to_claim_id);

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_claim_revision_uq UNIQUE (claim_id, review_revision);

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_object_generation_uq UNIQUE (account_id, object_id, version_generation);

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_object_identity_uq UNIQUE (account_id, object_id, id);

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_object_ingestion_uq UNIQUE (object_id, ingestion_key);

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_object_operation_uq UNIQUE (object_id, operation_id);

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_natural_identity_uq UNIQUE (account_id, scope_key, entity_type, normalized_key);

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_scope_type_identity_uq UNIQUE (account_id, id, scope_key, entity_type);

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_natural_identity_uq UNIQUE (account_id, scope_key, entity_type, normalized_alias);

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_account_id_id_key UNIQUE (account_id, id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_legacy_claim_id_key UNIQUE (legacy_claim_id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_legacy_document_id_key UNIQUE (legacy_document_id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_legacy_document_version_id_key UNIQUE (legacy_document_version_id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_legacy_memory_id_key UNIQUE (legacy_memory_id);

ALTER TABLE ONLY knowledge_entries
    ADD CONSTRAINT knowledge_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_entry_decisions
    ADD CONSTRAINT knowledge_entry_decisions_account_id_entry_id_version_key UNIQUE (account_id, entry_id, version);

ALTER TABLE ONLY knowledge_entry_decisions
    ADD CONSTRAINT knowledge_entry_decisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_entry_links
    ADD CONSTRAINT knowledge_entry_links_pkey PRIMARY KEY (revision_id, ordinal);

ALTER TABLE ONLY knowledge_entry_operations
    ADD CONSTRAINT knowledge_entry_operations_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_account_id_entry_id_id_key UNIQUE (account_id, entry_id, id);

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_account_id_entry_id_number_key UNIQUE (account_id, entry_id, number);

ALTER TABLE ONLY knowledge_entry_revisions
    ADD CONSTRAINT knowledge_entry_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_entry_search
    ADD CONSTRAINT knowledge_entry_search_pkey PRIMARY KEY (account_id, entry_id, revision_id, chunk_index);

ALTER TABLE ONLY knowledge_entry_vectors
    ADD CONSTRAINT knowledge_entry_vectors_pkey PRIMARY KEY (account_id, entry_id, revision_id, generation, chunk_index);

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_natural_identity_uq UNIQUE (account_id, scope_key, subject_entity_id, predicate_key, object_hash);

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_index_jobs
    ADD CONSTRAINT knowledge_index_jobs_pkey PRIMARY KEY (revision_id);

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_pkey PRIMARY KEY (id);

ALTER TABLE knowledge_memories
    ADD CONSTRAINT knowledge_memories_text_codec_version_chk CHECK (((text_codec_version IS NULL) OR (text_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_operation_action_uq UNIQUE (workspace_id, operation_id, action);

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_memory_lifecycle_events
    ADD CONSTRAINT knowledge_memory_lifecycle_events_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_memory_relationships
    ADD CONSTRAINT knowledge_memory_relationships_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY knowledge_operation_receipts
    ADD CONSTRAINT knowledge_operation_receipts_operation_uq UNIQUE (account_id, operation_kind, operation_namespace, operation_id);

ALTER TABLE ONLY knowledge_operation_receipts
    ADD CONSTRAINT knowledge_operation_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_external_identity_uq UNIQUE (account_id, provider_key, external_tenant_id);

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_review_batches
    ADD CONSTRAINT knowledge_review_batches_account_id_id_key UNIQUE (account_id, id);

ALTER TABLE ONLY knowledge_review_batches
    ADD CONSTRAINT knowledge_review_batches_account_id_owner_key_turn_id_key UNIQUE (account_id, owner_key, turn_id);

ALTER TABLE ONLY knowledge_review_batches
    ADD CONSTRAINT knowledge_review_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_source_generation_uq UNIQUE (account_id, source_id, generation);

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_source_operation_uq UNIQUE (source_id, operation_id);

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_current_version_identity_uq UNIQUE (account_id, id, current_version_id);

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_external_identity_uq UNIQUE (source_id, external_object_id);

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_source_identity_uq UNIQUE (account_id, id, source_id, scope_key);

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_source_operation_uq UNIQUE (source_id, operation_id);

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_version_uq UNIQUE (knowledge_document_version_id);

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_identity_uq UNIQUE (scheduled_task_run_id, external_object_id);

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_source_sync_object_observations
    ADD CONSTRAINT knowledge_source_sync_object_observations_identity_uq UNIQUE (source_id, external_object_id);

ALTER TABLE ONLY knowledge_source_sync_states
    ADD CONSTRAINT knowledge_source_sync_states_pkey PRIMARY KEY (source_id);

ALTER TABLE ONLY knowledge_source_sync_states
    ADD CONSTRAINT knowledge_source_sync_states_task_uq UNIQUE (scheduled_task_id);

ALTER TABLE ONLY knowledge_source_sync_wakes
    ADD CONSTRAINT knowledge_source_sync_wakes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_source_sync_wakes
    ADD CONSTRAINT knowledge_source_sync_wakes_run_uq UNIQUE (scheduled_task_run_id);

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_current_acl_identity_uq UNIQUE (account_id, id, current_acl_generation);

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_external_identity_uq UNIQUE (provider_id, external_source_id);

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_scope_identity_uq UNIQUE (account_id, id, scope_key);

ALTER TABLE ONLY knowledge_sync_runs
    ADD CONSTRAINT knowledge_sync_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge_sync_runs
    ADD CONSTRAINT knowledge_sync_runs_source_operation_uq UNIQUE (source_id, operation_id);

ALTER TABLE ONLY machine_metrics_latest
    ADD CONSTRAINT machine_metrics_latest_pkey PRIMARY KEY (enrollment_id);

ALTER TABLE ONLY machine_metrics_series
    ADD CONSTRAINT machine_metrics_series_pkey PRIMARY KEY (id);

ALTER TABLE ONLY machine_removal_operations
    ADD CONSTRAINT machine_removal_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_accounts
    ADD CONSTRAINT managed_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_auth_actor_mutation_leases
    ADD CONSTRAINT managed_auth_actor_mutation_leases_pkey PRIMARY KEY (session_set_id, request_id);

ALTER TABLE ONLY managed_auth_browser_installations
    ADD CONSTRAINT managed_auth_browser_installations_authority_hash_key UNIQUE (authority_hash);

ALTER TABLE ONLY managed_auth_browser_installations
    ADD CONSTRAINT managed_auth_browser_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_auth_login_return_intents
    ADD CONSTRAINT managed_auth_login_return_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_id_set_unique UNIQUE (id, session_set_id);

ALTER TABLE ONLY managed_auth_login_slots
    ADD CONSTRAINT managed_auth_login_slots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_auth_login_transaction_rate_limits
    ADD CONSTRAINT managed_auth_login_transaction_rate_limits_pkey PRIMARY KEY (scope_kind, scope_hash);

ALTER TABLE ONLY managed_auth_login_transactions
    ADD CONSTRAINT managed_auth_login_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_auth_session_set_operations
    ADD CONSTRAINT managed_auth_session_set_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY managed_auth_session_sets
    ADD CONSTRAINT managed_auth_session_sets_authority_hash_key UNIQUE (authority_hash);

ALTER TABLE ONLY managed_auth_session_sets
    ADD CONSTRAINT managed_auth_session_sets_installation_id_key UNIQUE (installation_id);

ALTER TABLE ONLY managed_auth_session_sets
    ADD CONSTRAINT managed_auth_session_sets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY managed_sign_in_method_operations
    ADD CONSTRAINT managed_sign_in_method_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_route_id_key UNIQUE (route_id);

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_stream_uq UNIQUE (source_id, stream_key);

ALTER TABLE ONLY mcp_oauth_access_tokens
    ADD CONSTRAINT mcp_oauth_access_tokens_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY mcp_oauth_authorization_codes
    ADD CONSTRAINT mcp_oauth_authorization_codes_pkey PRIMARY KEY (code_hash);

ALTER TABLE ONLY mcp_oauth_authorization_requests
    ADD CONSTRAINT mcp_oauth_authorization_requests_pkey PRIMARY KEY (request_hash);

ALTER TABLE ONLY mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_pkey PRIMARY KEY (client_id);

ALTER TABLE ONLY mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_family_id_generation_key UNIQUE (family_id, generation);

ALTER TABLE ONLY mcp_oauth_refresh_tokens
    ADD CONSTRAINT mcp_oauth_refresh_tokens_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY mcp_operations
    ADD CONSTRAINT mcp_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY memory_slack_publication_configurations
    ADD CONSTRAINT memory_slack_publication_configurations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_slack_publication_configurations
    ADD CONSTRAINT memory_slack_publication_configurations_workspace_revision_uq UNIQUE (workspace_id, revision);

ALTER TABLE ONLY memory_slack_publication_receipts
    ADD CONSTRAINT memory_slack_publication_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_slack_publication_receipts
    ADD CONSTRAINT memory_slack_publication_receipts_sequence_uq UNIQUE (publication_id, sequence);

ALTER TABLE ONLY memory_slack_publications
    ADD CONSTRAINT memory_slack_publications_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY memory_slack_publications
    ADD CONSTRAINT memory_slack_publications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_slack_publications
    ADD CONSTRAINT memory_slack_publications_source_uq UNIQUE (workspace_id, source_idempotency_key);

ALTER TABLE ONLY model_call_fact_reconciliation_candidates
    ADD CONSTRAINT model_call_fact_reconciliation_candidates_pkey PRIMARY KEY (workspace_id, turn_id, source_key);

ALTER TABLE ONLY model_call_fact_reconciliation_progress
    ADD CONSTRAINT model_call_fact_reconciliation_progress_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY model_call_facts
    ADD CONSTRAINT model_call_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY nested_agent_depth_configuration
    ADD CONSTRAINT nested_agent_depth_configuration_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY network_routes
    ADD CONSTRAINT network_routes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY network_routes
    ADD CONSTRAINT network_routes_workspace_create_operation_uq UNIQUE (workspace_id, create_operation_id);

ALTER TABLE ONLY network_routes
    ADD CONSTRAINT network_routes_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY new_session_drafts
    ADD CONSTRAINT new_session_drafts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_agent_admin_access
    ADD CONSTRAINT organization_agent_admin_access_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_api_key_workspaces
    ADD CONSTRAINT organization_api_key_workspaces_pkey PRIMARY KEY (api_key_id, workspace_id);

ALTER TABLE ONLY organization_codex_rotation_settings
    ADD CONSTRAINT organization_codex_rotation_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_company_profile_agent_policies
    ADD CONSTRAINT organization_company_profile_agent_policies_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_company_profile_agent_policy_events
    ADD CONSTRAINT organization_company_profile_agent_policy_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_credential_providers
    ADD CONSTRAINT organization_credential_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_integration_policies
    ADD CONSTRAINT organization_integration_policies_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_integration_policy_operations
    ADD CONSTRAINT organization_integration_policy_operations_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY organization_invitation_binding_events
    ADD CONSTRAINT organization_invitation_binding_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_membership_invitations
    ADD CONSTRAINT organization_membership_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_membership_lifecycle_events
    ADD CONSTRAINT organization_membership_lifecycle_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_membership_operation_receipts
    ADD CONSTRAINT organization_membership_operation_receipts_pk PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY organization_memberships
    ADD CONSTRAINT organization_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_model_defaults
    ADD CONSTRAINT organization_model_defaults_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_model_provider_custom_models
    ADD CONSTRAINT organization_model_provider_c_account_id_provider_kind_crea_key UNIQUE (account_id, provider_kind, create_operation_id);

ALTER TABLE ONLY organization_model_provider_connection_operations
    ADD CONSTRAINT organization_model_provider_c_account_id_provider_kind_ope_key1 UNIQUE (account_id, provider_kind, operation_id);

ALTER TABLE ONLY organization_model_provider_connections
    ADD CONSTRAINT organization_model_provider_c_account_id_provider_kind_oper_key UNIQUE (account_id, provider_kind, operation_id);

ALTER TABLE ONLY organization_model_provider_connections
    ADD CONSTRAINT organization_model_provider_connec_account_id_provider_kind_key UNIQUE (account_id, provider_kind);

ALTER TABLE ONLY organization_model_provider_connection_operations
    ADD CONSTRAINT organization_model_provider_connection_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_model_provider_connections
    ADD CONSTRAINT organization_model_provider_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_model_provider_custom_models
    ADD CONSTRAINT organization_model_provider_custom_models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_plans
    ADD CONSTRAINT organization_plans_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_plans
    ADD CONSTRAINT organization_plans_stripe_subscription_id_key UNIQUE (stripe_subscription_id);

ALTER TABLE ONLY organization_privacy_preferences
    ADD CONSTRAINT organization_privacy_preferences_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_private_session_setting_events
    ADD CONSTRAINT organization_private_session_setting_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_private_session_settings
    ADD CONSTRAINT organization_private_session_settings_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_profile_events
    ADD CONSTRAINT organization_profile_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_evidence_unique UNIQUE (operation_id, canonical_identity_id, membership_authorization_revision, identity_revision, auth_revision, subject_revision, login_binding_revision);

ALTER TABLE ONLY organization_recovery_approvals
    ADD CONSTRAINT organization_recovery_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_notification_attempts
    ADD CONSTRAINT organization_recovery_attempts_delivery_phase_unique UNIQUE (outbox_id, delivery_id, phase);

ALTER TABLE ONLY organization_recovery_command_receipts
    ADD CONSTRAINT organization_recovery_command_receipts_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY organization_recovery_custodian_acceptances
    ADD CONSTRAINT organization_recovery_custodian_acceptances_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_id_policy_unique UNIQUE (id, policy_id);

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_policy_identity_unique UNIQUE (policy_id, canonical_identity_id);

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_policy_membership_unique UNIQUE (policy_id, membership_id);

ALTER TABLE ONLY organization_recovery_custodians
    ADD CONSTRAINT organization_recovery_custodians_policy_ordinal_unique UNIQUE (policy_id, ordinal);

ALTER TABLE ONLY organization_recovery_events
    ADD CONSTRAINT organization_recovery_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_notification_attempts
    ADD CONSTRAINT organization_recovery_notification_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_notification_outbox
    ADD CONSTRAINT organization_recovery_notification_outbox_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY organization_recovery_notification_outbox
    ADD CONSTRAINT organization_recovery_notification_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_id_account_unique UNIQUE (id, account_id);

ALTER TABLE ONLY organization_recovery_operations
    ADD CONSTRAINT organization_recovery_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_policies
    ADD CONSTRAINT organization_recovery_policies_account_revision_unique UNIQUE (account_id, revision);

ALTER TABLE ONLY organization_recovery_policies
    ADD CONSTRAINT organization_recovery_policies_id_account_unique UNIQUE (id, account_id);

ALTER TABLE ONLY organization_recovery_policies
    ADD CONSTRAINT organization_recovery_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_recovery_policy_heads
    ADD CONSTRAINT organization_recovery_policy_heads_current_policy_id_key UNIQUE (current_policy_id);

ALTER TABLE ONLY organization_recovery_policy_heads
    ADD CONSTRAINT organization_recovery_policy_heads_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_service_accounts
    ADD CONSTRAINT organization_service_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_shared_workspace_administration_capabilities
    ADD CONSTRAINT organization_shared_workspace_administration_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_id);

ALTER TABLE ONLY organization_user_resource_authorities
    ADD CONSTRAINT organization_user_resource_authorities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_user_resource_grants
    ADD CONSTRAINT organization_user_resource_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_user_retention_deletion_events
    ADD CONSTRAINT organization_user_retention_deletion_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_user_retention_deletions
    ADD CONSTRAINT organization_user_retention_deletions_pk PRIMARY KEY (account_id, membership_id);

ALTER TABLE ONLY organization_user_retention_object_deletion_receipts
    ADD CONSTRAINT organization_user_retention_object_deletion_receipts_pk PRIMARY KEY (account_id, membership_id, object_kind, source_id, object_bucket);

ALTER TABLE ONLY organization_user_retention_object_obligations
    ADD CONSTRAINT organization_user_retention_object_obligations_pk PRIMARY KEY (account_id, membership_id, object_kind, source_id, object_bucket);

ALTER TABLE ONLY organization_user_retention_policies
    ADD CONSTRAINT organization_user_retention_policies_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_id_account_uq UNIQUE (id, account_id);

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_invitation_uq UNIQUE (account_id, invitation_id);

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_user_setup_deliveries
    ADD CONSTRAINT organization_user_setup_deliveries_provider_key_key UNIQUE (provider_key);

ALTER TABLE ONLY organization_user_setup_delivery_attempts
    ADD CONSTRAINT organization_user_setup_delivery_attempts_number_uq UNIQUE (delivery_id, attempt_number);

ALTER TABLE ONLY organization_user_setup_delivery_attempts
    ADD CONSTRAINT organization_user_setup_delivery_attempts_operation_uq UNIQUE (delivery_id, operation_id);

ALTER TABLE ONLY organization_user_setup_delivery_attempts
    ADD CONSTRAINT organization_user_setup_delivery_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_user_setup_intents
    ADD CONSTRAINT organization_user_setup_intents_invitation_uq UNIQUE (account_id, invitation_id);

ALTER TABLE ONLY organization_user_setup_intents
    ADD CONSTRAINT organization_user_setup_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_user_setup_intents
    ADD CONSTRAINT organization_user_setup_intents_token_uq UNIQUE (token_digest);

ALTER TABLE ONLY organization_webhook_deliveries
    ADD CONSTRAINT organization_webhook_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_webhooks
    ADD CONSTRAINT organization_webhooks_account_id_uq UNIQUE (account_id, id);

ALTER TABLE ONLY organization_webhooks
    ADD CONSTRAINT organization_webhooks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_workspace_lifecycle_events
    ADD CONSTRAINT organization_workspace_lifecycle_events_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY organization_workspace_lifecycle_events
    ADD CONSTRAINT organization_workspace_lifecycle_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY organization_workspace_operation_receipts
    ADD CONSTRAINT organization_workspace_operation_receipts_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY personal_document_once_consumption_receipts
    ADD CONSTRAINT personal_document_once_consumption_receipts_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY personal_github_repository_selection_heads
    ADD CONSTRAINT personal_github_repository_selection_heads_pkey PRIMARY KEY (connection_id);

ALTER TABLE ONLY personal_github_repository_selection_heads
    ADD CONSTRAINT personal_github_repository_selection_heads_tenant_uq UNIQUE (account_id, origin_workspace_id, owner_subject_id, connection_id);

ALTER TABLE ONLY personal_github_repository_selection_operations
    ADD CONSTRAINT personal_github_repository_selection_operations_pkey PRIMARY KEY (connection_id, idempotency_key);

ALTER TABLE ONLY personal_github_repository_selections
    ADD CONSTRAINT personal_github_repository_selections_pkey PRIMARY KEY (connection_id, repository_id);

ALTER TABLE ONLY personal_resource_once_consumption_receipts
    ADD CONSTRAINT personal_resource_once_consumption_receipts_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_expiry_entry_id_key UNIQUE (expiry_entry_id);

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_grant_entry_id_key UNIQUE (grant_entry_id);

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY plan_credit_periods
    ADD CONSTRAINT plan_credit_periods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY pr_review_app_registrations
    ADD CONSTRAINT pr_review_app_registrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY pr_review_managed_github_authority_nonces
    ADD CONSTRAINT pr_review_managed_github_authority_nonces_pkey PRIMARY KEY (authority_nonce);

ALTER TABLE ONLY pr_review_managed_github_routes
    ADD CONSTRAINT pr_review_managed_github_routes_pkey PRIMARY KEY (binding_id);

ALTER TABLE ONLY pr_review_repository_bindings
    ADD CONSTRAINT pr_review_repository_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_preference_version_uq UNIQUE (preference_id, version);

ALTER TABLE ONLY preference_registry_preferences
    ADD CONSTRAINT preference_registry_preferences_account_id_uq UNIQUE (account_id, id);

ALTER TABLE ONLY preference_registry_preferences
    ADD CONSTRAINT preference_registry_preferences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY preference_registry_revisions
    ADD CONSTRAINT preference_registry_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY preference_registry_revisions
    ADD CONSTRAINT preference_registry_revisions_preference_id_uq UNIQUE (preference_id, id);

ALTER TABLE ONLY preference_registry_revisions
    ADD CONSTRAINT preference_registry_revisions_preference_revision_uq UNIQUE (preference_id, revision);

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_attempt_uq UNIQUE (account_id, workspace_id, attempt_id);

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY private_session_create_capabilities
    ADD CONSTRAINT private_session_create_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_id);

ALTER TABLE ONLY recording_chunks
    ADD CONSTRAINT recording_chunks_object_key_uq UNIQUE (object_key);

ALTER TABLE ONLY recording_chunks
    ADD CONSTRAINT recording_chunks_pkey PRIMARY KEY (recording_id, track_number, chunk_number);

ALTER TABLE ONLY recording_events
    ADD CONSTRAINT recording_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_live_segments
    ADD CONSTRAINT recording_live_segments_pkey PRIMARY KEY (recording_id, track_number, segment_number);

ALTER TABLE ONLY recording_notes
    ADD CONSTRAINT recording_notes_pkey PRIMARY KEY (recording_id, kind);

ALTER TABLE ONLY recording_people
    ADD CONSTRAINT recording_people_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_people
    ADD CONSTRAINT recording_people_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY recording_segment_edits
    ADD CONSTRAINT recording_segment_edits_pkey PRIMARY KEY (version_id, segment_index);

ALTER TABLE ONLY recording_speaker_assignments
    ADD CONSTRAINT recording_speaker_assignments_pkey PRIMARY KEY (version_id, speaker_label);

ALTER TABLE ONLY recording_speaker_voices
    ADD CONSTRAINT recording_speaker_voices_pkey PRIMARY KEY (version_id, speaker_label);

ALTER TABLE ONLY recording_tracks
    ADD CONSTRAINT recording_tracks_pkey PRIMARY KEY (recording_id, track_number);

ALTER TABLE ONLY recording_tracks
    ADD CONSTRAINT recording_tracks_workspace_uq UNIQUE (workspace_id, recording_id, track_number);

ALTER TABLE ONLY recording_transcript_segments
    ADD CONSTRAINT recording_transcript_segments_pkey PRIMARY KEY (version_id, segment_index);

ALTER TABLE ONLY recording_transcript_versions
    ADD CONSTRAINT recording_transcript_versions_number_uq UNIQUE (recording_id, version_number);

ALTER TABLE ONLY recording_transcript_versions
    ADD CONSTRAINT recording_transcript_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_transcript_versions
    ADD CONSTRAINT recording_transcript_versions_workspace_uq UNIQUE (workspace_id, recording_id, id);

ALTER TABLE ONLY recording_voice_rejections
    ADD CONSTRAINT recording_voice_rejections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recording_voiceprints
    ADD CONSTRAINT recording_voiceprints_pkey PRIMARY KEY (workspace_id, person_id, channel, model);

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY remember_knowledge_confirmation_receipts
    ADD CONSTRAINT remember_knowledge_confirmation_r_workspace_id_operation_id_key UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY remember_knowledge_confirmation_receipts
    ADD CONSTRAINT remember_knowledge_confirmation_receipts_claim_id_key UNIQUE (claim_id);

ALTER TABLE ONLY remember_knowledge_confirmation_receipts
    ADD CONSTRAINT remember_knowledge_confirmation_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_materializations_memory_uq UNIQUE (workspace_id, memory_id);

ALTER TABLE ONLY remember_knowledge_memory_materializations
    ADD CONSTRAINT remember_knowledge_memory_materializations_pkey PRIMARY KEY (confirmation_receipt_id);

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_settlement_key_uq UNIQUE (settlement_key);

ALTER TABLE rig_changes
    ADD CONSTRAINT rig_changes_payload_codec_version_chk CHECK (((payload_codec_version IS NULL) OR (payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY rig_changes
    ADD CONSTRAINT rig_changes_pkey PRIMARY KEY (id);

ALTER TABLE rig_changes
    ADD CONSTRAINT rig_changes_verification_codec_version_chk CHECK (((verification_codec_version IS NULL) OR (verification_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY rig_versions
    ADD CONSTRAINT rig_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rigs
    ADD CONSTRAINT rigs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_checkpoint_artifacts
    ADD CONSTRAINT sandbox_checkpoint_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_lease_holders
    ADD CONSTRAINT sandbox_lease_holders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_leases
    ADD CONSTRAINT sandbox_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_pty_sessions
    ADD CONSTRAINT sandbox_pty_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_retained_processes
    ADD CONSTRAINT sandbox_retained_processes_pkey PRIMARY KEY (id);

ALTER TABLE sandbox_session_envelopes
    ADD CONSTRAINT sandbox_session_envelopes_codec_version_chk CHECK (((envelope_codec_version IS NULL) OR (envelope_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY sandbox_session_envelopes
    ADD CONSTRAINT sandbox_session_envelopes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandboxes
    ADD CONSTRAINT sandboxes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_reusable_connection_source_uq UNIQUE (task_id, source_task_authority_revision, source_execution_digest);

ALTER TABLE ONLY scheduled_task_blocker_reviews
    ADD CONSTRAINT scheduled_task_blocker_reviews_pkey PRIMARY KEY (task_id);

ALTER TABLE ONLY scheduled_task_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_connection_authority_snapshots_pkey PRIMARY KEY (task_id, task_authority_revision, server_id);

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_event_uq UNIQUE (task_id, event_id);

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY scheduled_task_event_occurrences
    ADD CONSTRAINT scheduled_task_event_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY scheduled_task_event_settings
    ADD CONSTRAINT scheduled_task_event_settings_pkey PRIMARY KEY (task_id);

ALTER TABLE ONLY scheduled_task_personal_resource_authorities
    ADD CONSTRAINT scheduled_task_personal_resource_authorities_pk PRIMARY KEY (task_id, task_authority_revision);

ALTER TABLE ONLY scheduled_task_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_personal_resource_snapshots_pk PRIMARY KEY (task_id, task_authority_revision, resource_kind, resource_id);

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations
    ADD CONSTRAINT scheduled_task_reusable_connection_materializations_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY scheduled_task_revision_authorities
    ADD CONSTRAINT scheduled_task_revision_authorities_pk PRIMARY KEY (task_id, task_authority_revision);

ALTER TABLE scheduled_task_runs
    ADD CONSTRAINT scheduled_task_run_accepted_execution_required_chk CHECK (((action_kind <> 'agent_turn'::text) OR (status <> ALL (ARRAY['queued'::text, 'dispatched'::text])) OR (accepted_execution_snapshot IS NOT NULL))) NOT VALID;

ALTER TABLE ONLY scheduled_task_run_connection_authority_snapshots
    ADD CONSTRAINT scheduled_task_run_connection_authority_snapshots_pkey PRIMARY KEY (run_id, server_id);

ALTER TABLE ONLY scheduled_task_run_personal_resource_admissions
    ADD CONSTRAINT scheduled_task_run_personal_resource_admissions_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY scheduled_task_run_personal_resource_once_receipts
    ADD CONSTRAINT scheduled_task_run_personal_resource_once_receipts_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY scheduled_task_run_personal_resource_snapshots
    ADD CONSTRAINT scheduled_task_run_personal_resource_snapshots_pk PRIMARY KEY (run_id, resource_kind, resource_id);

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY scheduled_task_schedule_outbox
    ADD CONSTRAINT scheduled_task_schedule_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY scheduled_task_schedule_outbox
    ADD CONSTRAINT scheduled_task_schedule_outbox_task_id_key UNIQUE (task_id);

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY secret_approval_rules
    ADD CONSTRAINT secret_approval_rules_pkey PRIMARY KEY (account_id, item_id, field_key);

ALTER TABLE ONLY secret_use_approvals
    ADD CONSTRAINT secret_use_approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup__organization_membership_id_key UNIQUE (organization_membership_id);

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_recei_personal_workspace_id_key UNIQUE (personal_workspace_id);

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_receipts_account_id_key UNIQUE (account_id);

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_receipts_operation_id_key UNIQUE (operation_id);

ALTER TABLE ONLY self_service_organization_setup_receipts
    ADD CONSTRAINT self_service_organization_setup_receipts_pkey PRIMARY KEY (auth_user_id);

ALTER TABLE ONLY session_admin_access
    ADD CONSTRAINT session_admin_access_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY session_attempt_codemode_calls
    ADD CONSTRAINT session_attempt_codemode_calls_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY session_attempt_connected_machine_authorizations
    ADD CONSTRAINT session_attempt_connected_machine_authorizations_pkey PRIMARY KEY (attempt_id, enrollment_id);

ALTER TABLE ONLY session_attempt_interruptions
    ADD CONSTRAINT session_attempt_interruptions_operation_attempt_uq UNIQUE (operation_id, attempt_id);

ALTER TABLE ONLY session_attempt_interruptions
    ADD CONSTRAINT session_attempt_interruptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_attempt_machine_consents
    ADD CONSTRAINT session_attempt_machine_consents_pkey PRIMARY KEY (attempt_id, consent_id);

ALTER TABLE session_attempt_model_context_snapshots
    ADD CONSTRAINT session_attempt_model_context_snapshots_content_refs_check CHECK (((content_refs IS NULL) OR ((jsonb_typeof(content_refs) = 'object'::text) AND (((content_refs ->> 'v'::text))::integer = 1)))) NOT VALID;

ALTER TABLE ONLY session_attempt_model_context_snapshots
    ADD CONSTRAINT session_attempt_model_context_snapshots_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY session_attempt_personal_document_admissions
    ADD CONSTRAINT session_attempt_personal_document_admissions_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY session_attempt_personal_document_snapshots
    ADD CONSTRAINT session_attempt_personal_document_snapshots_pk PRIMARY KEY (attempt_id, document_id);

ALTER TABLE ONLY session_attempt_personal_resource_admissions
    ADD CONSTRAINT session_attempt_personal_resource_admissions_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY session_attempt_personal_resource_snapshots
    ADD CONSTRAINT session_attempt_personal_resource_snapshots_pk PRIMARY KEY (attempt_id, resource_kind, resource_id);

ALTER TABLE session_attempt_tool_catalogs
    ADD CONSTRAINT session_attempt_tool_catalogs_content_refs_check CHECK (((content_refs IS NULL) OR ((jsonb_typeof(content_refs) = 'object'::text) AND (((content_refs ->> 'v'::text))::integer = 1) AND (jsonb_typeof((content_refs -> 'entries'::text)) = 'array'::text) AND (jsonb_array_length((catalog -> 'entries'::text)) = 0)))) NOT VALID;

ALTER TABLE ONLY session_attempt_tool_catalogs
    ADD CONSTRAINT session_attempt_tool_catalogs_pkey PRIMARY KEY (attempt_id);

ALTER TABLE ONLY session_background_commands
    ADD CONSTRAINT session_background_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_command_receipts
    ADD CONSTRAINT session_command_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_content_blobs
    ADD CONSTRAINT session_content_blobs_pkey PRIMARY KEY (workspace_id, session_id, digest);

ALTER TABLE ONLY session_create_idempotency_guard
    ADD CONSTRAINT session_create_idempotency_guard_pk PRIMARY KEY (workspace_id, idempotency_key);

ALTER TABLE ONLY session_event_cursors
    ADD CONSTRAINT session_event_cursors_pkey PRIMARY KEY (session_id);

ALTER TABLE session_events
    ADD CONSTRAINT session_events_payload_codec_version_chk CHECK (((payload_codec_version IS NULL) OR (payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_pkey PRIMARY KEY (id);
