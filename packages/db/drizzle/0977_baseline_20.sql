-- deployment-mode: rolling
-- Opengeni baseline part 20 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

ALTER TABLE self_service_organization_setup_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_admin_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_admin_access_account ON session_admin_access USING ((account_id = opengeni_private.current_account_id())) WITH CHECK ((account_id = opengeni_private.current_account_id()));

ALTER TABLE session_attempt_codemode_calls ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_connected_machine_authorizations ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_interruptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_machine_consents ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_model_context_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_personal_document_admissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_personal_document_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_personal_resource_admissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_personal_resource_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_attempt_tool_catalogs ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_background_commands ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_command_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_content_blobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_event_cursors ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_events_automatic_title_quarantine_v1 ON session_events USING (
CASE
    WHEN (CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
       FROM pg_class relation
      WHERE (relation.oid = ('session_events'::regclass)::oid))) THEN (current_setting('opengeni.automatic_session_title_quarantine_v1'::text, true) = '1'::text)
    ELSE false
END) WITH CHECK (
CASE
    WHEN (CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
       FROM pg_class relation
      WHERE (relation.oid = ('session_events'::regclass)::oid))) THEN (current_setting('opengeni.automatic_session_title_quarantine_v1'::text, true) = '1'::text)
    ELSE false
END);

ALTER TABLE session_goal_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_goals ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_history_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_human_input_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_list_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_message_search_event_mirror_insert ON session_message_search_texts FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM session_events event
  WHERE ((event.workspace_id = session_message_search_texts.workspace_id) AND (event.session_id = session_message_search_texts.session_id) AND (event.sequence = session_message_search_texts.sequence) AND (event.account_id = session_message_search_texts.account_id) AND (event.type = ANY (ARRAY['user.message'::text, 'agent.message.completed'::text])) AND (jsonb_typeof((event.payload -> 'text'::text)) = 'string'::text) AND ((event.payload ->> 'text'::text) = session_message_search_texts.text) AND (session_message_search_texts.encoded = starts_with((event.payload ->> 'text'::text), 'opengeni_lossless_json_string_v2_81f06e15:'::text))))));

CREATE POLICY session_message_search_owner_insert ON session_message_search_texts FOR INSERT WITH CHECK ((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('session_message_search_texts'::regclass)::oid))));

CREATE POLICY session_message_search_pattern ON session_message_search_texts AS RESTRICTIVE FOR SELECT USING ((encoded OR (text ~ NULLIF(current_setting('opengeni.session_message_search_pattern'::text, true), ''::text))));

ALTER TABLE session_message_search_texts ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_ownership_capability_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.session_ownership_capability_active()));

CREATE POLICY session_ownership_capability_write ON sessions USING (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.session_ownership_capability_active())) WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND opengeni_private.session_ownership_capability_active()));

ALTER TABLE session_pending_tool_calls ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_pins ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_realtime_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_realtime_context_projections ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_realtime_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_realtime_modes ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_recordings ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_spawn_denials ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_stream_acknowledgments ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_system_update_outbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_system_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_tenancy_activation_receipt_insert ON session_tenancy_activations FOR INSERT WITH CHECK (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'session_tenancy_activation'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid)));

ALTER TABLE session_tenancy_activations ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_tenancy_activations_organization_isolation ON session_tenancy_activations FOR SELECT USING ((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid));

ALTER TABLE session_tenancy_additional_organization_activation_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_tenancy_additional_organization_activation_lifecycle ON session_tenancy_additional_organization_activation_evidence USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'session_tenancy_greenfield_activation'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'session_tenancy_greenfield_activation'::text));

CREATE POLICY session_tenancy_fence_inventory_read ON browser_sessions FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON computer_sessions FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON interaction_operations FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON sandbox_lease_holders FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON sandbox_leases FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON sandbox_retained_processes FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON sandbox_workspace_mutation_admissions FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON session_event_cursors FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON session_goals FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON session_system_updates FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON session_turn_attempts FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON session_turns FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fence_inventory_read ON sessions FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true));

CREATE POLICY session_tenancy_fenced_owner_interaction ON browser_sessions USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_interaction ON computer_sessions USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_interaction ON interaction_operations USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_interaction ON workspace_interaction_revisions USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_read ON sandbox_workspace_mutation_admissions FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_read ON session_background_commands FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_read ON session_turn_attempts FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_read ON session_turns FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_read ON sessions FOR SELECT USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_write ON sandbox_lease_holders USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_write ON sandbox_leases USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_write ON sandbox_retained_processes USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

CREATE POLICY session_tenancy_fenced_owner_write ON session_event_cursors USING (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false)) WITH CHECK (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false));

ALTER TABLE session_tenancy_greenfield_activation_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_tenancy_greenfield_activation_evidence_lifecycle ON session_tenancy_greenfield_activation_evidence USING ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'session_tenancy_greenfield_activation'::text)) WITH CHECK ((current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'session_tenancy_greenfield_activation'::text));

CREATE POLICY session_tenancy_greenfield_activation_witness_read ON session_tenancy_activations FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'session_tenancy_greenfield_activation'::text)));

ALTER TABLE session_title_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_turn_app_action_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_turn_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_turn_machine_consents ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_turn_startup_milestones ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_turns ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_variable_set_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_visibility_cache_stripping ON session_list_snapshots USING (((NULLIF(current_setting('opengeni.session_visibility_write_capability'::text, true), ''::text) IS NOT NULL) AND session_visibility_lifecycle_capability_held())) WITH CHECK (((NULLIF(current_setting('opengeni.session_visibility_write_capability'::text, true), ''::text) IS NOT NULL) AND session_visibility_lifecycle_capability_held()));

CREATE POLICY session_visibility_capability_owner ON session_visibility_write_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

