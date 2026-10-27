-- deployment-mode: rolling
-- Opengeni baseline part 8 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE INDEX auth_sessions_user_id_idx ON auth_sessions USING btree (user_id);

CREATE UNIQUE INDEX auth_users_email_idx ON auth_users USING btree (lower(email));

CREATE INDEX auth_verifications_identifier_idx ON auth_verifications USING btree (identifier);

CREATE UNIQUE INDEX automation_run_event_links_event_trigger_uq ON automation_run_event_links USING btree (event_id, trigger_id);

CREATE UNIQUE INDEX automation_runs_trigger_occurrence_uq ON automation_runs USING btree (trigger_id, occurrence_key);

CREATE INDEX automation_runs_workspace_status_idx ON automation_runs USING btree (workspace_id, status, created_at);

CREATE UNIQUE INDEX automation_runs_workspace_trigger_id_uq ON automation_runs USING btree (workspace_id, trigger_id, id);

CREATE UNIQUE INDEX automation_sources_endpoint_uq ON automation_sources USING btree (endpoint_id);

CREATE UNIQUE INDEX automation_sources_workspace_id_uq ON automation_sources USING btree (workspace_id, id);

CREATE INDEX automation_sources_workspace_status_idx ON automation_sources USING btree (workspace_id, status);

CREATE INDEX automation_templates_workspace_idx ON automation_templates USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX automation_trigger_events_source_delivery_uq ON automation_trigger_events USING btree (source_id, delivery_key);

CREATE INDEX automation_trigger_events_workspace_created_idx ON automation_trigger_events USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX automation_trigger_events_workspace_source_id_uq ON automation_trigger_events USING btree (workspace_id, source_id, id);

CREATE UNIQUE INDEX automation_triggers_workspace_id_uq ON automation_triggers USING btree (workspace_id, id);

CREATE UNIQUE INDEX automation_triggers_workspace_source_id_uq ON automation_triggers USING btree (workspace_id, id, source_id);

CREATE INDEX automation_triggers_workspace_status_idx ON automation_triggers USING btree (workspace_id, status);

CREATE UNIQUE INDEX billing_customers_account_provider_idx ON billing_customers USING btree (account_id, provider);

CREATE UNIQUE INDEX billing_customers_provider_customer_idx ON billing_customers USING btree (provider, provider_customer_id);

CREATE UNIQUE INDEX billing_subscription_operations_pending_idx ON billing_subscription_operations USING btree (account_id) WHERE (completed_at IS NULL);

CREATE UNIQUE INDEX browser_identities_workspace_active_name_uq ON browser_identities USING btree (workspace_id, lower(name)) WHERE (status = 'active'::text);

CREATE INDEX browser_identities_workspace_status_updated_idx ON browser_identities USING btree (workspace_id, status, updated_at, id);

CREATE INDEX browser_revision_components_revision_idx ON browser_revision_components USING btree (workspace_id, revision_id, "position");

CREATE INDEX browser_revisions_identity_history_idx ON browser_revisions USING btree (workspace_id, identity_id, ordinal);

CREATE INDEX browser_session_associations_resource_idx ON browser_session_associations USING btree (workspace_id, browser_session_id, last_used_at);

CREATE INDEX browser_session_associations_workspace_session_idx ON browser_session_associations USING btree (workspace_id, session_id, last_used_at);

CREATE INDEX browser_session_retained_downloads_file_idx ON browser_session_retained_downloads USING btree (account_id, workspace_id, file_id);

CREATE INDEX browser_sessions_controller_host_sandbox_group_idx ON browser_sessions USING btree (workspace_id, controller_host_sandbox_group_id, lifecycle);

CREATE INDEX browser_sessions_device_workspace_idx ON browser_sessions USING btree (device_workspace_id, device_id, lifecycle) WHERE (device_id IS NOT NULL);

CREATE INDEX browser_sessions_sandbox_group_idx ON browser_sessions USING btree (workspace_id, sandbox_group_id, lifecycle);

CREATE INDEX browser_sessions_suspended_controller_idx ON browser_sessions USING btree (updated_at, id) WHERE ((lifecycle = 'suspended'::text) AND (controller_generation IS NOT NULL));

CREATE INDEX browser_sessions_workspace_lifecycle_idx ON browser_sessions USING btree (workspace_id, lifecycle, last_used_at, id);

CREATE INDEX browser_sessions_workspace_network_route_idx ON browser_sessions USING btree (workspace_id, network_route_id, lifecycle);

CREATE INDEX browser_state_artifacts_gc_idx ON browser_state_artifacts USING btree (state, retained_until, delete_claimed_at, created_at);

CREATE INDEX browser_state_artifacts_source_idx ON browser_state_artifacts USING btree (workspace_id, source_browser_session_id, created_at);

CREATE INDEX browser_state_uploads_gc_idx ON browser_state_uploads USING btree (state, cleanup_after, delete_claimed_at, created_at);

CREATE INDEX canonical_human_identity_operations_identity_created_idx ON canonical_human_identity_operations USING btree (identity_id, created_at, operation_id);

CREATE INDEX canonical_human_identity_subjects_identity_idx ON canonical_human_identity_subjects USING btree (identity_id, status);

CREATE INDEX canonical_human_login_bindings_identity_status_idx ON canonical_human_login_bindings USING btree (identity_id, status, created_at, id);

CREATE UNIQUE INDEX canonical_human_login_bindings_provider_account_idx ON canonical_human_login_bindings USING btree (provider_id, provider_account_id);

CREATE UNIQUE INDEX capability_catalog_items_global_capability_idx ON capability_catalog_items USING btree (id) WHERE (workspace_id IS NULL);

CREATE INDEX capability_catalog_items_import_batch_idx ON capability_catalog_items USING btree (import_batch_id);

CREATE INDEX capability_catalog_items_provider_domain_idx ON capability_catalog_items USING btree (provider_domain);

CREATE UNIQUE INDEX capability_catalog_items_registry_surface_idx ON capability_catalog_items USING btree (source, provider_domain, mcp_url);

CREATE INDEX capability_catalog_items_source_stale_idx ON capability_catalog_items USING btree (source, stale);

CREATE UNIQUE INDEX capability_catalog_items_workspace_capability_idx ON capability_catalog_items USING btree (workspace_id, id);

CREATE INDEX capability_catalog_items_workspace_category_idx ON capability_catalog_items USING btree (workspace_id, category);

CREATE INDEX capability_catalog_items_workspace_kind_idx ON capability_catalog_items USING btree (workspace_id, kind);

CREATE INDEX capability_catalog_items_workspace_source_idx ON capability_catalog_items USING btree (workspace_id, source);

CREATE INDEX capability_component_owners_workspace_owner_idx ON capability_component_owners USING btree (workspace_id, owner_kind, owner_id);

