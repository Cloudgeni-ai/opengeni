-- deployment-mode: rolling
-- Opengeni baseline part 12 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE TRIGGER session_turns_capture_company_brain_context_snapshot AFTER INSERT ON session_turns FOR EACH ROW EXECUTE FUNCTION capture_company_brain_turn_context_snapshot();

CREATE TRIGGER session_turns_claude_authority_lock_trg BEFORE UPDATE OF claude_provider_account_authority_snapshot ON session_turns FOR EACH ROW EXECUTE FUNCTION prevent_claude_snapshot_mutation();

CREATE TRIGGER session_turns_clear_context_compaction_pending AFTER UPDATE OF active_attempt_id ON session_turns FOR EACH ROW WHEN ((old.active_attempt_id IS DISTINCT FROM new.active_attempt_id)) EXECUTE FUNCTION opengeni_private.clear_context_compaction_pending_turn();

CREATE TRIGGER session_turns_codex_authority_snapshot_immutable_trg BEFORE UPDATE OF codex_provider_account_authority_snapshot ON session_turns FOR EACH ROW EXECUTE FUNCTION prevent_codex_provider_account_authority_snapshot_mutation();

CREATE TRIGGER session_turns_connection_account_intent_immutable BEFORE UPDATE OF connection_account_intent ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_connection_account_intent_mutation();

CREATE TRIGGER session_turns_goal_snapshot_immutable BEFORE UPDATE OF goal_snapshot ON session_turns FOR EACH ROW EXECUTE FUNCTION session_goal_reject_turn_snapshot_mutation();

CREATE TRIGGER session_turns_goal_snapshot_insert BEFORE INSERT ON session_turns FOR EACH ROW EXECUTE FUNCTION session_goal_freeze_turn_snapshot();

CREATE TRIGGER session_turns_imported_archive_guard BEFORE INSERT OR UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

CREATE TRIGGER session_turns_inference_claim_guard BEFORE UPDATE OF status ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_session_inference_claim();

CREATE TRIGGER session_turns_initiating_human_immutable BEFORE UPDATE OF initiating_human_subject_id ON session_turns FOR EACH ROW EXECUTE FUNCTION workspace_governance_reject_turn_human_mutation();

CREATE TRIGGER session_turns_initiator_immutable BEFORE UPDATE OF initiator_kind, initiator_subject_id, initiator_context ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_session_turn_initiator_mutation();

CREATE TRIGGER session_turns_list_attention_update AFTER UPDATE OF status, updated_at ON session_turns FOR EACH ROW WHEN ((((old.status = 'requires_action'::text) OR (new.status = 'requires_action'::text)) AND ((old.status IS DISTINCT FROM new.status) OR (old.updated_at IS DISTINCT FROM new.updated_at)))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_turns_list_insert_delete AFTER INSERT OR DELETE ON session_turns FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_turns_lossless_legacy_update_fence BEFORE UPDATE OF prompt ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_turns_personal_authority_immutable BEFORE UPDATE OF personal_connection_delegations ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER session_turns_personal_resource_binding_immutable BEFORE UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION fence_turn_personal_resource_protocol_update();

CREATE TRIGGER session_turns_prompt_routing_immutable BEFORE UPDATE OF prompt_routing ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_session_turn_prompt_routing_mutation();

CREATE TRIGGER session_turns_subscription_authority_immutable_trg BEFORE UPDATE OF subscription_authority ON session_turns FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();

CREATE TRIGGER session_turns_surface_immutable BEFORE UPDATE OF surface ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_session_turn_surface_mutation();

CREATE TRIGGER session_turns_xai_authority_snapshot_immutable_trg BEFORE UPDATE OF xai_provider_account_authority_snapshot ON session_turns FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();

CREATE TRIGGER session_update_outbox_personal_authority_immutable BEFORE UPDATE OF personal_connection_delegations ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER session_updates_codex_authority_snapshot_immutable_trg BEFORE UPDATE OF codex_provider_account_authority_snapshot ON session_system_updates FOR EACH ROW EXECUTE FUNCTION prevent_codex_provider_account_authority_snapshot_mutation();

CREATE TRIGGER session_updates_personal_authority_immutable BEFORE UPDATE OF personal_connection_delegations ON session_system_updates FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER session_usage_limit_meter_event AFTER INSERT ON session_events FOR EACH ROW WHEN ((new.type = 'agent.model.usage'::text)) EXECUTE FUNCTION meter_session_usage_limit_event();

CREATE TRIGGER session_usage_limit_root_seed AFTER INSERT ON sessions REFERENCING NEW TABLE AS inserted_sessions FOR EACH STATEMENT EXECUTE FUNCTION seed_session_usage_limit_root();

CREATE TRIGGER session_work_claim_revisions_guard_mutation BEFORE INSERT OR DELETE OR UPDATE ON session_work_claim_revisions FOR EACH ROW EXECUTE FUNCTION guard_session_work_claim_revision_mutation();

CREATE TRIGGER session_work_claims_guard_mutation BEFORE INSERT OR DELETE OR UPDATE ON session_work_claims FOR EACH ROW EXECUTE FUNCTION guard_session_work_claim_mutation();

CREATE TRIGGER session_workflow_wake_control_revision BEFORE INSERT OR UPDATE OF reason, wake_revision, control_revision ON session_workflow_wake_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.stamp_session_workflow_control_revision();

CREATE TRIGGER session_workflow_wake_imported_archive_guard BEFORE INSERT OR UPDATE ON session_workflow_wake_outbox FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

CREATE CONSTRAINT TRIGGER sessions_activity_insert_commit_guard AFTER INSERT ON sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.activity_revision_pending_xid IS NOT NULL)) EXECUTE FUNCTION opengeni_private.reject_unfinalized_session_activity();

