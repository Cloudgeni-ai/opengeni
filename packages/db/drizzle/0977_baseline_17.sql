-- deployment-mode: rolling
-- Opengeni baseline part 17 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE ONLY session_goal_revisions
    ADD CONSTRAINT session_goal_revisions_rollback_of_revision_fk FOREIGN KEY (workspace_id, rollback_of_revision_id) REFERENCES session_goal_revisions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_pending_tool_calls
    ADD CONSTRAINT pending_tool_calls_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY session_realtime_modes
    ADD CONSTRAINT session_realtime_modes_context_projection_fk FOREIGN KEY (context_projection_id) REFERENCES session_realtime_context_projections(id) DEFERRABLE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_forked_from_session_account_fk FOREIGN KEY (forked_from_session_id, account_id) REFERENCES sessions(id, account_id) DEFERRABLE;

ALTER TABLE ONLY session_system_updates
    ADD CONSTRAINT session_system_updates_history_item_fk FOREIGN KEY (delivered_history_item_id) REFERENCES session_history_items(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY session_turn_attempts
    ADD CONSTRAINT session_turn_attempts_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_turns
    ADD CONSTRAINT session_turns_workspace_active_attempt_fk FOREIGN KEY (workspace_id, active_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY session_work_claim_revisions
    ADD CONSTRAINT session_work_claim_revisions_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY slack_shared_task_origins
    ADD CONSTRAINT slack_shared_task_origins_policy_home_fk FOREIGN KEY (policy_account_id, policy_workspace_id, policy_revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY slack_task_policy_activation_events
    ADD CONSTRAINT slack_task_policy_events_new_revision_fk FOREIGN KEY (account_id, workspace_id, new_revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY slack_task_policy_heads
    ADD CONSTRAINT slack_task_policy_heads_revision_fk FOREIGN KEY (account_id, workspace_id, revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY slack_task_policy_revisions
    ADD CONSTRAINT slack_task_policy_revisions_supersedes_fk FOREIGN KEY (account_id, workspace_id, supersedes_revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_note_events
    ADD CONSTRAINT task_note_events_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_note_replacement_receipts
    ADD CONSTRAINT task_note_replacement_receipts_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_notes
    ADD CONSTRAINT task_notes_created_by_attempt_fk FOREIGN KEY (workspace_id, created_by_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY task_notes
    ADD CONSTRAINT task_notes_created_by_turn_fk FOREIGN KEY (workspace_id, created_by_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY transcription_recording_chunks
    ADD CONSTRAINT transcription_recording_chunks_object_fk FOREIGN KEY (object_key) REFERENCES transcription_recording_objects(object_key) DEFERRABLE;

ALTER TABLE ONLY transcription_recording_segments
    ADD CONSTRAINT transcription_recording_segments_object_fk FOREIGN KEY (object_key) REFERENCES transcription_recording_objects(object_key) DEFERRABLE;

ALTER TABLE ONLY turn_connection_authority_snapshots
    ADD CONSTRAINT turn_connection_authority_connection_fk FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE;

ALTER TABLE ONLY turn_connection_authority_snapshots
    ADD CONSTRAINT turn_connection_authority_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE;

ALTER TABLE ONLY vaults
    ADD CONSTRAINT vaults_provider_connection_id_fkey FOREIGN KEY (provider_connection_id) REFERENCES connections(id) DEFERRABLE;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_source_attempt_fk FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_source_session_fk FOREIGN KEY (workspace_id, source_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_artifact_events
    ADD CONSTRAINT workspace_artifact_events_source_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_source_attempt_fk FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_source_session_fk FOREIGN KEY (workspace_id, source_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_artifact_versions
    ADD CONSTRAINT workspace_artifact_versions_source_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_activation_events
    ADD CONSTRAINT workspace_instruction_policy_activation_ev_new_revision_id_fkey FOREIGN KEY (new_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_activation_events
    ADD CONSTRAINT workspace_instruction_policy_activation_ev_old_revision_id_fkey FOREIGN KEY (old_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_deactivation_events
    ADD CONSTRAINT workspace_instruction_policy_deactivation__old_revision_id_fkey FOREIGN KEY (old_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_heads
    ADD CONSTRAINT workspace_instruction_policy_heads_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals
    ADD CONSTRAINT workspace_instruction_policy_onboardi_baseline_revision_id_fkey FOREIGN KEY (baseline_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals
    ADD CONSTRAINT workspace_instruction_policy_onboarding__draft_revision_id_fkey FOREIGN KEY (draft_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_instruction_policy_revisions
    ADD CONSTRAINT workspace_instruction_policy_revisi_supersedes_revision_id_fkey FOREIGN KEY (supersedes_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY workspace_learning_policy_heads
    ADD CONSTRAINT workspace_learning_policy_heads_revision_fk FOREIGN KEY (account_id, workspace_id, revision_id) REFERENCES workspace_learning_policy_revisions(account_id, workspace_id, id) DEFERRABLE;

ALTER TABLE ONLY workspace_learning_policy_revisions
    ADD CONSTRAINT workspace_learning_policy_revisions_supersedes_revision_id_fkey FOREIGN KEY (supersedes_revision_id) REFERENCES workspace_learning_policy_revisions(id) DEFERRABLE;

ALTER TABLE ONLY event_sources
    ADD CONSTRAINT event_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_sources
    ADD CONSTRAINT event_sources_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_sources
    ADD CONSTRAINT event_sources_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY event_ingress_routes
    ADD CONSTRAINT event_ingress_routes_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_ingress_routes
    ADD CONSTRAINT event_ingress_routes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_ingress_routes
    ADD CONSTRAINT event_ingress_routes_source_id_fkey FOREIGN KEY (source_id) REFERENCES event_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_ingress_routes
    ADD CONSTRAINT event_ingress_routes_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY event_deliveries
    ADD CONSTRAINT event_deliveries_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_deliveries
    ADD CONSTRAINT event_deliveries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_deliveries
    ADD CONSTRAINT event_deliveries_source_id_fkey FOREIGN KEY (source_id) REFERENCES event_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_deliveries
    ADD CONSTRAINT event_deliveries_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY inbound_events
    ADD CONSTRAINT inbound_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY inbound_events
    ADD CONSTRAINT inbound_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY inbound_events
    ADD CONSTRAINT inbound_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES event_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY inbound_events
    ADD CONSTRAINT inbound_events_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES event_deliveries(id) ON DELETE SET NULL;

ALTER TABLE ONLY inbound_events
    ADD CONSTRAINT inbound_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_source_id_fkey FOREIGN KEY (source_id) REFERENCES event_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_triggers
    ADD CONSTRAINT event_triggers_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_settings
    ADD CONSTRAINT scheduled_task_event_settings_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_settings
    ADD CONSTRAINT scheduled_task_event_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_settings
    ADD CONSTRAINT scheduled_task_event_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_settings
    ADD CONSTRAINT scheduled_task_event_settings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_occurrences
    ADD CONSTRAINT scheduled_task_event_occurrences_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_occurrences
    ADD CONSTRAINT scheduled_task_event_occurrences_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_occurrences
    ADD CONSTRAINT scheduled_task_event_occurrences_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_occurrences
    ADD CONSTRAINT scheduled_task_event_occurrences_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_task_id_fkey FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_event_id_fkey FOREIGN KEY (event_id) REFERENCES inbound_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_occurrence_id_fkey FOREIGN KEY (occurrence_id) REFERENCES scheduled_task_event_occurrences(id) ON DELETE SET NULL;

ALTER TABLE ONLY scheduled_task_event_inbox
    ADD CONSTRAINT scheduled_task_event_inbox_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY recordings
    ADD CONSTRAINT recordings_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_tracks
    ADD CONSTRAINT recording_tracks_recording_fk FOREIGN KEY (workspace_id, recording_id) REFERENCES recordings(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_chunks
    ADD CONSTRAINT recording_chunks_track_fk FOREIGN KEY (workspace_id, recording_id, track_number) REFERENCES recording_tracks(workspace_id, recording_id, track_number) ON DELETE CASCADE;

ALTER TABLE ONLY recording_transcript_versions
    ADD CONSTRAINT recording_transcript_versions_recording_fk FOREIGN KEY (workspace_id, recording_id) REFERENCES recordings(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_transcript_segments
    ADD CONSTRAINT recording_transcript_segments_version_fk FOREIGN KEY (workspace_id, recording_id, version_id) REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_people
    ADD CONSTRAINT recording_people_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_speaker_assignments
    ADD CONSTRAINT recording_speaker_assignments_version_fk FOREIGN KEY (workspace_id, recording_id, version_id) REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_speaker_assignments
    ADD CONSTRAINT recording_speaker_assignments_person_fk FOREIGN KEY (workspace_id, person_id) REFERENCES recording_people(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_segment_edits
    ADD CONSTRAINT recording_segment_edits_version_fk FOREIGN KEY (workspace_id, recording_id, version_id) REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_events
    ADD CONSTRAINT recording_events_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_source_id_fkey FOREIGN KEY (source_id) REFERENCES event_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_event_subscriptions
    ADD CONSTRAINT mcp_event_subscriptions_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_installations
    ADD CONSTRAINT teams_bot_installations_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_links
    ADD CONSTRAINT teams_bot_links_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES teams_bot_installations(tenant_id, workspace_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_proofs
    ADD CONSTRAINT teams_bot_proofs_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_routes
    ADD CONSTRAINT teams_bot_routes_tenant_id_workspace_id_fkey FOREIGN KEY (tenant_id, workspace_id) REFERENCES teams_bot_installations(tenant_id, workspace_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_inbox
    ADD CONSTRAINT teams_bot_inbox_route_id_workspace_id_account_id_fkey FOREIGN KEY (route_id, workspace_id, account_id) REFERENCES teams_bot_routes(route_id, workspace_id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_outbox
    ADD CONSTRAINT teams_bot_outbox_route_id_workspace_id_account_id_fkey FOREIGN KEY (route_id, workspace_id, account_id) REFERENCES teams_bot_routes(route_id, workspace_id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_links
    ADD CONSTRAINT teams_bot_links_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_routes
    ADD CONSTRAINT teams_bot_routes_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_inbox
    ADD CONSTRAINT teams_bot_inbox_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY teams_bot_outbox
    ADD CONSTRAINT teams_bot_outbox_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY event_source_feeds
    ADD CONSTRAINT event_source_feeds_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_source_feeds
    ADD CONSTRAINT event_source_feeds_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_source_feeds
    ADD CONSTRAINT event_source_feeds_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES event_sources(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY event_source_feeds
    ADD CONSTRAINT event_source_feeds_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_voiceprints
    ADD CONSTRAINT recording_voiceprints_person_fk FOREIGN KEY (workspace_id, person_id) REFERENCES recording_people(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_voiceprints
    ADD CONSTRAINT recording_voiceprints_workspace_account_fk FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_speaker_voices
    ADD CONSTRAINT recording_speaker_voices_version_fk FOREIGN KEY (workspace_id, recording_id, version_id) REFERENCES recording_transcript_versions(workspace_id, recording_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_voice_rejections
    ADD CONSTRAINT recording_voice_rejections_recording_fk FOREIGN KEY (workspace_id, recording_id) REFERENCES recordings(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_voice_rejections
    ADD CONSTRAINT recording_voice_rejections_person_fk FOREIGN KEY (workspace_id, person_id) REFERENCES recording_people(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_live_segments
    ADD CONSTRAINT recording_live_segments_track_fk FOREIGN KEY (workspace_id, recording_id, track_number) REFERENCES recording_tracks(workspace_id, recording_id, track_number) ON DELETE CASCADE;

ALTER TABLE ONLY site_sidebar_states
    ADD CONSTRAINT site_sidebar_states_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY site_sidebar_states
    ADD CONSTRAINT site_sidebar_states_workspace_id_site_id_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY secret_approval_rules
    ADD CONSTRAINT secret_approval_rules_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY secret_use_approvals
    ADD CONSTRAINT secret_use_approvals_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY secret_use_approvals
    ADD CONSTRAINT secret_use_approvals_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY recording_notes
    ADD CONSTRAINT recording_notes_recording_fk FOREIGN KEY (workspace_id, recording_id) REFERENCES recordings(workspace_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY automation_templates
    ADD CONSTRAINT automation_templates_workspace_id_account_id_fkey FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_app_action_grants
    ADD CONSTRAINT session_turn_app_action_grants_turn_id_fkey FOREIGN KEY (turn_id) REFERENCES session_turns(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_app_action_grants
    ADD CONSTRAINT session_turn_app_action_grants_account_id_fkey FOREIGN KEY (account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_turn_app_action_grants
    ADD CONSTRAINT session_turn_app_action_grants_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE opengeni_private.artifact_catalog_pins ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.automatic_session_title_fanout_outbox_v1 ENABLE ROW LEVEL SECURITY;

CREATE POLICY automatic_title_fanout_owner_v1 ON opengeni_private.automatic_session_title_fanout_outbox_v1 USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.automatic_session_title_fanout_outbox_v1'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.automatic_session_title_fanout_outbox_v1'::regclass)::oid))));

ALTER TABLE opengeni_private.credit_grant_observations ENABLE ROW LEVEL SECURITY;

CREATE POLICY importer_isolation ON opengeni_private.session_import_batches AS RESTRICTIVE USING ((subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))) WITH CHECK ((subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)));

ALTER TABLE opengeni_private.inbox_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_items_owner ON opengeni_private.inbox_items USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_items'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_items'::regclass)::oid))));

ALTER TABLE opengeni_private.inbox_member_notify_optins ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_member_notify_optins_owner ON opengeni_private.inbox_member_notify_optins USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_member_notify_optins'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_member_notify_optins'::regclass)::oid))));

ALTER TABLE opengeni_private.inbox_session_mutes ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_session_mutes_owner ON opengeni_private.inbox_session_mutes USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_session_mutes'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_session_mutes'::regclass)::oid))));

ALTER TABLE opengeni_private.inbox_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbox_settings_owner ON opengeni_private.inbox_settings USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_settings'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.inbox_settings'::regclass)::oid))));

ALTER TABLE opengeni_private.lifecycle_backfill_read_capabilities ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.modal_native_origin_read_capabilities ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.native_push_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY native_push_deliveries_owner ON opengeni_private.native_push_deliveries USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.native_push_deliveries'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.native_push_deliveries'::regclass)::oid))));