CREATE INDEX capability_facet_installations_workspace_status_idx ON capability_facet_installations USING btree (workspace_id, status);

CREATE INDEX capability_facets_version_kind_idx ON capability_facets USING btree (plugin_version_id, kind);

CREATE UNIQUE INDEX capability_installations_workspace_capability_idx ON capability_installations USING btree (workspace_id, capability_id);

CREATE INDEX capability_installations_workspace_kind_idx ON capability_installations USING btree (workspace_id, kind);

CREATE INDEX capability_installations_workspace_status_idx ON capability_installations USING btree (workspace_id, status);

CREATE INDEX capability_mcp_facets_server_idx ON capability_mcp_facets USING btree (server_id);

CREATE INDEX capability_operations_workspace_status_idx ON capability_operations USING btree (workspace_id, status, updated_at);

CREATE INDEX capability_plugin_installations_workspace_status_idx ON capability_plugin_installations USING btree (workspace_id, status);

CREATE UNIQUE INDEX capability_plugins_global_key_idx ON capability_plugins USING btree (plugin_key) WHERE (workspace_id IS NULL);

CREATE INDEX capability_plugins_scope_idx ON capability_plugins USING btree (workspace_id, category);

CREATE UNIQUE INDEX capability_plugins_workspace_key_idx ON capability_plugins USING btree (workspace_id, plugin_key);

CREATE INDEX capability_skill_facets_content_idx ON capability_skill_facets USING btree (content_sha256);

CREATE UNIQUE INDEX channels_workspace_id_uq ON channels USING btree (workspace_id, id);

CREATE UNIQUE INDEX channels_workspace_name_idx ON channels USING btree (workspace_id, lower(name));

CREATE INDEX channels_workspace_pinned_name_idx ON channels USING btree (workspace_id, pinned DESC, name, id);

CREATE INDEX channels_workspace_pinned_order_idx ON channels USING btree (workspace_id, pinned DESC, sort_order, id);

CREATE INDEX claude_capacity_waiters_pending_idx ON claude_capacity_waiters USING btree (workspace_id, status, next_check_at);

CREATE INDEX claude_capacity_waiters_wake_repair_idx ON claude_capacity_waiters USING btree (status, wake_revision, observed_wake_revision);

CREATE UNIQUE INDEX claude_capacity_waiters_workspace_session_uq ON claude_capacity_waiters USING btree (workspace_id, session_id, authority_scope, owner_organization_membership_id) NULLS NOT DISTINCT;

CREATE INDEX claude_credential_leases_active_credential_idx ON claude_credential_leases USING btree (workspace_id, credential_id, leased_until);

CREATE INDEX claude_credential_leases_expiry_idx ON claude_credential_leases USING btree (leased_until);

CREATE UNIQUE INDEX claude_credential_leases_workspace_turn_uq ON claude_credential_leases USING btree (workspace_id, turn_id);

CREATE UNIQUE INDEX claude_rotation_settings_workspace_pool_uq ON claude_rotation_settings USING btree (account_id, workspace_id, authority_scope, owner_organization_membership_id) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX claude_session_account_pins_workspace_session_uq ON claude_session_account_pins USING btree (workspace_id, session_id, authority_scope, owner_organization_membership_id) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX claude_subscription_credentials_account_identity_uq ON claude_subscription_credentials USING btree (account_id, id);

CREATE UNIQUE INDEX claude_subscription_credentials_provider_identity_uq ON claude_subscription_credentials USING btree (account_id, workspace_id, authority_scope, owner_organization_membership_id, provider_account_id) NULLS NOT DISTINCT WHERE (provider_account_id IS NOT NULL);

CREATE UNIQUE INDEX claude_subscription_credentials_workspace_account_id_uq ON claude_subscription_credentials USING btree (workspace_id, account_id, id);

CREATE UNIQUE INDEX claude_subscription_credentials_workspace_id_uq ON claude_subscription_credentials USING btree (workspace_id, id);

CREATE INDEX claude_subscription_credentials_workspace_status_idx ON claude_subscription_credentials USING btree (workspace_id, status, allocator_enabled);

CREATE UNIQUE INDEX codex_apps_settings_workspace_idx ON codex_apps_settings USING btree (workspace_id);

CREATE INDEX codex_capacity_waiters_pending_idx ON codex_capacity_waiters USING btree (workspace_id, status, next_check_at);

CREATE INDEX codex_capacity_waiters_wake_repair_idx ON codex_capacity_waiters USING btree (status, wake_revision, observed_wake_revision);

CREATE UNIQUE INDEX codex_capacity_waiters_workspace_id_idx ON codex_capacity_waiters USING btree (workspace_id, id);

CREATE UNIQUE INDEX codex_capacity_waiters_workspace_session_idx ON codex_capacity_waiters USING btree (workspace_id, session_id);

CREATE INDEX codex_credential_leases_active_credential_idx ON codex_credential_leases USING btree (credential_id, leased_until);

CREATE INDEX codex_credential_leases_expiry_idx ON codex_credential_leases USING btree (leased_until);

CREATE UNIQUE INDEX codex_credential_leases_workspace_turn_idx ON codex_credential_leases USING btree (workspace_id, turn_id);

CREATE INDEX codex_reset_redemption_claim_expiry_idx ON codex_reset_redemption_attempts USING btree (claim_expires_at) WHERE (status <> 'completed'::text);

CREATE UNIQUE INDEX codex_reset_redemption_credential_credit_idx ON codex_reset_redemption_attempts USING btree (workspace_id, credential_id, credit_id) WHERE ((status <> 'completed'::text) OR (outcome = ANY (ARRAY['reset'::text, 'alreadyRedeemed'::text])));

CREATE UNIQUE INDEX codex_reset_redemption_upstream_key_idx ON codex_reset_redemption_attempts USING btree (upstream_idempotency_key);

CREATE INDEX codex_reset_redemption_workspace_credential_idx ON codex_reset_redemption_attempts USING btree (workspace_id, credential_id, created_at DESC);

CREATE UNIQUE INDEX codex_rotation_settings_workspace_idx ON codex_rotation_settings USING btree (workspace_id);

CREATE UNIQUE INDEX codex_subscription_credentials_account_id_idx ON codex_subscription_credentials USING btree (account_id, id);

CREATE UNIQUE INDEX codex_subscription_credentials_organization_account_idx ON codex_subscription_credentials USING btree (organization_id, chatgpt_account_id) WHERE ((authority_scope = 'organization'::text) AND (chatgpt_account_id IS NOT NULL));

CREATE INDEX codex_subscription_credentials_organization_lookup_idx ON codex_subscription_credentials USING btree (organization_id, created_at, id) WHERE (authority_scope = 'organization'::text);

