-- deployment-mode: rolling
-- Opengeni baseline part 5 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

SELECT pg_catalog.setval('opengeni_private.product_lifecycle_backfill_queue_seq_seq', 1, false);

SELECT pg_catalog.setval('opengeni_private.subscription_plan_catalog_revisions_revision_seq', 1, true);

SELECT pg_catalog.setval('opengeni_private.verified_signup_trial_switch_revisions_revision_seq', 1, true);

SELECT pg_catalog.setval('auth_runs_health_sequence_seq', 1, false);

SELECT pg_catalog.setval('company_profile_revision_seq', 1, false);

SELECT pg_catalog.setval('document_index_completion_seq', 1, false);

SELECT pg_catalog.setval('knowledge_claim_review_revision_seq', 1, false);

SELECT pg_catalog.setval('preference_registry_revision_seq', 1, false);

SELECT pg_catalog.setval('recording_live_segments_sequence_seq', 1, false);

SELECT pg_catalog.setval('site_host_generation_seq', 1, false);

SELECT pg_catalog.setval('slack_task_policy_revision_seq', 1, false);

SELECT pg_catalog.setval('workspace_instruction_policy_revision_seq', 1, false);

SELECT pg_catalog.setval('workspace_learning_policy_revision_seq', 1, false);

ALTER TABLE ONLY opengeni_private.artifact_catalog_pins
    ADD CONSTRAINT artifact_catalog_pins_pkey PRIMARY KEY (account_id, workspace_id, kind, artifact_id);

ALTER TABLE ONLY opengeni_private.automatic_session_title_fanout_outbox_v1
    ADD CONSTRAINT automatic_session_title_fanout_outbox_v1_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.claude_subscription_runtime_capabilities
    ADD CONSTRAINT claude_subscription_runtime_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.connection_tenancy_backfill_capabilities
    ADD CONSTRAINT connection_tenancy_backfill_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, account_id);

ALTER TABLE ONLY opengeni_private.context_compaction_pending_observations
    ADD CONSTRAINT context_compaction_pending_observations_pkey PRIMARY KEY (workspace_id, attempt_id);

ALTER TABLE ONLY opengeni_private.credit_grant_observations
    ADD CONSTRAINT credit_grant_observations_pkey PRIMARY KEY (ledger_entry_id);

ALTER TABLE ONLY opengeni_private.credit_promotion_policy_revisions
    ADD CONSTRAINT credit_promotion_policy_revisions_pkey PRIMARY KEY (revision);

ALTER TABLE ONLY opengeni_private.document_migration_capabilities
    ADD CONSTRAINT document_migration_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.google_drive_object_acl_runtime_capabilities
    ADD CONSTRAINT google_drive_object_acl_runtime_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.inbox_items
    ADD CONSTRAINT inbox_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.inbox_items
    ADD CONSTRAINT inbox_items_session_kind_source_recipient_key UNIQUE (session_id, kind, source_key, recipient_subject_id);

ALTER TABLE ONLY opengeni_private.inbox_member_notify_optins
    ADD CONSTRAINT inbox_member_notify_optins_pkey PRIMARY KEY (workspace_id, subject_id);

ALTER TABLE ONLY opengeni_private.inbox_session_mutes
    ADD CONSTRAINT inbox_session_mutes_pkey PRIMARY KEY (session_id, subject_id);

ALTER TABLE ONLY opengeni_private.inbox_settings
    ADD CONSTRAINT inbox_settings_pkey PRIMARY KEY (account_id, subject_id);

ALTER TABLE ONLY opengeni_private.insights_fact_read_runtime_capabilities
    ADD CONSTRAINT insights_fact_read_runtime_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.insights_usage_hourly_backfill
    ADD CONSTRAINT insights_usage_hourly_backfill_pkey PRIMARY KEY (workspace_id, hour);

ALTER TABLE ONLY opengeni_private.insights_usage_hourly_rollups
    ADD CONSTRAINT insights_usage_hourly_rollups_account_id_workspace_id_hour__key UNIQUE NULLS NOT DISTINCT (account_id, workspace_id, hour, session_id, provider, model, payer, scheduled_task_id);

ALTER TABLE ONLY opengeni_private.lifecycle_backfill_read_capabilities
    ADD CONSTRAINT lifecycle_backfill_read_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.maintenance_claim_capabilities
    ADD CONSTRAINT maintenance_claim_capabilities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_browser_sessions
    ADD CONSTRAINT maintenance_probe_browser_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_enrollments
    ADD CONSTRAINT maintenance_probe_enrollments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_rig_changes
    ADD CONSTRAINT maintenance_probe_rig_changes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_rig_versions
    ADD CONSTRAINT maintenance_probe_rig_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts
    ADD CONSTRAINT maintenance_probe_sandbox_checkpoint_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_sandbox_lease_holders
    ADD CONSTRAINT maintenance_probe_sandbox_lease_holders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_sandbox_leases
    ADD CONSTRAINT maintenance_probe_sandbox_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_sandbox_retained_processes
    ADD CONSTRAINT maintenance_probe_sandbox_retained_processes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_sandbox_workspace_mutation_admissions
    ADD CONSTRAINT maintenance_probe_sandbox_workspace_mutation_admissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_session_background_commands
    ADD CONSTRAINT maintenance_probe_session_background_commands_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_session_list_snapshots
    ADD CONSTRAINT maintenance_probe_session_list_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_session_system_update_outbox
    ADD CONSTRAINT maintenance_probe_session_system_update_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_session_turns
    ADD CONSTRAINT maintenance_probe_session_turns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_session_workflow_wake_outbox
    ADD CONSTRAINT maintenance_probe_session_workflow_wake_outbox_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_sessions
    ADD CONSTRAINT maintenance_probe_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.maintenance_probe_site_auth_connections
    ADD CONSTRAINT maintenance_probe_site_auth_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.managed_auth_new_signups_switch_revisions
    ADD CONSTRAINT managed_auth_new_signups_switch_revisions_pkey PRIMARY KEY (revision);