ALTER TABLE opengeni_private.native_push_devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY native_push_devices_owner ON opengeni_private.native_push_devices USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.native_push_devices'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('opengeni_private.native_push_devices'::regclass)::oid))));

CREATE POLICY organization_isolation ON opengeni_private.organization_signup_use_cases USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

CREATE POLICY organization_isolation ON opengeni_private.organization_slack_bot_access USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE opengeni_private.organization_signup_use_cases ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.organization_slack_bot_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_only ON opengeni_private.modal_native_origin_read_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE opengeni_private.product_lifecycle_backfill_progress ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.product_lifecycle_backfill_queue ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.sandbox_file_publications ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.scheduled_slack_bot_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY scoped_owner_read ON opengeni_private.session_usage_limit_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND ((to_regclass('workspaces'::text))::oid = ('workspaces'::regclass)::oid) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)));

CREATE POLICY scoped_owner_read ON opengeni_private.session_usage_limit_roots FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND ((to_regclass('workspaces'::text))::oid = ('workspaces'::regclass)::oid) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)));

CREATE POLICY scoped_owner_read ON opengeni_private.workspace_usage_allowances FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND ((to_regclass('workspaces'::text))::oid = ('workspaces'::regclass)::oid) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)));

ALTER TABLE opengeni_private.session_file_attachments ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.session_import_batches ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.session_usage_limit_config_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_usage_limit_import_inventory ON opengeni_private.session_usage_limit_roots FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(NULL::uuid, NULL::uuid)));