CREATE POLICY session_visibility_delete_isolation ON model_call_facts AS RESTRICTIVE FOR DELETE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = model_call_facts.account_id) AND (session_row.workspace_id = model_call_facts.workspace_id) AND (session_row.id = model_call_facts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_delete_isolation ON usage_events AS RESTRICTIVE FOR DELETE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = usage_events.account_id) AND (session_row.workspace_id = usage_events.workspace_id) AND (session_row.id = usage_events.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_insert_isolation ON model_call_facts AS RESTRICTIVE FOR INSERT WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = model_call_facts.account_id) AND (session_row.workspace_id = model_call_facts.workspace_id) AND (session_row.id = model_call_facts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_insert_isolation ON usage_events AS RESTRICTIVE FOR INSERT WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = usage_events.account_id) AND (session_row.workspace_id = usage_events.workspace_id) AND (session_row.id = usage_events.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON agent_run_states AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = agent_run_states.account_id) AND (session_row.workspace_id = agent_run_states.workspace_id) AND (session_row.id = agent_run_states.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = agent_run_states.account_id) AND (session_row.workspace_id = agent_run_states.workspace_id) AND (session_row.id = agent_run_states.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON automation_runs AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = automation_runs.account_id) AND (session_row.workspace_id = automation_runs.workspace_id) AND (session_row.id = automation_runs.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = automation_runs.account_id) AND (session_row.workspace_id = automation_runs.workspace_id) AND (session_row.id = automation_runs.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON browser_session_associations AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = browser_session_associations.account_id) AND (session_row.workspace_id = browser_session_associations.workspace_id) AND (session_row.id = browser_session_associations.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = browser_session_associations.account_id) AND (session_row.workspace_id = browser_session_associations.workspace_id) AND (session_row.id = browser_session_associations.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON claude_capacity_waiters AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = claude_capacity_waiters.account_id) AND (session_row.workspace_id = claude_capacity_waiters.workspace_id) AND (session_row.id = claude_capacity_waiters.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = claude_capacity_waiters.account_id) AND (session_row.workspace_id = claude_capacity_waiters.workspace_id) AND (session_row.id = claude_capacity_waiters.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON claude_session_account_pins AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = claude_session_account_pins.account_id) AND (session_row.workspace_id = claude_session_account_pins.workspace_id) AND (session_row.id = claude_session_account_pins.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = claude_session_account_pins.account_id) AND (session_row.workspace_id = claude_session_account_pins.workspace_id) AND (session_row.id = claude_session_account_pins.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON codex_capacity_waiters AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = codex_capacity_waiters.account_id) AND (session_row.workspace_id = codex_capacity_waiters.workspace_id) AND (session_row.id = codex_capacity_waiters.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = codex_capacity_waiters.account_id) AND (session_row.workspace_id = codex_capacity_waiters.workspace_id) AND (session_row.id = codex_capacity_waiters.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_brain_context_selection_receipts AS RESTRICTIVE USING (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_brain_context_selection_receipts.account_id) AND (session_row.workspace_id = company_brain_context_selection_receipts.workspace_id) AND (session_row.id = company_brain_context_selection_receipts.root_session_id))
 OFFSET 0)))) WITH CHECK (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_brain_context_selection_receipts.account_id) AND (session_row.workspace_id = company_brain_context_selection_receipts.workspace_id) AND (session_row.id = company_brain_context_selection_receipts.root_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_brain_preference_proposal_receipts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_brain_preference_proposal_receipts.account_id) AND (session_row.workspace_id = company_brain_preference_proposal_receipts.workspace_id) AND (session_row.id = company_brain_preference_proposal_receipts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_brain_preference_proposal_receipts.account_id) AND (session_row.workspace_id = company_brain_preference_proposal_receipts.workspace_id) AND (session_row.id = company_brain_preference_proposal_receipts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_brain_turn_context_snapshots AS RESTRICTIVE USING (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_brain_turn_context_snapshots.account_id) AND (session_row.workspace_id = company_brain_turn_context_snapshots.workspace_id) AND (session_row.id = company_brain_turn_context_snapshots.root_session_id))
 OFFSET 0)))) WITH CHECK (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_brain_turn_context_snapshots.account_id) AND (session_row.workspace_id = company_brain_turn_context_snapshots.workspace_id) AND (session_row.id = company_brain_turn_context_snapshots.root_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_profile_agent_automatic_activation_receipts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_agent_automatic_activation_receipts.account_id) AND (session_row.workspace_id = company_profile_agent_automatic_activation_receipts.workspace_id) AND (session_row.id = company_profile_agent_automatic_activation_receipts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_agent_automatic_activation_receipts.account_id) AND (session_row.workspace_id = company_profile_agent_automatic_activation_receipts.workspace_id) AND (session_row.id = company_profile_agent_automatic_activation_receipts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_profile_agent_confirmation_receipts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_agent_confirmation_receipts.account_id) AND (session_row.workspace_id = company_profile_agent_confirmation_receipts.workspace_id) AND (session_row.id = company_profile_agent_confirmation_receipts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_agent_confirmation_receipts.account_id) AND (session_row.workspace_id = company_profile_agent_confirmation_receipts.workspace_id) AND (session_row.id = company_profile_agent_confirmation_receipts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_profile_agent_proposal_receipts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_agent_proposal_receipts.account_id) AND (session_row.workspace_id = company_profile_agent_proposal_receipts.workspace_id) AND (session_row.id = company_profile_agent_proposal_receipts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_agent_proposal_receipts.account_id) AND (session_row.workspace_id = company_profile_agent_proposal_receipts.workspace_id) AND (session_row.id = company_profile_agent_proposal_receipts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON company_profile_snapshots AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_snapshots.account_id) AND (session_row.workspace_id = company_profile_snapshots.workspace_id) AND (session_row.id = company_profile_snapshots.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = company_profile_snapshots.account_id) AND (session_row.workspace_id = company_profile_snapshots.workspace_id) AND (session_row.id = company_profile_snapshots.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON composer_drafts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = composer_drafts.account_id) AND (session_row.workspace_id = composer_drafts.workspace_id) AND (session_row.id = composer_drafts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = composer_drafts.account_id) AND (session_row.workspace_id = composer_drafts.workspace_id) AND (session_row.id = composer_drafts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON computer_session_associations AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = computer_session_associations.account_id) AND (session_row.workspace_id = computer_session_associations.workspace_id) AND (session_row.id = computer_session_associations.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = computer_session_associations.account_id) AND (session_row.workspace_id = computer_session_associations.workspace_id) AND (session_row.id = computer_session_associations.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON connector_action_requests AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = connector_action_requests.account_id) AND (session_row.workspace_id = connector_action_requests.workspace_id) AND (session_row.id = connector_action_requests.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = connector_action_requests.account_id) AND (session_row.workspace_id = connector_action_requests.workspace_id) AND (session_row.id = connector_action_requests.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON editable_artifact_session_links AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = editable_artifact_session_links.account_id) AND (session_row.workspace_id = editable_artifact_session_links.workspace_id) AND (session_row.id = editable_artifact_session_links.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = editable_artifact_session_links.account_id) AND (session_row.workspace_id = editable_artifact_session_links.workspace_id) AND (session_row.id = editable_artifact_session_links.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON external_link_turn_authorities AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = external_link_turn_authorities.account_id) AND (session_row.workspace_id = external_link_turn_authorities.workspace_id) AND (session_row.id = external_link_turn_authorities.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = external_link_turn_authorities.account_id) AND (session_row.workspace_id = external_link_turn_authorities.workspace_id) AND (session_row.id = external_link_turn_authorities.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON feedback_submissions AS RESTRICTIVE USING (((session_id IS NULL) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = feedback_submissions.account_id) AND (session_row.workspace_id = feedback_submissions.workspace_id) AND (session_row.id = feedback_submissions.session_id))
 OFFSET 0))))) WITH CHECK (((session_id IS NULL) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = feedback_submissions.account_id) AND (session_row.workspace_id = feedback_submissions.workspace_id) AND (session_row.id = feedback_submissions.session_id))
 OFFSET 0)))));

CREATE POLICY session_visibility_isolation ON generated_image_artifacts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = generated_image_artifacts.account_id) AND (session_row.workspace_id = generated_image_artifacts.workspace_id) AND (session_row.id = generated_image_artifacts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = generated_image_artifacts.account_id) AND (session_row.workspace_id = generated_image_artifacts.workspace_id) AND (session_row.id = generated_image_artifacts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON generated_video_artifacts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = generated_video_artifacts.account_id) AND (session_row.workspace_id = generated_video_artifacts.workspace_id) AND (session_row.id = generated_video_artifacts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = generated_video_artifacts.account_id) AND (session_row.workspace_id = generated_video_artifacts.workspace_id) AND (session_row.id = generated_video_artifacts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON governed_learning_decision_receipts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = governed_learning_decision_receipts.account_id) AND (session_row.workspace_id = governed_learning_decision_receipts.workspace_id) AND (session_row.id = governed_learning_decision_receipts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = governed_learning_decision_receipts.account_id) AND (session_row.workspace_id = governed_learning_decision_receipts.workspace_id) AND (session_row.id = governed_learning_decision_receipts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON host_mcp_turn_authorities AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = host_mcp_turn_authorities.account_id) AND (session_row.workspace_id = host_mcp_turn_authorities.workspace_id) AND (session_row.id = host_mcp_turn_authorities.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = host_mcp_turn_authorities.account_id) AND (session_row.workspace_id = host_mcp_turn_authorities.workspace_id) AND (session_row.id = host_mcp_turn_authorities.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON image_generation_operations AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = image_generation_operations.account_id) AND (session_row.workspace_id = image_generation_operations.workspace_id) AND (session_row.id = image_generation_operations.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = image_generation_operations.account_id) AND (session_row.workspace_id = image_generation_operations.workspace_id) AND (session_row.id = image_generation_operations.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON interaction_interventions AS RESTRICTIVE USING (((originating_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = interaction_interventions.account_id) AND (session_row.workspace_id = interaction_interventions.workspace_id) AND (session_row.id = interaction_interventions.originating_session_id))
 OFFSET 0)))) WITH CHECK (((originating_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = interaction_interventions.account_id) AND (session_row.workspace_id = interaction_interventions.workspace_id) AND (session_row.id = interaction_interventions.originating_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON knowledge_memories AS RESTRICTIVE USING ((((created_by_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = knowledge_memories.account_id) AND (session_row.workspace_id = knowledge_memories.workspace_id) AND (session_row.id = knowledge_memories.created_by_session_id))
 OFFSET 0))) AND ((scope_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = knowledge_memories.account_id) AND (session_row.workspace_id = knowledge_memories.workspace_id) AND (session_row.id = knowledge_memories.scope_session_id))
 OFFSET 0))))) WITH CHECK ((((created_by_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = knowledge_memories.account_id) AND (session_row.workspace_id = knowledge_memories.workspace_id) AND (session_row.id = knowledge_memories.created_by_session_id))
 OFFSET 0))) AND ((scope_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = knowledge_memories.account_id) AND (session_row.workspace_id = knowledge_memories.workspace_id) AND (session_row.id = knowledge_memories.scope_session_id))
 OFFSET 0)))));