CREATE CONSTRAINT TRIGGER sessions_activity_update_commit_guard AFTER UPDATE ON sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.activity_revision_pending_xid IS NOT NULL) OR (old.activity_revision_pending_xid IS NOT NULL))) EXECUTE FUNCTION opengeni_private.reject_unfinalized_session_activity();

CREATE TRIGGER sessions_archive_object_deletion AFTER DELETE ON sessions FOR EACH ROW WHEN ((old.content_archive IS NOT NULL)) EXECUTE FUNCTION opengeni_private.enqueue_session_archive_object_deletion();

CREATE TRIGGER sessions_authority_write_fence BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_session_authority_write();

CREATE TRIGGER sessions_automatic_title_policy_v1_fence BEFORE INSERT OR UPDATE OF title, title_source ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1();

CREATE TRIGGER sessions_child_authority_fence BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION fence_child_session_authority();

CREATE TRIGGER sessions_claude_authority_lock_trg BEFORE UPDATE OF initial_claude_provider_account_authority_snapshot ON sessions FOR EACH ROW EXECUTE FUNCTION prevent_claude_snapshot_mutation();

CREATE TRIGGER sessions_codex_last_workspace_guard BEFORE INSERT OR UPDATE OF codex_last_credential_id, workspace_id ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace('last');

CREATE TRIGGER sessions_codex_pinned_workspace_guard BEFORE INSERT OR UPDATE OF codex_pinned_credential_id, workspace_id ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace('pinned');

CREATE TRIGGER sessions_create_requested_visibility_immutable BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION fence_session_create_requested_visibility_update();

CREATE TRIGGER sessions_creator_immutable BEFORE UPDATE OF created_by_kind, created_by_subject_id, created_by_context ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_session_creator_mutation();

CREATE CONSTRAINT TRIGGER sessions_event_projection_cursor_guard AFTER INSERT OR UPDATE OF last_sequence ON sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_session_event_projection_not_ahead();

CREATE TRIGGER sessions_imported_archive_identity_guard BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_imported_archive_identity();

CREATE TRIGGER sessions_initial_personal_resource_intent_immutable BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION fence_session_initial_personal_resource_intent_update();

CREATE TRIGGER sessions_initial_xai_authority_snapshot_immutable_trg BEFORE UPDATE OF initial_xai_provider_account_authority_snapshot ON sessions FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();

CREATE TRIGGER sessions_initialize_event_cursors AFTER INSERT ON sessions REFERENCING NEW TABLE AS inserted_sessions FOR EACH STATEMENT EXECUTE FUNCTION initialize_session_event_cursors_for_inserted_sessions();