CREATE POLICY session_usage_limit_owner ON opengeni_private.session_usage_limit_config_receipts USING (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(account_id, workspace_id)));

CREATE POLICY session_usage_limit_owner ON opengeni_private.session_usage_limit_receipts USING (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(account_id, workspace_id)));

CREATE POLICY session_usage_limit_owner ON opengeni_private.session_usage_limit_roots USING (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND session_usage_limit_capability_active(account_id, workspace_id)));

CREATE POLICY session_usage_limit_pending_inventory ON opengeni_private.session_usage_limit_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (status = 'pending'::text) AND session_usage_limit_capability_active(NULL::uuid, NULL::uuid)));

ALTER TABLE opengeni_private.session_usage_limit_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.session_usage_limit_roots ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_visibility_isolation ON opengeni_private.session_import_batches AS RESTRICTIVE USING (session_reference_visible(account_id, workspace_id, session_id)) WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

ALTER TABLE opengeni_private.slack_file_upload_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.subscription_authority_compat ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_authority_compat_carrier_insert ON opengeni_private.subscription_authority_compat FOR INSERT WITH CHECK (
CASE carrier_kind
    WHEN 'session_initial'::text THEN (EXISTS ( SELECT 1
       FROM sessions carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.session_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'session_turn'::text THEN (EXISTS ( SELECT 1
       FROM session_turns carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.turn_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'scheduled_task'::text THEN (EXISTS ( SELECT 1
       FROM scheduled_tasks carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.scheduled_task_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'scheduled_task_revision'::text THEN (EXISTS ( SELECT 1
       FROM scheduled_task_revision_authorities carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.task_id = subscription_authority_compat.scheduled_task_id) AND (carrier.task_authority_revision = subscription_authority_compat.task_authority_revision) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'session_system_update'::text THEN (EXISTS ( SELECT 1
       FROM session_system_updates carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.system_update_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'session_system_update_outbox'::text THEN (EXISTS ( SELECT 1
       FROM session_system_update_outbox carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.outbox_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    ELSE false
END);

CREATE POLICY subscription_authority_compat_carrier_read ON opengeni_private.subscription_authority_compat FOR SELECT USING (
CASE carrier_kind
    WHEN 'session_initial'::text THEN (EXISTS ( SELECT 1
       FROM sessions carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.session_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'session_turn'::text THEN (EXISTS ( SELECT 1
       FROM session_turns carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.turn_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'scheduled_task'::text THEN (EXISTS ( SELECT 1
       FROM scheduled_tasks carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.scheduled_task_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'scheduled_task_revision'::text THEN (EXISTS ( SELECT 1
       FROM scheduled_task_revision_authorities carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.task_id = subscription_authority_compat.scheduled_task_id) AND (carrier.task_authority_revision = subscription_authority_compat.task_authority_revision) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'session_system_update'::text THEN (EXISTS ( SELECT 1
       FROM session_system_updates carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.system_update_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    WHEN 'session_system_update_outbox'::text THEN (EXISTS ( SELECT 1
       FROM session_system_update_outbox carrier
      WHERE ((carrier.workspace_id = subscription_authority_compat.workspace_id) AND (carrier.id = subscription_authority_compat.outbox_id) AND (carrier.account_id = subscription_authority_compat.account_id))))
    ELSE false
END);

CREATE POLICY usage_allowance_attribution_lifecycle ON opengeni_private.usage_allowance_attribution_receipts FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_attribution_owner ON opengeni_private.usage_allowance_attribution_receipts FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

ALTER TABLE opengeni_private.usage_allowance_attribution_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_allowance_maintenance_inventory ON opengeni_private.workspace_usage_allowances FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(NULL::uuid, NULL::uuid)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_allowance_clear_receipts USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_allowance_counters USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_allowance_grants USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_allowance_notifications USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_allowance_periods USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_member_allowances USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_usage_allowances USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_allowance_owner ON opengeni_private.workspace_video_allowance_allocations USING (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND usage_allowance_capability_active(account_id, workspace_id)));

CREATE POLICY usage_analytics_owner ON opengeni_private.credit_grant_observations USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY usage_analytics_owner ON opengeni_private.lifecycle_backfill_read_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY usage_analytics_owner ON opengeni_private.product_lifecycle_backfill_progress USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY usage_analytics_owner ON opengeni_private.product_lifecycle_backfill_queue USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY usage_analytics_owner ON opengeni_private.user_activity_presence USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE opengeni_private.user_activity_presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY visible_file ON opengeni_private.sandbox_file_publications AS RESTRICTIVE USING ((EXISTS ( SELECT 1
   FROM files f
  WHERE ((f.account_id = sandbox_file_publications.account_id) AND (f.workspace_id = sandbox_file_publications.workspace_id) AND (f.id = sandbox_file_publications.file_id) AND (f.status = 'ready'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM files f
  WHERE ((f.account_id = sandbox_file_publications.account_id) AND (f.workspace_id = sandbox_file_publications.workspace_id) AND (f.id = sandbox_file_publications.file_id) AND (f.status = 'ready'::text)))));

ALTER TABLE opengeni_private.workspace_allowance_clear_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.workspace_allowance_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.workspace_allowance_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.workspace_allowance_notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.workspace_allowance_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON opengeni_private.artifact_catalog_pins USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON opengeni_private.sandbox_file_publications USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON opengeni_private.scheduled_slack_bot_messages USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON opengeni_private.session_file_attachments USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON opengeni_private.session_import_batches USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON opengeni_private.slack_file_upload_operations USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM sessions s
  WHERE ((s.account_id = slack_file_upload_operations.account_id) AND (s.workspace_id = slack_file_upload_operations.workspace_id) AND (s.id = slack_file_upload_operations.session_id)))) AND (EXISTS ( SELECT 1
   FROM slack_interactions i
  WHERE ((i.account_id = slack_file_upload_operations.account_id) AND (i.workspace_id = slack_file_upload_operations.workspace_id) AND (i.id = slack_file_upload_operations.interaction_id) AND (i.session_id = slack_file_upload_operations.session_id) AND (i.connection_id = slack_file_upload_operations.connection_id) AND ((i.visibility <> 'private'::text) OR (NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL) OR (i.owning_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) OR (i.owning_subject_id = NULLIF(current_setting('opengeni.initiating_human_subject_id'::text, true), ''::text)))))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM sessions s
  WHERE ((s.account_id = slack_file_upload_operations.account_id) AND (s.workspace_id = slack_file_upload_operations.workspace_id) AND (s.id = slack_file_upload_operations.session_id)))) AND (EXISTS ( SELECT 1
   FROM slack_interactions i
  WHERE ((i.account_id = slack_file_upload_operations.account_id) AND (i.workspace_id = slack_file_upload_operations.workspace_id) AND (i.id = slack_file_upload_operations.interaction_id) AND (i.session_id = slack_file_upload_operations.session_id) AND (i.connection_id = slack_file_upload_operations.connection_id) AND ((i.visibility <> 'private'::text) OR (NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL) OR (i.owning_subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) OR (i.owning_subject_id = NULLIF(current_setting('opengeni.initiating_human_subject_id'::text, true), ''::text))))))));

ALTER TABLE opengeni_private.workspace_member_allowances ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.workspace_usage_allowances ENABLE ROW LEVEL SECURITY;

ALTER TABLE opengeni_private.workspace_video_allowance_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_isolation ON company_profile_activation_events USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE POLICY account_isolation ON company_profile_heads USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE POLICY account_isolation ON company_profile_revisions USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE POLICY account_isolation ON secret_approval_rules USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE POLICY additional_organization_creation_lifecycle ON additional_organization_creation_receipts USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'additional_organization_creation'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'additional_organization_creation'::text));

ALTER TABLE additional_organization_creation_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE agent_instruction_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE agent_learning_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE agent_learning_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE agent_run_states ENABLE ROW LEVEL SECURITY;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_account_workspace_or_hash_isolation ON api_keys USING ((opengeni_private.optional_workspace_rls_visible(account_id, workspace_id) OR (key_hash = opengeni_private.current_api_key_hash()))) WITH CHECK ((opengeni_private.optional_workspace_rls_visible(account_id, workspace_id) OR (key_hash = opengeni_private.current_api_key_hash())));

ALTER TABLE attached_browser_devices ENABLE ROW LEVEL SECURITY;

ALTER TABLE attached_browser_inventories ENABLE ROW LEVEL SECURITY;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_events_account_workspace_isolation ON audit_events USING (((account_id IS NULL) OR opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))) WITH CHECK (((account_id IS NULL) OR opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)));

ALTER TABLE auth_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE automation_run_event_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_run_event_links_tenant ON automation_run_event_links USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_runs_tenant ON automation_runs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE automation_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_sources_tenant ON automation_sources USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE automation_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE automation_trigger_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_trigger_events_tenant ON automation_trigger_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE automation_trigger_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_trigger_revisions_tenant ON automation_trigger_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE automation_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY automation_triggers_tenant ON automation_triggers USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY billing_customers_account_isolation ON billing_customers USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

ALTER TABLE billing_subscription_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY billing_subscription_operations_account_isolation ON billing_subscription_operations USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE POLICY blocker_review_inventory_read ON scheduled_task_blocker_reviews FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

ALTER TABLE browser_identities ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_revision_components ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_session_associations ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_session_retained_downloads ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_state_artifacts ENABLE ROW LEVEL SECURITY;

ALTER TABLE browser_state_uploads ENABLE ROW LEVEL SECURITY;

ALTER TABLE canonical_human_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY canonical_human_identity_lifecycle ON canonical_human_identities USING ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text));

CREATE POLICY canonical_human_identity_lifecycle ON canonical_human_identity_operations USING ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text));

CREATE POLICY canonical_human_identity_lifecycle ON canonical_human_identity_subjects USING ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text));

CREATE POLICY canonical_human_identity_lifecycle ON canonical_human_login_bindings USING ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text)) WITH CHECK ((current_setting('opengeni.canonical_human_identity_lifecycle'::text, true) = 'active'::text));

ALTER TABLE canonical_human_identity_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE canonical_human_identity_subjects ENABLE ROW LEVEL SECURITY;

ALTER TABLE canonical_human_login_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_api_facets ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_catalog_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_component_owners ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_facet_installations ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_facets ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_installations ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_integration_facets ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_mcp_facets ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_plugin_installations ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_plugin_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_plugins ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_skill_facets ENABLE ROW LEVEL SECURITY;

ALTER TABLE capability_skill_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY capture_insert ON codex_turn_source_bindings FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.workspace_rls_visible(account_id, workspace_id)));

ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

ALTER TABLE claude_capacity_waiters ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_capacity_waiters_closed_insert ON claude_capacity_waiters AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_capacity_waiters_closed_update ON claude_capacity_waiters AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

ALTER TABLE claude_credential_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_credential_leases_closed_insert ON claude_credential_leases AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_credential_leases_closed_update ON claude_credential_leases AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

ALTER TABLE claude_rotation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_rotation_settings_closed_insert ON claude_rotation_settings AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_rotation_settings_closed_update ON claude_rotation_settings AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

ALTER TABLE claude_session_account_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_session_account_pins_closed_insert ON claude_session_account_pins AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_session_account_pins_closed_update ON claude_session_account_pins AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

ALTER TABLE claude_subscription_account_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_subscription_account_usage_closed_insert ON claude_subscription_account_usage AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_subscription_account_usage_closed_update ON claude_subscription_account_usage AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_subscription_authority_closed ON organization_user_resource_authorities AS RESTRICTIVE FOR INSERT WITH CHECK (((resource_kind <> 'claude_subscription'::text) OR (NOT opengeni_private.subscription_provider_cutover_committed('claude'::text))));

ALTER TABLE claude_subscription_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY claude_subscription_credentials_closed_insert ON claude_subscription_credentials AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

CREATE POLICY claude_subscription_credentials_closed_update ON claude_subscription_credentials AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('claude'::text)));