CREATE UNIQUE INDEX codex_subscription_credentials_workspace_account_id_idx ON codex_subscription_credentials USING btree (workspace_id, account_id, id);

CREATE UNIQUE INDEX codex_subscription_credentials_workspace_id_idx ON codex_subscription_credentials USING btree (workspace_id, id);

CREATE INDEX codex_subscription_credentials_workspace_lookup_idx ON codex_subscription_credentials USING btree (workspace_id);

CREATE UNIQUE INDEX codex_subscription_credentials_ws_account_idx ON codex_subscription_credentials USING btree (workspace_id, chatgpt_account_id) WHERE (chatgpt_account_id IS NOT NULL);

CREATE UNIQUE INDEX company_brain_context_selection_turn_uq ON company_brain_context_selection_receipts USING btree (workspace_id, turn_id);

CREATE INDEX company_brain_context_selection_workspace_time_idx ON company_brain_context_selection_receipts USING btree (workspace_id, created_at, id);

CREATE UNIQUE INDEX company_brain_turn_context_snapshot_turn_uq ON company_brain_turn_context_snapshots USING btree (workspace_id, turn_id);

CREATE UNIQUE INDEX company_brain_turn_context_snapshot_workspace_id_uq ON company_brain_turn_context_snapshots USING btree (workspace_id, id);

CREATE UNIQUE INDEX company_profile_agent_automatic_activations_account_operation_u ON company_profile_agent_automatic_activation_receipts USING btree (account_id, operation_id);

CREATE UNIQUE INDEX company_profile_agent_automatic_activations_event_uq ON company_profile_agent_automatic_activation_receipts USING btree (account_id, activation_event_id);

CREATE UNIQUE INDEX company_profile_agent_automatic_activations_proposal_uq ON company_profile_agent_automatic_activation_receipts USING btree (account_id, proposal_receipt_id);

CREATE INDEX company_profile_agent_automatic_activations_turn_idx ON company_profile_agent_automatic_activation_receipts USING btree (workspace_id, session_id, turn_id, execution_generation);

CREATE UNIQUE INDEX company_profile_agent_confirmations_account_operation_uq ON company_profile_agent_confirmation_receipts USING btree (account_id, operation_id);

CREATE UNIQUE INDEX company_profile_agent_confirmations_event_uq ON company_profile_agent_confirmation_receipts USING btree (account_id, activation_event_id);

CREATE UNIQUE INDEX company_profile_agent_confirmations_proposal_uq ON company_profile_agent_confirmation_receipts USING btree (account_id, proposal_receipt_id);

CREATE UNIQUE INDEX company_profile_agent_proposals_account_operation_uq ON company_profile_agent_proposal_receipts USING btree (account_id, operation_id);

CREATE UNIQUE INDEX company_profile_agent_proposals_account_revision_uq ON company_profile_agent_proposal_receipts USING btree (account_id, revision_id);

CREATE INDEX company_profile_agent_proposals_turn_idx ON company_profile_agent_proposal_receipts USING btree (workspace_id, session_id, turn_id, execution_generation);

CREATE INDEX company_profile_events_account_time_idx ON company_profile_activation_events USING btree (account_id, created_at DESC, id);

CREATE INDEX company_profile_revisions_account_history_idx ON company_profile_revisions USING btree (account_id, revision DESC);

CREATE INDEX company_profile_snapshots_workspace_time_idx ON company_profile_snapshots USING btree (workspace_id, created_at DESC, id);

CREATE UNIQUE INDEX composer_drafts_subject_session_uq ON composer_drafts USING btree (workspace_id, session_id, subject_id);

CREATE INDEX computer_session_associations_resource_idx ON computer_session_associations USING btree (workspace_id, computer_session_id, last_used_at);

CREATE INDEX computer_session_associations_workspace_session_idx ON computer_session_associations USING btree (workspace_id, session_id, last_used_at);

CREATE INDEX computer_sessions_device_workspace_idx ON computer_sessions USING btree (device_workspace_id, device_id, lifecycle) WHERE (device_id IS NOT NULL);

CREATE INDEX computer_sessions_sandbox_group_idx ON computer_sessions USING btree (workspace_id, sandbox_group_id, lifecycle);

CREATE INDEX computer_sessions_workspace_lifecycle_idx ON computer_sessions USING btree (workspace_id, lifecycle, last_used_at, id);

CREATE UNIQUE INDEX connect_attempts_actor_idempotency_idx ON connect_attempts USING btree (workspace_id, subject_id, idempotency_key_hash);

CREATE INDEX connect_attempts_actor_pending_idx ON connect_attempts USING btree (workspace_id, subject_id, created_at DESC, id DESC) WHERE ((projection ->> 'state'::text) <> ALL (ARRAY['complete'::text, 'cancelled'::text, 'expired'::text]));

CREATE INDEX connect_attempts_expiry_idx ON connect_attempts USING btree (expires_at, id);

CREATE INDEX connection_use_audit_attempt_idx ON connection_use_audit_facts USING btree (workspace_id, attempt_id, occurred_at);

CREATE UNIQUE INDEX connections_authority_identity_uq ON connections USING btree (account_id, authority_id) WHERE (authority_id IS NOT NULL);

CREATE UNIQUE INDEX connections_create_operation_uq ON connections USING btree (workspace_id, created_by_subject_id, create_operation_id) WHERE (create_operation_id IS NOT NULL);

CREATE INDEX connections_owner_authority_idx ON connections USING btree (account_id, owner_organization_membership_id, status, updated_at, id) WHERE (authority_scope = 'user'::text);

CREATE INDEX connections_workspace_expires_idx ON connections USING btree (workspace_id, expires_at);

CREATE INDEX connections_workspace_kind_idx ON connections USING btree (workspace_id, kind);

CREATE INDEX connections_workspace_provider_status_idx ON connections USING btree (workspace_id, provider_domain, status);

CREATE INDEX connections_workspace_subject_provider_idx ON connections USING btree (workspace_id, subject_id, provider_domain);

CREATE INDEX connector_action_policies_workspace_connection_idx ON connector_action_policies USING btree (workspace_id, connection_id, server_id);

CREATE INDEX connector_action_requests_attempt_status_idx ON connector_action_requests USING btree (workspace_id, creation_attempt_id, status);

CREATE INDEX connector_action_requests_session_created_idx ON connector_action_requests USING btree (workspace_id, session_id, created_at DESC, id DESC);

CREATE INDEX credit_debit_allocations_grant_idx ON credit_debit_allocations USING btree (account_id, grant_entry_id);

CREATE INDEX credit_ledger_entries_account_created_idx ON credit_ledger_entries USING btree (account_id, created_at);

