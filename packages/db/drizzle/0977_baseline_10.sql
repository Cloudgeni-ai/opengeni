-- deployment-mode: rolling
-- Opengeni baseline part 10 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE INDEX site_abuse_reports_open_idx ON site_abuse_reports USING btree (created_at DESC) WHERE (status = 'open'::text);

CREATE INDEX site_abuse_reports_site_idx ON site_abuse_reports USING btree (workspace_id, site_id, status, created_at DESC);

CREATE INDEX site_auth_codes_site_expiry_idx ON site_auth_codes USING btree (workspace_id, site_id, expires_at);

CREATE INDEX site_auth_connections_health_maintenance_idx ON site_auth_connections USING btree (next_check_at, maintenance_claimed_at, id);

CREATE UNIQUE INDEX site_auth_connections_workspace_active_name_uq ON site_auth_connections USING btree (workspace_id, lower(name)) WHERE (status = 'active'::text);

CREATE INDEX site_auth_connections_workspace_status_updated_idx ON site_auth_connections USING btree (workspace_id, status, updated_at, id);

CREATE UNIQUE INDEX site_data_collections_site_name_uq ON site_data_collections USING btree (workspace_id, site_id, name);

CREATE UNIQUE INDEX site_data_collections_workspace_id_uq ON site_data_collections USING btree (workspace_id, id);

CREATE UNIQUE INDEX site_data_collections_workspace_site_id_uq ON site_data_collections USING btree (workspace_id, site_id, id);

CREATE INDEX site_data_files_site_idx ON site_data_files USING btree (workspace_id, site_id, created_at, id);

CREATE INDEX site_data_record_values_num_idx ON site_data_record_values USING btree (collection_id, name, value_num) WHERE (kind = 'index'::text);

CREATE INDEX site_data_record_values_text_idx ON site_data_record_values USING btree (collection_id, name, value_text) WHERE (kind = 'index'::text);

CREATE UNIQUE INDEX site_data_record_values_unique_uq ON site_data_record_values USING btree (collection_id, name, scope, value_hash) WHERE (kind = 'unique'::text);

CREATE INDEX site_data_record_values_workspace_record_idx ON site_data_record_values USING btree (workspace_id, record_id);

CREATE INDEX site_data_records_created_idx ON site_data_records USING btree (collection_id, created_at, id);

CREATE INDEX site_data_records_data_idx ON site_data_records USING gin (data jsonb_path_ops);

CREATE UNIQUE INDEX site_data_records_key_uq ON site_data_records USING btree (collection_id, key_scope, record_key) WHERE (record_key IS NOT NULL);

CREATE INDEX site_data_records_owner_idx ON site_data_records USING btree (collection_id, owner_principal, created_at, id);

CREATE INDEX site_data_records_site_idx ON site_data_records USING btree (workspace_id, site_id);

CREATE INDEX site_data_records_updated_idx ON site_data_records USING btree (collection_id, updated_at, id);

CREATE UNIQUE INDEX site_data_records_workspace_id_uq ON site_data_records USING btree (workspace_id, id);

CREATE UNIQUE INDEX site_hostnames_live_site_uq ON site_hostnames USING btree (site_id) WHERE (released_at IS NULL);

CREATE INDEX site_hostnames_workspace_site_idx ON site_hostnames USING btree (workspace_id, site_id);

CREATE INDEX site_opens_site_idx ON site_opens USING btree (workspace_id, site_id);

CREATE INDEX site_publications_flagged_idx ON site_publications USING btree (scanned_at DESC) WHERE (scan_status = 'flagged'::text);

CREATE UNIQUE INDEX site_publications_label_uq ON site_publications USING btree (label);

CREATE UNIQUE INDEX site_publications_workspace_site_uq ON site_publications USING btree (workspace_id, site_id);

CREATE INDEX site_runtime_conversations_cancel_page_idx ON site_runtime_conversations USING btree (account_id, workspace_id, site_id, session_id);

CREATE INDEX site_runtime_conversations_reserved_idx ON site_runtime_conversations USING btree (workspace_id, site_id, swept_at NULLS FIRST, updated_at) WHERE (reserved_micros > 0);

CREATE INDEX site_runtime_conversations_site_recent_idx ON site_runtime_conversations USING btree (workspace_id, site_id, updated_at DESC);

CREATE INDEX site_runtime_conversations_viewer_idx ON site_runtime_conversations USING btree (workspace_id, site_id, viewer_principal, created_at DESC);

CREATE INDEX site_runtime_rate_windows_site_window_idx ON site_runtime_rate_windows USING btree (workspace_id, site_id, window_started_at);

CREATE INDEX site_runtime_usage_site_period_idx ON site_runtime_usage USING btree (workspace_id, site_id, period_start);

CREATE INDEX site_sidebar_states_site_idx ON site_sidebar_states USING btree (workspace_id, site_id);

CREATE UNIQUE INDEX site_sql_migrations_name_uq ON site_sql_migrations USING btree (workspace_id, site_id, name);

CREATE UNIQUE INDEX site_sql_migrations_ordinal_uq ON site_sql_migrations USING btree (workspace_id, site_id, ordinal);

CREATE UNIQUE INDEX site_sql_queries_name_uq ON site_sql_queries USING btree (workspace_id, site_id, name);

CREATE INDEX site_viewer_sessions_site_expiry_idx ON site_viewer_sessions USING btree (workspace_id, site_id, expires_at);

CREATE INDEX site_viewer_sessions_site_subject_idx ON site_viewer_sessions USING btree (workspace_id, site_id, subject_id);

CREATE INDEX slack_app_home_refreshes_pending_idx ON slack_app_home_refreshes USING btree (retry_at, updated_at, id) WHERE (processed_revision < desired_revision);

CREATE INDEX slack_bot_delete_operations_workspace_status_idx ON slack_bot_delete_operations USING btree (workspace_id, status, updated_at);

CREATE INDEX slack_bot_post_operations_workspace_status_idx ON slack_bot_post_operations USING btree (workspace_id, status, updated_at);

CREATE INDEX slack_bot_update_operations_workspace_status_idx ON slack_bot_update_operations USING btree (workspace_id, status, updated_at);

CREATE INDEX slack_bot_user_links_workspace_subject_idx ON slack_bot_user_links USING btree (workspace_id, subject_id);

CREATE INDEX slack_channel_routes_target_idx ON slack_channel_routes USING btree (target_workspace_id, slack_team_id);

CREATE UNIQUE INDEX slack_installation_bindings_active_team_uq ON slack_installation_bindings USING btree (slack_team_id) WHERE (state = 'active'::text);

CREATE INDEX slack_installation_bindings_workspace_state_idx ON slack_installation_bindings USING btree (workspace_id, state, updated_at);

CREATE INDEX slack_interaction_action_handles_pending_idx ON slack_interaction_action_handles USING btree (workspace_id, status, expires_at, id);

CREATE INDEX slack_interaction_inbox_pending_idx ON slack_interaction_inbox USING btree (status, retry_at, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));

CREATE INDEX slack_interactions_delivery_idx ON slack_interactions USING btree (terminal_delivery_state, delivery_retry_at, updated_at, id) WHERE ((session_id IS NOT NULL) AND (terminal_delivery_state = 'open'::text));

CREATE UNIQUE INDEX slack_interactions_workspace_reservation_uq ON slack_interactions USING btree (workspace_id, session_reservation_id);