ALTER TABLE codex_apps_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE codex_capacity_waiters ENABLE ROW LEVEL SECURITY;

ALTER TABLE codex_credential_leases ENABLE ROW LEVEL SECURITY;

ALTER TABLE codex_reset_redemption_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE codex_rotation_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE codex_subscription_credentials ENABLE ROW LEVEL SECURITY;

ALTER TABLE codex_turn_source_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_brain_context_selection_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_brain_context_selection_tenant ON company_brain_context_selection_receipts USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE company_brain_preference_proposal_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_brain_turn_context_snapshot_tenant ON company_brain_turn_context_snapshots USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE company_brain_turn_context_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_profile_activation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_profile_agent_admin_lifecycle ON company_profile_agent_automatic_activation_receipts USING ((current_setting('opengeni.company_profile_agent_admin_lifecycle'::text, true) = 'company_profile_agent_admin'::text)) WITH CHECK ((current_setting('opengeni.company_profile_agent_admin_lifecycle'::text, true) = 'company_profile_agent_admin'::text));

CREATE POLICY company_profile_agent_admin_lifecycle ON company_profile_agent_confirmation_receipts USING ((current_setting('opengeni.company_profile_agent_admin_lifecycle'::text, true) = 'company_profile_agent_admin'::text)) WITH CHECK ((current_setting('opengeni.company_profile_agent_admin_lifecycle'::text, true) = 'company_profile_agent_admin'::text));

