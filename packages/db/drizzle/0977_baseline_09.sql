-- deployment-mode: rolling
-- Opengeni baseline part 9 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE INDEX memory_slack_publication_receipts_workspace_history_idx ON memory_slack_publication_receipts USING btree (workspace_id, publication_id, sequence);

CREATE INDEX memory_slack_publications_claim_idx ON memory_slack_publications USING btree (state, retry_at, created_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'retry_wait'::text, 'delivering'::text]));

CREATE INDEX memory_slack_publications_workspace_history_idx ON memory_slack_publications USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX model_call_facts_connection_occurred_idx ON model_call_facts USING btree (account_id, connection_id, occurred_at) WHERE (connection_id IS NOT NULL);

CREATE INDEX model_call_facts_site_occurred_idx ON model_call_facts USING btree (workspace_id, site_id, occurred_at) WHERE (site_id IS NOT NULL);

CREATE INDEX model_call_facts_workspace_occurred_idx ON model_call_facts USING btree (workspace_id, occurred_at);

CREATE INDEX model_call_facts_workspace_provider_model_occurred_idx ON model_call_facts USING btree (workspace_id, provider, model, occurred_at);

CREATE INDEX model_call_facts_workspace_scheduled_task_occurred_idx ON model_call_facts USING btree (workspace_id, scheduled_task_id, occurred_at) WHERE (scheduled_task_id IS NOT NULL);

CREATE INDEX model_call_facts_workspace_session_occurred_idx ON model_call_facts USING btree (workspace_id, session_id, occurred_at);

CREATE UNIQUE INDEX model_call_facts_workspace_turn_source_uq ON model_call_facts USING btree (workspace_id, turn_id, source_key);

CREATE INDEX model_fact_reconciliation_batch_idx ON model_call_fact_reconciliation_candidates USING btree (workspace_id, batch_id);

CREATE INDEX model_fact_reconciliation_ready_idx ON model_call_fact_reconciliation_candidates USING btree (workspace_id, occurred_at, turn_id, source_key) WHERE (batch_id IS NULL);

CREATE UNIQUE INDEX network_routes_workspace_active_name_uq ON network_routes USING btree (workspace_id, lower(name)) WHERE (status = 'active'::text);

CREATE INDEX network_routes_workspace_status_updated_idx ON network_routes USING btree (workspace_id, status, updated_at, id);

CREATE INDEX new_session_drafts_project_provenance_backfill_v1_idx ON new_session_drafts USING btree (id) WHERE (session_options ? 'selectedProjectChannelId'::text);

CREATE UNIQUE INDEX new_session_drafts_subject_workspace_uq ON new_session_drafts USING btree (workspace_id, subject_id);

CREATE INDEX organization_api_key_workspaces_workspace_idx ON organization_api_key_workspaces USING btree (workspace_id, account_id);

CREATE UNIQUE INDEX organization_codex_rotation_settings_account_idx ON organization_codex_rotation_settings USING btree (account_id);

CREATE INDEX organization_company_profile_agent_policy_events_account_idx ON organization_company_profile_agent_policy_events USING btree (account_id, result_version);

CREATE UNIQUE INDEX organization_credential_providers_account_uq ON organization_credential_providers USING btree (account_id);

CREATE UNIQUE INDEX organization_invitation_binding_events_invitation_uq ON organization_invitation_binding_events USING btree (account_id, invitation_id);