CREATE UNIQUE INDEX slack_interactions_workspace_session_uq ON slack_interactions USING btree (workspace_id, session_id) WHERE (session_id IS NOT NULL);

CREATE UNIQUE INDEX slack_route_prompts_pending_conversation_uq ON slack_route_prompts USING btree (connection_id, slack_channel_id, slack_user_id) WHERE (status = 'pending'::text);

CREATE INDEX slack_route_prompts_pending_idx ON slack_route_prompts USING btree (expires_at, id) WHERE (status = 'pending'::text);

CREATE INDEX slack_task_policy_events_workspace_time_idx ON slack_task_policy_activation_events USING btree (workspace_id, created_at DESC, id);

CREATE INDEX slack_task_policy_heads_account_idx ON slack_task_policy_heads USING btree (account_id);

CREATE INDEX slack_task_policy_revisions_workspace_history_idx ON slack_task_policy_revisions USING btree (workspace_id, revision DESC);

CREATE INDEX slack_user_dm_routes_target_idx ON slack_user_dm_routes USING btree (target_workspace_id, slack_team_id);

CREATE UNIQUE INDEX slack_user_link_access_request_operations_idempotency_uq ON slack_user_link_access_request_operations USING btree (request_id, actor_subject_id, operation, idempotency_key);

CREATE UNIQUE INDEX slack_user_link_access_request_operations_result_version_uq ON slack_user_link_access_request_operations USING btree (request_id, result_version);

CREATE UNIQUE INDEX slack_user_link_access_requests_active_principal_uq ON slack_user_link_access_requests USING btree (workspace_id, connection_id, slack_user_id, subject_id) WHERE (status = ANY (ARRAY['prepared'::text, 'pending'::text]));

CREATE INDEX slack_user_link_access_requests_subject_idx ON slack_user_link_access_requests USING btree (workspace_id, subject_id, id);

CREATE UNIQUE INDEX slack_user_link_access_requests_token_digest_uq ON slack_user_link_access_requests USING btree (token_digest);

CREATE INDEX slack_user_link_access_requests_workspace_pending_idx ON slack_user_link_access_requests USING btree (workspace_id, status, expires_at, created_at);

CREATE UNIQUE INDEX social_connections_subject_provider_handle_idx ON social_connections USING btree (workspace_id, subject_id, provider) WHERE (subject_id IS NOT NULL);

CREATE INDEX social_connections_subject_provider_status_idx ON social_connections USING btree (workspace_id, subject_id, provider, status);

CREATE UNIQUE INDEX social_connections_workspace_provider_handle_idx ON social_connections USING btree (workspace_id, provider, account_handle) WHERE (subject_id IS NULL);

CREATE INDEX social_connections_workspace_provider_status_idx ON social_connections USING btree (workspace_id, provider, status);

CREATE UNIQUE INDEX social_posts_workspace_connection_external_post_idx ON social_posts USING btree (workspace_id, connection_id, external_post_id);

CREATE INDEX social_posts_workspace_connection_published_idx ON social_posts USING btree (workspace_id, connection_id, published_at);

CREATE INDEX social_posts_workspace_provider_published_idx ON social_posts USING btree (workspace_id, provider, published_at);

CREATE INDEX subscription_apps_designations_connection_idx ON subscription_apps_designations USING btree (account_id, connection_id);

CREATE UNIQUE INDEX subscription_capacity_waiters_account_waiter_id_uq ON subscription_capacity_waiters USING btree (account_id, waiter_id);

CREATE INDEX subscription_capacity_waiters_candidates_idx ON subscription_capacity_waiters USING gin (candidate_providers);

CREATE INDEX subscription_capacity_waiters_due_idx ON subscription_capacity_waiters USING btree (provider, next_check_at, wake_revision) WHERE (next_check_at IS NOT NULL);

CREATE INDEX subscription_capacity_waiters_home_scope_idx ON subscription_capacity_waiters USING btree (account_id, workspace_id, provider, session_id);

CREATE INDEX subscription_capacity_waiters_recovery_idx ON subscription_capacity_waiters USING btree (provider, earliest_reset_at, wake_revision);

CREATE INDEX subscription_capacity_wake_outbox_due_idx ON subscription_capacity_wake_outbox USING btree (next_attempt_at, created_at) WHERE (delivered_at IS NULL);

CREATE INDEX subscription_connection_assignment_policies_manager_idx ON subscription_connection_assignment_policies USING btree (account_id, managed_by_workspace_id) WHERE (managed_by_workspace_id IS NOT NULL);

CREATE INDEX subscription_connection_assignment_policies_pool_idx ON subscription_connection_assignment_policies USING btree (account_id, workspace_id, inference_pool, connection_id);

CREATE INDEX subscription_connection_people_placement_idx ON subscription_connection_people USING btree (account_id, organization_membership_id, connection_id);

CREATE INDEX subscription_connection_workspaces_placement_idx ON subscription_connection_workspaces USING btree (account_id, workspace_id, connection_id);

CREATE UNIQUE INDEX subscription_connections_account_id_uq ON subscription_connections USING btree (account_id, id);

CREATE UNIQUE INDEX subscription_connections_account_provider_id_uq ON subscription_connections USING btree (account_id, provider, id);

CREATE INDEX subscription_connections_manager_idx ON subscription_connections USING btree (account_id, managed_by_workspace_id) WHERE (managed_by_workspace_id IS NOT NULL);

CREATE INDEX subscription_connections_placement_idx ON subscription_connections USING btree (account_id, provider, status, allocator_enabled, ownership, scope_kind);