CREATE POLICY company_profile_agent_admin_lifecycle ON company_profile_agent_proposal_receipts USING ((current_setting('opengeni.company_profile_agent_admin_lifecycle'::text, true) = 'company_profile_agent_admin'::text)) WITH CHECK ((current_setting('opengeni.company_profile_agent_admin_lifecycle'::text, true) = 'company_profile_agent_admin'::text));

ALTER TABLE company_profile_agent_automatic_activation_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_profile_agent_confirmation_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_profile_agent_proposal_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_profile_heads ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_profile_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE company_profile_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE composer_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY compute_enrollment_inventory_owner_read ON enrollments FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND modal_inventory_read_capability_active()));

ALTER TABLE computer_session_associations ENABLE ROW LEVEL SECURITY;

ALTER TABLE computer_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE connect_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY connect_attempts_actor_scope ON connect_attempts USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()) AND (subject_id = opengeni_private.current_subject_id())));

CREATE POLICY connected_command_fenced_write ON session_background_commands USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY connected_command_inventory_read ON session_background_commands FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY connection_authority_binding_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (((resource_kind = 'connection'::text) AND (CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'connection_authority_binding'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

CREATE POLICY connection_authority_binding_lock ON organization_memberships FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'connection_authority_binding'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

CREATE POLICY connection_authority_binding_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'connection_authority_binding'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

CREATE POLICY connection_authority_convergence_audit_read ON connections FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND connection_authority_convergence_audit_capability_active(account_id)));

CREATE POLICY connection_authority_convergence_audit_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND connection_authority_convergence_audit_capability_active(account_id)));

