-- deployment-mode: rolling
-- Opengeni baseline part 13 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT system_updates_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT system_updates_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT system_updates_workspace_turn_fk FOREIGN KEY (workspace_id, delivered_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_workspace_resumed_update_fk FOREIGN KEY (workspace_id, resumed_update_id) REFERENCES session_system_updates(workspace_id, id) ON DELETE SET NULL;

ALTER TABLE ONLY session_system_update_outbox
    ADD CONSTRAINT system_update_outbox_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_update_outbox
    ADD CONSTRAINT system_update_outbox_source_session_fk FOREIGN KEY (workspace_id, source_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_update_outbox
    ADD CONSTRAINT system_update_outbox_target_session_fk FOREIGN KEY (workspace_id, target_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT pending_tool_calls_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT pending_tool_calls_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT pending_tool_calls_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_workflow_wake_outbox
    ADD CONSTRAINT session_workflow_wake_outbox_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_workflow_wake_outbox
    ADD CONSTRAINT session_workflow_wake_outbox_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_inference_controls
    ADD CONSTRAINT workspace_inference_controls_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_attempts
    ADD CONSTRAINT session_turn_attempts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_command_receipts
    ADD CONSTRAINT session_command_receipts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_control_events
    ADD CONSTRAINT workspace_control_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_interruptions
    ADD CONSTRAINT session_attempt_interruptions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY composer_drafts
    ADD CONSTRAINT composer_drafts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY composer_drafts
    ADD CONSTRAINT composer_drafts_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_reset_redemption_attempts
    ADD CONSTRAINT codex_reset_redemption_attempts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_reset_redemption_attempts
    ADD CONSTRAINT codex_reset_redemption_attempts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_reset_redemption_attempts
    ADD CONSTRAINT codex_reset_redemption_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_session_activity_revisions
    ADD CONSTRAINT workspace_session_activity_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installation_repositories
    ADD CONSTRAINT github_installation_repositories_installation_fk FOREIGN KEY (workspace_id, installation_id) REFERENCES github_installations(workspace_id, installation_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_human_input_requests
    ADD CONSTRAINT session_human_input_requests_creation_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, creation_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_create_idempotency_guard
    ADD CONSTRAINT session_create_idempotency_guard_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_spawn_denials
    ADD CONSTRAINT session_spawn_denials_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_root_session_fk FOREIGN KEY (workspace_id, root_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_policy_session_fk FOREIGN KEY (workspace_id, nested_agent_depth_policy_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY sandbox_lease_holders
    ADD CONSTRAINT sandbox_lease_holders_lease_scope_fk FOREIGN KEY (account_id, workspace_id, lease_id) REFERENCES sandbox_leases(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_workspace_mutation_admissions
    ADD CONSTRAINT sandbox_workspace_mutation_admissions_lease_scope_fk FOREIGN KEY (account_id, workspace_id, sandbox_group_id, lease_id) REFERENCES sandbox_leases(account_id, workspace_id, sandbox_group_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_retained_processes
    ADD CONSTRAINT sandbox_retained_processes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY new_session_drafts
    ADD CONSTRAINT new_session_drafts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_revisions
    ADD CONSTRAINT workspace_instruction_policy_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_revisions
    ADD CONSTRAINT workspace_instruction_policy_revisions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_heads
    ADD CONSTRAINT workspace_instruction_policy_heads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_heads
    ADD CONSTRAINT workspace_instruction_policy_heads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_activation_events
    ADD CONSTRAINT workspace_instruction_policy_activation_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_activation_events
    ADD CONSTRAINT workspace_instruction_policy_activation_event_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_post_operations
    ADD CONSTRAINT slack_bot_post_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_post_operations
    ADD CONSTRAINT slack_bot_post_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_post_operations
    ADD CONSTRAINT slack_bot_post_operations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_preferences
    ADD CONSTRAINT preference_registry_preferences_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY preference_registry_revisions
    ADD CONSTRAINT preference_registry_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY preference_registry_events
    ADD CONSTRAINT preference_registry_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY sandbox_leases
    ADD CONSTRAINT sandbox_leases_current_checkpoint_fk FOREIGN KEY (current_checkpoint_artifact_id) REFERENCES sandbox_checkpoint_artifacts(id) DEFERRABLE;

ALTER TABLE ONLY sandbox_leases
    ADD CONSTRAINT sandbox_leases_previous_checkpoint_fk FOREIGN KEY (previous_checkpoint_artifact_id) REFERENCES sandbox_checkpoint_artifacts(id) DEFERRABLE;

ALTER TABLE ONLY workspace_screenshot_quotas
    ADD CONSTRAINT workspace_screenshot_quotas_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY model_call_facts
    ADD CONSTRAINT model_call_facts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_delete_operations
    ADD CONSTRAINT slack_bot_delete_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_delete_operations
    ADD CONSTRAINT slack_bot_delete_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_delete_operations
    ADD CONSTRAINT slack_bot_delete_operations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_artifact_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifacts
    ADD CONSTRAINT workspace_artifacts_current_version_fk FOREIGN KEY (workspace_id, current_version_id) REFERENCES workspace_artifact_versions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_artifact_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_user_links
    ADD CONSTRAINT slack_bot_user_links_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_user_links
    ADD CONSTRAINT slack_bot_user_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_bot_user_links
    ADD CONSTRAINT slack_bot_user_links_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_inbox
    ADD CONSTRAINT slack_interaction_inbox_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_inbox
    ADD CONSTRAINT slack_interaction_inbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_inbox
    ADD CONSTRAINT slack_interaction_inbox_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interactions
    ADD CONSTRAINT slack_interactions_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_interaction_progress_deliveries
    ADD CONSTRAINT slack_interaction_progress_deliveries_interaction_fk FOREIGN KEY (account_id, workspace_id, interaction_id) REFERENCES slack_interactions(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_created_by_workspace_session_fk FOREIGN KEY (workspace_id, created_by_session_id) REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (created_by_session_id);

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_scope_session_fk FOREIGN KEY (workspace_id, scope_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_operation_receipts
    ADD CONSTRAINT knowledge_operation_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_providers
    ADD CONSTRAINT knowledge_providers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_sources
    ADD CONSTRAINT knowledge_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_source_acl_versions
    ADD CONSTRAINT knowledge_source_acl_versions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_sync_runs
    ADD CONSTRAINT knowledge_sync_runs_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_source_objects
    ADD CONSTRAINT knowledge_source_objects_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_document_versions
    ADD CONSTRAINT knowledge_document_versions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_lifecycle_events
    ADD CONSTRAINT knowledge_lifecycle_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_entities
    ADD CONSTRAINT knowledge_entities_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_entity_aliases
    ADD CONSTRAINT knowledge_entity_aliases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_facts
    ADD CONSTRAINT knowledge_facts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_claims
    ADD CONSTRAINT knowledge_claims_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_claim_relations
    ADD CONSTRAINT knowledge_claim_relations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_claim_evidence
    ADD CONSTRAINT knowledge_claim_evidence_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_claim_reviews
    ADD CONSTRAINT knowledge_claim_reviews_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge_change_proposals
    ADD CONSTRAINT knowledge_change_proposals_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY connector_action_policies
    ADD CONSTRAINT connector_action_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_action_policies
    ADD CONSTRAINT connector_action_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_action_policies
    ADD CONSTRAINT connector_action_policies_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_action_requests
    ADD CONSTRAINT connector_action_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_action_requests
    ADD CONSTRAINT connector_action_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_action_requests
    ADD CONSTRAINT connector_action_requests_creation_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, creation_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY connector_action_requests
    ADD CONSTRAINT connector_action_requests_execution_attempt_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, execution_attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY preference_registry_snapshots
    ADD CONSTRAINT preference_registry_snapshots_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_snapshots
    ADD CONSTRAINT workspace_instruction_policy_snapshots_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_modes
    ADD CONSTRAINT session_realtime_modes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_modes
    ADD CONSTRAINT session_realtime_modes_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_connections
    ADD CONSTRAINT session_realtime_connections_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_connections
    ADD CONSTRAINT session_realtime_connections_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_connections
    ADD CONSTRAINT session_realtime_connections_realtime_fk FOREIGN KEY (realtime_id) REFERENCES session_realtime_modes(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_realtime_fk FOREIGN KEY (realtime_id) REFERENCES session_realtime_modes(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_source_update_fk FOREIGN KEY (source_update_id) REFERENCES session_system_updates(id) ON DELETE SET NULL;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_history_item_fk FOREIGN KEY (history_item_id) REFERENCES session_history_items(id) ON DELETE SET NULL;

ALTER TABLE ONLY session_realtime_entries
    ADD CONSTRAINT session_realtime_entries_turn_fk FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY session_realtime_context_projections
    ADD CONSTRAINT session_realtime_context_projections_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_context_projections
    ADD CONSTRAINT session_realtime_context_projections_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_realtime_context_projections
    ADD CONSTRAINT session_realtime_context_projections_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_disconnect_operations
    ADD CONSTRAINT connection_disconnect_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_disconnect_operations
    ADD CONSTRAINT connection_disconnect_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY connection_disconnect_operations
    ADD CONSTRAINT connection_disconnect_operations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals
    ADD CONSTRAINT workspace_instruction_policy_onboarding_proposa_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals
    ADD CONSTRAINT workspace_instruction_policy_onboarding_propo_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY transcription_recordings
    ADD CONSTRAINT transcription_recordings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY transcription_recordings
    ADD CONSTRAINT transcription_recordings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY transcription_recordings
    ADD CONSTRAINT transcription_recordings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY transcription_recording_objects
    ADD CONSTRAINT transcription_recording_objects_authority_fk FOREIGN KEY (account_id, workspace_id, subject_id, recording_id) REFERENCES transcription_recordings(account_id, workspace_id, subject_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY transcription_recording_chunks
    ADD CONSTRAINT transcription_recording_chunks_authority_fk FOREIGN KEY (account_id, workspace_id, subject_id, recording_id) REFERENCES transcription_recordings(account_id, workspace_id, subject_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY transcription_recording_segments
    ADD CONSTRAINT transcription_recording_segments_authority_fk FOREIGN KEY (account_id, workspace_id, subject_id, recording_id) REFERENCES transcription_recordings(account_id, workspace_id, subject_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_apps_settings
    ADD CONSTRAINT codex_apps_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_apps_settings
    ADD CONSTRAINT codex_apps_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_apps_settings
    ADD CONSTRAINT codex_apps_settings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_apps_settings
    ADD CONSTRAINT codex_apps_settings_credential_scope_fk FOREIGN KEY (workspace_id, account_id, credential_id) REFERENCES codex_subscription_credentials(workspace_id, account_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_session_fk FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_turn_fk FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY retained_screenshot_artifacts
    ADD CONSTRAINT retained_screenshot_artifacts_attempt_fk FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE SET NULL;

ALTER TABLE ONLY machine_removal_operations
    ADD CONSTRAINT machine_removal_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_removal_operations
    ADD CONSTRAINT machine_removal_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_removal_operations
    ADD CONSTRAINT machine_removal_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (session_id);

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL (turn_id);

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (attempt_id);

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_upload_fk FOREIGN KEY (upload_id) REFERENCES file_uploads(id) ON DELETE SET NULL;

ALTER TABLE ONLY generated_image_artifacts
    ADD CONSTRAINT generated_image_artifacts_workspace_file_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES files(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY image_generation_operations
    ADD CONSTRAINT image_generation_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY image_generation_operations
    ADD CONSTRAINT image_generation_operations_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY image_generation_operations
    ADD CONSTRAINT image_generation_operations_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY image_generation_operations
    ADD CONSTRAINT image_generation_operations_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (attempt_id);

ALTER TABLE ONLY editable_artifact_scope_authorization_heads
    ADD CONSTRAINT editable_artifact_scope_authorization_heads_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY editable_artifacts
    ADD CONSTRAINT editable_artifacts_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_predecessor_fk FOREIGN KEY (account_id, workspace_id, artifact_id, actor_key_digest, replica_id, previous_local_transaction_id) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, actor_key_digest, replica_id, client_transaction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_operations
    ADD CONSTRAINT editable_artifact_operations_transaction_fk FOREIGN KEY (account_id, workspace_id, artifact_id, transaction_id) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_idempotency_receipts
    ADD CONSTRAINT editable_artifact_idempotency_receipts_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_idempotency_receipts
    ADD CONSTRAINT editable_artifact_idempotency_receipts_transaction_fk FOREIGN KEY (account_id, workspace_id, artifact_id, server_transaction_id) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_idempotency_receipts
    ADD CONSTRAINT editable_artifact_idempotency_receipts_exact_transaction_fk FOREIGN KEY (account_id, workspace_id, artifact_id, server_transaction_id, authority_key_digest, idempotency_key, request_hash) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id, actor_key_digest, client_transaction_id, request_hash) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_undo_claims
    ADD CONSTRAINT editable_artifact_undo_claims_transaction_fk FOREIGN KEY (account_id, workspace_id, artifact_id, claiming_transaction_id) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_sequence_checkpoints
    ADD CONSTRAINT editable_artifact_sequence_checkpoints_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_sequence_checkpoints
    ADD CONSTRAINT editable_artifact_sequence_checkpoints_transaction_fk FOREIGN KEY (account_id, workspace_id, artifact_id, transaction_id) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_transactions
    ADD CONSTRAINT editable_artifact_transactions_parent_checkpoint_fk FOREIGN KEY (account_id, workspace_id, artifact_id, parent_head_sequence) REFERENCES editable_artifact_sequence_checkpoints(account_id, workspace_id, artifact_id, head_sequence) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_blob_refs
    ADD CONSTRAINT editable_artifact_blob_refs_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_blob_fk FOREIGN KEY (account_id, workspace_id, artifact_id, blob_ref_id) REFERENCES editable_artifact_blob_refs(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_blob_facts_fk FOREIGN KEY (account_id, workspace_id, artifact_id, blob_ref_id, byte_size, content_hash, mime_type) REFERENCES editable_artifact_blob_refs(account_id, workspace_id, artifact_id, id, byte_size, content_hash, mime_type) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_snapshots
    ADD CONSTRAINT editable_artifact_snapshots_checkpoint_fk FOREIGN KEY (account_id, workspace_id, artifact_id, covered_head_sequence) REFERENCES editable_artifact_sequence_checkpoints(account_id, workspace_id, artifact_id, head_sequence) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifacts
    ADD CONSTRAINT editable_artifacts_current_snapshot_fk FOREIGN KEY (account_id, workspace_id, id, current_snapshot_id) REFERENCES editable_artifact_snapshots(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_versions
    ADD CONSTRAINT editable_artifact_versions_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_versions
    ADD CONSTRAINT editable_artifact_versions_snapshot_fk FOREIGN KEY (account_id, workspace_id, artifact_id, snapshot_id) REFERENCES editable_artifact_snapshots(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_versions
    ADD CONSTRAINT editable_artifact_versions_checkpoint_fk FOREIGN KEY (account_id, workspace_id, artifact_id, head_sequence) REFERENCES editable_artifact_sequence_checkpoints(account_id, workspace_id, artifact_id, head_sequence) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_materialization_jobs
    ADD CONSTRAINT editable_artifact_materialization_jobs_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_materialization_jobs
    ADD CONSTRAINT editable_artifact_materialization_jobs_version_fk FOREIGN KEY (account_id, workspace_id, artifact_id, version_id) REFERENCES editable_artifact_versions(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_materialization_jobs
    ADD CONSTRAINT editable_artifact_materialization_jobs_checkpoint_fk FOREIGN KEY (account_id, workspace_id, artifact_id, target_head_sequence) REFERENCES editable_artifact_sequence_checkpoints(account_id, workspace_id, artifact_id, head_sequence) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_materialization_jobs
    ADD CONSTRAINT editable_artifact_materialization_jobs_source_snapshot_fk FOREIGN KEY (account_id, workspace_id, artifact_id, input_snapshot_id, target_head_sequence, state_hash) REFERENCES editable_artifact_snapshots(account_id, workspace_id, artifact_id, id, covered_head_sequence, state_hash) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_materialization_results
    ADD CONSTRAINT editable_artifact_materialization_results_job_fk FOREIGN KEY (account_id, workspace_id, artifact_id, job_id) REFERENCES editable_artifact_materialization_jobs(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_materialization_results
    ADD CONSTRAINT editable_artifact_materialization_results_blob_fk FOREIGN KEY (account_id, workspace_id, artifact_id, blob_ref_id) REFERENCES editable_artifact_blob_refs(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_materialization_results
    ADD CONSTRAINT editable_artifact_materialization_results_blob_facts_fk FOREIGN KEY (account_id, workspace_id, artifact_id, blob_ref_id, byte_size, content_hash, mime_type) REFERENCES editable_artifact_blob_refs(account_id, workspace_id, artifact_id, id, byte_size, content_hash, mime_type) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_live_outbox
    ADD CONSTRAINT editable_artifact_live_outbox_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_live_outbox
    ADD CONSTRAINT editable_artifact_live_outbox_transaction_fk FOREIGN KEY (account_id, workspace_id, artifact_id, transaction_id) REFERENCES editable_artifact_transactions(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_live_outbox
    ADD CONSTRAINT editable_artifact_live_outbox_snapshot_fk FOREIGN KEY (account_id, workspace_id, artifact_id, snapshot_id) REFERENCES editable_artifact_snapshots(account_id, workspace_id, artifact_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY editable_artifact_replica_leases
    ADD CONSTRAINT editable_artifact_replica_leases_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_replica_leases
    ADD CONSTRAINT editable_artifact_replica_leases_checkpoint_fk FOREIGN KEY (account_id, workspace_id, artifact_id, applied_head_sequence) REFERENCES editable_artifact_sequence_checkpoints(account_id, workspace_id, artifact_id, head_sequence) ON DELETE RESTRICT;

ALTER TABLE ONLY editable_artifact_live_tickets
    ADD CONSTRAINT editable_artifact_live_tickets_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY editable_artifact_blob_refs
    ADD CONSTRAINT editable_artifact_blob_refs_source_file_fk FOREIGN KEY (account_id, workspace_id, source_file_id) REFERENCES files(account_id, workspace_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_knowledge_sync_fk FOREIGN KEY (knowledge_sync_run_id) REFERENCES knowledge_sync_runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_source_sync_states
    ADD CONSTRAINT knowledge_source_sync_states_source_fk FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_states
    ADD CONSTRAINT knowledge_source_sync_states_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_states
    ADD CONSTRAINT knowledge_source_sync_states_task_fk FOREIGN KEY (scheduled_task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_states
    ADD CONSTRAINT knowledge_source_sync_states_buffered_run_fk FOREIGN KEY (buffered_scheduled_task_run_id) REFERENCES scheduled_task_runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_source_sync_object_observations
    ADD CONSTRAINT knowledge_source_sync_object_observations_source_fk FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_object_observations
    ADD CONSTRAINT knowledge_source_sync_object_observations_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_object_observations
    ADD CONSTRAINT knowledge_source_sync_object_observations_run_fk FOREIGN KEY (scheduled_task_run_id) REFERENCES scheduled_task_runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_task_run_fk FOREIGN KEY (scheduled_task_run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_sync_run_fk FOREIGN KEY (knowledge_sync_run_id) REFERENCES knowledge_sync_runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_source_fk FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_wakes
    ADD CONSTRAINT knowledge_source_sync_wakes_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_wakes
    ADD CONSTRAINT knowledge_source_sync_wakes_source_fk FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_wakes
    ADD CONSTRAINT knowledge_source_sync_wakes_task_fk FOREIGN KEY (scheduled_task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_wakes
    ADD CONSTRAINT knowledge_source_sync_wakes_run_fk FOREIGN KEY (scheduled_task_run_id) REFERENCES scheduled_task_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_run_fk FOREIGN KEY (scheduled_task_run_id) REFERENCES scheduled_task_runs(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_source_fk FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_object_fk FOREIGN KEY (knowledge_source_object_id) REFERENCES knowledge_source_objects(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_version_fk FOREIGN KEY (knowledge_document_version_id) REFERENCES knowledge_document_versions(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_index_obligations
    ADD CONSTRAINT knowledge_source_sync_index_obligations_document_fk FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_source_sync_item_outcomes
    ADD CONSTRAINT knowledge_source_sync_item_outcomes_index_obligation_fk FOREIGN KEY (index_obligation_id) REFERENCES knowledge_source_sync_index_obligations(id) ON DELETE SET NULL;

ALTER TABLE ONLY memory_slack_publication_configurations
    ADD CONSTRAINT memory_slack_publication_configurations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_slack_publication_configurations
    ADD CONSTRAINT memory_slack_publication_configurations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_slack_publications
    ADD CONSTRAINT memory_slack_publications_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_slack_publications
    ADD CONSTRAINT memory_slack_publications_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_slack_publication_receipts
    ADD CONSTRAINT memory_slack_publication_receipts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_slack_publication_receipts
    ADD CONSTRAINT memory_slack_publication_receipts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY memory_slack_publication_receipts
    ADD CONSTRAINT memory_slack_publication_receipts_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES memory_slack_publications(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_heads
    ADD CONSTRAINT workspace_learning_policy_heads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_heads
    ADD CONSTRAINT workspace_learning_policy_heads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_activation_events
    ADD CONSTRAINT workspace_learning_policy_activation_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_activation_events
    ADD CONSTRAINT workspace_learning_policy_activation_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_learning_policy_snapshots
    ADD CONSTRAINT workspace_learning_policy_snapshots_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_revisions
    ADD CONSTRAINT company_profile_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_revisions
    ADD CONSTRAINT company_profile_revisions_supersedes_revision_id_fkey FOREIGN KEY (supersedes_revision_id) REFERENCES company_profile_revisions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_heads
    ADD CONSTRAINT company_profile_heads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_heads
    ADD CONSTRAINT company_profile_heads_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES company_profile_revisions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_activation_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_activation_events_old_revision_id_fkey FOREIGN KEY (old_revision_id) REFERENCES company_profile_revisions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_activation_events
    ADD CONSTRAINT company_profile_activation_events_new_revision_id_fkey FOREIGN KEY (new_revision_id) REFERENCES company_profile_revisions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY company_profile_snapshots
    ADD CONSTRAINT company_profile_snapshots_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES session_turn_attempts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_video_generation_policies
    ADD CONSTRAINT workspace_video_generation_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_video_generation_policies
    ADD CONSTRAINT workspace_video_generation_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_video_generation_policies
    ADD CONSTRAINT workspace_video_generation_policies_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_video_generation_quotas
    ADD CONSTRAINT workspace_video_generation_quotas_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_video_generation_quotas
    ADD CONSTRAINT workspace_video_generation_quotas_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_video_generation_quotas
    ADD CONSTRAINT workspace_video_generation_quotas_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (session_id);

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL (turn_id);

ALTER TABLE ONLY video_generation_operations
    ADD CONSTRAINT video_generation_operations_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (attempt_id);

ALTER TABLE ONLY video_generation_references
    ADD CONSTRAINT video_generation_references_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES video_generation_operations(id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_references
    ADD CONSTRAINT video_generation_references_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_references
    ADD CONSTRAINT video_generation_references_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY video_generation_references
    ADD CONSTRAINT video_generation_references_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE SET NULL (session_id);

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL (turn_id);

ALTER TABLE ONLY generated_video_artifacts
    ADD CONSTRAINT generated_video_artifacts_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (attempt_id);

ALTER TABLE ONLY session_attempt_tool_catalogs
    ADD CONSTRAINT session_attempt_tool_catalogs_attempt_owner_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id) REFERENCES session_turn_attempts(account_id, workspace_id, session_id, turn_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_attempt_codemode_calls
    ADD CONSTRAINT session_attempt_codemode_calls_catalog_fk FOREIGN KEY (account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation, catalog_digest) REFERENCES session_attempt_tool_catalogs(account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation, digest) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_interaction_revisions
    ADD CONSTRAINT workspace_interaction_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_resource_fk FOREIGN KEY (workspace_id, browser_session_id) REFERENCES browser_sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL (turn_id);

ALTER TABLE ONLY browser_session_associations
    ADD CONSTRAINT browser_session_associations_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (attempt_id);

ALTER TABLE ONLY interaction_operations
    ADD CONSTRAINT interaction_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_identities
    ADD CONSTRAINT browser_identities_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_revisions
    ADD CONSTRAINT browser_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_state_artifacts
    ADD CONSTRAINT browser_state_artifacts_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_revision_components
    ADD CONSTRAINT browser_revision_components_revision_fk FOREIGN KEY (workspace_id, identity_id, revision_id, source_browser_session_id) REFERENCES browser_revisions(workspace_id, identity_id, id, source_browser_session_id) ON DELETE CASCADE;

ALTER TABLE ONLY attached_browser_devices
    ADD CONSTRAINT attached_browser_devices_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY attached_browser_inventories
    ADD CONSTRAINT attached_browser_inventories_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY computer_sessions
    ADD CONSTRAINT computer_sessions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_resource_fk FOREIGN KEY (workspace_id, computer_session_id) REFERENCES computer_sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL (turn_id);

ALTER TABLE ONLY computer_session_associations
    ADD CONSTRAINT computer_session_associations_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (attempt_id);

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_linked_computer_session_fk FOREIGN KEY (workspace_id, linked_computer_session_id) REFERENCES computer_sessions(workspace_id, id) ON DELETE SET NULL (linked_computer_session_id);

ALTER TABLE ONLY network_routes
    ADD CONSTRAINT network_routes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_auth_connections
    ADD CONSTRAINT site_auth_connections_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_auth_connections
    ADD CONSTRAINT site_auth_connections_identity_fk FOREIGN KEY (workspace_id, preferred_identity_id) REFERENCES browser_identities(workspace_id, id) ON DELETE SET NULL (preferred_identity_id);

ALTER TABLE ONLY site_auth_connections
    ADD CONSTRAINT site_auth_connections_network_route_fk FOREIGN KEY (workspace_id, preferred_network_route_id) REFERENCES network_routes(workspace_id, id) ON DELETE SET NULL (preferred_network_route_id);

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_browser_session_fk FOREIGN KEY (workspace_id, browser_session_id) REFERENCES browser_sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_auth_run_fk FOREIGN KEY (workspace_id, auth_run_id) REFERENCES auth_runs(workspace_id, id) ON DELETE SET NULL (auth_run_id);

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_session_fk FOREIGN KEY (workspace_id, originating_session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_turn_fk FOREIGN KEY (workspace_id, originating_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE SET NULL (originating_turn_id);

ALTER TABLE ONLY interaction_interventions
    ADD CONSTRAINT interaction_interventions_attempt_fk FOREIGN KEY (workspace_id, originating_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) ON DELETE SET NULL (originating_attempt_id);

ALTER TABLE ONLY auth_runs
    ADD CONSTRAINT auth_runs_intervention_fk FOREIGN KEY (workspace_id, intervention_id) REFERENCES interaction_interventions(workspace_id, id) ON DELETE SET NULL (intervention_id);

ALTER TABLE ONLY interaction_resource_operations
    ADD CONSTRAINT interaction_resource_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY editable_artifact_session_links
    ADD CONSTRAINT editable_artifact_session_links_workspace_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY editable_artifact_session_links
    ADD CONSTRAINT editable_artifact_session_links_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY editable_artifact_session_links
    ADD CONSTRAINT editable_artifact_session_links_artifact_fk FOREIGN KEY (account_id, workspace_id, artifact_id) REFERENCES editable_artifacts(account_id, workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY browser_state_uploads
    ADD CONSTRAINT browser_state_uploads_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_installation_bindings
    ADD CONSTRAINT slack_installation_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_installation_bindings
    ADD CONSTRAINT slack_installation_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_installation_bindings
    ADD CONSTRAINT slack_installation_bindings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_installation_bindings
    ADD CONSTRAINT slack_installation_bindings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_requests
    ADD CONSTRAINT slack_user_link_access_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_requests
    ADD CONSTRAINT slack_user_link_access_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_requests
    ADD CONSTRAINT slack_user_link_access_requests_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_requests
    ADD CONSTRAINT slack_user_link_access_requests_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_request_operations
    ADD CONSTRAINT slack_user_link_access_request_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_request_operations
    ADD CONSTRAINT slack_user_link_access_request_operations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_request_operations
    ADD CONSTRAINT slack_user_link_access_request_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY slack_user_link_access_request_operations
    ADD CONSTRAINT slack_user_link_access_request_operations_request_tenant_fk FOREIGN KEY (request_id, workspace_id, account_id) REFERENCES slack_user_link_access_requests(id, workspace_id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_plugins
    ADD CONSTRAINT capability_plugins_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_plugins
    ADD CONSTRAINT capability_plugins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_plugin_versions
    ADD CONSTRAINT capability_plugin_versions_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES capability_plugins(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_plugin_versions
    ADD CONSTRAINT capability_plugin_versions_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL;

ALTER TABLE ONLY capability_facets
    ADD CONSTRAINT capability_facets_plugin_version_id_fkey FOREIGN KEY (plugin_version_id) REFERENCES capability_plugin_versions(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_integration_facets
    ADD CONSTRAINT capability_integration_facets_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_mcp_facets
    ADD CONSTRAINT capability_mcp_facets_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_api_facets
    ADD CONSTRAINT capability_api_facets_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_skill_facets
    ADD CONSTRAINT capability_skill_facets_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_skill_files
    ADD CONSTRAINT capability_skill_files_skill_facet_id_fkey FOREIGN KEY (skill_facet_id) REFERENCES capability_skill_facets(facet_id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_plugin_installations
    ADD CONSTRAINT capability_plugin_installations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_plugin_installations
    ADD CONSTRAINT capability_plugin_installations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_facet_installations
    ADD CONSTRAINT capability_facet_installations_plugin_installation_id_fkey FOREIGN KEY (plugin_installation_id) REFERENCES capability_plugin_installations(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_component_owners
    ADD CONSTRAINT capability_component_owners_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_component_owners
    ADD CONSTRAINT capability_component_owners_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_component_owners
    ADD CONSTRAINT capability_component_owners_facet_installation_id_fkey FOREIGN KEY (facet_installation_id) REFERENCES capability_facet_installations(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_spec_revisions
    ADD CONSTRAINT integration_spec_revisions_api_facet_id_fkey FOREIGN KEY (api_facet_id) REFERENCES capability_api_facets(facet_id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_tools
    ADD CONSTRAINT integration_tools_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_facet_definitions
    ADD CONSTRAINT integration_facet_definitions_integration_facet_id_fkey FOREIGN KEY (integration_facet_id) REFERENCES capability_integration_facets(facet_id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_facet_bindings
    ADD CONSTRAINT integration_facet_bindings_integration_facet_installatio_fkey FOREIGN KEY (integration_facet_installation_id) REFERENCES capability_facet_installations(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_facet_binding_owners
    ADD CONSTRAINT integration_facet_binding_owners_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;