CREATE POLICY session_visibility_isolation ON knowledge_memory_lifecycle_events AS RESTRICTIVE USING (((actor_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = knowledge_memory_lifecycle_events.account_id) AND (session_row.workspace_id = knowledge_memory_lifecycle_events.workspace_id) AND (session_row.id = knowledge_memory_lifecycle_events.actor_session_id))
 OFFSET 0)))) WITH CHECK (((actor_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = knowledge_memory_lifecycle_events.account_id) AND (session_row.workspace_id = knowledge_memory_lifecycle_events.workspace_id) AND (session_row.id = knowledge_memory_lifecycle_events.actor_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON memory_slack_publications AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = memory_slack_publications.account_id) AND (session_row.workspace_id = memory_slack_publications.workspace_id) AND (session_row.id = memory_slack_publications.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = memory_slack_publications.account_id) AND (session_row.workspace_id = memory_slack_publications.workspace_id) AND (session_row.id = memory_slack_publications.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON model_call_facts AS RESTRICTIVE FOR SELECT USING (
CASE
    WHEN ( SELECT insights_fact_read_policy_capability_active((CURRENT_USER)::text, (pg_get_userbyid(( SELECT relation.relowner
               FROM pg_class relation
              WHERE (relation.oid = ('model_call_facts'::regclass)::oid))))::text, 'model_call_facts'::text) AS insights_fact_read_policy_capability_active) THEN true
    ELSE ((session_id IS NULL) OR (EXISTS ( SELECT 1
       FROM sessions session_row
      WHERE ((session_row.account_id = model_call_facts.account_id) AND (session_row.workspace_id = model_call_facts.workspace_id) AND (session_row.id = model_call_facts.session_id))
     OFFSET 0)))
END);

CREATE POLICY session_visibility_isolation ON organization_user_resource_grants AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = organization_user_resource_grants.account_id) AND (session_row.workspace_id = organization_user_resource_grants.workspace_id) AND (session_row.id = organization_user_resource_grants.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = organization_user_resource_grants.account_id) AND (session_row.workspace_id = organization_user_resource_grants.workspace_id) AND (session_row.id = organization_user_resource_grants.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON preference_registry_snapshots AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = preference_registry_snapshots.account_id) AND (session_row.workspace_id = preference_registry_snapshots.workspace_id) AND (session_row.id = preference_registry_snapshots.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = preference_registry_snapshots.account_id) AND (session_row.workspace_id = preference_registry_snapshots.workspace_id) AND (session_row.id = preference_registry_snapshots.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON remember_knowledge_confirmation_receipts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = remember_knowledge_confirmation_receipts.account_id) AND (session_row.workspace_id = remember_knowledge_confirmation_receipts.workspace_id) AND (session_row.id = remember_knowledge_confirmation_receipts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = remember_knowledge_confirmation_receipts.account_id) AND (session_row.workspace_id = remember_knowledge_confirmation_receipts.workspace_id) AND (session_row.id = remember_knowledge_confirmation_receipts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON remember_knowledge_memory_materializations AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = remember_knowledge_memory_materializations.account_id) AND (session_row.workspace_id = remember_knowledge_memory_materializations.workspace_id) AND (session_row.id = remember_knowledge_memory_materializations.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = remember_knowledge_memory_materializations.account_id) AND (session_row.workspace_id = remember_knowledge_memory_materializations.workspace_id) AND (session_row.id = remember_knowledge_memory_materializations.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON retained_screenshot_artifacts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = retained_screenshot_artifacts.account_id) AND (session_row.workspace_id = retained_screenshot_artifacts.workspace_id) AND (session_row.id = retained_screenshot_artifacts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = retained_screenshot_artifacts.account_id) AND (session_row.workspace_id = retained_screenshot_artifacts.workspace_id) AND (session_row.id = retained_screenshot_artifacts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON sandbox_pty_sessions AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_pty_sessions.account_id) AND (session_row.workspace_id = sandbox_pty_sessions.workspace_id) AND (session_row.id = sandbox_pty_sessions.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_pty_sessions.account_id) AND (session_row.workspace_id = sandbox_pty_sessions.workspace_id) AND (session_row.id = sandbox_pty_sessions.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON sandbox_retained_processes AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_retained_processes.account_id) AND (session_row.workspace_id = sandbox_retained_processes.workspace_id) AND (session_row.id = sandbox_retained_processes.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_retained_processes.account_id) AND (session_row.workspace_id = sandbox_retained_processes.workspace_id) AND (session_row.id = sandbox_retained_processes.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON sandbox_session_envelopes AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_session_envelopes.account_id) AND (session_row.workspace_id = sandbox_session_envelopes.workspace_id) AND (session_row.id = sandbox_session_envelopes.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_session_envelopes.account_id) AND (session_row.workspace_id = sandbox_session_envelopes.workspace_id) AND (session_row.id = sandbox_session_envelopes.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON sandbox_workspace_mutation_admissions AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_workspace_mutation_admissions.account_id) AND (session_row.workspace_id = sandbox_workspace_mutation_admissions.workspace_id) AND (session_row.id = sandbox_workspace_mutation_admissions.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = sandbox_workspace_mutation_admissions.account_id) AND (session_row.workspace_id = sandbox_workspace_mutation_admissions.workspace_id) AND (session_row.id = sandbox_workspace_mutation_admissions.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON scheduled_task_reusable_connection_materializations AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = scheduled_task_reusable_connection_materializations.account_id) AND (session_row.workspace_id = scheduled_task_reusable_connection_materializations.workspace_id) AND (session_row.id = scheduled_task_reusable_connection_materializations.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = scheduled_task_reusable_connection_materializations.account_id) AND (session_row.workspace_id = scheduled_task_reusable_connection_materializations.workspace_id) AND (session_row.id = scheduled_task_reusable_connection_materializations.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON scheduled_task_runs AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = scheduled_task_runs.account_id) AND (session_row.workspace_id = scheduled_task_runs.workspace_id) AND (session_row.id = scheduled_task_runs.session_id))
 OFFSET 0)) OR ( SELECT insights_fact_read_policy_capability_active((CURRENT_USER)::text, (pg_get_userbyid(( SELECT relation.relowner
           FROM pg_class relation
          WHERE (relation.oid = ('scheduled_task_runs'::regclass)::oid))))::text, 'private_scheduled_task_summary'::text) AS insights_fact_read_policy_capability_active))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = scheduled_task_runs.account_id) AND (session_row.workspace_id = scheduled_task_runs.workspace_id) AND (session_row.id = scheduled_task_runs.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON scheduled_tasks AS RESTRICTIVE USING (((reusable_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = scheduled_tasks.account_id) AND (session_row.workspace_id = scheduled_tasks.workspace_id) AND (session_row.id = scheduled_tasks.reusable_session_id))
 OFFSET 0)) OR ( SELECT opengeni_private.lifecycle_backfill_read_active() AS lifecycle_backfill_read_active) OR ( SELECT insights_fact_read_policy_capability_active((CURRENT_USER)::text, (pg_get_userbyid(( SELECT relation.relowner
           FROM pg_class relation
          WHERE (relation.oid = ('scheduled_tasks'::regclass)::oid))))::text, 'private_scheduled_task_summary'::text) AS insights_fact_read_policy_capability_active))) WITH CHECK (((reusable_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = scheduled_tasks.account_id) AND (session_row.workspace_id = scheduled_tasks.workspace_id) AND (session_row.id = scheduled_tasks.reusable_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON secret_use_approvals AS RESTRICTIVE USING (session_reference_visible(account_id, workspace_id, session_id)) WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

CREATE POLICY session_visibility_isolation ON session_attempt_codemode_calls AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_attempt_codemode_calls.account_id) AND (session_row.workspace_id = session_attempt_codemode_calls.workspace_id) AND (session_row.id = session_attempt_codemode_calls.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_attempt_codemode_calls.account_id) AND (session_row.workspace_id = session_attempt_codemode_calls.workspace_id) AND (session_row.id = session_attempt_codemode_calls.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_attempt_interruptions AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_attempt_interruptions.account_id) AND (session_row.workspace_id = session_attempt_interruptions.workspace_id) AND (session_row.id = session_attempt_interruptions.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_attempt_interruptions.account_id) AND (session_row.workspace_id = session_attempt_interruptions.workspace_id) AND (session_row.id = session_attempt_interruptions.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_attempt_tool_catalogs AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_attempt_tool_catalogs.account_id) AND (session_row.workspace_id = session_attempt_tool_catalogs.workspace_id) AND (session_row.id = session_attempt_tool_catalogs.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_attempt_tool_catalogs.account_id) AND (session_row.workspace_id = session_attempt_tool_catalogs.workspace_id) AND (session_row.id = session_attempt_tool_catalogs.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_background_commands AS RESTRICTIVE USING ((session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true) OR session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_background_commands.account_id) AND (session_row.workspace_id = session_background_commands.workspace_id) AND (session_row.id = session_background_commands.session_id))
 OFFSET 0))))) WITH CHECK ((session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_background_commands.account_id) AND (session_row.workspace_id = session_background_commands.workspace_id) AND (session_row.id = session_background_commands.session_id))
 OFFSET 0)))));