CREATE TRIGGER sessions_list_insert_delete AFTER INSERT OR DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER sessions_list_projection_update AFTER UPDATE OF initial_message, created_by_kind, created_by_subject_id, scope_subject_id, keep_live, content_archived_at, imported_archive_import_id, imported_archive_imported_at, site_id ON sessions FOR EACH ROW WHEN ((((((((((old.initial_message IS DISTINCT FROM new.initial_message) OR (old.created_by_kind IS DISTINCT FROM new.created_by_kind)) OR (old.created_by_subject_id IS DISTINCT FROM new.created_by_subject_id)) OR (old.scope_subject_id IS DISTINCT FROM new.scope_subject_id)) OR (old.keep_live IS DISTINCT FROM new.keep_live)) OR (old.content_archived_at IS DISTINCT FROM new.content_archived_at)) OR (old.imported_archive_import_id IS DISTINCT FROM new.imported_archive_import_id)) OR (old.imported_archive_imported_at IS DISTINCT FROM new.imported_archive_imported_at)) OR (old.site_id IS DISTINCT FROM new.site_id))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER sessions_list_update AFTER UPDATE OF status, active_turn_id, title, title_source, model, reasoning_effort, channel_id, parent_session_id, root_session_id, visibility, owner_subject_id, site_access_root_id, admission_block, direct_control_state, direct_pause_revision, subtree_run_override_revision, input_wait_until, input_wait_turn_id, input_wait_reason, content_archive_state, updated_at, metadata ON sessions FOR EACH ROW WHEN (((((((((((((((((((((((old.status IS DISTINCT FROM new.status) OR (old.active_turn_id IS DISTINCT FROM new.active_turn_id)) OR (old.title IS DISTINCT FROM new.title)) OR (old.title_source IS DISTINCT FROM new.title_source)) OR (old.model IS DISTINCT FROM new.model)) OR (old.reasoning_effort IS DISTINCT FROM new.reasoning_effort)) OR (old.channel_id IS DISTINCT FROM new.channel_id)) OR (old.parent_session_id IS DISTINCT FROM new.parent_session_id)) OR (old.root_session_id IS DISTINCT FROM new.root_session_id)) OR (old.visibility IS DISTINCT FROM new.visibility)) OR (old.owner_subject_id IS DISTINCT FROM new.owner_subject_id)) OR (old.site_access_root_id IS DISTINCT FROM new.site_access_root_id)) OR (old.admission_block IS DISTINCT FROM new.admission_block)) OR (old.direct_control_state IS DISTINCT FROM new.direct_control_state)) OR (old.direct_pause_revision IS DISTINCT FROM new.direct_pause_revision)) OR (old.subtree_run_override_revision IS DISTINCT FROM new.subtree_run_override_revision)) OR (old.input_wait_until IS DISTINCT FROM new.input_wait_until)) OR (old.input_wait_turn_id IS DISTINCT FROM new.input_wait_turn_id)) OR (old.input_wait_reason IS DISTINCT FROM new.input_wait_reason)) OR (old.content_archive_state IS DISTINCT FROM new.content_archive_state)) OR (old.updated_at IS DISTINCT FROM new.updated_at)) OR (((old.metadata -> 'scheduledTaskId'::text) IS DISTINCT FROM (new.metadata -> 'scheduledTaskId'::text)) OR ((old.metadata -> '_opengeniSiteOrigin'::text) IS DISTINCT FROM (new.metadata -> '_opengeniSiteOrigin'::text))))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER sessions_lossless_legacy_update_fence BEFORE UPDATE OF initial_message ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER sessions_mark_activity_pending BEFORE INSERT OR UPDATE OF updated_at, channel_id, activity_revision, activity_revision_pending_xid ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.mark_session_activity_pending();

CREATE TRIGGER sessions_parent_turn_valid BEFORE INSERT OR UPDATE OF parent_turn_id, parent_session_id, workspace_id ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_session_parent_turn();

CREATE TRIGGER sessions_personal_authority_immutable BEFORE UPDATE OF initial_personal_connection_delegations, parent_turn_id ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_personal_connection_authority_mutation();

CREATE TRIGGER sessions_policy_role_immutable BEFORE UPDATE OF policy_role ON sessions FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_session_role_mutation();

CREATE TRIGGER sessions_prevent_event_projection_regression BEFORE UPDATE OF last_sequence ON sessions FOR EACH ROW EXECUTE FUNCTION prevent_session_event_projection_regression();

CREATE TRIGGER sessions_settle_work_claims_terminal AFTER UPDATE OF status ON sessions FOR EACH ROW WHEN ((new.status IS DISTINCT FROM old.status)) EXECUTE FUNCTION settle_session_work_claims_on_session_terminal();

CREATE TRIGGER sessions_stamp_activity_xid BEFORE INSERT OR UPDATE OF updated_at, channel_id, activity_xid ON sessions FOR EACH ROW EXECUTE FUNCTION stamp_session_activity_xid();

CREATE TRIGGER sessions_strip_private_list_snapshots AFTER UPDATE OF visibility ON sessions FOR EACH ROW WHEN (((new.visibility = 'user_private'::text) AND (old.visibility IS DISTINCT FROM new.visibility))) EXECUTE FUNCTION strip_private_session_list_snapshots();

CREATE TRIGGER sessions_variable_set_attachment_status_sync AFTER UPDATE OF status ON sessions FOR EACH ROW EXECUTE FUNCTION sync_session_variable_set_attachment_status();

CREATE TRIGGER sessions_variable_set_attachments_sync AFTER INSERT OR UPDATE OF variable_set_ids, variable_set_id ON sessions FOR EACH ROW EXECUTE FUNCTION sync_session_variable_set_attachments();

CREATE TRIGGER sessions_variable_set_selection_normalize BEFORE INSERT OR UPDATE OF variable_set_ids, variable_set_id ON sessions FOR EACH ROW EXECUTE FUNCTION normalize_session_variable_set_selection();

CREATE TRIGGER sessions_z_execution_epoch BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION derive_session_execution_authority_epoch();

CREATE TRIGGER sessions_zz_execution_context BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_session_execution_context();

CREATE TRIGGER settle_background_command_from_retained_process AFTER UPDATE OF state, exit_code, settlement_reason, settled_at ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION opengeni_private.settle_background_command_from_retained_process();

CREATE TRIGGER site_hostnames_hold_deleted AFTER DELETE ON site_hostnames FOR EACH ROW EXECUTE FUNCTION opengeni_private.hold_deleted_site_hostname();

CREATE TRIGGER site_session_access_list_change AFTER INSERT OR DELETE OR UPDATE ON site_session_access FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER skill_config_conversion_receipts_immutable BEFORE DELETE OR UPDATE ON skill_config_conversion_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_skill_config_receipt_mutation();

CREATE TRIGGER skill_guard_legacy_activation BEFORE INSERT OR UPDATE ON preference_registry_preferences FOR EACH ROW EXECUTE FUNCTION skill_guard_legacy_activation();

CREATE TRIGGER skill_guard_legacy_revision BEFORE INSERT ON preference_registry_revisions FOR EACH ROW EXECUTE FUNCTION skill_guard_legacy_revision();

CREATE TRIGGER skill_publish_plugin_owner AFTER UPDATE OF status ON capability_plugin_installations FOR EACH ROW WHEN (((new.status = 'active'::text) AND (old.status IS DISTINCT FROM new.status))) EXECUTE FUNCTION skill_publish_finalized_owner();

CREATE TRIGGER skill_write_receipts_immutable BEFORE DELETE OR UPDATE ON skill_write_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_owned_skill_history_delete();

CREATE TRIGGER slack_action_handle_tenancy_sync AFTER INSERT OR DELETE OR UPDATE OF account_id, workspace_id, connection_id ON slack_interaction_action_handles FOR EACH ROW EXECUTE FUNCTION opengeni_private.sync_slack_action_handle_tenancy();

CREATE TRIGGER slack_bot_post_operations_claim_mode_fence BEFORE INSERT OR UPDATE ON slack_bot_post_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_slack_bot_post_claim_mode();

CREATE TRIGGER slack_interactions_list_change AFTER INSERT OR DELETE ON slack_interactions FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER slack_interactions_list_update AFTER UPDATE OF visibility, owning_subject_id, session_reservation_id ON slack_interactions FOR EACH ROW WHEN ((((old.visibility IS DISTINCT FROM new.visibility) OR (old.owning_subject_id IS DISTINCT FROM new.owning_subject_id)) OR (old.session_reservation_id IS DISTINCT FROM new.session_reservation_id))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER slack_shared_task_origins_immutable BEFORE DELETE OR UPDATE ON slack_shared_task_origins FOR EACH ROW EXECUTE FUNCTION slack_shared_task_origin_forbid_mutation();

CREATE TRIGGER slack_task_policy_events_immutable BEFORE DELETE OR UPDATE ON slack_task_policy_activation_events FOR EACH ROW EXECUTE FUNCTION slack_task_policy_forbid_mutation();

CREATE TRIGGER slack_task_policy_heads_lifecycle_only BEFORE INSERT OR DELETE OR UPDATE ON slack_task_policy_heads FOR EACH ROW EXECUTE FUNCTION slack_task_policy_guard_head_mutation();

CREATE TRIGGER slack_task_policy_revisions_immutable BEFORE DELETE OR UPDATE ON slack_task_policy_revisions FOR EACH ROW EXECUTE FUNCTION slack_task_policy_forbid_mutation();

CREATE TRIGGER social_connection_version BEFORE UPDATE ON social_connections FOR EACH ROW EXECUTE FUNCTION bump_social_connection_version();

CREATE TRIGGER subscription_capacity_waiters_turn_session_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id ON subscription_capacity_waiters FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_turn_session_reference();

CREATE TRIGGER subscription_connection_workspaces_owner_reach BEFORE INSERT OR UPDATE ON subscription_connection_workspaces FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_workspace_owner_reach();

CREATE TRIGGER subscription_connections_core_plan_change_trg BEFORE UPDATE OF plan_type ON subscription_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.record_subscription_core_plan_change();

CREATE TRIGGER subscription_connections_health_retry_trg BEFORE UPDATE ON subscription_connections FOR EACH ROW EXECUTE FUNCTION clear_subscription_connection_health_retry();

CREATE TRIGGER subscription_connections_identity BEFORE UPDATE OF account_id, provider ON subscription_connections FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_cutover_identity('connection');

CREATE TRIGGER subscription_connections_owner_reach BEFORE UPDATE OF managed_by_workspace_id ON subscription_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_workspace_owner_reach();

CREATE TRIGGER subscription_connections_refresh_generation_trg BEFORE UPDATE ON subscription_connections FOR EACH ROW EXECUTE FUNCTION enforce_subscription_refresh_generation();

CREATE TRIGGER subscription_connections_scope_guard BEFORE UPDATE ON subscription_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_connection_scope();

CREATE TRIGGER subscription_designation_disconnect_admission BEFORE INSERT OR UPDATE OF connection_id ON subscription_apps_designations FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_designation_disconnect();

CREATE TRIGGER subscription_disconnect_history BEFORE UPDATE ON subscription_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_history();

CREATE TRIGGER subscription_leases_connection_reference_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id, connection_id, provider ON subscription_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_connection_reference();

CREATE TRIGGER subscription_leases_turn_session_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id ON subscription_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_turn_session_reference();

CREATE TRIGGER subscription_operation_leases_connection_reference_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, operation_id, attempt_id, operation_kind, session_id, turn_id, connection_id, provider, holder_id, generation ON subscription_operation_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_operation_lease_reference();

CREATE TRIGGER subscription_provider_cutovers_codex_identity BEFORE UPDATE ON subscription_provider_cutovers FOR EACH ROW EXECUTE FUNCTION opengeni_private.keep_subscription_codex_cutover_identity();

CREATE TRIGGER subscription_provider_cutovers_identity BEFORE UPDATE ON subscription_provider_cutovers FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_cutover_identity('cutover row');

CREATE TRIGGER subscription_session_bindings_cache_clock BEFORE UPDATE OF connection_id, provider, model_id, choice ON subscription_session_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.reset_subscription_binding_cache_clock();

CREATE TRIGGER subscription_session_bindings_connection_reference_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, connection_id, provider ON subscription_session_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_connection_reference();

CREATE TRIGGER subscription_session_bindings_provider_fixed BEFORE UPDATE OF provider ON subscription_session_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_binding_provider();

CREATE TRIGGER subscription_settings_identity_immutable BEFORE UPDATE OF account_id, workspace_id ON subscription_settings FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_settings_identity();

CREATE TRIGGER subscription_settings_locked_overrides_clear AFTER INSERT OR UPDATE OF locked_settings ON subscription_settings FOR EACH ROW WHEN ((new.workspace_id IS NULL)) EXECUTE FUNCTION opengeni_private.clear_subscription_settings_locked_overrides();

CREATE TRIGGER subscription_settings_locked_overrides_guard BEFORE INSERT OR UPDATE ON subscription_settings FOR EACH ROW WHEN ((new.workspace_id IS NOT NULL)) EXECUTE FUNCTION opengeni_private.guard_subscription_settings_locked_overrides();

CREATE TRIGGER subscription_turn_failures_turn_session_guard BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id ON subscription_turn_failures FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_turn_session_reference();

CREATE TRIGGER subscription_usage_call_capture AFTER INSERT OR DELETE OR UPDATE ON model_call_facts FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.capture_usage_call();

CREATE TRIGGER subscription_usage_reading_capture AFTER INSERT OR UPDATE OF quota, updated_at ON subscription_connection_quota FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.capture_usage_reading();

CREATE TRIGGER supervised_command_admission_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_workspace_mutation_admissions FOR EACH ROW EXECUTE FUNCTION opengeni_private.supervised_command_blocker_guard();

CREATE TRIGGER supervised_command_capture_guard BEFORE UPDATE OF unobservable_command_drain_ids, archive_capture_id, archive_capture_published_at, archive_generation, resume_state ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.supervised_command_capture_guard();

CREATE TRIGGER supervised_command_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION opengeni_private.supervised_command_guard();

CREATE TRIGGER supervised_command_holder_guard BEFORE DELETE OR UPDATE ON sandbox_lease_holders FOR EACH ROW EXECUTE FUNCTION opengeni_private.supervised_command_blocker_guard();

CREATE CONSTRAINT TRIGGER supervised_provider_loss_commit_guard AFTER UPDATE ON sandbox_retained_processes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.state = 'active'::text) AND (new.state = 'lost'::text) AND (new.provider_command ? 'supervision'::text) AND (new.settlement_reason = 'provider_instance_lost'::text))) EXECUTE FUNCTION opengeni_private.supervised_provider_loss_commit_guard();