ALTER TABLE ONLY opengeni_private.modal_inventory_read_capabilities
    ADD CONSTRAINT modal_inventory_read_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, data_schema);

ALTER TABLE ONLY opengeni_private.modal_native_origin_read_capabilities
    ADD CONSTRAINT modal_native_origin_read_capabilities_pkey PRIMARY KEY (capability_id);

ALTER TABLE ONLY opengeni_private.native_push_deliveries
    ADD CONSTRAINT native_push_deliveries_auth_session_id_dedupe_key_key UNIQUE (auth_session_id, dedupe_key);

ALTER TABLE ONLY opengeni_private.native_push_deliveries
    ADD CONSTRAINT native_push_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.native_push_devices
    ADD CONSTRAINT native_push_devices_pkey PRIMARY KEY (auth_session_id);

ALTER TABLE ONLY opengeni_private.organization_signup_use_cases
    ADD CONSTRAINT organization_signup_use_cases_pkey PRIMARY KEY (account_id, subject_id);

ALTER TABLE ONLY opengeni_private.organization_slack_bot_access
    ADD CONSTRAINT organization_slack_bot_access_pkey PRIMARY KEY (connection_id);

ALTER TABLE ONLY opengeni_private.organization_tenancy_inventory_capabilities
    ADD CONSTRAINT organization_tenancy_inventory_capabilities_pk PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.organization_tenancy_parity_capabilities
    ADD CONSTRAINT organization_tenancy_parity_capabilities_pk PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.organization_usage_read_capabilities
    ADD CONSTRAINT organization_usage_read_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.personal_document_authority_capabilities
    ADD CONSTRAINT personal_document_authority_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.personal_resource_delegation_capabilities
    ADD CONSTRAINT personal_resource_delegation_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.product_lifecycle_backfill_progress
    ADD CONSTRAINT product_lifecycle_backfill_progress_pkey PRIMARY KEY (source);

ALTER TABLE ONLY opengeni_private.product_lifecycle_backfill_queue
    ADD CONSTRAINT product_lifecycle_backfill_queue_pkey PRIMARY KEY (source, seq);

ALTER TABLE ONLY opengeni_private.resource_classification_capabilities
    ADD CONSTRAINT resource_classification_capabilities_pk PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.sandbox_file_publications
    ADD CONSTRAINT sandbox_file_publications_pk PRIMARY KEY (account_id, workspace_id, file_id);

ALTER TABLE ONLY opengeni_private.sandbox_recovery_operator_receipts
    ADD CONSTRAINT sandbox_recovery_operator_receipts_pkey PRIMARY KEY (audit_event_id);

ALTER TABLE ONLY opengeni_private.sandbox_recovery_rollout
    ADD CONSTRAINT sandbox_recovery_rollout_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY opengeni_private.scheduled_personal_resource_capabilities
    ADD CONSTRAINT scheduled_personal_resource_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.scheduled_slack_bot_messages
    ADD CONSTRAINT scheduled_slack_bot_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.scoped_compute_capabilities
    ADD CONSTRAINT scoped_compute_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.session_archive_object_deletions
    ADD CONSTRAINT session_archive_object_deletions_pkey PRIMARY KEY (object_key);

ALTER TABLE ONLY opengeni_private.session_file_attachments
    ADD CONSTRAINT session_file_attachments_pkey PRIMARY KEY (account_id, workspace_id, session_id, file_id);

ALTER TABLE ONLY opengeni_private.session_file_read_capabilities
    ADD CONSTRAINT session_file_read_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, nonce, file_id);

ALTER TABLE ONLY opengeni_private.session_import_batches
    ADD CONSTRAINT session_import_batches_pkey PRIMARY KEY (workspace_id, session_id, batch_id);

ALTER TABLE ONLY opengeni_private.session_ownership_capabilities
    ADD CONSTRAINT session_ownership_capabilities_pk PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.session_tenancy_fence_inventory_capabilities
    ADD CONSTRAINT session_tenancy_fence_inventory_capabilities_pkey PRIMARY KEY (capability_id);

ALTER TABLE ONLY opengeni_private.session_tenancy_fence_target_registry
    ADD CONSTRAINT session_tenancy_fence_target_registry_pk PRIMARY KEY (singleton);

ALTER TABLE ONLY opengeni_private.session_tenancy_fenced_access_capabilities
    ADD CONSTRAINT session_tenancy_fenced_access_capabilities_pkey PRIMARY KEY (capability_id);

ALTER TABLE ONLY opengeni_private.session_turn_delta_folds
    ADD CONSTRAINT session_turn_delta_folds_pkey PRIMARY KEY (workspace_id, turn_id);

ALTER TABLE ONLY opengeni_private.session_usage_limit_capabilities
    ADD CONSTRAINT session_usage_limit_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, data_schema, workspace_id);

ALTER TABLE ONLY opengeni_private.session_usage_limit_config_receipts
    ADD CONSTRAINT session_usage_limit_config_receipts_pkey PRIMARY KEY (workspace_id, root_session_id, operation_id);

ALTER TABLE ONLY opengeni_private.session_usage_limit_receipts
    ADD CONSTRAINT session_usage_limit_receipts_pkey PRIMARY KEY (workspace_id, source_id);