CREATE POLICY session_visibility_isolation ON session_command_receipts AS RESTRICTIVE USING (((target_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_command_receipts.account_id) AND (session_row.workspace_id = session_command_receipts.workspace_id) AND (session_row.id = session_command_receipts.target_session_id))
 OFFSET 0)))) WITH CHECK (((target_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_command_receipts.account_id) AND (session_row.workspace_id = session_command_receipts.workspace_id) AND (session_row.id = session_command_receipts.target_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_content_blobs AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_content_blobs.account_id) AND (session_row.workspace_id = session_content_blobs.workspace_id) AND (session_row.id = session_content_blobs.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_content_blobs.account_id) AND (session_row.workspace_id = session_content_blobs.workspace_id) AND (session_row.id = session_content_blobs.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_event_cursors AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_event_cursors.account_id) AND (session_row.workspace_id = session_event_cursors.workspace_id) AND (session_row.id = session_event_cursors.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_event_cursors.account_id) AND (session_row.workspace_id = session_event_cursors.workspace_id) AND (session_row.id = session_event_cursors.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_events AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_events.account_id) AND (session_row.workspace_id = session_events.workspace_id) AND (session_row.id = session_events.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_events.account_id) AND (session_row.workspace_id = session_events.workspace_id) AND (session_row.id = session_events.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_goal_revisions AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_goal_revisions.account_id) AND (session_row.workspace_id = session_goal_revisions.workspace_id) AND (session_row.id = session_goal_revisions.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_goal_revisions.account_id) AND (session_row.workspace_id = session_goal_revisions.workspace_id) AND (session_row.id = session_goal_revisions.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_goals AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_goals.account_id) AND (session_row.workspace_id = session_goals.workspace_id) AND (session_row.id = session_goals.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_goals.account_id) AND (session_row.workspace_id = session_goals.workspace_id) AND (session_row.id = session_goals.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_history_items AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_history_items.account_id) AND (session_row.workspace_id = session_history_items.workspace_id) AND (session_row.id = session_history_items.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_history_items.account_id) AND (session_row.workspace_id = session_history_items.workspace_id) AND (session_row.id = session_history_items.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_human_input_requests AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_human_input_requests.account_id) AND (session_row.workspace_id = session_human_input_requests.workspace_id) AND (session_row.id = session_human_input_requests.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_human_input_requests.account_id) AND (session_row.workspace_id = session_human_input_requests.workspace_id) AND (session_row.id = session_human_input_requests.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_mcp_servers AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_mcp_servers.account_id) AND (session_row.workspace_id = session_mcp_servers.workspace_id) AND (session_row.id = session_mcp_servers.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_mcp_servers.account_id) AND (session_row.workspace_id = session_mcp_servers.workspace_id) AND (session_row.id = session_mcp_servers.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_message_search_texts AS RESTRICTIVE FOR SELECT USING (session_reference_visible(account_id, workspace_id, session_id));

CREATE POLICY session_visibility_isolation ON session_pending_tool_calls AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_pending_tool_calls.account_id) AND (session_row.workspace_id = session_pending_tool_calls.workspace_id) AND (session_row.id = session_pending_tool_calls.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_pending_tool_calls.account_id) AND (session_row.workspace_id = session_pending_tool_calls.workspace_id) AND (session_row.id = session_pending_tool_calls.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_pins AS RESTRICTIVE USING (
CASE
    WHEN (subject_id = opengeni_private.current_subject_id()) THEN true
    ELSE ((session_id IS NULL) OR (EXISTS ( SELECT 1
       FROM sessions session_row
      WHERE ((session_row.account_id = session_pins.account_id) AND (session_row.workspace_id = session_pins.workspace_id) AND (session_row.id = session_pins.session_id))
     OFFSET 0)) OR (subject_id = opengeni_private.current_subject_id()))
END) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_pins.account_id) AND (session_row.workspace_id = session_pins.workspace_id) AND (session_row.id = session_pins.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_realtime_connections AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_connections.account_id) AND (session_row.workspace_id = session_realtime_connections.workspace_id) AND (session_row.id = session_realtime_connections.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_connections.account_id) AND (session_row.workspace_id = session_realtime_connections.workspace_id) AND (session_row.id = session_realtime_connections.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_realtime_context_projections AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_context_projections.account_id) AND (session_row.workspace_id = session_realtime_context_projections.workspace_id) AND (session_row.id = session_realtime_context_projections.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_context_projections.account_id) AND (session_row.workspace_id = session_realtime_context_projections.workspace_id) AND (session_row.id = session_realtime_context_projections.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_realtime_entries AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_entries.account_id) AND (session_row.workspace_id = session_realtime_entries.workspace_id) AND (session_row.id = session_realtime_entries.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_entries.account_id) AND (session_row.workspace_id = session_realtime_entries.workspace_id) AND (session_row.id = session_realtime_entries.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_realtime_modes AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_modes.account_id) AND (session_row.workspace_id = session_realtime_modes.workspace_id) AND (session_row.id = session_realtime_modes.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_realtime_modes.account_id) AND (session_row.workspace_id = session_realtime_modes.workspace_id) AND (session_row.id = session_realtime_modes.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_recordings AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_recordings.account_id) AND (session_row.workspace_id = session_recordings.workspace_id) AND (session_row.id = session_recordings.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_recordings.account_id) AND (session_row.workspace_id = session_recordings.workspace_id) AND (session_row.id = session_recordings.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_system_update_outbox AS RESTRICTIVE USING ((((source_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_system_update_outbox.account_id) AND (session_row.workspace_id = session_system_update_outbox.workspace_id) AND (session_row.id = session_system_update_outbox.source_session_id))
 OFFSET 0))) AND ((target_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_system_update_outbox.account_id) AND (session_row.workspace_id = session_system_update_outbox.workspace_id) AND (session_row.id = session_system_update_outbox.target_session_id))
 OFFSET 0))))) WITH CHECK ((((source_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_system_update_outbox.account_id) AND (session_row.workspace_id = session_system_update_outbox.workspace_id) AND (session_row.id = session_system_update_outbox.source_session_id))
 OFFSET 0))) AND ((target_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_system_update_outbox.account_id) AND (session_row.workspace_id = session_system_update_outbox.workspace_id) AND (session_row.id = session_system_update_outbox.target_session_id))
 OFFSET 0)))));

CREATE POLICY session_visibility_isolation ON session_system_updates AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_system_updates.account_id) AND (session_row.workspace_id = session_system_updates.workspace_id) AND (session_row.id = session_system_updates.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_system_updates.account_id) AND (session_row.workspace_id = session_system_updates.workspace_id) AND (session_row.id = session_system_updates.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_title_operations AS RESTRICTIVE USING (session_reference_visible(account_id, workspace_id, session_id)) WITH CHECK (session_reference_visible(account_id, workspace_id, session_id));

CREATE POLICY session_visibility_isolation ON session_turn_attempts AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_turn_attempts.account_id) AND (session_row.workspace_id = session_turn_attempts.workspace_id) AND (session_row.id = session_turn_attempts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_turn_attempts.account_id) AND (session_row.workspace_id = session_turn_attempts.workspace_id) AND (session_row.id = session_turn_attempts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_turn_startup_milestones AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_turn_startup_milestones.account_id) AND (session_row.workspace_id = session_turn_startup_milestones.workspace_id) AND (session_row.id = session_turn_startup_milestones.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_turn_startup_milestones.account_id) AND (session_row.workspace_id = session_turn_startup_milestones.workspace_id) AND (session_row.id = session_turn_startup_milestones.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_turns AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_turns.account_id) AND (session_row.workspace_id = session_turns.workspace_id) AND (session_row.id = session_turns.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_turns.account_id) AND (session_row.workspace_id = session_turns.workspace_id) AND (session_row.id = session_turns.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON session_variable_set_attachments AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_variable_set_attachments.account_id) AND (session_row.workspace_id = session_variable_set_attachments.workspace_id) AND (session_row.id = session_variable_set_attachments.session_id))
 OFFSET 0)) OR opengeni_private.variable_set_authority_capability_active('write'::text))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_variable_set_attachments.account_id) AND (session_row.workspace_id = session_variable_set_attachments.workspace_id) AND (session_row.id = session_variable_set_attachments.session_id))
 OFFSET 0)) OR opengeni_private.variable_set_authority_capability_active('write'::text)));

CREATE POLICY session_visibility_isolation ON session_work_claim_revisions AS RESTRICTIVE FOR SELECT USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_work_claim_revisions.account_id) AND (session_row.workspace_id = session_work_claim_revisions.workspace_id) AND (session_row.id = session_work_claim_revisions.session_id))
 OFFSET 0)) OR opengeni_private.session_work_claim_capability_active()));

CREATE POLICY session_visibility_isolation ON session_work_claims AS RESTRICTIVE FOR SELECT USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_work_claims.account_id) AND (session_row.workspace_id = session_work_claims.workspace_id) AND (session_row.id = session_work_claims.session_id))
 OFFSET 0)) OR opengeni_private.session_work_claim_capability_active()));

CREATE POLICY session_visibility_isolation ON session_workflow_wake_outbox AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_workflow_wake_outbox.account_id) AND (session_row.workspace_id = session_workflow_wake_outbox.workspace_id) AND (session_row.id = session_workflow_wake_outbox.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = session_workflow_wake_outbox.account_id) AND (session_row.workspace_id = session_workflow_wake_outbox.workspace_id) AND (session_row.id = session_workflow_wake_outbox.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON sessions AS RESTRICTIVE USING (((NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL) OR (visibility = 'workspace_shared'::text) OR ((workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND ((((owner_organization_membership_id)::text || ':'::text) || owner_subject_id) = ANY (( SELECT session_private_actor_visible_keys() AS session_private_actor_visible_keys)::text[]))) OR (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true) OR session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false) OR (NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL) OR (visibility = 'workspace_shared'::text) OR ((owner_subject_id = ANY (ARRAY[NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.initiating_human_subject_id'::text, true), ''::text)])) AND session_private_actor_visible(account_id, workspace_id, owner_organization_membership_id, owner_subject_id)) OR site_session_cancellation_capability_active(account_id, workspace_id, site_id, site_access_root_id)) OR ( SELECT (opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'titles'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text))))) WITH CHECK (((NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL) OR (visibility = 'workspace_shared'::text) OR ((workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND ((((owner_organization_membership_id)::text || ':'::text) || owner_subject_id) = ANY (( SELECT session_private_actor_visible_keys() AS session_private_actor_visible_keys)::text[]))) OR (session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, true) OR session_tenancy_fence_owner_policy_active((CURRENT_USER)::text, '{{owner}}'::text, ({{schema_oid}})::oid, workspace_id, false) OR (NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL) OR (visibility = 'workspace_shared'::text) OR ((owner_subject_id = ANY (ARRAY[NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.initiating_human_subject_id'::text, true), ''::text)])) AND session_private_actor_visible(account_id, workspace_id, owner_organization_membership_id, owner_subject_id)) OR site_session_cancellation_capability_active(account_id, workspace_id, site_id, site_access_root_id)) OR ( SELECT (opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'titles'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text)))));