CREATE UNIQUE INDEX credit_ledger_entries_id_account_idx ON credit_ledger_entries USING btree (id, account_id);

CREATE UNIQUE INDEX credit_ledger_entries_idempotency_idx ON credit_ledger_entries USING btree (idempotency_key);

CREATE INDEX credit_ledger_entries_model_debit_period_idx ON credit_ledger_entries USING btree (account_id, occurred_at, workspace_id) WHERE ((type = 'model_usage_debit'::text) AND (source_type = 'model_response'::text) AND (amount_micros < 0));

CREATE INDEX credit_ledger_scoped_grants_idx ON credit_ledger_entries USING btree (account_id, created_at, id) WHERE (eligible_model_ids IS NOT NULL);

CREATE INDEX credit_ledger_site_occurred_idx ON credit_ledger_entries USING btree (workspace_id, site_id, occurred_at) WHERE ((site_id IS NOT NULL) AND (type = 'model_usage_debit'::text) AND (amount_micros < 0));

CREATE UNIQUE INDEX device_enrollment_requests_device_code_idx ON device_enrollment_requests USING btree (device_code);

CREATE INDEX device_enrollment_requests_expires_idx ON device_enrollment_requests USING btree (expires_at);

CREATE UNIQUE INDEX device_enrollment_requests_user_code_pending_idx ON device_enrollment_requests USING btree (user_code) WHERE (status = 'pending'::text);

CREATE INDEX device_enrollment_requests_workspace_created_idx ON device_enrollment_requests USING btree (workspace_id, created_at);

CREATE INDEX document_authority_reclassifications_document_idx ON document_authority_reclassifications USING btree (account_id, request_workspace_id, document_id, created_at, operation_id);

CREATE INDEX document_bases_workspace_created_idx ON document_bases USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX document_bases_workspace_default_name_uq ON document_bases USING btree (workspace_id) WHERE (lower(btrim(name)) = 'default'::text);

CREATE INDEX document_chunks_authority_idx ON document_chunks USING btree (account_id, authority_kind, authority_workspace_id, authority_subject_id);

CREATE INDEX document_chunks_text_fts_idx ON document_chunks USING gin (to_tsvector('simple'::regconfig, text));

CREATE INDEX document_chunks_workspace_base_idx ON document_chunks USING btree (workspace_id, base_id);

CREATE UNIQUE INDEX document_chunks_workspace_document_index_idx ON document_chunks USING btree (workspace_id, document_id, chunk_index);

CREATE INDEX documents_account_index_sequence_idx ON documents USING btree (account_id, index_sequence) WHERE ((status = 'ready'::text) AND (index_sequence IS NOT NULL));

CREATE INDEX documents_acl_tags_idx ON documents USING gin (acl_tags);

CREATE INDEX documents_authority_idx ON documents USING btree (account_id, authority_kind, authority_workspace_id, authority_subject_id, status);

CREATE INDEX documents_user_authority_idx ON documents USING btree (account_id, owner_organization_membership_id, status, id) WHERE ((authority_kind = 'personal'::text) AND (authority_id IS NOT NULL));

CREATE UNIQUE INDEX documents_workspace_base_file_idx ON documents USING btree (workspace_id, base_id, file_id) WHERE (knowledge_source_identity IS NULL);

CREATE INDEX documents_workspace_base_status_idx ON documents USING btree (workspace_id, base_id, status);

CREATE INDEX documents_workspace_curation_status_idx ON documents USING btree (workspace_id, curation_status);

CREATE UNIQUE INDEX documents_workspace_knowledge_source_identity_uq ON documents USING btree (workspace_id, knowledge_source_identity) WHERE (knowledge_source_identity IS NOT NULL);

CREATE INDEX documents_workspace_source_external_id_idx ON documents USING btree (workspace_id, source_external_id);

CREATE INDEX documents_workspace_source_kind_idx ON documents USING btree (workspace_id, source_kind);

CREATE UNIQUE INDEX editable_artifact_idempotency_receipts_artifact_request_uq ON editable_artifact_idempotency_receipts USING btree (account_id, workspace_id, artifact_id, operation_kind, authority_key_digest, idempotency_key) WHERE (operation_kind = ANY (ARRAY['edit'::text, 'snapshot'::text, 'version'::text, 'materialize'::text]));

CREATE UNIQUE INDEX editable_artifact_idempotency_receipts_creation_request_uq ON editable_artifact_idempotency_receipts USING btree (account_id, workspace_id, operation_kind, authority_key_digest, idempotency_key) WHERE (operation_kind = ANY (ARRAY['create'::text, 'import'::text]));

CREATE UNIQUE INDEX editable_artifact_idempotency_receipts_origin_uq ON editable_artifact_idempotency_receipts USING btree (account_id, workspace_id, artifact_id) WHERE ((operation_kind = ANY (ARRAY['create'::text, 'import'::text])) AND (resource_type = 'artifact'::text));

CREATE INDEX editable_artifact_idempotency_receipts_transaction_idx ON editable_artifact_idempotency_receipts USING btree (workspace_id, artifact_id, server_transaction_id);

CREATE UNIQUE INDEX editable_artifact_live_outbox_id_uq ON editable_artifact_live_outbox USING btree (id);

CREATE INDEX editable_artifact_live_outbox_pending_claim_idx ON editable_artifact_live_outbox USING btree (next_attempt_at, created_at, id) WHERE (state = 'pending'::text);

CREATE INDEX editable_artifact_live_outbox_publishing_claim_idx ON editable_artifact_live_outbox USING btree (lease_expires_at, created_at, id) WHERE (state = 'publishing'::text);

CREATE UNIQUE INDEX editable_artifact_live_outbox_snapshot_uq ON editable_artifact_live_outbox USING btree (account_id, workspace_id, artifact_id, snapshot_id) WHERE (event_kind = 'snapshot_published'::text);

CREATE UNIQUE INDEX editable_artifact_live_outbox_transaction_uq ON editable_artifact_live_outbox USING btree (account_id, workspace_id, artifact_id, transaction_id) WHERE (event_kind = 'transaction_committed'::text);

CREATE INDEX editable_artifact_live_tickets_expiry_idx ON editable_artifact_live_tickets USING btree (expires_at, token_digest);

CREATE INDEX editable_artifact_materialization_jobs_claim_idx ON editable_artifact_materialization_jobs USING btree (COALESCE(lease_expires_at, created_at), created_at, account_id, workspace_id, artifact_id, id) WHERE (state = ANY (ARRAY['pending'::text, 'running'::text]));

CREATE UNIQUE INDEX editable_artifact_operations_dot_operation_uq ON editable_artifact_operations USING btree (account_id, workspace_id, artifact_id, dot_replica_id, dot_counter, operation_index);

