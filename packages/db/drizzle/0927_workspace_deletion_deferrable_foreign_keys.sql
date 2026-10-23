-- deployment-mode: rolling
-- Deleting a workspace removes its rows through ON DELETE CASCADE chains. Many
-- of the deleted tables also reference each other ON DELETE RESTRICT or with a
-- NO ACTION check that runs immediately. PostgreSQL runs a cascade level by
-- level, and orders one row's foreign key actions by trigger name, which ends
-- in the constraint OID compared as text (see 0857). Such a check therefore ran
-- while the referencing row was still waiting for its own cascade: a resource
-- grant that a turn's machine authorization referenced, or a turn that a later
-- attempt referenced, made the whole workspace undeletable, depending on how
-- deep each row sat and which OIDs a database happened to assign.
--
-- Every foreign key between two tables a workspace deletion removes becomes a
-- deferrable NO ACTION check. Ordinary writes keep their immediate checks.
-- Workspace deletion defers exactly these checks to commit, after the cascade
-- has removed both ends, through defer_workspace_cascade_foreign_keys().
-- A constraint that was already INITIALLY DEFERRED stays deferred.
--
-- Rolling: deleting a referenced row is still refused while a reference
-- remains, at the end of the statement instead of at once; no reader or writer
-- sees a difference. The restrict keys are re-added NOT VALID and validated by
-- 0928.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE attached_browser_devices
  DROP CONSTRAINT attached_browser_devices_enrollment_fk,
  ADD CONSTRAINT attached_browser_devices_enrollment_fk FOREIGN KEY (workspace_id, enrollment_id) REFERENCES enrollments(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE attached_browser_inventories
  DROP CONSTRAINT attached_browser_inventories_enrollment_fk,
  ADD CONSTRAINT attached_browser_inventories_enrollment_fk FOREIGN KEY (workspace_id, enrollment_id) REFERENCES enrollments(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE auth_runs
  DROP CONSTRAINT auth_runs_site_auth_connection_fk,
  ADD CONSTRAINT auth_runs_site_auth_connection_fk FOREIGN KEY (workspace_id, site_auth_connection_id) REFERENCES site_auth_connections(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE automation_runs
  DROP CONSTRAINT automation_runs_event_fk,
  ADD CONSTRAINT automation_runs_event_fk FOREIGN KEY (workspace_id, source_id, event_id) REFERENCES automation_trigger_events(workspace_id, source_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT automation_runs_source_fk,
  ADD CONSTRAINT automation_runs_source_fk FOREIGN KEY (workspace_id, source_id) REFERENCES automation_sources(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT automation_runs_trigger_revision_fk,
  ADD CONSTRAINT automation_runs_trigger_revision_fk FOREIGN KEY (trigger_id, trigger_revision) REFERENCES automation_trigger_revisions(trigger_id, revision) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT automation_runs_trigger_source_fk,
  ADD CONSTRAINT automation_runs_trigger_source_fk FOREIGN KEY (workspace_id, trigger_id, source_id) REFERENCES automation_triggers(workspace_id, id, source_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE browser_identities
  DROP CONSTRAINT browser_identities_default_revision_fk,
  ADD CONSTRAINT browser_identities_default_revision_fk FOREIGN KEY (id, default_revision_id) REFERENCES browser_revisions(identity_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE browser_revision_components
  DROP CONSTRAINT browser_revision_components_artifact_fk,
  ADD CONSTRAINT browser_revision_components_artifact_fk FOREIGN KEY (workspace_id, artifact_id, artifact_purpose, source_browser_session_id, kind) REFERENCES browser_state_artifacts(workspace_id, id, purpose, source_browser_session_id, kind) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE browser_revisions
  DROP CONSTRAINT browser_revisions_identity_fk,
  ADD CONSTRAINT browser_revisions_identity_fk FOREIGN KEY (workspace_id, identity_id) REFERENCES browser_identities(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_revisions_parent_fk,
  ADD CONSTRAINT browser_revisions_parent_fk FOREIGN KEY (identity_id, parent_revision_id) REFERENCES browser_revisions(identity_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_revisions_publication_operation_fk,
  ADD CONSTRAINT browser_revisions_publication_operation_fk FOREIGN KEY (workspace_id, publication_operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_revisions_source_session_fk,
  ADD CONSTRAINT browser_revisions_source_session_fk FOREIGN KEY (workspace_id, source_browser_session_id) REFERENCES browser_sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE browser_sessions
  DROP CONSTRAINT browser_sessions_base_revision_fk,
  ADD CONSTRAINT browser_sessions_base_revision_fk FOREIGN KEY (identity_id, base_revision_id) REFERENCES browser_revisions(identity_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_sessions_create_operation_fk,
  ADD CONSTRAINT browser_sessions_create_operation_fk FOREIGN KEY (workspace_id, create_operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_sessions_identity_fk,
  ADD CONSTRAINT browser_sessions_identity_fk FOREIGN KEY (workspace_id, identity_id) REFERENCES browser_identities(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_sessions_network_route_fk,
  ADD CONSTRAINT browser_sessions_network_route_fk FOREIGN KEY (workspace_id, network_route_id) REFERENCES network_routes(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_sessions_private_checkpoint_fk,
  ADD CONSTRAINT browser_sessions_private_checkpoint_fk FOREIGN KEY (workspace_id, private_checkpoint_artifact_id) REFERENCES browser_state_artifacts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE browser_state_artifacts
  DROP CONSTRAINT browser_state_artifacts_source_session_fk,
  ADD CONSTRAINT browser_state_artifacts_source_session_fk FOREIGN KEY (workspace_id, source_browser_session_id) REFERENCES browser_sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE browser_state_uploads
  DROP CONSTRAINT browser_state_uploads_committed_artifact_fk,
  ADD CONSTRAINT browser_state_uploads_committed_artifact_fk FOREIGN KEY (workspace_id, committed_artifact_id, purpose, source_browser_session_id) REFERENCES browser_state_artifacts(workspace_id, id, purpose, source_browser_session_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_state_uploads_operation_fk,
  ADD CONSTRAINT browser_state_uploads_operation_fk FOREIGN KEY (workspace_id, operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT browser_state_uploads_source_session_fk,
  ADD CONSTRAINT browser_state_uploads_source_session_fk FOREIGN KEY (workspace_id, source_browser_session_id) REFERENCES browser_sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE capability_api_facets
  DROP CONSTRAINT capability_api_facets_integration_facet_id_fkey,
  ADD CONSTRAINT capability_api_facets_integration_facet_id_fkey FOREIGN KEY (integration_facet_id) REFERENCES capability_integration_facets(facet_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE capability_facet_installations
  DROP CONSTRAINT capability_facet_installations_connection_id_fkey,
  ADD CONSTRAINT capability_facet_installations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT capability_facet_installations_facet_id_fkey,
  ADD CONSTRAINT capability_facet_installations_facet_id_fkey FOREIGN KEY (facet_id) REFERENCES capability_facets(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE capability_mcp_facets
  DROP CONSTRAINT capability_mcp_facets_integration_facet_id_fkey,
  ADD CONSTRAINT capability_mcp_facets_integration_facet_id_fkey FOREIGN KEY (integration_facet_id) REFERENCES capability_integration_facets(facet_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE capability_plugin_installations
  DROP CONSTRAINT capability_plugin_installations_plugin_id_fkey,
  ADD CONSTRAINT capability_plugin_installations_plugin_id_fkey FOREIGN KEY (plugin_id) REFERENCES capability_plugins(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT capability_plugin_installations_plugin_version_fk,
  ADD CONSTRAINT capability_plugin_installations_plugin_version_fk FOREIGN KEY (plugin_id, plugin_version_id) REFERENCES capability_plugin_versions(plugin_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE company_brain_preference_proposal_receipts
  DROP CONSTRAINT company_brain_preference_proposal_re_knowledge_proposal_id_fkey,
  ADD CONSTRAINT company_brain_preference_proposal_re_knowledge_proposal_id_fkey FOREIGN KEY (knowledge_proposal_id) REFERENCES knowledge_change_proposals(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE company_profile_agent_automatic_activation_receipts
  DROP CONSTRAINT company_profile_agent_automatic_activations_proposal_fk,
  ADD CONSTRAINT company_profile_agent_automatic_activations_proposal_fk FOREIGN KEY (proposal_receipt_id, account_id) REFERENCES company_profile_agent_proposal_receipts(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE company_profile_agent_confirmation_receipts
  DROP CONSTRAINT company_profile_agent_confirmations_proposal_fk,
  ADD CONSTRAINT company_profile_agent_confirmations_proposal_fk FOREIGN KEY (proposal_receipt_id, account_id) REFERENCES company_profile_agent_proposal_receipts(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE composer_drafts
  DROP CONSTRAINT composer_drafts_source_turn_fk,
  ADD CONSTRAINT composer_drafts_source_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE computer_sessions
  DROP CONSTRAINT computer_sessions_create_operation_fk,
  ADD CONSTRAINT computer_sessions_create_operation_fk FOREIGN KEY (workspace_id, create_operation_id) REFERENCES interaction_operations(workspace_id, operation_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE document_chunks
  DROP CONSTRAINT document_chunks_authority_workspace_fk,
  ADD CONSTRAINT document_chunks_authority_workspace_fk FOREIGN KEY (authority_workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT document_chunks_file_id_fkey,
  ADD CONSTRAINT document_chunks_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE documents
  DROP CONSTRAINT documents_authority_workspace_fk,
  ADD CONSTRAINT documents_authority_workspace_fk FOREIGN KEY (authority_workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT documents_file_id_fkey,
  ADD CONSTRAINT documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE external_link_task_authorities
  ALTER CONSTRAINT external_link_task_authorities_workspace_id_account_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE external_link_turn_authorities
  ALTER CONSTRAINT external_link_turn_authorities_source_task_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT external_link_turn_authorities_source_turn_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT external_link_turn_authorities_workspace_id_account_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE generated_video_artifacts
  DROP CONSTRAINT generated_video_artifacts_operation_id_fkey,
  ADD CONSTRAINT generated_video_artifacts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES video_generation_operations(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT generated_video_artifacts_primary_file_id_fkey,
  ADD CONSTRAINT generated_video_artifacts_primary_file_id_fkey FOREIGN KEY (primary_file_id) REFERENCES files(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT generated_video_artifacts_workspace_file_scope_fk,
  ADD CONSTRAINT generated_video_artifacts_workspace_file_scope_fk FOREIGN KEY (account_id, workspace_id, primary_file_id) REFERENCES files(account_id, workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE google_drive_object_acl_evidence
  DROP CONSTRAINT google_drive_object_acl_evidence_connection_id_fkey,
  ADD CONSTRAINT google_drive_object_acl_evidence_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT google_drive_object_acl_evidence_file_id_fkey,
  ADD CONSTRAINT google_drive_object_acl_evidence_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE governed_learning_activation_receipts
  DROP CONSTRAINT governed_learning_activation__knowledge_approval_review_id_fkey,
  ADD CONSTRAINT governed_learning_activation__knowledge_approval_review_id_fkey FOREIGN KEY (knowledge_approval_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation__knowledge_previous_review_id_fkey,
  ADD CONSTRAINT governed_learning_activation__knowledge_previous_review_id_fkey FOREIGN KEY (knowledge_previous_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_receipts_claim_id_fkey,
  ADD CONSTRAINT governed_learning_activation_receipts_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES knowledge_claims(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_receipts_decision_receipt_id_fkey,
  ADD CONSTRAINT governed_learning_activation_receipts_decision_receipt_id_fkey FOREIGN KEY (decision_receipt_id) REFERENCES governed_learning_decision_receipts(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_receipts_evidence_id_fkey,
  ADD CONSTRAINT governed_learning_activation_receipts_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES knowledge_claim_evidence(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_receipts_policy_revision_id_fkey,
  ADD CONSTRAINT governed_learning_activation_receipts_policy_revision_id_fkey FOREIGN KEY (policy_revision_id) REFERENCES workspace_learning_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_receipts_proposal_id_fkey,
  ADD CONSTRAINT governed_learning_activation_receipts_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES knowledge_change_proposals(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE governed_learning_activation_undo_receipts
  DROP CONSTRAINT governed_learning_activation__knowledge_revocation_review__fkey,
  ADD CONSTRAINT governed_learning_activation__knowledge_revocation_review__fkey FOREIGN KEY (knowledge_revocation_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_knowledge_approval_review_id_fkey1,
  ADD CONSTRAINT governed_learning_activation_knowledge_approval_review_id_fkey1 FOREIGN KEY (knowledge_approval_review_id) REFERENCES knowledge_claim_reviews(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT governed_learning_activation_undo_re_activation_receipt_id_fkey,
  ADD CONSTRAINT governed_learning_activation_undo_re_activation_receipt_id_fkey FOREIGN KEY (activation_receipt_id) REFERENCES governed_learning_activation_receipts(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE host_mcp_delegations
  ALTER CONSTRAINT host_mcp_delegations_binding_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE host_mcp_task_authorities
  ALTER CONSTRAINT host_mcp_task_authorities_binding_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT host_mcp_task_authorities_delegation_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE host_mcp_turn_authorities
  ALTER CONSTRAINT host_mcp_turn_authorities_binding_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT host_mcp_turn_authorities_delegation_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE integration_facet_bindings
  DROP CONSTRAINT integration_facet_bindings_connection_id_fkey,
  ADD CONSTRAINT integration_facet_bindings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT integration_facet_bindings_facet_definition_id_fkey,
  ADD CONSTRAINT integration_facet_bindings_facet_definition_id_fkey FOREIGN KEY (facet_definition_id) REFERENCES integration_facet_definitions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_change_proposals
  DROP CONSTRAINT knowledge_change_proposals_claim_fk,
  ADD CONSTRAINT knowledge_change_proposals_claim_fk FOREIGN KEY (account_id, claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_change_proposals_evidence_fk,
  ADD CONSTRAINT knowledge_change_proposals_evidence_fk FOREIGN KEY (account_id, evidence_id, claim_id, scope_key) REFERENCES knowledge_claim_evidence(account_id, id, claim_id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_claim_evidence
  DROP CONSTRAINT knowledge_claim_evidence_claim_fk,
  ADD CONSTRAINT knowledge_claim_evidence_claim_fk FOREIGN KEY (account_id, claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_claim_evidence_version_fk,
  ADD CONSTRAINT knowledge_claim_evidence_version_fk FOREIGN KEY (account_id, document_version_id, scope_key) REFERENCES knowledge_document_versions(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_claim_relations
  DROP CONSTRAINT knowledge_claim_relations_from_fk,
  ADD CONSTRAINT knowledge_claim_relations_from_fk FOREIGN KEY (account_id, from_claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_claim_relations_to_fk,
  ADD CONSTRAINT knowledge_claim_relations_to_fk FOREIGN KEY (account_id, to_claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_claim_reviews
  DROP CONSTRAINT knowledge_claim_reviews_claim_fk,
  ADD CONSTRAINT knowledge_claim_reviews_claim_fk FOREIGN KEY (account_id, claim_id, scope_key) REFERENCES knowledge_claims(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_claims
  DROP CONSTRAINT knowledge_claims_fact_fk,
  ADD CONSTRAINT knowledge_claims_fact_fk FOREIGN KEY (account_id, fact_id, scope_key) REFERENCES knowledge_facts(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_document_versions
  DROP CONSTRAINT knowledge_document_versions_acl_fk,
  ADD CONSTRAINT knowledge_document_versions_acl_fk FOREIGN KEY (account_id, source_id, acl_generation) REFERENCES knowledge_source_acl_versions(account_id, source_id, generation) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_document_versions_object_fk,
  ADD CONSTRAINT knowledge_document_versions_object_fk FOREIGN KEY (account_id, object_id, source_id, scope_key) REFERENCES knowledge_source_objects(account_id, id, source_id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_document_versions_source_fk,
  ADD CONSTRAINT knowledge_document_versions_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_entity_aliases
  DROP CONSTRAINT knowledge_entity_aliases_entity_fk,
  ADD CONSTRAINT knowledge_entity_aliases_entity_fk FOREIGN KEY (account_id, entity_id, scope_key, entity_type) REFERENCES knowledge_entities(account_id, id, scope_key, entity_type) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_entry_links
  ALTER CONSTRAINT knowledge_entry_links_account_id_target_entry_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT knowledge_entry_links_account_id_target_entry_id_target_re_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE knowledge_entry_revisions
  ALTER CONSTRAINT knowledge_entry_revisions_account_id_entry_id_previous_rev_fkey DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT knowledge_entry_revisions_account_id_entry_id_restored_fro_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE knowledge_facts
  DROP CONSTRAINT knowledge_facts_object_entity_fk,
  ADD CONSTRAINT knowledge_facts_object_entity_fk FOREIGN KEY (account_id, object_entity_id, scope_key) REFERENCES knowledge_entities(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_facts_subject_fk,
  ADD CONSTRAINT knowledge_facts_subject_fk FOREIGN KEY (account_id, subject_entity_id, scope_key) REFERENCES knowledge_entities(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_lifecycle_events
  DROP CONSTRAINT knowledge_lifecycle_events_object_fk,
  ADD CONSTRAINT knowledge_lifecycle_events_object_fk FOREIGN KEY (account_id, object_id, scope_key) REFERENCES knowledge_source_objects(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_lifecycle_events_provider_fk,
  ADD CONSTRAINT knowledge_lifecycle_events_provider_fk FOREIGN KEY (account_id, provider_id, scope_key) REFERENCES knowledge_providers(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_lifecycle_events_source_fk,
  ADD CONSTRAINT knowledge_lifecycle_events_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_memory_lifecycle_events
  DROP CONSTRAINT knowledge_memory_lifecycle_events_actor_attempt_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_memory_lifecycle_events_actor_session_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_memory_lifecycle_events_actor_turn_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_memory_lifecycle_events_related_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_related_fk FOREIGN KEY (workspace_id, related_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_memory_lifecycle_events_relationship_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_relationship_fk FOREIGN KEY (workspace_id, relationship_id) REFERENCES knowledge_memory_relationships(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID,
  DROP CONSTRAINT knowledge_memory_lifecycle_events_reverts_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_reverts_fk FOREIGN KEY (workspace_id, reverts_event_id) REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID,
  DROP CONSTRAINT knowledge_memory_lifecycle_events_target_fk,
  ADD CONSTRAINT knowledge_memory_lifecycle_events_target_fk FOREIGN KEY (workspace_id, target_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_memory_relationships
  DROP CONSTRAINT knowledge_memory_relationships_created_event_fk,
  ADD CONSTRAINT knowledge_memory_relationships_created_event_fk FOREIGN KEY (workspace_id, created_by_event_id) REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID,
  DROP CONSTRAINT knowledge_memory_relationships_removed_event_fk,
  ADD CONSTRAINT knowledge_memory_relationships_removed_event_fk FOREIGN KEY (workspace_id, removed_by_event_id) REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID,
  DROP CONSTRAINT knowledge_memory_relationships_source_fk,
  ADD CONSTRAINT knowledge_memory_relationships_source_fk FOREIGN KEY (workspace_id, source_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT knowledge_memory_relationships_target_fk,
  ADD CONSTRAINT knowledge_memory_relationships_target_fk FOREIGN KEY (workspace_id, target_memory_id) REFERENCES knowledge_memories(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_source_acl_versions
  DROP CONSTRAINT knowledge_source_acl_versions_source_fk,
  ADD CONSTRAINT knowledge_source_acl_versions_source_fk FOREIGN KEY (account_id, source_id, source_scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_source_objects
  DROP CONSTRAINT knowledge_source_objects_current_version_fk,
  ADD CONSTRAINT knowledge_source_objects_current_version_fk FOREIGN KEY (account_id, id, current_version_id) REFERENCES knowledge_document_versions(account_id, object_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID,
  DROP CONSTRAINT knowledge_source_objects_source_fk,
  ADD CONSTRAINT knowledge_source_objects_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_sources
  DROP CONSTRAINT knowledge_sources_current_acl_fk,
  ADD CONSTRAINT knowledge_sources_current_acl_fk FOREIGN KEY (account_id, id, current_acl_generation) REFERENCES knowledge_source_acl_versions(account_id, source_id, generation) DEFERRABLE INITIALLY DEFERRED NOT VALID,
  DROP CONSTRAINT knowledge_sources_provider_fk,
  ADD CONSTRAINT knowledge_sources_provider_fk FOREIGN KEY (account_id, provider_id, scope_key) REFERENCES knowledge_providers(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE knowledge_sync_runs
  DROP CONSTRAINT knowledge_sync_runs_source_fk,
  ADD CONSTRAINT knowledge_sync_runs_source_fk FOREIGN KEY (account_id, source_id, scope_key) REFERENCES knowledge_sources(account_id, id, scope_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE machine_removal_operations
  DROP CONSTRAINT machine_removal_operations_enrollment_id_fkey,
  ADD CONSTRAINT machine_removal_operations_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE memory_slack_publications
  DROP CONSTRAINT memory_slack_publications_configuration_id_fkey,
  ADD CONSTRAINT memory_slack_publications_configuration_id_fkey FOREIGN KEY (configuration_id) REFERENCES memory_slack_publication_configurations(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE organization_user_resource_grants
  DROP CONSTRAINT organization_user_resource_grants_session_workspace_fk,
  ADD CONSTRAINT organization_user_resource_grants_session_workspace_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE personal_document_once_consumption_receipts
  DROP CONSTRAINT personal_document_once_consumption_receipts_grant_fk,
  ADD CONSTRAINT personal_document_once_consumption_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE personal_resource_once_consumption_receipts
  DROP CONSTRAINT personal_resource_once_consumption_receipts_grant_fk,
  ADD CONSTRAINT personal_resource_once_consumption_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE retained_screenshot_artifacts
  DROP CONSTRAINT retained_screenshot_artifacts_workspace_file_fk,
  ADD CONSTRAINT retained_screenshot_artifacts_workspace_file_fk FOREIGN KEY (workspace_id, artifact_id) REFERENCES files(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE sandbox_pty_sessions
  DROP CONSTRAINT sandbox_pty_sessions_retained_process_scope_fk,
  ADD CONSTRAINT sandbox_pty_sessions_retained_process_scope_fk FOREIGN KEY (account_id, workspace_id, session_id, lease_id, retained_process_id) REFERENCES sandbox_retained_processes(account_id, workspace_id, session_id, lease_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE sandbox_retained_processes
  DROP CONSTRAINT sandbox_retained_processes_parent_admission_scope_fk,
  ADD CONSTRAINT sandbox_retained_processes_parent_admission_scope_fk FOREIGN KEY (account_id, workspace_id, session_id, lease_id, parent_admission_id) REFERENCES sandbox_workspace_mutation_admissions(account_id, workspace_id, session_id, lease_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT sandbox_retained_processes_workspace_session_fk,
  ADD CONSTRAINT sandbox_retained_processes_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE sandbox_workspace_mutation_admissions
  DROP CONSTRAINT sandbox_workspace_mutation_admissions_workspace_attempt_fk,
  ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT sandbox_workspace_mutation_admissions_workspace_session_fk,
  ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT sandbox_workspace_mutation_admissions_workspace_turn_fk,
  ADD CONSTRAINT sandbox_workspace_mutation_admissions_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_task_connection_authority_snapshots
  DROP CONSTRAINT scheduled_task_connection_authority_sn_grant_id_account_id_fkey,
  ADD CONSTRAINT scheduled_task_connection_authority_sn_grant_id_account_id_fkey FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_task_personal_resource_snapshots
  DROP CONSTRAINT scheduled_task_personal_resource_snapshots_grant_fk,
  ADD CONSTRAINT scheduled_task_personal_resource_snapshots_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_task_run_connection_authority_snapshots
  DROP CONSTRAINT scheduled_task_run_connection_authorit_grant_id_account_id_fkey,
  ADD CONSTRAINT scheduled_task_run_connection_authorit_grant_id_account_id_fkey FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_task_run_personal_resource_admissions
  DROP CONSTRAINT scheduled_task_run_personal_resource_admissions_task_fk,
  ADD CONSTRAINT scheduled_task_run_personal_resource_admissions_task_fk FOREIGN KEY (task_id, task_authority_revision) REFERENCES scheduled_task_personal_resource_authorities(task_id, task_authority_revision) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_task_run_personal_resource_once_receipts
  DROP CONSTRAINT scheduled_task_run_personal_resource_once_receipts_grant_fk,
  ADD CONSTRAINT scheduled_task_run_personal_resource_once_receipts_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_task_run_personal_resource_snapshots
  DROP CONSTRAINT scheduled_task_run_personal_resource_snapshots_task_fk,
  ADD CONSTRAINT scheduled_task_run_personal_resource_snapshots_task_fk FOREIGN KEY (task_id, task_authority_revision, resource_kind, resource_id) REFERENCES scheduled_task_personal_resource_snapshots(task_id, task_authority_revision, resource_kind, resource_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE scheduled_tasks
  DROP CONSTRAINT scheduled_tasks_environment_id_fkey,
  ADD CONSTRAINT scheduled_tasks_environment_id_fkey FOREIGN KEY (variable_set_id) REFERENCES workspace_variable_sets(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_attempt_codemode_calls
  ALTER CONSTRAINT session_attempt_codemode_calls_approval_request_id_fkey DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE session_attempt_connected_machine_authorizations
  DROP CONSTRAINT session_attempt_connected_machine_grant_fk,
  ADD CONSTRAINT session_attempt_connected_machine_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_attempt_interruptions
  DROP CONSTRAINT session_attempt_interruptions_attempt_fk,
  ADD CONSTRAINT session_attempt_interruptions_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_attempt_interruptions_operation_fk,
  ADD CONSTRAINT session_attempt_interruptions_operation_fk FOREIGN KEY (workspace_id, operation_id) REFERENCES session_command_receipts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_attempt_personal_document_snapshots
  DROP CONSTRAINT session_attempt_personal_document_snapshots_grant_fk,
  ADD CONSTRAINT session_attempt_personal_document_snapshots_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_attempt_personal_resource_snapshots
  DROP CONSTRAINT session_attempt_personal_resource_snapshots_grant_fk,
  ADD CONSTRAINT session_attempt_personal_resource_snapshots_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_background_commands
  DROP CONSTRAINT session_background_commands_control_workspace_fk,
  ADD CONSTRAINT session_background_commands_control_workspace_fk FOREIGN KEY (control_workspace_id, account_id) REFERENCES workspaces(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_background_commands_process_fk,
  ADD CONSTRAINT session_background_commands_process_fk FOREIGN KEY (retained_process_id) REFERENCES sandbox_retained_processes(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_command_receipts
  DROP CONSTRAINT session_command_receipts_actor_attempt_fk,
  ADD CONSTRAINT session_command_receipts_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_command_receipts_target_turn_fk,
  ADD CONSTRAINT session_command_receipts_target_turn_fk FOREIGN KEY (workspace_id, target_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE session_events
  DROP CONSTRAINT session_events_duplicate_of_event_fk,
  ADD CONSTRAINT session_events_duplicate_of_event_fk FOREIGN KEY (duplicate_of_event_id) REFERENCES session_events(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_events_workspace_attempt_fk,
  ADD CONSTRAINT session_events_workspace_attempt_fk FOREIGN KEY (workspace_id, turn_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE session_goal_revisions
  DROP CONSTRAINT session_goal_revisions_actor_attempt_fk,
  ADD CONSTRAINT session_goal_revisions_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_goal_revisions_actor_turn_fk,
  ADD CONSTRAINT session_goal_revisions_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_goal_revisions_proposal_fk,
  ADD CONSTRAINT session_goal_revisions_proposal_fk FOREIGN KEY (workspace_id, proposal_id) REFERENCES session_goal_revisions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_goal_revisions_rollback_of_revision_fk,
  ADD CONSTRAINT session_goal_revisions_rollback_of_revision_fk FOREIGN KEY (workspace_id, rollback_of_revision_id) REFERENCES session_goal_revisions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_pending_tool_calls
  DROP CONSTRAINT pending_tool_calls_workspace_attempt_fk,
  ADD CONSTRAINT pending_tool_calls_workspace_attempt_fk FOREIGN KEY (workspace_id, attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE session_realtime_modes
  DROP CONSTRAINT session_realtime_modes_context_projection_fk,
  ADD CONSTRAINT session_realtime_modes_context_projection_fk FOREIGN KEY (context_projection_id) REFERENCES session_realtime_context_projections(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE sessions
  DROP CONSTRAINT sessions_forked_from_session_account_fk,
  ADD CONSTRAINT sessions_forked_from_session_account_fk FOREIGN KEY (forked_from_session_id, account_id) REFERENCES sessions(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_system_updates
  DROP CONSTRAINT session_system_updates_history_item_fk,
  ADD CONSTRAINT session_system_updates_history_item_fk FOREIGN KEY (delivered_history_item_id) REFERENCES session_history_items(id) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE session_turn_attempts
  DROP CONSTRAINT session_turn_attempts_workspace_turn_fk,
  ADD CONSTRAINT session_turn_attempts_workspace_turn_fk FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE session_turns
  ALTER CONSTRAINT session_turns_execution_context_turn_id_fkey DEFERRABLE INITIALLY IMMEDIATE,
  DROP CONSTRAINT session_turns_workspace_active_attempt_fk,
  ADD CONSTRAINT session_turns_workspace_active_attempt_fk FOREIGN KEY (workspace_id, active_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED NOT VALID;

ALTER TABLE session_work_claim_revisions
  DROP CONSTRAINT session_work_claim_revisions_actor_attempt_fk,
  ADD CONSTRAINT session_work_claim_revisions_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_work_claim_revisions_actor_session_fk,
  ADD CONSTRAINT session_work_claim_revisions_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT session_work_claim_revisions_actor_turn_fk,
  ADD CONSTRAINT session_work_claim_revisions_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE slack_shared_task_origins
  DROP CONSTRAINT slack_shared_task_origins_policy_home_fk,
  ADD CONSTRAINT slack_shared_task_origins_policy_home_fk FOREIGN KEY (policy_account_id, policy_workspace_id, policy_revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE slack_task_policy_activation_events
  DROP CONSTRAINT slack_task_policy_events_new_revision_fk,
  ADD CONSTRAINT slack_task_policy_events_new_revision_fk FOREIGN KEY (account_id, workspace_id, new_revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE slack_task_policy_heads
  DROP CONSTRAINT slack_task_policy_heads_revision_fk,
  ADD CONSTRAINT slack_task_policy_heads_revision_fk FOREIGN KEY (account_id, workspace_id, revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE slack_task_policy_revisions
  DROP CONSTRAINT slack_task_policy_revisions_supersedes_fk,
  ADD CONSTRAINT slack_task_policy_revisions_supersedes_fk FOREIGN KEY (account_id, workspace_id, supersedes_revision_id) REFERENCES slack_task_policy_revisions(account_id, workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE task_note_events
  DROP CONSTRAINT task_note_events_actor_attempt_fk,
  ADD CONSTRAINT task_note_events_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT task_note_events_actor_session_fk,
  ADD CONSTRAINT task_note_events_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT task_note_events_actor_turn_fk,
  ADD CONSTRAINT task_note_events_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE task_note_replacement_receipts
  DROP CONSTRAINT task_note_replacement_receipts_actor_attempt_fk,
  ADD CONSTRAINT task_note_replacement_receipts_actor_attempt_fk FOREIGN KEY (workspace_id, actor_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT task_note_replacement_receipts_actor_session_fk,
  ADD CONSTRAINT task_note_replacement_receipts_actor_session_fk FOREIGN KEY (workspace_id, actor_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT task_note_replacement_receipts_actor_turn_fk,
  ADD CONSTRAINT task_note_replacement_receipts_actor_turn_fk FOREIGN KEY (workspace_id, actor_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE task_notes
  DROP CONSTRAINT task_notes_created_by_attempt_fk,
  ADD CONSTRAINT task_notes_created_by_attempt_fk FOREIGN KEY (workspace_id, created_by_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT task_notes_created_by_turn_fk,
  ADD CONSTRAINT task_notes_created_by_turn_fk FOREIGN KEY (workspace_id, created_by_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE transcription_recording_chunks
  DROP CONSTRAINT transcription_recording_chunks_object_fk,
  ADD CONSTRAINT transcription_recording_chunks_object_fk FOREIGN KEY (object_key) REFERENCES transcription_recording_objects(object_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE transcription_recording_segments
  DROP CONSTRAINT transcription_recording_segments_object_fk,
  ADD CONSTRAINT transcription_recording_segments_object_fk FOREIGN KEY (object_key) REFERENCES transcription_recording_objects(object_key) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE turn_connection_authority_snapshots
  DROP CONSTRAINT turn_connection_authority_connection_fk,
  ADD CONSTRAINT turn_connection_authority_connection_fk FOREIGN KEY (connection_id) REFERENCES connections(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT turn_connection_authority_grant_fk,
  ADD CONSTRAINT turn_connection_authority_grant_fk FOREIGN KEY (grant_id, account_id) REFERENCES organization_user_resource_grants(id, account_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE vaults
  DROP CONSTRAINT vaults_provider_connection_id_fkey,
  ADD CONSTRAINT vaults_provider_connection_id_fkey FOREIGN KEY (provider_connection_id) REFERENCES connections(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_artifact_events
  DROP CONSTRAINT workspace_artifact_events_source_attempt_fk,
  ADD CONSTRAINT workspace_artifact_events_source_attempt_fk FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT workspace_artifact_events_source_session_fk,
  ADD CONSTRAINT workspace_artifact_events_source_session_fk FOREIGN KEY (workspace_id, source_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT workspace_artifact_events_source_turn_fk,
  ADD CONSTRAINT workspace_artifact_events_source_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_artifact_versions
  DROP CONSTRAINT workspace_artifact_versions_source_attempt_fk,
  ADD CONSTRAINT workspace_artifact_versions_source_attempt_fk FOREIGN KEY (workspace_id, source_attempt_id) REFERENCES session_turn_attempts(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT workspace_artifact_versions_source_session_fk,
  ADD CONSTRAINT workspace_artifact_versions_source_session_fk FOREIGN KEY (workspace_id, source_session_id) REFERENCES sessions(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT workspace_artifact_versions_source_turn_fk,
  ADD CONSTRAINT workspace_artifact_versions_source_turn_fk FOREIGN KEY (workspace_id, source_turn_id) REFERENCES session_turns(workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_instruction_policy_activation_events
  DROP CONSTRAINT workspace_instruction_policy_activation_ev_new_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_activation_ev_new_revision_id_fkey FOREIGN KEY (new_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT workspace_instruction_policy_activation_ev_old_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_activation_ev_old_revision_id_fkey FOREIGN KEY (old_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_instruction_policy_deactivation_events
  DROP CONSTRAINT workspace_instruction_policy_deactivation__old_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_deactivation__old_revision_id_fkey FOREIGN KEY (old_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_instruction_policy_heads
  DROP CONSTRAINT workspace_instruction_policy_heads_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_heads_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_instruction_policy_onboarding_proposals
  DROP CONSTRAINT workspace_instruction_policy_onboardi_baseline_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_onboardi_baseline_revision_id_fkey FOREIGN KEY (baseline_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID,
  DROP CONSTRAINT workspace_instruction_policy_onboarding__draft_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_onboarding__draft_revision_id_fkey FOREIGN KEY (draft_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_instruction_policy_revisions
  DROP CONSTRAINT workspace_instruction_policy_revisi_supersedes_revision_id_fkey,
  ADD CONSTRAINT workspace_instruction_policy_revisi_supersedes_revision_id_fkey FOREIGN KEY (supersedes_revision_id) REFERENCES workspace_instruction_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_learning_policy_heads
  DROP CONSTRAINT workspace_learning_policy_heads_revision_fk,
  ADD CONSTRAINT workspace_learning_policy_heads_revision_fk FOREIGN KEY (account_id, workspace_id, revision_id) REFERENCES workspace_learning_policy_revisions(account_id, workspace_id, id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE workspace_learning_policy_revisions
  DROP CONSTRAINT workspace_learning_policy_revisions_supersedes_revision_id_fkey,
  ADD CONSTRAINT workspace_learning_policy_revisions_supersedes_revision_id_fkey FOREIGN KEY (supersedes_revision_id) REFERENCES workspace_learning_policy_revisions(id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

DO $defer_workspace_cascade$
DECLARE
  data_schema text := pg_catalog.current_schema();
  role_name text;
BEGIN
  EXECUTE pg_catalog.format($create$
    CREATE FUNCTION opengeni_private.defer_workspace_cascade_foreign_keys()
    RETURNS void
    LANGUAGE plpgsql
    SET search_path = pg_catalog, pg_temp
    AS $body$
    DECLARE
      constraint_names text;
    BEGIN
      -- Every table a workspace deletion removes, through cascading keys.
      WITH RECURSIVE removed(relation_id) AS (
        SELECT %L::regclass::oid
        UNION
        SELECT c.conrelid
        FROM pg_constraint c
        JOIN removed ON c.confrelid = removed.relation_id
        WHERE c.contype = 'f' AND c.confdeltype = 'c' AND c.conparentid = 0
      )
      SELECT string_agg(DISTINCT format('%%I.%%I', n.nspname, c.conname), ', ')
      INTO constraint_names
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND c.conparentid = 0
        AND c.condeferrable AND c.confdeltype = 'a'
        AND c.conrelid IN (SELECT relation_id FROM removed)
        AND c.confrelid IN (SELECT relation_id FROM removed);
      IF constraint_names IS NOT NULL THEN
        EXECUTE 'SET CONSTRAINTS ' || constraint_names || ' DEFERRED';
      END IF;
    END
    $body$
  $create$, pg_catalog.format('%I.workspaces', data_schema));
  REVOKE ALL ON FUNCTION opengeni_private.defer_workspace_cascade_foreign_keys() FROM PUBLIC;
  FOR role_name IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_roles r
    WHERE r.rolname = 'opengeni_app'
      OR r.rolname IN (
        SELECT configured.value FROM pg_catalog.jsonb_array_elements_text(
          coalesce(nullif(pg_catalog.current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
        ) configured(value)
      )
      OR r.oid IN (
        SELECT acl.grantee FROM pg_catalog.pg_proc helper
        CROSS JOIN LATERAL pg_catalog.aclexplode(helper.proacl) acl
        WHERE helper.oid = pg_catalog.format(
          '%I.session_private_actor_visible(uuid,uuid,uuid,text)', data_schema
        )::regprocedure
        AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> helper.proowner
      )
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.defer_workspace_cascade_foreign_keys() TO %I',
      role_name);
  END LOOP;
END
$defer_workspace_cascade$;