CREATE POLICY session_visibility_isolation ON slack_interaction_action_handles AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = slack_interaction_action_handles.account_id) AND (session_row.workspace_id = slack_interaction_action_handles.workspace_id) AND (session_row.id = slack_interaction_action_handles.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = slack_interaction_action_handles.account_id) AND (session_row.workspace_id = slack_interaction_action_handles.workspace_id) AND (session_row.id = slack_interaction_action_handles.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON slack_interactions AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = slack_interactions.account_id) AND (session_row.workspace_id = slack_interactions.workspace_id) AND (session_row.id = slack_interactions.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = slack_interactions.account_id) AND (session_row.workspace_id = slack_interactions.workspace_id) AND (session_row.id = slack_interactions.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON slack_shared_task_origins AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = slack_shared_task_origins.account_id) AND (session_row.workspace_id = slack_shared_task_origins.workspace_id) AND (session_row.id = slack_shared_task_origins.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = slack_shared_task_origins.account_id) AND (session_row.workspace_id = slack_shared_task_origins.workspace_id) AND (session_row.id = slack_shared_task_origins.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON subscription_capacity_waiters AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_capacity_waiters.account_id) AND (session_row.workspace_id = subscription_capacity_waiters.workspace_id) AND (session_row.id = subscription_capacity_waiters.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_capacity_waiters.account_id) AND (session_row.workspace_id = subscription_capacity_waiters.workspace_id) AND (session_row.id = subscription_capacity_waiters.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON subscription_leases AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_leases.account_id) AND (session_row.workspace_id = subscription_leases.workspace_id) AND (session_row.id = subscription_leases.session_id))
 OFFSET 0)) OR ((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)) OR ((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_leases.account_id) AND (session_row.workspace_id = subscription_leases.workspace_id) AND (session_row.id = subscription_leases.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON subscription_operation_leases AS RESTRICTIVE USING (((session_id IS NULL) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_operation_leases.account_id) AND (session_row.workspace_id = subscription_operation_leases.workspace_id) AND (session_row.id = subscription_operation_leases.session_id))
 OFFSET 0))) OR ((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_operation_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)) OR ((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_operation_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)))) WITH CHECK (((session_id IS NULL) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_operation_leases.account_id) AND (session_row.workspace_id = subscription_operation_leases.workspace_id) AND (session_row.id = subscription_operation_leases.session_id))
 OFFSET 0)))));

CREATE POLICY session_visibility_isolation ON subscription_session_bindings AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_session_bindings.account_id) AND (session_row.workspace_id = subscription_session_bindings.workspace_id) AND (session_row.id = subscription_session_bindings.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_session_bindings.account_id) AND (session_row.workspace_id = subscription_session_bindings.workspace_id) AND (session_row.id = subscription_session_bindings.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON subscription_turn_failures AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_turn_failures.account_id) AND (session_row.workspace_id = subscription_turn_failures.workspace_id) AND (session_row.id = subscription_turn_failures.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_turn_failures.account_id) AND (session_row.workspace_id = subscription_turn_failures.workspace_id) AND (session_row.id = subscription_turn_failures.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON task_note_events AS RESTRICTIVE USING (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = task_note_events.account_id) AND (session_row.workspace_id = task_note_events.workspace_id) AND (session_row.id = task_note_events.root_session_id))
 OFFSET 0)))) WITH CHECK (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = task_note_events.account_id) AND (session_row.workspace_id = task_note_events.workspace_id) AND (session_row.id = task_note_events.root_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON task_note_replacement_receipts AS RESTRICTIVE USING (((actor_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = task_note_replacement_receipts.account_id) AND (session_row.workspace_id = task_note_replacement_receipts.workspace_id) AND (session_row.id = task_note_replacement_receipts.actor_session_id))
 OFFSET 0)))) WITH CHECK (((actor_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = task_note_replacement_receipts.account_id) AND (session_row.workspace_id = task_note_replacement_receipts.workspace_id) AND (session_row.id = task_note_replacement_receipts.actor_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON task_notes AS RESTRICTIVE USING (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = task_notes.account_id) AND (session_row.workspace_id = task_notes.workspace_id) AND (session_row.id = task_notes.root_session_id))
 OFFSET 0)))) WITH CHECK (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = task_notes.account_id) AND (session_row.workspace_id = task_notes.workspace_id) AND (session_row.id = task_notes.root_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON usage_events AS RESTRICTIVE FOR SELECT USING (
CASE
    WHEN ( SELECT organization_usage_policy_capability_active((CURRENT_USER)::text) AS organization_usage_policy_capability_active) THEN true
    ELSE
    CASE
        WHEN ( SELECT insights_fact_read_policy_capability_active((CURRENT_USER)::text, (pg_get_userbyid(( SELECT relation.relowner
                   FROM pg_class relation
                  WHERE (relation.oid = ('usage_events'::regclass)::oid))))::text, 'usage_events'::text) AS insights_fact_read_policy_capability_active) THEN true
        ELSE ((session_id IS NULL) OR (EXISTS ( SELECT 1
           FROM sessions session_row
          WHERE ((session_row.account_id = usage_events.account_id) AND (session_row.workspace_id = usage_events.workspace_id) AND (session_row.id = usage_events.session_id))
         OFFSET 0)))
    END
END);

CREATE POLICY session_visibility_isolation ON video_generation_operations AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = video_generation_operations.account_id) AND (session_row.workspace_id = video_generation_operations.workspace_id) AND (session_row.id = video_generation_operations.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = video_generation_operations.account_id) AND (session_row.workspace_id = video_generation_operations.workspace_id) AND (session_row.id = video_generation_operations.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON workspace_captures AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_captures.account_id) AND (session_row.workspace_id = workspace_captures.workspace_id) AND (session_row.id = workspace_captures.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_captures.account_id) AND (session_row.workspace_id = workspace_captures.workspace_id) AND (session_row.id = workspace_captures.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON workspace_control_events AS RESTRICTIVE USING (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_control_events.account_id) AND (session_row.workspace_id = workspace_control_events.workspace_id) AND (session_row.id = workspace_control_events.root_session_id))
 OFFSET 0)))) WITH CHECK (((root_session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_control_events.account_id) AND (session_row.workspace_id = workspace_control_events.workspace_id) AND (session_row.id = workspace_control_events.root_session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON workspace_instruction_policy_snapshots AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_instruction_policy_snapshots.account_id) AND (session_row.workspace_id = workspace_instruction_policy_snapshots.workspace_id) AND (session_row.id = workspace_instruction_policy_snapshots.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_instruction_policy_snapshots.account_id) AND (session_row.workspace_id = workspace_instruction_policy_snapshots.workspace_id) AND (session_row.id = workspace_instruction_policy_snapshots.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON workspace_learning_policy_snapshots AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_learning_policy_snapshots.account_id) AND (session_row.workspace_id = workspace_learning_policy_snapshots.workspace_id) AND (session_row.id = workspace_learning_policy_snapshots.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = workspace_learning_policy_snapshots.account_id) AND (session_row.workspace_id = workspace_learning_policy_snapshots.workspace_id) AND (session_row.id = workspace_learning_policy_snapshots.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON xai_capacity_waiters AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = xai_capacity_waiters.account_id) AND (session_row.workspace_id = xai_capacity_waiters.workspace_id) AND (session_row.id = xai_capacity_waiters.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = xai_capacity_waiters.account_id) AND (session_row.workspace_id = xai_capacity_waiters.workspace_id) AND (session_row.id = xai_capacity_waiters.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_isolation ON xai_session_account_pins AS RESTRICTIVE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = xai_session_account_pins.account_id) AND (session_row.workspace_id = xai_session_account_pins.workspace_id) AND (session_row.id = xai_session_account_pins.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = xai_session_account_pins.account_id) AND (session_row.workspace_id = xai_session_account_pins.workspace_id) AND (session_row.id = xai_session_account_pins.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_update_isolation ON model_call_facts AS RESTRICTIVE FOR UPDATE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = model_call_facts.account_id) AND (session_row.workspace_id = model_call_facts.workspace_id) AND (session_row.id = model_call_facts.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = model_call_facts.account_id) AND (session_row.workspace_id = model_call_facts.workspace_id) AND (session_row.id = model_call_facts.session_id))
 OFFSET 0))));