CREATE POLICY connection_authority_convergence_audit_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND connection_authority_convergence_audit_capability_active(account_id)));

ALTER TABLE connection_disconnect_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY connection_tenancy_backfill_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (((resource_kind = 'connection'::text) AND (CURRENT_USER = '{{owner}}'::name) AND opengeni_private.connection_tenancy_backfill_capability_active(account_id)));

CREATE POLICY connection_tenancy_backfill_read ON connections FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.connection_tenancy_backfill_capability_active(account_id)));

CREATE POLICY connection_tenancy_backfill_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.connection_tenancy_backfill_capability_active(account_id)));

CREATE POLICY connection_tenancy_backfill_read ON organization_user_resource_authorities FOR SELECT USING (((resource_kind = 'connection'::text) AND (CURRENT_USER = '{{owner}}'::name) AND opengeni_private.connection_tenancy_backfill_capability_active(account_id)));

CREATE POLICY connection_tenancy_backfill_update ON connections FOR UPDATE USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.connection_tenancy_backfill_capability_active(account_id))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.connection_tenancy_backfill_capability_active(account_id)));

CREATE POLICY connection_tenancy_legacy_retirement ON connections AS RESTRICTIVE FOR SELECT USING (((authority_scope <> 'legacy_user'::text) OR (NOT opengeni_private.session_tenancy_account_activated(account_id)) OR opengeni_private.connection_tenancy_backfill_capability_active(account_id) OR opengeni_private.organization_tenancy_inventory_capability_active() OR opengeni_private.organization_tenancy_parity_capability_active() OR ( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active)));

