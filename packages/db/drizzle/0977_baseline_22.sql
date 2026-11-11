-- deployment-mode: rolling
-- Opengeni baseline part 22 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE POLICY workspace_isolation ON slack_user_link_access_requests USING (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON social_connections USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((subject_id IS NULL) OR (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND ((subject_id IS NULL) OR (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))));

CREATE POLICY workspace_isolation ON social_posts USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM social_connections connection
  WHERE ((connection.id = social_posts.connection_id) AND (connection.workspace_id = social_posts.workspace_id)))))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (EXISTS ( SELECT 1
   FROM social_connections connection
  WHERE ((connection.id = social_posts.connection_id) AND (connection.workspace_id = social_posts.workspace_id))))));

CREATE POLICY workspace_isolation ON teams_bot_inbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON teams_bot_installations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON teams_bot_links USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON teams_bot_outbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON teams_bot_proofs USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON teams_bot_routes USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON temporal_schedule_cleanup_outbox USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON video_generation_operations USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON video_generation_references USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_artifact_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_artifact_uploads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_artifact_versions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_artifacts USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_captures USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_codex_subscription_preferences USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_control_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_gateway_custom_models USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_inference_controls USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_instruction_policy_activation_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_instruction_policy_deactivation_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_instruction_policy_heads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_instruction_policy_onboarding_proposals USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_instruction_policy_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_instruction_policy_snapshots USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_interaction_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_learning_policy_activation_events USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_learning_policy_heads USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_learning_policy_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_learning_policy_snapshots USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_model_policies USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_screenshot_quotas USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_session_activity_revisions USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_variable_set_variables USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_variable_sets USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_video_generation_policies USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_isolation ON workspace_video_generation_quotas USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE workspace_learning_policy_activation_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_learning_policy_heads ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_learning_policy_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_learning_policy_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_model_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_or_global_visibility ON capability_plugins USING (((workspace_id IS NULL) OR opengeni_private.workspace_rls_visible(account_id, workspace_id))) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

CREATE POLICY workspace_pause_timer_discovery ON workspace_inference_controls FOR SELECT TO {{owner}} USING ((current_setting('opengeni.pause_timer_discovery'::text, true) = '1'::text));

ALTER TABLE workspace_screenshot_quotas ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_session_activity_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_subject_isolation ON connection_disconnect_operations USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text))));

CREATE POLICY workspace_subject_isolation ON tool_gateway_approval_capabilities USING ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id()))) WITH CHECK ((opengeni_private.workspace_rls_visible(account_id, workspace_id) AND (subject_id = opengeni_private.current_subject_id())));

ALTER TABLE workspace_variable_set_variables ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_variable_sets ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_video_generation_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_video_generation_quotas ENABLE ROW LEVEL SECURITY;

ALTER TABLE workspace_webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_webhook_deliveries_dispatcher_owner ON workspace_webhook_deliveries USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('workspace_webhook_deliveries'::regclass)::oid)))) WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('workspace_webhook_deliveries'::regclass)::oid))));

CREATE POLICY workspace_webhook_deliveries_workspace_scope ON workspace_webhook_deliveries USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE workspace_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_webhooks_dispatcher_owner ON workspace_webhooks FOR SELECT USING ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('workspace_webhooks'::regclass)::oid))));

CREATE POLICY workspace_webhooks_workspace_scope ON workspace_webhooks USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE xai_capacity_waiters ENABLE ROW LEVEL SECURITY;

CREATE POLICY xai_capacity_waiters_closed_insert ON xai_capacity_waiters AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

CREATE POLICY xai_capacity_waiters_closed_update ON xai_capacity_waiters AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

ALTER TABLE xai_credential_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY xai_credential_leases_closed_insert ON xai_credential_leases AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

CREATE POLICY xai_credential_leases_closed_update ON xai_credential_leases AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

ALTER TABLE xai_rotation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY xai_rotation_settings_closed_insert ON xai_rotation_settings AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

CREATE POLICY xai_rotation_settings_closed_update ON xai_rotation_settings AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

ALTER TABLE xai_session_account_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY xai_session_account_pins_closed_insert ON xai_session_account_pins AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

CREATE POLICY xai_session_account_pins_closed_update ON xai_session_account_pins AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

CREATE POLICY xai_subscription_authority_closed ON organization_user_resource_authorities AS RESTRICTIVE FOR INSERT WITH CHECK (((resource_kind <> 'xai_subscription'::text) OR (NOT opengeni_private.subscription_provider_cutover_committed('xai'::text))));

ALTER TABLE xai_subscription_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY xai_subscription_credentials_closed_insert ON xai_subscription_credentials AS RESTRICTIVE FOR INSERT WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

CREATE POLICY xai_subscription_credentials_closed_update ON xai_subscription_credentials AS RESTRICTIVE FOR UPDATE USING (true) WITH CHECK ((NOT opengeni_private.subscription_provider_cutover_committed('xai'::text)));