CREATE POLICY session_visibility_update_isolation ON usage_events AS RESTRICTIVE FOR UPDATE USING (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = usage_events.account_id) AND (session_row.workspace_id = usage_events.workspace_id) AND (session_row.id = usage_events.session_id))
 OFFSET 0)))) WITH CHECK (((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = usage_events.account_id) AND (session_row.workspace_id = usage_events.workspace_id) AND (session_row.id = usage_events.session_id))
 OFFSET 0))));

ALTER TABLE session_visibility_write_capabilities ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_work_claim_capability_owner ON session_work_claim_write_capabilities USING ((CURRENT_USER = '{{owner}}'::name)) WITH CHECK ((CURRENT_USER = '{{owner}}'::name));

ALTER TABLE session_work_claim_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_work_claim_revisions_immutable_delete ON session_work_claim_revisions AS RESTRICTIVE FOR DELETE USING (false);

CREATE POLICY session_work_claim_revisions_immutable_update ON session_work_claim_revisions AS RESTRICTIVE FOR UPDATE USING (false) WITH CHECK (false);

CREATE POLICY session_work_claim_revisions_lifecycle_insert ON session_work_claim_revisions AS RESTRICTIVE FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM session_work_claim_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.session_work_claim_write_capability'::text, true), ''::text))::uuid)))));

CREATE POLICY session_work_claim_revisions_tenant ON session_work_claim_revisions USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE session_work_claim_write_capabilities ENABLE ROW LEVEL SECURITY;

ALTER TABLE session_work_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY session_work_claims_lifecycle_delete ON session_work_claims AS RESTRICTIVE FOR DELETE USING ((EXISTS ( SELECT 1
   FROM session_work_claim_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.session_work_claim_write_capability'::text, true), ''::text))::uuid)))));

CREATE POLICY session_work_claims_lifecycle_insert ON session_work_claims AS RESTRICTIVE FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM session_work_claim_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.session_work_claim_write_capability'::text, true), ''::text))::uuid)))));

CREATE POLICY session_work_claims_lifecycle_update ON session_work_claims AS RESTRICTIVE FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM session_work_claim_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.session_work_claim_write_capability'::text, true), ''::text))::uuid))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM session_work_claim_write_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id()) AND (capability.capability_id = (NULLIF(current_setting('opengeni.session_work_claim_write_capability'::text, true), ''::text))::uuid)))));

CREATE POLICY session_work_claims_tenant ON session_work_claims USING (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id()))) WITH CHECK (((account_id = opengeni_private.current_account_id()) AND (workspace_id = opengeni_private.current_workspace_id())));

ALTER TABLE session_workflow_wake_outbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY sessions_automatic_title_quarantine_v1 ON sessions USING (((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('sessions'::regclass)::oid))) AND (current_setting('opengeni.automatic_session_title_quarantine_v1'::text, true) = '1'::text))) WITH CHECK (((CURRENT_USER = ( SELECT pg_get_userbyid(relation.relowner) AS pg_get_userbyid
   FROM pg_class relation
  WHERE (relation.oid = ('sessions'::regclass)::oid))) AND (current_setting('opengeni.automatic_session_title_quarantine_v1'::text, true) = '1'::text)));

CREATE POLICY sessions_variable_set_attachments_protocol_v1 ON sessions AS RESTRICTIVE USING (((current_setting('opengeni.session_variable_set_attachments_v1'::text, true) = '1'::text) OR opengeni_private.session_variable_set_attachments_protocol_v1_active())) WITH CHECK (((current_setting('opengeni.session_variable_set_attachments_v1'::text, true) = '1'::text) OR opengeni_private.session_variable_set_attachments_protocol_v1_active()));

ALTER TABLE site_abuse_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_abuse_reports_owner ON site_abuse_reports FOR SELECT USING ((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('site_abuse_reports'::regclass)::oid)))));

ALTER TABLE site_auth_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_auth_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_collections ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_files ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_rate_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_record_values ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_validation_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_data_workspace_validation_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_hostname_holds ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_hostname_holds_label_lane ON site_hostname_holds FOR SELECT USING ((label = NULLIF(current_setting('opengeni.site_hostname_label'::text, true), ''::text)));

CREATE POLICY site_hostname_holds_owner ON site_hostname_holds USING ((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('site_hostname_holds'::regclass)::oid))))) WITH CHECK ((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('site_hostname_holds'::regclass)::oid)))));

ALTER TABLE site_hostnames ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_hostnames_label_lookup ON site_hostnames FOR SELECT USING ((label = NULLIF(current_setting('opengeni.site_hostname_label'::text, true), ''::text)));

CREATE POLICY site_hostnames_label_takeover ON site_hostnames FOR DELETE USING (((label = NULLIF(current_setting('opengeni.site_hostname_label'::text, true), ''::text)) AND (released_at IS NOT NULL) AND (released_at < (now() - '30 days'::interval))));

ALTER TABLE site_limit_profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_opens ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_platform_brake ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_platform_lane ON site_platform_brake USING ((current_setting('opengeni.site_platform_lane'::text, true) = 'on'::text)) WITH CHECK ((current_setting('opengeni.site_platform_lane'::text, true) = 'on'::text));

CREATE POLICY site_platform_lane ON site_platform_storage USING ((current_setting('opengeni.site_platform_lane'::text, true) = 'on'::text)) WITH CHECK ((current_setting('opengeni.site_platform_lane'::text, true) = 'on'::text));

CREATE POLICY site_platform_lane ON site_platform_totals USING ((current_setting('opengeni.site_platform_lane'::text, true) = 'on'::text)) WITH CHECK ((current_setting('opengeni.site_platform_lane'::text, true) = 'on'::text));

ALTER TABLE site_platform_storage ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_platform_totals ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_platform_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_publications ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_publications_owner ON site_publications FOR SELECT USING ((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('site_publications'::regclass)::oid)))));

ALTER TABLE site_runtime_conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_runtime_rate_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_runtime_usage ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_session_access ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_sidebar_states ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_sql_databases ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_sql_migrations ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_sql_queries ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_sql_rate_windows ENABLE ROW LEVEL SECURITY;

ALTER TABLE site_sql_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY site_viewer_isolation ON sessions AS RESTRICTIVE USING (((site_access_root_id IS NULL) OR (session_site_actor_visible(site_id, site_access_root_id, root_session_id, site_viewer_principal, site_owner_subject_id) OR site_session_cancellation_capability_active(account_id, workspace_id, site_id, site_access_root_id)) OR ( SELECT (opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'titles'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text))))) WITH CHECK (((site_access_root_id IS NULL) OR (session_site_actor_visible(site_id, site_access_root_id, root_session_id, site_viewer_principal, site_owner_subject_id) OR site_session_cancellation_capability_active(account_id, workspace_id, site_id, site_access_root_id)) OR ( SELECT (opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'wakes'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'titles'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'site_auth'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'updates'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'ended_epoch'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'inventory'::text) OR opengeni_private.maintenance_claim_active((CURRENT_USER)::text, 'workspace_commands'::text)))));

ALTER TABLE site_viewer_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE skill_config_conversion_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE skill_source_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY skill_workspace_scope ON skill_config_conversion_receipts USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

CREATE POLICY skill_workspace_scope ON skill_source_bindings USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

CREATE POLICY skill_workspace_scope ON skill_write_receipts USING (((account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid)));

ALTER TABLE skill_write_receipts ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_app_home_refreshes ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_bot_delete_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_bot_post_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_bot_update_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_bot_user_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_channel_routes ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_installation_bindings ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_interaction_action_handles ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_interaction_inbox ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_interaction_progress_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_interactions ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_route_prompt_options ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_route_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY slack_routing_capability_read ON slack_interactions FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('slack_interactions'::regclass)::oid)))) AND opengeni_private.slack_routing_capability_active()));

ALTER TABLE slack_shared_task_origins ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_task_policy_activation_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_task_policy_heads ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_task_policy_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_user_dm_routes ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_user_link_access_request_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE slack_user_link_access_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;

ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_account_workspace_scope ON subscription_capacity_waiters USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))));

CREATE POLICY subscription_account_workspace_scope ON subscription_leases USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))));

CREATE POLICY subscription_account_workspace_scope ON subscription_session_bindings USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))));

CREATE POLICY subscription_account_workspace_scope ON subscription_turn_failures USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))));

CREATE POLICY subscription_admin_self_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND ((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND (subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND (status = 'active'::text) AND (revoked_at IS NULL) AND (role = ANY (ARRAY['owner'::text, 'admin'::text]))));

ALTER TABLE subscription_apps_designations ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_apps_designations_admin ON subscription_apps_designations USING (opengeni_private.subscription_apps_designation_manage_allowed(account_id, workspace_id, connection_id)) WITH CHECK (opengeni_private.subscription_apps_designation_allowed(account_id, workspace_id, connection_id));

CREATE POLICY subscription_apps_designations_scope ON subscription_apps_designations FOR SELECT USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))));