ALTER TABLE connection_use_audit_facts ENABLE ROW LEVEL SECURITY;

ALTER TABLE connection_use_once_consumption_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE connector_action_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY connector_action_policies_workspace_isolation ON connector_action_policies USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE connector_action_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY connector_action_requests_workspace_isolation ON connector_action_requests USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE credit_debit_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY credit_debit_allocations_account_isolation ON credit_debit_allocations USING (opengeni_private.account_rls_visible(account_id)) WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE POLICY credit_ledger_account_workspace_isolation ON credit_ledger_entries USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));

ALTER TABLE credit_ledger_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE device_enrollment_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_authority_isolation ON document_chunks USING (opengeni_private.scoped_knowledge_scope_visible(account_id, authority_kind, authority_workspace_id, authority_subject_id)) WITH CHECK (opengeni_private.scoped_knowledge_scope_visible(account_id, authority_kind, authority_workspace_id, authority_subject_id));

CREATE POLICY document_authority_isolation ON documents USING (opengeni_private.scoped_knowledge_scope_visible(account_id, authority_kind, authority_workspace_id, authority_subject_id)) WITH CHECK (opengeni_private.scoped_knowledge_scope_visible(account_id, authority_kind, authority_workspace_id, authority_subject_id));

ALTER TABLE document_authority_reclassifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE document_bases ENABLE ROW LEVEL SECURITY;

ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_default_backfill_lifecycle ON document_bases USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('default_backfill'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('default_backfill'::text)));

CREATE POLICY document_default_backfill_lifecycle ON workspaces USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('default_backfill'::text))) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.document_migration_capability_active('default_backfill'::text)));

ALTER TABLE document_default_collection_backfill_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE document_default_collection_backfill_receipts ENABLE ROW LEVEL SECURITY;