ALTER TABLE ONLY opengeni_private.session_usage_limit_roots
    ADD CONSTRAINT session_usage_limit_roots_pkey PRIMARY KEY (workspace_id, root_session_id);

ALTER TABLE ONLY opengeni_private.site_session_cancellation_capabilities
    ADD CONSTRAINT site_session_cancellation_capabilities_capability_id_key UNIQUE (capability_id);

ALTER TABLE ONLY opengeni_private.site_session_cancellation_capabilities
    ADD CONSTRAINT site_session_cancellation_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id);

ALTER TABLE ONLY opengeni_private.slack_action_handle_tenancy
    ADD CONSTRAINT slack_action_handle_tenancy_pkey PRIMARY KEY (handle_id);

ALTER TABLE ONLY opengeni_private.slack_file_upload_operations
    ADD CONSTRAINT slack_file_upload_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.slack_routing_runtime_capabilities
    ADD CONSTRAINT slack_routing_runtime_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.subscription_authority_compat
    ADD CONSTRAINT subscription_authority_compat_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.subscription_core_auto_assignments
    ADD CONSTRAINT subscription_codex_auto_assignments_pkey PRIMARY KEY (connection_id);

ALTER TABLE ONLY opengeni_private.subscription_core_plan_change_providers
    ADD CONSTRAINT subscription_core_plan_change_providers_pkey PRIMARY KEY (provider);

ALTER TABLE ONLY opengeni_private.subscription_core_providers
    ADD CONSTRAINT subscription_core_providers_pkey PRIMARY KEY (provider);

ALTER TABLE ONLY opengeni_private.subscription_plan_catalog_revisions
    ADD CONSTRAINT subscription_plan_catalog_revisions_pkey PRIMARY KEY (revision);

ALTER TABLE ONLY opengeni_private.subscription_provider_cutover_receipts
    ADD CONSTRAINT subscription_provider_cutover_receipts_pkey PRIMARY KEY (provider);

ALTER TABLE ONLY opengeni_private.subscription_runtime_capabilities
    ADD CONSTRAINT subscription_runtime_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_kind, account_id, connection_id);

ALTER TABLE ONLY opengeni_private.subscription_usage_calls
    ADD CONSTRAINT subscription_usage_calls_pkey PRIMARY KEY (fact_id);

ALTER TABLE ONLY opengeni_private.subscription_usage_readings
    ADD CONSTRAINT subscription_usage_readings_pkey PRIMARY KEY (connection_id, window_id, observed_at);

ALTER TABLE ONLY opengeni_private.usage_allowance_attribution_receipts
    ADD CONSTRAINT usage_allowance_attribution_receipts_pkey PRIMARY KEY (account_id, workspace_id, source_kind, source_id);

ALTER TABLE ONLY opengeni_private.usage_allowance_capabilities
    ADD CONSTRAINT usage_allowance_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, data_schema, workspace_id);

ALTER TABLE ONLY opengeni_private.usage_allowance_membership_changes
    ADD CONSTRAINT usage_allowance_membership_changes_pkey PRIMARY KEY (data_schema, account_id);

ALTER TABLE ONLY opengeni_private.usage_maintenance_due
    ADD CONSTRAINT usage_maintenance_due_pkey PRIMARY KEY (data_schema, kind, workspace_id, source_id);

ALTER TABLE ONLY opengeni_private.user_activity_presence
    ADD CONSTRAINT user_activity_presence_pkey PRIMARY KEY (subject_id);

ALTER TABLE ONLY opengeni_private.variable_set_authority_capabilities
    ADD CONSTRAINT variable_set_authority_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.vault_authority_capabilities
    ADD CONSTRAINT vault_authority_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY opengeni_private.verified_signup_trial_switch_revisions
    ADD CONSTRAINT verified_signup_trial_switch_revisions_pkey PRIMARY KEY (revision);

ALTER TABLE ONLY opengeni_private.workspace_allowance_clear_receipts
    ADD CONSTRAINT workspace_allowance_clear_receipts_pkey PRIMARY KEY (workspace_id, operation_id);

ALTER TABLE ONLY opengeni_private.workspace_allowance_counters
    ADD CONSTRAINT workspace_allowance_counters_pkey PRIMARY KEY (workspace_id, period_key, subject_id);

ALTER TABLE ONLY opengeni_private.workspace_allowance_grants
    ADD CONSTRAINT workspace_allowance_grants_pkey PRIMARY KEY (workspace_id, operation_id);

ALTER TABLE ONLY opengeni_private.workspace_allowance_notifications
    ADD CONSTRAINT workspace_allowance_notificat_workspace_id_period_key_subje_key UNIQUE (workspace_id, period_key, subject_id, threshold);

ALTER TABLE ONLY opengeni_private.workspace_allowance_notifications
    ADD CONSTRAINT workspace_allowance_notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY opengeni_private.workspace_allowance_periods
    ADD CONSTRAINT workspace_allowance_periods_pkey PRIMARY KEY (workspace_id, period_key);

ALTER TABLE ONLY opengeni_private.workspace_member_allowances
    ADD CONSTRAINT workspace_member_allowances_pkey PRIMARY KEY (workspace_id, subject_id);

ALTER TABLE ONLY opengeni_private.workspace_usage_allowances
    ADD CONSTRAINT workspace_usage_allowances_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY opengeni_private.workspace_video_allowance_allocations
    ADD CONSTRAINT workspace_video_allowance_allocations_pkey PRIMARY KEY (ledger_id);

