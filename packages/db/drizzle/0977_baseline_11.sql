-- deployment-mode: rolling
-- Opengeni baseline part 11 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE TRIGGER files_personal_owner_immutable BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION knowledge_file_owner_immutable();

CREATE TRIGGER governed_learning_activation_receipts_immutable BEFORE DELETE OR UPDATE ON governed_learning_activation_receipts FOR EACH ROW EXECUTE FUNCTION governed_learning_reject_activation_receipt_mutation();

CREATE TRIGGER governed_learning_activation_undo_receipts_immutable BEFORE DELETE OR UPDATE ON governed_learning_activation_undo_receipts FOR EACH ROW EXECUTE FUNCTION governed_learning_reject_activation_receipt_mutation();

CREATE TRIGGER governed_learning_decision_receipts_immutable BEFORE DELETE OR UPDATE ON governed_learning_decision_receipts FOR EACH ROW EXECUTE FUNCTION reject_governed_learning_decision_receipt_mutation();

CREATE TRIGGER guard_tenancy_backfill_unresolved_row BEFORE DELETE OR UPDATE ON tenancy_backfill_unresolved_rows FOR EACH ROW EXECUTE FUNCTION guard_tenancy_backfill_unresolved_row();

CREATE TRIGGER host_export_consumers_lossless_legacy_update_fence BEFORE UPDATE OF last_error ON host_export_consumers FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER host_export_dead_letters_lossless_legacy_update_fence BEFORE UPDATE OF envelope ON host_export_dead_letters FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER host_export_outbox_capture_root_session BEFORE INSERT ON host_export_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_host_export_root_session();

CREATE TRIGGER host_export_outbox_lossless_legacy_update_fence BEFORE UPDATE OF payload ON host_export_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER host_mcp_binding_immutable BEFORE UPDATE ON host_mcp_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_binding_update();