CREATE UNIQUE INDEX editable_artifact_operations_operation_uq ON editable_artifact_operations USING btree (account_id, workspace_id, artifact_id, operation_id);

CREATE INDEX editable_artifact_operations_replay_idx ON editable_artifact_operations USING btree (workspace_id, artifact_id, sequence);

CREATE UNIQUE INDEX editable_artifact_operations_sequence_uq ON editable_artifact_operations USING btree (account_id, workspace_id, artifact_id, sequence);

CREATE INDEX editable_artifact_replica_leases_expiry_idx ON editable_artifact_replica_leases USING btree (lease_expires_at, replica_id) WHERE (revoked_at IS NULL);

CREATE UNIQUE INDEX editable_artifact_sequence_checkpoints_transaction_uq ON editable_artifact_sequence_checkpoints USING btree (account_id, workspace_id, artifact_id, transaction_id) WHERE (transaction_id IS NOT NULL);

CREATE INDEX editable_artifact_session_links_session_timeline_idx ON editable_artifact_session_links USING btree (workspace_id, session_id, last_used_at DESC, artifact_id);

CREATE INDEX editable_artifact_snapshots_coverage_idx ON editable_artifact_snapshots USING btree (workspace_id, artifact_id, covered_head_sequence DESC);

CREATE INDEX editable_artifact_transactions_replay_idx ON editable_artifact_transactions USING btree (workspace_id, artifact_id, sequence_start);

CREATE INDEX editable_artifact_undo_claims_transaction_idx ON editable_artifact_undo_claims USING btree (account_id, workspace_id, artifact_id, claiming_transaction_id, target_operation_id);

CREATE INDEX editable_artifact_versions_timeline_idx ON editable_artifact_versions USING btree (workspace_id, artifact_id, created_at DESC, id);

CREATE INDEX editable_artifacts_workspace_timeline_idx ON editable_artifacts USING btree (workspace_id, lifecycle_state, updated_at DESC, id);

CREATE INDEX enrollment_token_redemptions_enrollment_idx ON enrollment_token_redemptions USING btree (enrollment_id) WHERE (enrollment_id IS NOT NULL);

CREATE INDEX enrollment_token_redemptions_workspace_expires_idx ON enrollment_token_redemptions USING btree (workspace_id, expires_at);

CREATE INDEX enrollments_active_sandbox_id_idx ON enrollments USING btree (id) WHERE ((kind = 'sandbox'::text) AND (status = 'active'::text));

CREATE UNIQUE INDEX enrollments_organization_pubkey_idx ON enrollments USING btree (account_id, pubkey) WHERE (authority_scope = 'organization'::text);

CREATE INDEX enrollments_sandbox_group_idx ON enrollments USING btree (workspace_id, sandbox_group_id) WHERE (kind = 'sandbox'::text);

CREATE UNIQUE INDEX enrollments_user_pubkey_idx ON enrollments USING btree (account_id, owner_organization_membership_id, pubkey) WHERE (authority_scope = 'user'::text);

CREATE UNIQUE INDEX enrollments_workspace_pubkey_idx ON enrollments USING btree (workspace_id, pubkey) WHERE (authority_scope = 'workspace'::text);

CREATE INDEX enrollments_workspace_status_idx ON enrollments USING btree (workspace_id, status);

CREATE UNIQUE INDEX event_deliveries_dedupe_uq ON event_deliveries USING btree (source_id, dedupe_key) WHERE (replay_of_delivery_id IS NULL);

CREATE INDEX event_deliveries_received_idx ON event_deliveries USING btree (received_at);

CREATE INDEX event_deliveries_retained_body_idx ON event_deliveries USING btree (received_at) WHERE (body IS NOT NULL);

CREATE INDEX event_deliveries_source_received_idx ON event_deliveries USING btree (workspace_id, source_id, received_at DESC, id DESC);

CREATE INDEX event_ingress_routes_external_idx ON event_ingress_routes USING btree (kind, external_key) WHERE (external_key IS NOT NULL);

CREATE INDEX event_ingress_routes_source_idx ON event_ingress_routes USING btree (source_id);

CREATE INDEX event_source_feeds_due_idx ON event_source_feeds USING btree (next_action_at, source_id);

CREATE INDEX event_source_feeds_workspace_idx ON event_source_feeds USING btree (workspace_id, source_id);

CREATE UNIQUE INDEX event_sources_app_uq ON event_sources USING btree (workspace_id, kind, external_key) WHERE (kind = ANY (ARRAY['github'::text, 'slack'::text, 'gmail'::text]));

CREATE UNIQUE INDEX event_sources_mcp_uq ON event_sources USING btree (workspace_id, owner_subject_id, mcp_server_id, connection_id) NULLS NOT DISTINCT WHERE (kind = 'mcp'::text);

CREATE UNIQUE INDEX event_sources_workspace_id_uq ON event_sources USING btree (workspace_id, id);

CREATE UNIQUE INDEX event_sources_workspace_owner_uq ON event_sources USING btree (workspace_id, owner_subject_id) WHERE (kind = 'workspace'::text);

CREATE INDEX event_triggers_source_idx ON event_triggers USING btree (workspace_id, source_id) WHERE (status = 'active'::text);

CREATE INDEX event_triggers_stream_idx ON event_triggers USING btree (workspace_id, source_id, stream_key) WHERE (stream_key <> ''::text);

CREATE INDEX event_triggers_task_idx ON event_triggers USING btree (workspace_id, task_id);

CREATE INDEX external_identity_links_external_idx ON external_identity_links USING btree (account_id, external_identity_id, created_at, id);

CREATE INDEX external_identity_links_native_idx ON external_identity_links USING btree (account_id, native_subject_id, id) WHERE (native_subject_id IS NOT NULL);