CREATE TRIGGER sync_personal_enrollment_authority_after_update AFTER UPDATE OF generation, status ON enrollments FOR EACH ROW EXECUTE FUNCTION sync_personal_enrollment_authority();

CREATE TRIGGER system_update_outbox_codex_authority_snapshot_immutable_trg BEFORE UPDATE OF codex_provider_account_authority_snapshot ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION prevent_codex_provider_account_authority_snapshot_mutation();

CREATE TRIGGER system_update_outbox_xai_snapshot_immutable_trg BEFORE UPDATE OF xai_provider_account_authority_snapshot ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();

CREATE TRIGGER task_note_events_guard_mutation BEFORE INSERT OR DELETE OR UPDATE ON task_note_events FOR EACH ROW EXECUTE FUNCTION guard_task_note_event_mutation();

CREATE TRIGGER task_note_replacement_receipts_immutable BEFORE DELETE OR UPDATE ON task_note_replacement_receipts FOR EACH ROW EXECUTE FUNCTION reject_task_note_replacement_receipt_mutation();

CREATE TRIGGER task_notes_guard_mutation BEFORE INSERT OR DELETE OR UPDATE ON task_notes FOR EACH ROW EXECUTE FUNCTION guard_task_note_mutation();

CREATE TRIGGER terminal_turn_run_state_cleanup AFTER UPDATE OF status ON session_turns FOR EACH ROW WHEN ((new.status = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'withdrawn_for_edit'::text]))) EXECUTE FUNCTION retire_terminal_turn_run_state();