CREATE UNIQUE INDEX subscription_connections_provider_owner_account_uq ON subscription_connections USING btree (account_id, provider, provider_account_id, COALESCE(provider_subject_id, ''::text), COALESCE(owner_organization_membership_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (provider_account_id IS NOT NULL);

CREATE INDEX subscription_leases_connection_expiry_idx ON subscription_leases USING btree (account_id, connection_id, leased_until);

CREATE INDEX subscription_operation_leases_connection_expiry_idx ON subscription_operation_leases USING btree (account_id, connection_id, leased_until);

CREATE INDEX subscription_operation_leases_session_idx ON subscription_operation_leases USING btree (account_id, workspace_id, session_id, turn_id) WHERE (session_id IS NOT NULL);

CREATE UNIQUE INDEX subscription_operation_request_identity_uq ON subscription_operation_leases USING btree (account_id, request_id, transport_attempt) WHERE (request_id IS NOT NULL);

CREATE INDEX subscription_session_bindings_connection_idx ON subscription_session_bindings USING btree (account_id, provider, connection_id);

CREATE INDEX subscription_settings_workspace_idx ON subscription_settings USING btree (account_id, workspace_id) WHERE (workspace_id IS NOT NULL);

CREATE INDEX subscription_turn_failures_turn_idx ON subscription_turn_failures USING btree (account_id, turn_id, provider);

CREATE UNIQUE INDEX task_note_events_note_version_uq ON task_note_events USING btree (workspace_id, note_id, note_version);

CREATE INDEX task_note_events_root_timeline_idx ON task_note_events USING btree (workspace_id, root_session_id, created_at, id);

CREATE UNIQUE INDEX task_note_events_workspace_operation_uq ON task_note_events USING btree (workspace_id, operation_id);

CREATE INDEX task_note_replacement_receipts_root_timeline_idx ON task_note_replacement_receipts USING btree (workspace_id, root_session_id, created_at DESC, id DESC);

CREATE INDEX task_notes_root_active_idx ON task_notes USING btree (workspace_id, root_session_id, status, expires_at, updated_at DESC, id DESC);

CREATE UNIQUE INDEX task_notes_workspace_archive_operation_uq ON task_notes USING btree (workspace_id, archive_operation_id) WHERE (archive_operation_id IS NOT NULL);

CREATE UNIQUE INDEX task_notes_workspace_create_operation_uq ON task_notes USING btree (workspace_id, create_operation_id);

CREATE UNIQUE INDEX task_notes_workspace_id_uq ON task_notes USING btree (workspace_id, id);

CREATE UNIQUE INDEX task_notes_workspace_root_id_uq ON task_notes USING btree (workspace_id, root_session_id, id);

CREATE INDEX teams_bot_inbox_pending ON teams_bot_inbox USING btree (route_id, created_at) WHERE (state = 'pending'::text);

CREATE INDEX teams_bot_outbox_pending ON teams_bot_outbox USING btree (route_id, source_sequence, part_index, retry_at) WHERE (state = 'pending'::text);

CREATE INDEX teams_bot_routes_due ON teams_bot_routes USING btree (tenant_id, generation, last_claimed_at, route_id);

CREATE UNIQUE INDEX teams_bot_routes_session ON teams_bot_routes USING btree (workspace_id, session_id);

CREATE INDEX teams_bot_routes_unread ON teams_bot_routes USING btree (tenant_id, generation, last_claimed_at) WHERE (relevant_event_sequence > delivered_sequence);

CREATE INDEX temporal_schedule_cleanup_outbox_due_idx ON temporal_schedule_cleanup_outbox USING btree (next_attempt_at, claim_until, id);

CREATE UNIQUE INDEX temporal_schedule_cleanup_outbox_schedule_uq ON temporal_schedule_cleanup_outbox USING btree (temporal_schedule_id);

CREATE INDEX tenancy_backfill_receipt_account_time_idx ON tenancy_backfill_receipts USING btree (account_id, started_at, id);

CREATE UNIQUE INDEX tenancy_backfill_receipt_run_uq ON tenancy_backfill_receipts USING btree (account_id, resource_family, run_key);

CREATE INDEX tenancy_backfill_unresolved_account_family_idx ON tenancy_backfill_unresolved_rows USING btree (account_id, resource_family, observed_at);

CREATE UNIQUE INDEX tenancy_backfill_unresolved_row_uq ON tenancy_backfill_unresolved_rows USING btree (receipt_id, resource_family, resource_id);

CREATE INDEX tool_gateway_approval_capabilities_expires_idx ON tool_gateway_approval_capabilities USING btree (expires_at, token_hash);

CREATE INDEX tool_gateway_approval_capabilities_live_subject_expiry_idx ON tool_gateway_approval_capabilities USING btree (workspace_id, subject_id, expires_at, token_hash) WHERE (consumed_at IS NULL);

CREATE UNIQUE INDEX tool_gateway_approval_capabilities_operation_uq ON tool_gateway_approval_capabilities USING btree (workspace_id, subject_id, operation_id);

CREATE INDEX transcription_recording_chunks_order_idx ON transcription_recording_chunks USING btree (workspace_id, recording_id, chunk_number);

CREATE INDEX transcription_recording_objects_claim_recovery_idx ON transcription_recording_objects USING btree (cleanup_claimed_at, object_key) WHERE ((cleaned_at IS NULL) AND (cleanup_claim_id IS NOT NULL));

CREATE INDEX transcription_recording_objects_due_cleanup_idx ON transcription_recording_objects USING btree (cleanup_after, object_key) WHERE (cleaned_at IS NULL);

CREATE INDEX transcription_recording_segments_order_idx ON transcription_recording_segments USING btree (workspace_id, recording_id, segment_number);

CREATE INDEX transcription_recordings_expiry_idx ON transcription_recordings USING btree (expires_at, id);

CREATE INDEX transcription_recordings_subject_created_idx ON transcription_recordings USING btree (workspace_id, subject_id, created_at);

CREATE INDEX turn_connection_authority_connection_idx ON turn_connection_authority_snapshots USING btree (account_id, connection_id, turn_id, server_id);

CREATE INDEX turn_personal_resource_snapshots_authority_idx ON turn_personal_resource_snapshots USING btree (authority_id);

CREATE INDEX turn_personal_resource_snapshots_grant_idx ON turn_personal_resource_snapshots USING btree (grant_id);

CREATE INDEX usage_events_account_metric_idx ON usage_events USING btree (account_id, event_type, occurred_at);

CREATE INDEX usage_events_account_recent_idx ON usage_events USING btree (account_id, occurred_at DESC, recorded_at DESC);

CREATE UNIQUE INDEX usage_events_idempotency_idx ON usage_events USING btree (idempotency_key);

CREATE INDEX usage_events_workspace_metric_idx ON usage_events USING btree (workspace_id, event_type, occurred_at);

CREATE INDEX usage_events_workspace_metric_page_idx ON usage_events USING btree (workspace_id, event_type, occurred_at, id);

CREATE INDEX usage_events_workspace_metric_source_idx ON usage_events USING btree (workspace_id, event_type, source_resource_id);

CREATE INDEX usage_events_workspace_recent_idx ON usage_events USING btree (account_id, workspace_id, occurred_at DESC, recorded_at DESC);

CREATE INDEX usage_events_workspace_session_idx ON usage_events USING btree (workspace_id, session_id, occurred_at);

CREATE UNIQUE INDEX vault_item_fields_name_idx ON vault_item_fields USING btree (item_id, name_key);

CREATE INDEX vault_item_name_aliases_item_idx ON vault_item_name_aliases USING btree (item_id);

CREATE UNIQUE INDEX vault_items_name_idx ON vault_items USING btree (vault_id, name_key) WHERE (archived_at IS NULL);

CREATE INDEX vault_items_name_key_idx ON vault_items USING btree (name_key);

CREATE UNIQUE INDEX vault_items_provider_ref_idx ON vault_items USING btree (vault_id, provider_item_ref) WHERE (provider_item_ref IS NOT NULL);

CREATE INDEX vault_items_vault_updated_idx ON vault_items USING btree (vault_id, updated_at DESC);

CREATE INDEX vault_items_websites_idx ON vault_items USING gin (websites);

CREATE INDEX vault_name_aliases_vault_idx ON vault_name_aliases USING btree (vault_id);

CREATE INDEX vault_passkey_leases_holder_idx ON vault_passkey_leases USING btree (holder);

CREATE INDEX vaults_account_owner_idx ON vaults USING btree (account_id, owner_kind);

CREATE UNIQUE INDEX vaults_default_idx ON vaults USING btree (workspace_id, owner_kind, COALESCE(owner_organization_membership_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (is_default AND (owner_kind = 'workspace'::text));

CREATE UNIQUE INDEX vaults_id_account_idx ON vaults USING btree (id, account_id);

CREATE UNIQUE INDEX vaults_org_name_idx ON vaults USING btree (account_id, name_key) WHERE (owner_kind = 'organization'::text);

CREATE INDEX vaults_provider_connection_idx ON vaults USING btree (provider_connection_id) WHERE (provider_connection_id IS NOT NULL);

CREATE UNIQUE INDEX vaults_task_idx ON vaults USING btree (workspace_id, root_session_id) WHERE (owner_kind = 'task'::text);

CREATE UNIQUE INDEX vaults_user_default_idx ON vaults USING btree (account_id, owner_organization_membership_id) WHERE (is_default AND (owner_kind = 'user'::text));

CREATE UNIQUE INDEX vaults_user_name_idx ON vaults USING btree (account_id, owner_organization_membership_id, name_key) WHERE (owner_kind = 'user'::text);

CREATE INDEX vaults_workspace_idx ON vaults USING btree (workspace_id);

CREATE UNIQUE INDEX vaults_workspace_name_idx ON vaults USING btree (workspace_id, name_key) WHERE (owner_kind = 'workspace'::text);

CREATE UNIQUE INDEX video_generation_operations_admission_uq ON video_generation_operations USING btree (workspace_id, admission_key);

CREATE INDEX video_generation_operations_due_idx ON video_generation_operations USING btree (status, next_reconcile_at, id);

CREATE UNIQUE INDEX video_generation_operations_expected_artifact_uq ON video_generation_operations USING btree (workspace_id, expected_artifact_id);

CREATE UNIQUE INDEX video_generation_operations_expected_file_uq ON video_generation_operations USING btree (workspace_id, expected_file_id);

CREATE INDEX video_generation_operations_workspace_created_idx ON video_generation_operations USING btree (workspace_id, created_at, id);

CREATE INDEX workspace_artifact_events_list_idx ON workspace_artifact_events USING btree (workspace_id, artifact_id, created_at DESC);

CREATE INDEX workspace_artifact_uploads_expiry_idx ON workspace_artifact_uploads USING btree (workspace_id, expires_at) WHERE (status <> 'published'::text);

CREATE INDEX workspace_artifacts_list_idx ON workspace_artifacts USING btree (workspace_id, updated_at DESC);

CREATE INDEX workspace_artifacts_status_list_idx ON workspace_artifacts USING btree (workspace_id, status, updated_at);

CREATE INDEX workspace_captures_latest_idx ON workspace_captures USING btree (workspace_id, session_id, revision DESC);

CREATE UNIQUE INDEX workspace_captures_session_revision_idx ON workspace_captures USING btree (session_id, revision);

CREATE UNIQUE INDEX workspace_control_events_workspace_revision_uq ON workspace_control_events USING btree (workspace_id, revision);

CREATE UNIQUE INDEX workspace_credential_providers_workspace_uq ON workspace_credential_providers USING btree (workspace_id);

CREATE UNIQUE INDEX workspace_gateway_custom_models_create_operation_uq ON workspace_gateway_custom_models USING btree (workspace_id, provider_kind, create_operation_id);

CREATE UNIQUE INDEX workspace_gateway_custom_models_delete_operation_uq ON workspace_gateway_custom_models USING btree (workspace_id, provider_kind, delete_operation_id) WHERE (delete_operation_id IS NOT NULL);

CREATE UNIQUE INDEX workspace_gateway_custom_models_workspace_upstream_uq ON workspace_gateway_custom_models USING btree (workspace_id, provider_kind, upstream_model_id) WHERE (retired_at IS NULL);

CREATE UNIQUE INDEX workspace_inference_controls_workspace_account_uq ON workspace_inference_controls USING btree (workspace_id, account_id);

CREATE UNIQUE INDEX workspace_instruction_policy_deactivations_target_version_uq ON workspace_instruction_policy_deactivation_events USING btree (workspace_id, kind, scope, COALESCE(role_key, ''::text), activation_version);

CREATE INDEX workspace_instruction_policy_deactivations_workspace_time_idx ON workspace_instruction_policy_deactivation_events USING btree (workspace_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX workspace_instruction_policy_events_target_version_uq ON workspace_instruction_policy_activation_events USING btree (workspace_id, kind, scope, COALESCE(role_key, ''::text), activation_version);

CREATE UNIQUE INDEX workspace_instruction_policy_events_workspace_operation_uq ON workspace_instruction_policy_activation_events USING btree (workspace_id, operation_id) WHERE (operation_id IS NOT NULL);

CREATE INDEX workspace_instruction_policy_events_workspace_time_idx ON workspace_instruction_policy_activation_events USING btree (workspace_id, created_at DESC, id);

CREATE UNIQUE INDEX workspace_instruction_policy_heads_charter_uq ON workspace_instruction_policy_heads USING btree (workspace_id) WHERE (kind = 'charter'::text);

CREATE UNIQUE INDEX workspace_instruction_policy_heads_global_policy_uq ON workspace_instruction_policy_heads USING btree (workspace_id) WHERE ((kind = 'policy'::text) AND (scope = 'global'::text));

CREATE UNIQUE INDEX workspace_instruction_policy_heads_role_policy_uq ON workspace_instruction_policy_heads USING btree (workspace_id, role_key) WHERE ((kind = 'policy'::text) AND (scope = 'role'::text));

CREATE UNIQUE INDEX workspace_instruction_policy_onboarding_proposals_source_versio ON workspace_instruction_policy_onboarding_proposals USING btree (workspace_id, kind, scope, COALESCE(role_key, ''::text), source_id, source_version, baseline_activation_version);

CREATE INDEX workspace_instruction_policy_onboarding_proposals_workspace_tim ON workspace_instruction_policy_onboarding_proposals USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX workspace_instruction_policy_revisions_workspace_history_idx ON workspace_instruction_policy_revisions USING btree (workspace_id, kind, scope, role_key, revision DESC);

CREATE UNIQUE INDEX workspace_instruction_policy_revisions_workspace_operation_uq ON workspace_instruction_policy_revisions USING btree (workspace_id, operation_id) WHERE (operation_id IS NOT NULL);

CREATE INDEX workspace_instruction_policy_snapshots_workspace_time_idx ON workspace_instruction_policy_snapshots USING btree (workspace_id, created_at DESC, id);

CREATE INDEX workspace_learning_policy_events_workspace_time_idx ON workspace_learning_policy_activation_events USING btree (workspace_id, created_at DESC, id);

CREATE INDEX workspace_learning_policy_revisions_workspace_history_idx ON workspace_learning_policy_revisions USING btree (workspace_id, revision DESC);

CREATE INDEX workspace_learning_policy_snapshots_workspace_time_idx ON workspace_learning_policy_snapshots USING btree (workspace_id, created_at DESC, id);

CREATE INDEX workspace_memberships_account_idx ON workspace_memberships USING btree (account_id);

CREATE INDEX workspace_memberships_legacy_member_0516_idx ON workspace_memberships USING btree (id) WHERE ((role = 'member'::text) AND (permissions @> '["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage"]'::jsonb) AND ('["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage"]'::jsonb @> permissions));

CREATE INDEX workspace_memberships_legacy_member_0555_idx ON workspace_memberships USING btree (id) WHERE ((role = 'member'::text) AND (subject_id !~~ 'external_user:%'::text) AND (((permissions @> '["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage"]'::jsonb) AND ('["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage"]'::jsonb @> permissions)) OR ((permissions @> '["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage"]'::jsonb) AND ('["workspace:read", "sessions:create", "sessions:read", "sessions:control", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage"]'::jsonb @> permissions))));

CREATE INDEX workspace_memberships_legacy_member_0865_idx ON workspace_memberships USING btree (id) WHERE ((role = 'member'::text) AND (subject_id !~~ 'external_user:%'::text) AND (permissions @> '["workspace:read", "sessions:create", "sessions:read", "sessions:control", "stream:view", "stream:acknowledge", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage", "rigs:use", "artifacts:read", "artifacts:publish"]'::jsonb) AND ('["workspace:read", "sessions:create", "sessions:read", "sessions:control", "stream:view", "stream:acknowledge", "files:upload", "files:read", "documents:manage", "documents:search", "scheduled_tasks:manage", "scheduled_tasks:run", "github:use", "connections:read", "variable-sets:list", "variable-sets:read", "variable-sets:write", "variable-sets:attach", "variable-sets:use", "secrets:list", "secrets:write", "goals:manage", "rigs:use", "artifacts:read", "artifacts:publish"]'::jsonb @> permissions));

CREATE INDEX workspace_memberships_subject_idx ON workspace_memberships USING btree (subject_id);

CREATE UNIQUE INDEX workspace_memberships_subject_workspace_idx ON workspace_memberships USING btree (subject_id, workspace_id);

CREATE UNIQUE INDEX workspace_model_policies_workspace_idx ON workspace_model_policies USING btree (workspace_id);

CREATE INDEX workspace_pause_timer_due_idx ON workspace_inference_controls USING btree (timer_due_at, workspace_id) WHERE (timer_id IS NOT NULL);

CREATE UNIQUE INDEX workspace_variable_set_variables_env_name_idx ON workspace_variable_set_variables USING btree (workspace_id, variable_set_id, name);

CREATE INDEX workspace_variable_set_variables_workspace_env_idx ON workspace_variable_set_variables USING btree (workspace_id, variable_set_id);

CREATE INDEX workspace_variable_sets_account_scope_created_idx ON workspace_variable_sets USING btree (account_id, authority_scope, created_at, id) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX workspace_variable_sets_organization_name_active_idx ON workspace_variable_sets USING btree (account_id, name) WHERE ((authority_scope = 'organization'::text) AND (status = 'active'::text));

CREATE UNIQUE INDEX workspace_variable_sets_user_name_active_idx ON workspace_variable_sets USING btree (account_id, owner_organization_membership_id, name) WHERE ((authority_scope = 'user'::text) AND (status = 'active'::text));

CREATE INDEX workspace_variable_sets_workspace_created_idx ON workspace_variable_sets USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX workspace_variable_sets_workspace_name_active_idx ON workspace_variable_sets USING btree (workspace_id, name) WHERE ((authority_scope = 'workspace'::text) AND (status = 'active'::text));

CREATE INDEX workspace_webhook_deliveries_due_idx ON workspace_webhook_deliveries USING btree (next_attempt_at, id) WHERE ((delivered_at IS NULL) AND (failed_at IS NULL));

CREATE UNIQUE INDEX workspace_webhook_deliveries_event_uq ON workspace_webhook_deliveries USING btree (webhook_id, event_id);

CREATE INDEX workspace_webhook_deliveries_settled_idx ON workspace_webhook_deliveries USING btree (created_at) WHERE ((delivered_at IS NOT NULL) OR (failed_at IS NOT NULL));

CREATE INDEX workspace_webhook_deliveries_webhook_recent_idx ON workspace_webhook_deliveries USING btree (webhook_id, created_at DESC);

CREATE INDEX workspace_webhooks_workspace_idx ON workspace_webhooks USING btree (workspace_id, created_at);

CREATE INDEX workspaces_account_idx ON workspaces USING btree (account_id);

CREATE UNIQUE INDEX workspaces_account_slug_idx ON workspaces USING btree (account_id, slug) WHERE (slug IS NOT NULL);

CREATE UNIQUE INDEX workspaces_external_idx ON workspaces USING btree (account_id, external_source, external_id);

CREATE UNIQUE INDEX workspaces_id_account_idx ON workspaces USING btree (id, account_id);

CREATE INDEX workspaces_sandbox_viewer_force_drain_idx ON workspaces USING btree (id) WHERE (sandbox_viewer_force_drain_reason IS NOT NULL);

CREATE INDEX xai_capacity_waiters_pending_idx ON xai_capacity_waiters USING btree (workspace_id, status, next_check_at);

CREATE INDEX xai_capacity_waiters_wake_repair_idx ON xai_capacity_waiters USING btree (status, wake_revision, observed_wake_revision);

CREATE UNIQUE INDEX xai_capacity_waiters_workspace_session_uq ON xai_capacity_waiters USING btree (workspace_id, session_id, authority_scope, owner_organization_membership_id) NULLS NOT DISTINCT;

CREATE INDEX xai_credential_leases_active_credential_idx ON xai_credential_leases USING btree (workspace_id, credential_id, leased_until);

CREATE INDEX xai_credential_leases_expiry_idx ON xai_credential_leases USING btree (leased_until);

CREATE UNIQUE INDEX xai_credential_leases_workspace_turn_uq ON xai_credential_leases USING btree (workspace_id, turn_id);

CREATE UNIQUE INDEX xai_rotation_settings_workspace_pool_uq ON xai_rotation_settings USING btree (account_id, workspace_id, authority_scope, owner_organization_membership_id) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX xai_session_account_pins_workspace_session_uq ON xai_session_account_pins USING btree (workspace_id, session_id, authority_scope, owner_organization_membership_id) NULLS NOT DISTINCT;

CREATE UNIQUE INDEX xai_subscription_credentials_account_identity_uq ON xai_subscription_credentials USING btree (account_id, id);

CREATE UNIQUE INDEX xai_subscription_credentials_provider_identity_uq ON xai_subscription_credentials USING btree (account_id, workspace_id, authority_scope, owner_organization_membership_id, provider_account_id) NULLS NOT DISTINCT WHERE (provider_account_id IS NOT NULL);

CREATE UNIQUE INDEX xai_subscription_credentials_workspace_account_id_uq ON xai_subscription_credentials USING btree (workspace_id, account_id, id);

CREATE UNIQUE INDEX xai_subscription_credentials_workspace_id_uq ON xai_subscription_credentials USING btree (workspace_id, id);

CREATE INDEX xai_subscription_credentials_workspace_status_idx ON xai_subscription_credentials USING btree (workspace_id, status, allocator_enabled);

CREATE STATISTICS session_events_scope_statistics (dependencies, mcv) ON session_id, account_id, workspace_id FROM session_events;
ALTER STATISTICS session_events_scope_statistics SET STATISTICS 1000;

CREATE TRIGGER credit_promotion_policy_revisions_immutable BEFORE DELETE OR UPDATE ON opengeni_private.credit_promotion_policy_revisions FOR EACH ROW EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TRIGGER credit_promotion_policy_revisions_no_truncate BEFORE TRUNCATE ON opengeni_private.credit_promotion_policy_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TRIGGER managed_auth_new_signups_switch_revisions_immutable BEFORE DELETE OR UPDATE ON opengeni_private.managed_auth_new_signups_switch_revisions FOR EACH ROW EXECUTE FUNCTION reject_managed_auth_new_signups_switch_revision_mutation();

CREATE TRIGGER managed_auth_new_signups_switch_revisions_no_truncate BEFORE TRUNCATE ON opengeni_private.managed_auth_new_signups_switch_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_managed_auth_new_signups_switch_revision_mutation();

CREATE TRIGGER product_lifecycle_fact_user_active AFTER INSERT ON opengeni_private.user_activity_presence FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_user_active_day AFTER UPDATE OF active_day ON opengeni_private.user_activity_presence FOR EACH ROW WHEN ((new.active_day IS DISTINCT FROM old.active_day)) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER slack_file_upload_operations_guard BEFORE INSERT OR UPDATE ON opengeni_private.slack_file_upload_operations FOR EACH ROW EXECUTE FUNCTION guard_slack_file_upload_operation();

CREATE TRIGGER subscription_authority_compat_guard BEFORE INSERT OR DELETE OR UPDATE ON opengeni_private.subscription_authority_compat FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_authority_compat();

CREATE TRIGGER subscription_authority_compat_no_truncate BEFORE TRUNCATE ON opengeni_private.subscription_authority_compat FOR EACH STATEMENT EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_authority_compat();

CREATE TRIGGER subscription_core_providers_append_only BEFORE INSERT OR DELETE OR UPDATE ON opengeni_private.subscription_core_providers FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_provider_registry();

CREATE TRIGGER subscription_core_providers_connection_kind_immutable BEFORE UPDATE ON opengeni_private.subscription_core_providers FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_provider_connection_kind();

CREATE TRIGGER subscription_core_providers_no_truncate BEFORE TRUNCATE ON opengeni_private.subscription_core_providers FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.guard_subscription_provider_registry();

CREATE TRIGGER subscription_plan_catalog_immutable BEFORE DELETE OR UPDATE ON opengeni_private.subscription_plan_catalog_revisions FOR EACH ROW EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TRIGGER subscription_plan_catalog_no_truncate BEFORE TRUNCATE ON opengeni_private.subscription_plan_catalog_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TRIGGER subscription_provider_cutover_receipts_append_only BEFORE DELETE OR UPDATE ON opengeni_private.subscription_provider_cutover_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts();

CREATE TRIGGER subscription_provider_cutover_receipts_no_truncate BEFORE TRUNCATE ON opengeni_private.subscription_provider_cutover_receipts FOR EACH STATEMENT EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts();

CREATE TRIGGER subscription_runtime_capabilities_reclaim_finished BEFORE INSERT ON opengeni_private.subscription_runtime_capabilities FOR EACH ROW EXECUTE FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities();

CREATE TRIGGER usage_maintenance_due_sync AFTER INSERT OR DELETE OR UPDATE ON opengeni_private.session_usage_limit_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.sync_usage_maintenance_due('{{schema}}', 'session_receipt');

CREATE TRIGGER usage_maintenance_due_sync AFTER INSERT OR DELETE OR UPDATE ON opengeni_private.session_usage_limit_roots FOR EACH ROW EXECUTE FUNCTION opengeni_private.sync_usage_maintenance_due('{{schema}}', 'session_import');

CREATE TRIGGER usage_maintenance_due_sync AFTER INSERT OR DELETE OR UPDATE ON opengeni_private.workspace_usage_allowances FOR EACH ROW EXECUTE FUNCTION opengeni_private.sync_usage_maintenance_due('{{schema}}', 'allowance');

CREATE TRIGGER verified_signup_trial_switch_revisions_immutable BEFORE DELETE OR UPDATE ON opengeni_private.verified_signup_trial_switch_revisions FOR EACH ROW EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TRIGGER verified_signup_trial_switch_revisions_no_truncate BEFORE TRUNCATE ON opengeni_private.verified_signup_trial_switch_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_verified_signup_trial_switch_revision_mutation();

CREATE TRIGGER a_sync_ordered_model_history BEFORE INSERT OR UPDATE OF item, item_ordered ON session_history_items FOR EACH ROW EXECUTE FUNCTION sync_session_history_items_ordered();

CREATE TRIGGER a_sync_ordered_model_history BEFORE INSERT OR UPDATE OF call_item, call_item_ordered, result_item, result_item_ordered, tied_reasoning_items, tied_reasoning_items_ordered ON session_pending_tool_calls FOR EACH ROW EXECUTE FUNCTION sync_session_pending_tool_calls_ordered();

CREATE TRIGGER aa_subscription_request_history BEFORE INSERT OR DELETE OR UPDATE ON subscription_operation_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_request_history();

CREATE TRIGGER accepted_scheduled_turn_connection_authority_capture AFTER INSERT OR UPDATE OF personal_connection_delegations ON session_turns FOR EACH ROW WHEN ((new.scheduled_task_run_id IS NOT NULL)) EXECUTE FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities();

CREATE TRIGGER accepted_turn_connection_authority_capture AFTER INSERT OR UPDATE OF personal_connection_delegations ON session_turns FOR EACH ROW WHEN ((new.scheduled_task_run_id IS NULL)) EXECUTE FUNCTION opengeni_private.capture_accepted_turn_connection_authorities();

CREATE TRIGGER additional_organization_creation_receipts_immutable BEFORE DELETE OR UPDATE ON additional_organization_creation_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER agent_instruction_activation_preservation BEFORE INSERT ON workspace_instruction_policy_activation_events FOR EACH ROW EXECUTE FUNCTION agent_instruction_activation_preserves_baseline();

CREATE TRIGGER agent_run_states_lossless_legacy_update_fence BEFORE UPDATE OF serialized_run_state, pending_approvals ON agent_run_states FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER allowance_membership_delete AFTER DELETE ON external_identities REFERENCING OLD TABLE AS old_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE CONSTRAINT TRIGGER allowance_membership_delete AFTER DELETE ON managed_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_delete AFTER DELETE ON organization_memberships REFERENCING OLD TABLE AS old_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_delete AFTER DELETE ON workspace_memberships REFERENCING OLD TABLE AS old_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_insert AFTER INSERT ON external_identities REFERENCING NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_insert AFTER INSERT ON managed_accounts REFERENCING NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_insert AFTER INSERT ON organization_memberships REFERENCING NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_insert AFTER INSERT ON workspace_memberships REFERENCING NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_update AFTER UPDATE ON external_identities REFERENCING OLD TABLE AS old_members NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_update AFTER UPDATE ON managed_accounts REFERENCING OLD TABLE AS old_members NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_update AFTER UPDATE ON organization_memberships REFERENCING OLD TABLE AS old_members NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_membership_update AFTER UPDATE ON workspace_memberships REFERENCING OLD TABLE AS old_members NEW TABLE AS new_members FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.arm_usage_allowances_for_membership();

CREATE TRIGGER allowance_query_attribution AFTER INSERT OR UPDATE ON usage_events FOR EACH ROW EXECUTE FUNCTION capture_usage_allowance_attribution();

CREATE TRIGGER allowance_schedule_attribution AFTER INSERT OR UPDATE ON scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION capture_usage_allowance_attribution();

CREATE TRIGGER allowance_turn_attribution AFTER INSERT OR UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION capture_usage_allowance_attribution();

CREATE TRIGGER api_keys_00_normalize_credential_kind BEFORE INSERT OR UPDATE OF workspace_id, credential_kind, permissions, revoked_at ON api_keys FOR EACH ROW EXECUTE FUNCTION opengeni_private.normalize_api_key_credential_kind();

CREATE TRIGGER attached_browser_devices_update_guard_trg BEFORE UPDATE ON attached_browser_devices FOR EACH ROW EXECUTE FUNCTION opengeni_private.attached_browser_devices_update_guard();

CREATE TRIGGER audit_events_lossless_legacy_update_fence BEFORE UPDATE OF metadata ON audit_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER browser_identities_update_guard_trg BEFORE UPDATE ON browser_identities FOR EACH ROW EXECUTE FUNCTION opengeni_private.browser_identities_update_guard();

CREATE TRIGGER browser_sessions_default_device_workspace_trg BEFORE INSERT OR UPDATE OF device_id, device_workspace_id ON browser_sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.default_interaction_device_workspace();

CREATE TRIGGER browser_state_artifacts_update_guard_trg BEFORE UPDATE ON browser_state_artifacts FOR EACH ROW EXECUTE FUNCTION opengeni_private.browser_state_artifacts_update_guard();

CREATE TRIGGER browser_state_uploads_update_guard_trg BEFORE UPDATE ON browser_state_uploads FOR EACH ROW EXECUTE FUNCTION opengeni_private.browser_state_uploads_update_guard();

CREATE TRIGGER capability_api_facets_immutable BEFORE UPDATE ON capability_api_facets FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER capability_component_owners_validate BEFORE INSERT OR UPDATE ON capability_component_owners FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_component_owner();

CREATE TRIGGER capability_facet_installations_validate BEFORE INSERT OR UPDATE ON capability_facet_installations FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_facet_installation();

CREATE TRIGGER capability_facets_immutable BEFORE UPDATE ON capability_facets FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER capability_integration_facets_immutable BEFORE UPDATE ON capability_integration_facets FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER capability_mcp_facets_immutable BEFORE UPDATE ON capability_mcp_facets FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER capability_plugin_installations_validate BEFORE INSERT OR UPDATE ON capability_plugin_installations FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_plugin_installation();

CREATE TRIGGER capability_plugin_versions_restrict_update BEFORE UPDATE ON capability_plugin_versions FOR EACH ROW EXECUTE FUNCTION capability_plugin_versions_restrict_update();

CREATE TRIGGER capability_skill_facets_immutable BEFORE UPDATE ON capability_skill_facets FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER capability_skill_files_immutable BEFORE UPDATE ON capability_skill_files FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER channels_list_change AFTER INSERT OR DELETE ON channels FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER channels_list_update AFTER UPDATE OF name, pinned, sort_order ON channels FOR EACH ROW WHEN ((((old.name IS DISTINCT FROM new.name) OR (old.pinned IS DISTINCT FROM new.pinned)) OR (old.sort_order IS DISTINCT FROM new.sort_order))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER codex_cooldown_revision_guard BEFORE UPDATE OF exhausted_until, exhausted_kind, exhausted_revision ON codex_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.codex_cooldown_revision_guard();

CREATE TRIGGER codex_credential_leases_source_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, credential_id, turn_id ON codex_credential_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_lease_source();

CREATE TRIGGER codex_credentials_organization_live_lease_disconnect_guard BEFORE DELETE ON codex_subscription_credentials FOR EACH ROW WHEN ((old.authority_scope = 'organization'::text)) EXECUTE FUNCTION opengeni_private.prevent_organization_codex_disconnect_with_live_leases();

CREATE TRIGGER codex_credentials_organization_runtime_update_guard BEFORE UPDATE ON codex_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_organization_codex_runtime_update();

CREATE TRIGGER codex_credentials_validate_user_authority_trg BEFORE INSERT OR UPDATE OF id, account_id, workspace_id, organization_id, authority_scope, owner_organization_membership_id, organization_user_resource_authority_id, organization_user_resource_kind, organization_user_resource_authority_generation ON codex_subscription_credentials FOR EACH ROW EXECUTE FUNCTION validate_personal_codex_credential_authority();

CREATE TRIGGER codex_rotation_settings_workspace_guard BEFORE INSERT OR UPDATE OF active_credential_id, workspace_id ON codex_rotation_settings FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace();

CREATE TRIGGER company_brain_context_selection_receipts_immutable BEFORE INSERT OR DELETE OR UPDATE ON company_brain_context_selection_receipts FOR EACH ROW EXECUTE FUNCTION guard_company_brain_context_selection_receipt();

CREATE TRIGGER company_brain_preference_proposal_receipts_immutable BEFORE DELETE OR UPDATE ON company_brain_preference_proposal_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_owned_skill_history_delete();

CREATE TRIGGER company_brain_turn_context_snapshots_immutable BEFORE INSERT OR DELETE OR UPDATE ON company_brain_turn_context_snapshots FOR EACH ROW EXECUTE FUNCTION guard_company_brain_turn_context_snapshot();

CREATE TRIGGER company_profile_agent_automatic_activations_immutable BEFORE DELETE OR UPDATE ON company_profile_agent_automatic_activation_receipts FOR EACH ROW EXECUTE FUNCTION company_profile_agent_receipts_immutable();

CREATE TRIGGER company_profile_agent_confirmations_immutable BEFORE DELETE OR UPDATE ON company_profile_agent_confirmation_receipts FOR EACH ROW EXECUTE FUNCTION company_profile_agent_receipts_immutable();

CREATE TRIGGER company_profile_agent_proposals_immutable BEFORE DELETE OR UPDATE ON company_profile_agent_proposal_receipts FOR EACH ROW EXECUTE FUNCTION company_profile_agent_receipts_immutable();

CREATE TRIGGER company_profile_events_immutable BEFORE DELETE OR UPDATE ON company_profile_activation_events FOR EACH ROW EXECUTE FUNCTION company_profile_reject_history_mutation();

CREATE TRIGGER company_profile_events_validate BEFORE INSERT OR UPDATE ON company_profile_activation_events FOR EACH ROW EXECUTE FUNCTION company_profile_validate_event();

CREATE TRIGGER company_profile_heads_lifecycle_only BEFORE INSERT OR DELETE OR UPDATE ON company_profile_heads FOR EACH ROW EXECUTE FUNCTION company_profile_guard_head_mutation();

CREATE TRIGGER company_profile_heads_validate BEFORE INSERT OR UPDATE ON company_profile_heads FOR EACH ROW EXECUTE FUNCTION company_profile_validate_head();

CREATE TRIGGER company_profile_revisions_immutable BEFORE DELETE OR UPDATE ON company_profile_revisions FOR EACH ROW EXECUTE FUNCTION company_profile_reject_history_mutation();

CREATE TRIGGER company_profile_revisions_validate BEFORE INSERT OR UPDATE ON company_profile_revisions FOR EACH ROW EXECUTE FUNCTION company_profile_validate_revision();

CREATE TRIGGER company_profile_snapshots_immutable BEFORE DELETE OR UPDATE ON company_profile_snapshots FOR EACH ROW EXECUTE FUNCTION company_profile_reject_snapshot_mutation();

CREATE TRIGGER company_profile_snapshots_validate BEFORE INSERT ON company_profile_snapshots FOR EACH ROW EXECUTE FUNCTION company_profile_validate_snapshot();

CREATE TRIGGER computer_sessions_default_device_workspace_trg BEFORE INSERT OR UPDATE OF device_id, device_workspace_id ON computer_sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.default_interaction_device_workspace();

CREATE TRIGGER connect_attempt_origin_guard BEFORE UPDATE ON connect_attempts FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_connect_attempt_origin();

CREATE TRIGGER connections_authority_binding BEFORE INSERT OR UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.bind_connection_authority();

CREATE TRIGGER connections_invalidate_stale_verified_install BEFORE UPDATE OF subject_id, provider_domain, kind, credential_encrypted, granted_scopes, metadata, version, verified_install_at, verified_install_version ON connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.invalidate_stale_verified_install();

CREATE TRIGGER connections_sync_slack_installation_binding AFTER INSERT OR UPDATE OF account_id, workspace_id, subject_id, provider_domain, kind, status, granted_scopes, metadata, version, verified_install_at, verified_install_version ON connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.sync_slack_installation_binding();

CREATE TRIGGER connector_action_requests_identity_immutable BEFORE UPDATE ON connector_action_requests FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_connector_action_request_identity_mutation();

CREATE TRIGGER credit_grant_observation AFTER INSERT ON credit_ledger_entries FOR EACH ROW WHEN (((new.type = ANY (ARRAY['grant'::text, 'manual_credit_grant'::text])) AND (new.amount_micros > 0))) EXECUTE FUNCTION opengeni_private.observe_credit_grant();

CREATE TRIGGER credit_ledger_allowance_debit AFTER INSERT ON credit_ledger_entries FOR EACH ROW WHEN (((new.amount_micros < 0) AND (new.workspace_id IS NOT NULL))) EXECUTE FUNCTION count_workspace_allowance_debit();

CREATE TRIGGER credit_ledger_expired_plan_refund AFTER INSERT ON credit_ledger_entries FOR EACH ROW WHEN (((new.type = 'video_generation_refund'::text) AND (new.amount_micros > 0))) EXECUTE FUNCTION opengeni_private.expire_refunded_plan_credit();

CREATE TRIGGER credit_ledger_video_allowance_refund AFTER INSERT ON credit_ledger_entries FOR EACH ROW WHEN (((new.amount_micros > 0) AND (new.type = 'video_generation_refund'::text))) EXECUTE FUNCTION reverse_video_allowance_refund();

CREATE TRIGGER document_authority_reclassifications_immutable BEFORE DELETE OR UPDATE ON document_authority_reclassifications FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_migration_receipt_mutation();

CREATE TRIGGER document_billing_attribution_immutable BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION knowledge_index_attribution_immutable();

CREATE TRIGGER document_chunks_authority_guard BEFORE INSERT OR UPDATE ON document_chunks FOR EACH ROW EXECUTE FUNCTION opengeni_private.apply_document_chunk_authority();

CREATE TRIGGER document_default_collection_backfill_operations_immutable BEFORE DELETE OR UPDATE ON document_default_collection_backfill_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_migration_receipt_mutation();

CREATE TRIGGER document_default_collection_backfill_receipts_immutable BEFORE DELETE OR UPDATE ON document_default_collection_backfill_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_migration_receipt_mutation();

CREATE TRIGGER documents_authority_guard BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION opengeni_private.apply_document_authority();

CREATE TRIGGER documents_index_completion_stamp BEFORE INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION opengeni_private.stamp_document_index_completion();

CREATE TRIGGER documents_personal_authority_revoke AFTER DELETE ON documents FOR EACH ROW EXECUTE FUNCTION revoke_personal_document_authority_after_delete();

CREATE TRIGGER editable_artifact_blob_refs_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_blob_refs FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE TRIGGER editable_artifact_checkpoints_insert_guard BEFORE INSERT ON editable_artifact_sequence_checkpoints FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();

CREATE TRIGGER editable_artifact_idempotency_receipts_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE CONSTRAINT TRIGGER editable_artifact_idempotency_receipts_projection_guard AFTER INSERT ON editable_artifact_idempotency_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE CONSTRAINT TRIGGER editable_artifact_live_outbox_projection_guard AFTER INSERT ON editable_artifact_live_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE TRIGGER editable_artifact_live_outbox_transaction_insert_guard BEFORE INSERT ON editable_artifact_live_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();

CREATE TRIGGER editable_artifact_live_outbox_update_guard BEFORE INSERT OR UPDATE ON editable_artifact_live_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_mutable_state();

CREATE CONSTRAINT TRIGGER editable_artifact_materialization_jobs_projection_guard AFTER INSERT OR UPDATE ON editable_artifact_materialization_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE TRIGGER editable_artifact_materialization_jobs_update_guard BEFORE INSERT OR UPDATE ON editable_artifact_materialization_jobs FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_mutable_state();

CREATE TRIGGER editable_artifact_materialization_results_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_materialization_results FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE CONSTRAINT TRIGGER editable_artifact_materialization_results_projection_guard AFTER INSERT ON editable_artifact_materialization_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE TRIGGER editable_artifact_operations_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE TRIGGER editable_artifact_operations_insert_guard BEFORE INSERT ON editable_artifact_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();

CREATE TRIGGER editable_artifact_receipts_insert_guard BEFORE INSERT ON editable_artifact_idempotency_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();

CREATE CONSTRAINT TRIGGER editable_artifact_replica_leases_projection_guard AFTER INSERT OR UPDATE ON editable_artifact_replica_leases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE TRIGGER editable_artifact_replica_leases_update_guard BEFORE UPDATE ON editable_artifact_replica_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_mutable_state();

CREATE TRIGGER editable_artifact_sequence_checkpoints_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_sequence_checkpoints FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE TRIGGER editable_artifact_snapshots_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_snapshots FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE CONSTRAINT TRIGGER editable_artifact_snapshots_projection_guard AFTER INSERT ON editable_artifact_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE CONSTRAINT TRIGGER editable_artifact_transactions_commit_guard AFTER INSERT ON editable_artifact_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_transaction_commit();

CREATE TRIGGER editable_artifact_transactions_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_transactions FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE TRIGGER editable_artifact_undo_claims_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_undo_claims FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE TRIGGER editable_artifact_undo_claims_insert_guard BEFORE INSERT ON editable_artifact_undo_claims FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert();

CREATE TRIGGER editable_artifact_versions_immutable_guard BEFORE DELETE OR UPDATE ON editable_artifact_versions FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_editable_artifact_history_mutation();

CREATE CONSTRAINT TRIGGER editable_artifact_versions_projection_guard AFTER INSERT ON editable_artifact_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_version_projection();

CREATE CONSTRAINT TRIGGER editable_artifacts_projection_guard AFTER INSERT OR UPDATE ON editable_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_editable_artifact_projection();

CREATE TRIGGER editable_artifacts_update_guard BEFORE UPDATE ON editable_artifacts FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_editable_artifact_update();

CREATE TRIGGER explicit_workspace_recovery_publication_guard BEFORE UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION guard_explicit_workspace_recovery_publication();

CREATE TRIGGER explicit_workspace_recovery_warning_guard BEFORE INSERT ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION guard_explicit_workspace_recovery_warning();

CREATE TRIGGER external_identity_link_lifecycle BEFORE INSERT OR UPDATE ON external_identity_links FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_external_identity_link_lifecycle();

CREATE TRIGGER external_link_task_snapshot_guard BEFORE INSERT OR UPDATE ON external_link_task_authorities FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_external_link_work_snapshot();

CREATE TRIGGER external_link_turn_snapshot_guard BEFORE INSERT OR UPDATE ON external_link_turn_authorities FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_external_link_work_snapshot();

CREATE TRIGGER file_upload_owner_immutable BEFORE UPDATE ON file_uploads FOR EACH ROW EXECUTE FUNCTION knowledge_media_file_owner_immutable();
