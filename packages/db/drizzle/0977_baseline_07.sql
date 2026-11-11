-- deployment-mode: rolling
-- Opengeni baseline part 7 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_goals
    ADD CONSTRAINT session_goals_pkey PRIMARY KEY (id);

ALTER TABLE session_history_items
    ADD CONSTRAINT session_history_items_item_codec_version_chk CHECK (((item_codec_version IS NULL) OR (item_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_history_items
    ADD CONSTRAINT session_history_items_pkey PRIMARY KEY (id);

ALTER TABLE session_history_items
    ADD CONSTRAINT session_history_items_provider_artifact_invalidation_shape_chk CHECK ((((provider_artifact_invalidated_at IS NULL) AND (provider_artifact_invalidation_reason IS NULL) AND (provider_artifact_invalidated_by_attempt_id IS NULL)) OR ((provider_artifact_invalidated_at IS NOT NULL) AND (provider_artifact_invalidation_reason = 'encrypted_content_rejected'::text) AND (provider_artifact_invalidated_by_attempt_id IS NOT NULL) AND ((item ->> 'type'::text) = ANY (ARRAY['reasoning'::text, 'compaction'::text]))))) NOT VALID;

ALTER TABLE ONLY session_history_items_repair_audit
    ADD CONSTRAINT session_history_items_repair_audit_pkey PRIMARY KEY (id);

ALTER TABLE session_human_input_requests
    ADD CONSTRAINT session_human_input_requests_origin_check CHECK ((origin = ANY (ARRAY['tool_call'::text, 'secret_use_approval'::text]))) NOT VALID;

ALTER TABLE ONLY session_human_input_requests
    ADD CONSTRAINT session_human_input_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_list_snapshots
    ADD CONSTRAINT session_list_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_mcp_servers
    ADD CONSTRAINT session_mcp_servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_message_search_texts
    ADD CONSTRAINT session_message_search_texts_pkey PRIMARY KEY (workspace_id, session_id, sequence);

ALTER TABLE session_pending_tool_calls
    ADD CONSTRAINT session_pending_tool_calls_call_codec_version_chk CHECK (((call_item_codec_version IS NULL) OR (call_item_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT session_pending_tool_calls_pkey PRIMARY KEY (id);

ALTER TABLE session_pending_tool_calls
    ADD CONSTRAINT session_pending_tool_calls_result_codec_version_chk CHECK (((result_item_codec_version IS NULL) OR (result_item_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_realtime_connections
    ADD CONSTRAINT session_realtime_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_realtime_context_projections
    ADD CONSTRAINT session_realtime_context_projections_pkey PRIMARY KEY (id);

ALTER TABLE session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_payload_codec_version_chk CHECK (((payload_codec_version IS NULL) OR (payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_pkey PRIMARY KEY (id);

ALTER TABLE session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_text_codec_version_chk CHECK (((text_codec_version IS NULL) OR (text_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_realtime_modes
    ADD CONSTRAINT session_realtime_modes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_recordings
    ADD CONSTRAINT session_recordings_pkey PRIMARY KEY (id);

ALTER TABLE session_recordings
    ADD CONSTRAINT session_recordings_reason_codec_version_chk CHECK (((reason_codec_version IS NULL) OR (reason_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_spawn_denials
    ADD CONSTRAINT session_spawn_denials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_stream_acknowledgments
    ADD CONSTRAINT session_stream_acknowledgments_pkey PRIMARY KEY (id);

ALTER TABLE session_system_update_outbox
    ADD CONSTRAINT session_system_update_outbox_payload_codec_version_chk CHECK (((payload_codec_version IS NULL) OR (payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_system_update_outbox
    ADD CONSTRAINT session_system_update_outbox_pkey PRIMARY KEY (id);

ALTER TABLE session_system_update_outbox
    ADD CONSTRAINT session_system_update_outbox_summary_codec_version_chk CHECK (((summary_codec_version IS NULL) OR (summary_codec_version = 1))) NOT VALID;

ALTER TABLE session_system_updates
    ADD CONSTRAINT session_system_updates_payload_codec_version_chk CHECK (((payload_codec_version IS NULL) OR (payload_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT session_system_updates_pkey PRIMARY KEY (id);

ALTER TABLE session_system_updates
    ADD CONSTRAINT session_system_updates_summary_codec_version_chk CHECK (((summary_codec_version IS NULL) OR (summary_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_tenancy_activations
    ADD CONSTRAINT session_tenancy_activations_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organ_organization_membership_id_key UNIQUE (organization_membership_id);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organiz_private_setting_event_id_key UNIQUE (private_setting_event_id);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organizati_creation_operation_id_key UNIQUE (creation_operation_id);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organizati_personal_workspace_id_key UNIQUE (personal_workspace_id);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organization_activation_evidenc_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence
    ADD CONSTRAINT session_tenancy_additional_organization_shared_workspace_id_key UNIQUE (shared_workspace_id);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activ_organization_membership_id_key UNIQUE (organization_membership_id);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activat_private_setting_event_id_key UNIQUE (private_setting_event_id);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_ev_setup_auth_user_id_key UNIQUE (setup_auth_user_id);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_ev_setup_operation_id_key UNIQUE (setup_operation_id);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_evidence_pkey PRIMARY KEY (account_id);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence
    ADD CONSTRAINT session_tenancy_greenfield_activation_personal_workspace_id_key UNIQUE (personal_workspace_id);

ALTER TABLE ONLY session_title_operations
    ADD CONSTRAINT session_title_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_turn_app_action_grants
    ADD CONSTRAINT session_turn_app_action_grants_pkey PRIMARY KEY (turn_id);

ALTER TABLE ONLY session_turn_attempts
    ADD CONSTRAINT session_turn_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_turn_machine_consents
    ADD CONSTRAINT session_turn_machine_consents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_turn_machine_consents
    ADD CONSTRAINT session_turn_machine_consents_turn_id_enrollment_id_route_e_key UNIQUE (turn_id, enrollment_id, route_epoch);

ALTER TABLE ONLY session_turn_startup_milestones
    ADD CONSTRAINT session_turn_startup_milestones_pkey PRIMARY KEY (workspace_id, turn_id, milestone, outcome);

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_pkey PRIMARY KEY (id);

ALTER TABLE session_turns
    ADD CONSTRAINT session_turns_prompt_codec_version_chk CHECK (((prompt_codec_version IS NULL) OR (prompt_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_session_position_uq UNIQUE (workspace_id, session_id, "position");

ALTER TABLE ONLY session_variable_set_attachments
    ADD CONSTRAINT session_variable_set_attachments_session_set_uq UNIQUE (workspace_id, session_id, variable_set_id);

ALTER TABLE ONLY session_visibility_write_capabilities
    ADD CONSTRAINT session_visibility_write_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_id);

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_work_claim_write_capabilities
    ADD CONSTRAINT session_work_claim_write_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_id);

ALTER TABLE ONLY session_work_claims
    ADD CONSTRAINT session_work_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_workflow_wake_outbox
    ADD CONSTRAINT session_workflow_wake_outbox_pkey PRIMARY KEY (session_id);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_initial_message_codec_version_chk CHECK (((initial_message_codec_version IS NULL) OR (initial_message_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_tool_policy_version_check CHECK ((tool_policy_version >= 1)) NOT VALID;

ALTER TABLE ONLY site_abuse_reports
    ADD CONSTRAINT site_abuse_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_auth_codes
    ADD CONSTRAINT site_auth_codes_code_hash_key UNIQUE (code_hash);

ALTER TABLE ONLY site_auth_codes
    ADD CONSTRAINT site_auth_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_auth_connections
    ADD CONSTRAINT site_auth_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_auth_connections
    ADD CONSTRAINT site_auth_connections_workspace_create_operation_uq UNIQUE (workspace_id, create_operation_id);

ALTER TABLE ONLY site_auth_connections
    ADD CONSTRAINT site_auth_connections_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY site_data_collections
    ADD CONSTRAINT site_data_collections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_data_files
    ADD CONSTRAINT site_data_files_object_key_key UNIQUE (object_key);

ALTER TABLE ONLY site_data_files
    ADD CONSTRAINT site_data_files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_data_rate_windows
    ADD CONSTRAINT site_data_rate_windows_pkey PRIMARY KEY (workspace_id, site_id, principal_key);

ALTER TABLE ONLY site_data_record_values
    ADD CONSTRAINT site_data_record_values_pkey PRIMARY KEY (record_id, kind, name);

ALTER TABLE ONLY site_data_records
    ADD CONSTRAINT site_data_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_data_usage
    ADD CONSTRAINT site_data_usage_pkey PRIMARY KEY (workspace_id, site_id);

ALTER TABLE ONLY site_data_validation_windows
    ADD CONSTRAINT site_data_validation_windows_pkey PRIMARY KEY (workspace_id, site_id);

ALTER TABLE ONLY site_data_workspace_validation_windows
    ADD CONSTRAINT site_data_workspace_validation_windows_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY site_hostname_holds
    ADD CONSTRAINT site_hostname_holds_pkey PRIMARY KEY (label);

ALTER TABLE ONLY site_hostnames
    ADD CONSTRAINT site_hostnames_pkey PRIMARY KEY (label);

ALTER TABLE ONLY site_limit_profiles
    ADD CONSTRAINT site_limit_profiles_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY site_opens
    ADD CONSTRAINT site_opens_pkey PRIMARY KEY (workspace_id, subject_id, site_id);

ALTER TABLE ONLY site_platform_brake
    ADD CONSTRAINT site_platform_brake_pkey PRIMARY KEY (period_start);

ALTER TABLE ONLY site_platform_storage
    ADD CONSTRAINT site_platform_storage_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY site_platform_totals
    ADD CONSTRAINT site_platform_totals_pkey PRIMARY KEY (period_start, shard);

ALTER TABLE ONLY site_platform_usage
    ADD CONSTRAINT site_platform_usage_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY site_publications
    ADD CONSTRAINT site_publications_pkey PRIMARY KEY (site_id);

ALTER TABLE site_runtime_conversations
    ADD CONSTRAINT site_runtime_conversations_budget_key_check CHECK ((budget_key = ANY (ARRAY['*'::text, '*members'::text]))) NOT VALID;

ALTER TABLE ONLY site_runtime_conversations
    ADD CONSTRAINT site_runtime_conversations_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY site_runtime_rate_windows
    ADD CONSTRAINT site_runtime_rate_windows_pkey PRIMARY KEY (workspace_id, site_id, principal_key, bucket);

ALTER TABLE ONLY site_runtime_usage
    ADD CONSTRAINT site_runtime_usage_pkey PRIMARY KEY (workspace_id, site_id, principal_key, period);

ALTER TABLE ONLY site_session_access
    ADD CONSTRAINT site_session_access_pkey PRIMARY KEY (workspace_id, site_id, session_id);

ALTER TABLE ONLY site_sidebar_states
    ADD CONSTRAINT site_sidebar_states_pkey PRIMARY KEY (workspace_id, subject_id, site_id);

ALTER TABLE ONLY site_sql_databases
    ADD CONSTRAINT site_sql_databases_pkey PRIMARY KEY (workspace_id, site_id);

ALTER TABLE ONLY site_sql_migrations
    ADD CONSTRAINT site_sql_migrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_sql_queries
    ADD CONSTRAINT site_sql_queries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_sql_rate_windows
    ADD CONSTRAINT site_sql_rate_windows_pkey PRIMARY KEY (workspace_id, site_id, principal_key);

ALTER TABLE ONLY site_sql_usage
    ADD CONSTRAINT site_sql_usage_pkey PRIMARY KEY (workspace_id, site_id);

ALTER TABLE ONLY site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE site_viewer_sessions
    ADD CONSTRAINT site_viewer_sessions_view_as_check CHECK (((view_as IS NULL) OR (view_as = ANY (ARRAY['invited'::text, 'public'::text])))) NOT VALID;

ALTER TABLE ONLY skill_config_conversion_receipts
    ADD CONSTRAINT skill_config_conversion_receipts_pkey PRIMARY KEY (workspace_id, source_kind, source_id, conversion_version);

ALTER TABLE ONLY skill_source_bindings
    ADD CONSTRAINT skill_source_bindings_pkey PRIMARY KEY (workspace_id, plugin_id, facet_key);

ALTER TABLE ONLY skill_source_bindings
    ADD CONSTRAINT skill_source_bindings_preference_id_key UNIQUE (preference_id);

ALTER TABLE ONLY skill_write_receipts
    ADD CONSTRAINT skill_write_receipts_pkey PRIMARY KEY (workspace_id, operation_id);

ALTER TABLE ONLY slack_api_rate_limits
    ADD CONSTRAINT slack_api_rate_limits_pkey PRIMARY KEY (scope_hash);

ALTER TABLE ONLY slack_app_home_refreshes
    ADD CONSTRAINT slack_app_home_refreshes_connection_user_uq UNIQUE (connection_id, slack_user_id);

ALTER TABLE ONLY slack_app_home_refreshes
    ADD CONSTRAINT slack_app_home_refreshes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_bot_delete_operations
    ADD CONSTRAINT slack_bot_delete_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_bot_delete_operations
    ADD CONSTRAINT slack_bot_delete_operations_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY slack_bot_post_operations
    ADD CONSTRAINT slack_bot_post_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_bot_post_operations
    ADD CONSTRAINT slack_bot_post_operations_workspace_operation_uq UNIQUE (workspace_id, connection_id, operation_id);

ALTER TABLE ONLY slack_bot_update_operations
    ADD CONSTRAINT slack_bot_update_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_bot_update_operations
    ADD CONSTRAINT slack_bot_update_operations_workspace_operation_uq UNIQUE (workspace_id, connection_id, operation_id);

ALTER TABLE ONLY slack_bot_user_links
    ADD CONSTRAINT slack_bot_user_links_connection_user_uq UNIQUE (connection_id, slack_user_id);

ALTER TABLE ONLY slack_bot_user_links
    ADD CONSTRAINT slack_bot_user_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_channel_uq UNIQUE (connection_id, slack_channel_id);

ALTER TABLE ONLY slack_channel_routes
    ADD CONSTRAINT slack_channel_routes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_installation_bindings
    ADD CONSTRAINT slack_installation_bindings_connection_uq UNIQUE (connection_id);

ALTER TABLE ONLY slack_installation_bindings
    ADD CONSTRAINT slack_installation_bindings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_identity_uq UNIQUE (interaction_id, session_event_sequence, action_key);

ALTER TABLE ONLY slack_interaction_action_handles
    ADD CONSTRAINT slack_interaction_action_handles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_interaction_inbox
    ADD CONSTRAINT slack_interaction_inbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_interaction_inbox
    ADD CONSTRAINT slack_interaction_inbox_provider_event_uq UNIQUE (connection_id, provider_event_id);

ALTER TABLE ONLY slack_interaction_inbox
    ADD CONSTRAINT slack_interaction_inbox_provider_message_uq UNIQUE (connection_id, provider_message_id);

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_event_uq UNIQUE (interaction_id, session_event_sequence);

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_slot_uq UNIQUE (interaction_id, slot);

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_identity_uq UNIQUE (account_id, workspace_id, id);

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_route_uq UNIQUE (connection_id, route_key);

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_prompt_position_uq UNIQUE (prompt_id, "position");

ALTER TABLE ONLY slack_route_prompt_options
    ADD CONSTRAINT slack_route_prompt_options_prompt_workspace_uq UNIQUE (prompt_id, candidate_workspace_id);

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_event_uq UNIQUE (connection_id, provider_event_id);

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_identity_uq UNIQUE (account_id, workspace_id, id);

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_inbox_uq UNIQUE (connection_id, inbox_id);

ALTER TABLE ONLY slack_route_prompts
    ADD CONSTRAINT slack_route_prompts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_identity_uq UNIQUE (workspace_id, session_id);

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_pkey PRIMARY KEY (interaction_id);

ALTER TABLE ONLY slack_task_policy_activation_events
    ADD CONSTRAINT slack_task_policy_activation_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_task_policy_activation_events
    ADD CONSTRAINT slack_task_policy_events_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY slack_task_policy_activation_events
    ADD CONSTRAINT slack_task_policy_events_workspace_version_uq UNIQUE (workspace_id, activation_version);

ALTER TABLE ONLY slack_task_policy_heads
    ADD CONSTRAINT slack_task_policy_heads_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_workspace_identity_uq UNIQUE (account_id, workspace_id, id);

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_workspace_revision_uq UNIQUE (workspace_id, revision);

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_user_dm_routes
    ADD CONSTRAINT slack_user_dm_routes_user_uq UNIQUE (connection_id, slack_user_id);

ALTER TABLE ONLY slack_user_link_access_request_operations
    ADD CONSTRAINT slack_user_link_access_request_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_user_link_access_requests
    ADD CONSTRAINT slack_user_link_access_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_user_link_access_requests
    ADD CONSTRAINT slack_user_link_access_requests_tenant_uq UNIQUE (id, workspace_id, account_id);

ALTER TABLE ONLY social_connections
    ADD CONSTRAINT social_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY social_posts
    ADD CONSTRAINT social_posts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY subscription_apps_designations
    ADD CONSTRAINT subscription_apps_designations_pkey PRIMARY KEY (workspace_id);

ALTER TABLE subscription_capacity_waiters
    ADD CONSTRAINT subscription_capacity_waiters_goal_fence_chk CHECK ((((goal_id IS NULL) AND (goal_version IS NULL)) OR ((goal_id IS NOT NULL) AND (goal_version IS NOT NULL) AND (goal_version > 0)))) NOT VALID;

ALTER TABLE subscription_capacity_waiters
    ADD CONSTRAINT subscription_capacity_waiters_last_wake_reason_chk CHECK (((last_wake_reason IS NULL) OR ((length(btrim(last_wake_reason)) >= 1) AND (length(btrim(last_wake_reason)) <= 128)))) NOT VALID;

ALTER TABLE ONLY subscription_capacity_waiters
    ADD CONSTRAINT subscription_capacity_waiters_pkey PRIMARY KEY (workspace_id, session_id);

ALTER TABLE ONLY subscription_capacity_wake_outbox
    ADD CONSTRAINT subscription_capacity_wake_outbox_identity_uq UNIQUE (account_id, waiter_id, generation, wake_revision);

ALTER TABLE ONLY subscription_capacity_wake_outbox
    ADD CONSTRAINT subscription_capacity_wake_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY subscription_connection_aliases
    ADD CONSTRAINT subscription_connection_aliases_pkey PRIMARY KEY (account_id, provider, alias_connection_id);

ALTER TABLE ONLY subscription_connection_assignment_policies
    ADD CONSTRAINT subscription_connection_assignment_policies_pkey PRIMARY KEY (account_id, connection_id, workspace_id, inference_pool);

ALTER TABLE ONLY subscription_connection_people
    ADD CONSTRAINT subscription_connection_people_pkey PRIMARY KEY (connection_id, organization_membership_id);

ALTER TABLE ONLY subscription_connection_quota
    ADD CONSTRAINT subscription_connection_quota_pkey PRIMARY KEY (connection_id);

ALTER TABLE ONLY subscription_connection_workspaces
    ADD CONSTRAINT subscription_connection_workspaces_pkey PRIMARY KEY (connection_id, workspace_id);

ALTER TABLE ONLY subscription_connections
    ADD CONSTRAINT subscription_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY subscription_leases
    ADD CONSTRAINT subscription_leases_pkey PRIMARY KEY (workspace_id, turn_id);

ALTER TABLE ONLY subscription_operation_leases
    ADD CONSTRAINT subscription_operation_leases_pkey PRIMARY KEY (account_id, operation_id);

ALTER TABLE ONLY subscription_person_preferences
    ADD CONSTRAINT subscription_person_preferences_pkey PRIMARY KEY (account_id, organization_membership_id);

ALTER TABLE ONLY subscription_provider_cutovers
    ADD CONSTRAINT subscription_provider_cutovers_pkey PRIMARY KEY (account_id, provider);

ALTER TABLE ONLY subscription_session_bindings
    ADD CONSTRAINT subscription_session_bindings_pkey PRIMARY KEY (workspace_id, session_id, provider);

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_account_id_workspace_id_key UNIQUE NULLS NOT DISTINCT (account_id, workspace_id);

ALTER TABLE ONLY subscription_settings
    ADD CONSTRAINT subscription_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY subscription_turn_failures
    ADD CONSTRAINT subscription_turn_failures_pkey PRIMARY KEY (workspace_id, turn_id, connection_id);

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY task_note_knowledge_promotion_capabilities
    ADD CONSTRAINT task_note_knowledge_promotion_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_id);

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_workspace_replacement_uq UNIQUE (workspace_id, replacement_note_id);

ALTER TABLE ONLY task_note_write_capabilities
    ADD CONSTRAINT task_note_write_capabilities_pkey PRIMARY KEY (backend_pid, transaction_id, capability_id);

ALTER TABLE ONLY task_notes
    ADD CONSTRAINT task_notes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY teams_bot_inbox
    ADD CONSTRAINT teams_bot_inbox_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY teams_bot_installations
    ADD CONSTRAINT teams_bot_installations_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY teams_bot_installations
    ADD CONSTRAINT teams_bot_installations_tenant_id_workspace_id_key UNIQUE (tenant_id, workspace_id);

ALTER TABLE ONLY teams_bot_installations
    ADD CONSTRAINT teams_bot_installations_workspace_id_key UNIQUE (workspace_id);

ALTER TABLE ONLY teams_bot_links
    ADD CONSTRAINT teams_bot_links_pkey PRIMARY KEY (tenant_id, actor_id);

ALTER TABLE ONLY teams_bot_links
    ADD CONSTRAINT teams_bot_links_workspace_id_subject_id_key UNIQUE (workspace_id, subject_id);

ALTER TABLE ONLY teams_bot_outbox
    ADD CONSTRAINT teams_bot_outbox_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY teams_bot_proofs
    ADD CONSTRAINT teams_bot_proofs_pkey PRIMARY KEY (nonce);

ALTER TABLE ONLY teams_bot_routes
    ADD CONSTRAINT teams_bot_routes_pkey PRIMARY KEY (route_id);

ALTER TABLE ONLY teams_bot_routes
    ADD CONSTRAINT teams_bot_routes_route_id_workspace_id_account_id_key UNIQUE (route_id, workspace_id, account_id);

ALTER TABLE ONLY temporal_schedule_cleanup_outbox
    ADD CONSTRAINT temporal_schedule_cleanup_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenancy_backfill_receipts
    ADD CONSTRAINT tenancy_backfill_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenancy_backfill_unresolved_rows
    ADD CONSTRAINT tenancy_backfill_unresolved_rows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tool_gateway_approval_capabilities
    ADD CONSTRAINT tool_gateway_approval_capabilities_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY transcription_recording_chunks
    ADD CONSTRAINT transcription_recording_chunks_object_key_uq UNIQUE (object_key);

ALTER TABLE ONLY transcription_recording_chunks
    ADD CONSTRAINT transcription_recording_chunks_pk PRIMARY KEY (recording_id, chunk_number);

ALTER TABLE ONLY transcription_recording_objects
    ADD CONSTRAINT transcription_recording_objects_pkey PRIMARY KEY (object_key);

ALTER TABLE ONLY transcription_recording_segments
    ADD CONSTRAINT transcription_recording_segments_object_key_uq UNIQUE (object_key);

ALTER TABLE ONLY transcription_recording_segments
    ADD CONSTRAINT transcription_recording_segments_pk PRIMARY KEY (recording_id, segment_number);

ALTER TABLE transcription_recording_segments
    ADD CONSTRAINT transcription_recording_segments_text_codec_version_chk CHECK (((transcript_text_codec_version IS NULL) OR (transcript_text_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY transcription_recordings
    ADD CONSTRAINT transcription_recordings_exact_authority_uq UNIQUE (account_id, workspace_id, subject_id, id);

ALTER TABLE ONLY transcription_recordings
    ADD CONSTRAINT transcription_recordings_pkey PRIMARY KEY (id);

ALTER TABLE transcription_recordings
    ADD CONSTRAINT transcription_recordings_text_codec_version_chk CHECK (((transcript_text_codec_version IS NULL) OR (transcript_text_codec_version = 1))) NOT VALID;

ALTER TABLE ONLY turn_connection_authority_snapshots
    ADD CONSTRAINT turn_connection_authority_snapshots_pkey PRIMARY KEY (turn_id, server_id);

ALTER TABLE ONLY turn_personal_resource_attachment_receipts
    ADD CONSTRAINT turn_personal_resource_attachment_receipts_pkey PRIMARY KEY (turn_id);

ALTER TABLE ONLY turn_personal_resource_once_receipts
    ADD CONSTRAINT turn_personal_resource_once_receipts_pkey PRIMARY KEY (grant_id);

ALTER TABLE ONLY turn_personal_resource_snapshots
    ADD CONSTRAINT turn_personal_resource_snapshots_pkey PRIMARY KEY (turn_id, resource_kind, resource_id);

ALTER TABLE ONLY usage_events
    ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY vault_field_versions
    ADD CONSTRAINT vault_field_versions_pkey PRIMARY KEY (field_id, version);

ALTER TABLE ONLY vault_item_fields
    ADD CONSTRAINT vault_item_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY vault_item_name_aliases
    ADD CONSTRAINT vault_item_name_aliases_pkey PRIMARY KEY (vault_id, name_key);

ALTER TABLE ONLY vault_items
    ADD CONSTRAINT vault_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY vault_name_aliases
    ADD CONSTRAINT vault_name_aliases_pkey PRIMARY KEY (account_id, scope_key, name_key);

ALTER TABLE ONLY vault_passkey_leases
    ADD CONSTRAINT vault_passkey_leases_pkey PRIMARY KEY (item_id);

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_pkey PRIMARY KEY (id);

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY video_generation_references
    ADD CONSTRAINT video_generation_references_pk PRIMARY KEY (operation_id, ordinal);

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_operation_uq UNIQUE (workspace_id, operation_key);

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_artifact_uploads
    ADD CONSTRAINT workspace_artifact_uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_operation_uq UNIQUE (workspace_id, operation_key);

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_revision_uq UNIQUE (workspace_id, artifact_id, revision);

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_workspace_slug_uq UNIQUE (workspace_id, slug);

ALTER TABLE ONLY workspace_captures
    ADD CONSTRAINT workspace_captures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_codex_subscription_preferences
    ADD CONSTRAINT workspace_codex_subscription_preferences_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_control_events
    ADD CONSTRAINT workspace_control_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_credential_providers
    ADD CONSTRAINT workspace_credential_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_variable_set_variables
    ADD CONSTRAINT workspace_environment_variables_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_variable_sets
    ADD CONSTRAINT workspace_environments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_gateway_custom_models
    ADD CONSTRAINT workspace_gateway_custom_models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_inference_controls
    ADD CONSTRAINT workspace_inference_controls_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_instruction_policy_activation_events
    ADD CONSTRAINT workspace_instruction_policy_activation_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_instruction_policy_deactivation_events
    ADD CONSTRAINT workspace_instruction_policy_deactivate_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY workspace_instruction_policy_deactivation_events
    ADD CONSTRAINT workspace_instruction_policy_deactivation_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_instruction_policy_heads
    ADD CONSTRAINT workspace_instruction_policy_heads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals
    ADD CONSTRAINT workspace_instruction_policy_onboarding_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals
    ADD CONSTRAINT workspace_instruction_policy_onboarding_proposals_workspace_ope UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY workspace_instruction_policy_revisions
    ADD CONSTRAINT workspace_instruction_policy_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_instruction_policy_revisions
    ADD CONSTRAINT workspace_instruction_policy_revisions_workspace_revision_uq UNIQUE (workspace_id, revision);

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_attempt_uq UNIQUE (account_id, workspace_id, attempt_id);

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_interaction_revisions
    ADD CONSTRAINT workspace_interaction_revisions_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_learning_policy_activation_events
    ADD CONSTRAINT workspace_learning_policy_activation_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_learning_policy_activation_events
    ADD CONSTRAINT workspace_learning_policy_events_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY workspace_learning_policy_activation_events
    ADD CONSTRAINT workspace_learning_policy_events_workspace_version_uq UNIQUE (workspace_id, activation_version);

ALTER TABLE ONLY workspace_learning_policy_heads
    ADD CONSTRAINT workspace_learning_policy_heads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_learning_policy_heads
    ADD CONSTRAINT workspace_learning_policy_heads_workspace_uq UNIQUE (workspace_id);

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_workspace_identity_uq UNIQUE (account_id, workspace_id, id);

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_workspace_operation_uq UNIQUE (workspace_id, operation_id);

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_workspace_revision_uq UNIQUE (workspace_id, revision);

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_attempt_uq UNIQUE (account_id, workspace_id, attempt_id);

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_memberships
    ADD CONSTRAINT workspace_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_model_policies
    ADD CONSTRAINT workspace_model_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_screenshot_quotas
    ADD CONSTRAINT workspace_screenshot_quotas_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_session_activity_revisions
    ADD CONSTRAINT workspace_session_activity_revisions_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_video_generation_policies
    ADD CONSTRAINT workspace_video_generation_policies_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_video_generation_quotas
    ADD CONSTRAINT workspace_video_generation_quotas_pkey PRIMARY KEY (workspace_id);

ALTER TABLE ONLY workspace_webhook_deliveries
    ADD CONSTRAINT workspace_webhook_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_webhooks
    ADD CONSTRAINT workspace_webhooks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_webhooks
    ADD CONSTRAINT workspace_webhooks_workspace_id_uq UNIQUE (workspace_id, id);

ALTER TABLE ONLY workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY xai_capacity_waiters
    ADD CONSTRAINT xai_capacity_waiters_pkey PRIMARY KEY (id);

ALTER TABLE ONLY xai_credential_leases
    ADD CONSTRAINT xai_credential_leases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY xai_rotation_settings
    ADD CONSTRAINT xai_rotation_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY xai_session_account_pins
    ADD CONSTRAINT xai_session_account_pins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY xai_subscription_credentials
    ADD CONSTRAINT xai_subscription_credentials_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX automatic_title_fanout_event_uq ON opengeni_private.automatic_session_title_fanout_outbox_v1 USING btree (event_id);

CREATE INDEX automatic_title_fanout_pending_idx ON opengeni_private.automatic_session_title_fanout_outbox_v1 USING btree (created_at, id) WHERE (delivered_at IS NULL);

CREATE INDEX inbox_items_recipient_open_idx ON opengeni_private.inbox_items USING btree (account_id, recipient_subject_id, updated_at DESC) WHERE (status = 'open'::text);

CREATE INDEX inbox_member_notify_optins_person_idx ON opengeni_private.inbox_member_notify_optins USING btree (account_id, subject_id);

CREATE INDEX inbox_session_mutes_person_idx ON opengeni_private.inbox_session_mutes USING btree (account_id, subject_id);

CREATE INDEX inbox_session_mutes_schedule_idx ON opengeni_private.inbox_session_mutes USING btree (scheduled_task_id, subject_id) WHERE (scheduled_task_id IS NOT NULL);

CREATE INDEX insights_usage_hourly_pending ON opengeni_private.insights_usage_hourly_backfill USING btree (workspace_id, hour) WHERE (NOT completed);

CREATE INDEX maintenance_probe_browser_ses_controller_host_sandbox_group_idx ON opengeni_private.maintenance_probe_browser_sessions USING btree (controller_host_sandbox_group_id, placement_instance_id);

CREATE INDEX maintenance_probe_rig_changes_base_version_id_idx ON opengeni_private.maintenance_probe_rig_changes USING btree (base_version_id) WHERE (status = ANY (ARRAY['verifying'::text, 'proposed'::text]));

CREATE INDEX maintenance_probe_sandbox_checkpoint_artif_state_created_at_idx ON opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts USING btree (state, created_at);

CREATE INDEX maintenance_probe_sandbox_lea_current_checkpoint_artifact_i_idx ON opengeni_private.maintenance_probe_sandbox_leases USING btree (current_checkpoint_artifact_id);

CREATE INDEX maintenance_probe_sandbox_lea_previous_checkpoint_artifact__idx ON opengeni_private.maintenance_probe_sandbox_leases USING btree (previous_checkpoint_artifact_id);

CREATE INDEX maintenance_probe_sandbox_lease_hol_lease_id_kind_holder_id_idx ON opengeni_private.maintenance_probe_sandbox_lease_holders USING btree (lease_id, kind, holder_id);

CREATE INDEX maintenance_probe_sandbox_leases_liveness_idx ON opengeni_private.maintenance_probe_sandbox_leases USING btree (liveness);

CREATE INDEX maintenance_probe_sandbox_retained_processe_reconcile_after_idx ON opengeni_private.maintenance_probe_sandbox_retained_processes USING btree (reconcile_after) WHERE (state = 'active'::text);

CREATE INDEX maintenance_probe_sandbox_workspace_mutation_adm_settled_at_idx ON opengeni_private.maintenance_probe_sandbox_workspace_mutation_admissions USING btree (settled_at) WHERE ((settled_at IS NULL) AND (route_kind = 'home'::text) AND (provider_backend = 'modal'::text));

CREATE INDEX maintenance_probe_session_background_comman_reconcile_after_idx ON opengeni_private.maintenance_probe_session_background_commands USING btree (reconcile_after) WHERE ((provider = 'connected_machine'::text) AND (state = ANY (ARRAY['running'::text, 'stopping'::text, 'exited'::text])));

CREATE INDEX maintenance_probe_session_list_snapshots_expires_at_idx ON opengeni_private.maintenance_probe_session_list_snapshots USING btree (expires_at);

CREATE INDEX maintenance_probe_session_system_update_outbox_status_idx ON opengeni_private.maintenance_probe_session_system_update_outbox USING btree (status);

CREATE INDEX maintenance_probe_session_turns_workspace_id_session_id_idx ON opengeni_private.maintenance_probe_session_turns USING btree (workspace_id, session_id) WHERE ((status = 'recovering'::text) AND (metadata ? 'sandboxSetupOutcomeUnknown'::text));

CREATE INDEX maintenance_probe_session_workflow_wake_out_next_attempt_at_idx ON opengeni_private.maintenance_probe_session_workflow_wake_outbox USING btree (next_attempt_at) WHERE (wake_revision > delivered_revision);

CREATE INDEX maintenance_probe_site_auth_connections_next_check_at_idx ON opengeni_private.maintenance_probe_site_auth_connections USING btree (next_check_at) WHERE ((status = 'active'::text) AND ((health_policy ->> 'mode'::text) = 'maintained'::text));

CREATE INDEX native_push_deliveries_pending_idx ON opengeni_private.native_push_deliveries USING btree (next_attempt_at) WHERE ((delivered_at IS NULL) AND (failed_at IS NULL));

CREATE INDEX native_push_devices_subject_idx ON opengeni_private.native_push_devices USING btree (subject_id);

CREATE INDEX sandbox_file_publications_session_idx ON opengeni_private.sandbox_file_publications USING btree (workspace_id, source_session_id, published_at, file_id);

CREATE INDEX sandbox_recovery_operator_receipts_recent_idx ON opengeni_private.sandbox_recovery_operator_receipts USING btree (occurred_at);

CREATE INDEX scheduled_slack_bot_messages_session_idx ON opengeni_private.scheduled_slack_bot_messages USING btree (workspace_id, session_id, created_at);

CREATE INDEX session_usage_limit_receipts_pending ON opengeni_private.session_usage_limit_receipts USING btree (workspace_id, root_session_id, recorded_at) WHERE (status = 'pending'::text);

CREATE INDEX session_usage_limit_receipts_root ON opengeni_private.session_usage_limit_receipts USING btree (workspace_id, root_session_id, recorded_at);

CREATE INDEX session_usage_limit_roots_import_due ON opengeni_private.session_usage_limit_roots USING btree (import_next_at, workspace_id, root_session_id) WHERE (history_state = 'preparing'::text);

CREATE INDEX slack_file_upload_operations_session_idx ON opengeni_private.slack_file_upload_operations USING btree (workspace_id, session_id);

CREATE UNIQUE INDEX slack_file_upload_operations_workspace_operation_uq ON opengeni_private.slack_file_upload_operations USING btree (workspace_id, operation_id);

CREATE UNIQUE INDEX subscription_authority_compat_outbox_uq ON opengeni_private.subscription_authority_compat USING btree (outbox_id, provider);

CREATE UNIQUE INDEX subscription_authority_compat_revision_uq ON opengeni_private.subscription_authority_compat USING btree (scheduled_task_id, task_authority_revision, provider);

CREATE UNIQUE INDEX subscription_authority_compat_session_uq ON opengeni_private.subscription_authority_compat USING btree (session_id, workspace_id, provider);

CREATE UNIQUE INDEX subscription_authority_compat_task_uq ON opengeni_private.subscription_authority_compat USING btree (scheduled_task_id, provider) WHERE (carrier_kind = 'scheduled_task'::text);

CREATE UNIQUE INDEX subscription_authority_compat_turn_uq ON opengeni_private.subscription_authority_compat USING btree (turn_id, workspace_id, provider);

CREATE UNIQUE INDEX subscription_authority_compat_update_uq ON opengeni_private.subscription_authority_compat USING btree (system_update_id, workspace_id, provider);

CREATE INDEX subscription_codex_auto_assignments_account_idx ON opengeni_private.subscription_core_auto_assignments USING btree (account_id);

CREATE INDEX subscription_usage_calls_connection_time ON opengeni_private.subscription_usage_calls USING btree (connection_id, occurred_at);

CREATE INDEX subscription_usage_calls_retention ON opengeni_private.subscription_usage_calls USING btree (occurred_at);

CREATE INDEX subscription_usage_readings_retention ON opengeni_private.subscription_usage_readings USING btree (observed_at);

CREATE INDEX usage_maintenance_due_time ON opengeni_private.usage_maintenance_due USING btree (data_schema, kind, due_at);

CREATE INDEX user_activity_presence_last_seen_idx ON opengeni_private.user_activity_presence USING btree (last_seen_at);

CREATE INDEX workspace_allowance_grants_fefo ON opengeni_private.workspace_allowance_grants USING btree (workspace_id, expires_at, created_at, operation_id) WHERE (remaining > 0);

CREATE INDEX workspace_usage_allowances_maintenance_due ON opengeni_private.workspace_usage_allowances USING btree (maintenance_next_at, workspace_id) WHERE (config IS NOT NULL);

CREATE UNIQUE INDEX workspace_video_allowance_allocations_operation_idx ON opengeni_private.workspace_video_allowance_allocations USING btree (account_id, workspace_id, operation_id);

CREATE UNIQUE INDEX workspace_video_allowance_allocations_refund_idx ON opengeni_private.workspace_video_allowance_allocations USING btree (reversed_by_ledger_id) WHERE (reversed_by_ledger_id IS NOT NULL);

CREATE INDEX additional_organization_creation_receipts_actor_subject_idx ON additional_organization_creation_receipts USING btree (actor_subject_id);

CREATE INDEX agent_learning_revisions_current_idx ON agent_learning_revisions USING btree (account_id, owner_key, context_key, version DESC);

CREATE INDEX api_keys_account_idx ON api_keys USING btree (account_id);

CREATE UNIQUE INDEX api_keys_id_account_idx ON api_keys USING btree (id, account_id);

CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys USING btree (key_hash);

CREATE INDEX api_keys_organization_account_idx ON api_keys USING btree (account_id, created_at DESC) WHERE (credential_kind = 'organization'::text);

CREATE INDEX api_keys_personal_owner_idx ON api_keys USING btree (account_id, owner_subject_id, created_at DESC) WHERE (credential_kind = 'personal'::text);

CREATE INDEX api_keys_prefix_idx ON api_keys USING btree (prefix);

CREATE INDEX api_keys_service_account_idx ON api_keys USING btree (service_account_id) WHERE (service_account_id IS NOT NULL);

CREATE INDEX api_keys_workspace_idx ON api_keys USING btree (workspace_id);

CREATE INDEX attached_browser_devices_discovery_idx ON attached_browser_devices USING btree (workspace_id, disconnected_at, updated_at, id);

CREATE INDEX attached_browser_devices_enrollment_idx ON attached_browser_devices USING btree (workspace_id, enrollment_id, disconnected_at, updated_at);

CREATE INDEX audit_events_account_created_idx ON audit_events USING btree (account_id, occurred_at);

CREATE INDEX audit_events_workspace_created_idx ON audit_events USING btree (workspace_id, occurred_at);

CREATE UNIQUE INDEX auth_identities_provider_account_idx ON auth_identities USING btree (provider_id, account_id);

CREATE INDEX auth_identities_user_id_idx ON auth_identities USING btree (user_id);

CREATE UNIQUE INDEX auth_rate_limits_key_idx ON auth_rate_limits USING btree (key);

CREATE UNIQUE INDEX auth_runs_active_browser_target_uq ON auth_runs USING btree (workspace_id, browser_session_id, target_id) WHERE (settled_at IS NULL);

CREATE INDEX auth_runs_browser_history_idx ON auth_runs USING btree (workspace_id, browser_session_id, created_at);

CREATE INDEX auth_runs_site_history_idx ON auth_runs USING btree (workspace_id, site_auth_connection_id, created_at);

CREATE UNIQUE INDEX auth_runs_workspace_maintenance_operation_uq ON auth_runs USING btree (workspace_id, maintenance_operation_id) WHERE (maintenance_operation_id IS NOT NULL);

CREATE INDEX auth_sessions_identity_revision_idx ON auth_sessions USING btree (identity_id, auth_revision, identity_revision);

CREATE INDEX auth_sessions_login_binding_revision_idx ON auth_sessions USING btree (login_binding_id, login_binding_revision);

CREATE INDEX auth_sessions_managed_auth_expiry_idx ON auth_sessions USING btree (expires_at, id);

CREATE INDEX auth_sessions_managed_auth_login_transaction_idx ON auth_sessions USING btree (managed_auth_login_transaction_id, created_at) WHERE (managed_auth_login_transaction_id IS NOT NULL);

CREATE UNIQUE INDEX auth_sessions_token_idx ON auth_sessions USING btree (token);