REVOKE ALL ON FUNCTION opengeni_host_export.ack_host_export_batch(p_export_kind text, p_consumer_id text, p_lease_token uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.allocate_host_export_cursors(p_export_kind text, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.claim_host_export_batch(p_export_kind text, p_consumer_id text, p_lease_token uuid, p_lease_holder_id text, p_lease_seconds integer, p_limit integer, p_max_bytes integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.dead_letter_host_export_head(p_export_kind text, p_consumer_id text, p_lease_token uuid, p_export_cursor bigint, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.disable_host_export_consumer(p_export_kind text, p_consumer_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.fail_host_export_batch(p_export_kind text, p_consumer_id text, p_lease_token uuid, p_error text, p_max_failures integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.fail_host_export_batch(p_export_kind text, p_consumer_id text, p_lease_token uuid, p_error text, p_max_failures integer, p_error_codec_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.host_export_claim_analytics_sidecars(p_export_kind text, p_consumer_id text, p_lease_token uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.host_export_claim_sidecars(p_export_kind text, p_consumer_id text, p_lease_token uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.host_export_consumer_status(p_export_kind text, p_consumer_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.host_export_consumer_status_sidecar(p_export_kind text, p_consumer_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.host_export_cursor_roots(p_export_kind text, p_consumer_id text, p_lease_token uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.prune_host_export_outbox(p_export_kind text, p_grace_seconds integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.register_host_export_consumer(p_export_kind text, p_consumer_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.resume_host_export_consumer(p_export_kind text, p_consumer_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.retire_host_export_consumer(p_export_kind text, p_consumer_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_host_export.rewind_host_export_consumer(p_export_kind text, p_consumer_id text, p_checkpoint bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_amount_inputs(a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone, p_granularity text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hour_lock(w uuid, h timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_delta(v opengeni_private.insights_usage_hourly_rollups, d bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_maintain() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_raw(a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_recompute(a uuid, w uuid, h timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_scan(a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.model_context_contributions_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_insights_internal.insights_usage_hourly_value(f model_call_facts) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.abandon_session_content_archive(p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.accept_session_file_attachments(p_account uuid, p_workspace uuid, p_session uuid, p_turn uuid, p_subject text, p_files uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.account_rls_visible(account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.active_external_owning_subject(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.advance_editable_artifact_authorization_revision(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_expected_revision bigint, p_next_revision bigint, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.advance_editable_artifact_scope_authorization_revision(p_account_id uuid, p_workspace_id uuid, p_expected_revision bigint, p_next_revision bigint, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.advance_session_execution_context() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.analytics_model_provider(p_provider_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.append_subscription_usage_reading(p_account uuid, p_connection uuid, p_provider text, p_reading jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.apply_document_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.apply_document_chunk_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.archived_session_event_types() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.arm_usage_allowances_for_membership() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assert_organization_administrator(p_account uuid, p_actor text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assert_organization_integration_policy_administrator(p_account uuid, p_actor text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assert_organization_retention_account(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assert_organization_shared_workspace_administrator(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assert_session_ownership_scope(p_organization_id uuid, p_run_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assert_workspace_membership_removal_actor(p_account_id uuid, p_workspace_id uuid, p_actor_subject text, p_target_subject text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.assign_managed_self_organization_owner() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.attached_browser_devices_update_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.authorize_editable_artifact_actor(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_actor_kind text, p_actor_subject_id text, p_agent_session_id text, p_agent_turn_id text, p_agent_attempt_id text, p_agent_generation integer, p_service_name text, p_permission text, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_ownerless_session_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_personal_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_provider text, p_session_owner_subject_id text, p_turn_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_personal_placement_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_provider text, p_owner_membership_id uuid, p_authority_generation bigint, p_session_owner_subject_id text, p_turn_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_service_session_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_session_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.auto_assign_subscription_core_personal_workspace() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.auto_assign_subscription_core_workspace() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.automatic_session_title_fanout_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.backfill_product_lifecycle_facts(p_source text, p_batch_size integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.begin_site_session_cancellation(a uuid, w uuid, site uuid, root uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_codex_apps_refresh(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_core_owned_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text, p_connection_id uuid, p_holder_id text, p_lease_generation bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.bind_connection_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.bind_connection_owner_authority(p_account_id uuid, p_subject_id text, p_connection_id uuid, p_workspace_id uuid, OUT membership_id uuid, OUT authority_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.bound_workspace_control_event() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_deadline_checkpoint(p_target jsonb, p_prepare boolean, p_touch boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_deadline_checkpoint_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_identities_update_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_state_artifacts_update_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_state_uploads_update_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_system_checkpoint_digest(p_reason text, p_account_id uuid, p_workspace_id uuid, p_lease_id uuid, p_lease_epoch bigint, p_instance_id text, p_browser_session_id text, p_controller_generation text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.browser_system_checkpoint_operation_id(p_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.capture_accepted_turn_connection_authorities() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.capture_host_export_root_session() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.capture_product_lifecycle_fact() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.capture_scheduled_turn_connection_authorities() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.check_organization_tenancy_parity_pre_0340(p_organization_id uuid, p_evidence_limit integer, p_observation_window_days integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_automatic_session_title_fanout_v1(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_browser_state_artifact_cleanup(p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_browser_state_upload_cleanup(p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_connected_command_output_releases(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_due_before timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_connected_machine_background_commands(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_connected_machine_background_commands(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_due_before timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_due_transcription_recording_object_cleanup(p_grace_ms bigint, p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_editable_artifact_live_outbox(p_owner text, p_lease_duration_ms integer, p_limit integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_editable_artifact_materializations(p_owner text, p_lease_duration_ms integer, p_limit integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_expired_file_upload_cleanup(p_grace_ms bigint, p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_memory_slack_publication(p_holder uuid, p_lease_ms integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_native_push_deliveries_v1(p_claim_id uuid, p_limit integer, p_claim_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_organization_user_setup_delivery_unfenced_0401(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_organization_webhook_deliveries_v1(p_claim_id uuid, p_limit integer, p_claim_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_retained_screenshot_maintenance(p_pending_grace_ms bigint, p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_archive_object_deletions(p_claim_timeout_seconds integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_system_update_outbox_v2(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_title_workflows(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_site_auth_maintenance(p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_slack_app_home_refresh(p_holder uuid, p_lease_ms integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_slack_interaction_delivery(p_holder uuid, p_lease_ms integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_slack_interaction_inbox(p_holder uuid, p_lease_ms integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_temporal_schedule_cleanups(p_claim_id uuid, p_limit integer, p_claim_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_reconciler_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_video_generation_operations(p_owner text, p_lease_seconds integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claim_workspace_webhook_deliveries_v1(p_claim_id uuid, p_limit integer, p_claim_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.classify_connected_command_ops(p_control_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text, p_op_ids text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.claude_subscription_pool_protocol_v1_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.cleanup_expired_editable_artifact_live_tickets(p_limit integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_command_containment_reason() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_context_compaction_pending_attempt() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_context_compaction_pending_turn() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_deadline_forced_admissions() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_subscription_settings_locked_overrides() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_unobservable_command_drain() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_untracked_writer_since() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.clear_workspace_codex_session_affinity() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.close_inbox_items_v1(p_session_id uuid, p_kinds text[], p_source_key text, p_status text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.close_session_tenancy_fence_inventory(p_capability_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.close_session_tenancy_fenced_access(p_capability_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.codex_cooldown_revision_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.codex_credential_serves_turn(p_account_id uuid, p_workspace_id uuid, p_credential_id uuid, p_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.codex_credential_serves_workspace(p_account_id uuid, p_workspace_id uuid, p_credential_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.codex_organization_admin_visible(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.codex_organization_live_lease_count(p_account_id uuid, p_credential_id uuid, p_exclude_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.codex_organization_scope_visible(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.compact_session_content_row(p_kind text, p_workspace_id uuid, p_attempt_id uuid, p_stored jsonb, p_refs jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.company_brain_legacy_instruction_projection(value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.company_brain_memory_selections_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.complete_session_archive_object_deletion(p_object_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.complete_temporal_schedule_connector_cleanup(p_id uuid, p_claim_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.complete_workspace_insights_usage_projection(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_event_types text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.complete_workspace_temporal_connector_cleanups(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.configure_fork_session_runtime(p_account_id uuid, p_workspace_id uuid, p_source_session_id uuid, p_destination_session_id uuid, p_actor_subject_id text, p_variable_set_ids jsonb, p_rig_id uuid, p_rig_version_id uuid, p_configuration_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connect_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_credential_encrypted text, p_provider_account_id text, p_provider_subject_id text, p_plan_type text, p_provider_state jsonb, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_account_email text, p_label text, p_connected_by_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connect_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_credential_encrypted text, p_provider_account_id text, p_provider_subject_id text, p_plan_type text, p_provider_state jsonb, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_account_email text, p_label text, p_connected_by_subject_id text, p_credential_format text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connected_command_output_release_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connected_command_reconciliation_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connected_output_runner_eligible_v1(p_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connection_account_intent_is_valid(intent jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.connection_tenancy_backfill_capability_active(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.consume_editable_artifact_live_ticket(p_token_digest text, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.context_compaction_pending_summary() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.continue_session_waiting_work_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.copy_subscription_authority_compat(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.count_active_retained_processes_by_owner_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.count_active_users() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.count_expired_draining_sandbox_leases() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.count_queued_turns() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.count_sandbox_leases_by_liveness() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.count_session_recovery_backlog() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.credit_balance_by_account() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.credit_grant_class(p_type text, p_source_type text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.credit_grant_totals() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_account_id() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_api_key_hash() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_memory_actor_id() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_memory_actor_kind() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_memory_role_key() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_memory_session_id() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_subject_id() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.current_workspace_id() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.dead_letter_editable_artifact_live_outbox(p_outbox_id text, p_owner text, p_attempt_count integer, p_error_code text, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.default_interaction_device_workspace() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.defer_workspace_cascade_foreign_keys() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.detach_retention_variable_set_session_selections(p_account_id uuid, p_membership_id uuid, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.disconnect_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.dismiss_inbox_notification_v1(p_item_id uuid, p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.document_migration_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_actor_key_matches(value text, actor_kind text, actor_subject_id text, agent_session_id text, agent_turn_id text, agent_attempt_id text, agent_generation integer, service_name text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_frontier_dominates(candidate jsonb, required jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_frontier_merge_dot_equals(result_frontier jsonb, left_frontier jsonb, right_frontier jsonb, dot_replica_id text, dot_counter bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_frontier_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_id_array_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_identity_valid(value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_object_has_exact_keys(value jsonb, expected text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_operation_id_list_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_scope_matches_context(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.editable_artifact_text_sha256(value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.end_site_session_cancellation(token uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_codex_credential_workspace() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_codex_lease_source() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_model_connection_access_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_organization_codex_runtime_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_organization_plan_seats() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_rig_platform_base_only_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_sandbox_checkpoint_artifact_immutability() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enforce_session_inference_claim() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_automatic_session_title_fanout_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_event_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_host_session_event_export() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_host_usage_event_export() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_native_push_v1(p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text, p_event_type text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_native_push_v2(p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text, p_event_type text, p_extra jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_native_push_v3(p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text, p_event_type text, p_extra jsonb, p_recipient text, p_link_session boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_recording_event_workspace_webhooks_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_session_archive_object_deletion() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.ensure_editable_artifact_scope_authorization_head(p_account_id uuid, p_workspace_id uuid, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.ensure_workspace_session_activity_revision(target_schema text, target_workspace_id uuid, target_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.expire_refunded_plan_credit() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.external_membership_service_authority(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.external_workspace_service_permissions(p_account uuid, p_actor text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fail_editable_artifact_materialization(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_job_id text, p_owner text, p_attempt_count integer, p_error_code text, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fail_subscription_codex_apps_refresh(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fail_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fail_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fence_inbox_execution_context() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fence_legacy_lossless_content_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fence_mcp_account_bindings() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fence_new_session_draft_project_provenance_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fence_session_execution_context() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fence_slack_bot_post_claim_mode() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.file_private_to_another(p_account uuid, p_workspace uuid, p_file uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.fold_session_event_delta_run(p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_first integer, p_last integer, p_ids uuid[], p_payload jsonb, p_payload_codec_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.google_drive_object_acl_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.governed_learning_derived_uuid(p_operation_id uuid, p_label text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.governed_learning_reason_codes_valid(value text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.grant_verified_signup_trial_credit() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_activated_tenancy_writer() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_connect_attempt_origin() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_editable_artifact_mutable_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_editable_artifact_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_external_identity_link_lifecycle() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_external_link_work_snapshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_binding_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_child_turn_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_delegation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_inherited_turn_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_resolver_write() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_scheduled_turn_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_task_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_host_mcp_turn_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_mcp_operation_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_memory_slack_publication_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_pending_tool_event_output_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_admission_diagnostic() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_admission_refusal() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_run_owner() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_scheduled_task_owner() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_session_title_operation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_binding_provider() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_connection_reference() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_connection_scope() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_designation_disconnect() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_disconnect_admission() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_disconnect_history() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_operation_lease_reference() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_provider_connection_kind() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_provider_registry() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_request_history() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_settings_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_settings_locked_overrides() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_turn_session_reference() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_workspace_owner_reach() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_unresolved_provider_create() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_workspace_owned_skill_head_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_workspace_owned_skill_history_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.guard_workspace_session_activity_revision() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.hold_deleted_site_hostname() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.host_export_session_root(p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.immutable_memory_lifecycle_event() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.inbox_item_v1(p_item_id uuid, p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.inbox_settings_v1(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.inbox_settings_v2(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.inbox_settings_v3(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.inbox_settings_v4(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.index_session_message_search_text() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.informational_update_origin_human_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_kind text, p_lineage jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.initialize_workspace_session_activity_revision() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.insights_raw_amount_inputs(a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.insights_scoped_calls_rows(p_account uuid, p_workspace uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_query jsonb, p_cursor_at timestamp with time zone, p_cursor_id uuid, p_limit integer, p_details uuid[], p_shared boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.insights_scoped_usage_rows(p_account uuid, p_workspace uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_granularity text, p_details uuid[], p_shared boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.insights_site_usage(a uuid, w uuid, lo timestamp with time zone, hi timestamp with time zone, viewer text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.insights_usage_filter(p jsonb, q jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.insights_usage_payer(provider text, billing text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.inspect_slack_installation_binding(p_team_id text, p_bot_id text, p_bot_user_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.integration_webhook_payload_v1(p_account uuid, p_workspace uuid, p_event uuid, p_type text, p_session uuid, p_turn uuid, p_sequence bigint, p_occurred timestamp with time zone, p_payload jsonb, p_lane text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.invalidate_stale_verified_install() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.keep_subscription_codex_cutover_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.knowledge_index_due_v1(p_model text, p_dimensions integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.knowledge_memory_relationship_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.knowledge_memory_row_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.lifecycle_backfill_read_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_artifact_pins(p_account uuid, p_workspace uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_command_containment_candidates(p_limit integer, p_idle_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_continuable_sessions(p_workspace_id uuid, p_root_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_due_event_source_feeds_v1(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_due_recording_retention_v1(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_due_workspace_pause_timers(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_exhausted_scheduled_tasks(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_idle_checkpoint_candidates(p_limit integer, p_interval_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_idle_interaction_leases(p_limit integer, p_idle_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_inbox_items_v1(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_inbox_items_v2(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_inbox_items_v3(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_legacy_modal_checkpoint_slots(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_live_modal_sandbox_leases() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_meterable_warm_leases() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_organization_slack_bots(p_account uuid, p_target uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_orphaned_idle_browser_checkpoints(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_pending_modal_provider_creates() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_setup_uncertainties(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_file_publications(p_account uuid, p_workspace uuid, p_query jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_file_publications_pinned(p_account uuid, p_workspace uuid, p_query jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_sandbox_viewer_force_drain_workspaces() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_scheduled_task_blocker_reviews(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_scheduled_task_schedule_reconciliations(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(after_enrollment uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_stalled_recording_work_v1(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.list_unobservable_command_drain_candidates(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.locate_connected_command_completion(p_control_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text, p_op_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.lock_nested_agent_workspace_policy_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_active(p_actor text, p_operation text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_checkpoint_gc_inner(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_checkpoint_prune_inner(p_retention_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_checkpoint_settle_inner(p_id uuid, p_claim_id uuid, p_deleted boolean, p_error text, p_retry_after_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_ended_blockers_inner(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_ended_setup_inner(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_output_release_inner(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_due_before timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_site_auth_inner(p_claim_timeout_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_snapshots_inner(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_titles_inner(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_updates_inner(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_claim_wakes_inner(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_inventory_draining_inner() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_inventory_retained_inner() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_browser_sessions_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_enrollments_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_output_runner_eligible_v1(p_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_rig_changes_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_rig_versions_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_sandbox_lease_holders_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_sandbox_leases_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_sandbox_retained_processes_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_sandbox_workspace_mutation_admissions_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_session_background_commands_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_session_list_snapshots_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_session_system_update_outbox_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_session_turns_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_session_workflow_wake_outbox_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_sessions_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_probe_site_auth_connections_sync() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_schedule_cleanup_claim_inner(p_claim_id uuid, p_limit integer, p_claim_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_schedule_cleanup_connector_inner(p_id uuid, p_claim_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_schedule_cleanup_settle_inner(p_id uuid, p_claim_id uuid, p_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_title_event_visible(p_actor text, p_event_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_workspace_commands_prepare_inner(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.maintenance_workspace_commands_prune_inner(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.make_room_for_retained_screenshot(p_account_id uuid, p_workspace_id uuid, p_needed_bytes bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.manage_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_action text, p_label text, p_enabled boolean, p_expected_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mark_automatic_session_title_fanout_delivered_v1(p_outbox_id uuid, p_event_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mark_automatic_session_title_fanout_failed_v1(p_outbox_id uuid, p_event_id uuid, p_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mark_editable_artifact_live_outbox_published(p_outbox_id text, p_owner text, p_attempt_count integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mark_inbox_item_event_v1(p_session_id uuid, p_kind text, p_source_key text, p_sequence integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mark_session_activity_pending() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mark_session_turn_deltas_folded(p_workspace_id uuid, p_turn_id uuid, p_folded_runs integer, p_removed_rows integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.mcp_operation_command_scoped(p_scope jsonb, p_action text, p_payload jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.member_notifications_allowed_v1(p_workspace_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.memory_labels_valid(value text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.memory_scope_authorized(row_scope_type text, row_subject_id text, row_role_key text, row_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.memory_scope_visible(row_scope_type text, row_subject_id text, row_role_key text, row_session_id uuid, row_valid_from timestamp with time zone, row_valid_until timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.model_context_value_valid(value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.native_push_device_v1(p_auth_session_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.normalize_api_key_credential_kind() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.observe_credit_grant() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.open_inbox_item_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_recipient text, p_kind text, p_source_key text, p_title text, p_body text, p_urgency text, p_choices jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.open_session_tenancy_fence_inventory(p_target_schema oid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.open_session_tenancy_fenced_access(p_target_schema oid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.optional_workspace_rls_visible(account_id uuid, workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_invitation_row_json(p_invitation organization_membership_invitations) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_membership_history_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_membership_row_json(p_membership organization_memberships) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_model_provider_scope_visible(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_model_usage_summary(p_account_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_after_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_retention_file_candidates(p_account_id uuid, p_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_retention_object_candidates(p_account_id uuid, p_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_subscription_model_scope_visible(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_tenancy_inventory_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_tenancy_parity_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_usage_summary(p_account_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_granularity text, p_after_workspace_id uuid, p_include_period boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.organization_user_setup_delivery_json(p_delivery organization_user_setup_deliveries) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.pause_private_scheduled_task(p_account uuid, p_workspace uuid, p_exclude_owner text, p_task uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_codex_apps_refresh(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_core_refresh_with_plan(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_plan_type text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.personal_document_authority_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.personal_resource_delegation_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.plan_general_balance(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.plan_period_usage(p_period plan_credit_periods, p_until timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.preference_registry_scope_visible(row_account_id uuid, row_scope text, row_workspace_id uuid, row_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prepare_organization_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_task uuid, p_connection uuid, p_version integer, p_home uuid, p_generation bigint, p_channel text, p_thread text, p_text text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prepare_scheduled_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_task uuid, p_connection uuid, p_connection_version integer, p_channel text, p_thread text, p_text text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prepare_workspace_background_command_deletion(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.preserve_credit_grant_scope() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_connection_account_intent_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_connector_action_request_identity_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_organization_codex_disconnect_with_live_leases() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_personal_connection_authority_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_scheduled_task_creator_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_session_creator_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_session_turn_initiator_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prevent_workspace_control_revision_rollback() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.private_scheduled_task_summaries(p_account uuid, p_workspace uuid, p_exclude_owner text, p_task uuid, p_since timestamp with time zone, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.product_lifecycle_auth_method(p_provider_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.product_lifecycle_connection_class(p_provider_domain text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.product_lifecycle_fact_valid(p_fact_type text, p_attribute text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.project_context_compaction_event() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.project_inbox_for_session_event_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.project_session_event_payload(source_payload jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(p_retention_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_event_intake_v1(p_body_seconds integer, p_event_seconds integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_native_push_deliveries_v1(p_retention_hours integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_organization_webhook_deliveries_v1(p_retention_seconds integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_settled_cross_workspace_background_commands(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_subscription_usage_history() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.prune_workspace_webhook_deliveries_v1(p_retention_seconds integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.purge_archived_session_content(p_workspace_id uuid, p_session_id uuid, p_table text, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.purge_expired_transcription_recordings(p_grace_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.put_editable_artifact_live_ticket(p_token_digest text, p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_modality text, p_actor_kind text, p_actor_subject_id text, p_replica_id text, p_agent_session_id text, p_agent_turn_id text, p_agent_attempt_id text, p_agent_generation integer, p_service_name text, p_allow_edit boolean, p_protocol_version integer, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.quarantine_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_holder_id text, p_lease_generation bigint, p_expected_refresh_generation bigint, p_status text, p_last_error text, p_retry_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.queue_detached_retained_screenshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_archived_session_import_batch(p_account uuid, p_workspace uuid, p_session uuid, p_import text, p_subject text, p_batch text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_fork_session_runtime(p_account_id uuid, p_workspace_id uuid, p_source_session_id uuid, p_destination_session_id uuid, p_actor_subject_id text, p_configuration_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_organization_slack_bot_access(p_account uuid, p_home uuid, p_connection uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_organization_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_scheduled_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_sender_connection(p_account_id uuid, p_origin_workspace_id uuid, p_connection_id uuid, p_owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_session_file_attachments(p_account uuid, p_workspace uuid, p_session uuid, p_epoch integer, p_files uuid[], p_actor jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_slack_bot_workspace_access(p_account uuid, p_home uuid, p_connection uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_subscription_authority_compat(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_subscription_codex_apps_credential(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_subscription_core_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_subscription_core_owned_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.read_subscription_usage_history(p_account uuid, p_workspace uuid, p_subject text, p_provider text, p_connections uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reap_expired_session_list_snapshots(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reap_mcp_oauth_state(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reap_sandbox_leases(p_viewer_holder_ttl_ms bigint, p_idle_grace_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reap_sandbox_leases(p_viewer_holder_ttl_ms bigint, p_turn_holder_ttl_ms bigint, p_interaction_holder_ttl_ms bigint, p_idle_grace_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reap_stale_interaction_transitions(p_interaction_holder_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reclaim_finished_subscription_runtime_capabilities() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_archived_session_import_batch(p_account uuid, p_workspace uuid, p_session uuid, p_import text, p_subject text, p_batch text, p_hash text, p_offset integer, p_count integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_organization_signup_use_case(p_account uuid, p_subject text, p_use_case text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_sandbox_file_publication(p_account uuid, p_workspace uuid, p_file uuid, p_session uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_sandbox_recovery_operator_event(event_id uuid, event_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_subscription_core_owned_connection_quota(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_refresh_generation bigint, p_expected_revision bigint, p_quota jsonb, p_observed_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_subscription_core_plan_change() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.record_user_activity_presence(p_subject_ids text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.recover_subscription_core_connection_health(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.refresh_concurrent_capture_takeover() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.register_mcp_oauth_client(p_client_id text, p_redirect_uris jsonb, p_client_name text, p_grant_types jsonb, p_response_types jsonb, p_registration_scope_hash text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.register_native_push_device_v1(p_auth_session_id text, p_platform text, p_app_id text, p_environment text, p_token text, p_rules text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_document_migration_receipt_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_editable_artifact_history_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_memory_slack_immutable_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_session_turn_prompt_routing_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_session_turn_surface_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_skill_config_receipt_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reject_unfinalized_session_activity() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.release_editable_artifact_live_outbox(p_outbox_id text, p_owner text, p_attempt_count integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.renew_editable_artifact_live_outbox(p_outbox_id text, p_owner text, p_attempt_count integer, p_lease_duration_ms integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.renew_editable_artifact_materialization(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_job_id text, p_owner text, p_attempt_count integer, p_lease_duration_ms integer, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.request_due_sandbox_rotations(p_lead_ms bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.require_session_tenancy_fence() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.reset_subscription_binding_cache_clock() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_device_enrollment_request(p_device_code text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_document_index_authority(p_account_id uuid, p_workspace_id uuid, p_document_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_editable_artifact_data_schema(requested_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_editable_artifact_ticket_data_schema(requested_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_integration_initiating_human_v1(p_account uuid, p_workspace uuid, p_subject text, p_turn uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_organization_credential_provider_v1(p_account uuid, p_workspace uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_pending_device_enrollment_by_user_code(p_user_code text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(p_connection_id uuid, p_handle_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(p_account_id uuid, p_connection_id uuid, p_handle_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_installation(p_team_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(p_connection_id uuid, p_route_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(p_account_id uuid, p_connection_id uuid, p_route_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resolve_subscription_codex_apps_designation(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.resource_classification_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.retry_editable_artifact_live_outbox(p_outbox_id text, p_owner text, p_attempt_count integer, p_retry_delay_ms integer, p_error_code text, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(p_claim_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_artifact_inventory() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_staleness() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_checkpoint_staleness_at(value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_ended_epoch_blockers_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_idle_checkpoint_due_v1(p_interval_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_lease_reaper_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_recovery_observations() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_rotation_backlog() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sandbox_rotation_interaction_blocked() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scheduled_personal_resource_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scoped_compute_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scoped_knowledge_actor_authorized(row_actor_kind text, row_actor_subject_id text, row_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scoped_knowledge_actor_valid(row_actor_kind text, row_actor_subject_id text, row_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scoped_knowledge_scope_key(row_scope text, row_workspace_id uuid, row_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scoped_knowledge_scope_valid(row_scope text, row_workspace_id uuid, row_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.scoped_knowledge_scope_visible(row_account_id uuid, row_scope text, row_workspace_id uuid, row_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.seed_subscription_codex_cutover() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_archive_candidates(p_idle_seconds bigint, p_limit integer, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_archive_preference_snapshot_rows(p_workspace_id uuid, p_session_id uuid, p_after_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_archive_unfinished(p_stale_seconds bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_content_compaction_candidates(p_kind text, p_after_attempt_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_create_idempotency_guard_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_delta_fold_candidates(p_settle_seconds bigint, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_depth_policy_defaults() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_depth_snapshot_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_file_read_allowed(p_account uuid, p_workspace uuid, p_file uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_hands_back_v1(p_session_id uuid, p_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_list_snapshots_expired_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_ownership_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_person_v1(p_workspace_id uuid, p_session_id uuid, p_owner text, p_creator text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_recipient_v1(p_owner text, p_creator text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_replies_muted_for_v1(p_session_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_replies_muted_v1(p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_reply_mute_schedule_v1(p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_spawn_denials_append_only() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_system_update_outbox_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_tenancy_account_activated(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_tenancy_fence_inventory_capability_active(p_target_schema oid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_tenancy_fenced_access_capability_active(p_target_schema oid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_variable_set_attachments_protocol_v1_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_work_claim_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.session_workflow_wakes_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_inbox_settings_v1(p_account_id uuid, p_subject_id text, p_tidy_policy text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_inbox_settings_v2(p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_inbox_settings_v3(p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean, p_replies boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_inbox_settings_v4(p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean, p_replies boolean, p_time_sensitive_needs_you boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_member_notifications_allowed_v1(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_allowed boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_organization_slack_bot_access(p_account uuid, p_home uuid, p_connection uuid, p_subject text, p_enabled boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_session_replies_muted_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_subject_id text, p_muted boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_slack_bot_workspace_access(p_account uuid, p_home uuid, p_connection uuid, p_subject text, p_enabled boolean, p_workspaces uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_subscription_core_reach(p_provider text, p_account_id uuid, p_connection_id uuid, p_shared boolean, p_personal boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.set_subscription_core_reach_allocator(p_provider text, p_account_id uuid, p_connection_id uuid, p_enabled boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.settle_background_command_from_retained_process() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.settle_native_push_delivery_v1(p_claim_id uuid, p_delivery_id uuid, p_outcome text, p_error text, p_retry_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.settle_organization_webhook_delivery_v1(p_delivery_id uuid, p_claim_id uuid, p_status integer, p_error text, p_max_attempts integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.settle_sandbox_checkpoint_artifact(p_id uuid, p_claim_id uuid, p_deleted boolean, p_error text, p_retry_after_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.settle_temporal_schedule_cleanup(p_id uuid, p_claim_id uuid, p_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.settle_workspace_webhook_delivery_v1(p_delivery_id uuid, p_claim_id uuid, p_status integer, p_error text, p_max_attempts integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.site_auth_maintenance_due_v1(p_claim_timeout_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.slack_routing_capability_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.stamp_document_index_completion() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.stamp_sandbox_lease_holders_changed() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.stamp_session_workflow_control_revision() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_apps_designation_allowed(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_apps_designation_manage_allowed(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_authority_carrier_inserted_now(p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_authority_compat_providers() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_apps_designation_target(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_cutover_v1_active() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_owner_capability_held(p_account_id uuid, p_kinds text[], p_subject_id text, p_connection_id uuid, p_any_connection boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_owner_membership_held(p_account_id uuid, p_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_refresh_write_allowed(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_reset_authority(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_reset_credit_fence(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text, p_credit_id text, p_attempt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_connection_visible(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_ownership text, p_scope_kind text, p_owner_membership_id uuid, p_owner_subject_id text, p_provider text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_acceptance_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_accepting_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_connection_kind(p_provider text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_failover_readiness(p_provider text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_owner_capability_held(p_provider text, p_account_id uuid, p_kinds text[], p_subject_id text, p_connection_id uuid, p_any_connection boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_owner_membership_held(p_account_id uuid, p_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_personal_connection_versions(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_personal_connections(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_personal_sharing(p_provider text, p_account_id uuid, p_subject_id text, p_connection_id uuid, p_expected_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_reach(p_provider text, p_account_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_refresh_write_allowed(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_revision_authority_v2(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_core_task_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_reusable_session_id uuid, p_accepting_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_organization_admin(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_own_person_membership_id(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_people_assignment_visible(p_account_id uuid, p_workspace_id uuid, p_membership_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_people_designation_visible(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_person_preference_owned(p_account_id uuid, p_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_person_preference_visible(p_account_id uuid, p_membership_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_personal_connection_visible(p_account_id uuid, p_connection_id uuid, p_owner_membership_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text, p_provider text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_plan_definition(p_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_plan_free_anniversary(p_created_at timestamp with time zone, p_now timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_provider_cutover_committed(p_provider text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_setting_override_widened(p_new jsonb, p_old jsonb, p_keyed boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.subscription_usage_history_prune_due() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.succeed_editable_artifact_materialization(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_job_id text, p_owner text, p_attempt_count integer, p_result_id text, p_blob_ref_id text, p_object_reference text, p_byte_size bigint, p_content_hash text, p_mime_type text, p_verified_at timestamp with time zone, p_data_schema name) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.summarize_session_recovery_backlog() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.supervised_command_blocker_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.supervised_command_capture_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.supervised_command_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.supervised_provider_loss_commit_guard() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sync_external_membership_lifecycle() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sync_slack_action_handle_tenancy() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sync_slack_installation_binding() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.sync_usage_maintenance_due() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.tenancy_activation_canonical_json(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.tenancy_backfill_ledger_available() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.terminal_retained_processes_due_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.truncate_workspace_control_text(source_text text, max_bytes integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.unregister_native_push_device_v1(p_auth_session_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.update_artifact_pin(p_account uuid, p_workspace uuid, p_kind text, p_id text, p_pinned boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.update_inbox_item_attention_v1(p_item_id uuid, p_account_id uuid, p_subject_id text, p_seen boolean, p_set_snooze boolean, p_snoozed_until timestamp with time zone, p_dismiss boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.update_organization_integration_policy(p_account uuid, p_actor text, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.upgrade_temporal_schedule_connector_cleanup(p_account_id uuid, p_workspace_id uuid, p_temporal_schedule_id text, p_scheduled_task_id uuid, p_subject_id text, p_snapshot jsonb, p_claim_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_editable_artifact_projection() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_editable_artifact_transaction_commit() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_editable_artifact_version_projection() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_mcp_account_bindings(bindings jsonb, delegations jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_sandbox_checkpoint_artifact_refs() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_sandbox_checkpoint_refs() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_sandbox_pty_process_v2() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_sandbox_retained_process_v2() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_session_parent_turn() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_usage_event_execution_context() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.validate_user_resource_grant_action() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.variable_set_authority_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_assert_name(p_name text, p_what text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_assert_writable(p_context jsonb, p_vault vaults) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_audit(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_action text, p_target_type text, p_target_id text, p_metadata jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_authority_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_capability_close() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_capability_open(p_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_context(p_principal jsonb, p_workspace uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_ensure_default(p_context jsonb, p_owner_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_ensure_task(p_context jsonb, p_session uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_insert(p_context jsonb, p_owner_kind text, p_name text, p_description text, p_allowed_workspace_ids uuid[], p_allow_personal_workspaces boolean, p_is_default boolean, p_root_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_item_json(p_item vault_items, p_with_fields boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_items_by_key(p_vault_ids uuid[], p_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_limit(p_name text, p_default integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_name_is_valid(p text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_owner_scope_key(p_vault vaults) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_policy_ids(p_policy jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_policy_intersect(p_left jsonb, p_right jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_policy_is_valid(p jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_principal_context(p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_raise(p_code text, p_message text, p_details jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_reach(p_context jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_reachable_item(p_context jsonb, p_item_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_reachable_row(p_context jsonb, p_vault_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_sanitize_legacy_name(p text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_session_policy_chain(p_account uuid, p_workspace uuid, p_session uuid, p_include_self boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_session_view_json(p_context jsonb, p_session uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_subject_has_secrets_use(p_account uuid, p_workspace uuid, p_subject text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_subject_in_workspace(p_account uuid, p_workspace uuid, p_subject text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_summary_json(p_vault vaults, p_context jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_vaults_by_key(p_vault_ids uuid[], p_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_workspace_is_personal(p_account uuid, p_workspace uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_workspace_set(p_ids uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.vault_write_item(p_context jsonb, p_vault vaults, p_existing vault_items, p jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_model_call_facts(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_provider text, p_model text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_model_fact_rows(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_provider text, p_model text, p_root_session_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_usage_events(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_usage_events(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_event_types text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.visible_workspace_insights_usage_projection(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_event_types text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.wake_teams_route_for_session_event() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.warming_reset_resume_state_v2(p_backend text, p_resume_backend_id text, p_resume_state jsonb, p_workspace_generation integer, p_archive_generation integer, p_reset_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_insights_amount_fact_rows(p_workspace_id uuid, p_since timestamp with time zone, p_until timestamp with time zone, p_provider text, p_model text, p_root_session_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_member_custom_permissions_valid(p_permissions jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_member_legacy_permissions_0516() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_member_legacy_permissions_0555() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_member_legacy_permissions_0865() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_member_role(p_role text, p_permissions jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_member_role_permissions(p_role text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_membership_administers(p_role text, p_permissions jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_private.workspace_rls_visible(account_id uuid, workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.append_usage_reading(p_account uuid, p_connection uuid, reading jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.apply_subscription_core_auto_assignments(p_provider text, p_account_id uuid, p_workspace_id uuid, p_personal boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.capture_usage_call() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.capture_usage_reading() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.derive_scheduled_revision_subscription_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.drop_subscription_codex_owner_capabilities(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.drop_subscription_core_owner_capabilities(p_provider text, p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.enforce_subscription_authority_compat() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.grant_subscription_codex_owner_capability(p_kind text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.grant_subscription_core_owner_capability(p_provider text, p_kind text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.guard_subscription_authority_compat() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.keep_subscription_authority_inserted_at() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.keep_subscription_cutover_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.stamp_subscription_authority_inserted_at() FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_authority_compat_entry_valid(entry jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_carrier_expected(p_provider text, p_committed_at timestamp with time zone, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint, OUT fires boolean, OUT has_record boolean, OUT personal jsonb, OUT shared_pool text, OUT legacy_scope text, OUT owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_carrier_sources(p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_carrier_state(p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint, OUT account_id uuid, OUT v2 jsonb, OUT inserted_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_compaction_source(p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_delivery_sources(p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_execution_context_turn_id uuid, p_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_effective(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_enter_scope(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_expected(p_provider text, p_committed_at timestamp with time zone, p_workspace_id uuid, p_source_kind text, p_source_id uuid, p_source_revision bigint, p_causal_human text, OUT fires boolean, OUT has_record boolean, OUT personal jsonb, OUT shared_pool text, OUT legacy_scope text, OUT owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_leave_scope(p_prior text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_receiver_source(p_workspace_id uuid, p_session_id uuid, OUT source_kind text, OUT source_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_record(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_scheduled_source(p_workspace_id uuid, p_run_id uuid, OUT source_kind text, OUT source_id uuid, OUT source_revision bigint, OUT causal_human text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_turn_human(p_workspace_id uuid, p_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_compat_v2_has_entry(p_v2 jsonb, p_provider text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_core_connection_target(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_core_writer_context(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_personal_entry_serviceable(p_account_id uuid, p_entry jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_scheduled_firing_v2(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_scheduled_run_personal_entries(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION opengeni_subscription_internal.subscription_v2_copy_matches(p_value jsonb, p_expected jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION accept_organization_invitation_v2(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION accept_turn_personal_resource_attachment(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_mode text, p_expected_authority_epoch integer, p_workspace_shared_acknowledged boolean, p_shared_output_warning_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_automatic_session_title_quarantine_fences_v1(p_batch_size integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_due_retained_process_session_tenancy_fences() FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_due_sandbox_rotation_session_tenancy_fences(p_lead_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_organization_session_tenancy_fences(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_sandbox_reaper_session_tenancy_fences() FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_sandbox_reaper_session_tenancy_fences(p_interaction_holder_ttl_ms bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_scoped_machine_session_tenancy_fences(p_account_id uuid, p_sandbox_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION acquire_session_tenancy_fence(p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION activate_governed_learning_decision(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_decision_receipt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION activate_greenfield_session_tenancy_from_setup(p_auth_user_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION activate_human_confirmed_learning_decision(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_decision_receipt_id uuid, p_human_input_request_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION activate_session_tenancy_from_additional_organization(p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION activate_session_tenancy_product(p_account_id uuid, p_inventory_digest text, p_parity_digest text, p_activated_by text, p_application_roles text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_scheduled_agent_run_execution() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_scheduled_task_run_connection_authorities() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_scheduled_task_run_personal_resources() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_session_attempt_personal_documents() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_session_attempt_personal_machine() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_session_attempt_personal_machine_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_session_attempt_personal_resources() FROM PUBLIC;

REVOKE ALL ON FUNCTION admit_session_attempt_personal_resources_v1() FROM PUBLIC;

REVOKE ALL ON FUNCTION advance_session_event_cursors_for_inserted_events() FROM PUBLIC;

REVOKE ALL ON FUNCTION agent_instruction_activation_preserves_baseline() FROM PUBLIC;

REVOKE ALL ON FUNCTION agent_instruction_apply(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION agent_instruction_apply_0462_unsafe(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION agent_learning_manage(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION apply_canonical_human_identity_operation(p_operation_id uuid, p_auth_user_id text, p_expected_identity_revision bigint, p_operation_type text, p_binding_id uuid, p_provider_id text, p_provider_account_id text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION apply_secret_answers(p_session uuid, p_turn uuid, p_answers jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION archive_task_note_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_note_id uuid, p_expected_version integer, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION archive_vault_item(p_item uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_active_managed_human_organization_membership(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_document_migration_audit_authority(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_managed_sign_in_recovery(p_user text, p_session text, p_binding uuid, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_organization_shared_workspace_administrator(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_scoped_variable_set_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_scoped_variable_set_materialization_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_session_attempt_machine_consent(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid, p_require_active_sandbox boolean, p_record_use boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid, p_require_active_sandbox boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_session_event_projection_not_ahead() FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_session_tenancy_quiescent(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_require_singleton_group boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION assert_workspace_member_management_candidate(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_target_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION authorize_organization_shared_workspace_administration(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION authorize_scoped_sandbox_attach(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION authorize_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION authorize_session_attempt_personal_resource_reads(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION backfill_organization_connection_authority(p_account_id uuid, p_limit integer, p_dry_run boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION backfill_organization_session_ownership(p_organization_id uuid, p_limit integer, p_dry_run boolean, p_run_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION begin_billing_subscription_operation(p_account_id uuid, p_key uuid, p_kind text, p_request jsonb, p_intent jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION begin_plan_credit_settlement(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION bind_managed_social_account() FROM PUBLIC;

REVOKE ALL ON FUNCTION bind_pending_organization_invitations_for_verified_email(p_subject_id text, p_email text) FROM PUBLIC;

REVOKE ALL ON FUNCTION bind_scheduled_task_run_connection_authorities(p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION bind_scheduled_task_run_session(p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION bind_session_attempt_machine_consent(p_attempt_id uuid, p_turn_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION bind_session_site_audience() FROM PUBLIC;

REVOKE ALL ON FUNCTION bump_social_connection_version() FROM PUBLIC;

REVOKE ALL ON FUNCTION capture_company_brain_turn_context_snapshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION capture_legacy_codex_turn_sources(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION capture_usage_allowance_attribution() FROM PUBLIC;

REVOKE ALL ON FUNCTION capture_usage_allowance_period(p_account uuid, p_workspace uuid, p_config jsonb, p_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION carry_session_attempt_machine_authorization(p_attempt_id uuid, p_turn_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION change_connected_machine_audience(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_expected_generation bigint, p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION check_organization_tenancy_parity(p_organization_id uuid, p_evidence_limit integer, p_observation_window_days integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION check_tenancy_backfill_activation_evidence(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION claim_managed_sign_in_notification(p_operation uuid, p_sender text, p_scope text, p_retention integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION claim_organization_retention_deletion(p_account_id uuid, p_operation_id uuid, p_excluded_membership_ids uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION claim_organization_user_setup_delivery(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION claim_organization_user_setup_delivery_v2(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION classify_organization_connection_authority(p_account_id uuid, p_run_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION classify_organization_session_ownership(p_organization_id uuid, p_run_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION claude_provider_account_authority_snapshot_v1_valid(snapshot jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION clear_subscription_connection_health_retry() FROM PUBLIC;

REVOKE ALL ON FUNCTION clone_scheduled_task_personal_resource_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_source_revision bigint, p_target_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION clone_scheduled_task_revision_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_source_revision bigint, p_target_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION close_organization_shared_workspace_administration_capability(p_capability_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION close_private_session_create_capability(p_capability_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_brain_context_get_or_create_selection(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_brain_inspect_context_receipts(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_attempt_id uuid, p_before_created_at timestamp with time zone, p_before_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_profile_agent_confirmation_prompt(p_revision_id uuid, p_revision bigint, p_content_hash text, p_content_json text) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_profile_agent_confirmation_summary(p_content_json text) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_profile_apply_activation(p_operation_id uuid, p_request_fingerprint text, p_account_id uuid, p_workspace_id uuid, p_target_revision_id uuid, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_type text, p_actor_subject_id text, p_principal_kind text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_profile_canonical_snapshot_at(p_account_id uuid, p_accepted_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION company_profile_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION complete_billing_subscription_operation(p_account_id uuid, p_key uuid, p_result jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION complete_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text) FROM PUBLIC;

REVOKE ALL ON FUNCTION complete_organization_user_setup(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION complete_self_service_organization_setup(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION complete_tenancy_backfill_receipt(p_receipt_id uuid, p_classified_count bigint, p_skipped_count bigint, p_status text) FROM PUBLIC;

REVOKE ALL ON FUNCTION confirm_company_profile_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_proposal_receipt_id uuid, p_human_input_request_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION confirm_remember_knowledge_claim(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_execution_generation integer, p_operation_id uuid, p_claim_id uuid, p_human_input_request_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION connected_machine_audience_inventory(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION connected_machine_audience_workspaces(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION consent_session_turn_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_enrollment_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION count_scoped_rigs(p_account_id uuid, p_workspace_id uuid, p_scope text) FROM PUBLIC;

REVOKE ALL ON FUNCTION count_scoped_variable_sets(p_account_id uuid, p_workspace_id uuid, p_scope text) FROM PUBLIC;

REVOKE ALL ON FUNCTION count_unbilled_allowance_usage(p_account_id uuid, p_workspace_id uuid, p_human text, p_amount bigint, p_data_schema text) FROM PUBLIC;

REVOKE ALL ON FUNCTION count_unbilled_model_allowance_debit() FROM PUBLIC;

REVOKE ALL ON FUNCTION count_workspace_allowance_debit() FROM PUBLIC;

REVOKE ALL ON FUNCTION create_additional_managed_organization(p_subject_id text, p_subject_label text, p_organization_name text, p_workspace_name text, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_agent_child_session(p_account uuid, p_workspace uuid, p_parent uuid, p_turn uuid, p_attempt uuid, p_generation integer, p_values jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_managed_organization(p_subject_id text, p_subject_label text, p_name text, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_organization_invitation_v2(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_organization_shared_workspace(p_account_id uuid, p_actor_subject_id text, p_name text, p_slug text, p_agent_instructions text, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_personal_document_authority(p_account_id uuid, p_workspace_id uuid, p_document_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_scheduled_agent_run_with_admission(p_run_id uuid, p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint, p_task_execution_digest text, p_trigger_type text, p_producer_key text, p_scheduled_at timestamp with time zone, p_fired_at timestamp with time zone, p_accepted_execution_snapshot jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_scoped_rig(p_account_id uuid, p_workspace_id uuid, p_scope text, p_name text, p_description text, p_created_by text, p_initial_version jsonb, p_allow_organization boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_scoped_variable_set(p_account_id uuid, p_workspace_id uuid, p_scope text, p_name text, p_description text, p_variables jsonb, p_allow_organization boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_task_note_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_kind text, p_text text, p_expires_in_days integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION create_vault(p jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION delete_vault(p_id uuid, p_confirm_name text, p_allow_organization boolean, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION delete_vault_item_permanently(p_item uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION derive_session_execution_authority_epoch() FROM PUBLIC;

REVOKE ALL ON FUNCTION detach_scoped_machine_dependent_sessions(p_account_id uuid, p_origin_workspace_id uuid, p_sandbox_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION digest_turn_personal_resource_snapshot(p_snapshot turn_personal_resource_snapshots) FROM PUBLIC;

REVOKE ALL ON FUNCTION document_migration_audit_capability_active(p_capability_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION emit_usage_allowance_notifications(p_account uuid, p_workspace uuid, p_config jsonb, p_period text, p_end timestamp with time zone, p_subject text) FROM PUBLIC;

REVOKE ALL ON FUNCTION enable_organization_private_sessions_from_activation(p_account_id uuid, p_application_roles text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION enforce_subscription_refresh_generation() FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_canonical_human_identity(p_auth_user_id text, p_display_name text) FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_default_vault(p_workspace uuid, p_owner_kind text, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_external_identity(p_account_id uuid, p_source text, p_external_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_managed_human_personal_workspace(p_account_id uuid, p_subject_id text, p_personal_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_organization_user_setup_intent(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION ensure_task_vault(p_workspace uuid, p_session uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION evaluate_governed_learning_proposal(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_policy_snapshot_id uuid, p_proposal_id uuid, p_claim_id uuid, p_evidence_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION expire_ended_plan_credit_periods(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION expire_plan_credit_period(p_account_id uuid, p_period_id uuid, p_force boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION fail_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_reason_code text) FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_attempt_personal_resource_protocol_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_background_command_launch_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_child_session_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_agent_run_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_occurrence_evidence_delete() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_occurrence_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_task_personal_resource_execution_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_task_run_connection_session_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_task_tombstone() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_task_turn_run_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_scheduled_turn_execution_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_session_create_requested_visibility_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_session_initial_personal_resource_intent_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_terminal_scheduled_occurrence_delivery() FROM PUBLIC;

REVOKE ALL ON FUNCTION fence_turn_personal_resource_protocol_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION finalize_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text) FROM PUBLIC;

REVOKE ALL ON FUNCTION finalize_scoped_enrollment(p_account_id uuid, p_workspace_id uuid, p_scope text, p_pubkey text, p_has_display boolean, p_allow_screen_control boolean, p_os text, p_arch text, p_sandbox_name text, p_allow_organization boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_source_event_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION fork_session_content_with_runtime(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_variable_set_ids jsonb, p_rig_id uuid, p_rig_version_id uuid, p_configuration_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION free_plan_credit_eligible(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION freeze_scheduled_task_personal_resources(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_canonical_human_exact_login_binding(p_auth_user_id text, p_provider_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_canonical_human_identity_projection(p_auth_user_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_company_profile_agent_policy(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_document_default_collection_backfill_audit(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_external_identity_link_inventory_references(p_account_id uuid, p_link_ids uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_external_identity_link_reference(p_account_id uuid, p_link_id uuid, p_challenge_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_organization_administration_overview(p_account_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_organization_invitation_for_administration(p_account_id uuid, p_actor_subject_id text, p_invitation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_organization_private_session_settings(p_account_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_organization_recovery_overview(p_account_id uuid, p_actor_subject text, p_fence jsonb, p_auth_session_id text, p_auth_user_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_organization_retention_policy(p_account_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_private_session_create_policy(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_scoped_sandbox(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_self_organization_invitation(p_subject_id text, p_invitation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_self_personal_github_repository_selection(p_account_id uuid, p_origin_workspace_id uuid, p_owner_subject_id text, p_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_session_attempt_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_sandbox_id uuid, p_enrollment_id uuid, p_require_active_sandbox boolean, p_metadata_only boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_session_machine_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_vault_for_subject(p_vault uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_vault_item(p_item uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION get_workspace_kind(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION google_drive_document_citation(p_account_id uuid, p_request_workspace_id uuid, p_subject_id text, p_document_id uuid, p_file_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION google_drive_file_authorized(p_account_id uuid, p_request_workspace_id uuid, p_subject_id text, p_file_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION governed_learning_apply_instruction_policy(p_action text, p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_proposal_id uuid, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_target_revision_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION governed_learning_apply_knowledge_review(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_claim_id uuid, p_expected_review_id uuid, p_expected_review_revision bigint, p_state text, p_actor_subject_id text, p_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION governed_learning_apply_knowledge_review(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_claim_id uuid, p_expected_review_id uuid, p_expected_review_revision bigint, p_state text, p_actor_subject_id text, p_initiating_human_subject_id text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION governed_learning_apply_preference(p_action text, p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_knowledge_proposal_id uuid, p_preference_id uuid, p_revision_id uuid, p_expected_active_revision_id uuid, p_expected_activation_version integer, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION governed_learning_deactivate_instruction_policy(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_proposal_id uuid, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION grant_plan_credit_period(p_account_id uuid, p_plan_key text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_stripe_subscription_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_company_brain_context_selection_receipt() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_company_brain_turn_context_snapshot() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_explicit_workspace_recovery_publication() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_explicit_workspace_recovery_warning() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_imported_archive_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_managed_social_account() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_private_child_session_create() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_private_session_visibility_transition() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_public_sandbox_recovery_lease() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_public_sandbox_recovery_session() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_sandbox_automatic_warning_receipt() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_sandbox_recovery_consent_receipt() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_sandbox_recovery_warning_claim() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_session_admission_block() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_session_agent_creation_provenance() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_session_work_claim_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_session_work_claim_revision_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_slack_file_upload_operation() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_task_note_event_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_task_note_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_tenancy_backfill_unresolved_row() FROM PUBLIC;

REVOKE ALL ON FUNCTION guard_variable_set_session_attachments() FROM PUBLIC;

REVOKE ALL ON FUNCTION has_pending_organization_invitation_for_subject(p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION initialize_company_profile_agent_policy() FROM PUBLIC;

REVOKE ALL ON FUNCTION inspect_governed_learning_activation_undos(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION inspect_governed_learning_activations(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION inspect_governed_learning_decisions(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION inspect_organization_connection_authority_convergence(p_account_id uuid, p_limit integer, p_after_connection_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION invalidate_unclaimed_scheduled_agent_runs_on_task_inactive() FROM PUBLIC;

REVOKE ALL ON FUNCTION inventory_organization_tenancy(p_organization_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION issue_self_user_resource_grant(p_account_id uuid, p_authority_id uuid, p_workspace_id uuid, p_action text, p_mode text, p_context text, p_session_id uuid, p_workspace_shared_acknowledged boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION issue_self_user_resource_grant(p_account_id uuid, p_authority_id uuid, p_workspace_id uuid, p_resource_kind text, p_mode text, p_context text, p_session_id uuid, p_expected_authority_epoch integer, p_workspace_shared_acknowledged boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_document_prepare(p_account uuid, p_workspace uuid, p_document uuid, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_document_visible(p_document uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_enqueue_index() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_entry_apply(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_entry_confirm_legacy(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_entry_prepare_file(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_entry_read(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_entry_visible_body(p_account uuid, p_body jsonb, p_pending boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_file_owner_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_attribution_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_billing_policy(p_account uuid, p_revision uuid, p_lease uuid, p_requested text, p_activation_at timestamp with time zone, p_rate bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_claim(p_model text, p_dimensions integer, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_paid_publication_guard(p_account uuid, p_revision uuid, p_lease uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_retention_active(p_account uuid, p_entry uuid, p_revision uuid, p_preparing_document uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_revision(p_account uuid, p_entry uuid, p_revision uuid, p_text text) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_wait_for_funding(p_account uuid, p_revision uuid, p_lease uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_index_work(p_account uuid, p_revision uuid, p_lease uuid, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_instruction_confirm_legacy(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_instruction_context(p_revision workspace_instruction_policy_revisions) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_learning_context_visible(p_account uuid, p_workspace uuid, p_subject text, p_scope text, p_context text) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_learning_for_turn(p_account uuid, p_workspace uuid, p_turn uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_learning_resolve(p_account uuid, p_workspace uuid, p_subject text, p_context text, p_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_learning_settings_valid(value jsonb, complete boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_legacy_memory_setting_retired() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_legacy_version_visible(p_account uuid, p_version uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_media_file_owner_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_memory_apply_operation(p_plan jsonb, p_plan_hash text, p_actor_kind text, p_actor_subject_id text, p_actor_session_id uuid, p_actor_turn_id uuid, p_actor_attempt_id uuid, p_actor_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_memory_plan_hash(p_value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_memory_revert_operation(p_operation_id uuid, p_applied_operation_id uuid, p_plan_hash text, p_actor_kind text, p_actor_subject_id text, p_actor_session_id uuid, p_actor_turn_id uuid, p_actor_attempt_id uuid, p_actor_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_memory_stable_jsonb(p_value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_query_billing_receipt_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_reject_history_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_resolve_actor(p_account uuid, p_workspace uuid, p_actor jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_retired_learning_read_only() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_retired_memory_read_only() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_review_batch_for_actor(p_account uuid, p_workspace uuid, p_actor jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_revision_visible(p_account uuid, p_entry uuid, p_revision uuid, p_pending boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_revisions_visible(p_account uuid, p_entries uuid[], p_revisions uuid[], p_pending boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_scope_visible(e knowledge_entries) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_source_index_wake() FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_source_sync_lock_authority(p_account_id uuid, p_source_id uuid, p_object_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_source_visible(p_account uuid, p_body jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_task_note_source(p_account uuid, p_workspace uuid, p_actor jsonb, p_note uuid, p_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_validate_links(p_account uuid, p_entry uuid, p_body jsonb, p_batch uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_validate_source(p_account uuid, p_entry uuid, p_body jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION knowledge_visible_index_status(p_account uuid, p_workspace uuid, p_actor jsonb, p_items jsonb, p_view text) FROM PUBLIC;

REVOKE ALL ON FUNCTION lease_vault_passkeys(p_principal jsonb, p_holder text, p_ttl_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION link_provider_vault(p jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_document_authority_reclassifications(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_document_id uuid, p_limit integer, p_before_created_at timestamp with time zone, p_before_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_document_default_collection_backfill_runs(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_administration_members(p_account_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_codex_workspace_ids(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_document_authority_reclassifications(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_invitations(p_account_id uuid, p_actor_subject_id text, p_cursor_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_members(p_account_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_membership_backfill_anchors(p_organization_id uuid, p_subject_ids text[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_memberships_without_personal_workspace(p_organization_id uuid, p_limit integer, p_after_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_retention_deletion_objects(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_subscription_workspace_ids(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_organization_workspace_ids(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_owned_connection_accounts(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_scoped_enrollments(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_status text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_scoped_machine_dependent_sessions(p_account_id uuid, p_origin_workspace_id uuid, p_sandbox_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_scoped_rigs(p_account_id uuid, p_workspace_id uuid, p_rig_id uuid, p_name text, p_scope text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_scoped_variable_sets(p_account_id uuid, p_workspace_id uuid, p_variable_set_id uuid, p_name text, p_scope text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_self_organization_invitations(p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_self_organization_invitations(p_subject_id text, p_cursor_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_self_organization_memberships(p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_self_user_resource_authorities(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_self_user_resource_authorities(p_account_id uuid, p_workspace_id uuid, p_resource_kind text, p_after_authority_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_task_notes_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_include_archived boolean, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_vault_field_versions(p_field uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_vault_items(p_vault uuid, p_query text, p_type text, p_include_archived boolean, p_cursor text, p_limit integer, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_vaults_for_subject(p_workspace uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION list_workspace_member_management_candidates(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION live_session_turn_machine_consent(p_consent_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION lock_live_native_original_origin_v2(p_scope jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION lock_nested_agent_depth_configuration() FROM PUBLIC;

REVOKE ALL ON FUNCTION lock_session_tenancy_activation_boundary() FROM PUBLIC;

REVOKE ALL ON FUNCTION lookup_external_identity(p_account uuid, p_actor text, p_source text, p_external_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION maintain_session_usage_limits(p_limit integer, p_budget integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION maintain_usage_allowances(p_limit integer, p_member_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_actor_mutation_fence(p_authority_hash text, p_actor_epoch bigint, p_request_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_actor_mutation_lease_acquire(p_authority_hash text, p_actor_epoch bigint, p_request_id uuid, p_lease_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_actor_mutation_lease_release(p_authority_hash text, p_request_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_actor_mutation_lease_validate(p_authority_hash text, p_actor_epoch bigint, p_request_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_adopted_session_snapshot(p_auth_session_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_expired_session_set_reap(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_isolated_session_reap(p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_login_transaction_rate_limit_take(p_client_scope_hash text, p_set_scope_hash text) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_exact_binding_stamp() FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_authority_state(p_authority_hash text) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_begin_transaction(p_authority_hash text, p_csrf_hash text, p_rate_scope_hash text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_transaction_id uuid, p_expected_actor_epoch bigint, p_transaction_secret_hash text, p_kind text, p_target_slot_id uuid, p_return_intent_id uuid, p_return_path text, p_expires_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_bootstrap(p_authority_hash text, p_csrf_hash text, p_auth_session_id text, p_mode text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_complete_transaction(p_authority_hash text, p_csrf_hash text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint, p_transaction_id uuid, p_transaction_secret_hash text, p_auth_session_id text, p_mode text) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_mutate(p_authority_hash text, p_csrf_hash text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint, p_operation_type text, p_target_slot_id uuid, p_replacement_slot_id uuid, p_transaction_id uuid, p_transaction_secret_hash text, p_mode text) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_operation_receipt(p_authority_hash text, p_operation_id uuid, p_request_digest text, p_operation_kind text) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_operations_append_only() FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_set_snapshot(p_authority_hash text, p_mode text, p_include_internal boolean, p_allow_recovery boolean, p_read_only boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_auth_session_slot_invalidation() FROM PUBLIC;

REVOKE ALL ON FUNCTION managed_sign_in_method_authority(p_user text, p_session text, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION materialize_remember_knowledge_memory(p_account_id uuid, p_workspace_id uuid, p_confirmation_receipt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION materialize_scheduled_task_reusable_session_from_run(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_run_id uuid, p_session_id uuid, p_source_revision bigint, p_source_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION materialize_scheduled_task_reusable_session_from_run_0252(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_run_id uuid, p_session_id uuid, p_source_task_authority_revision bigint, p_source_execution_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION materialize_scoped_rig_version_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_variable_set_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_session(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_variable_set_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION mcp_operation_command(p_scope jsonb, p_action text, p_payload jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION meter_session_usage_limit_event() FROM PUBLIC;

REVOKE ALL ON FUNCTION modal_native_origin_member_read_active(p_account uuid, p_subject text) FROM PUBLIC;

REVOKE ALL ON FUNCTION model_fact_reconciliation_enqueue() FROM PUBLIC;

REVOKE ALL ON FUNCTION move_vault_item(p_item uuid, p_target_vault uuid, p_mode text, p_new_name text, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION mutate_managed_sign_in_method(p_user text, p_session text, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION mutate_scoped_rig(p_account_id uuid, p_workspace_id uuid, p_rig_id uuid, p_operation text, p_name text, p_name_present boolean, p_description text, p_description_present boolean, p_allow_organization boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION mutate_scoped_variable_set(p_account_id uuid, p_workspace_id uuid, p_variable_set_id uuid, p_operation text, p_name text, p_name_present boolean, p_description text, p_description_present boolean, p_variable_name text, p_value_encrypted text, p_allow_organization boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION mutate_self_personal_github_repository_selection(p_account_id uuid, p_origin_workspace_id uuid, p_owner_subject_id text, p_connection_id uuid, p_expected_connection_authority_generation bigint, p_expected_selection_generation bigint, p_idempotency_key text, p_repositories jsonb, p_verify_only boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION normalize_legacy_session_event_sequence_from_cursor() FROM PUBLIC;

REVOKE ALL ON FUNCTION normalize_session_variable_set_selection() FROM PUBLIC;

REVOKE ALL ON FUNCTION notify_session_list_change() FROM PUBLIC;

REVOKE ALL ON FUNCTION open_organization_shared_workspace_administration_capability(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION open_private_child_session_create_capability(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_parent_session_id uuid, p_actor_turn_id uuid, p_actor_attempt_id uuid, p_actor_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION open_private_session_create_capability(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION open_tenancy_backfill_receipt(p_account_id uuid, p_resource_family text, p_run_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_membership_command(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_membership_command_0263(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_plan_seats_used(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_private_sessions_enabled(p_account_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_append_only() FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_assert_recent_reauth(p_fence jsonb, p_actor_subject text, p_auth_session_id text, p_auth_user_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_command(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_exactly_three_custodians() FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_lock_policy_evidence(p_policy_id uuid, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_overview_json(p_account_id uuid, p_actor_subject text, p_recent_reauthentication_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_resolve_recent_reauth(p_fence jsonb, p_actor_subject text, p_auth_session_id text, p_auth_user_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_valid_acceptance_id(p_policy_id uuid, p_identity_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_valid_approval_count(p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_recovery_valid_approvals_json(p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_workspace_command(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION organization_workspace_command_without_creator_access(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION personal_machine_grant_covers_descendant(p_grant_id uuid, p_session_id uuid, p_turn_id uuid, p_enrollment_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION personal_machine_turn_consent_covers_descendant(p_consent_id uuid, p_session_id uuid, p_turn_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_accepted_snapshot_for_recovery(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_execution_generation integer, p_initiating_human_subject_id text, p_accepted_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_activation_authority(p_workspace_id uuid, p_revision_ids uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_apply_lifecycle(p_operation text, p_preference_id uuid, p_expected_scope_version integer, p_expected_revision_id uuid, p_revision_id uuid, p_new_scope text, p_related_preference_id uuid, p_actor_subject_id text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_canonical_snapshot_at(p_account_id uuid, p_workspace_id uuid, p_initiating_human_subject_id text, p_accepted_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_create_knowledge_proposal_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_input_hash text, p_knowledge_proposal_id uuid, p_stable_key text, p_title text, p_description text, p_content text, p_precedence_rank integer, p_conflict_strategy text, p_conflicts_with jsonb, p_expires_at timestamp with time zone, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION preference_registry_lock_heads(p_preference_ids uuid[]) FROM PUBLIC;

REVOKE ALL ON FUNCTION preflight_organization_user_setup(p_token_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_external_workspace_membership_operation(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_organization_membership_protocol_settlements(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_organization_recovery_notifications(p_provider text, p_claim_owner text, p_limit integer, p_lease_seconds integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_organization_user_setup_delivery(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_organization_user_setup_delivery_v2(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_organization_workspace_member_removal(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_scheduled_task_attempt_once_grants() FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_session_attempt_personal_document_reads(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_attempt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION prepare_workspace_membership_removal_settlements(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION prevent_claude_snapshot_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION prevent_session_event_projection_regression() FROM PUBLIC;

REVOKE ALL ON FUNCTION prevent_subscription_authority_v2_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION preview_connected_machine_audience_change(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION preview_organization_retention_deletions(p_account_id uuid, p_limit integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION preview_organization_user_setup(p_token_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION private_session_cancels_foreign_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION propose_company_profile_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_content_json text, p_content_hash text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION propose_company_profile_for_attempt_v2(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_automatic_activation_operation_id uuid, p_content_json text, p_content_hash text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION provider_connection_home_workspace(p_connection uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION provider_vault_item_ref(p_vault uuid, p_item uuid, p_provider_item_ref text, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION provider_vault_sync_target(p_vault uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION read_organization_plan_balance(p_account_id uuid, p_as_of timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION read_scoped_variable_set_secret(p_account_id uuid, p_workspace_id uuid, p_variable_set_id uuid, p_variable_set_name text, p_variable_name text, p_actor_kind text, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION read_vault_field_ciphertext(p_field uuid, p_version integer, p_purpose text, p_principal jsonb, p_metadata jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION reclassify_document_authority(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION reconcile_organization_recovery_notification(p_outbox_id uuid, p_delivery_id uuid, p_reconciliation_owner text, p_resolution text, p_provider_message_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION record_external_workspace_membership_operation(p_command jsonb, p_result jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION record_organization_retention_object_deleted(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_kind text, p_source_id text, p_object_bucket text, p_object_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION record_organization_workspace_member_removal(p_command jsonb, p_workspace_membership_id uuid, p_actor_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION record_scheduled_task_revision_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION record_tenancy_backfill_unresolved(p_receipt_id uuid, p_resource_id uuid, p_reason_code text) FROM PUBLIC;

REVOKE ALL ON FUNCTION record_vault_secret_use(p_principal jsonb, p_use jsonb, p_items jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION refuse_imported_archive_execution() FROM PUBLIC;

REVOKE ALL ON FUNCTION reject_legacy_claude_subscription_credentials() FROM PUBLIC;

REVOKE ALL ON FUNCTION reject_managed_auth_new_signups_switch_revision_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION reject_task_note_replacement_receipt_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION reject_turn_personal_resource_snapshot_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION reject_verified_signup_trial_switch_revision_mutation() FROM PUBLIC;

REVOKE ALL ON FUNCTION reject_workspace_account_id_change() FROM PUBLIC;

REVOKE ALL ON FUNCTION release_session_work_claim_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_claim_id uuid, p_expected_revision integer, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION release_vault_passkey_leases(p_holder text, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION replace_plan_credit_period(p_account_id uuid, p_plan_key text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_stripe_subscription_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION replace_task_note_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_archive_operation_id uuid, p_create_operation_id uuid, p_replaced_note_id uuid, p_expected_replaced_version integer, p_replacement_kind text, p_replacement_text text, p_replacement_expires_in_days integer, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION replay_applied_session_fork(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION replay_applied_session_fork_with_runtime(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_configuration_digest text) FROM PUBLIC;

REVOKE ALL ON FUNCTION replay_managed_sign_in_method(p_user text, p_session text, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_accepted_connection_use(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_physical_request_id uuid, p_use_phase text, p_server_id text, p_connection_id uuid, p_provider_domain text, p_connection_kind text, p_subject_scope text, p_owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_connection_use_authority_legacy_0256(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_snapshot jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_document_original_file(p_account_id uuid, p_request_workspace_id uuid, p_actor_id text, p_document_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_organization_workspace_removal_subject(p_account_id uuid, p_actor_subject_id text, p_target_organization_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_secret_reference_candidates(p_principal jsonb, p_refs jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_session_attempt_personal_document_reads(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_attempt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_session_attempt_personal_resources(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_session_attempt_personal_resources_legacy_0305(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_session_work_claim_attempt_authority(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_task_note_attempt_authority(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_task_note_knowledge_promotion_source(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_note_id uuid, p_expected_note_version integer, p_evidence_operation_id text, p_claim_operation_id text, p_actor_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_turn_context_attempt_authority(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_workspace_codex_subscription_source(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION resolve_workspace_writer_grant_identity(p_account_id uuid, p_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION restore_vault_item(p_item uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION retire_terminal_turn_run_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION reverse_video_allowance_refund() FROM PUBLIC;

REVOKE ALL ON FUNCTION revoke_self_user_resource_grant(p_account_id uuid, p_grant_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION revoke_self_user_resource_grant(p_account_id uuid, p_workspace_id uuid, p_grant_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION run_document_default_collection_backfill(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION sandbox_warm_attribution_immutable() FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_scoped_rig_version_metadata(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_rig_id uuid, p_version_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION xai_provider_account_authority_snapshot_v1_valid(snapshot jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_execution_digest(p_task scheduled_tasks) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_execution_state(p_task scheduled_tasks) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_is_exhausted(p_task_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_personal_resource_authority_subject(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_revision_authority_snapshot(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_revision_authority_subject(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_run_connection_authority_subject(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_task_run_personal_resource_authority(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scheduled_variable_set_expected_generation_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_variable_set_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_compute_actor_membership(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_advance_object_version(p_account_id uuid, p_object_id uuid, p_expected_lifecycle_generation bigint, p_expected_version_generation bigint, p_version_id uuid, p_operation_id text, p_input_hash text, p_reason_code text, p_actor_kind text, p_actor_subject_id text, p_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_advance_source_acl(p_account_id uuid, p_source_id uuid, p_expected_lifecycle_generation bigint, p_expected_acl_generation bigint, p_acl_version_id uuid, p_operation_id text, p_input_hash text, p_reason_code text, p_actor_kind text, p_actor_subject_id text, p_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_apply_lifecycle(p_account_id uuid, p_target_kind text, p_target_id uuid, p_event_type text, p_expected_generation bigint, p_operation_id text, p_input_hash text, p_reason_code text, p_actor_kind text, p_actor_subject_id text, p_initiating_human_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_complete_sync(p_account_id uuid, p_run_id uuid, p_state text, p_output_cursor text, p_watermark timestamp with time zone, p_metadata jsonb, p_error_code text, p_completion_hash text, p_reason_code text) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_guard_acl_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_guard_sync_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_knowledge_guard_version_insert() FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_rig_json(p_rig_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_variable_set_actor_membership(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION scoped_variable_set_json(p_variable_set_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION seed_session_usage_limit_root() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_attempt_interruption_fill_quiescence_hint() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_events_fill_tool_identity() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_events_fill_usage_source_key() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_foreign_subscription_binding_count(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_private_actor_visible(p_account_id uuid, p_workspace_id uuid, p_owner_organization_membership_id uuid, p_owner_subject_id text) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_private_actor_visible_keys() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_private_transition_blocker(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_reference_visible(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_secrets_view(p_session uuid, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_system_update_carries_foreign_authority(p_update session_system_updates, p_owner_subject_id text, p_owner_membership_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_tenancy_any_product_activation() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_tenancy_fence_target_schema() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_tenancy_product_activated(p_account_id uuid, p_activation_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_tenancy_standing_blocker(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_turn_attempt_propagate_quiescence_hint() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_apply_receipt(p_account uuid, p_workspace uuid, p_root uuid, p_source_id text, p_source_session uuid, p_turn uuid, p_amount bigint, p_pricing_source text, p_model text, p_origin text) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_command(p_input jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_event_amount(p_payload jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_import_page(p_account uuid, p_workspace uuid, p_root uuid, p_budget integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_import_step(p_account uuid, p_workspace uuid, p_root uuid, p_budget integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_meter_amount(p_amount numeric, p_pricing text, p_input numeric, p_output numeric) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_usage_limit_state(p_root_json jsonb, p_inherited boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_visibility_change_blocker(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_visibility_foreign_authority_items(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION session_visibility_lifecycle_capability_held() FROM PUBLIC;

REVOKE ALL ON FUNCTION session_work_claim_subject_digest(p_namespace text, p_type text, p_canonical_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION set_credit_promotion_policy(p_policy jsonb, p_operator text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION set_managed_auth_new_signups_enabled(p_enabled boolean, p_operator text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION set_scheduled_task_execution_digest() FROM PUBLIC;

REVOKE ALL ON FUNCTION set_session_vault_policy(p_session uuid, p_policy jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION set_subscription_plan_catalog(p_catalog jsonb, p_operator text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION set_vault_sync_status(p_vault uuid, p jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION set_verified_signup_trial_credits_enabled(p_enabled boolean, p_operator text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_active_session_work_claims(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_state text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_managed_sign_in_notification(p_operation uuid, p_lease uuid, p_status text) FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_organization_recovery_notification(p_outbox_id uuid, p_delivery_id uuid, p_claim_owner text, p_phase text, p_provider_message_id text, p_error_class text) FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_organization_user_setup_delivery(p_command jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_scheduled_run_from_terminal_turn() FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_scheduled_run_from_terminal_update() FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_session_work_claims_on_goal_completion() FROM PUBLIC;

REVOKE ALL ON FUNCTION settle_session_work_claims_on_session_terminal() FROM PUBLIC;

REVOKE ALL ON FUNCTION skill_apply_lifecycle(p_account_id uuid, p_workspace_id uuid, p_actor jsonb, p_request jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION skill_publish_finalized_owner() FROM PUBLIC;

REVOKE ALL ON FUNCTION skill_source_has_effective_owner(p_account_id uuid, p_workspace_id uuid, p_facet_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION slack_task_policy_hash(policy jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION slack_task_policy_update(p_operation_id uuid, p_request_fingerprint text, p_account_id uuid, p_workspace_id uuid, p_policy jsonb, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_actor_subject_id text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION slack_task_policy_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION stamp_model_call_site() FROM PUBLIC;

REVOKE ALL ON FUNCTION stamp_model_debit_site() FROM PUBLIC;

REVOKE ALL ON FUNCTION stamp_session_activity_xid() FROM PUBLIC;

REVOKE ALL ON FUNCTION stamp_turn_personal_resource_snapshot_digest() FROM PUBLIC;

REVOKE ALL ON FUNCTION subscription_effective_settings(p_account_id uuid, p_workspace_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION sync_organization_user_setup_delivery_revocation() FROM PUBLIC;

REVOKE ALL ON FUNCTION sync_personal_enrollment_authority() FROM PUBLIC;

REVOKE ALL ON FUNCTION sync_session_variable_set_attachment_status() FROM PUBLIC;

REVOKE ALL ON FUNCTION sync_session_variable_set_attachments() FROM PUBLIC;

REVOKE ALL ON FUNCTION transition_scheduled_agent_run(p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid, p_trigger_event_id uuid, p_status text, p_error text) FROM PUBLIC;

REVOKE ALL ON FUNCTION transition_session_visibility(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_actor_subject_id text, p_target_visibility text, p_expected_authority_epoch integer, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION undo_governed_learning_activation(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_activation_receipt_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION update_company_profile_agent_policy(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_mode text, p_expected_version bigint, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION update_organization_name(p_account_id uuid, p_actor_subject_id text, p_name text, p_expected_updated_at timestamp with time zone, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION update_organization_private_session_settings(p_account_id uuid, p_actor_subject_id text, p_enabled boolean, p_expected_version bigint, p_operation_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION update_passkey_sign_count(p_item uuid, p_count bigint, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION update_vault(p_id uuid, p_expected_generation bigint, p jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION upsert_organization_plan(p_account_id uuid, p_plan_key text, p_status text, p_stripe_subscription_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_cancel_at_period_end boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION upsert_organization_shared_workspace_member(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_target_membership_id uuid, p_subject_label text, p_role text, p_permissions jsonb, p_require_existing boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION upsert_provider_vault_items(p_vault uuid, p_content_version text, p_items jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION upsert_session_work_claim_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_expected_revision integer, p_subject_namespace text, p_subject_type text, p_canonical_key text, p_display_label text, p_role text, p_version_kind text, p_version_value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION upsert_vault_item(p jsonb, p_principal jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION usage_allowance_command(p_input jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION usage_allowance_effective_period(p_workspace uuid, p_config jsonb, p_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION usage_allowance_members(p_account uuid, p_workspace uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION usage_allowance_period(p_config jsonb, p_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_canonical_human_session(p_auth_session_id text, p_auth_user_id text, p_allow_recovery boolean) FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_scheduled_agent_run_live_authority(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_scheduled_occurrence_accepted_execution() FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_scheduled_task_attempt_personal_resources() FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_task_note_knowledge_evidence() FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_usage_allowance_config(p_config jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION validate_usage_allowance_rule(p_rule jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION vault_actor_membership(p_account uuid, p_subject text) FROM PUBLIC;

REVOKE ALL ON FUNCTION verify_organization_resource_classification(p_organization_id uuid, p_run_key text) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_instruction_policy_canonical_snapshot_entries(p_account_id uuid, p_workspace_id uuid, p_policy_role text, p_accepted_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_instruction_policy_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_instruction_policy_normalize_role_key(value text) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_learning_policy_apply_activation(p_operation_id uuid, p_request_fingerprint text, p_account_id uuid, p_workspace_id uuid, p_target_revision_id uuid, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_type text, p_actor_subject_id text, p_reason text) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_learning_policy_canonical_at(p_account_id uuid, p_workspace_id uuid, p_accepted_at timestamp with time zone) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_learning_policy_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_learning_policy_hash(p_workspace_mode text, p_source_overrides jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_learning_policy_snapshot_hash(p_revision_id uuid, p_revision bigint, p_policy_hash text, p_activation_version bigint, p_activated_at timestamp with time zone, p_workspace_mode text, p_source_overrides jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_learning_policy_source_overrides_valid(value jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION workspace_membership_removal_command(p_command jsonb) FROM PUBLIC;

GRANT SELECT ON TABLE teams_bot_routes TO pg_write_all_data;

GRANT UPDATE(relevant_event_sequence) ON TABLE teams_bot_routes TO pg_write_all_data;

-- Application-role privileges. opengeni_app receives them when it exists; each
-- configured application role (opengeni.migration_application_roles) receives
-- the subset later migrations granted to every configured role.
DO $application_role_grants$
DECLARE
  application_role text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO opengeni_app';
    EXECUTE $grant$GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT USAGE ON SCHEMA {{schema}} TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.model_context_contributions_valid(value jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE model_call_facts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.abandon_session_content_archive(p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.accept_session_file_attachments(p_account uuid, p_workspace uuid, p_session uuid, p_turn uuid, p_subject text, p_files uuid[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.account_rls_visible(account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.advance_editable_artifact_authorization_revision(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_expected_revision bigint, p_next_revision bigint, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.advance_editable_artifact_scope_authorization_revision(p_account_id uuid, p_workspace_id uuid, p_expected_revision bigint, p_next_revision bigint, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.append_subscription_usage_reading(p_account uuid, p_connection uuid, p_provider text, p_reading jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.apply_document_authority() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.apply_document_chunk_authority() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.archived_session_event_types() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.assign_managed_self_organization_owner() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.authorize_editable_artifact_actor(p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_actor_kind text, p_actor_subject_id text, p_agent_session_id text, p_agent_turn_id text, p_agent_attempt_id text, p_agent_generation integer, p_service_name text, p_permission text, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.authorize_subscription_ownerless_session_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.authorize_subscription_personal_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_provider text, p_session_owner_subject_id text, p_turn_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.authorize_subscription_personal_placement_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_provider text, p_owner_membership_id uuid, p_authority_generation bigint, p_session_owner_subject_id text, p_turn_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.authorize_subscription_service_session_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.authorize_subscription_session_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.backfill_product_lifecycle_facts(p_source text, p_batch_size integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.begin_subscription_codex_apps_refresh(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.begin_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.begin_subscription_core_owned_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.begin_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text, p_connection_id uuid, p_holder_id text, p_lease_generation bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.bind_connection_owner_authority(p_account_id uuid, p_subject_id text, p_connection_id uuid, p_workspace_id uuid, OUT membership_id uuid, OUT authority_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.bound_workspace_control_event() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.browser_deadline_checkpoint(p_target jsonb, p_prepare boolean, p_touch boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.browser_deadline_checkpoint_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.capture_host_export_root_session() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_browser_state_artifact_cleanup(p_claim_timeout_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_browser_state_upload_cleanup(p_claim_timeout_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_connected_command_output_releases(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_due_before timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_connected_machine_background_commands(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_connected_machine_background_commands(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_due_before timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_due_transcription_recording_object_cleanup(p_grace_ms bigint, p_claim_timeout_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_expired_file_upload_cleanup(p_grace_ms bigint, p_claim_timeout_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE memory_slack_publications TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_memory_slack_publication(p_holder uuid, p_lease_ms integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_native_push_deliveries_v1(p_claim_id uuid, p_limit integer, p_claim_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_organization_webhook_deliveries_v1(p_claim_id uuid, p_limit integer, p_claim_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_retained_screenshot_maintenance(p_pending_grace_ms bigint, p_claim_timeout_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_sandbox_checkpoint_artifacts(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_session_archive_object_deletions(p_claim_timeout_seconds integer, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_session_title_workflows(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_site_auth_maintenance(p_claim_timeout_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_app_home_refreshes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_slack_app_home_refresh(p_holder uuid, p_lease_ms integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_interactions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_slack_interaction_delivery(p_holder uuid, p_lease_ms integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_interaction_inbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_slack_interaction_inbox(p_holder uuid, p_lease_ms integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_temporal_schedule_cleanups(p_claim_id uuid, p_limit integer, p_claim_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_reconciler_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_video_generation_operations(p_owner text, p_lease_seconds integer, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.claim_workspace_webhook_deliveries_v1(p_claim_id uuid, p_limit integer, p_claim_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.classify_connected_command_ops(p_control_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text, p_op_ids text[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.cleanup_expired_editable_artifact_live_tickets(p_limit integer, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.clear_subscription_settings_locked_overrides() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.close_inbox_items_v1(p_session_id uuid, p_kinds text[], p_source_key text, p_status text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.codex_credential_serves_turn(p_account_id uuid, p_workspace_id uuid, p_credential_id uuid, p_turn_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.codex_organization_admin_visible(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.codex_organization_live_lease_count(p_account_id uuid, p_credential_id uuid, p_exclude_turn_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.codex_organization_scope_visible(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.compact_session_content_row(p_kind text, p_workspace_id uuid, p_attempt_id uuid, p_stored jsonb, p_refs jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.complete_session_archive_object_deletion(p_object_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.complete_temporal_schedule_connector_cleanup(p_id uuid, p_claim_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.complete_workspace_temporal_connector_cleanups(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.connect_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_credential_encrypted text, p_provider_account_id text, p_provider_subject_id text, p_plan_type text, p_provider_state jsonb, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_account_email text, p_label text, p_connected_by_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.connect_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_credential_encrypted text, p_provider_account_id text, p_provider_subject_id text, p_plan_type text, p_provider_state jsonb, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_account_email text, p_label text, p_connected_by_subject_id text, p_credential_format text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.connected_command_output_release_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.connected_command_reconciliation_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.connection_account_intent_is_valid(intent jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.connection_tenancy_backfill_capability_active(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.consume_editable_artifact_live_ticket(p_token_digest text, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.context_compaction_pending_summary() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.continue_session_waiting_work_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.copy_subscription_authority_compat(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.count_active_retained_processes_by_owner_state() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.count_active_users() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.count_expired_draining_sandbox_leases() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.count_queued_turns() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.count_sandbox_leases_by_liveness() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.count_session_recovery_backlog() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.credit_balance_by_account() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.credit_grant_class(p_type text, p_source_type text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.credit_grant_totals() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_account_id() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_api_key_hash() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_memory_actor_id() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_memory_actor_kind() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_memory_role_key() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_memory_session_id() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_subject_id() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.current_workspace_id() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.defer_workspace_cascade_foreign_keys() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.disconnect_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.dismiss_inbox_notification_v1(p_item_id uuid, p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.document_migration_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_actor_key_matches(value text, actor_kind text, actor_subject_id text, agent_session_id text, agent_turn_id text, agent_attempt_id text, agent_generation integer, service_name text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_frontier_dominates(candidate jsonb, required jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_frontier_merge_dot_equals(result_frontier jsonb, left_frontier jsonb, right_frontier jsonb, dot_replica_id text, dot_counter bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_frontier_valid(value jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_id_array_valid(value jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_identity_valid(value text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_object_has_exact_keys(value jsonb, expected text[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_operation_id_list_valid(value jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_scope_matches_context(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_text_sha256(value text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enforce_codex_credential_workspace() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enforce_organization_plan_seats() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enforce_sandbox_checkpoint_artifact_immutability() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enforce_session_inference_claim() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_host_session_event_export() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_host_usage_event_export() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_native_push_v1(p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text, p_event_type text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_native_push_v2(p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text, p_event_type text, p_extra jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_native_push_v3(p_session_id uuid, p_rule text, p_dedupe_key text, p_title text, p_body text, p_event_type text, p_extra jsonb, p_recipient text, p_link_session boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.ensure_editable_artifact_scope_authorization_head(p_account_id uuid, p_workspace_id uuid, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.expire_refunded_plan_credit() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.fail_subscription_codex_apps_refresh(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.fail_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.fail_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_last_error text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.fence_legacy_lossless_content_update() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.file_private_to_another(p_account uuid, p_workspace uuid, p_file uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.fold_session_event_delta_run(p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_first integer, p_last integer, p_ids uuid[], p_payload jsonb, p_payload_codec_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.google_drive_object_acl_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_editable_artifact_mutable_state() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_editable_artifact_transaction_child_insert() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_editable_artifact_update() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_binding_provider() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_connection_reference() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_connection_scope() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_operation_lease_reference() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_provider_connection_kind() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_provider_registry() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_settings_identity() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_settings_locked_overrides() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_turn_session_reference() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.host_export_session_root(p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.immutable_memory_lifecycle_event() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.inbox_item_v1(p_item_id uuid, p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.inbox_settings_v1(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.inbox_settings_v2(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.inbox_settings_v3(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.inbox_settings_v4(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.inspect_slack_installation_binding(p_team_id text, p_bot_id text, p_bot_user_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.integration_webhook_payload_v1(p_account uuid, p_workspace uuid, p_event uuid, p_type text, p_session uuid, p_turn uuid, p_sequence bigint, p_occurred timestamp with time zone, p_payload jsonb, p_lane text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.invalidate_stale_verified_install() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.knowledge_memory_relationship_guard() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.knowledge_memory_row_guard() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.lifecycle_backfill_read_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_artifact_pins(p_account uuid, p_workspace uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_browser_deadline_checkpoints(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_command_containment_candidates(p_limit integer, p_idle_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_continuable_sessions(p_workspace_id uuid, p_root_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_due_event_source_feeds_v1(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_due_recording_retention_v1(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_due_workspace_pause_timers(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_exhausted_scheduled_tasks(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_idle_checkpoint_candidates(p_limit integer, p_interval_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_idle_interaction_leases(p_limit integer, p_idle_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_inbox_items_v1(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_inbox_items_v2(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_inbox_items_v3(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_legacy_modal_checkpoint_slots(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_live_modal_sandbox_leases() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_meterable_warm_leases() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_organization_slack_bots(p_account uuid, p_target uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_orphaned_idle_browser_checkpoints(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_pending_child_terminal_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_pending_modal_provider_creates() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_quiescence_receipt_wake_repairs_v1(p_limit integer, p_after_workspace_id uuid, p_after_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_blockers(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_sandbox_ended_epoch_setup_uncertainties(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_sandbox_file_publications(p_account uuid, p_workspace uuid, p_query jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_sandbox_file_publications_pinned(p_account uuid, p_workspace uuid, p_query jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_sandbox_viewer_force_drain_workspaces() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_scheduled_task_blocker_reviews(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_scheduled_task_schedule_reconciliations(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(after_enrollment uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_stalled_recording_work_v1(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_subscription_plan_maintenance_accounts(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.list_unobservable_command_drain_candidates(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.locate_connected_command_completion(p_control_workspace_id uuid, p_enrollment_id uuid, p_connection_instance_id text, p_op_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.lock_nested_agent_workspace_policy_update() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.maintenance_claim_active(p_actor text, p_operation text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.maintenance_title_event_visible(p_actor text, p_event_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.make_room_for_retained_screenshot(p_account_id uuid, p_workspace_id uuid, p_needed_bytes bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.manage_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_action text, p_label text, p_enabled boolean, p_expected_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.mark_inbox_item_event_v1(p_session_id uuid, p_kind text, p_source_key text, p_sequence integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.mark_session_turn_deltas_folded(p_workspace_id uuid, p_turn_id uuid, p_folded_runs integer, p_removed_rows integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.member_notifications_allowed_v1(p_workspace_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.memory_labels_valid(value text[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.memory_scope_authorized(row_scope_type text, row_subject_id text, row_role_key text, row_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.memory_scope_visible(row_scope_type text, row_subject_id text, row_role_key text, row_session_id uuid, row_valid_from timestamp with time zone, row_valid_until timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.model_context_value_valid(value text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.native_push_device_v1(p_auth_session_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.observe_credit_grant() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.open_inbox_item_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_recipient text, p_kind text, p_source_key text, p_title text, p_body text, p_urgency text, p_choices jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.optional_workspace_rls_visible(account_id uuid, workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.organization_invitation_row_json(p_invitation organization_membership_invitations) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.organization_membership_row_json(p_membership organization_memberships) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.organization_model_provider_scope_visible(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.organization_subscription_model_scope_visible(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.organization_tenancy_inventory_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.organization_tenancy_parity_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.persist_subscription_codex_apps_refresh(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.persist_subscription_core_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.persist_subscription_core_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.persist_subscription_core_refresh_with_plan(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_expected_refresh_generation bigint, p_credential_encrypted text, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_plan_type text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.personal_document_authority_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.personal_resource_delegation_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.plan_general_balance(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE plan_credit_periods TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.plan_period_usage(p_period plan_credit_periods, p_until timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.preference_registry_scope_visible(row_account_id uuid, row_scope text, row_workspace_id uuid, row_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prepare_organization_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_task uuid, p_connection uuid, p_version integer, p_home uuid, p_generation bigint, p_channel text, p_thread text, p_text text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prepare_scheduled_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_task uuid, p_connection uuid, p_connection_version integer, p_channel text, p_thread text, p_text text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prepare_workspace_background_command_deletion(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prevent_connector_action_request_identity_mutation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prevent_personal_connection_authority_mutation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prevent_scheduled_task_creator_mutation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prevent_session_creator_mutation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prevent_session_turn_initiator_mutation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.project_inbox_for_session_event_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.project_session_event_payload(source_payload jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_deleted_sandbox_checkpoint_artifacts(p_retention_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_event_intake_v1(p_body_seconds integer, p_event_seconds integer, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_native_push_deliveries_v1(p_retention_hours integer, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_organization_webhook_deliveries_v1(p_retention_seconds integer, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_settled_cross_workspace_background_commands(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_subscription_usage_history() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.prune_workspace_webhook_deliveries_v1(p_retention_seconds integer, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.purge_archived_session_content(p_workspace_id uuid, p_session_id uuid, p_table text, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.purge_expired_transcription_recordings(p_grace_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.put_editable_artifact_live_ticket(p_token_digest text, p_account_id uuid, p_workspace_id uuid, p_artifact_id text, p_modality text, p_actor_kind text, p_actor_subject_id text, p_replica_id text, p_agent_session_id text, p_agent_turn_id text, p_agent_attempt_id text, p_agent_generation integer, p_service_name text, p_allow_edit boolean, p_protocol_version integer, p_issued_at timestamp with time zone, p_expires_at timestamp with time zone, p_data_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.quarantine_subscription_core_connection(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_connection_id uuid, p_holder_id text, p_lease_generation bigint, p_expected_refresh_generation bigint, p_status text, p_last_error text, p_retry_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.queue_detached_retained_screenshot() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_archived_session_import_batch(p_account uuid, p_workspace uuid, p_session uuid, p_import text, p_subject text, p_batch text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_organization_slack_bot_access(p_account uuid, p_home uuid, p_connection uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_organization_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_scheduled_slack_bot_message(p_account uuid, p_workspace uuid, p_session uuid, p_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE connections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE files TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_session_file_attachments(p_account uuid, p_workspace uuid, p_session uuid, p_epoch integer, p_files uuid[], p_actor jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_slack_bot_workspace_access(p_account uuid, p_home uuid, p_connection uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_authority_compat(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_codex_apps_credential(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_core_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_operation_id uuid, p_attempt_id uuid, p_holder_id text, p_generation bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_core_owned_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_usage_history(p_account uuid, p_workspace uuid, p_subject text, p_provider text, p_connections uuid[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.reap_expired_session_list_snapshots(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.reap_sandbox_leases(p_viewer_holder_ttl_ms bigint, p_idle_grace_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.reap_sandbox_leases(p_viewer_holder_ttl_ms bigint, p_turn_holder_ttl_ms bigint, p_interaction_holder_ttl_ms bigint, p_idle_grace_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.reap_stale_interaction_transitions(p_interaction_holder_ttl_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.record_archived_session_import_batch(p_account uuid, p_workspace uuid, p_session uuid, p_import text, p_subject text, p_batch text, p_hash text, p_offset integer, p_count integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.record_organization_signup_use_case(p_account uuid, p_subject text, p_use_case text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.record_sandbox_file_publication(p_account uuid, p_workspace uuid, p_file uuid, p_session uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.record_subscription_core_owned_connection_quota(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_refresh_generation bigint, p_expected_revision bigint, p_quota jsonb, p_observed_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.record_user_activity_presence(p_subject_ids text[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.recover_subscription_core_connection_health(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.register_native_push_device_v1(p_auth_session_id text, p_platform text, p_app_id text, p_environment text, p_token text, p_rules text[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.reject_editable_artifact_history_mutation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.request_due_sandbox_rotations(p_lead_ms bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.reset_subscription_binding_cache_clock() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_device_enrollment_request(p_device_code text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_document_index_authority(p_account_id uuid, p_workspace_id uuid, p_document_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_editable_artifact_data_schema(requested_schema name) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_integration_initiating_human_v1(p_account uuid, p_workspace uuid, p_subject text, p_turn uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_credential_providers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_organization_credential_provider_v1(p_account uuid, p_workspace uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_pending_device_enrollment_by_user_code(p_user_code text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(p_connection_id uuid, p_handle_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_slack_action_handle_tenancy(p_account_id uuid, p_connection_id uuid, p_handle_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_slack_installation(p_team_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(p_connection_id uuid, p_route_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(p_account_id uuid, p_connection_id uuid, p_route_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resolve_subscription_codex_apps_designation(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.resource_classification_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_checkpoint_artifact_gc_due_v1(p_claim_ttl_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_checkpoint_artifact_inventory() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_checkpoint_staleness() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_ended_epoch_blockers_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_idle_checkpoint_due_v1(p_interval_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_lease_reaper_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_rotation_backlog() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_rotation_interaction_blocked() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scheduled_personal_resource_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scoped_compute_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scoped_knowledge_actor_authorized(row_actor_kind text, row_actor_subject_id text, row_initiating_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scoped_knowledge_actor_valid(row_actor_kind text, row_actor_subject_id text, row_initiating_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scoped_knowledge_scope_key(row_scope text, row_workspace_id uuid, row_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scoped_knowledge_scope_valid(row_scope text, row_workspace_id uuid, row_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.scoped_knowledge_scope_visible(row_account_id uuid, row_scope text, row_workspace_id uuid, row_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_archive_candidates(p_idle_seconds bigint, p_limit integer, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_archive_preference_snapshot_rows(p_workspace_id uuid, p_session_id uuid, p_after_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_archive_unfinished(p_stale_seconds bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_content_compaction_candidates(p_kind text, p_after_attempt_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_create_idempotency_guard_insert() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_delta_fold_candidates(p_settle_seconds bigint, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_depth_policy_defaults() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_depth_snapshot_immutable() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_file_read_allowed(p_account uuid, p_workspace uuid, p_file uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_hands_back_v1(p_session_id uuid, p_turn_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_list_snapshots_expired_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_ownership_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_replies_muted_for_v1(p_session_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_spawn_denials_append_only() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_tenancy_account_activated(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_work_claim_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.session_workflow_wakes_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_inbox_settings_v1(p_account_id uuid, p_subject_id text, p_tidy_policy text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_inbox_settings_v2(p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_inbox_settings_v3(p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean, p_replies boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_inbox_settings_v4(p_account_id uuid, p_subject_id text, p_tidy_policy text, p_paused_goals boolean, p_replies boolean, p_time_sensitive_needs_you boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_member_notifications_allowed_v1(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_allowed boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_organization_slack_bot_access(p_account uuid, p_home uuid, p_connection uuid, p_subject text, p_enabled boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_session_replies_muted_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_subject_id text, p_muted boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_slack_bot_workspace_access(p_account uuid, p_home uuid, p_connection uuid, p_subject text, p_enabled boolean, p_workspaces uuid[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_subscription_core_reach(p_provider text, p_account_id uuid, p_connection_id uuid, p_shared boolean, p_personal boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.set_subscription_core_reach_allocator(p_provider text, p_account_id uuid, p_connection_id uuid, p_enabled boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.settle_native_push_delivery_v1(p_claim_id uuid, p_delivery_id uuid, p_outcome text, p_error text, p_retry_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.settle_organization_webhook_delivery_v1(p_delivery_id uuid, p_claim_id uuid, p_status integer, p_error text, p_max_attempts integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.settle_sandbox_checkpoint_artifact(p_id uuid, p_claim_id uuid, p_deleted boolean, p_error text, p_retry_after_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.settle_temporal_schedule_cleanup(p_id uuid, p_claim_id uuid, p_error text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.settle_workspace_webhook_delivery_v1(p_delivery_id uuid, p_claim_id uuid, p_status integer, p_error text, p_max_attempts integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.site_auth_maintenance_due_v1(p_claim_timeout_ms bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.slack_routing_capability_active() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.stamp_session_workflow_control_revision() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_apps_designation_allowed(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_apps_designation_manage_allowed(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_authority_carrier_inserted_now(p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_authority_compat_providers() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_connections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_codex_owner_capability_held(p_account_id uuid, p_kinds text[], p_subject_id text, p_connection_id uuid, p_any_connection boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_codex_owner_membership_held(p_account_id uuid, p_membership_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_codex_refresh_write_allowed(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_codex_reset_authority(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_codex_reset_credit_fence(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text, p_credit_id text, p_attempt_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_connection_visible(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_ownership text, p_scope_kind text, p_owner_membership_id uuid, p_owner_subject_id text, p_provider text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_acceptance_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_accepting_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_connection_kind(p_provider text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_failover_readiness(p_provider text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_owner_capability_held(p_provider text, p_account_id uuid, p_kinds text[], p_subject_id text, p_connection_id uuid, p_any_connection boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_owner_membership_held(p_account_id uuid, p_membership_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_personal_connection_versions(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_personal_connections(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_personal_sharing(p_provider text, p_account_id uuid, p_subject_id text, p_connection_id uuid, p_expected_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_reach(p_provider text, p_account_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_refresh_write_allowed(p_provider text, p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_revision_authority_v2(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_task_authority_v2(p_provider text, p_account_id uuid, p_workspace_id uuid, p_reusable_session_id uuid, p_accepting_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_organization_admin(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_own_person_membership_id(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_people_assignment_visible(p_account_id uuid, p_workspace_id uuid, p_membership_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_people_designation_visible(p_account_id uuid, p_workspace_id uuid, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_person_preference_owned(p_account_id uuid, p_membership_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_person_preference_visible(p_account_id uuid, p_membership_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_personal_connection_visible(p_account_id uuid, p_connection_id uuid, p_owner_membership_id uuid, p_session_owner_subject_id text, p_turn_human_subject_id text, p_provider text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_plan_definition(p_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_plan_free_anniversary(p_created_at timestamp with time zone, p_now timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_provider_cutover_committed(p_provider text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_setting_override_widened(p_new jsonb, p_old jsonb, p_keyed boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.subscription_usage_history_prune_due() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.summarize_session_recovery_backlog() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.terminal_retained_processes_due_v1() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.truncate_workspace_control_text(source_text text, max_bytes integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.unregister_native_push_device_v1(p_auth_session_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.update_artifact_pin(p_account uuid, p_workspace uuid, p_kind text, p_id text, p_pinned boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.update_inbox_item_attention_v1(p_item_id uuid, p_account_id uuid, p_subject_id text, p_seen boolean, p_set_snooze boolean, p_snoozed_until timestamp with time zone, p_dismiss boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.upgrade_temporal_schedule_connector_cleanup(p_account_id uuid, p_workspace_id uuid, p_temporal_schedule_id text, p_scheduled_task_id uuid, p_subject_id text, p_snapshot jsonb, p_claim_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_editable_artifact_projection() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_editable_artifact_transaction_commit() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_sandbox_checkpoint_artifact_refs() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_sandbox_checkpoint_refs() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_sandbox_pty_process_v2() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_sandbox_retained_process_v2() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_session_parent_turn() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.validate_usage_event_execution_context() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.variable_set_authority_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vaults TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.vault_authority_capability_active(p_capability_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vault_items TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.vault_policy_is_valid(p jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE usage_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.warming_reset_resume_state_v2(p_backend text, p_resume_backend_id text, p_resume_state jsonb, p_workspace_generation integer, p_archive_generation integer, p_reset_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.workspace_membership_administers(p_role text, p_permissions jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION opengeni_private.workspace_rls_visible(account_id uuid, workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION accept_organization_invitation_v2(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION accept_turn_personal_resource_attachment(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_mode text, p_expected_authority_epoch integer, p_workspace_shared_acknowledged boolean, p_shared_output_warning_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION apply_canonical_human_identity_operation(p_operation_id uuid, p_auth_user_id text, p_expected_identity_revision bigint, p_operation_type text, p_binding_id uuid, p_provider_id text, p_provider_account_id text, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION apply_secret_answers(p_session uuid, p_turn uuid, p_answers jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION archive_task_note_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_note_id uuid, p_expected_version integer, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION archive_vault_item(p_item uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION assert_active_managed_human_organization_membership(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION assert_organization_shared_workspace_administrator(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION assert_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid, p_require_active_sandbox boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION assert_workspace_member_management_candidate(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_target_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION authorize_organization_shared_workspace_administration(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION authorize_scoped_sandbox_attach(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION authorize_session_attempt_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_enrollment_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION authorize_session_attempt_personal_resource_reads(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION backfill_organization_connection_authority(p_account_id uuid, p_limit integer, p_dry_run boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION backfill_organization_session_ownership(p_organization_id uuid, p_limit integer, p_dry_run boolean, p_run_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION begin_billing_subscription_operation(p_account_id uuid, p_key uuid, p_kind text, p_request jsonb, p_intent jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION begin_plan_credit_settlement(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION bind_pending_organization_invitations_for_verified_email(p_subject_id text, p_email text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION bind_scheduled_task_run_session(p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION capture_legacy_codex_turn_sources(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION change_connected_machine_audience(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_expected_generation bigint, p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION check_organization_tenancy_parity(p_organization_id uuid, p_evidence_limit integer, p_observation_window_days integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION claim_organization_retention_deletion(p_account_id uuid, p_operation_id uuid, p_excluded_membership_ids uuid[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION claim_organization_user_setup_delivery(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION claim_organization_user_setup_delivery_v2(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION classify_organization_connection_authority(p_account_id uuid, p_run_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION classify_organization_session_ownership(p_organization_id uuid, p_run_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION clone_scheduled_task_personal_resource_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_source_revision bigint, p_target_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION clone_scheduled_task_revision_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_source_revision bigint, p_target_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION close_organization_shared_workspace_administration_capability(p_capability_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION close_private_session_create_capability(p_capability_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION company_brain_context_get_or_create_selection(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION company_brain_inspect_context_receipts(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_attempt_id uuid, p_before_created_at timestamp with time zone, p_before_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION company_profile_apply_activation(p_operation_id uuid, p_request_fingerprint text, p_account_id uuid, p_workspace_id uuid, p_target_revision_id uuid, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_type text, p_actor_subject_id text, p_principal_kind text, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE company_profile_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION company_profile_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION complete_billing_subscription_operation(p_account_id uuid, p_key uuid, p_result jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION complete_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION complete_organization_user_setup(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION complete_self_service_organization_setup(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION complete_tenancy_backfill_receipt(p_receipt_id uuid, p_classified_count bigint, p_skipped_count bigint, p_status text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION confirm_company_profile_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_proposal_receipt_id uuid, p_human_input_request_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION consent_session_turn_personal_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_enrollment_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION count_scoped_rigs(p_account_id uuid, p_workspace_id uuid, p_scope text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION count_scoped_variable_sets(p_account_id uuid, p_workspace_id uuid, p_scope text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_additional_managed_organization(p_subject_id text, p_subject_label text, p_organization_name text, p_workspace_name text, p_operation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_agent_child_session(p_account uuid, p_workspace uuid, p_parent uuid, p_turn uuid, p_attempt uuid, p_generation integer, p_values jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_managed_organization(p_subject_id text, p_subject_label text, p_name text, p_operation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_organization_invitation_v2(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_organization_shared_workspace(p_account_id uuid, p_actor_subject_id text, p_name text, p_slug text, p_agent_instructions text, p_operation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_personal_document_authority(p_account_id uuid, p_workspace_id uuid, p_document_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_scheduled_agent_run_with_admission(p_run_id uuid, p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint, p_task_execution_digest text, p_trigger_type text, p_producer_key text, p_scheduled_at timestamp with time zone, p_fired_at timestamp with time zone, p_accepted_execution_snapshot jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_scoped_rig(p_account_id uuid, p_workspace_id uuid, p_scope text, p_name text, p_description text, p_created_by text, p_initial_version jsonb, p_allow_organization boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_scoped_variable_set(p_account_id uuid, p_workspace_id uuid, p_scope text, p_name text, p_description text, p_variables jsonb, p_allow_organization boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_task_note_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_kind text, p_text text, p_expires_in_days integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION create_vault(p jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION delete_vault(p_id uuid, p_confirm_name text, p_allow_organization boolean, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION delete_vault_item_permanently(p_item uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION detach_scoped_machine_dependent_sessions(p_account_id uuid, p_origin_workspace_id uuid, p_sandbox_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE turn_personal_resource_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION ensure_canonical_human_identity(p_auth_user_id text, p_display_name text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION ensure_default_vault(p_workspace uuid, p_owner_kind text, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION ensure_managed_human_personal_workspace(p_account_id uuid, p_subject_id text, p_personal_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION ensure_organization_user_setup_intent(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION ensure_task_vault(p_workspace uuid, p_session uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION expire_ended_plan_credit_periods(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION expire_plan_credit_period(p_account_id uuid, p_period_id uuid, p_force boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION fail_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_reason_code text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION finalize_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION finalize_scoped_enrollment(p_account_id uuid, p_workspace_id uuid, p_scope text, p_pubkey text, p_has_display boolean, p_allow_screen_control boolean, p_os text, p_arch text, p_sandbox_name text, p_allow_organization boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_source_event_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION free_plan_credit_eligible(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION freeze_scheduled_task_personal_resources(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_canonical_human_exact_login_binding(p_auth_user_id text, p_provider_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_canonical_human_identity_projection(p_auth_user_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_document_default_collection_backfill_audit(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_organization_administration_overview(p_account_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_organization_invitation_for_administration(p_account_id uuid, p_actor_subject_id text, p_invitation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_organization_private_session_settings(p_account_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_organization_recovery_overview(p_account_id uuid, p_actor_subject text, p_fence jsonb, p_auth_session_id text, p_auth_user_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_organization_retention_policy(p_account_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_private_session_create_policy(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_scoped_sandbox(p_account_id uuid, p_workspace_id uuid, p_sandbox_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_self_organization_invitation(p_subject_id text, p_invitation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_self_personal_github_repository_selection(p_account_id uuid, p_origin_workspace_id uuid, p_owner_subject_id text, p_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_session_attempt_machine(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_sandbox_id uuid, p_enrollment_id uuid, p_require_active_sandbox boolean, p_metadata_only boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_session_machine_access(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_vault_for_subject(p_vault uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_vault_item(p_item uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION get_workspace_kind(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION google_drive_document_citation(p_account_id uuid, p_request_workspace_id uuid, p_subject_id text, p_document_id uuid, p_file_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION google_drive_file_authorized(p_account_id uuid, p_request_workspace_id uuid, p_subject_id text, p_file_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_instruction_policy_activation_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE knowledge_claim_review_revision_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_claim_reviews TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE preference_registry_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE workspace_instruction_policy_deactivation_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION grant_plan_credit_period(p_account_id uuid, p_plan_key text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_stripe_subscription_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION has_pending_organization_invitation_for_subject(p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION inspect_governed_learning_activation_undos(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION inspect_governed_learning_activations(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION inspect_governed_learning_decisions(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION inspect_organization_connection_authority_convergence(p_account_id uuid, p_limit integer, p_after_connection_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION inventory_organization_tenancy(p_organization_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION issue_self_user_resource_grant(p_account_id uuid, p_authority_id uuid, p_workspace_id uuid, p_resource_kind text, p_mode text, p_context text, p_session_id uuid, p_expected_authority_epoch integer, p_workspace_shared_acknowledged boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE workspace_instruction_policy_revision_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_instruction_policy_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION knowledge_source_sync_lock_authority(p_account_id uuid, p_source_id uuid, p_object_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION lease_vault_passkeys(p_principal jsonb, p_holder text, p_ttl_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION link_provider_vault(p jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_document_authority_reclassifications(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_document_id uuid, p_limit integer, p_before_created_at timestamp with time zone, p_before_operation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_document_default_collection_backfill_runs(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_administration_members(p_account_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_document_authority_reclassifications(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_invitations(p_account_id uuid, p_actor_subject_id text, p_cursor_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_members(p_account_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_membership_backfill_anchors(p_organization_id uuid, p_subject_ids text[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_memberships_without_personal_workspace(p_organization_id uuid, p_limit integer, p_after_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_retention_deletion_objects(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_subscription_workspace_ids(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_organization_workspace_ids(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_scoped_enrollments(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_status text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_scoped_machine_dependent_sessions(p_account_id uuid, p_origin_workspace_id uuid, p_sandbox_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_scoped_rigs(p_account_id uuid, p_workspace_id uuid, p_rig_id uuid, p_name text, p_scope text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_scoped_variable_sets(p_account_id uuid, p_workspace_id uuid, p_variable_set_id uuid, p_name text, p_scope text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_self_organization_invitations(p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_self_organization_invitations(p_subject_id text, p_cursor_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_self_organization_memberships(p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_self_user_resource_authorities(p_account_id uuid, p_workspace_id uuid, p_resource_kind text, p_after_authority_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_task_notes_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_include_archived boolean, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_vault_field_versions(p_field uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_vault_items(p_vault uuid, p_query text, p_type text, p_include_archived boolean, p_cursor text, p_limit integer, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_vaults_for_subject(p_workspace uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION list_workspace_member_management_candidates(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION lock_nested_agent_depth_configuration() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION maintain_session_usage_limits(p_limit integer, p_budget integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION maintain_usage_allowances(p_limit integer, p_member_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_actor_mutation_fence(p_authority_hash text, p_actor_epoch bigint, p_request_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_actor_mutation_lease_acquire(p_authority_hash text, p_actor_epoch bigint, p_request_id uuid, p_lease_seconds integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_actor_mutation_lease_release(p_authority_hash text, p_request_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_actor_mutation_lease_validate(p_authority_hash text, p_actor_epoch bigint, p_request_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_adopted_session_snapshot(p_auth_session_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_expired_session_set_reap(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_isolated_session_reap(p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_authority_state(p_authority_hash text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_begin_transaction(p_authority_hash text, p_csrf_hash text, p_rate_scope_hash text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_transaction_id uuid, p_expected_actor_epoch bigint, p_transaction_secret_hash text, p_kind text, p_target_slot_id uuid, p_return_intent_id uuid, p_return_path text, p_expires_at timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_bootstrap(p_authority_hash text, p_csrf_hash text, p_auth_session_id text, p_mode text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_complete_transaction(p_authority_hash text, p_csrf_hash text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint, p_transaction_id uuid, p_transaction_secret_hash text, p_auth_session_id text, p_mode text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_mutate(p_authority_hash text, p_csrf_hash text, p_operation_id uuid, p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint, p_operation_type text, p_target_slot_id uuid, p_replacement_slot_id uuid, p_transaction_id uuid, p_transaction_secret_hash text, p_mode text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_operation_receipt(p_authority_hash text, p_operation_id uuid, p_request_digest text, p_operation_kind text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION managed_auth_session_set_snapshot(p_authority_hash text, p_mode text, p_include_internal boolean, p_allow_recovery boolean, p_read_only boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION materialize_scheduled_task_reusable_session_from_run(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_run_id uuid, p_session_id uuid, p_source_revision bigint, p_source_digest text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION materialize_scoped_rig_version_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION materialize_scoped_variable_set_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_variable_set_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION materialize_scoped_variable_set_for_session(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_variable_set_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION move_vault_item(p_item uuid, p_target_vault uuid, p_mode text, p_new_name text, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION mutate_scoped_rig(p_account_id uuid, p_workspace_id uuid, p_rig_id uuid, p_operation text, p_name text, p_name_present boolean, p_description text, p_description_present boolean, p_allow_organization boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION mutate_scoped_variable_set(p_account_id uuid, p_workspace_id uuid, p_variable_set_id uuid, p_operation text, p_name text, p_name_present boolean, p_description text, p_description_present boolean, p_variable_name text, p_value_encrypted text, p_allow_organization boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION mutate_self_personal_github_repository_selection(p_account_id uuid, p_origin_workspace_id uuid, p_owner_subject_id text, p_connection_id uuid, p_expected_connection_authority_generation bigint, p_expected_selection_generation bigint, p_idempotency_key text, p_repositories jsonb, p_verify_only boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION open_organization_shared_workspace_administration_capability(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION open_private_child_session_create_capability(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_parent_session_id uuid, p_actor_turn_id uuid, p_actor_attempt_id uuid, p_actor_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION open_private_session_create_capability(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION open_tenancy_backfill_receipt(p_account_id uuid, p_resource_family text, p_run_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION organization_membership_command(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION organization_plan_seats_used(p_account_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION organization_recovery_command(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION organization_workspace_command(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preference_registry_activation_authority(p_workspace_id uuid, p_revision_ids uuid[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preference_registry_apply_lifecycle(p_operation text, p_preference_id uuid, p_expected_scope_version integer, p_expected_revision_id uuid, p_revision_id uuid, p_new_scope text, p_related_preference_id uuid, p_actor_subject_id text, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preference_registry_create_knowledge_proposal_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_input_hash text, p_knowledge_proposal_id uuid, p_stable_key text, p_title text, p_description text, p_content text, p_precedence_rank integer, p_conflict_strategy text, p_conflicts_with jsonb, p_expires_at timestamp with time zone, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE preference_registry_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preference_registry_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preference_registry_lock_heads(p_preference_ids uuid[]) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preflight_organization_user_setup(p_token_digest text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION prepare_organization_membership_protocol_settlements(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION prepare_organization_user_setup_delivery(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION prepare_organization_user_setup_delivery_v2(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION prepare_organization_workspace_member_removal(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION prepare_workspace_membership_removal_settlements(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preview_connected_machine_audience_change(p_account_id uuid, p_workspace_id uuid, p_enrollment_id uuid, p_target_scope text, p_owner_subject_id text, p_schedules_may_be_only_me boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preview_organization_retention_deletions(p_account_id uuid, p_limit integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION preview_organization_user_setup(p_token_digest text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION propose_company_profile_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_content_json text, p_content_hash text, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION provider_connection_home_workspace(p_connection uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION provider_vault_item_ref(p_vault uuid, p_item uuid, p_provider_item_ref text, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION provider_vault_sync_target(p_vault uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION read_organization_plan_balance(p_account_id uuid, p_as_of timestamp with time zone) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION read_scoped_variable_set_secret(p_account_id uuid, p_workspace_id uuid, p_variable_set_id uuid, p_variable_set_name text, p_variable_name text, p_actor_kind text, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION read_vault_field_ciphertext(p_field uuid, p_version integer, p_purpose text, p_principal jsonb, p_metadata jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION reclassify_document_authority(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION record_organization_retention_object_deleted(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_kind text, p_source_id text, p_object_bucket text, p_object_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION record_organization_workspace_member_removal(p_command jsonb, p_workspace_membership_id uuid, p_actor_membership_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION record_scheduled_task_revision_authority(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION record_tenancy_backfill_unresolved(p_receipt_id uuid, p_resource_id uuid, p_reason_code text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION record_vault_secret_use(p_principal jsonb, p_use jsonb, p_items jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION release_session_work_claim_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_claim_id uuid, p_expected_revision integer, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION release_vault_passkey_leases(p_holder text, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION replace_plan_credit_period(p_account_id uuid, p_plan_key text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_stripe_subscription_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION replace_task_note_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_archive_operation_id uuid, p_create_operation_id uuid, p_replaced_note_id uuid, p_expected_replaced_version integer, p_replacement_kind text, p_replacement_text text, p_replacement_expires_in_days integer, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION replay_applied_session_fork(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_accepted_connection_use(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_physical_request_id uuid, p_use_phase text, p_server_id text, p_connection_id uuid, p_provider_domain text, p_connection_kind text, p_subject_scope text, p_owner_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_document_original_file(p_account_id uuid, p_request_workspace_id uuid, p_actor_id text, p_document_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_organization_workspace_removal_subject(p_account_id uuid, p_actor_subject_id text, p_target_organization_membership_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_secret_reference_candidates(p_principal jsonb, p_refs jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_session_attempt_personal_document_reads(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_attempt_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_session_attempt_personal_resources(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_session_attempt_personal_resources_legacy_0305(p_account_id uuid, p_workspace_id uuid, p_attempt_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_task_note_knowledge_promotion_source(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_note_id uuid, p_expected_note_version integer, p_evidence_operation_id text, p_claim_operation_id text, p_actor_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_workspace_codex_subscription_source(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION resolve_workspace_writer_grant_identity(p_account_id uuid, p_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION restore_vault_item(p_item uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION revoke_self_user_resource_grant(p_account_id uuid, p_workspace_id uuid, p_grant_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION run_document_default_collection_backfill(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_scoped_rig_version_metadata(p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_rig_id uuid, p_version_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION xai_provider_account_authority_snapshot_v1_valid(snapshot jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE scheduled_tasks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_task_is_exhausted(p_task_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_task_personal_resource_authority_subject(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_task_revision_authority_snapshot(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_task_revision_authority_subject(p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_task_authority_revision bigint) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_task_run_connection_authority_subject(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_task_run_personal_resource_authority(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scheduled_variable_set_expected_generation_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_variable_set_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scoped_knowledge_advance_object_version(p_account_id uuid, p_object_id uuid, p_expected_lifecycle_generation bigint, p_expected_version_generation bigint, p_version_id uuid, p_operation_id text, p_input_hash text, p_reason_code text, p_actor_kind text, p_actor_subject_id text, p_initiating_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scoped_knowledge_advance_source_acl(p_account_id uuid, p_source_id uuid, p_expected_lifecycle_generation bigint, p_expected_acl_generation bigint, p_acl_version_id uuid, p_operation_id text, p_input_hash text, p_reason_code text, p_actor_kind text, p_actor_subject_id text, p_initiating_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scoped_knowledge_apply_lifecycle(p_account_id uuid, p_target_kind text, p_target_id uuid, p_event_type text, p_expected_generation bigint, p_operation_id text, p_input_hash text, p_reason_code text, p_actor_kind text, p_actor_subject_id text, p_initiating_human_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_sync_runs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION scoped_knowledge_complete_sync(p_account_id uuid, p_run_id uuid, p_state text, p_output_cursor text, p_watermark timestamp with time zone, p_metadata jsonb, p_error_code text, p_completion_hash text, p_reason_code text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_private_actor_visible(p_account_id uuid, p_workspace_id uuid, p_owner_organization_membership_id uuid, p_owner_subject_id text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_private_actor_visible_keys() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_reference_visible(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_secrets_view(p_session uuid, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_system_updates TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_tenancy_any_product_activation() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_tenancy_product_activated(p_account_id uuid, p_activation_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_usage_limit_command(p_input jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_visibility_change_blocker(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_visibility_foreign_authority_items(p_account_id uuid, p_workspace_id uuid, p_session_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION session_visibility_lifecycle_capability_held() TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION set_session_vault_policy(p_session uuid, p_policy jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION set_vault_sync_status(p_vault uuid, p jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION settle_organization_user_setup_delivery(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION slack_task_policy_update(p_operation_id uuid, p_request_fingerprint text, p_account_id uuid, p_workspace_id uuid, p_policy jsonb, p_expected_current_revision_id uuid, p_expected_activation_version bigint, p_actor_subject_id text, p_reason text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION subscription_effective_settings(p_account_id uuid, p_workspace_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION transition_scheduled_agent_run(p_account_id uuid, p_workspace_id uuid, p_run_id uuid, p_session_id uuid, p_trigger_event_id uuid, p_status text, p_error text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION transition_session_visibility(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_actor_subject_id text, p_target_visibility text, p_expected_authority_epoch integer, p_operation_key text, p_canonical_request_hash text, p_activation_version integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION undo_governed_learning_activation(p_account_id uuid, p_workspace_id uuid, p_operation_id uuid, p_activation_receipt_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION update_organization_name(p_account_id uuid, p_actor_subject_id text, p_name text, p_expected_updated_at timestamp with time zone, p_operation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION update_organization_private_session_settings(p_account_id uuid, p_actor_subject_id text, p_enabled boolean, p_expected_version bigint, p_operation_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION update_passkey_sign_count(p_item uuid, p_count bigint, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION update_vault(p_id uuid, p_expected_generation bigint, p jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION upsert_organization_plan(p_account_id uuid, p_plan_key text, p_status text, p_stripe_subscription_id text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_cancel_at_period_end boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION upsert_organization_shared_workspace_member(p_account_id uuid, p_workspace_id uuid, p_actor_subject_id text, p_target_membership_id uuid, p_subject_label text, p_role text, p_permissions jsonb, p_require_existing boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION upsert_provider_vault_items(p_vault uuid, p_content_version text, p_items jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION upsert_session_work_claim_for_attempt(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer, p_operation_id uuid, p_expected_revision integer, p_subject_namespace text, p_subject_type text, p_canonical_key text, p_display_label text, p_role text, p_version_kind text, p_version_value text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION upsert_vault_item(p jsonb, p_principal jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION usage_allowance_command(p_input jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION validate_canonical_human_session(p_auth_session_id text, p_auth_user_id text, p_allow_recovery boolean) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION validate_scheduled_agent_run_live_authority(p_account_id uuid, p_workspace_id uuid, p_run_id uuid) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION verify_organization_resource_classification(p_organization_id uuid, p_run_key text) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE workspace_instruction_policy_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION workspace_instruction_policy_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION workspace_learning_policy_get_or_create_snapshot(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid, p_attempt_id uuid, p_execution_generation integer) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION workspace_learning_policy_hash(p_workspace_mode text, p_source_overrides jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION workspace_learning_policy_source_overrides_valid(value jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT ALL ON FUNCTION workspace_membership_removal_command(p_command jsonb) TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE opengeni_private.credit_promotion_policy_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE opengeni_private.slack_file_upload_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE opengeni_private.subscription_plan_catalog_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_instruction_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_learning_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_learning_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_run_states TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE api_keys TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE attached_browser_devices TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE attached_browser_inventories TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE audit_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_identities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_rate_limits TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE auth_runs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE auth_runs_health_sequence_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_users TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_verifications TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_run_event_links TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_runs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_sources TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_templates TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_trigger_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_trigger_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_triggers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE automation_webhook_endpoints TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE billing_customers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE billing_subscription_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE browser_identities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE browser_revision_components TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE browser_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE browser_session_associations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE browser_session_retained_downloads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE browser_sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE browser_state_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE browser_state_uploads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE canonical_human_identities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE canonical_human_identity_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE canonical_human_identity_subjects TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE canonical_human_login_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_api_facets TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE capability_catalog_items TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE capability_component_owners TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE capability_facet_installations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_facets TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE capability_installations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_integration_facets TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_mcp_facets TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE capability_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE capability_plugin_installations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_plugin_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_plugins TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_skill_facets TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE capability_skill_files TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE channels TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE claude_capacity_waiters TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE claude_credential_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE claude_rotation_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE claude_session_account_pins TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE claude_subscription_account_usage TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE claude_subscription_credentials TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE codex_apps_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE codex_capacity_waiters TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE codex_credential_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE codex_reset_redemption_attempts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE codex_rotation_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE codex_subscription_credentials TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE codex_turn_source_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE company_profile_activation_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE company_profile_agent_automatic_activation_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE company_profile_heads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE company_profile_revision_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE company_profile_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE composer_drafts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE computer_session_associations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE computer_sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE connection_authority_convergence_audit_capabilities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE connection_disconnect_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE connector_action_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE connector_action_requests TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE credit_debit_allocations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE credit_ledger_entries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE device_enrollment_requests TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE document_authority_reclassifications TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_bases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_chunks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE document_index_completion_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE documents TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_blob_refs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_idempotency_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_live_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_materialization_jobs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_materialization_results TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE editable_artifact_replica_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_sequence_checkpoints TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE editable_artifact_session_links TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_transactions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_undo_claims TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE editable_artifact_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE editable_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE enrollment_token_redemptions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE enrollments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_deliveries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_ingress_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_source_feeds TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_sources TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_triggers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE external_identity_links TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE external_link_task_authorities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE external_link_turn_authorities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE feedback_submissions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE file_uploads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE generated_image_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE generated_video_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE github_installation_repositories TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE github_installations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE google_drive_object_acl_evidence TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE google_drive_object_acl_principals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE host_export_config TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE host_export_consumers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE host_export_cursor_state TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE host_export_dead_letters TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE host_export_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE image_generation_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE import_batches TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE inbound_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE insights_audience_sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE integration_facet_binding_owners TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE integration_facet_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE integration_facet_definitions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE integration_oauth_clients TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE integration_oauth_pending_states TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE integration_oauth_state_nonces TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE integration_spec_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE integration_tools TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE interaction_interventions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE interaction_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE interaction_resource_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_change_proposals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_claim_evidence TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_claim_relations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_claims TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_document_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entities TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entity_aliases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entry_decisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entry_links TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entry_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entry_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entry_search TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_entry_vectors TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_facts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_index_jobs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_lifecycle_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE knowledge_memories TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_memory_lifecycle_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_memory_relationships TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_operation_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_providers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_review_batches TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_acl_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_objects TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_sync_index_obligations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_sync_item_outcomes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_sync_object_observations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_sync_states TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_source_sync_wakes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE knowledge_sources TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE machine_metrics_latest TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE machine_metrics_series TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE machine_removal_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_accounts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_actor_mutation_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_browser_installations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_login_return_intents TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_login_slots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_login_transaction_rate_limits TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_login_transactions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_session_set_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_auth_session_sets TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE managed_sign_in_method_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_event_subscriptions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE memory_slack_publication_configurations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE memory_slack_publication_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE model_call_fact_reconciliation_candidates TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE model_call_fact_reconciliation_progress TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE nested_agent_depth_configuration TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE network_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE new_session_drafts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_agent_admin_access TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_codex_rotation_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_company_profile_agent_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_company_profile_agent_policy_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_integration_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_integration_policy_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_model_defaults TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_model_provider_connection_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_model_provider_connections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_model_provider_custom_models TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE organization_plans TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_privacy_preferences TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_private_session_setting_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_private_session_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_profile_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_approvals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_command_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_custodian_acceptances TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_custodians TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_notification_attempts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_notification_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_recovery_policy_heads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_webhook_deliveries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE organization_webhooks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pr_review_app_registrations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pr_review_managed_github_authority_nonces TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pr_review_managed_github_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pr_review_repository_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE preference_registry_preferences TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE preference_registry_revision_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE preference_registry_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_chunks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_live_segments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE recording_live_segments_sequence_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_notes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_people TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_segment_edits TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_speaker_assignments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_speaker_voices TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_tracks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_transcript_segments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_transcript_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_voice_rejections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recording_voiceprints TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE recordings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE retained_screenshot_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE rig_changes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE rig_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE rigs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_checkpoint_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_lease_holders TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_pty_sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_retained_processes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_session_envelopes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandbox_workspace_mutation_admissions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sandboxes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_task_blocker_reviews TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_task_event_inbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_task_event_occurrences TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_task_event_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE scheduled_task_runs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_task_schedule_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE secret_approval_rules TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE secret_use_approvals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_admin_access TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE session_attempt_codemode_calls TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_attempt_interruptions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE session_attempt_model_context_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE session_attempt_tool_catalogs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_background_commands TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_command_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE session_content_blobs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_create_idempotency_guard TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_event_cursors TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE session_goal_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_goals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_history_items TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_history_items_repair_audit TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_human_input_requests TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_list_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_mcp_servers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE session_message_search_texts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_pending_tool_calls TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_pins TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_realtime_connections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_realtime_context_projections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_realtime_entries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_realtime_modes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_recordings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_spawn_denials TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_stream_acknowledgments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_system_update_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_tenancy_activations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_title_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_turn_app_action_grants TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_turn_attempts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE session_turn_startup_milestones TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_turns TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_variable_set_attachments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE session_work_claims TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE session_workflow_wake_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_abuse_reports TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_auth_codes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE site_auth_connections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_collections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_files TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_rate_windows TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_record_values TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_records TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_usage TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_validation_windows TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_data_workspace_validation_windows TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE site_host_generation_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_hostname_holds TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_hostnames TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_limit_profiles TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_opens TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_platform_brake TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_platform_storage TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_platform_totals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_platform_usage TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_publications TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_runtime_conversations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_runtime_rate_windows TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_runtime_usage TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_session_access TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_sidebar_states TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_sql_databases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_sql_migrations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_sql_queries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_sql_rate_windows TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_sql_usage TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE site_viewer_sessions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE skill_config_conversion_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE skill_source_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE skill_write_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_api_rate_limits TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_bot_delete_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_bot_post_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_bot_update_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_bot_user_links TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_channel_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_installation_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_interaction_action_handles TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_interaction_progress_deliveries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_route_prompt_options TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_route_prompts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_shared_task_origins TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_task_policy_activation_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_task_policy_heads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE slack_task_policy_revision_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_task_policy_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_user_dm_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_user_link_access_request_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE slack_user_link_access_requests TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE social_connections TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE social_posts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE stripe_webhook_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_apps_designations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_capacity_waiters TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_capacity_wake_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_connection_aliases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_connection_assignment_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_connection_people TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_connection_quota TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_connection_workspaces TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_operation_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_person_preferences TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_provider_cutovers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_session_bindings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscription_turn_failures TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams_bot_inbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams_bot_installations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams_bot_links TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams_bot_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams_bot_proofs TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams_bot_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT UPDATE(relevant_event_sequence) ON TABLE teams_bot_routes TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE temporal_schedule_cleanup_outbox TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE transcription_recording_chunks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE transcription_recording_objects TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE transcription_recording_segments TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE transcription_recordings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE turn_personal_resource_attachment_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE turn_personal_resource_once_receipts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vault_field_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vault_item_fields TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vault_item_name_aliases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vault_name_aliases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE vault_passkey_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE video_generation_operations TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE video_generation_references TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE workspace_artifact_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT ON TABLE workspace_artifact_versions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_artifacts TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_captures TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_codex_subscription_preferences TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_control_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_credential_providers TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_inference_controls TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_instruction_policy_heads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_instruction_policy_onboarding_proposals TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,UPDATE ON TABLE workspace_interaction_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE workspace_learning_policy_activation_events TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE workspace_learning_policy_heads TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,USAGE ON SEQUENCE workspace_learning_policy_revision_seq TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT ON TABLE workspace_learning_policy_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_learning_policy_snapshots TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_memberships TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_model_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_screenshot_quotas TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,UPDATE ON TABLE workspace_session_activity_revisions TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_video_generation_policies TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_video_generation_quotas TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_webhook_deliveries TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_webhooks TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspaces TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE xai_capacity_waiters TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE xai_credential_leases TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE xai_rotation_settings TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE xai_session_account_pins TO opengeni_app;$grant$;
    EXECUTE $grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE xai_subscription_credentials TO opengeni_app;$grant$;
    EXECUTE $grant$ALTER DEFAULT PRIVILEGES IN SCHEMA {{schema}} GRANT SELECT,USAGE ON SEQUENCES TO opengeni_app;$grant$;
    EXECUTE $grant$ALTER DEFAULT PRIVILEGES IN SCHEMA {{schema}} GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO opengeni_app;$grant$;
  END IF;
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
  LOOP
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.append_subscription_usage_reading(p_account uuid, p_connection uuid, p_provider text, p_reading jsonb) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.automatic_session_title_fanout_due_v1() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.begin_site_session_cancellation(a uuid, w uuid, site uuid, root uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.begin_subscription_core_owned_connection_refresh(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.claim_automatic_session_title_fanout_v1(p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.clear_subscription_settings_locked_overrides() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.connect_subscription_core_personal(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_credential_encrypted text, p_provider_account_id text, p_provider_subject_id text, p_plan_type text, p_provider_state jsonb, p_expires_at timestamp with time zone, p_last_refresh_at timestamp with time zone, p_account_email text, p_label text, p_connected_by_subject_id text, p_credential_format text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.copy_subscription_authority_compat(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.defer_workspace_cascade_foreign_keys() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.editable_artifact_operation_id_list_valid(value jsonb) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.end_site_session_cancellation(token uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.enqueue_automatic_session_title_fanout_v1(p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_event_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_binding_provider() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_provider_connection_kind() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_settings_identity() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.guard_subscription_settings_locked_overrides() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_due_event_source_feeds_v1(p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_due_recording_retention_v1(p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_live_modal_sandbox_leases() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_pending_modal_provider_creates() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_stale_compute_sandbox_enrollments(after_enrollment uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.list_stalled_recording_work_v1(p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.maintenance_claim_active(p_actor text, p_operation text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.maintenance_title_event_visible(p_actor text, p_event_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.mark_automatic_session_title_fanout_delivered_v1(p_outbox_id uuid, p_event_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.mark_automatic_session_title_fanout_failed_v1(p_outbox_id uuid, p_event_id uuid, p_error text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.organization_model_provider_scope_visible(p_account_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.organization_subscription_model_scope_visible(p_account_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.prune_event_intake_v1(p_body_seconds integer, p_event_seconds integer, p_limit integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.prune_subscription_usage_history() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_authority_compat(p_provider text, p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_core_owned_connection_credential(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.read_subscription_usage_history(p_account uuid, p_workspace uuid, p_subject text, p_provider text, p_connections uuid[]) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.record_sandbox_recovery_operator_event(event_id uuid, event_kind text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.record_subscription_core_owned_connection_quota(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid, p_refresh_generation bigint, p_expected_revision bigint, p_quota jsonb, p_observed_at timestamp with time zone) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.reset_subscription_binding_cache_clock() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.sandbox_recovery_observations() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.session_variable_set_attachments_protocol_v1_active() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.set_subscription_core_reach(p_provider text, p_account_id uuid, p_connection_id uuid, p_shared boolean, p_personal boolean) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.set_subscription_core_reach_allocator(p_provider text, p_account_id uuid, p_connection_id uuid, p_enabled boolean) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_authority_carrier_inserted_now(p_carrier_kind text, p_workspace_id uuid, p_carrier_id uuid, p_task_authority_revision bigint) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_authority_compat_providers() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_connection_kind(p_provider text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_failover_readiness(p_provider text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_personal_connection_versions(p_provider text, p_account_id uuid, p_workspace_id uuid, p_subject_id text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_personal_sharing(p_provider text, p_account_id uuid, p_subject_id text, p_connection_id uuid, p_expected_version integer) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_core_reach(p_provider text, p_account_id uuid, p_connection_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_own_person_membership_id(p_account_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_person_preference_owned(p_account_id uuid, p_membership_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_provider_cutover_committed(p_provider text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_setting_override_widened(p_new jsonb, p_old jsonb, p_keyed boolean) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.subscription_usage_history_prune_due() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION opengeni_private.workspace_membership_administers(p_role text, p_permissions jsonb) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION agent_instruction_apply(p_account uuid, p_workspace uuid, p_actor jsonb, p_request jsonb) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION create_additional_managed_organization(p_subject_id text, p_subject_label text, p_organization_name text, p_workspace_name text, p_operation_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION fork_session_content_with_runtime(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_variable_set_ids jsonb, p_rig_id uuid, p_rig_version_id uuid, p_configuration_digest text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION knowledge_index_billing_policy(p_account uuid, p_revision uuid, p_lease uuid, p_requested text, p_activation_at timestamp with time zone, p_rate bigint) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION knowledge_index_paid_publication_guard(p_account uuid, p_revision uuid, p_lease uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION knowledge_index_wait_for_funding(p_account uuid, p_revision uuid, p_lease uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION knowledge_visible_index_status(p_account uuid, p_workspace uuid, p_actor jsonb, p_items jsonb, p_view text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION list_organization_subscription_workspace_ids(p_account_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION list_organization_workspace_ids(p_account_id uuid) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION lock_live_native_original_origin_v2(p_scope jsonb) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION replay_applied_session_fork_with_runtime(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_configuration_digest text) TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT ALL ON FUNCTION session_private_actor_visible_keys() TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT SELECT ON TABLE opengeni_private.sandbox_recovery_rollout TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_ingress_routes TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT SELECT,INSERT,UPDATE ON TABLE organization_model_provider_connection_operations TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT SELECT,INSERT,UPDATE ON TABLE organization_model_provider_connections TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
    EXECUTE replace($grant$GRANT SELECT,INSERT,UPDATE ON TABLE organization_model_provider_custom_models TO {{role}};$grant$, '{{role}}', quote_ident(application_role));
  END LOOP;
END $application_role_grants$;