CREATE INDEX feedback_submissions_author_idx ON feedback_submissions USING btree (workspace_id, subject_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX feedback_submissions_request_idx ON feedback_submissions USING btree (workspace_id, subject_id, idempotency_key);

CREATE INDEX feedback_submissions_session_idx ON feedback_submissions USING btree (workspace_id, session_id, created_at DESC, id DESC);

CREATE INDEX file_uploads_claim_recovery_idx ON file_uploads USING btree (updated_at, id) WHERE (status = 'cleanup_pending'::text);

CREATE INDEX file_uploads_file_id_idx ON file_uploads USING btree (file_id);

CREATE INDEX file_uploads_pending_expiry_cleanup_idx ON file_uploads USING btree (expires_at, id) WHERE (status = 'pending'::text);

CREATE INDEX file_uploads_status_idx ON file_uploads USING btree (status);

CREATE INDEX file_uploads_workspace_idx ON file_uploads USING btree (workspace_id);

CREATE UNIQUE INDEX files_object_key_idx ON files USING btree (object_key);

CREATE UNIQUE INDEX files_scope_id_uq ON files USING btree (account_id, workspace_id, id);

CREATE INDEX files_status_idx ON files USING btree (status);

CREATE INDEX files_workspace_created_idx ON files USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX files_workspace_id_uq ON files USING btree (workspace_id, id);

CREATE UNIQUE INDEX generated_image_artifacts_provider_item_uq ON generated_image_artifacts USING btree (workspace_id, provider_id, provider_binding_hash, provider_item_id) WHERE (provider_item_id IS NOT NULL);

CREATE INDEX generated_image_artifacts_session_created_idx ON generated_image_artifacts USING btree (workspace_id, session_id, created_at, artifact_id);

CREATE UNIQUE INDEX generated_image_artifacts_settlement_key_uq ON generated_image_artifacts USING btree (workspace_id, settlement_key);

CREATE INDEX generated_video_artifacts_session_created_idx ON generated_video_artifacts USING btree (workspace_id, session_id, created_at, id);

CREATE UNIQUE INDEX generated_video_artifacts_workspace_file_uq ON generated_video_artifacts USING btree (workspace_id, primary_file_id);

CREATE UNIQUE INDEX generated_video_artifacts_workspace_operation_uq ON generated_video_artifacts USING btree (workspace_id, operation_id);

CREATE INDEX github_install_repo_workspace_installation_idx ON github_installation_repositories USING btree (workspace_id, installation_id);

CREATE UNIQUE INDEX github_install_repo_workspace_installation_repo_idx ON github_installation_repositories USING btree (workspace_id, installation_id, repository_id);

CREATE UNIQUE INDEX github_installations_authority_nonce_uq ON github_installations USING btree (authority_nonce) WHERE (authority_nonce IS NOT NULL);

CREATE INDEX github_installations_installation_idx ON github_installations USING btree (installation_id);

CREATE INDEX github_installations_workspace_idx ON github_installations USING btree (workspace_id);

CREATE UNIQUE INDEX github_installations_workspace_installation_idx ON github_installations USING btree (workspace_id, installation_id);

CREATE INDEX google_drive_object_acl_evidence_file_idx ON google_drive_object_acl_evidence USING btree (account_id, file_id, expires_at DESC);

CREATE INDEX google_drive_object_acl_evidence_version_idx ON google_drive_object_acl_evidence USING btree (knowledge_document_version_id, expires_at DESC, created_at DESC);

CREATE INDEX google_drive_object_acl_principals_match_idx ON google_drive_object_acl_principals USING btree (evidence_id, principal_type, permission_id_hash, email_hash, domain_hash);

CREATE INDEX governed_learning_activation_receipts_workspace_time_idx ON governed_learning_activation_receipts USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX governed_learning_activation_undo_receipts_workspace_time_idx ON governed_learning_activation_undo_receipts USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX governed_learning_decision_receipts_workspace_time_idx ON governed_learning_decision_receipts USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX host_export_consumers_due_idx ON host_export_consumers USING btree (enabled, blocked_at, next_attempt_at);

CREATE UNIQUE INDEX host_export_consumers_kind_id_uq ON host_export_consumers USING btree (export_kind, consumer_id);

CREATE UNIQUE INDEX host_export_dead_letters_consumer_cursor_uq ON host_export_dead_letters USING btree (export_kind, consumer_id, export_cursor);

CREATE INDEX host_export_outbox_cursor_read_idx ON host_export_outbox USING btree (export_kind, export_cursor) INCLUDE (envelope_bytes) WHERE (export_cursor IS NOT NULL);

CREATE UNIQUE INDEX host_export_outbox_cursor_uq ON host_export_outbox USING btree (export_kind, export_cursor) WHERE (export_cursor IS NOT NULL);

CREATE UNIQUE INDEX host_export_outbox_source_uq ON host_export_outbox USING btree (export_kind, source_id);

CREATE INDEX host_export_outbox_unassigned_idx ON host_export_outbox USING btree (export_kind, enqueued_at, id) WHERE (export_cursor IS NULL);

CREATE INDEX host_export_outbox_unassigned_session_idx ON host_export_outbox USING btree (export_kind, session_id, session_sequence) WHERE ((export_cursor IS NULL) AND (session_id IS NOT NULL));

CREATE INDEX host_mcp_bindings_owner_idx ON host_mcp_bindings USING btree (workspace_id, owner_subject_id, created_at, id);

CREATE INDEX host_mcp_delegations_owner_idx ON host_mcp_delegations USING btree (workspace_id, owner_subject_id, binding_id, id);

CREATE INDEX image_generation_operations_credit_hold_idx ON image_generation_operations USING btree (workspace_id, provider_started_at) WHERE ((credit_state = 'pending'::text) AND (status = 'provider_started'::text));

CREATE UNIQUE INDEX image_generation_operations_operation_key_uq ON image_generation_operations USING btree (workspace_id, operation_key);

CREATE INDEX image_generation_operations_session_created_idx ON image_generation_operations USING btree (workspace_id, session_id, created_at, id);

CREATE INDEX import_batches_created_at_idx ON import_batches USING btree (created_at);

CREATE INDEX import_batches_source_snapshot_idx ON import_batches USING btree (source, snapshot_date);

CREATE INDEX inbound_events_delivery_idx ON inbound_events USING btree (delivery_id);

CREATE UNIQUE INDEX inbound_events_external_uq ON inbound_events USING btree (source_id, stream_key, external_id) WHERE (external_id IS NOT NULL);

CREATE INDEX inbound_events_received_idx ON inbound_events USING btree (received_at);

CREATE INDEX inbound_events_source_received_idx ON inbound_events USING btree (workspace_id, source_id, received_at DESC, id DESC);

CREATE INDEX inbound_events_workspace_received_idx ON inbound_events USING btree (workspace_id, received_at DESC, id DESC);

CREATE INDEX integration_facet_binding_owners_workspace_owner_idx ON integration_facet_binding_owners USING btree (workspace_id, owner_kind, owner_id);

CREATE UNIQUE INDEX integration_facet_bindings_workspace_runtime_uq ON integration_facet_bindings USING btree (workspace_id, runtime_key) WHERE (runtime_key IS NOT NULL);

CREATE INDEX integration_facet_bindings_workspace_status_idx ON integration_facet_bindings USING btree (workspace_id, status);

CREATE INDEX integration_facet_definitions_integration_kind_idx ON integration_facet_definitions USING btree (integration_facet_id, kind);

CREATE INDEX integration_oauth_clients_as_idx ON integration_oauth_clients USING btree (authorization_server);

CREATE UNIQUE INDEX integration_oauth_clients_issuer_idx ON integration_oauth_clients USING btree (issuer);

CREATE INDEX integration_oauth_pending_states_expiry_idx ON integration_oauth_pending_states USING btree (workspace_id, expires_at);

CREATE INDEX integration_oauth_state_nonces_expires_idx ON integration_oauth_state_nonces USING btree (expires_at);

CREATE INDEX integration_oauth_state_nonces_workspace_idx ON integration_oauth_state_nonces USING btree (workspace_id);

CREATE UNIQUE INDEX interaction_interventions_open_auth_run_uq ON interaction_interventions USING btree (workspace_id, auth_run_id) WHERE ((status = 'open'::text) AND (auth_run_id IS NOT NULL));

CREATE INDEX interaction_interventions_open_resource_idx ON interaction_interventions USING btree (workspace_id, resource_kind, resource_id, status, created_at);

CREATE UNIQUE INDEX interaction_interventions_open_target_kind_uq ON interaction_interventions USING btree (workspace_id, resource_kind, resource_id, target_id, kind) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX interaction_interventions_originating_tool_call_uq ON interaction_interventions USING btree (workspace_id, originating_session_id, originating_turn_id, originating_tool_call_id) WHERE (originating_tool_call_id IS NOT NULL);

CREATE UNIQUE INDEX interaction_operations_active_resource_uq ON interaction_operations USING btree (workspace_id, resource_kind, resource_id) WHERE (state = ANY (ARRAY['prepared'::text, 'dispatched'::text]));

CREATE INDEX interaction_operations_resource_history_idx ON interaction_operations USING btree (workspace_id, resource_kind, resource_id, created_at);

CREATE INDEX interaction_resource_operations_resource_history_idx ON interaction_resource_operations USING btree (workspace_id, resource_kind, resource_id, created_at);

CREATE INDEX knowledge_change_proposals_claim_timeline_idx ON knowledge_change_proposals USING btree (claim_id, created_at DESC);

CREATE INDEX knowledge_claim_evidence_claim_polarity_idx ON knowledge_claim_evidence USING btree (claim_id, polarity, created_at);

CREATE UNIQUE INDEX knowledge_claim_evidence_document_natural_identity_uq ON knowledge_claim_evidence USING btree (claim_id, document_version_id, polarity, COALESCE((document_chunk_id)::text, ''::text), COALESCE(locator, ''::text)) WHERE (document_version_id IS NOT NULL);

CREATE UNIQUE INDEX knowledge_claim_evidence_task_note_natural_identity_uq ON knowledge_claim_evidence USING btree (claim_id, task_note_id, polarity) WHERE (task_note_id IS NOT NULL);

CREATE INDEX knowledge_claim_reviews_claim_timeline_idx ON knowledge_claim_reviews USING btree (claim_id, review_revision DESC);

CREATE INDEX knowledge_claims_fact_timeline_idx ON knowledge_claims USING btree (fact_id, effective_at DESC, created_at DESC);

CREATE INDEX knowledge_document_versions_object_external_version_idx ON knowledge_document_versions USING btree (object_id, external_version_id);

CREATE INDEX knowledge_entity_aliases_entity_idx ON knowledge_entity_aliases USING btree (entity_id, created_at);

CREATE INDEX knowledge_entries_scope_idx ON knowledge_entries USING btree (account_id, scope, scope_workspace_id, scope_subject_id, id);

CREATE INDEX knowledge_entry_links_target_idx ON knowledge_entry_links USING btree (account_id, target_entry_id, relation, revision_id);

CREATE INDEX knowledge_entry_search_vector_idx ON knowledge_entry_search USING gin (search_vector);

CREATE INDEX knowledge_index_jobs_due ON knowledge_index_jobs USING btree (next_attempt_at, revision_id) WHERE (state <> 'obsolete'::text);

CREATE UNIQUE INDEX knowledge_lifecycle_events_target_operation_uq ON knowledge_lifecycle_events USING btree (account_id, target_kind, provider_id, source_id, object_id, operation_id) NULLS NOT DISTINCT;

CREATE INDEX knowledge_lifecycle_events_target_timeline_idx ON knowledge_lifecycle_events USING btree (target_kind, provider_id, source_id, object_id, created_at DESC);

CREATE INDEX knowledge_memories_labels_idx ON knowledge_memories USING gin (labels);

CREATE UNIQUE INDEX knowledge_memories_scope_visible_text_hash_uq ON knowledge_memories USING btree (workspace_id, scope_type, scope_subject_id, scope_role_key, scope_session_id, namespace_key, text_hash) NULLS NOT DISTINCT WHERE ((status = ANY (ARRAY['active'::text, 'approved'::text])) AND (text_hash IS NOT NULL));

CREATE INDEX knowledge_memories_text_fts_idx ON knowledge_memories USING gin (to_tsvector('simple'::regconfig, text));

CREATE INDEX knowledge_memories_workspace_created_by_session_idx ON knowledge_memories USING btree (workspace_id, created_by_session_id);

CREATE UNIQUE INDEX knowledge_memories_workspace_id_uq ON knowledge_memories USING btree (workspace_id, id);

CREATE INDEX knowledge_memories_workspace_kind_idx ON knowledge_memories USING btree (workspace_id, kind);

CREATE INDEX knowledge_memories_workspace_namespace_idx ON knowledge_memories USING btree (workspace_id, namespace_key, updated_at DESC, id);

CREATE INDEX knowledge_memories_workspace_scope_idx ON knowledge_memories USING btree (workspace_id, scope);

CREATE INDEX knowledge_memories_workspace_status_idx ON knowledge_memories USING btree (workspace_id, status, updated_at);

CREATE INDEX knowledge_memories_workspace_text_hash_idx ON knowledge_memories USING btree (workspace_id, text_hash);

CREATE INDEX knowledge_memories_workspace_typed_scope_idx ON knowledge_memories USING btree (workspace_id, scope_type, scope_subject_id, scope_role_key, scope_session_id);

CREATE INDEX knowledge_memories_workspace_visible_idx ON knowledge_memories USING btree (workspace_id, pinned DESC, updated_at DESC) WHERE (status = ANY (ARRAY['active'::text, 'approved'::text]));

CREATE INDEX knowledge_memory_lifecycle_events_actor_timeline_idx ON knowledge_memory_lifecycle_events USING btree (workspace_id, actor_kind, actor_subject_id, created_at DESC, id);

CREATE UNIQUE INDEX knowledge_memory_lifecycle_events_one_revert_uq ON knowledge_memory_lifecycle_events USING btree (reverts_event_id) WHERE (reverts_event_id IS NOT NULL);

CREATE INDEX knowledge_memory_lifecycle_events_target_timeline_idx ON knowledge_memory_lifecycle_events USING btree (workspace_id, target_memory_id, created_at DESC, id);

CREATE UNIQUE INDEX knowledge_memory_relationships_active_edge_uq ON knowledge_memory_relationships USING btree (workspace_id, source_memory_id, target_memory_id, relationship_type) WHERE (removed_by_event_id IS NULL);

CREATE UNIQUE INDEX knowledge_memory_relationships_active_symmetric_edge_uq ON knowledge_memory_relationships USING btree (workspace_id, relationship_type, LEAST(source_memory_id, target_memory_id), GREATEST(source_memory_id, target_memory_id)) WHERE ((removed_by_event_id IS NULL) AND (relationship_type = ANY (ARRAY['conflicts_with'::text, 'related_to'::text])));

CREATE INDEX knowledge_memory_relationships_source_idx ON knowledge_memory_relationships USING btree (workspace_id, source_memory_id, created_at DESC, id);

CREATE INDEX knowledge_memory_relationships_target_idx ON knowledge_memory_relationships USING btree (workspace_id, target_memory_id, created_at DESC, id);

CREATE INDEX knowledge_operation_receipts_result_idx ON knowledge_operation_receipts USING btree (operation_kind, result_id);

CREATE INDEX knowledge_providers_scope_lifecycle_idx ON knowledge_providers USING btree (account_id, scope_key, lifecycle_state);

CREATE UNIQUE INDEX knowledge_review_batches_run_idx ON knowledge_review_batches USING btree (account_id, owner_key, scheduled_task_run_id) WHERE (scheduled_task_run_id IS NOT NULL);

CREATE INDEX knowledge_source_acl_versions_source_timeline_idx ON knowledge_source_acl_versions USING btree (source_id, generation DESC);

CREATE INDEX knowledge_source_sync_index_obligations_pending_idx ON knowledge_source_sync_index_obligations USING btree (workspace_id, status, created_at);

CREATE INDEX knowledge_source_sync_item_outcomes_run_idx ON knowledge_source_sync_item_outcomes USING btree (workspace_id, scheduled_task_run_id, created_at);

CREATE INDEX knowledge_source_sync_object_observations_scan_idx ON knowledge_source_sync_object_observations USING btree (workspace_id, source_id, scan_generation);

CREATE INDEX knowledge_source_sync_states_due_idx ON knowledge_source_sync_states USING btree (workspace_id, buffered_wake, lease_until, updated_at);

CREATE INDEX knowledge_source_sync_wakes_pending_idx ON knowledge_source_sync_wakes USING btree (workspace_id, source_id, completed_at, created_at);

CREATE INDEX knowledge_sources_provider_idx ON knowledge_sources USING btree (provider_id, external_source_id);

CREATE INDEX knowledge_sync_runs_source_state_idx ON knowledge_sync_runs USING btree (source_id, state, started_at DESC);

CREATE INDEX machine_metrics_latest_workspace_idx ON machine_metrics_latest USING btree (workspace_id);

CREATE INDEX machine_metrics_series_enrollment_sampled_idx ON machine_metrics_series USING btree (enrollment_id, sampled_at);

CREATE INDEX machine_metrics_series_sampled_idx ON machine_metrics_series USING btree (sampled_at);

CREATE INDEX machine_removal_operations_enrollment_created_idx ON machine_removal_operations USING btree (workspace_id, enrollment_id, created_at);

CREATE UNIQUE INDEX machine_removal_operations_workspace_id_uq ON machine_removal_operations USING btree (workspace_id, id);

CREATE UNIQUE INDEX machine_removal_operations_workspace_operation_uq ON machine_removal_operations USING btree (workspace_id, operation_key);

CREATE UNIQUE INDEX managed_accounts_external_idx ON managed_accounts USING btree (external_source, external_id);

CREATE INDEX managed_auth_actor_mutation_leases_expiry_idx ON managed_auth_actor_mutation_leases USING btree (expires_at, session_set_id);

CREATE UNIQUE INDEX managed_auth_login_slots_live_binding_idx ON managed_auth_login_slots USING btree (session_set_id, login_binding_id) WHERE (status <> 'revoked'::text);

CREATE UNIQUE INDEX managed_auth_login_slots_live_session_idx ON managed_auth_login_slots USING btree (auth_session_id) WHERE ((auth_session_id IS NOT NULL) AND (status <> 'revoked'::text));

CREATE INDEX managed_auth_login_slots_set_status_idx ON managed_auth_login_slots USING btree (session_set_id, status, created_at, id);

CREATE INDEX managed_auth_login_transaction_rate_limits_expiry_idx ON managed_auth_login_transaction_rate_limits USING btree (expires_at, scope_kind, scope_hash);

CREATE INDEX managed_auth_login_transactions_set_status_idx ON managed_auth_login_transactions USING btree (session_set_id, status, expires_at);

CREATE INDEX managed_auth_session_set_operations_set_created_idx ON managed_auth_session_set_operations USING btree (session_set_id, created_at, operation_id);

CREATE INDEX mcp_event_subscriptions_due_idx ON mcp_event_subscriptions USING btree (next_action_at, id);

CREATE INDEX mcp_event_subscriptions_workspace_idx ON mcp_event_subscriptions USING btree (workspace_id, source_id);

CREATE INDEX mcp_oauth_access_tokens_expires_idx ON mcp_oauth_access_tokens USING btree (expires_at);

CREATE INDEX mcp_oauth_access_tokens_family_idx ON mcp_oauth_access_tokens USING btree (refresh_family_id, refresh_generation);

CREATE INDEX mcp_oauth_authorization_codes_expires_idx ON mcp_oauth_authorization_codes USING btree (expires_at);

CREATE INDEX mcp_oauth_authorization_requests_expires_idx ON mcp_oauth_authorization_requests USING btree (expires_at);

CREATE INDEX mcp_oauth_clients_created_idx ON mcp_oauth_clients USING btree (created_at);

CREATE INDEX mcp_oauth_clients_expires_idx ON mcp_oauth_clients USING btree (expires_at, client_id);

CREATE INDEX mcp_oauth_clients_scope_created_idx ON mcp_oauth_clients USING btree (registration_scope_hash, created_at);

CREATE INDEX mcp_oauth_refresh_tokens_expires_idx ON mcp_oauth_refresh_tokens USING btree (expires_at);

CREATE INDEX mcp_oauth_refresh_tokens_organization_idx ON mcp_oauth_refresh_tokens USING btree (account_id, family_id) WHERE (organization_access IS NOT NULL);

CREATE INDEX mcp_operations_source_idx ON mcp_operations USING btree (workspace_id, session_id, source_turn_id, source_call_id);

CREATE INDEX memory_slack_publication_configurations_workspace_created_idx ON memory_slack_publication_configurations USING btree (workspace_id, revision DESC);