CREATE TRIGGER transcription_recording_segments_lossless_legacy_update_fence BEFORE UPDATE OF transcript_text ON transcription_recording_segments FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER transcription_recordings_lossless_legacy_update_fence BEFORE UPDATE OF transcript_text ON transcription_recordings FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER turn_personal_resource_attachment_receipts_immutable BEFORE UPDATE ON turn_personal_resource_attachment_receipts FOR EACH ROW EXECUTE FUNCTION reject_turn_personal_resource_snapshot_update();

CREATE TRIGGER turn_personal_resource_once_receipts_immutable BEFORE UPDATE ON turn_personal_resource_once_receipts FOR EACH ROW EXECUTE FUNCTION reject_turn_personal_resource_snapshot_update();

CREATE TRIGGER turn_personal_resource_snapshots_digest BEFORE INSERT ON turn_personal_resource_snapshots FOR EACH ROW EXECUTE FUNCTION stamp_turn_personal_resource_snapshot_digest();

CREATE TRIGGER turn_personal_resource_snapshots_immutable BEFORE UPDATE ON turn_personal_resource_snapshots FOR EACH ROW EXECUTE FUNCTION reject_turn_personal_resource_snapshot_update();

CREATE TRIGGER usage_events_execution_context_guard BEFORE INSERT OR UPDATE OF workspace_id, session_id, turn_id, turn_attempt_id ON usage_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_usage_event_execution_context();

CREATE CONSTRAINT TRIGGER usage_events_host_export AFTER INSERT ON usage_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.enqueue_host_usage_event_export();

CREATE TRIGGER video_generation_file_owner_immutable BEFORE UPDATE ON video_generation_operations FOR EACH ROW EXECUTE FUNCTION knowledge_media_file_owner_immutable();

CREATE TRIGGER workspace_artifact_events_immutable BEFORE DELETE OR UPDATE ON workspace_artifact_events FOR EACH ROW EXECUTE FUNCTION workspace_artifact_reject_history_mutation();

CREATE TRIGGER workspace_artifact_events_validate_links BEFORE INSERT OR UPDATE ON workspace_artifact_events FOR EACH ROW EXECUTE FUNCTION workspace_artifact_validate_event_links();

CREATE TRIGGER workspace_artifact_versions_immutable BEFORE DELETE OR UPDATE ON workspace_artifact_versions FOR EACH ROW EXECUTE FUNCTION workspace_artifact_reject_history_mutation();

CREATE CONSTRAINT TRIGGER workspace_artifacts_validate_current AFTER INSERT OR UPDATE ON workspace_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workspace_artifact_validate_current();

CREATE TRIGGER workspace_codex_subscription_preference_affinity_reset AFTER INSERT OR UPDATE OF mode ON workspace_codex_subscription_preferences FOR EACH ROW EXECUTE FUNCTION opengeni_private.clear_workspace_codex_session_affinity();

CREATE TRIGGER workspace_control_events_bound_fields BEFORE INSERT OR UPDATE OF reason, actor, reason_original_bytes, actor_original_bytes ON workspace_control_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.bound_workspace_control_event();

CREATE TRIGGER workspace_control_revision_monotonic BEFORE UPDATE OF revision ON workspace_inference_controls FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_workspace_control_revision_rollback();

CREATE TRIGGER workspace_instruction_policy_activations_operation_guard BEFORE INSERT ON workspace_instruction_policy_activation_events FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_guard_lifecycle_operation();

CREATE TRIGGER workspace_instruction_policy_deactivations_immutable BEFORE DELETE OR UPDATE ON workspace_instruction_policy_deactivation_events FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

CREATE TRIGGER workspace_instruction_policy_deactivations_operation_guard BEFORE INSERT ON workspace_instruction_policy_deactivation_events FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_guard_lifecycle_operation();

CREATE TRIGGER workspace_instruction_policy_deactivations_validate_revision BEFORE INSERT ON workspace_instruction_policy_deactivation_events FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_deactivation_event();

CREATE TRIGGER workspace_instruction_policy_events_immutable BEFORE DELETE OR UPDATE ON workspace_instruction_policy_activation_events FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

CREATE TRIGGER workspace_instruction_policy_events_validate_revisions BEFORE INSERT OR UPDATE ON workspace_instruction_policy_activation_events FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_event();

CREATE TRIGGER workspace_instruction_policy_heads_deactivation_guard BEFORE DELETE ON workspace_instruction_policy_heads FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_guard_head_delete();

CREATE TRIGGER workspace_instruction_policy_heads_validate_revision BEFORE INSERT OR UPDATE ON workspace_instruction_policy_heads FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_head();