ALTER TABLE ONLY opengeni_private.xai_subscription_runtime_capabilities
    ADD CONSTRAINT xai_subscription_runtime_capabilities_pk PRIMARY KEY (backend_pid, transaction_id, capability_kind);

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_organization_membership_id_key UNIQUE (organization_membership_id);

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_rece_personal_workspace_id_key UNIQUE (personal_workspace_id);

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_receip_shared_workspace_id_key UNIQUE (shared_workspace_id);

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_receipts_account_id_key UNIQUE (account_id);

ALTER TABLE ONLY additional_organization_creation_receipts
    ADD CONSTRAINT additional_organization_creation_receipts_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY agent_instruction_operations
    ADD CONSTRAINT agent_instruction_operations_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY agent_learning_revisions
    ADD CONSTRAINT agent_learning_revisions_account_id_operation_id_key UNIQUE (account_id, operation_id);

ALTER TABLE ONLY agent_learning_revisions
    ADD CONSTRAINT agent_learning_revisions_account_id_owner_key_context_key_v_key UNIQUE (account_id, owner_key, context_key, version);

ALTER TABLE ONLY agent_learning_revisions
    ADD CONSTRAINT agent_learning_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY agent_learning_snapshots
    ADD CONSTRAINT agent_learning_snapshots_pkey PRIMARY KEY (account_id, turn_id);