CREATE INDEX organization_membership_invitations_account_created_idx ON organization_membership_invitations USING btree (account_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX organization_membership_invitations_id_account_idx ON organization_membership_invitations USING btree (id, account_id);

CREATE UNIQUE INDEX organization_membership_invitations_pending_email_uq ON organization_membership_invitations USING btree (account_id, target_email) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX organization_membership_invitations_pending_target_uq ON organization_membership_invitations USING btree (account_id, target_subject_id) WHERE ((status = 'pending'::text) AND (target_subject_id IS NOT NULL));

CREATE INDEX organization_membership_invitations_subject_created_idx ON organization_membership_invitations USING btree (target_subject_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX organization_membership_lifecycle_events_operation_uq ON organization_membership_lifecycle_events USING btree (account_id, operation_id);

CREATE UNIQUE INDEX organization_memberships_account_subject_idx ON organization_memberships USING btree (account_id, subject_id);

CREATE UNIQUE INDEX organization_memberships_id_account_idx ON organization_memberships USING btree (id, account_id);

CREATE UNIQUE INDEX organization_memberships_personal_workspace_idx ON organization_memberships USING btree (account_id, personal_workspace_id) WHERE (personal_workspace_id IS NOT NULL);

CREATE INDEX organization_memberships_retention_due_idx ON organization_memberships USING btree (account_id, personal_retention_until, id) WHERE ((status = 'revoked'::text) AND (personal_retention_until IS NOT NULL));

CREATE UNIQUE INDEX organization_model_provider_custom_models_active_uq ON organization_model_provider_custom_models USING btree (account_id, provider_kind, upstream_model_id) WHERE (retired_at IS NULL);

CREATE UNIQUE INDEX organization_model_provider_custom_models_delete_operation_uq ON organization_model_provider_custom_models USING btree (account_id, provider_kind, delete_operation_id) WHERE (delete_operation_id IS NOT NULL);

CREATE INDEX organization_recovery_acceptances_current_idx ON organization_recovery_custodian_acceptances USING btree (policy_id, canonical_identity_id, accepted_at DESC, id DESC);

CREATE INDEX organization_recovery_approvals_current_idx ON organization_recovery_approvals USING btree (operation_id, canonical_identity_id, approved_at DESC, id DESC);

CREATE INDEX organization_recovery_custodians_account_policy_idx ON organization_recovery_custodians USING btree (account_id, policy_id, ordinal);

CREATE UNIQUE INDEX organization_recovery_events_command_type_unique ON organization_recovery_events USING btree (account_id, command_operation_id, event_type) WHERE (command_operation_id IS NOT NULL);

CREATE INDEX organization_recovery_operations_account_created_idx ON organization_recovery_operations USING btree (account_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX organization_recovery_operations_one_live_idx ON organization_recovery_operations USING btree (account_id) WHERE (state = ANY (ARRAY['collecting'::text, 'cooling'::text]));

CREATE INDEX organization_recovery_outbox_batch_idx ON organization_recovery_notification_outbox USING btree (operation_id, batch_id, id);

CREATE INDEX organization_retention_events_member_created_idx ON organization_user_retention_deletion_events USING btree (account_id, membership_id, created_at, id);

CREATE INDEX organization_service_accounts_account_idx ON organization_service_accounts USING btree (account_id, created_at) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX organization_service_accounts_id_account_idx ON organization_service_accounts USING btree (id, account_id);

CREATE UNIQUE INDEX organization_user_resource_authorities_codex_tuple_idx ON organization_user_resource_authorities USING btree (id, account_id, organization_membership_id, resource_kind, resource_id, generation);

CREATE UNIQUE INDEX organization_user_resource_authorities_id_account_idx ON organization_user_resource_authorities USING btree (id, account_id);

CREATE UNIQUE INDEX organization_user_resource_authorities_id_account_membership_id ON organization_user_resource_authorities USING btree (id, account_id, organization_membership_id);

CREATE UNIQUE INDEX organization_user_resource_authorities_resource_identity_idx ON organization_user_resource_authorities USING btree (account_id, organization_membership_id, resource_kind, resource_id);

CREATE UNIQUE INDEX organization_user_resource_authorities_subscription_resource_uq ON organization_user_resource_authorities USING btree (id, account_id, organization_membership_id, resource_kind, resource_id);

CREATE UNIQUE INDEX organization_user_resource_authorities_xai_tuple_uq ON organization_user_resource_authorities USING btree (id, account_id, organization_membership_id, resource_kind, resource_id, generation);

CREATE UNIQUE INDEX organization_user_resource_grants_active_identity_uq ON organization_user_resource_grants USING btree (account_id, authority_id, workspace_id, action, mode, context, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(authority_epoch, 0)) WHERE (status = 'active'::text);

CREATE INDEX organization_user_resource_grants_authority_workspace_idx ON organization_user_resource_grants USING btree (authority_id, workspace_id, status);

CREATE UNIQUE INDEX organization_user_resource_grants_id_account_idx ON organization_user_resource_grants USING btree (id, account_id);

CREATE UNIQUE INDEX organization_user_retention_deletion_events_operation_kind_uq ON organization_user_retention_deletion_events USING btree (account_id, operation_id, kind);

CREATE INDEX organization_user_retention_deletions_claim_idx ON organization_user_retention_deletions USING btree (account_id, state, claim_expires_at);

CREATE UNIQUE INDEX organization_user_retention_deletions_operation_uq ON organization_user_retention_deletions USING btree (claim_operation_id);

CREATE INDEX organization_user_setup_deliveries_account_updated_idx ON organization_user_setup_deliveries USING btree (account_id, updated_at DESC, id DESC);

CREATE UNIQUE INDEX organization_user_setup_deliveries_token_digest_uq ON organization_user_setup_deliveries USING btree (token_digest) WHERE (token_digest IS NOT NULL);

CREATE INDEX organization_webhook_deliveries_due_idx ON organization_webhook_deliveries USING btree (next_attempt_at, id) WHERE ((delivered_at IS NULL) AND (failed_at IS NULL));

CREATE UNIQUE INDEX organization_webhook_deliveries_event_uq ON organization_webhook_deliveries USING btree (webhook_id, event_id);

CREATE INDEX organization_webhook_deliveries_settled_idx ON organization_webhook_deliveries USING btree (created_at) WHERE ((delivered_at IS NOT NULL) OR (failed_at IS NOT NULL));

CREATE INDEX organization_webhook_deliveries_webhook_recent_idx ON organization_webhook_deliveries USING btree (webhook_id, created_at DESC);

CREATE INDEX organization_webhooks_account_idx ON organization_webhooks USING btree (account_id, created_at);

CREATE INDEX organization_workspace_cancelled_grant_idx ON organization_workspace_operation_receipts USING btree (account_id, ((result ->> 'fencedGrantOperationId'::text))) WHERE ((action = 'revoke'::text) AND (result ? 'fencedGrantOperationId'::text));

CREATE INDEX personal_github_repository_selection_heads_owner_idx ON personal_github_repository_selection_heads USING btree (account_id, owner_subject_id, connection_id);

CREATE INDEX personal_github_repository_selections_tenant_idx ON personal_github_repository_selections USING btree (account_id, origin_workspace_id, connection_id);

CREATE INDEX plan_credit_periods_due_idx ON plan_credit_periods USING btree (period_end, account_id) WHERE (expired_at IS NULL);

CREATE UNIQUE INDEX plan_credit_periods_open_idx ON plan_credit_periods USING btree (account_id) WHERE (expired_at IS NULL);

CREATE UNIQUE INDEX pr_review_app_registrations_source_uq ON pr_review_app_registrations USING btree (source_id);

CREATE UNIQUE INDEX pr_review_app_registrations_workspace_id_provider_uq ON pr_review_app_registrations USING btree (workspace_id, id, provider);

CREATE UNIQUE INDEX pr_review_app_registrations_workspace_id_uq ON pr_review_app_registrations USING btree (workspace_id, id);

CREATE UNIQUE INDEX pr_review_app_registrations_workspace_provider_name_uq ON pr_review_app_registrations USING btree (workspace_id, provider, name);

CREATE INDEX pr_review_app_registrations_workspace_status_idx ON pr_review_app_registrations USING btree (workspace_id, status);

CREATE UNIQUE INDEX pr_review_managed_github_authority_nonce_uq ON pr_review_app_registrations USING btree (authority_nonce) WHERE (authority_nonce IS NOT NULL);

CREATE UNIQUE INDEX pr_review_managed_github_route_identity_uq ON pr_review_managed_github_routes USING btree (installation_id, provider_repository_id);

CREATE UNIQUE INDEX pr_review_managed_github_workspace_installation_uq ON pr_review_app_registrations USING btree (workspace_id, installation_id) WHERE (credential_kind = 'managed_github_app'::text);

CREATE UNIQUE INDEX pr_review_repo_workspace_registration_provider_uq ON pr_review_repository_bindings USING btree (workspace_id, id, registration_id, provider);

CREATE UNIQUE INDEX pr_review_repository_bindings_registration_repo_uq ON pr_review_repository_bindings USING btree (registration_id, provider_repository_id);

CREATE UNIQUE INDEX pr_review_repository_bindings_trigger_uq ON pr_review_repository_bindings USING btree (trigger_id);

CREATE UNIQUE INDEX pr_review_repository_bindings_workspace_id_uq ON pr_review_repository_bindings USING btree (workspace_id, id);

CREATE INDEX pr_review_repository_bindings_workspace_status_idx ON pr_review_repository_bindings USING btree (workspace_id, status);

CREATE INDEX preference_registry_events_timeline_idx ON preference_registry_events USING btree (preference_id, created_at DESC, id);

CREATE INDEX preference_registry_preferences_applicable_idx ON preference_registry_preferences USING btree (account_id, scope, scope_workspace_id, scope_subject_id, status, stable_key);

CREATE UNIQUE INDEX preference_registry_preferences_organization_key_uq ON preference_registry_preferences USING btree (account_id, stable_key) WHERE (scope = 'organization'::text);

CREATE UNIQUE INDEX preference_registry_preferences_user_key_uq ON preference_registry_preferences USING btree (account_id, scope_subject_id, stable_key) WHERE (scope = 'user'::text);

CREATE UNIQUE INDEX preference_registry_preferences_workspace_key_uq ON preference_registry_preferences USING btree (account_id, scope_workspace_id, stable_key) WHERE (scope = 'workspace'::text);

CREATE INDEX preference_registry_revisions_history_idx ON preference_registry_revisions USING btree (preference_id, revision DESC);

CREATE INDEX preference_registry_snapshots_human_timeline_idx ON preference_registry_snapshots USING btree (workspace_id, initiating_human_subject_id, created_at DESC);

CREATE INDEX recording_events_recording_idx ON recording_events USING btree (workspace_id, recording_id);

CREATE INDEX recording_events_workspace_idx ON recording_events USING btree (workspace_id, occurred_at, id);

CREATE INDEX recording_live_segments_sequence_idx ON recording_live_segments USING btree (workspace_id, recording_id, sequence);

CREATE INDEX recording_notes_workspace_idx ON recording_notes USING btree (workspace_id, recording_id);

CREATE UNIQUE INDEX recording_people_external_ref_uq ON recording_people USING btree (workspace_id, external_ref) WHERE (external_ref IS NOT NULL);

CREATE UNIQUE INDEX recording_people_member_uq ON recording_people USING btree (workspace_id, member_subject_id) WHERE (member_subject_id IS NOT NULL);

CREATE INDEX recording_speaker_assignments_person_idx ON recording_speaker_assignments USING btree (workspace_id, person_id) WHERE (person_id IS NOT NULL);

CREATE INDEX recording_speaker_voices_recording_idx ON recording_speaker_voices USING btree (workspace_id, recording_id);

CREATE INDEX recording_transcript_segments_recording_idx ON recording_transcript_segments USING btree (workspace_id, recording_id);

CREATE INDEX recording_transcript_segments_search_idx ON recording_transcript_segments USING gin (search);

CREATE UNIQUE INDEX recording_transcript_versions_current_uq ON recording_transcript_versions USING btree (recording_id) WHERE is_current;

CREATE INDEX recording_voice_rejections_recording_idx ON recording_voice_rejections USING btree (workspace_id, recording_id, person_id);

CREATE INDEX recordings_external_ref_idx ON recordings USING btree (workspace_id, external_ref) WHERE (external_ref IS NOT NULL);

CREATE INDEX recordings_started_idx ON recordings USING btree (workspace_id, started_at DESC, id);

CREATE INDEX remember_knowledge_confirmation_receipts_workspace_time_idx ON remember_knowledge_confirmation_receipts USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX remember_knowledge_memory_materializations_workspace_time_idx ON remember_knowledge_memory_materializations USING btree (workspace_id, created_at DESC, memory_id);

CREATE INDEX retained_screenshot_artifacts_pending_reconcile_idx ON retained_screenshot_artifacts USING btree (updated_at, artifact_id) WHERE (status = ANY (ARRAY['pending'::text, 'reconciling'::text, 'cleanup_queued'::text, 'cleanup_pending'::text]));

CREATE INDEX retained_screenshot_artifacts_ready_expiry_idx ON retained_screenshot_artifacts USING btree (retention_expires_at, artifact_id) WHERE (status = 'ready'::text);

CREATE INDEX retained_screenshot_artifacts_session_created_idx ON retained_screenshot_artifacts USING btree (workspace_id, session_id, created_at, artifact_id);

CREATE INDEX retained_screenshot_artifacts_workspace_ready_age_idx ON retained_screenshot_artifacts USING btree (workspace_id, retention_expires_at, artifact_id) WHERE (status = 'ready'::text);

CREATE INDEX rig_changes_workspace_rig_idx ON rig_changes USING btree (workspace_id, rig_id, created_at);

CREATE INDEX rig_changes_workspace_status_idx ON rig_changes USING btree (workspace_id, status);

CREATE UNIQUE INDEX rig_versions_rig_active_idx ON rig_versions USING btree (rig_id) WHERE active;

CREATE UNIQUE INDEX rig_versions_rig_version_idx ON rig_versions USING btree (rig_id, version);

CREATE INDEX rig_versions_workspace_rig_idx ON rig_versions USING btree (workspace_id, rig_id, version);

CREATE UNIQUE INDEX rigs_organization_name_active_idx ON rigs USING btree (account_id, name) WHERE ((authority_scope = 'organization'::text) AND (status = 'active'::text));

CREATE UNIQUE INDEX rigs_user_name_active_idx ON rigs USING btree (account_id, owner_organization_membership_id, name) WHERE ((authority_scope = 'user'::text) AND (status = 'active'::text));

CREATE INDEX rigs_workspace_created_idx ON rigs USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX rigs_workspace_name_active_idx ON rigs USING btree (workspace_id, name) WHERE ((authority_scope = 'workspace'::text) AND (status = 'active'::text));

CREATE INDEX sandbox_checkpoint_artifacts_gc_idx ON sandbox_checkpoint_artifacts USING btree (delete_after, created_at, id) WHERE (state = ANY (ARRAY['candidate'::text, 'current'::text, 'previous'::text, 'delete_pending'::text, 'delete_failed'::text, 'deleting'::text]));

CREATE UNIQUE INDEX sandbox_checkpoint_artifacts_provider_object_uq ON sandbox_checkpoint_artifacts USING btree (provider_backend, provider_binding_key, object_id);

CREATE INDEX sandbox_checkpoint_artifacts_source_idx ON sandbox_checkpoint_artifacts USING btree (workspace_id, sandbox_group_id, source_lease_id);

CREATE UNIQUE INDEX sandbox_lease_holders_holder_idx ON sandbox_lease_holders USING btree (lease_id, kind, holder_id);

CREATE INDEX sandbox_lease_holders_lease_idx ON sandbox_lease_holders USING btree (lease_id);

CREATE INDEX sandbox_lease_holders_stale_idx ON sandbox_lease_holders USING btree (kind, last_heartbeat_at);

CREATE UNIQUE INDEX sandbox_leases_account_workspace_id_uq ON sandbox_leases USING btree (account_id, workspace_id, id);

CREATE INDEX sandbox_leases_archive_capture_deadline_idx ON sandbox_leases USING btree (archive_capture_deadline_at, id) WHERE (archive_capture_id IS NOT NULL);

CREATE INDEX sandbox_leases_expired_draining_inventory_idx ON sandbox_leases USING btree (expires_at, backend) WHERE (liveness = 'draining'::text);

CREATE UNIQUE INDEX sandbox_leases_group_idx ON sandbox_leases USING btree (workspace_id, sandbox_group_id);

CREATE INDEX sandbox_leases_provider_deadline_idx ON sandbox_leases USING btree (provider_deadline_at, id) WHERE ((backend = 'modal'::text) AND (liveness = ANY (ARRAY['warming'::text, 'warm'::text])) AND (rotation_requested_at IS NULL));

CREATE INDEX sandbox_leases_reaper_idx ON sandbox_leases USING btree (expires_at) WHERE (liveness = ANY (ARRAY['warming'::text, 'warm'::text, 'draining'::text]));

CREATE UNIQUE INDEX sandbox_leases_scoped_id_uq ON sandbox_leases USING btree (account_id, workspace_id, sandbox_group_id, id);

CREATE UNIQUE INDEX sandbox_pty_sessions_open_process_uq ON sandbox_pty_sessions USING btree (retained_process_id) WHERE (status = 'open'::text);

CREATE INDEX sandbox_pty_sessions_session_idx ON sandbox_pty_sessions USING btree (workspace_id, session_id) WHERE (status = 'open'::text);

CREATE INDEX sandbox_retained_processes_active_idx ON sandbox_retained_processes USING btree (workspace_id, session_id, started_at) WHERE (state = 'active'::text);

CREATE INDEX sandbox_retained_processes_active_inventory_idx ON sandbox_retained_processes USING btree (owner_actor_kind, workspace_id, owner_turn_id, owner_attempt_id) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX sandbox_retained_processes_holder_uq ON sandbox_retained_processes USING btree (lease_id, holder_id);

CREATE INDEX sandbox_retained_processes_initiating_human_idx ON sandbox_retained_processes USING btree (account_id, initiating_human_subject_id) WHERE (state = 'active'::text);

CREATE INDEX sandbox_retained_processes_initiator_idx ON sandbox_retained_processes USING btree (account_id, initiator_organization_membership_id) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX sandbox_retained_processes_live_provider_session_uq ON sandbox_retained_processes USING btree (lease_id, lease_epoch, provider_instance_id, route_epoch, provider_session_id) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX sandbox_retained_processes_parent_admission_uq ON sandbox_retained_processes USING btree (parent_admission_id);

CREATE INDEX sandbox_retained_processes_reconcile_due_idx ON sandbox_retained_processes USING btree (reconcile_after, started_at, id) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX sandbox_retained_processes_scoped_id_uq ON sandbox_retained_processes USING btree (account_id, workspace_id, session_id, lease_id, id);

CREATE UNIQUE INDEX sandbox_session_envelopes_session_idx ON sandbox_session_envelopes USING btree (workspace_id, session_id);

CREATE INDEX sandbox_workspace_mutation_admissions_actor_idx ON sandbox_workspace_mutation_admissions USING btree (workspace_id, actor_kind, actor_id);

CREATE INDEX sandbox_workspace_mutation_admissions_attempt_idx ON sandbox_workspace_mutation_admissions USING btree (workspace_id, attempt_id);

CREATE INDEX sandbox_workspace_mutation_admissions_blocking_idx ON sandbox_workspace_mutation_admissions USING btree (lease_id, workspace_generation) WHERE (settled_at IS NULL);

CREATE INDEX sandbox_workspace_mutation_admissions_initiator_idx ON sandbox_workspace_mutation_admissions USING btree (account_id, initiator_organization_membership_id) WHERE (settled_at IS NULL);

CREATE UNIQUE INDEX sandbox_workspace_mutation_admissions_lease_generation_uq ON sandbox_workspace_mutation_admissions USING btree (lease_id, workspace_generation);

CREATE UNIQUE INDEX sandbox_workspace_mutation_admissions_scoped_id_uq ON sandbox_workspace_mutation_admissions USING btree (account_id, workspace_id, session_id, lease_id, id);

CREATE INDEX sandbox_workspace_mutation_admissions_settled_idx ON sandbox_workspace_mutation_admissions USING btree (lease_id, settled_at) WHERE (settled_at IS NOT NULL);

CREATE INDEX sandbox_workspace_mutation_admissions_unsettled_session_idx ON sandbox_workspace_mutation_admissions USING btree (workspace_id, session_id) WHERE (settled_at IS NULL);

CREATE INDEX sandboxes_enrollment_idx ON sandboxes USING btree (enrollment_id) WHERE (enrollment_id IS NOT NULL);

CREATE INDEX sandboxes_workspace_created_idx ON sandboxes USING btree (workspace_id, created_at);

CREATE INDEX scheduled_reusable_connection_task_idx ON scheduled_task_reusable_connection_materializations USING btree (task_id, materialized_at DESC);

CREATE INDEX scheduled_run_connection_authority_grant_idx ON scheduled_task_run_connection_authority_snapshots USING btree (account_id, grant_id, run_id);

CREATE INDEX scheduled_task_blocker_reviews_workspace_idx ON scheduled_task_blocker_reviews USING btree (workspace_id, task_id);

CREATE INDEX scheduled_task_connection_authority_grant_idx ON scheduled_task_connection_authority_snapshots USING btree (account_id, grant_id, task_id);

CREATE INDEX scheduled_task_event_inbox_event_idx ON scheduled_task_event_inbox USING btree (event_id);

CREATE INDEX scheduled_task_event_inbox_pending_idx ON scheduled_task_event_inbox USING btree (task_id, occurred_at, id) WHERE (status = 'pending'::text);

CREATE INDEX scheduled_task_event_inbox_workspace_idx ON scheduled_task_event_inbox USING btree (workspace_id, task_id);

CREATE INDEX scheduled_task_event_occurrences_pending_idx ON scheduled_task_event_occurrences USING btree (task_id, created_at) WHERE (status = 'pending'::text);

CREATE INDEX scheduled_task_event_occurrences_task_idx ON scheduled_task_event_occurrences USING btree (workspace_id, task_id, created_at DESC);

CREATE INDEX scheduled_task_event_settings_due_idx ON scheduled_task_event_settings USING btree (dispatch_due_at, task_id) WHERE (dispatch_due_at IS NOT NULL);

CREATE INDEX scheduled_task_event_settings_workspace_idx ON scheduled_task_event_settings USING btree (workspace_id, task_id);

CREATE INDEX scheduled_task_personal_resource_snapshots_authority_idx ON scheduled_task_personal_resource_snapshots USING btree (account_id, authority_id, authority_generation);

CREATE INDEX scheduled_task_personal_resource_snapshots_grant_idx ON scheduled_task_personal_resource_snapshots USING btree (account_id, grant_id, grant_generation);

CREATE INDEX scheduled_task_run_personal_resource_snapshots_authority_idx ON scheduled_task_run_personal_resource_snapshots USING btree (account_id, authority_id, authority_generation);

CREATE INDEX scheduled_task_runs_knowledge_sync_idx ON scheduled_task_runs USING btree (workspace_id, knowledge_sync_run_id) WHERE (knowledge_sync_run_id IS NOT NULL);

CREATE UNIQUE INDEX scheduled_task_runs_producer_key_uq ON scheduled_task_runs USING btree (workspace_id, producer_key) WHERE (producer_key IS NOT NULL);

CREATE UNIQUE INDEX scheduled_task_runs_workspace_id_uq ON scheduled_task_runs USING btree (workspace_id, id);

CREATE INDEX scheduled_task_runs_workspace_session_idx ON scheduled_task_runs USING btree (workspace_id, session_id);

CREATE INDEX scheduled_task_runs_workspace_task_created_idx ON scheduled_task_runs USING btree (workspace_id, task_id, created_at);

CREATE INDEX scheduled_task_schedule_outbox_due_idx ON scheduled_task_schedule_outbox USING btree (next_attempt_at, id);

CREATE INDEX scheduled_tasks_live_workspace_created_idx ON scheduled_tasks USING btree (workspace_id, created_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX scheduled_tasks_rig_idx ON scheduled_tasks USING btree (workspace_id, rig_id);

CREATE INDEX scheduled_tasks_variable_set_idx ON scheduled_tasks USING btree (workspace_id, variable_set_id);

CREATE INDEX scheduled_tasks_workspace_session_target_idx ON scheduled_tasks USING btree (workspace_id, reusable_session_id) WHERE (deleted_at IS NULL);

CREATE INDEX scheduled_tasks_workspace_status_idx ON scheduled_tasks USING btree (workspace_id, status);

CREATE UNIQUE INDEX scheduled_tasks_workspace_temporal_schedule_id_idx ON scheduled_tasks USING btree (workspace_id, temporal_schedule_id);

CREATE INDEX secret_use_approvals_grants_idx ON secret_use_approvals USING btree (workspace_id, approver_subject_id) WHERE (status = 'approved'::text);

CREATE INDEX secret_use_approvals_session_idx ON secret_use_approvals USING btree (session_id, created_at DESC);

CREATE INDEX secret_use_approvals_targets_idx ON secret_use_approvals USING gin (targets jsonb_path_ops) WHERE (status = 'approved'::text);

CREATE INDEX session_admin_access_account_idx ON session_admin_access USING btree (account_id);

CREATE INDEX session_attempt_codemode_calls_active_attempt_idx ON session_attempt_codemode_calls USING btree (workspace_id, attempt_id, state) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text]));

CREATE INDEX session_attempt_codemode_calls_session_turn_idx ON session_attempt_codemode_calls USING btree (workspace_id, session_id, turn_id, created_at);

CREATE INDEX session_attempt_interruptions_attempt_lookup_idx ON session_attempt_interruptions USING btree (workspace_id, session_id, attempt_id, requested_at DESC);

CREATE INDEX session_attempt_interruptions_open_settlement_idx ON session_attempt_interruptions USING btree (workspace_id, session_id) WHERE ((state = ANY (ARRAY['pending'::text, 'delivered'::text, 'acknowledged'::text])) OR (NOT attempt_quiesced));

CREATE INDEX session_attempt_interruptions_unsettled_idx ON session_attempt_interruptions USING btree (workspace_id, session_id, requested_at) WHERE (state = ANY (ARRAY['pending'::text, 'delivered'::text, 'acknowledged'::text]));

CREATE INDEX session_attempt_model_context_snapshots_session_idx ON session_attempt_model_context_snapshots USING btree (workspace_id, session_id, captured_at DESC);

CREATE UNIQUE INDEX session_attempt_personal_resource_admissions_identity_uq ON session_attempt_personal_resource_admissions USING btree (account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation);

CREATE INDEX session_attempt_personal_resource_snapshots_authority_idx ON session_attempt_personal_resource_snapshots USING btree (account_id, authority_id, authority_generation);

CREATE INDEX session_attempt_personal_resource_snapshots_grant_idx ON session_attempt_personal_resource_snapshots USING btree (account_id, grant_id, grant_generation);

CREATE UNIQUE INDEX session_attempt_tool_catalogs_exact_authority_digest_uidx ON session_attempt_tool_catalogs USING btree (account_id, workspace_id, session_id, turn_id, attempt_id, execution_generation, digest);

CREATE INDEX session_attempt_tool_catalogs_session_turn_idx ON session_attempt_tool_catalogs USING btree (workspace_id, session_id, turn_id);

CREATE INDEX session_background_commands_active_session_idx ON session_background_commands USING btree (workspace_id, session_id, state, started_at, id) WHERE (state = ANY (ARRAY['running'::text, 'stopping'::text]));

CREATE INDEX session_background_commands_captured_output_release_idx ON session_background_commands USING btree (((output_consumed_at IS NULL)), reconcile_after, started_at, id) WHERE ((provider = 'connected_machine'::text) AND (state = 'exited'::text) AND (output_release_observed_at IS NULL) AND (output_unavailable_at IS NULL));

CREATE UNIQUE INDEX session_background_commands_connected_op_uq ON session_background_commands USING btree (control_workspace_id, enrollment_id, connection_instance_id, op_id) WHERE (provider = 'connected_machine'::text);

CREATE INDEX session_background_commands_output_release_idx ON session_background_commands USING btree (reconcile_after, started_at, id) WHERE ((provider = 'connected_machine'::text) AND (state = 'exited'::text) AND (output_release_observed_at IS NULL) AND (output_unavailable_at IS NULL));

CREATE UNIQUE INDEX session_background_commands_process_uq ON session_background_commands USING btree (retained_process_id) WHERE (retained_process_id IS NOT NULL);

CREATE INDEX session_background_commands_stopping_idx ON session_background_commands USING btree (reconcile_after, cancel_requested_at, id) WHERE (state = ANY (ARRAY['running'::text, 'stopping'::text]));

CREATE UNIQUE INDEX session_command_receipts_goal_progress_operation_uq ON session_command_receipts USING btree (workspace_id, action, target_session_id, operation_key) WHERE (action = 'goal.progress'::text);

CREATE UNIQUE INDEX session_command_receipts_goal_update_operation_uq ON session_command_receipts USING btree (workspace_id, action, target_session_id, operation_key) WHERE (action = 'goal.update'::text);

CREATE UNIQUE INDEX session_command_receipts_idempotency_uq ON session_command_receipts USING btree (workspace_id, actor_type, actor_subject_id, actor_attempt_id, action, target_session_id, target_turn_id, operation_key) NULLS NOT DISTINCT;

CREATE INDEX session_command_receipts_prompt_actor_operation_idx ON session_command_receipts USING btree (workspace_id, actor_type, actor_subject_id, actor_attempt_id, operation_key) WHERE (action = ANY (ARRAY['prompt.send'::text, 'prompt.steer'::text]));

CREATE UNIQUE INDEX session_command_receipts_scheduled_goal_run_uq ON session_command_receipts USING btree (workspace_id, action, operation_key) WHERE (action = 'scheduled.goal.reset'::text);

CREATE INDEX session_command_receipts_target_created_idx ON session_command_receipts USING btree (workspace_id, target_session_id, created_at);

CREATE UNIQUE INDEX session_command_receipts_wait_for_input_operation_uq ON session_command_receipts USING btree (workspace_id, action, target_session_id, operation_key) WHERE (action = 'session.wait_for_input'::text);

CREATE UNIQUE INDEX session_command_receipts_workspace_id_uq ON session_command_receipts USING btree (workspace_id, id);

CREATE INDEX session_content_blobs_session_idx ON session_content_blobs USING btree (session_id);

CREATE UNIQUE INDEX session_event_cursors_workspace_session_idx ON session_event_cursors USING btree (workspace_id, session_id);

CREATE INDEX session_events_command_output_client_idx ON session_events USING btree (workspace_id, session_id, client_event_id COLLATE "C", sequence) WHERE (type = 'sandbox.command.output.delta'::text);

CREATE INDEX session_events_command_output_page_idx ON session_events USING btree (workspace_id, session_id, ((payload ->> 'commandId'::text)), sequence) WHERE (type = 'sandbox.command.output.delta'::text);

CREATE UNIQUE INDEX session_events_current_model_usage_source_uq ON session_events USING btree (workspace_id, session_id, turn_id, ((payload ->> 'sourceKey'::text))) WHERE ((type = 'agent.model.usage'::text) AND (turn_association = 'current'::text) AND (turn_id IS NOT NULL) AND (NULLIF((payload ->> 'sourceKey'::text), ''::text) IS NOT NULL));

CREATE INDEX session_events_duplicate_of_event_idx ON session_events USING btree (duplicate_of_event_id);

CREATE INDEX session_events_meaningful_attention_idx ON session_events USING btree (workspace_id, session_id, sequence) WHERE ((type = ANY (ARRAY['agent.message.completed'::text, 'turn.completed'::text, 'turn.failed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'tool.auth_needed'::text, 'credential.auth_needed'::text, 'goal.completed'::text, 'goal.paused'::text, 'goal.progress'::text, 'goal.rewrite.proposed'::text, 'rig.setup.failed'::text, 'sandbox.operation.failed'::text, 'sandbox.box.lost'::text, 'workspace.revision.degraded'::text, 'machine.op.failed'::text, 'machine.link.lost'::text, 'session.event.envelope_omitted'::text])) AND (duplicate_of_event_id IS NULL) AND ((turn_association IS NULL) OR (turn_association = 'current'::text)) AND ((type <> 'agent.message.completed'::text) OR (COALESCE((payload ->> 'text'::text), ''::text) <> ''::text)) AND ((type <> 'turn.completed'::text) OR ((NOT (payload ?| ARRAY['maintenance'::text, 'segmentLimit'::text])) AND (COALESCE(NULLIF((payload -> 'output'::text), 'null'::jsonb), (payload -> 'result'::text)) IS NOT NULL) AND (COALESCE(NULLIF((payload -> 'output'::text), 'null'::jsonb), (payload -> 'result'::text)) <> ALL (ARRAY['null'::jsonb, '""'::jsonb])))));

CREATE INDEX session_events_meaningful_attention_v2_idx ON session_events USING btree (workspace_id, session_id, sequence) WHERE ((type = ANY (ARRAY['agent.message.completed'::text, 'turn.completed'::text, 'turn.failed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'tool.auth_needed'::text, 'credential.auth_needed'::text, 'goal.completed'::text, 'goal.paused'::text, 'goal.progress'::text, 'goal.rewrite.proposed'::text, 'rig.setup.failed'::text, 'sandbox.operation.failed'::text, 'sandbox.box.lost'::text, 'workspace.revision.degraded'::text, 'machine.op.failed'::text, 'machine.link.lost'::text, 'session.event.envelope_omitted'::text])) AND (duplicate_of_event_id IS NULL) AND ((turn_association IS NULL) OR (turn_association = 'current'::text)) AND ((type <> 'agent.message.completed'::text) OR (COALESCE((payload ->> 'text'::text), ''::text) <> ''::text)) AND ((type <> 'agent.message.completed'::text) OR (COALESCE((payload ->> 'phase'::text), ''::text) <> 'commentary'::text)) AND ((type <> 'turn.completed'::text) OR ((NOT (payload ?| ARRAY['maintenance'::text, 'segmentLimit'::text])) AND (((COALESCE(NULLIF((payload -> 'output'::text), 'null'::jsonb), (payload -> 'result'::text)) IS NOT NULL) AND (COALESCE(NULLIF((payload -> 'output'::text), 'null'::jsonb), (payload -> 'result'::text)) <> ALL (ARRAY['null'::jsonb, '""'::jsonb]))) OR (COALESCE((payload ->> 'reply'::text), ''::text) <> ''::text)))));

CREATE INDEX session_events_meaningful_attention_v3_idx ON session_events USING btree (workspace_id, session_id, sequence) WHERE ((type = ANY (ARRAY['agent.message.completed'::text, 'turn.completed'::text, 'turn.failed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'tool.auth_needed'::text, 'credential.auth_needed'::text, 'goal.completed'::text, 'goal.paused'::text, 'goal.progress'::text, 'goal.rewrite.proposed'::text, 'rig.setup.failed'::text, 'sandbox.operation.failed'::text, 'sandbox.box.lost'::text, 'workspace.revision.degraded'::text, 'machine.op.failed'::text, 'machine.link.lost'::text, 'session.event.envelope_omitted'::text])) AND (duplicate_of_event_id IS NULL) AND ((turn_association IS NULL) OR (turn_association = 'current'::text)) AND ((type <> 'agent.message.completed'::text) OR (COALESCE((payload ->> 'text'::text), ''::text) <> ''::text)) AND ((type <> 'agent.message.completed'::text) OR (COALESCE((payload ->> 'phase'::text), ''::text) <> 'commentary'::text)) AND ((type <> 'turn.completed'::text) OR ((payload ->> 'segmentLimit'::text) = 'session_usage_limit'::text) OR ((NOT (payload ?| ARRAY['maintenance'::text, 'segmentLimit'::text])) AND (((COALESCE(NULLIF((payload -> 'output'::text), 'null'::jsonb), (payload -> 'result'::text)) IS NOT NULL) AND (COALESCE(NULLIF((payload -> 'output'::text), 'null'::jsonb), (payload -> 'result'::text)) <> ALL (ARRAY['null'::jsonb, '""'::jsonb]))) OR (COALESCE((payload ->> 'reply'::text), ''::text) <> ''::text)))));

CREATE INDEX session_events_model_fact_page_idx ON session_events USING btree (workspace_id, session_id, turn_id, occurred_at, id) WHERE (type = 'agent.model.usage'::text);

CREATE INDEX session_events_tool_call_fallback_page_idx ON session_events USING btree (workspace_id, session_id, sequence) WHERE ((type = ANY (ARRAY['agent.toolCall.created'::text, 'agent.toolCall.output'::text])) AND ((tool_call_id IS NULL) OR (octet_length(tool_call_id) > 2048)));

CREATE INDEX session_events_tool_call_page_idx ON session_events USING btree (workspace_id, session_id, tool_call_id, sequence) WHERE ((type = ANY (ARRAY['agent.toolCall.created'::text, 'agent.toolCall.output'::text])) AND (tool_call_id IS NOT NULL) AND (octet_length(tool_call_id) <= 2048));

CREATE INDEX session_events_tool_name_fallback_page_idx ON session_events USING btree (workspace_id, session_id, sequence) WHERE ((type = 'agent.toolCall.created'::text) AND ((tool_name IS NULL) OR (octet_length(tool_name) > 2048)));

CREATE INDEX session_events_tool_name_page_idx ON session_events USING btree (workspace_id, session_id, tool_name, sequence) WHERE ((type = 'agent.toolCall.created'::text) AND (tool_name IS NOT NULL) AND (octet_length(tool_name) <= 2048));

CREATE INDEX session_events_usage_source_key_idx ON session_events USING btree (workspace_id, turn_id, usage_source_key) WHERE (usage_source_key IS NOT NULL);

CREATE INDEX session_events_workspace_attempt_idx ON session_events USING btree (workspace_id, turn_attempt_id) WHERE (turn_attempt_id IS NOT NULL);

CREATE UNIQUE INDEX session_events_workspace_client_event_idx ON session_events USING btree (workspace_id, session_id, client_event_id) WHERE (client_event_id IS NOT NULL);

CREATE UNIQUE INDEX session_events_workspace_id_uq ON session_events USING btree (workspace_id, id);

CREATE UNIQUE INDEX session_events_workspace_producer_idx ON session_events USING btree (workspace_id, session_id, producer_id, producer_seq) WHERE ((producer_id IS NOT NULL) AND (producer_seq IS NOT NULL));

CREATE INDEX session_events_workspace_session_created_idx ON session_events USING btree (workspace_id, session_id, created_at);

CREATE INDEX session_events_workspace_session_monitoring_tail_idx ON session_events USING btree (workspace_id, session_id, sequence DESC) WHERE (type <> ALL (ARRAY['agent.message.delta'::text, 'agent.reasoning.delta'::text, 'sandbox.command.output.delta'::text, 'terminal.pty.output.delta'::text]));

CREATE UNIQUE INDEX session_events_workspace_session_sequence_idx ON session_events USING btree (workspace_id, session_id, sequence);

CREATE INDEX session_events_workspace_session_type_sequence_idx ON session_events USING btree (workspace_id, session_id, type, sequence DESC);

CREATE INDEX session_events_workspace_turn_type_idx ON session_events USING btree (workspace_id, turn_id, type) WHERE (turn_id IS NOT NULL);

CREATE UNIQUE INDEX session_goal_revisions_applied_revision_uq ON session_goal_revisions USING btree (workspace_id, goal_id, result_objective_revision) WHERE (disposition = 'applied'::text);

CREATE INDEX session_goal_revisions_goal_timeline_idx ON session_goal_revisions USING btree (workspace_id, goal_id, created_at, id);

CREATE UNIQUE INDEX session_goal_revisions_proposal_decision_uq ON session_goal_revisions USING btree (workspace_id, proposal_id) WHERE ((proposal_id IS NOT NULL) AND (disposition = ANY (ARRAY['applied'::text, 'rejected'::text])));

CREATE UNIQUE INDEX session_goal_revisions_rollback_request_uq ON session_goal_revisions USING btree (workspace_id, goal_id, rollback_of_revision_id, base_objective_revision) WHERE ((disposition = 'applied'::text) AND (rollback_of_revision_id IS NOT NULL));

CREATE UNIQUE INDEX session_goal_revisions_workspace_id_uq ON session_goal_revisions USING btree (workspace_id, id);

CREATE INDEX session_goals_discovery_active_text_fts_idx ON session_goals USING gin (to_tsvector('simple'::regconfig, text)) WHERE (status = 'active'::text);

CREATE UNIQUE INDEX session_goals_workspace_id_idx ON session_goals USING btree (workspace_id, id);

CREATE UNIQUE INDEX session_goals_workspace_session_idx ON session_goals USING btree (workspace_id, session_id);

CREATE INDEX session_goals_workspace_status_idx ON session_goals USING btree (workspace_id, status);

CREATE INDEX session_history_items_active_idx ON session_history_items USING btree (workspace_id, session_id, "position") WHERE active;

CREATE UNIQUE INDEX session_history_items_position_idx ON session_history_items USING btree (workspace_id, session_id, "position");

CREATE INDEX session_history_items_scope_turn_position_idx ON session_history_items USING btree (workspace_id, session_id, turn_id, "position") WHERE (turn_id IS NOT NULL);

CREATE INDEX session_history_items_tool_router_idx ON session_history_items USING btree (workspace_id, session_id) WHERE (((item_ordered ->> 'type'::text) = ANY (ARRAY['tool_search_call'::text, 'tool_search_output'::text])) OR (((item_ordered ->> 'type'::text) = 'function_call'::text) AND ((item_ordered ->> 'name'::text) = ANY (ARRAY['tool_search'::text, 'tool_list'::text, 'tool_invoke'::text]))));

CREATE INDEX session_history_items_turn_id_idx ON session_history_items USING btree (turn_id) WHERE (turn_id IS NOT NULL);

CREATE INDEX session_history_items_turn_position_idx ON session_history_items USING btree (turn_id, "position") WHERE (turn_id IS NOT NULL);

CREATE INDEX session_human_input_requests_pending_expiry_idx ON session_human_input_requests USING btree (expires_at, id) WHERE ((status = 'pending'::text) AND (expires_at IS NOT NULL));

CREATE INDEX session_human_input_requests_pending_session_idx ON session_human_input_requests USING btree (workspace_id, session_id, created_at, id) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX session_human_input_requests_tool_call_uq ON session_human_input_requests USING btree (workspace_id, session_id, turn_id, tool_call_id);

CREATE INDEX session_list_snapshots_expiry_reaper_idx ON session_list_snapshots USING btree (expires_at, id);

CREATE INDEX session_list_snapshots_workspace_expiry_idx ON session_list_snapshots USING btree (workspace_id, subject_id, expires_at);

CREATE INDEX session_mcp_servers_session_idx ON session_mcp_servers USING btree (workspace_id, session_id);

CREATE UNIQUE INDEX session_mcp_servers_session_server_idx ON session_mcp_servers USING btree (workspace_id, session_id, server_id);

CREATE INDEX session_message_search_texts_encoded_idx ON session_message_search_texts USING btree (workspace_id) WHERE encoded;

CREATE INDEX session_message_search_texts_trgm_idx ON session_message_search_texts USING gin (workspace_id, text gin_trgm_ops);

CREATE INDEX session_pending_tool_calls_session_turn_idx ON session_pending_tool_calls USING btree (workspace_id, session_id, turn_id);

CREATE UNIQUE INDEX session_pending_tool_calls_turn_call_idx ON session_pending_tool_calls USING btree (workspace_id, turn_id, call_id);

CREATE INDEX session_pins_session_subject_idx ON session_pins USING btree (session_id, subject_id);

CREATE UNIQUE INDEX session_pins_subject_workspace_session_idx ON session_pins USING btree (subject_id, workspace_id, session_id);

CREATE INDEX session_pins_workspace_subject_archived_idx ON session_pins USING btree (workspace_id, subject_id, archived, archived_at DESC, session_id DESC);

CREATE INDEX session_pins_workspace_subject_pinned_idx ON session_pins USING btree (workspace_id, subject_id, pinned, pinned_at DESC, session_id DESC);

CREATE UNIQUE INDEX session_realtime_connections_epoch_uq ON session_realtime_connections USING btree (realtime_id, connection_epoch);

CREATE UNIQUE INDEX session_realtime_connections_one_active_uq ON session_realtime_connections USING btree (realtime_id) WHERE (((promotion_mode = 'legacy'::text) AND (state = ANY (ARRAY['negotiating'::text, 'ready'::text, 'active'::text]))) OR ((promotion_mode = 'staged'::text) AND (state = 'active'::text)));

CREATE UNIQUE INDEX session_realtime_connections_one_preparing_uq ON session_realtime_connections USING btree (realtime_id) WHERE (((promotion_mode = 'legacy'::text) AND (state = ANY (ARRAY['negotiating'::text, 'ready'::text, 'active'::text]))) OR ((promotion_mode = 'staged'::text) AND (state = ANY (ARRAY['negotiating'::text, 'ready'::text]))));

CREATE UNIQUE INDEX session_realtime_connections_operation_uq ON session_realtime_connections USING btree (realtime_id, operation_id);

CREATE UNIQUE INDEX session_realtime_context_projections_turn_uq ON session_realtime_context_projections USING btree (workspace_id, session_id, turn_id);

CREATE UNIQUE INDEX session_realtime_entries_delegation_call_uq ON session_realtime_entries USING btree (realtime_id, delegation_item_id) WHERE ((kind = 'delegation_call'::text) AND (delegation_item_id IS NOT NULL));

CREATE UNIQUE INDEX session_realtime_entries_delegation_terminal_uq ON session_realtime_entries USING btree (turn_id) WHERE ((direction = 'provider_out'::text) AND (kind = ANY (ARRAY['delegation_result'::text, 'error'::text])) AND (turn_id IS NOT NULL));

CREATE UNIQUE INDEX session_realtime_entries_delegation_turn_uq ON session_realtime_entries USING btree (turn_id) WHERE ((kind = 'delegation_call'::text) AND (turn_id IS NOT NULL));

CREATE INDEX session_realtime_entries_history_item_idx ON session_realtime_entries USING btree (history_item_id) WHERE (history_item_id IS NOT NULL);

CREATE UNIQUE INDEX session_realtime_entries_operation_uq ON session_realtime_entries USING btree (realtime_id, operation_id);

CREATE INDEX session_realtime_entries_outbound_pending_idx ON session_realtime_entries USING btree (realtime_id, sequence) WHERE ((direction = 'provider_out'::text) AND (provider_acked_at IS NULL));

CREATE UNIQUE INDEX session_realtime_entries_sequence_uq ON session_realtime_entries USING btree (realtime_id, sequence);

CREATE UNIQUE INDEX session_realtime_entries_source_update_uq ON session_realtime_entries USING btree (realtime_id, source_update_id) WHERE (source_update_id IS NOT NULL);

CREATE INDEX session_realtime_modes_active_lease_idx ON session_realtime_modes USING btree (lease_expires_at, workspace_id, session_id) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX session_realtime_modes_one_active_uq ON session_realtime_modes USING btree (workspace_id, session_id) WHERE (state = 'active'::text);

CREATE UNIQUE INDEX session_realtime_modes_operation_uq ON session_realtime_modes USING btree (workspace_id, session_id, operation_id);

CREATE INDEX session_realtime_modes_pending_context_idx ON session_realtime_modes USING btree (workspace_id, session_id, ended_at, id) WHERE ((state = 'ended'::text) AND (context_projection_id IS NULL));

CREATE INDEX session_recordings_session_idx ON session_recordings USING btree (workspace_id, session_id, created_at DESC);

CREATE INDEX session_spawn_denials_parent_idx ON session_spawn_denials USING btree (workspace_id, parent_session_id, created_at);

CREATE INDEX session_spawn_denials_workspace_created_idx ON session_spawn_denials USING btree (workspace_id, created_at);

CREATE UNIQUE INDEX session_spawn_denials_workspace_id_uq ON session_spawn_denials USING btree (workspace_id, id);

CREATE UNIQUE INDEX session_spawn_denials_workspace_idempotency_idx ON session_spawn_denials USING btree (workspace_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX session_stream_ack_group_idx ON session_stream_acknowledgments USING btree (workspace_id, sandbox_group_id);

CREATE UNIQUE INDEX session_stream_ack_subject_idx ON session_stream_acknowledgments USING btree (workspace_id, sandbox_group_id, subject_id);

CREATE UNIQUE INDEX session_system_update_outbox_dedupe_uq ON session_system_update_outbox USING btree (workspace_id, dedupe_key);

CREATE INDEX session_system_update_outbox_pending_idx ON session_system_update_outbox USING btree (status, created_at);

CREATE UNIQUE INDEX session_system_updates_dedupe_uq ON session_system_updates USING btree (workspace_id, session_id, dedupe_key);

CREATE INDEX session_system_updates_delivered_turn_idx ON session_system_updates USING btree (workspace_id, delivered_turn_id) WHERE (delivered_turn_id IS NOT NULL);

CREATE INDEX session_system_updates_history_item_idx ON session_system_updates USING btree (workspace_id, delivered_history_item_id) WHERE (delivered_history_item_id IS NOT NULL);

CREATE UNIQUE INDEX session_system_updates_one_pending_steer_idx ON session_system_updates USING btree (workspace_id, session_id) WHERE ((kind = 'agent_steer_instruction'::text) AND (state = 'pending'::text));

CREATE INDEX session_system_updates_pending_idx ON session_system_updates USING btree (workspace_id, session_id, state, created_at);

CREATE INDEX session_system_updates_pending_kind_source_idx ON session_system_updates USING btree (workspace_id, session_id, kind, source_id) WHERE (state = 'pending'::text);

CREATE INDEX session_system_updates_pending_terminal_repair_idx ON session_system_updates USING btree (workspace_id, session_id, source_id, dedupe_key) WHERE ((state = 'pending'::text) AND (kind = 'child_terminal_result'::text));

CREATE UNIQUE INDEX session_system_updates_workspace_id_uq ON session_system_updates USING btree (workspace_id, id);

CREATE INDEX session_title_operations_recovery_idx ON session_title_operations USING btree (workflow_retry_at, id) WHERE (state = ANY (ARRAY['pending'::text, 'dispatching'::text, 'responded'::text]));

CREATE UNIQUE INDEX session_title_operations_session_uq ON session_title_operations USING btree (workspace_id, session_id) WHERE (state = ANY (ARRAY['pending'::text, 'dispatching'::text, 'responded'::text]));

CREATE UNIQUE INDEX session_title_operations_source_uq ON session_title_operations USING btree (workspace_id, source_turn_id);

CREATE INDEX session_turn_attempts_authority_epoch_idx ON session_turn_attempts USING btree (workspace_id, session_id, authority_epoch);

CREATE UNIQUE INDEX session_turn_attempts_dispatch_uq ON session_turn_attempts USING btree (workspace_id, temporal_workflow_run_id, temporal_activity_id);

CREATE UNIQUE INDEX session_turn_attempts_human_input_owner_uq ON session_turn_attempts USING btree (account_id, workspace_id, session_id, turn_id, id);

CREATE INDEX session_turn_attempts_latest_session_idx ON session_turn_attempts USING btree (workspace_id, session_id, started_at DESC, id DESC);

CREATE INDEX session_turn_attempts_lease_expiry_idx ON session_turn_attempts USING btree (lease_expires_at, workspace_id, session_id) WHERE (state = ANY (ARRAY['claimed'::text, 'running'::text]));

CREATE UNIQUE INDEX session_turn_attempts_live_session_uq ON session_turn_attempts USING btree (workspace_id, session_id) WHERE (state = ANY (ARRAY['claimed'::text, 'running'::text]));

CREATE UNIQUE INDEX session_turn_attempts_live_turn_uq ON session_turn_attempts USING btree (workspace_id, turn_id) WHERE (state = ANY (ARRAY['claimed'::text, 'running'::text]));

CREATE UNIQUE INDEX session_turn_attempts_workspace_id_uq ON session_turn_attempts USING btree (workspace_id, id);

CREATE INDEX session_turn_startup_milestones_workspace_session_idx ON session_turn_startup_milestones USING btree (workspace_id, session_id);

CREATE INDEX session_turns_finished_order_idx ON session_turns USING btree (workspace_id, session_id, finished_at DESC, "position" DESC, created_at DESC) WHERE (finished_at IS NOT NULL);

CREATE INDEX session_turns_human_prompt_subject_idx ON session_turns USING btree (workspace_id, initiator_subject_id, session_id) WHERE ((initiator_kind = 'subject'::text) AND (source = ANY (ARRAY['user'::text, 'api'::text])) AND (surface IS DISTINCT FROM 'agent'::text));

CREATE UNIQUE INDEX session_turns_one_current_inference_uq ON session_turns USING btree (workspace_id, session_id) WHERE (status = ANY (ARRAY['running'::text, 'requires_action'::text, 'recovering'::text, 'waiting_capacity'::text]));

CREATE INDEX session_turns_prompt_queue_idx ON session_turns USING btree (workspace_id, session_id, "position") WHERE (status = 'queued'::text);

CREATE UNIQUE INDEX session_turns_scheduled_task_run_idx ON session_turns USING btree (workspace_id, scheduled_task_run_id) WHERE (scheduled_task_run_id IS NOT NULL);

CREATE INDEX session_turns_settled_fold_idx ON session_turns USING btree (updated_at, id) WHERE (status = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'withdrawn_for_edit'::text]));

CREATE INDEX session_turns_setup_outcome_unknown_idx ON session_turns USING btree (workspace_id, session_id) WHERE ((status = 'recovering'::text) AND (metadata ? 'sandboxSetupOutcomeUnknown'::text));

CREATE INDEX session_turns_unclaimed_prompt_trigger_idx ON session_turns USING btree (workspace_id, session_id, trigger_event_id) WHERE (started_at IS NULL);

CREATE UNIQUE INDEX session_turns_workspace_id_idx ON session_turns USING btree (workspace_id, id);

CREATE INDEX session_turns_workspace_queue_idx ON session_turns USING btree (workspace_id, session_id, status, "position");

CREATE INDEX session_variable_set_attachments_set_sessions_idx ON session_variable_set_attachments USING btree (variable_set_id, session_status, workspace_id, session_id);

CREATE UNIQUE INDEX session_work_claim_revisions_claim_revision_uq ON session_work_claim_revisions USING btree (workspace_id, claim_id, resulting_revision);

CREATE INDEX session_work_claim_revisions_session_timeline_idx ON session_work_claim_revisions USING btree (workspace_id, session_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX session_work_claim_revisions_workspace_operation_uq ON session_work_claim_revisions USING btree (workspace_id, operation_id);

CREATE UNIQUE INDEX session_work_claims_active_identity_uq ON session_work_claims USING btree (workspace_id, session_id, subject_namespace, subject_type, subject_digest, role) WHERE (state = 'active'::text);

CREATE INDEX session_work_claims_discovery_text_fts_idx ON session_work_claims USING gin (to_tsvector('simple'::regconfig, ((canonical_key || ' '::text) || COALESCE(display_label, ''::text))));

CREATE INDEX session_work_claims_session_state_idx ON session_work_claims USING btree (workspace_id, session_id, state, updated_at DESC, id DESC);

CREATE INDEX session_work_claims_subject_state_idx ON session_work_claims USING btree (workspace_id, subject_namespace, subject_type, subject_digest, state, updated_at DESC, id DESC);

CREATE UNIQUE INDEX session_work_claims_workspace_id_uq ON session_work_claims USING btree (workspace_id, id);

CREATE INDEX session_workflow_wake_outbox_pending_idx ON session_workflow_wake_outbox USING btree (next_attempt_at, updated_at, session_id) WHERE (wake_revision > delivered_revision);

CREATE UNIQUE INDEX session_workflow_wake_outbox_workspace_session_uq ON session_workflow_wake_outbox USING btree (workspace_id, session_id);

CREATE INDEX sessions_automatic_title_quarantine_v1_idx ON sessions USING btree (id) WHERE ((title_source IS DISTINCT FROM 'user'::text) AND ((title IS DISTINCT FROM 'New conversation'::text) OR (title_source IS DISTINCT FROM 'agent'::text)));

CREATE INDEX sessions_content_archive_state_idx ON sessions USING btree (content_archive_state, content_archive_started_at) WHERE (content_archive_state IS NOT NULL);

CREATE INDEX sessions_discovery_title_fts_idx ON sessions USING gin (to_tsvector('simple'::regconfig, title)) WHERE (title IS NOT NULL);

CREATE UNIQUE INDEX sessions_id_account_idx ON sessions USING btree (id, account_id);

CREATE INDEX sessions_parent_idx ON sessions USING btree (workspace_id, parent_session_id);

CREATE INDEX sessions_rig_idx ON sessions USING btree (workspace_id, rig_id);

CREATE INDEX sessions_sandbox_group_idx ON sessions USING btree (workspace_id, sandbox_group_id);

CREATE INDEX sessions_site_viewer_idx ON sessions USING btree (workspace_id, site_id, site_viewer_principal) WHERE (site_access_root_id IS NOT NULL);

CREATE INDEX sessions_variable_set_idx ON sessions USING btree (workspace_id, variable_set_id);

CREATE INDEX sessions_workspace_activity_pending_idx ON sessions USING btree (workspace_id, activity_revision_pending_xid, id) WHERE (activity_revision_pending_xid IS NOT NULL);

CREATE INDEX sessions_workspace_activity_revision_idx ON sessions USING btree (workspace_id, activity_revision DESC, updated_at DESC, id DESC);

CREATE INDEX sessions_workspace_activity_xid_idx ON sessions USING btree (workspace_id, activity_xid DESC, updated_at DESC, id DESC);

CREATE INDEX sessions_workspace_channel_idx ON sessions USING btree (workspace_id, channel_id) WHERE (channel_id IS NOT NULL);

CREATE UNIQUE INDEX sessions_workspace_create_idempotency_idx ON sessions USING btree (workspace_id, create_idempotency_key) WHERE (create_idempotency_key IS NOT NULL);

CREATE INDEX sessions_workspace_created_id_idx ON sessions USING btree (workspace_id, created_at DESC, id DESC);

CREATE INDEX sessions_workspace_created_idx ON sessions USING btree (workspace_id, created_at);

CREATE INDEX sessions_workspace_creator_updated_id_idx ON sessions USING btree (workspace_id, created_by_kind, created_by_subject_id, updated_at DESC, id DESC);

CREATE INDEX sessions_workspace_end_user_idx ON sessions USING btree (workspace_id, end_user_source, end_user_id) WHERE (end_user_id IS NOT NULL);

CREATE UNIQUE INDEX sessions_workspace_id_idx ON sessions USING btree (workspace_id, id);

CREATE UNIQUE INDEX sessions_workspace_imported_archive_idx ON sessions USING btree (workspace_id, imported_archive_import_id) WHERE (imported_archive_import_id IS NOT NULL);

CREATE INDEX sessions_workspace_root_depth_idx ON sessions USING btree (workspace_id, root_session_id, nested_agent_depth);

CREATE INDEX sessions_workspace_scope_subject_idx ON sessions USING btree (workspace_id, scope_subject_id) WHERE (scope_subject_id IS NOT NULL);

CREATE INDEX sessions_workspace_updated_id_idx ON sessions USING btree (workspace_id, updated_at DESC, id DESC);