CREATE TRIGGER workspace_instruction_policy_onboarding_proposals_immutable BEFORE DELETE OR UPDATE ON workspace_instruction_policy_onboarding_proposals FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

CREATE TRIGGER workspace_instruction_policy_onboarding_proposals_validate_draf BEFORE INSERT OR UPDATE ON workspace_instruction_policy_onboarding_proposals FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_onboarding_proposal();

CREATE TRIGGER workspace_instruction_policy_revisions_immutable BEFORE DELETE OR UPDATE ON workspace_instruction_policy_revisions FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_mutation();

CREATE TRIGGER workspace_instruction_policy_revisions_validate_link BEFORE INSERT OR UPDATE ON workspace_instruction_policy_revisions FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_revision_link();

CREATE TRIGGER workspace_instruction_policy_snapshots_immutable BEFORE DELETE OR UPDATE ON workspace_instruction_policy_snapshots FOR EACH ROW EXECUTE FUNCTION workspace_governance_snapshot_reject_mutation();

CREATE TRIGGER workspace_instruction_policy_snapshots_validate BEFORE INSERT ON workspace_instruction_policy_snapshots FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_snapshot();

CREATE TRIGGER workspace_learning_policy_events_immutable BEFORE DELETE OR UPDATE ON workspace_learning_policy_activation_events FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_reject_history_mutation();

CREATE TRIGGER workspace_learning_policy_events_validate_revisions BEFORE INSERT OR UPDATE ON workspace_learning_policy_activation_events FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_event();

CREATE TRIGGER workspace_learning_policy_heads_lifecycle_only BEFORE INSERT OR DELETE OR UPDATE ON workspace_learning_policy_heads FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_guard_head_mutation();

CREATE TRIGGER workspace_learning_policy_heads_validate_revision BEFORE INSERT OR UPDATE ON workspace_learning_policy_heads FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_head();

CREATE TRIGGER workspace_learning_policy_revisions_immutable BEFORE DELETE OR UPDATE ON workspace_learning_policy_revisions FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_reject_history_mutation();

CREATE TRIGGER workspace_learning_policy_revisions_validate_link BEFORE INSERT OR UPDATE ON workspace_learning_policy_revisions FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_revision_link();

CREATE TRIGGER workspace_learning_policy_snapshots_immutable BEFORE DELETE OR UPDATE ON workspace_learning_policy_snapshots FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_reject_snapshot_mutation();

CREATE TRIGGER workspace_learning_policy_snapshots_validate BEFORE INSERT ON workspace_learning_policy_snapshots FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_snapshot();