ALTER TABLE agent_run_states
    ADD CONSTRAINT agent_run_states_pending_codec_version_chk CHECK (((pending_approvals_codec_version IS NULL) OR (pending_approvals_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY agent_run_states
    ADD CONSTRAINT agent_run_states_pkey PRIMARY KEY (id);

ALTER TABLE agent_run_states
    ADD CONSTRAINT agent_run_states_provider_artifact_invalidation_shape_chk CHECK ((((provider_artifact_invalidated_at IS NULL) AND (provider_artifact_invalidation_reason IS NULL) AND (provider_artifact_invalidated_by_attempt_id IS NULL)) OR ((provider_artifact_invalidated_at IS NOT NULL) AND (provider_artifact_invalidation_reason = 'encrypted_content_rejected'::text) AND (provider_artifact_invalidated_by_attempt_id IS NOT NULL)))) NOT VALID;

ALTER TABLE agent_run_states
    ADD CONSTRAINT agent_run_states_serialized_codec_version_chk CHECK (((serialized_run_state_codec_version IS NULL) OR (serialized_run_state_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY attached_browser_devices
    ADD CONSTRAINT attached_browser_devices_workspace_id_pk PRIMARY KEY (workspace_id, id);

ALTER TABLE ONLY attached_browser_inventories
    ADD CONSTRAINT attached_browser_inventories_workspace_enrollment_pk PRIMARY KEY (workspace_id, enrollment_id);

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_metadata_codec_version_chk CHECK (((metadata_codec_version IS NULL) OR (metadata_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_users
    ADD CONSTRAINT auth_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_verifications
    ADD CONSTRAINT auth_verifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_run_event_links
    ADD CONSTRAINT automation_run_event_links_pkey PRIMARY KEY (run_id, event_id);

ALTER TABLE ONLY automation_runs
    ADD CONSTRAINT automation_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_sources
    ADD CONSTRAINT automation_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_templates
    ADD CONSTRAINT automation_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_trigger_events
    ADD CONSTRAINT automation_trigger_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_trigger_revisions
    ADD CONSTRAINT automation_trigger_revisions_pkey PRIMARY KEY (trigger_id, revision);

ALTER TABLE ONLY automation_triggers
    ADD CONSTRAINT automation_triggers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automation_webhook_endpoints
    ADD CONSTRAINT automation_webhook_endpoints_pkey PRIMARY KEY (endpoint_id);

ALTER TABLE ONLY automation_webhook_endpoints
    ADD CONSTRAINT automation_webhook_endpoints_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY billing_customers
    ADD CONSTRAINT billing_customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY billing_subscription_operations
    ADD CONSTRAINT billing_subscription_operations_pkey PRIMARY KEY (account_id, operation_key);

ALTER TABLE ONLY browser_identities
    ADD CONSTRAINT browser_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_identities
    ADD CONSTRAINT browser_identities_workspace_create_operation_uq UNIQUE (workspace_id, create_operation_id);

ALTER TABLE ONLY browser_identities
    ADD CONSTRAINT browser_identities_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_artifact_uq UNIQUE (artifact_id);

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_revision_kind_uq UNIQUE (revision_id, kind);

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_revision_position_uq UNIQUE (revision_id, "position");

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_identity_id_uq UNIQUE (identity_id, id);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_identity_ordinal_uq UNIQUE (identity_id, ordinal);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_workspace_identity_id_uq UNIQUE (workspace_id, identity_id, id);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_workspace_identity_source_id_uq UNIQUE (workspace_id, identity_id, id, source_browser_session_id);

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_workspace_publication_operation_uq UNIQUE (workspace_id, publication_operation_id);

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_resource_session_relationship_uq UNIQUE (browser_session_id, session_id, relationship);

ALTER TABLE ONLY browser_session_retained_downloads
    ADD CONSTRAINT browser_session_retained_downloads_pkey PRIMARY KEY (workspace_id, browser_session_id, download_id);

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_workspace_create_operation_uq UNIQUE (workspace_id, create_operation_id);

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_commit_authority_uq UNIQUE (workspace_id, id, purpose, source_browser_session_id);

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_component_authority_uq UNIQUE (workspace_id, id, purpose, source_browser_session_id, kind);

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_object_key_uq UNIQUE (object_key);

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_object_key_uq UNIQUE (object_key);

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_operation_object_uq UNIQUE (workspace_id, operation_id, object_key);

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY canonical_human_identities
    ADD CONSTRAINT canonical_human_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY canonical_human_identity_operations
    ADD CONSTRAINT canonical_human_identity_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY canonical_human_identity_subjects
    ADD CONSTRAINT canonical_human_identity_subjects_pkey PRIMARY KEY (auth_user_id);

ALTER TABLE ONLY canonical_human_login_bindings
    ADD CONSTRAINT canonical_human_login_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_api_facets
    ADD CONSTRAINT capability_api_facets_pkey PRIMARY KEY (facet_id);

ALTER TABLE ONLY capability_component_owners
    ADD CONSTRAINT capability_component_owners_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_component_owners
    ADD CONSTRAINT capability_component_owners_unique_uq UNIQUE (facet_installation_id, owner_kind, owner_id);

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_installation_facet_uq UNIQUE (plugin_installation_id, facet_id);

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_facets
    ADD CONSTRAINT capability_facets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_facets
    ADD CONSTRAINT capability_facets_version_key_uq UNIQUE (plugin_version_id, facet_key);

ALTER TABLE ONLY capability_installations
    ADD CONSTRAINT capability_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_integration_facets
    ADD CONSTRAINT capability_integration_facets_pkey PRIMARY KEY (facet_id);

ALTER TABLE ONLY capability_mcp_facets
    ADD CONSTRAINT capability_mcp_facets_pkey PRIMARY KEY (facet_id);

ALTER TABLE ONLY capability_operations
    ADD CONSTRAINT capability_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_operations
    ADD CONSTRAINT capability_operations_workspace_idempotency_uq UNIQUE (workspace_id, idempotency_key);

ALTER TABLE ONLY capability_plugin_installations
    ADD CONSTRAINT capability_plugin_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_plugin_installations
    ADD CONSTRAINT capability_plugin_installations_workspace_plugin_uq UNIQUE (workspace_id, plugin_id);

ALTER TABLE ONLY capability_plugin_versions
    ADD CONSTRAINT capability_plugin_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_plugin_versions
    ADD CONSTRAINT capability_plugin_versions_plugin_digest_uq UNIQUE (plugin_id, manifest_digest);

ALTER TABLE ONLY capability_plugin_versions
    ADD CONSTRAINT capability_plugin_versions_plugin_identity_uq UNIQUE (plugin_id, id);

ALTER TABLE ONLY capability_plugin_versions
    ADD CONSTRAINT capability_plugin_versions_plugin_version_uq UNIQUE (plugin_id, version);

ALTER TABLE ONLY capability_plugins
    ADD CONSTRAINT capability_plugins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_skill_facets
    ADD CONSTRAINT capability_skill_facets_pkey PRIMARY KEY (facet_id);

ALTER TABLE ONLY capability_skill_files
    ADD CONSTRAINT capability_skill_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY capability_skill_files
    ADD CONSTRAINT capability_skill_files_skill_path_uq UNIQUE (skill_facet_id, path);

ALTER TABLE ONLY channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY claude_capacity_waiters
    ADD CONSTRAINT claude_capacity_waiters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY claude_credential_leases
    ADD CONSTRAINT claude_credential_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY claude_rotation_settings
    ADD CONSTRAINT claude_rotation_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY claude_session_account_pins
    ADD CONSTRAINT claude_session_account_pins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY claude_subscription_account_usage
    ADD CONSTRAINT claude_subscription_account_usage_pkey PRIMARY KEY (credential_id);

ALTER TABLE ONLY claude_subscription_credentials
    ADD CONSTRAINT claude_subscription_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_apps_settings
    ADD CONSTRAINT codex_apps_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_credential_leases
    ADD CONSTRAINT codex_credential_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_reset_redemption_attempts
    ADD CONSTRAINT codex_reset_redemption_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_rotation_settings
    ADD CONSTRAINT codex_rotation_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_subscription_credentials
    ADD CONSTRAINT codex_subscription_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY codex_turn_source_bindings
    ADD CONSTRAINT codex_turn_source_bindings_pkey PRIMARY KEY (turn_id);

ALTER TABLE ONLY company_brain_context_selection_receipts
    ADD CONSTRAINT company_brain_context_selection_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_preference_proposal_receipts_knowledge_uq UNIQUE (account_id, knowledge_proposal_id);

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_preference_proposal_receipts_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY company_brain_preference_proposal_receipts
    ADD CONSTRAINT company_brain_preference_proposal_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_brain_turn_context_snapshots
    ADD CONSTRAINT company_brain_turn_context_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_activation_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts
    ADD CONSTRAINT company_profile_agent_automatic_activation_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_profile_agent_confirmation_receipts
    ADD CONSTRAINT company_profile_agent_confirmation_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposal_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_profile_agent_proposal_receipts
    ADD CONSTRAINT company_profile_agent_proposals_id_account_uq UNIQUE (id, account_id);

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_events_account_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_events_account_version_uq UNIQUE (account_id, activation_version);

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_events_id_account_uq UNIQUE (id, account_id);

ALTER TABLE ONLY company_profile_heads
    ADD CONSTRAINT company_profile_heads_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY company_profile_revisions
    ADD CONSTRAINT company_profile_revisions_account_operation_uq UNIQUE (account_id, operation_id);

ALTER TABLE ONLY company_profile_revisions
    ADD CONSTRAINT company_profile_revisions_account_revision_uq UNIQUE (account_id, revision);

ALTER TABLE ONLY company_profile_revisions
    ADD CONSTRAINT company_profile_revisions_id_account_uq UNIQUE (id, account_id);

ALTER TABLE ONLY company_profile_revisions
    ADD CONSTRAINT company_profile_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_attempt_uq UNIQUE (account_id, workspace_id, attempt_id);

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY composer_drafts
    ADD CONSTRAINT composer_drafts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_resource_session_relationship_uq UNIQUE (computer_session_id, session_id, relationship);

ALTER TABLE ONLY computer_sessions
    ADD CONSTRAINT computer_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY computer_sessions
    ADD CONSTRAINT computer_sessions_workspace_create_operation_uq UNIQUE (workspace_id, create_operation_id);

ALTER TABLE ONLY computer_sessions
    ADD CONSTRAINT computer_sessions_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY connect_attempts
    ADD CONSTRAINT connect_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connection_authority_convergence_audit_capabilities
    ADD CONSTRAINT connection_authority_convergence_audit_capabilities_pkey PRIMARY KEY (capability_id);

ALTER TABLE ONLY connection_disconnect_operations
    ADD CONSTRAINT connection_disconnect_operations_connection_generation_uq UNIQUE (workspace_id, connection_id, expected_version);

ALTER TABLE ONLY connection_disconnect_operations
    ADD CONSTRAINT connection_disconnect_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connection_disconnect_operations
    ADD CONSTRAINT connection_disconnect_operations_subject_key_uq UNIQUE (workspace_id, subject_id, idempotency_key);

ALTER TABLE ONLY connection_use_audit_facts
    ADD CONSTRAINT connection_use_audit_facts_pkey PRIMARY KEY (physical_request_id);

ALTER TABLE ONLY connection_use_once_consumption_receipts
    ADD CONSTRAINT connection_use_once_consumption_receipts_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connector_action_policies
    ADD CONSTRAINT connector_action_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connector_action_policies
    ADD CONSTRAINT connector_action_policies_scope_uq UNIQUE (workspace_id, connection_id, server_id, tool_name, action_name);

ALTER TABLE ONLY connector_action_requests
    ADD CONSTRAINT connector_action_requests_identity_uq UNIQUE (workspace_id, session_id, turn_id, approval_id);

ALTER TABLE ONLY connector_action_requests
    ADD CONSTRAINT connector_action_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY credit_debit_allocations
    ADD CONSTRAINT credit_debit_allocations_pkey PRIMARY KEY (debit_entry_id, grant_entry_id);

ALTER TABLE ONLY credit_ledger_entries
    ADD CONSTRAINT credit_ledger_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_model_catalog
    ADD CONSTRAINT deployment_model_catalog_pkey PRIMARY KEY (singleton);

ALTER TABLE ONLY device_enrollment_requests
    ADD CONSTRAINT device_enrollment_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY document_authority_reclassifications
    ADD CONSTRAINT document_authority_reclassifications_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY document_bases
    ADD CONSTRAINT document_bases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY document_default_collection_backfill_operations
    ADD CONSTRAINT document_default_collection_backfill_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY document_default_collection_backfill_receipts
    ADD CONSTRAINT document_default_collection_backfill_receipts_pkey PRIMARY KEY (run_id, workspace_id);

ALTER TABLE ONLY document_default_collection_backfill_runs
    ADD CONSTRAINT document_default_collection_backfill_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY document_migration_audit_capabilities
    ADD CONSTRAINT document_migration_audit_capabilities_pkey PRIMARY KEY (capability_id);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY editable_artifact_blob_refs
    ADD CONSTRAINT editable_artifact_blob_refs_content_uq UNIQUE (account_id, workspace_id, artifact_id, kind, content_hash);

ALTER TABLE ONLY editable_artifact_blob_refs
    ADD CONSTRAINT editable_artifact_blob_refs_exact_facts_uq UNIQUE (account_id, workspace_id, artifact_id, id, byte_size, content_hash, mime_type);

ALTER TABLE ONLY editable_artifact_blob_refs
    ADD CONSTRAINT editable_artifact_blob_refs_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifact_idempotency_receipts
    ADD CONSTRAINT editable_artifact_idempotency_receipts_pk PRIMARY KEY (account_id, workspace_id, id);

ALTER TABLE ONLY editable_artifact_live_outbox
    ADD CONSTRAINT editable_artifact_live_outbox_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifact_live_tickets
    ADD CONSTRAINT editable_artifact_live_tickets_pkey PRIMARY KEY (token_digest);

ALTER TABLE ONLY editable_artifact_materialization_jobs
    ADD CONSTRAINT editable_artifact_materialization_jobs_cache_uq UNIQUE (account_id, workspace_id, artifact_id, input_snapshot_id, state_hash, format, options_hash, codec_id, codec_version, kernel_version, font_registry_hash, policy_hash);

ALTER TABLE ONLY editable_artifact_materialization_jobs
    ADD CONSTRAINT editable_artifact_materialization_jobs_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifact_materialization_results
    ADD CONSTRAINT editable_artifact_materialization_results_job_uq UNIQUE (account_id, workspace_id, artifact_id, job_id);

ALTER TABLE ONLY editable_artifact_materialization_results
    ADD CONSTRAINT editable_artifact_materialization_results_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifact_operations
    ADD CONSTRAINT editable_artifact_operations_pk PRIMARY KEY (account_id, workspace_id, artifact_id, transaction_id, operation_index);

ALTER TABLE ONLY editable_artifact_replica_leases
    ADD CONSTRAINT editable_artifact_replica_leases_pk PRIMARY KEY (account_id, workspace_id, artifact_id, replica_id);

ALTER TABLE ONLY editable_artifact_scope_authorization_heads
    ADD CONSTRAINT editable_artifact_scope_authorization_heads_pk PRIMARY KEY (account_id, workspace_id);

ALTER TABLE ONLY editable_artifact_sequence_checkpoints
    ADD CONSTRAINT editable_artifact_sequence_checkpoints_pk PRIMARY KEY (account_id, workspace_id, artifact_id, head_sequence);

ALTER TABLE ONLY editable_artifact_session_links
    ADD CONSTRAINT editable_artifact_session_links_pk PRIMARY KEY (account_id, workspace_id, session_id, artifact_id);

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_content_uq UNIQUE (account_id, workspace_id, artifact_id, content_hash, covered_head_sequence);

ALTER TABLE editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_facts_chk CHECK ((((byte_size >= 1) AND (byte_size <= 67108864)) AND (content_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (mime_type = 'application/vnd.opengeni.editable-artifact-snapshot'::text) AND ((covered_head_sequence >= 0) AND (covered_head_sequence <= '9007199254740991'::bigint)) AND (state_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (((modality = 'spreadsheet'::text) AND (model_schema_version = 2) AND opengeni_private.editable_artifact_frontier_valid(covered_causal_frontier) AND (operation_protocol_version = 2) AND (crdt_state_version = 2) AND (native_revision IS NULL)) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (model_schema_version = 1) AND (covered_causal_frontier IS NULL) AND (operation_protocol_version IS NULL) AND (crdt_state_version IS NULL) AND ((native_revision >= 0) AND (native_revision <= '9007199254740991'::bigint)))) AND ((octet_length(kernel_version) >= 1) AND (octet_length(kernel_version) <= 512)) AND (verified_at <= published_at))) NOT VALID;

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_source_manifest_uq UNIQUE (account_id, workspace_id, artifact_id, id, covered_head_sequence, state_hash);

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_actor_client_uq UNIQUE (account_id, workspace_id, artifact_id, actor_key_digest, client_transaction_id);

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_exact_receipt_authority_uq UNIQUE (account_id, workspace_id, artifact_id, id, actor_key_digest, client_transaction_id, request_hash);

ALTER TABLE editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_frontiers_chk CHECK ((((modality = 'spreadsheet'::text) AND opengeni_private.editable_artifact_frontier_valid(causal_base) AND opengeni_private.editable_artifact_frontier_valid(resolved_causal_base) AND opengeni_private.editable_artifact_frontier_valid(resulting_causal_frontier) AND opengeni_private.editable_artifact_operation_id_list_valid(operation_ids) AND (jsonb_array_length(operation_ids) = operation_count) AND opengeni_private.editable_artifact_id_array_valid(selective_undo_targets)) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (causal_base IS NULL) AND (resolved_causal_base IS NULL) AND (resulting_causal_frontier IS NULL) AND (operation_ids IS NULL) AND (selective_undo_targets IS NULL)))) NOT VALID;

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_predecessor_identity_uq UNIQUE (account_id, workspace_id, artifact_id, actor_key_digest, replica_id, client_transaction_id);

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_replica_counter_uq UNIQUE (account_id, workspace_id, artifact_id, replica_id, replica_counter);

ALTER TABLE editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_result_chk CHECK (((prior_state_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (state_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND ((octet_length(kernel_version) >= 1) AND (octet_length(kernel_version) <= 512)) AND ((committed_transaction_byte_size >= 1) AND (committed_transaction_byte_size <= 8388608)) AND (octet_length(committed_transaction_bytes) = committed_transaction_byte_size) AND (committed_transaction_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (committed_transaction_hash = ('sha256:'::text || encode(sha256(committed_transaction_bytes), 'hex'::text))) AND (((modality = 'spreadsheet'::text) AND (model_schema_version = 2) AND (command_protocol_version = 2) AND (operation_protocol_version = 2) AND (commit_protocol_version IS NULL) AND (prior_native_revision IS NULL) AND (native_revision IS NULL) AND (command_count IS NULL) AND (native_receipt_byte_size IS NULL) AND (native_receipt_hash IS NULL) AND (native_receipt_bytes IS NULL) AND (SUBSTRING(committed_transaction_bytes FROM 1 FOR 8) = convert_to('OGACO002'::text, 'UTF8'::name))) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (model_schema_version = 1) AND (command_protocol_version = 1) AND (operation_protocol_version IS NULL) AND (commit_protocol_version = 1) AND ((prior_native_revision >= 0) AND (prior_native_revision <= '9007199254740991'::bigint)) AND (((modality = 'document'::text) AND (((native_revision = prior_native_revision) AND (state_hash = prior_state_hash)) OR ((native_revision = (prior_native_revision + 1)) AND (state_hash <> prior_state_hash)))) OR ((modality = 'presentation'::text) AND (native_revision = (prior_native_revision + 1)) AND (state_hash <> prior_state_hash))) AND ((command_count >= 1) AND (command_count <= 4096)) AND ((native_receipt_byte_size >= 1) AND (native_receipt_byte_size <= 524288)) AND (octet_length(native_receipt_bytes) = native_receipt_byte_size) AND (native_receipt_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (native_receipt_hash = ('sha256:'::text || encode(sha256(native_receipt_bytes), 'hex'::text))) AND (SUBSTRING(committed_transaction_bytes FROM 1 FOR 8) = convert_to('OGAST001'::text, 'UTF8'::name)) AND (get_byte(committed_transaction_bytes, 12) =
CASE modality
    WHEN 'document'::text THEN 1
    ELSE 2
END) AND (get_byte(committed_transaction_bytes, 13) = 0) AND (get_byte(committed_transaction_bytes, 14) = 0) AND (get_byte(committed_transaction_bytes, 15) = 0) AND (SUBSTRING(native_receipt_bytes FROM 1 FOR 8) = convert_to(
CASE modality
    WHEN 'document'::text THEN 'OGADR001'::text
    ELSE 'OGAPR001'::text
END, 'UTF8'::name)))))) NOT VALID;

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_sequence_uq UNIQUE (account_id, workspace_id, artifact_id, sequence_start, sequence_end);

ALTER TABLE ONLY editable_artifact_undo_claims
    ADD CONSTRAINT editable_artifact_undo_claims_pk PRIMARY KEY (account_id, workspace_id, artifact_id, target_operation_id);

ALTER TABLE ONLY editable_artifact_versions
    ADD CONSTRAINT editable_artifact_versions_pk PRIMARY KEY (account_id, workspace_id, artifact_id, id);

ALTER TABLE ONLY editable_artifacts
    ADD CONSTRAINT editable_artifacts_pk PRIMARY KEY (account_id, workspace_id, id);

ALTER TABLE ONLY enrollment_token_redemptions
    ADD CONSTRAINT enrollment_token_redemptions_pkey PRIMARY KEY (token_id);

ALTER TABLE ONLY enrollments
    ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY enrollments
    ADD CONSTRAINT enrollments_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY event_deliveries
    ADD CONSTRAINT event_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY event_ingress_routes
    ADD CONSTRAINT event_ingress_routes_pkey PRIMARY KEY (route_id);

ALTER TABLE ONLY event_source_feeds
    ADD CONSTRAINT event_source_feeds_pkey PRIMARY KEY (source_id);

ALTER TABLE ONLY event_sources
    ADD CONSTRAINT event_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_position_uq UNIQUE (task_id, "position");

ALTER TABLE ONLY external_identities
    ADD CONSTRAINT external_identities_account_id_source_external_id_key UNIQUE (account_id, source, external_id);

ALTER TABLE ONLY external_identities
    ADD CONSTRAINT external_identities_account_id_subject_id_key UNIQUE (account_id, subject_id);

ALTER TABLE ONLY external_identities
    ADD CONSTRAINT external_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_identity_links
    ADD CONSTRAINT external_identity_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_link_task_authorities
    ADD CONSTRAINT external_link_task_authorities_pkey PRIMARY KEY (task_id, task_revision);

ALTER TABLE ONLY external_link_turn_authorities
    ADD CONSTRAINT external_link_turn_authorities_pkey PRIMARY KEY (turn_id);

ALTER TABLE ONLY feedback_submissions
    ADD CONSTRAINT feedback_submissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_pkey PRIMARY KEY (id);

ALTER TABLE files
    ADD CONSTRAINT files_owner_is_private_owner CHECK (((owner_subject_id IS NULL) OR (private_owner_subject_ids IS NULL) OR (owner_subject_id = ANY (private_owner_subject_ids)))) NOT VALID;

ALTER TABLE ONLY files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY github_installations
    ADD CONSTRAINT github_installations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_identity_uq UNIQUE (id, index_obligation_id);

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_obligation_uq UNIQUE (index_obligation_id, operation_id);

ALTER TABLE ONLY google_drive_object_acl_evidence
    ADD CONSTRAINT google_drive_object_acl_evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY google_drive_object_acl_principals
    ADD CONSTRAINT google_drive_object_acl_principals_pkey PRIMARY KEY (evidence_id, ordinal);

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_decision_uq UNIQUE (decision_receipt_id);

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY governed_learning_activation_receipts
    ADD CONSTRAINT governed_learning_activation_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_undo_receipts_activation_uq UNIQUE (activation_receipt_id);

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_undo_receipts_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY governed_learning_activation_undo_receipts
    ADD CONSTRAINT governed_learning_activation_undo_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY governed_learning_decision_receipts
    ADD CONSTRAINT governed_learning_decision_receipts_snapshot_proposal_uq UNIQUE (policy_snapshot_id, proposal_id);

ALTER TABLE ONLY host_export_config
    ADD CONSTRAINT host_export_config_pkey PRIMARY KEY (id);

ALTER TABLE host_export_consumers
    ADD CONSTRAINT host_export_consumers_last_error_codec_version_chk CHECK (((last_error_codec_version IS NULL) OR (last_error_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY host_export_consumers
    ADD CONSTRAINT host_export_consumers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY host_export_cursor_state
    ADD CONSTRAINT host_export_cursor_state_pkey PRIMARY KEY (export_kind);

ALTER TABLE host_export_dead_letters
    ADD CONSTRAINT host_export_dead_letters_codec_version_chk CHECK (((envelope_codec_version IS NULL) OR (envelope_codec_version = 1))) NOT VALID;

ALTER TABLE host_export_dead_letters
    ADD CONSTRAINT host_export_dead_letters_event_payload_codec_version_chk CHECK (((event_payload_codec_version IS NULL) OR (event_payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY host_export_dead_letters
    ADD CONSTRAINT host_export_dead_letters_pkey PRIMARY KEY (id);

ALTER TABLE host_export_outbox
    ADD CONSTRAINT host_export_outbox_payload_codec_version_chk CHECK (((payload_codec_version IS NULL) OR (payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY host_export_outbox
    ADD CONSTRAINT host_export_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY host_mcp_bindings
    ADD CONSTRAINT host_mcp_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY host_mcp_bindings
    ADD CONSTRAINT host_mcp_bindings_workspace_id_owner_subject_id_operation_i_key UNIQUE (workspace_id, owner_subject_id, operation_id);