ALTER TABLE subscription_capacity_waiters ENABLE ROW LEVEL SECURITY;

ALTER TABLE subscription_capacity_wake_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_capacity_wake_outbox_service ON subscription_capacity_wake_outbox USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)) AND (NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)) AND (NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text) IS NULL)));

CREATE POLICY subscription_codex_disconnect_designation ON subscription_apps_designations FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_apps_designations'::regclass)::oid)))) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_codex_disconnect_designation_read ON subscription_apps_designations FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_apps_designations'::regclass)::oid)))) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_codex_expired_lease_delete ON subscription_leases FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_codex_expired_lease_delete ON subscription_operation_leases FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_operation_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_codex_expired_lease_read ON subscription_leases FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_codex_expired_lease_read ON subscription_operation_leases FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_operation_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_codex_owner_alias_read ON subscription_connection_aliases FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_aliases'::regclass)::oid)))) AND (provider = 'codex'::text) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, connection_id, true)));

CREATE POLICY subscription_codex_owner_authority_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (resource_kind = 'subscription_connection'::text) AND (status = 'active'::text) AND opengeni_private.subscription_codex_owner_membership_held(account_id, organization_membership_id)));

CREATE POLICY subscription_codex_owner_authority_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (resource_kind = 'subscription_connection'::text) AND opengeni_private.subscription_codex_owner_membership_held(account_id, organization_membership_id)));

CREATE POLICY subscription_codex_owner_authority_revoke ON organization_user_resource_authorities FOR UPDATE USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (resource_kind = 'subscription_connection'::text) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, resource_id, false))) WITH CHECK ((status = 'revoked'::text));

CREATE POLICY subscription_codex_owner_connections ON subscription_connections USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connections'::regclass)::oid)))) AND (provider = 'codex'::text) AND (ownership = 'personal'::text) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], owner_subject_id, id, true))) WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connections'::regclass)::oid)))) AND (provider = 'codex'::text) AND (ownership = 'personal'::text) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], owner_subject_id, id, true)));

CREATE POLICY subscription_codex_owner_membership_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_memberships'::regclass)::oid)))) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], subject_id, NULL::uuid, false)));

CREATE POLICY subscription_codex_owner_settings ON subscription_settings USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_settings'::regclass)::oid)))) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text], NULL::text, NULL::uuid, false) AND (cardinality(locked_settings) = 0)));

CREATE POLICY subscription_codex_reset_ledger_fence ON codex_reset_redemption_attempts USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('codex_reset_redemption_attempts'::regclass)::oid)))) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_connection_owner'::text, 'codex_reset_credit_fence'::text], NULL::text, credential_id, false))) WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('codex_reset_redemption_attempts'::regclass)::oid)))) AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY['codex_reset_credit_fence'::text], NULL::text, credential_id, false)));

ALTER TABLE subscription_connection_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_connection_aliases_runtime_read ON subscription_connection_aliases FOR SELECT USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND (provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])) AND (EXISTS ( SELECT 1
   FROM subscription_connections connection
  WHERE ((connection.account_id = subscription_connection_aliases.account_id) AND (connection.provider = subscription_connection_aliases.provider) AND (connection.id = subscription_connection_aliases.connection_id) AND opengeni_private.subscription_connection_visible(connection.account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, connection.id, connection.ownership, connection.scope_kind, connection.owner_organization_membership_id, connection.owner_subject_id, connection.provider))))));

CREATE POLICY subscription_connection_aliases_scope ON subscription_connection_aliases USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

ALTER TABLE subscription_connection_assignment_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_connection_assignment_policies_core_auto_assign ON subscription_connection_assignment_policies USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_assignment_policies'::regclass)::oid)))) AND (current_setting('opengeni.subscription_core_auto_assign'::text, true) = (account_id)::text))) WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_assignment_policies'::regclass)::oid)))) AND (current_setting('opengeni.subscription_core_auto_assign'::text, true) = (account_id)::text)));

CREATE POLICY subscription_connection_assignment_policy_manage ON subscription_connection_assignment_policies USING (((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)) OR ((workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (managed_by_workspace_id = workspace_id) AND opengeni_private.subscription_apps_designation_manage_allowed(account_id, workspace_id, connection_id) AND (EXISTS ( SELECT 1
   FROM workspace_memberships manager
  WHERE ((manager.account_id = subscription_connection_assignment_policies.account_id) AND (manager.workspace_id = subscription_connection_assignment_policies.workspace_id) AND (manager.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions))))))) WITH CHECK (((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)) OR ((workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (managed_by_workspace_id = workspace_id) AND opengeni_private.subscription_apps_designation_manage_allowed(account_id, workspace_id, connection_id) AND (EXISTS ( SELECT 1
   FROM workspace_memberships manager
  WHERE ((manager.account_id = subscription_connection_assignment_policies.account_id) AND (manager.workspace_id = subscription_connection_assignment_policies.workspace_id) AND (manager.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions)))))));

CREATE POLICY subscription_connection_assignment_policy_runtime_read ON subscription_connection_assignment_policies FOR SELECT USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM subscription_connections connection
  WHERE ((connection.account_id = subscription_connection_assignment_policies.account_id) AND (connection.id = subscription_connection_assignment_policies.connection_id) AND opengeni_private.subscription_connection_visible(connection.account_id, subscription_connection_assignment_policies.workspace_id, connection.id, connection.ownership, connection.scope_kind, connection.owner_organization_membership_id, connection.owner_subject_id, connection.provider))))));

ALTER TABLE subscription_connection_people ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_connection_people_admin ON subscription_connection_people USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_connection_people_designation_read ON subscription_connection_people FOR SELECT USING (opengeni_private.subscription_people_designation_visible(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, connection_id));

CREATE POLICY subscription_connection_people_own_read ON subscription_connection_people FOR SELECT USING ((organization_membership_id = opengeni_private.subscription_own_person_membership_id(account_id)));

CREATE POLICY subscription_connection_people_scope ON subscription_connection_people FOR SELECT USING (opengeni_private.subscription_people_assignment_visible(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, organization_membership_id, NULLIF(current_setting('opengeni.session_owner_subject_id'::text, true), ''::text), NULLIF(current_setting('opengeni.turn_human_subject_id'::text, true), ''::text)));

ALTER TABLE subscription_connection_quota ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_connection_quota_scope ON subscription_connection_quota USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM subscription_connections connection
  WHERE ((connection.account_id = connection.account_id) AND (connection.id = subscription_connection_quota.connection_id)))))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1
   FROM subscription_connections connection
  WHERE ((connection.account_id = connection.account_id) AND (connection.id = subscription_connection_quota.connection_id))))));

ALTER TABLE subscription_connection_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_connection_workspaces_admin ON subscription_connection_workspaces USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_connection_workspaces_core_auto_assign ON subscription_connection_workspaces USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_workspaces'::regclass)::oid)))) AND (current_setting('opengeni.subscription_core_auto_assign'::text, true) = (account_id)::text))) WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_workspaces'::regclass)::oid)))) AND (current_setting('opengeni.subscription_core_auto_assign'::text, true) = (account_id)::text)));

CREATE POLICY subscription_connection_workspaces_scope ON subscription_connection_workspaces FOR SELECT USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))));

CREATE POLICY subscription_connection_workspaces_workspace_admin ON subscription_connection_workspaces FOR INSERT WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND opengeni_private.subscription_apps_designation_manage_allowed(account_id, workspace_id, connection_id)));

ALTER TABLE subscription_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_connections_codex_refresh_read ON subscription_connections FOR SELECT USING (((provider = 'codex'::text) AND opengeni_private.subscription_codex_refresh_write_allowed(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id)));

CREATE POLICY subscription_connections_codex_refresh_update ON subscription_connections FOR UPDATE USING (((provider = 'codex'::text) AND opengeni_private.subscription_codex_refresh_write_allowed(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id))) WITH CHECK (((provider = 'codex'::text) AND opengeni_private.subscription_codex_refresh_write_allowed(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id)));

CREATE POLICY subscription_connections_delete_admin ON subscription_connections FOR DELETE USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_connections_insert_admin ON subscription_connections FOR INSERT WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)));

CREATE POLICY subscription_connections_insert_workspace_admin ON subscription_connections FOR INSERT WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND (ownership = 'shared'::text) AND (scope_kind = 'workspaces'::text) AND (allow_personal_workspaces = false) AND (owner_organization_membership_id IS NULL) AND (owner_subject_id IS NULL) AND (managed_by_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (EXISTS ( SELECT 1
   FROM workspace_memberships grant_row
  WHERE ((grant_row.account_id = subscription_connections.account_id) AND (grant_row.workspace_id = subscription_connections.managed_by_workspace_id) AND (grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions))))));

CREATE POLICY subscription_connections_membership_lifecycle ON subscription_connections FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT lifecycle.proowner
   FROM pg_proc lifecycle
  WHERE (lifecycle.oid = (to_regprocedure('finalize_organization_retention_deletion(uuid,uuid,uuid,text)'::text))::oid)))) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)));