CREATE TRIGGER workspace_memberships_list_change AFTER INSERT OR DELETE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER workspace_memberships_list_update AFTER UPDATE OF subject_label, role, permissions ON workspace_memberships FOR EACH ROW WHEN ((((old.subject_label IS DISTINCT FROM new.subject_label) OR (old.role IS DISTINCT FROM new.role)) OR (old.permissions IS DISTINCT FROM new.permissions))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER workspace_session_activity_revision_commit_gate BEFORE UPDATE ON workspace_session_activity_revisions FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_session_activity_revision();

CREATE TRIGGER workspace_variable_sets_session_attachment_guard BEFORE DELETE ON workspace_variable_sets FOR EACH ROW EXECUTE FUNCTION guard_variable_set_session_attachments();

CREATE TRIGGER workspaces_initialize_session_activity_revision AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION opengeni_private.initialize_workspace_session_activity_revision();

CREATE TRIGGER workspaces_subscription_core_auto_assign AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION opengeni_private.auto_assign_subscription_core_workspace();

CREATE TRIGGER z_session_attempt_personal_machine_admission_legacy AFTER INSERT ON session_turn_attempts FOR EACH ROW WHEN ((new.personal_resource_protocol_version = 0)) EXECUTE FUNCTION admit_session_attempt_personal_machine();

CREATE TRIGGER zz_scheduled_task_attempt_personal_resource_match AFTER INSERT ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION validate_scheduled_task_attempt_personal_resources();

CREATE TRIGGER zz_scheduled_task_execution_digest BEFORE INSERT OR UPDATE ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION set_scheduled_task_execution_digest();

CREATE TRIGGER zz_session_attempt_personal_machine_admission_v1 AFTER INSERT ON session_turn_attempts FOR EACH ROW WHEN ((new.personal_resource_protocol_version = 1)) EXECUTE FUNCTION admit_session_attempt_personal_machine_v1();

CREATE TRIGGER zz_session_goal_freeze_report_requirements_trigger BEFORE INSERT ON session_turns FOR EACH ROW EXECUTE FUNCTION session_goal_freeze_report_requirements();

CREATE TRIGGER zz_sessions_site_audience BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION bind_session_site_audience();

CREATE TRIGGER zz_subscription_binding_disconnect_admission BEFORE INSERT OR UPDATE OF connection_id ON subscription_session_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_admission();

CREATE TRIGGER zz_subscription_lease_disconnect_admission BEFORE INSERT OR UPDATE OF connection_id, holder_id, generation ON subscription_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_admission();

CREATE TRIGGER zz_subscription_operation_disconnect_admission BEFORE INSERT OR UPDATE OF connection_id, holder_id, generation ON subscription_operation_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_disconnect_admission();

CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON scheduled_task_revision_authorities FOR EACH ROW WHEN ((new.authority_inserted_at IS DISTINCT FROM old.authority_inserted_at)) EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON scheduled_tasks FOR EACH ROW WHEN ((new.authority_inserted_at IS DISTINCT FROM old.authority_inserted_at)) EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON session_system_update_outbox FOR EACH ROW WHEN ((new.authority_inserted_at IS DISTINCT FROM old.authority_inserted_at)) EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON session_system_updates FOR EACH ROW WHEN ((new.authority_inserted_at IS DISTINCT FROM old.authority_inserted_at)) EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON session_turns FOR EACH ROW WHEN ((new.authority_inserted_at IS DISTINCT FROM old.authority_inserted_at)) EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_immutable BEFORE UPDATE ON sessions FOR EACH ROW WHEN ((new.authority_inserted_at IS DISTINCT FROM old.authority_inserted_at)) EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON scheduled_task_revision_authorities FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON session_system_updates FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at();

CREATE TRIGGER zzz_authority_inserted_at_stamp BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at();

CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON scheduled_task_revision_authorities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat();

CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON scheduled_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat();

CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON session_system_update_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat();

CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON session_system_updates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat();

CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON session_turns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat();

CREATE CONSTRAINT TRIGGER zzz_subscription_authority_compat_check AFTER INSERT ON sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat();

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_base_id_fkey FOREIGN KEY (base_id) REFERENCES document_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_base_id_fkey FOREIGN KEY (base_id) REFERENCES document_bases(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_states
    ADD CONSTRAINT agent_run_states_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_states
    ADD CONSTRAINT agent_run_states_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_reusable_session_id_fkey FOREIGN KEY (reusable_session_id) REFERENCES sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspaces
    ADD CONSTRAINT workspaces_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_memberships
    ADD CONSTRAINT workspace_memberships_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installations
    ADD CONSTRAINT github_installations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installations
    ADD CONSTRAINT github_installations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY usage_events
    ADD CONSTRAINT usage_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY usage_events
    ADD CONSTRAINT usage_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY credit_ledger_entries
    ADD CONSTRAINT credit_ledger_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY credit_ledger_entries
    ADD CONSTRAINT credit_ledger_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

ALTER TABLE ONLY billing_customers
    ADD CONSTRAINT billing_customers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE SET NULL;

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY files
    ADD CONSTRAINT files_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_bases
    ADD CONSTRAINT document_bases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_bases
    ADD CONSTRAINT document_bases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_states
    ADD CONSTRAINT agent_run_states_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_states
    ADD CONSTRAINT agent_run_states_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_memberships
    ADD CONSTRAINT workspace_memberships_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY file_uploads
    ADD CONSTRAINT file_uploads_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY document_bases
    ADD CONSTRAINT document_bases_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY document_chunks
    ADD CONSTRAINT document_chunks_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_events
    ADD CONSTRAINT session_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY agent_run_states
    ADD CONSTRAINT agent_run_states_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_runs
    ADD CONSTRAINT scheduled_task_runs_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY github_installations
    ADD CONSTRAINT github_installations_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY usage_events
    ADD CONSTRAINT usage_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY social_connections
    ADD CONSTRAINT social_connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY social_connections
    ADD CONSTRAINT social_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY social_posts
    ADD CONSTRAINT social_posts_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY social_posts
    ADD CONSTRAINT social_posts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY social_posts
    ADD CONSTRAINT social_posts_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES social_connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_catalog_items
    ADD CONSTRAINT capability_catalog_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_catalog_items
    ADD CONSTRAINT capability_catalog_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_installations
    ADD CONSTRAINT capability_installations_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_installations
    ADD CONSTRAINT capability_installations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_variable_sets
    ADD CONSTRAINT workspace_environments_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_variable_sets
    ADD CONSTRAINT workspace_environments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_variable_set_variables
    ADD CONSTRAINT workspace_environment_variables_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_variable_set_variables
    ADD CONSTRAINT workspace_environment_variables_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_variable_set_variables
    ADD CONSTRAINT workspace_environment_variables_environment_id_fkey FOREIGN KEY (variable_set_id) REFERENCES workspace_variable_sets(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_environment_id_fkey FOREIGN KEY (variable_set_id) REFERENCES workspace_variable_sets(id) ON DELETE SET NULL;

ALTER TABLE ONLY session_goals
    ADD CONSTRAINT session_goals_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_goals
    ADD CONSTRAINT session_goals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_goals
    ADD CONSTRAINT session_goals_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_history_items
    ADD CONSTRAINT session_history_items_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_history_items
    ADD CONSTRAINT session_history_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_history_items
    ADD CONSTRAINT session_history_items_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_history_items
    ADD CONSTRAINT session_history_items_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY sandbox_session_envelopes
    ADD CONSTRAINT sandbox_session_envelopes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_session_envelopes
    ADD CONSTRAINT sandbox_session_envelopes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_session_envelopes
    ADD CONSTRAINT sandbox_session_envelopes_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_leases
    ADD CONSTRAINT sandbox_leases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_leases
    ADD CONSTRAINT sandbox_leases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_lease_holders
    ADD CONSTRAINT sandbox_lease_holders_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_lease_holders
    ADD CONSTRAINT sandbox_lease_holders_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_lease_holders
    ADD CONSTRAINT sandbox_lease_holders_lease_id_fkey FOREIGN KEY (lease_id) REFERENCES sandbox_leases(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_stream_acknowledgments
    ADD CONSTRAINT session_stream_acknowledgments_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_stream_acknowledgments
    ADD CONSTRAINT session_stream_acknowledgments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_recordings
    ADD CONSTRAINT session_recordings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_recordings
    ADD CONSTRAINT session_recordings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_recordings
    ADD CONSTRAINT session_recordings_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_recordings
    ADD CONSTRAINT session_recordings_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY sandbox_pty_sessions
    ADD CONSTRAINT sandbox_pty_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_pty_sessions
    ADD CONSTRAINT sandbox_pty_sessions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandbox_pty_sessions
    ADD CONSTRAINT sandbox_pty_sessions_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_subscription_credentials
    ADD CONSTRAINT codex_subscription_credentials_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_subscription_credentials
    ADD CONSTRAINT codex_subscription_credentials_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY enrollments
    ADD CONSTRAINT enrollments_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY enrollments
    ADD CONSTRAINT enrollments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandboxes
    ADD CONSTRAINT sandboxes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandboxes
    ADD CONSTRAINT sandboxes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY sandboxes
    ADD CONSTRAINT sandboxes_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_active_sandbox_id_fkey FOREIGN KEY (active_sandbox_id) REFERENCES sandboxes(id) ON DELETE SET NULL;

ALTER TABLE ONLY machine_metrics_latest
    ADD CONSTRAINT machine_metrics_latest_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_metrics_latest
    ADD CONSTRAINT machine_metrics_latest_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_metrics_latest
    ADD CONSTRAINT machine_metrics_latest_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_metrics_series
    ADD CONSTRAINT machine_metrics_series_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_metrics_series
    ADD CONSTRAINT machine_metrics_series_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY machine_metrics_series
    ADD CONSTRAINT machine_metrics_series_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY device_enrollment_requests
    ADD CONSTRAINT device_enrollment_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY device_enrollment_requests
    ADD CONSTRAINT device_enrollment_requests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY device_enrollment_requests
    ADD CONSTRAINT device_enrollment_requests_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE SET NULL;

ALTER TABLE ONLY device_enrollment_requests
    ADD CONSTRAINT device_enrollment_requests_sandbox_id_fkey FOREIGN KEY (sandbox_id) REFERENCES sandboxes(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_codex_pinned_credential_fk FOREIGN KEY (codex_pinned_credential_id) REFERENCES codex_subscription_credentials(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_codex_last_credential_fk FOREIGN KEY (codex_last_credential_id) REFERENCES codex_subscription_credentials(id) ON DELETE SET NULL;

ALTER TABLE ONLY codex_rotation_settings
    ADD CONSTRAINT codex_rotation_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_rotation_settings
    ADD CONSTRAINT codex_rotation_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_rotation_settings
    ADD CONSTRAINT codex_rotation_settings_active_credential_id_fkey FOREIGN KEY (active_credential_id) REFERENCES codex_subscription_credentials(id) ON DELETE SET NULL;

ALTER TABLE ONLY session_mcp_servers
    ADD CONSTRAINT session_mcp_servers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_mcp_servers
    ADD CONSTRAINT session_mcp_servers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_mcp_servers
    ADD CONSTRAINT session_mcp_servers_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY connections
    ADD CONSTRAINT connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_oauth_state_nonces
    ADD CONSTRAINT integration_oauth_state_nonces_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY integration_oauth_state_nonces
    ADD CONSTRAINT integration_oauth_state_nonces_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY capability_catalog_items
    ADD CONSTRAINT capability_catalog_items_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES import_batches(id) ON DELETE SET NULL;

ALTER TABLE ONLY workspace_captures
    ADD CONSTRAINT workspace_captures_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_captures
    ADD CONSTRAINT workspace_captures_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_captures
    ADD CONSTRAINT workspace_captures_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_captures
    ADD CONSTRAINT workspace_captures_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_supersedes_fk FOREIGN KEY (supersedes_id) REFERENCES knowledge_memories(id) ON DELETE SET NULL;

ALTER TABLE ONLY knowledge_memories
    ADD CONSTRAINT knowledge_memories_superseded_by_fk FOREIGN KEY (superseded_by_id) REFERENCES knowledge_memories(id) ON DELETE SET NULL;

ALTER TABLE ONLY rigs
    ADD CONSTRAINT rigs_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY rigs
    ADD CONSTRAINT rigs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_versions
    ADD CONSTRAINT rig_versions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_versions
    ADD CONSTRAINT rig_versions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_versions
    ADD CONSTRAINT rig_versions_rig_id_fkey FOREIGN KEY (rig_id) REFERENCES rigs(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_changes
    ADD CONSTRAINT rig_changes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_changes
    ADD CONSTRAINT rig_changes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_changes
    ADD CONSTRAINT rig_changes_rig_id_fkey FOREIGN KEY (rig_id) REFERENCES rigs(id) ON DELETE CASCADE;

ALTER TABLE ONLY rig_changes
    ADD CONSTRAINT rig_changes_base_version_id_fkey FOREIGN KEY (base_version_id) REFERENCES rig_versions(id) ON DELETE SET NULL;

ALTER TABLE ONLY rig_changes
    ADD CONSTRAINT rig_changes_result_version_id_fkey FOREIGN KEY (result_version_id) REFERENCES rig_versions(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_rig_id_fk FOREIGN KEY (rig_id) REFERENCES rigs(id) ON DELETE SET NULL;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_rig_version_id_fk FOREIGN KEY (rig_version_id) REFERENCES rig_versions(id) ON DELETE SET NULL;

ALTER TABLE ONLY scheduled_tasks
    ADD CONSTRAINT scheduled_tasks_rig_id_fk FOREIGN KEY (rig_id) REFERENCES rigs(id) ON DELETE SET NULL;

ALTER TABLE ONLY workspaces
    ADD CONSTRAINT workspaces_default_rig_id_fk FOREIGN KEY (default_rig_id) REFERENCES rigs(id) ON DELETE SET NULL;

ALTER TABLE ONLY codex_credential_leases
    ADD CONSTRAINT codex_credential_leases_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_credential_leases
    ADD CONSTRAINT codex_credential_leases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_credential_leases
    ADD CONSTRAINT codex_credential_leases_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_credential_leases
    ADD CONSTRAINT codex_credential_leases_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY codex_capacity_waiters
    ADD CONSTRAINT codex_capacity_waiters_workspace_blocked_turn_fk FOREIGN KEY (workspace_id, blocked_turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY session_list_snapshots
    ADD CONSTRAINT session_list_snapshots_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_model_policies
    ADD CONSTRAINT workspace_model_policies_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY workspace_model_policies
    ADD CONSTRAINT workspace_model_policies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT session_system_updates_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT session_system_updates_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_update_outbox
    ADD CONSTRAINT session_system_update_outbox_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_system_update_outbox
    ADD CONSTRAINT session_system_update_outbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT session_pending_tool_calls_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT session_pending_tool_calls_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