CREATE TRIGGER host_mcp_child_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities FOR EACH ROW WHEN (((new.canonical_snapshot #>> '{source,kind}'::text[]) = 'child_turn'::text)) EXECUTE FUNCTION opengeni_private.guard_host_mcp_child_turn_authority();

CREATE TRIGGER host_mcp_delegation_guard BEFORE INSERT OR UPDATE ON host_mcp_delegations FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_delegation();

CREATE TRIGGER host_mcp_inherited_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities FOR EACH ROW WHEN (((new.canonical_snapshot #>> '{source,kind}'::text[]) = 'inherited_turn'::text)) EXECUTE FUNCTION opengeni_private.guard_host_mcp_inherited_turn_authority();

CREATE TRIGGER host_mcp_resolver_operation_write BEFORE INSERT ON host_mcp_resolver_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_resolver_write();

CREATE TRIGGER host_mcp_resolver_write BEFORE INSERT OR UPDATE ON host_mcp_resolvers FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_resolver_write();

CREATE TRIGGER host_mcp_scheduled_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities FOR EACH ROW WHEN (((new.canonical_snapshot #>> '{source,kind}'::text[]) = 'scheduled_task'::text)) EXECUTE FUNCTION opengeni_private.guard_host_mcp_scheduled_turn_authority();

CREATE TRIGGER host_mcp_task_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_task_authorities FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_host_mcp_task_authority();

CREATE TRIGGER host_mcp_turn_authority_guard BEFORE INSERT OR UPDATE ON host_mcp_turn_authorities FOR EACH ROW WHEN ((((new.canonical_snapshot #>> '{source,kind}'::text[]) IS DISTINCT FROM 'inherited_turn'::text) AND ((new.canonical_snapshot #>> '{source,kind}'::text[]) IS DISTINCT FROM 'scheduled_task'::text) AND ((new.canonical_snapshot #>> '{source,kind}'::text[]) IS DISTINCT FROM 'child_turn'::text))) EXECUTE FUNCTION opengeni_private.guard_host_mcp_turn_authority();

CREATE TRIGGER inbox_execution_context_fence BEFORE INSERT OR UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_inbox_execution_context();

CREATE TRIGGER insights_usage_hourly_maintain AFTER INSERT OR DELETE OR UPDATE ON model_call_facts FOR EACH ROW EXECUTE FUNCTION opengeni_insights_internal.insights_usage_hourly_maintain();

CREATE TRIGGER integration_facet_binding_owners_validate BEFORE INSERT OR UPDATE ON integration_facet_binding_owners FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_facet_binding_owner();

CREATE TRIGGER integration_facet_bindings_validate BEFORE INSERT OR UPDATE ON integration_facet_bindings FOR EACH ROW EXECUTE FUNCTION capability_v2_validate_facet_binding();

CREATE TRIGGER integration_spec_revisions_immutable BEFORE UPDATE ON integration_spec_revisions FOR EACH ROW EXECUTE FUNCTION capability_v2_reject_immutable_update();

CREATE TRIGGER knowledge_change_proposals_immutable BEFORE DELETE OR UPDATE ON knowledge_change_proposals FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_claim_evidence_15_validate_task_note BEFORE INSERT ON knowledge_claim_evidence FOR EACH ROW EXECUTE FUNCTION validate_task_note_knowledge_evidence();

CREATE TRIGGER knowledge_claim_evidence_20_validate_bridge BEFORE INSERT ON knowledge_claim_evidence FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_bridge();

CREATE TRIGGER knowledge_claim_evidence_immutable BEFORE DELETE OR UPDATE ON knowledge_claim_evidence FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_claim_relations_immutable BEFORE DELETE OR UPDATE ON knowledge_claim_relations FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_claim_relations_validate BEFORE INSERT ON knowledge_claim_relations FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_claim_relation();

CREATE TRIGGER knowledge_claim_reviews_05_governed_learning_guard BEFORE INSERT ON knowledge_claim_reviews FOR EACH ROW EXECUTE FUNCTION governed_learning_guard_service_review();

CREATE TRIGGER knowledge_claim_reviews_immutable BEFORE DELETE OR UPDATE ON knowledge_claim_reviews FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_claims_immutable BEFORE DELETE OR UPDATE ON knowledge_claims FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_document_versions_10_generation_guard BEFORE INSERT ON knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_version_insert();

CREATE TRIGGER knowledge_document_versions_20_validate_bridge BEFORE INSERT ON knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_bridge();

CREATE TRIGGER knowledge_document_versions_immutable BEFORE DELETE OR UPDATE ON knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_entities_immutable BEFORE DELETE OR UPDATE ON knowledge_entities FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_entity_aliases_immutable BEFORE DELETE OR UPDATE ON knowledge_entity_aliases FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_facts_immutable BEFORE DELETE OR UPDATE ON knowledge_facts FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON agent_instruction_operations FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON agent_learning_revisions FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON agent_learning_snapshots FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON knowledge_entry_decisions FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON knowledge_entry_links FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON knowledge_entry_operations FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_immutable BEFORE DELETE OR UPDATE ON knowledge_entry_revisions FOR EACH ROW EXECUTE FUNCTION knowledge_reject_history_mutation();

CREATE TRIGGER knowledge_index_attribution_immutable BEFORE UPDATE ON knowledge_index_jobs FOR EACH ROW EXECUTE FUNCTION knowledge_index_attribution_immutable();

CREATE TRIGGER knowledge_learning_events_retired BEFORE INSERT OR DELETE OR UPDATE ON workspace_learning_policy_activation_events FOR EACH ROW EXECUTE FUNCTION knowledge_retired_learning_read_only();

CREATE TRIGGER knowledge_learning_heads_retired BEFORE INSERT OR DELETE OR UPDATE ON workspace_learning_policy_heads FOR EACH ROW EXECUTE FUNCTION knowledge_retired_learning_read_only();

CREATE TRIGGER knowledge_learning_revisions_retired BEFORE INSERT OR DELETE OR UPDATE ON workspace_learning_policy_revisions FOR EACH ROW EXECUTE FUNCTION knowledge_retired_learning_read_only();

CREATE TRIGGER knowledge_legacy_memory_setting_retired BEFORE UPDATE OF settings ON workspaces FOR EACH ROW EXECUTE FUNCTION knowledge_legacy_memory_setting_retired();

CREATE TRIGGER knowledge_lifecycle_events_immutable BEFORE DELETE OR UPDATE ON knowledge_lifecycle_events FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_memories_lossless_legacy_update_fence BEFORE UPDATE OF text ON knowledge_memories FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER knowledge_memories_retired BEFORE INSERT OR DELETE OR UPDATE ON knowledge_memories FOR EACH ROW EXECUTE FUNCTION knowledge_retired_memory_read_only();

CREATE TRIGGER knowledge_memories_row_guard BEFORE INSERT OR UPDATE ON knowledge_memories FOR EACH ROW EXECUTE FUNCTION opengeni_private.knowledge_memory_row_guard();

CREATE TRIGGER knowledge_memory_lifecycle_events_immutable BEFORE DELETE OR UPDATE ON knowledge_memory_lifecycle_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.immutable_memory_lifecycle_event();

CREATE TRIGGER knowledge_memory_relationships_guard BEFORE DELETE OR UPDATE ON knowledge_memory_relationships FOR EACH ROW EXECUTE FUNCTION opengeni_private.knowledge_memory_relationship_guard();

CREATE TRIGGER knowledge_operation_receipts_immutable BEFORE DELETE OR UPDATE ON knowledge_operation_receipts FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_providers_10_initial_guard BEFORE INSERT ON knowledge_providers FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_head_insert();

CREATE TRIGGER knowledge_providers_lifecycle_only BEFORE DELETE OR UPDATE ON knowledge_providers FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_provider_mutation();

CREATE TRIGGER knowledge_query_billing_receipt_immutable BEFORE UPDATE ON usage_events FOR EACH ROW EXECUTE FUNCTION knowledge_query_billing_receipt_immutable();

CREATE TRIGGER knowledge_revision_index_queue AFTER INSERT ON knowledge_entry_revisions FOR EACH ROW EXECUTE FUNCTION knowledge_enqueue_index();

CREATE TRIGGER knowledge_source_acl_versions_10_generation_guard BEFORE INSERT ON knowledge_source_acl_versions FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_acl_insert();

CREATE TRIGGER knowledge_source_acl_versions_immutable BEFORE DELETE OR UPDATE ON knowledge_source_acl_versions FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_reject_immutable_mutation();

CREATE TRIGGER knowledge_source_index_ready AFTER UPDATE OF status, acl_eligibility, google_drive_acl_evidence_id ON knowledge_source_sync_index_obligations FOR EACH ROW EXECUTE FUNCTION knowledge_source_index_wake();

CREATE TRIGGER knowledge_source_objects_10_initial_guard BEFORE INSERT ON knowledge_source_objects FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_head_insert();

CREATE TRIGGER knowledge_source_objects_20_validate_bridge BEFORE INSERT ON knowledge_source_objects FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_validate_bridge();

CREATE TRIGGER knowledge_source_objects_mutation_guard BEFORE DELETE OR UPDATE ON knowledge_source_objects FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_object_mutation();

CREATE TRIGGER knowledge_sources_10_initial_guard BEFORE INSERT ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_head_insert();

CREATE TRIGGER knowledge_sources_mutation_guard BEFORE DELETE OR UPDATE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_source_mutation();

CREATE TRIGGER knowledge_sync_runs_10_generation_guard BEFORE INSERT ON knowledge_sync_runs FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_sync_insert();

CREATE TRIGGER knowledge_sync_runs_completion_only BEFORE DELETE OR UPDATE ON knowledge_sync_runs FOR EACH ROW EXECUTE FUNCTION scoped_knowledge_guard_sync_mutation();

CREATE TRIGGER lock_nested_agent_workspace_policy_update BEFORE UPDATE OF settings ON workspaces FOR EACH ROW EXECUTE FUNCTION opengeni_private.lock_nested_agent_workspace_policy_update();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON browser_sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_browser_sessions_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_enrollments_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON rig_changes FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_rig_changes_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON rig_versions FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_rig_versions_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON sandbox_checkpoint_artifacts FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON sandbox_lease_holders FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_lease_holders_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_leases_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_retained_processes_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON sandbox_workspace_mutation_admissions FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_workspace_mutation_admissions_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON session_background_commands FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_session_background_commands_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON session_list_snapshots FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_session_list_snapshots_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_session_system_update_outbox_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_session_turns_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON session_workflow_wake_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_session_workflow_wake_outbox_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_sessions_sync();

CREATE TRIGGER maintenance_probe_sync AFTER INSERT OR DELETE OR UPDATE ON site_auth_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.maintenance_probe_site_auth_connections_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON browser_sessions FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_browser_sessions_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON enrollments FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_enrollments_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON rig_changes FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_rig_changes_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON rig_versions FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_rig_versions_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON sandbox_checkpoint_artifacts FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_checkpoint_artifacts_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON sandbox_lease_holders FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_lease_holders_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON sandbox_leases FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_leases_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON sandbox_retained_processes FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_retained_processes_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON sandbox_workspace_mutation_admissions FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_sandbox_workspace_mutation_admissions_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON session_background_commands FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_session_background_commands_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON session_list_snapshots FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_session_list_snapshots_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON session_system_update_outbox FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_session_system_update_outbox_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON session_turns FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_session_turns_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON session_workflow_wake_outbox FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_session_workflow_wake_outbox_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON sessions FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_sessions_sync();

CREATE TRIGGER maintenance_probe_truncate AFTER TRUNCATE ON site_auth_connections FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintenance_probe_site_auth_connections_sync();

CREATE TRIGGER managed_accounts_initialize_company_profile_agent_policy AFTER INSERT ON managed_accounts FOR EACH ROW EXECUTE FUNCTION initialize_company_profile_agent_policy();

CREATE TRIGGER managed_accounts_subscription_codex_cutover_seed AFTER INSERT ON managed_accounts FOR EACH ROW EXECUTE FUNCTION opengeni_private.seed_subscription_codex_cutover();

CREATE TRIGGER managed_auth_session_exact_binding_stamp BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION managed_auth_session_exact_binding_stamp();

CREATE TRIGGER managed_auth_session_set_operations_append_only BEFORE DELETE OR UPDATE ON managed_auth_session_set_operations FOR EACH ROW EXECUTE FUNCTION managed_auth_session_set_operations_append_only();

CREATE TRIGGER managed_auth_session_slot_invalidation BEFORE DELETE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION managed_auth_session_slot_invalidation();

CREATE TRIGGER managed_social_account_binding AFTER INSERT ON auth_identities FOR EACH ROW EXECUTE FUNCTION bind_managed_social_account();

CREATE TRIGGER managed_social_account_guard BEFORE INSERT ON auth_identities FOR EACH ROW EXECUTE FUNCTION guard_managed_social_account();

CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT ON scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT ON session_system_updates FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence_update BEFORE UPDATE ON scheduled_task_runs FOR EACH ROW WHEN ((old.accepted_execution_snapshot IS DISTINCT FROM new.accepted_execution_snapshot)) EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence_update BEFORE UPDATE ON session_system_update_outbox FOR EACH ROW WHEN (((old.mcp_account_bindings IS DISTINCT FROM new.mcp_account_bindings) OR (old.personal_connection_delegations IS DISTINCT FROM new.personal_connection_delegations))) EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence_update BEFORE UPDATE ON session_system_updates FOR EACH ROW WHEN (((old.mcp_account_bindings IS DISTINCT FROM new.mcp_account_bindings) OR (old.personal_connection_delegations IS DISTINCT FROM new.personal_connection_delegations))) EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence_update BEFORE UPDATE ON session_turns FOR EACH ROW WHEN (((old.mcp_account_bindings IS DISTINCT FROM new.mcp_account_bindings) OR (old.personal_connection_delegations IS DISTINCT FROM new.personal_connection_delegations))) EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_account_bindings_fence_update BEFORE UPDATE ON sessions FOR EACH ROW WHEN (((old.initial_mcp_account_bindings IS DISTINCT FROM new.initial_mcp_account_bindings) OR (old.initial_personal_connection_delegations IS DISTINCT FROM new.initial_personal_connection_delegations) OR (old.visibility IS DISTINCT FROM new.visibility))) EXECUTE FUNCTION opengeni_private.fence_mcp_account_bindings();

CREATE TRIGGER mcp_operation_immutable BEFORE UPDATE ON mcp_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_mcp_operation_immutable();

CREATE TRIGGER memory_slack_publication_configurations_immutable BEFORE DELETE OR UPDATE ON memory_slack_publication_configurations FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_memory_slack_immutable_mutation();

CREATE TRIGGER memory_slack_publication_receipts_immutable BEFORE DELETE OR UPDATE ON memory_slack_publication_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_memory_slack_immutable_mutation();

CREATE TRIGGER memory_slack_publications_identity_immutable BEFORE UPDATE ON memory_slack_publications FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_memory_slack_publication_identity();

CREATE TRIGGER model_call_site_attribution BEFORE INSERT OR UPDATE ON model_call_facts FOR EACH ROW EXECUTE FUNCTION stamp_model_call_site();

CREATE TRIGGER model_call_unbilled_allowance_cost_fill AFTER UPDATE OF estimated_provider_cost_micros ON model_call_facts FOR EACH ROW WHEN (((old.estimated_provider_cost_micros IS NULL) AND (new.priced_cost_micros = 0) AND (new.estimated_provider_cost_micros > 0))) EXECUTE FUNCTION count_unbilled_model_allowance_debit();

CREATE TRIGGER model_call_unbilled_allowance_debit AFTER INSERT ON model_call_facts FOR EACH ROW WHEN (((new.priced_cost_micros = 0) AND (new.estimated_provider_cost_micros > 0))) EXECUTE FUNCTION count_unbilled_model_allowance_debit();

CREATE TRIGGER model_connection_access_update_guard BEFORE UPDATE ON claude_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_model_connection_access_update();

CREATE TRIGGER model_connection_access_update_guard BEFORE UPDATE ON codex_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_model_connection_access_update();

CREATE TRIGGER model_connection_access_update_guard BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_model_connection_access_update();

CREATE TRIGGER model_connection_access_update_guard BEFORE UPDATE ON organization_model_provider_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_model_connection_access_update();

CREATE TRIGGER model_connection_access_update_guard BEFORE UPDATE ON xai_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_model_connection_access_update();

CREATE TRIGGER model_debit_site_attribution BEFORE INSERT OR UPDATE ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION stamp_model_debit_site();

CREATE TRIGGER model_fact_reconciliation_event_arrival AFTER INSERT ON session_events FOR EACH ROW WHEN ((new.type = 'agent.model.usage'::text)) EXECUTE FUNCTION model_fact_reconciliation_enqueue();

CREATE TRIGGER model_fact_reconciliation_ledger_arrival AFTER INSERT OR UPDATE OF session_id, turn_id, source_resource_type, source_resource_id, event_type ON usage_events FOR EACH ROW WHEN ((new.event_type = 'model.cost'::text)) EXECUTE FUNCTION model_fact_reconciliation_enqueue();

CREATE TRIGGER new_session_drafts_project_provenance_v1_fence BEFORE INSERT OR UPDATE ON new_session_drafts FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_new_session_draft_project_provenance_v1();

CREATE TRIGGER normalize_legacy_member_connection_read_0516 BEFORE INSERT OR UPDATE ON workspace_memberships FOR EACH ROW EXECUTE FUNCTION opengeni_private.normalize_legacy_member_connection_read_0516();

CREATE TRIGGER organization_codex_rotation_settings_credential_guard BEFORE INSERT OR UPDATE OF active_credential_id, account_id ON organization_codex_rotation_settings FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace();

CREATE TRIGGER organization_company_profile_agent_policy_events_immutable BEFORE DELETE OR UPDATE ON organization_company_profile_agent_policy_events FOR EACH ROW EXECUTE FUNCTION company_profile_agent_policy_events_immutable();

CREATE TRIGGER organization_invitation_binding_events_immutable BEFORE DELETE OR UPDATE ON organization_invitation_binding_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_invitations_plan_seat_limit BEFORE INSERT OR UPDATE OF status, expires_at, target_subject_id, account_id ON organization_membership_invitations FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_organization_plan_seats();

CREATE TRIGGER organization_membership_external_lifecycle AFTER UPDATE OF status, authorization_revision ON organization_memberships FOR EACH ROW WHEN (((old.status IS DISTINCT FROM new.status) OR (old.authorization_revision IS DISTINCT FROM new.authorization_revision))) EXECUTE FUNCTION opengeni_private.sync_external_membership_lifecycle();

CREATE TRIGGER organization_membership_lifecycle_events_immutable BEFORE DELETE OR UPDATE ON organization_membership_lifecycle_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_membership_operation_receipts_immutable BEFORE DELETE OR UPDATE ON organization_membership_operation_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_memberships_assign_managed_self_owner BEFORE INSERT ON organization_memberships FOR EACH ROW EXECUTE FUNCTION opengeni_private.assign_managed_self_organization_owner();

CREATE TRIGGER organization_memberships_plan_seat_limit BEFORE INSERT OR UPDATE OF status, subject_id, account_id ON organization_memberships FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_organization_plan_seats();

CREATE TRIGGER organization_memberships_subscription_core_auto_assign AFTER INSERT OR UPDATE OF personal_workspace_id ON organization_memberships FOR EACH ROW EXECUTE FUNCTION opengeni_private.auto_assign_subscription_core_personal_workspace();

CREATE TRIGGER organization_recovery_acceptances_append_only BEFORE DELETE OR UPDATE ON organization_recovery_custodian_acceptances FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_recovery_approvals_append_only BEFORE DELETE OR UPDATE ON organization_recovery_approvals FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_recovery_attempts_append_only BEFORE DELETE OR UPDATE ON organization_recovery_notification_attempts FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_recovery_custodians_append_only BEFORE DELETE OR UPDATE ON organization_recovery_custodians FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_recovery_events_append_only BEFORE DELETE OR UPDATE ON organization_recovery_events FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE CONSTRAINT TRIGGER organization_recovery_exactly_three_custodians AFTER INSERT OR UPDATE ON organization_recovery_policies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION organization_recovery_exactly_three_custodians();

CREATE TRIGGER organization_recovery_outbox_append_only BEFORE DELETE OR UPDATE ON organization_recovery_notification_outbox FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_recovery_policies_append_only BEFORE DELETE OR UPDATE ON organization_recovery_policies FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_recovery_receipts_append_only BEFORE DELETE OR UPDATE ON organization_recovery_command_receipts FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE TRIGGER organization_user_resource_grants_action_contract BEFORE INSERT OR UPDATE OF account_id, authority_id, action ON organization_user_resource_grants FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_user_resource_grant_action();

CREATE TRIGGER organization_user_retention_deletion_events_immutable BEFORE DELETE OR UPDATE ON organization_user_retention_deletion_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_user_retention_object_deletion_receipts_immutable BEFORE DELETE OR UPDATE ON organization_user_retention_object_deletion_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_user_retention_object_obligations_immutable BEFORE DELETE OR UPDATE ON organization_user_retention_object_obligations FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_user_setup_delivery_revocation AFTER UPDATE OF status ON organization_membership_invitations FOR EACH ROW EXECUTE FUNCTION sync_organization_user_setup_delivery_revocation();

CREATE TRIGGER organization_workspace_lifecycle_events_immutable BEFORE DELETE OR UPDATE ON organization_workspace_lifecycle_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER organization_workspace_operation_receipts_immutable BEFORE DELETE OR UPDATE ON organization_workspace_operation_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

CREATE TRIGGER preference_registry_events_immutable BEFORE DELETE OR UPDATE ON preference_registry_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_owned_skill_history_delete();

CREATE TRIGGER preference_registry_preferences_guard_delete BEFORE DELETE ON preference_registry_preferences FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_owned_skill_head_delete();

CREATE TRIGGER preference_registry_preferences_lifecycle_only BEFORE UPDATE ON preference_registry_preferences FOR EACH ROW EXECUTE FUNCTION preference_registry_guard_head_mutation();

CREATE CONSTRAINT TRIGGER preference_registry_preferences_require_proposal_event AFTER INSERT ON preference_registry_preferences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION preference_registry_require_proposal_event();

CREATE TRIGGER preference_registry_preferences_validate_head BEFORE INSERT OR UPDATE ON preference_registry_preferences FOR EACH ROW EXECUTE FUNCTION preference_registry_validate_head();

CREATE TRIGGER preference_registry_revisions_immutable BEFORE DELETE OR UPDATE ON preference_registry_revisions FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_owned_skill_history_delete();

CREATE TRIGGER preference_registry_snapshots_immutable BEFORE DELETE OR UPDATE ON preference_registry_snapshots FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_workspace_owned_skill_history_delete();

CREATE TRIGGER preference_registry_snapshots_validate BEFORE INSERT ON preference_registry_snapshots FOR EACH ROW EXECUTE FUNCTION preference_registry_validate_snapshot();

CREATE TRIGGER preserve_credit_grant_scope BEFORE UPDATE ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION opengeni_private.preserve_credit_grant_scope();

CREATE TRIGGER private_session_cancels_foreign_update BEFORE INSERT ON session_system_updates FOR EACH ROW EXECUTE FUNCTION private_session_cancels_foreign_update();

CREATE TRIGGER product_lifecycle_fact_additional_organization AFTER INSERT ON additional_organization_creation_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_connection_created AFTER INSERT ON connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_connection_deleted AFTER DELETE ON connections FOR EACH ROW WHEN ((old.status IS DISTINCT FROM 'revoked'::text)) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_connection_revoked AFTER UPDATE OF status ON connections FOR EACH ROW WHEN (((new.status = 'revoked'::text) AND (old.status IS DISTINCT FROM 'revoked'::text))) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_credits_granted AFTER INSERT ON credit_ledger_entries FOR EACH ROW WHEN (((new.type = ANY (ARRAY['grant'::text, 'manual_credit_grant'::text])) AND (new.amount_micros > 0))) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_credits_purchased AFTER INSERT ON credit_ledger_entries FOR EACH ROW WHEN ((new.type = 'credit_topup'::text)) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_email_verified AFTER UPDATE OF email_verified ON auth_users FOR EACH ROW WHEN ((new.email_verified AND (NOT old.email_verified))) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_machine_enrolled AFTER INSERT ON enrollments FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_member_activated AFTER UPDATE OF status ON organization_memberships FOR EACH ROW WHEN (((new.status = 'active'::text) AND (old.status IS DISTINCT FROM 'active'::text))) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_member_joined AFTER INSERT ON organization_memberships FOR EACH ROW WHEN ((new.status = 'active'::text)) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_model_connected AFTER INSERT ON claude_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_model_connected AFTER INSERT ON codex_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_model_connected AFTER INSERT ON organization_model_provider_connections FOR EACH ROW WHEN ((new.status = 'active'::text)) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_model_connected AFTER INSERT ON subscription_connections FOR EACH ROW WHEN ((COALESCE(current_setting('opengeni.subscription_cutover_provider'::text, true), ''::text) = ''::text)) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_model_connected AFTER INSERT ON xai_subscription_credentials FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_model_reconnected AFTER UPDATE OF status ON organization_model_provider_connections FOR EACH ROW WHEN (((new.status = 'active'::text) AND (old.status IS DISTINCT FROM 'active'::text))) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_organization_setup AFTER INSERT ON self_service_organization_setup_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_scheduled_task_created AFTER INSERT ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_sign_in AFTER INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_sign_up AFTER INSERT ON auth_identities FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_skill_installed AFTER INSERT ON skill_source_bindings FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_slack_user_linked AFTER INSERT ON slack_bot_user_links FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER product_lifecycle_fact_verified_at_signup AFTER INSERT ON auth_users FOR EACH ROW WHEN (new.email_verified) EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

CREATE TRIGGER public_sandbox_recovery_lease_guard BEFORE INSERT OR UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION guard_public_sandbox_recovery_lease();

CREATE TRIGGER public_sandbox_recovery_session_guard BEFORE INSERT OR UPDATE OF sandbox_group_id, active_sandbox_id, active_epoch ON sessions FOR EACH ROW EXECUTE FUNCTION guard_public_sandbox_recovery_session();

CREATE TRIGGER recording_events_organization_webhook_enqueue_v1 AFTER INSERT ON recording_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1();

CREATE TRIGGER recording_events_workspace_webhook_enqueue_v1 AFTER INSERT ON recording_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.enqueue_recording_event_workspace_webhooks_v1();

CREATE TRIGGER recording_live_allowance_usage AFTER UPDATE OF live_cost_usd_micros ON recording_tracks FOR EACH ROW WHEN ((COALESCE(new.live_cost_usd_micros, (0)::bigint) > COALESCE(old.live_cost_usd_micros, (0)::bigint))) EXECUTE FUNCTION count_unbilled_model_allowance_debit();

CREATE TRIGGER recording_transcript_allowance_usage AFTER UPDATE OF state ON recording_transcript_versions FOR EACH ROW WHEN (((old.state IS DISTINCT FROM 'complete'::text) AND (new.state = 'complete'::text) AND (new.cost_usd_micros > 0))) EXECUTE FUNCTION count_unbilled_model_allowance_debit();

CREATE TRIGGER reject_legacy_claude_subscription_credentials BEFORE INSERT OR UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION reject_legacy_claude_subscription_credentials();

CREATE TRIGGER reject_legacy_claude_subscription_credentials BEFORE INSERT OR UPDATE ON organization_model_provider_connections FOR EACH ROW EXECUTE FUNCTION reject_legacy_claude_subscription_credentials();

CREATE TRIGGER reject_workspace_account_id_change BEFORE UPDATE OF account_id ON workspaces FOR EACH ROW EXECUTE FUNCTION reject_workspace_account_id_change();

CREATE TRIGGER remember_knowledge_confirmation_receipts_immutable BEFORE DELETE OR UPDATE ON remember_knowledge_confirmation_receipts FOR EACH ROW EXECUTE FUNCTION reject_remember_knowledge_confirmation_receipt_mutation();

CREATE TRIGGER remember_knowledge_memory_materializations_immutable BEFORE DELETE OR UPDATE ON remember_knowledge_memory_materializations FOR EACH ROW EXECUTE FUNCTION reject_remember_knowledge_memory_materialization_mutation();

CREATE TRIGGER retained_processes_list_insert_delete AFTER INSERT OR DELETE ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER retained_processes_list_update AFTER UPDATE OF state, last_reconcile_outcome ON sandbox_retained_processes FOR EACH ROW WHEN (((old.state IS DISTINCT FROM new.state) OR (old.last_reconcile_outcome IS DISTINCT FROM new.last_reconcile_outcome))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER retained_screenshot_detachment_queue_trg BEFORE UPDATE OF session_id, turn_id, attempt_id ON retained_screenshot_artifacts FOR EACH ROW EXECUTE FUNCTION opengeni_private.queue_detached_retained_screenshot();

CREATE TRIGGER retained_screenshot_file_owner_immutable BEFORE UPDATE ON retained_screenshot_artifacts FOR EACH ROW EXECUTE FUNCTION knowledge_media_file_owner_immutable();

CREATE TRIGGER rig_changes_lossless_legacy_update_fence BEFORE UPDATE OF payload, verification ON rig_changes FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER rig_versions_platform_base_only BEFORE INSERT OR UPDATE OF image ON rig_versions FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_rig_platform_base_only_v1();

CREATE TRIGGER sandbox_automatic_warning_receipt_guard BEFORE INSERT OR DELETE OR UPDATE ON session_command_receipts FOR EACH ROW EXECUTE FUNCTION guard_sandbox_automatic_warning_receipt();

CREATE TRIGGER sandbox_checkpoint_artifact_immutability_guard BEFORE UPDATE ON sandbox_checkpoint_artifacts FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_checkpoint_artifact_immutability();

CREATE CONSTRAINT TRIGGER sandbox_checkpoint_artifact_refs_guard AFTER INSERT OR UPDATE OF account_id, workspace_id, sandbox_group_id, source_lease_id, provider_backend, state ON sandbox_checkpoint_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_checkpoint_artifact_refs();

CREATE CONSTRAINT TRIGGER sandbox_checkpoint_refs_guard AFTER INSERT OR UPDATE OF account_id, workspace_id, sandbox_group_id, backend, workspace_generation, archive_generation, resume_state, current_checkpoint_artifact_id, previous_checkpoint_artifact_id ON sandbox_leases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_checkpoint_refs();

CREATE TRIGGER sandbox_clear_deadline_forced_admissions BEFORE UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.clear_deadline_forced_admissions();

CREATE TRIGGER sandbox_clear_unobservable_command_drain BEFORE UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.clear_unobservable_command_drain();

CREATE TRIGGER sandbox_command_containment_reason_clear BEFORE UPDATE ON sandbox_leases FOR EACH ROW WHEN (((new.unobservable_command_drain_ids IS NULL) AND (new.command_containment_reason IS NOT NULL))) EXECUTE FUNCTION opengeni_private.clear_command_containment_reason();

CREATE TRIGGER sandbox_lease_holders_changed BEFORE UPDATE OF refcount, turn_holders, viewer_holders ON sandbox_leases FOR EACH ROW WHEN (((old.refcount IS DISTINCT FROM new.refcount) OR (old.turn_holders IS DISTINCT FROM new.turn_holders) OR (old.viewer_holders IS DISTINCT FROM new.viewer_holders))) EXECUTE FUNCTION opengeni_private.stamp_sandbox_lease_holders_changed();

CREATE TRIGGER sandbox_leases_drain_teardown_fence BEFORE UPDATE OF archive_capture_id, liveness ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.stamp_sandbox_drain_teardown_fence();

CREATE TRIGGER sandbox_provider_create_fence BEFORE DELETE OR UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_unresolved_provider_create();

CREATE CONSTRAINT TRIGGER sandbox_pty_sessions_process_identity_v2 AFTER INSERT OR UPDATE ON sandbox_pty_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_pty_process_v2();

CREATE TRIGGER sandbox_recovery_consent_receipt_guard BEFORE INSERT OR DELETE OR UPDATE ON session_command_receipts FOR EACH ROW EXECUTE FUNCTION guard_sandbox_recovery_consent_receipt();

CREATE TRIGGER sandbox_recovery_protocol_v2_admission_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_workspace_mutation_admissions FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE TRIGGER sandbox_recovery_protocol_v2_checkpoint_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_checkpoint_artifacts FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE TRIGGER sandbox_recovery_protocol_v2_holder_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_lease_holders FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE TRIGGER sandbox_recovery_protocol_v2_lease_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE TRIGGER sandbox_recovery_protocol_v2_process_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE TRIGGER sandbox_recovery_protocol_v2_pty_guard BEFORE INSERT OR DELETE OR UPDATE ON sandbox_pty_sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_sandbox_recovery_protocol_v2();

CREATE TRIGGER sandbox_recovery_warning_claim_guard BEFORE INSERT ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION guard_sandbox_recovery_warning_claim();

CREATE TRIGGER sandbox_refresh_concurrent_capture_takeover BEFORE UPDATE OF archive_capture_id ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION opengeni_private.refresh_concurrent_capture_takeover();

CREATE CONSTRAINT TRIGGER sandbox_retained_processes_identity_v2 AFTER INSERT OR UPDATE ON sandbox_retained_processes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_sandbox_retained_process_v2();

CREATE TRIGGER sandbox_retained_processes_tenancy_writer_fence BEFORE INSERT ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_activated_tenancy_writer();

CREATE TRIGGER sandbox_session_envelopes_lossless_legacy_update_fence BEFORE UPDATE OF envelope ON sandbox_session_envelopes FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER sandbox_untracked_writer_epoch_clear BEFORE UPDATE OF lease_epoch ON sandbox_leases FOR EACH ROW WHEN (((new.lease_epoch IS DISTINCT FROM old.lease_epoch) AND (new.untracked_writer_since IS NOT NULL))) EXECUTE FUNCTION opengeni_private.clear_untracked_writer_since();

CREATE TRIGGER sandbox_warm_attribution_immutable BEFORE UPDATE ON sandbox_leases FOR EACH ROW EXECUTE FUNCTION sandbox_warm_attribution_immutable();

CREATE TRIGGER sandbox_workspace_mutation_admissions_tenancy_writer_fence BEFORE INSERT ON sandbox_workspace_mutation_admissions FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_activated_tenancy_writer();

CREATE TRIGGER scheduled_admission_diagnostic_immutable BEFORE INSERT OR UPDATE ON scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_admission_diagnostic();

CREATE TRIGGER scheduled_admission_refusal_immutable BEFORE INSERT OR UPDATE ON scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_admission_refusal();

CREATE TRIGGER scheduled_agent_run_delete_immutable BEFORE DELETE ON scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION fence_scheduled_agent_run_delete();

CREATE TRIGGER scheduled_agent_run_execution_admission BEFORE INSERT ON scheduled_task_runs FOR EACH ROW WHEN (((new.admission_diagnostic IS NULL) AND (new.admission_refusal IS NULL))) EXECUTE FUNCTION admit_scheduled_agent_run_execution();

CREATE TRIGGER scheduled_occurrence_accepted_execution_validation BEFORE INSERT ON session_system_updates FOR EACH ROW EXECUTE FUNCTION validate_scheduled_occurrence_accepted_execution();

CREATE TRIGGER scheduled_occurrence_update_immutable BEFORE UPDATE ON session_system_updates FOR EACH ROW EXECUTE FUNCTION fence_scheduled_occurrence_update();

CREATE TRIGGER scheduled_run_owner_matches BEFORE INSERT ON scheduled_task_runs FOR EACH ROW WHEN (((new.admission_diagnostic IS NULL) AND (new.admission_refusal IS NULL))) EXECUTE FUNCTION opengeni_private.guard_scheduled_run_owner();

CREATE TRIGGER scheduled_run_terminal_turn_settlement AFTER UPDATE OF status ON session_turns FOR EACH ROW EXECUTE FUNCTION settle_scheduled_run_from_terminal_turn();

CREATE TRIGGER scheduled_run_terminal_update_settlement AFTER UPDATE OF state ON session_system_updates FOR EACH ROW EXECUTE FUNCTION settle_scheduled_run_from_terminal_update();

CREATE TRIGGER scheduled_system_update_evidence_delete_immutable BEFORE DELETE ON session_system_updates FOR EACH ROW EXECUTE FUNCTION fence_scheduled_occurrence_evidence_delete();

CREATE TRIGGER scheduled_task_attempt_once_retry_prepare BEFORE INSERT ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION prepare_scheduled_task_attempt_once_grants();

CREATE TRIGGER scheduled_task_owner_immutable BEFORE INSERT OR UPDATE ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_scheduled_task_owner();

CREATE TRIGGER scheduled_task_personal_resource_execution_revision BEFORE UPDATE ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_personal_resource_execution_update();

CREATE TRIGGER scheduled_task_revision_authorities_claude_authority_lock_trg BEFORE UPDATE OF claude_provider_account_authority_snapshot ON scheduled_task_revision_authorities FOR EACH ROW EXECUTE FUNCTION prevent_claude_snapshot_mutation();

CREATE TRIGGER scheduled_task_revision_authorities_subscription_authority_immu BEFORE UPDATE OF subscription_authority ON scheduled_task_revision_authorities FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();

CREATE TRIGGER scheduled_task_revision_authorities_subscription_authority_trg BEFORE INSERT ON scheduled_task_revision_authorities FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.derive_scheduled_revision_subscription_authority();

CREATE TRIGGER scheduled_task_run_connection_authority_admission AFTER INSERT ON scheduled_task_runs FOR EACH ROW WHEN ((new.status = 'queued'::text)) EXECUTE FUNCTION admit_scheduled_task_run_connection_authorities();

CREATE TRIGGER scheduled_task_run_connection_session_identity_immutable BEFORE UPDATE ON scheduled_task_runs FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_run_connection_session_identity();

CREATE TRIGGER scheduled_task_run_personal_resource_admission AFTER INSERT ON scheduled_task_runs FOR EACH ROW WHEN ((new.status = 'queued'::text)) EXECUTE FUNCTION admit_scheduled_task_run_personal_resources();

CREATE TRIGGER scheduled_task_tombstone_immutable BEFORE UPDATE ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_tombstone();

CREATE TRIGGER scheduled_task_turn_run_identity_immutable BEFORE UPDATE OF scheduled_task_run_id ON session_turns FOR EACH ROW EXECUTE FUNCTION fence_scheduled_task_turn_run_identity();

CREATE TRIGGER scheduled_task_unclaimed_occurrence_invalidation AFTER UPDATE OF status ON scheduled_tasks FOR EACH ROW WHEN (((old.status = 'active'::text) AND (new.status = 'paused'::text))) EXECUTE FUNCTION invalidate_unclaimed_scheduled_agent_runs_on_task_inactive();

CREATE TRIGGER scheduled_tasks_claude_authority_lock_trg BEFORE UPDATE OF claude_provider_account_authority_snapshot ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION prevent_claude_snapshot_mutation();

CREATE TRIGGER scheduled_tasks_codex_authority_snapshot_immutable_trg BEFORE UPDATE OF codex_provider_account_authority_snapshot ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION prevent_codex_provider_account_authority_snapshot_mutation();

CREATE TRIGGER scheduled_tasks_creator_immutable BEFORE UPDATE OF created_by_kind, created_by_subject_id, created_by_context ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION opengeni_private.prevent_scheduled_task_creator_mutation();

CREATE TRIGGER scheduled_tasks_subscription_authority_immutable_trg BEFORE UPDATE OF subscription_authority ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();

CREATE TRIGGER scheduled_tasks_xai_authority_snapshot_immutable_trg BEFORE UPDATE OF xai_provider_account_authority_snapshot ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();

CREATE TRIGGER scheduled_terminal_occurrence_delivery_fence BEFORE UPDATE OF state ON session_system_updates FOR EACH ROW WHEN (((old.scheduled_task_run_id IS NOT NULL) AND (old.state = 'pending'::text) AND (new.state = 'delivered'::text))) EXECUTE FUNCTION fence_terminal_scheduled_occurrence_delivery();

CREATE TRIGGER scheduled_turn_evidence_delete_immutable BEFORE DELETE ON session_turns FOR EACH ROW EXECUTE FUNCTION fence_scheduled_occurrence_evidence_delete();

CREATE TRIGGER scheduled_turn_execution_immutable BEFORE UPDATE OF model, reasoning_effort, latency_mode, tools, sandbox_backend, sandbox_os, initiating_human_subject_id, personal_connection_delegations, xai_provider_account_authority_snapshot, claude_provider_account_authority_snapshot, subscription_authority ON session_turns FOR EACH ROW EXECUTE FUNCTION fence_scheduled_turn_execution_update();

CREATE TRIGGER schedules_list_insert_delete AFTER INSERT OR DELETE ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER schedules_list_timing_update AFTER UPDATE OF schedule ON scheduled_tasks FOR EACH ROW WHEN ((old.schedule IS DISTINCT FROM new.schedule)) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER schedules_list_update AFTER UPDATE OF status, run_mode, reusable_session_id, deleted_at, visibility, metadata ON scheduled_tasks FOR EACH ROW WHEN (((((((old.status IS DISTINCT FROM new.status) OR (old.run_mode IS DISTINCT FROM new.run_mode)) OR (old.reusable_session_id IS DISTINCT FROM new.reusable_session_id)) OR (old.deleted_at IS DISTINCT FROM new.deleted_at)) OR (old.visibility IS DISTINCT FROM new.visibility)) OR ((old.metadata -> 'creatorSessionId'::text) IS DISTINCT FROM (new.metadata -> 'creatorSessionId'::text)))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER self_service_setup_trial_credit AFTER INSERT ON self_service_organization_setup_receipts FOR EACH ROW EXECUTE FUNCTION opengeni_private.grant_verified_signup_trial_credit();

CREATE TRIGGER session_00_private_child_create_fence BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_private_child_session_create();

CREATE TRIGGER session_01_private_visibility_setting_fence BEFORE UPDATE OF visibility ON sessions FOR EACH ROW WHEN (((old.visibility IS DISTINCT FROM new.visibility) AND (new.visibility = 'user_private'::text))) EXECUTE FUNCTION guard_private_session_visibility_transition();

CREATE TRIGGER session_agent_creation_provenance_guard BEFORE INSERT OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_session_agent_creation_provenance();

CREATE TRIGGER session_attempt_admission_block BEFORE INSERT ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION guard_session_admission_block();

CREATE TRIGGER session_attempt_interruptions_fill_quiescence_hint BEFORE INSERT ON session_attempt_interruptions FOR EACH ROW EXECUTE FUNCTION session_attempt_interruption_fill_quiescence_hint();

CREATE TRIGGER session_attempt_personal_document_admission AFTER INSERT ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION admit_session_attempt_personal_documents();

CREATE TRIGGER session_attempt_personal_resource_admission_legacy AFTER INSERT ON session_turn_attempts FOR EACH ROW WHEN ((new.personal_resource_protocol_version = 0)) EXECUTE FUNCTION admit_session_attempt_personal_resources();

CREATE TRIGGER session_attempt_personal_resource_admission_v1 AFTER INSERT ON session_turn_attempts FOR EACH ROW WHEN ((new.personal_resource_protocol_version = 1)) EXECUTE FUNCTION admit_session_attempt_personal_resources_v1();

CREATE TRIGGER session_background_commands_launch_identity_fence BEFORE INSERT OR UPDATE ON session_background_commands FOR EACH ROW EXECUTE FUNCTION fence_background_command_launch_identity();

CREATE TRIGGER session_commands_list_insert_delete AFTER INSERT OR DELETE ON session_background_commands FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_commands_list_update AFTER UPDATE OF state, last_reconcile_outcome ON session_background_commands FOR EACH ROW WHEN (((old.state IS DISTINCT FROM new.state) OR (old.last_reconcile_outcome IS DISTINCT FROM new.last_reconcile_outcome))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_depth_policy_defaults BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_depth_policy_defaults();

CREATE TRIGGER session_depth_snapshot_immutable BEFORE UPDATE OF parent_session_id, root_session_id, nested_agent_depth, max_nested_agent_depth_override, effective_max_nested_agent_depth, nested_agent_depth_policy_source, nested_agent_depth_policy_session_id ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_depth_snapshot_immutable();

CREATE TRIGGER session_document_inspection_receipt_immutable_trigger BEFORE UPDATE ON session_command_receipts FOR EACH ROW EXECUTE FUNCTION session_document_inspection_receipt_immutable();

CREATE TRIGGER session_document_inspection_receipt_retained_trigger BEFORE DELETE ON session_command_receipts FOR EACH ROW EXECUTE FUNCTION session_document_inspection_receipt_retained();

CREATE TRIGGER session_events_advance_event_cursors AFTER INSERT ON session_events REFERENCING NEW TABLE AS inserted_session_events FOR EACH STATEMENT EXECUTE FUNCTION advance_session_event_cursors_for_inserted_events();

CREATE TRIGGER session_events_fill_tool_identity BEFORE INSERT OR UPDATE OF payload, type ON session_events FOR EACH ROW WHEN (((new.type = ANY (ARRAY['agent.toolCall.created'::text, 'agent.toolCall.output'::text])) OR (new.tool_name IS NOT NULL) OR (new.tool_call_id IS NOT NULL))) EXECUTE FUNCTION session_events_fill_tool_identity();

CREATE TRIGGER session_events_fill_usage_source_key BEFORE INSERT ON session_events FOR EACH ROW WHEN ((new.type = 'agent.model.usage'::text)) EXECUTE FUNCTION session_events_fill_usage_source_key();

CREATE CONSTRAINT TRIGGER session_events_host_export AFTER INSERT ON session_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION opengeni_private.enqueue_host_session_event_export();

CREATE TRIGGER session_events_inbox_projection_v1 AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.duplicate_of_event_id IS NULL) AND (new.type = ANY (ARRAY['session.humanInput.requested'::text, 'session.requiresAction'::text, 'user.humanInputResponse'::text, 'user.approvalDecision'::text, 'turn.completed'::text, 'turn.failed'::text, 'turn.cancelled'::text, 'turn.superseded'::text, 'goal.paused'::text, 'goal.resumed'::text, 'goal.cleared'::text, 'goal.completed'::text, 'goal.set'::text, 'session.notification.posted'::text, 'session.notification.withdrawn'::text])))) EXECUTE FUNCTION opengeni_private.project_inbox_for_session_event_v1();

CREATE TRIGGER session_events_lossless_legacy_update_fence BEFORE UPDATE OF payload ON session_events FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_events_native_push_enqueue_v1 AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.duplicate_of_event_id IS NULL) AND (new.type = ANY (ARRAY['session.humanInput.requested'::text, 'session.requiresAction'::text, 'turn.completed'::text, 'turn.failed'::text])))) EXECUTE FUNCTION opengeni_private.enqueue_native_push_for_session_event_v1();

CREATE TRIGGER session_events_normalize_legacy_cursor_sequence BEFORE INSERT ON session_events FOR EACH ROW EXECUTE FUNCTION normalize_legacy_session_event_sequence_from_cursor();

CREATE TRIGGER session_events_organization_webhook_enqueue_v1 AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.duplicate_of_event_id IS NULL) AND (new.type = ANY (ARRAY['turn.completed'::text, 'turn.failed'::text, 'turn.cancelled'::text, 'session.status.changed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'session.notification.posted'::text, 'session.notification.withdrawn'::text])))) EXECUTE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1();

CREATE TRIGGER session_events_project_context_compaction_pending AFTER INSERT ON session_events FOR EACH ROW WHEN ((new.type = ANY (ARRAY['session.context.compaction.started'::text, 'session.context.compacted'::text, 'session.context.compaction.skipped'::text]))) EXECUTE FUNCTION opengeni_private.project_context_compaction_event();

CREATE TRIGGER session_events_teams_wake AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.duplicate_of_event_id IS NULL) AND (new.type = ANY (ARRAY['turn.completed'::text, 'turn.failed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text])))) EXECUTE FUNCTION opengeni_private.wake_teams_route_for_session_event();

CREATE TRIGGER session_events_workspace_webhook_enqueue_v1 AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.duplicate_of_event_id IS NULL) AND (new.type = ANY (ARRAY['turn.completed'::text, 'turn.failed'::text, 'turn.cancelled'::text, 'session.status.changed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'session.notification.posted'::text, 'session.notification.withdrawn'::text])))) EXECUTE FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1();

CREATE TRIGGER session_goal_00_normalize_root_constraints BEFORE INSERT OR UPDATE OF root_constraints ON session_goals FOR EACH ROW EXECUTE FUNCTION session_goal_normalize_root_constraints_before_write();

CREATE TRIGGER session_goal_report_requirements_before_delete_trigger BEFORE DELETE ON session_goals FOR EACH ROW EXECUTE FUNCTION session_goal_report_requirements_before_delete();

CREATE TRIGGER session_goal_report_requirements_before_write_trigger BEFORE INSERT OR UPDATE OF metadata, status ON session_goals FOR EACH ROW EXECUTE FUNCTION session_goal_report_requirements_before_write();

CREATE TRIGGER session_goal_revision_after_write_trigger AFTER INSERT OR UPDATE OF text, success_criteria, root_constraints, mutation_policy ON session_goals FOR EACH ROW EXECUTE FUNCTION session_goal_revision_after_write();

CREATE TRIGGER session_goal_revision_before_write_trigger BEFORE INSERT OR UPDATE OF text, success_criteria, root_constraints, mutation_policy, objective_revision ON session_goals FOR EACH ROW EXECUTE FUNCTION session_goal_revision_before_write();

CREATE TRIGGER session_goal_revisions_00_normalize_root_constraints BEFORE INSERT OR UPDATE OF root_constraints ON session_goal_revisions FOR EACH ROW EXECUTE FUNCTION session_goal_normalize_root_constraints_before_write();

CREATE TRIGGER session_goal_revisions_bound_insert BEFORE INSERT ON session_goal_revisions FOR EACH ROW EXECUTE FUNCTION session_goal_revision_bound_insert();

CREATE TRIGGER session_goal_revisions_immutable BEFORE DELETE OR UPDATE ON session_goal_revisions FOR EACH ROW EXECUTE FUNCTION session_goal_revision_reject_mutation();

CREATE TRIGGER session_goals_imported_archive_guard BEFORE INSERT OR UPDATE ON session_goals FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

CREATE TRIGGER session_goals_settle_work_claims_completed AFTER UPDATE OF status ON session_goals FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status) AND (new.status = 'completed'::text))) EXECUTE FUNCTION settle_session_work_claims_on_goal_completion();

CREATE TRIGGER session_history_items_imported_archive_guard BEFORE INSERT OR UPDATE ON session_history_items FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

CREATE TRIGGER session_history_items_lossless_legacy_update_fence BEFORE UPDATE OF item ON session_history_items FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_idempotency_guard BEFORE INSERT ON sessions FOR EACH ROW WHEN ((new.create_idempotency_key IS NOT NULL)) EXECUTE FUNCTION opengeni_private.session_create_idempotency_guard_insert();

CREATE TRIGGER session_message_search_index AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.type = ANY (ARRAY['user.message'::text, 'agent.message.completed'::text])) AND (new.session_id IS NOT NULL) AND (jsonb_typeof((new.payload -> 'text'::text)) = 'string'::text))) EXECUTE FUNCTION opengeni_private.index_session_message_search_text();

CREATE TRIGGER session_pending_tool_calls_event_output_delete_guard BEFORE DELETE ON session_pending_tool_calls FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_pending_tool_event_output_delete();

CREATE TRIGGER session_pending_tool_calls_lossless_legacy_update_fence BEFORE UPDATE OF call_item, result_item ON session_pending_tool_calls FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_pins_list_insert_delete AFTER INSERT OR DELETE ON session_pins FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_pins_list_update AFTER UPDATE OF pinned, archived, acknowledged_sequence, manually_unread_through, actively_working ON session_pins FOR EACH ROW WHEN ((((((old.pinned IS DISTINCT FROM new.pinned) OR (old.archived IS DISTINCT FROM new.archived)) OR (old.acknowledged_sequence IS DISTINCT FROM new.acknowledged_sequence)) OR (old.manually_unread_through IS DISTINCT FROM new.manually_unread_through)) OR (old.actively_working IS DISTINCT FROM new.actively_working))) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_realtime_entries_lossless_legacy_update_fence BEFORE UPDATE OF text, payload ON session_realtime_entries FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_recordings_lossless_legacy_update_fence BEFORE UPDATE OF reason ON session_recordings FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_spawn_denials_append_only BEFORE DELETE OR UPDATE ON session_spawn_denials FOR EACH ROW EXECUTE FUNCTION opengeni_private.session_spawn_denials_append_only();

CREATE TRIGGER session_spawn_denials_idempotency_guard BEFORE INSERT ON session_spawn_denials FOR EACH ROW WHEN ((new.idempotency_key IS NOT NULL)) EXECUTE FUNCTION opengeni_private.session_create_idempotency_guard_insert();

CREATE TRIGGER session_started_execution_context AFTER INSERT ON session_events FOR EACH ROW WHEN (((new.type = 'turn.started'::text) AND (new.turn_association = 'current'::text))) EXECUTE FUNCTION opengeni_private.advance_session_execution_context();

CREATE TRIGGER session_system_update_outbox_claude_authority_lock_trg BEFORE UPDATE OF claude_provider_account_authority_snapshot ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION prevent_claude_snapshot_mutation();

CREATE TRIGGER session_system_update_outbox_lossless_legacy_update_fence BEFORE UPDATE OF summary, payload ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_system_update_outbox_subscription_authority_immutable_t BEFORE UPDATE OF subscription_authority ON session_system_update_outbox FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();

CREATE TRIGGER session_system_updates_claude_authority_lock_trg BEFORE UPDATE OF claude_provider_account_authority_snapshot ON session_system_updates FOR EACH ROW EXECUTE FUNCTION prevent_claude_snapshot_mutation();

CREATE TRIGGER session_system_updates_content_archive_guard BEFORE INSERT ON session_system_updates FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

CREATE TRIGGER session_system_updates_lossless_legacy_update_fence BEFORE UPDATE OF summary, payload ON session_system_updates FOR EACH ROW EXECUTE FUNCTION opengeni_private.fence_legacy_lossless_content_update();

CREATE TRIGGER session_system_updates_subscription_authority_immutable_trg BEFORE UPDATE OF subscription_authority ON session_system_updates FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();

CREATE TRIGGER session_system_updates_xai_authority_snapshot_immutable_trg BEFORE UPDATE OF xai_provider_account_authority_snapshot ON session_system_updates FOR EACH ROW EXECUTE FUNCTION prevent_xai_snapshot_mutation();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON agent_run_states FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON claude_capacity_waiters FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON codex_capacity_waiters FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON sandbox_lease_holders FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON sandbox_retained_processes FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON sandbox_workspace_mutation_admissions FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON scheduled_tasks FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_attempt_interruptions FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_goals FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_human_input_requests FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_pending_tool_calls FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_realtime_connections FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_realtime_modes FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_system_updates FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON session_turns FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_tenancy_workspace_fence BEFORE INSERT OR DELETE OR UPDATE ON xai_capacity_waiters FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence();

CREATE TRIGGER session_title_operation_admission BEFORE INSERT OR UPDATE ON session_title_operations FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_session_title_operation();

CREATE TRIGGER session_turn_attempts_clear_context_compaction_pending AFTER UPDATE OF state ON session_turn_attempts FOR EACH ROW WHEN ((old.state IS DISTINCT FROM new.state)) EXECUTE FUNCTION opengeni_private.clear_context_compaction_pending_attempt();

CREATE TRIGGER session_turn_attempts_fill_authority_snapshot_trg BEFORE INSERT ON session_turn_attempts FOR EACH ROW WHEN (((new.authority_epoch IS NULL) AND (new.authority_visibility IS NULL) AND (new.authority_owner_organization_membership_id IS NULL))) EXECUTE FUNCTION session_turn_attempts_fill_authority_snapshot();

CREATE TRIGGER session_turn_attempts_guard_authority_snapshot_immutable_trg BEFORE UPDATE OF authority_epoch, authority_visibility, authority_owner_organization_membership_id ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION session_turn_attempts_guard_authority_snapshot_immutable();

CREATE TRIGGER session_turn_attempts_imported_archive_guard BEFORE INSERT OR UPDATE ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION refuse_imported_archive_execution();

CREATE TRIGGER session_turn_attempts_personal_resource_protocol_immutable BEFORE UPDATE ON session_turn_attempts FOR EACH ROW EXECUTE FUNCTION fence_attempt_personal_resource_protocol_update();

CREATE TRIGGER session_turn_attempts_propagate_quiescence_hint AFTER UPDATE OF quiesced_at ON session_turn_attempts FOR EACH ROW WHEN (((old.quiesced_at IS NULL) AND (new.quiesced_at IS NOT NULL))) EXECUTE FUNCTION session_turn_attempt_propagate_quiescence_hint();