CREATE POLICY subscription_connections_membership_lifecycle_read ON subscription_connections FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT lifecycle.proowner
   FROM pg_proc lifecycle
  WHERE (lifecycle.oid = (to_regprocedure('finalize_organization_retention_deletion(uuid,uuid,uuid,text)'::text))::oid)))) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'organization_membership_lifecycle'::text)));

CREATE POLICY subscription_connections_own_people_read ON subscription_connections FOR SELECT USING (((ownership = 'shared'::text) AND (scope_kind = 'people'::text) AND (EXISTS ( SELECT 1
   FROM subscription_connection_people assignment
  WHERE ((assignment.account_id = subscription_connections.account_id) AND (assignment.connection_id = subscription_connections.id) AND (assignment.organization_membership_id = opengeni_private.subscription_own_person_membership_id(subscription_connections.account_id)))))));

CREATE POLICY subscription_connections_receipt_insert ON subscription_connections AS RESTRICTIVE FOR INSERT WITH CHECK (opengeni_private.subscription_provider_cutover_committed(provider));

CREATE POLICY subscription_connections_scope ON subscription_connections FOR SELECT USING ((((ownership = 'shared'::text) AND (((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false))) OR opengeni_private.subscription_connection_visible(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id, ownership, scope_kind, owner_organization_membership_id, owner_subject_id, provider)));

CREATE POLICY subscription_connections_update_scope ON subscription_connections FOR UPDATE USING ((((ownership = 'shared'::text) AND (((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false))) OR ((ownership = 'shared'::text) AND opengeni_private.subscription_connection_visible(account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id, ownership, scope_kind, owner_organization_membership_id, owner_subject_id, provider) AND (managed_by_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (EXISTS ( SELECT 1
   FROM workspace_memberships grant_row
  WHERE ((grant_row.account_id = subscription_connections.account_id) AND (grant_row.workspace_id = subscription_connections.managed_by_workspace_id) AND (grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions))))))) WITH CHECK (((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND COALESCE(( SELECT opengeni_private.subscription_organization_admin((admin_scope.account_setting)::uuid) AS subscription_organization_admin
   FROM ( SELECT NULLIF(current_setting('opengeni.account_id'::text, true), ''::text) AS account_setting) admin_scope
  WHERE (admin_scope.account_setting ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)), false)) OR ((managed_by_workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND (ownership = 'shared'::text) AND (EXISTS ( SELECT 1
   FROM workspace_memberships grant_row
  WHERE ((grant_row.account_id = subscription_connections.account_id) AND (grant_row.workspace_id = subscription_connections.managed_by_workspace_id) AND (grant_row.subject_id = NULLIF(current_setting('opengeni.subject_id'::text, true), ''::text)) AND opengeni_private.workspace_membership_administers(grant_row.role, grant_row.permissions)))))));

CREATE POLICY subscription_core_capability_authority_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (EXISTS ( SELECT 1
   FROM opengeni_private.subscription_runtime_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id_if_assigned()) AND (capability.capability_kind = ANY (ARRAY['personal_access'::text, 'binding_access'::text, 'lifecycle'::text])) AND (capability.account_id = organization_user_resource_authorities.account_id))))));

CREATE POLICY subscription_core_capability_membership_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_memberships'::regclass)::oid)))) AND (EXISTS ( SELECT 1
   FROM opengeni_private.subscription_runtime_capabilities capability
  WHERE ((capability.backend_pid = pg_backend_pid()) AND (capability.transaction_id = pg_current_xact_id_if_assigned()) AND (capability.capability_kind = ANY (ARRAY['personal_access'::text, 'session_access'::text, 'binding_access'::text, 'lifecycle'::text, 'designation_management'::text])) AND (capability.account_id = organization_memberships.account_id))))));

CREATE POLICY subscription_core_disconnect_designation ON subscription_apps_designations FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_apps_designations'::regclass)::oid)))) AND opengeni_private.subscription_core_owner_capability_held(NULL::text, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_disconnect_designation_read ON subscription_apps_designations FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_apps_designations'::regclass)::oid)))) AND opengeni_private.subscription_core_owner_capability_held(NULL::text, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_expired_lease_delete ON subscription_leases FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_expired_lease_delete ON subscription_operation_leases FOR DELETE USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_operation_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_expired_lease_read ON subscription_leases FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_expired_lease_read ON subscription_operation_leases FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_operation_leases'::regclass)::oid)))) AND (leased_until <= clock_timestamp()) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_owner_alias_read ON subscription_connection_aliases FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_aliases'::regclass)::oid)))) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, true)));

CREATE POLICY subscription_core_owner_authority_insert ON organization_user_resource_authorities FOR INSERT WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (resource_kind = 'subscription_connection'::text) AND (status = 'active'::text) AND opengeni_private.subscription_core_owner_membership_held(account_id, organization_membership_id)));

CREATE POLICY subscription_core_owner_authority_read ON organization_user_resource_authorities FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (resource_kind = 'subscription_connection'::text) AND opengeni_private.subscription_core_owner_membership_held(account_id, organization_membership_id)));

CREATE POLICY subscription_core_owner_authority_revoke ON organization_user_resource_authorities FOR UPDATE USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_user_resource_authorities'::regclass)::oid)))) AND (resource_kind = 'subscription_connection'::text) AND opengeni_private.subscription_core_owner_capability_held(NULL::text, account_id, ARRAY['connection_owner'::text], NULL::text, resource_id, false))) WITH CHECK ((status = 'revoked'::text));

CREATE POLICY subscription_core_owner_connection_workspaces_read ON subscription_connection_workspaces FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connection_workspaces'::regclass)::oid)))) AND opengeni_private.subscription_core_owner_capability_held(NULL::text, account_id, ARRAY['connection_owner'::text], NULL::text, connection_id, false)));

CREATE POLICY subscription_core_owner_connections ON subscription_connections USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connections'::regclass)::oid)))) AND (ownership = 'personal'::text) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], owner_subject_id, id, true))) WITH CHECK (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('subscription_connections'::regclass)::oid)))) AND (ownership = 'personal'::text) AND opengeni_private.subscription_core_owner_capability_held(provider, account_id, ARRAY['connection_owner'::text], owner_subject_id, id, true)));

CREATE POLICY subscription_core_owner_membership_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = pg_get_userbyid(( SELECT relation.relowner
   FROM pg_class relation
  WHERE (relation.oid = ('organization_memberships'::regclass)::oid)))) AND opengeni_private.subscription_core_owner_capability_held(NULL::text, account_id, ARRAY['connection_owner'::text], subject_id, NULL::uuid, false)));

CREATE POLICY subscription_core_owner_settings ON subscription_settings USING (((CURRENT_USER = pg_get_userbyid(( SELECT pg_class.relowner
   FROM pg_class
  WHERE (pg_class.oid = ('subscription_settings'::regclass)::oid)))) AND (workspace_id = (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid) AND opengeni_private.subscription_core_owner_capability_held(NULL::text, account_id, ARRAY['connection_owner'::text], NULL::text, NULL::uuid, false) AND (cardinality(locked_settings) = 0)));

CREATE POLICY subscription_core_refresh_read ON subscription_connections FOR SELECT USING (opengeni_private.subscription_core_refresh_write_allowed(provider, account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id));

CREATE POLICY subscription_core_refresh_update ON subscription_connections FOR UPDATE USING (opengeni_private.subscription_core_refresh_write_allowed(provider, account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id)) WITH CHECK (opengeni_private.subscription_core_refresh_write_allowed(provider, account_id, (NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text))::uuid, id));

ALTER TABLE subscription_leases ENABLE ROW LEVEL SECURITY;

ALTER TABLE subscription_operation_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_operation_leases_scope ON subscription_operation_leases USING ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)) AND ((session_id IS NULL) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_operation_leases.account_id) AND (session_row.workspace_id = subscription_operation_leases.workspace_id) AND (session_row.id = subscription_operation_leases.session_id))
 OFFSET 0)))))) WITH CHECK ((((account_id)::text = NULLIF(current_setting('opengeni.account_id'::text, true), ''::text)) AND ((workspace_id)::text = NULLIF(current_setting('opengeni.workspace_id'::text, true), ''::text)) AND ((session_id IS NULL) OR ((session_id IS NULL) OR (EXISTS ( SELECT 1
   FROM sessions session_row
  WHERE ((session_row.account_id = subscription_operation_leases.account_id) AND (session_row.workspace_id = subscription_operation_leases.workspace_id) AND (session_row.id = subscription_operation_leases.session_id))
 OFFSET 0))))));

CREATE POLICY subscription_own_person_membership_read ON organization_memberships FOR SELECT USING (((CURRENT_USER = '{{owner}}'::name) AND (current_setting('opengeni.organization_tenancy_lifecycle'::text, true) = 'subscription_own_person_membership'::text) AND (account_id = (NULLIF(current_setting('opengeni.account_id'::text, true), ''::text))::uuid) AND (subject_id = opengeni_private.current_subject_id())));

ALTER TABLE subscription_person_preferences ENABLE ROW LEVEL SECURITY;
