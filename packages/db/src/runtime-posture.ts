import { sql } from "drizzle-orm";
import type { Database, RlsStrategy } from "./database";
import {
  classifyRoleRelationships,
  roleRelationshipsCatalogQuery,
  type RoleRelationshipCatalogRow,
} from "./role-relationships";

const ARTIFACT_OUTBOX_CAPABILITY_ROUTINES = [
  "claim_editable_artifact_live_outbox(text, integer, integer, name)",
  "mark_editable_artifact_live_outbox_published(text, text, integer, name)",
  "renew_editable_artifact_live_outbox(text, text, integer, integer, name)",
  "retry_editable_artifact_live_outbox(text, text, integer, integer, text, name)",
  "dead_letter_editable_artifact_live_outbox(text, text, integer, text, name)",
  "release_editable_artifact_live_outbox(text, text, integer, name)",
] as const;

const ARTIFACT_MATERIALIZER_CAPABILITY_ROUTINES = [
  "claim_editable_artifact_materializations(text, integer, integer, name)",
  "renew_editable_artifact_materialization(uuid, uuid, text, text, text, integer, integer, name)",
  "succeed_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, text, text, bigint, text, text, timestamp with time zone, name)",
  "fail_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, name)",
] as const;

const ARTIFACT_LIVE_TICKET_CAPABILITY_ROUTINES = [
  "put_editable_artifact_live_ticket(text, uuid, uuid, text, text, text, text, text, text, text, text, integer, text, boolean, integer, timestamp with time zone, timestamp with time zone, name)",
  "consume_editable_artifact_live_ticket(text, name)",
  "cleanup_expired_editable_artifact_live_tickets(integer, name)",
] as const;

const ARTIFACT_LIVE_TICKET_INTERNAL_ROUTINES = [
  "resolve_editable_artifact_ticket_data_schema(name)",
] as const;

const ARTIFACT_AUTHORIZATION_CAPABILITY_ROUTINES = [
  "authorize_editable_artifact_actor(uuid, uuid, text, text, text, text, text, text, integer, text, text, name)",
] as const;

const DEDICATED_ARTIFACT_CAPABILITY_ROUTINES = new Set<string>([
  ...ARTIFACT_OUTBOX_CAPABILITY_ROUTINES,
  ...ARTIFACT_MATERIALIZER_CAPABILITY_ROUTINES,
  ...ARTIFACT_LIVE_TICKET_INTERNAL_ROUTINES,
]);

const KNOWLEDGE_SOURCE_SYNC_LOCK_AUTHORITY_ROUTINE =
  "knowledge_source_sync_lock_authority(uuid, uuid, uuid)";
const GOOGLE_DRIVE_FILE_AUTHORIZATION_ROUTINE =
  "google_drive_file_authorized(uuid, uuid, text, uuid)";
const GOOGLE_DRIVE_DOCUMENT_CITATION_ROUTINE =
  "google_drive_document_citation(uuid, uuid, text, uuid, uuid)";
const GOOGLE_DRIVE_AUTHORITY_TABLES = [
  "connections",
  "files",
  "google_drive_object_acl_evidence",
  "google_drive_object_acl_principals",
  "knowledge_document_versions",
  "knowledge_providers",
  "knowledge_source_objects",
  "knowledge_source_sync_index_obligations",
  "knowledge_source_sync_states",
  "knowledge_sources",
] as const;
const KNOWLEDGE_SOURCE_SYNC_LOCK_AUTHORITY_TABLES = [
  "knowledge_sources",
  "knowledge_source_objects",
] as const;
const MANAGED_HUMAN_PERSONAL_WORKSPACE_ROUTINE =
  "ensure_managed_human_personal_workspace(uuid, text, uuid)";
const PREFERENCE_KNOWLEDGE_PROPOSAL_ROUTINE =
  "preference_registry_create_knowledge_proposal_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text, integer, text, jsonb, timestamp with time zone, text)";
const PREFERENCE_KNOWLEDGE_PROPOSAL_AUTHORITY_TABLES = [
  "company_brain_preference_proposal_receipts",
  "knowledge_change_proposals",
  "knowledge_claim_evidence",
  "knowledge_claim_reviews",
  "knowledge_claims",
  "preference_registry_events",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "session_attempt_interruptions",
  "session_turn_attempts",
  "session_turns",
  "sessions",
  "workspaces",
] as const;
const MANAGED_HUMAN_PERSONAL_WORKSPACE_AUTHORITY_TABLES = [
  "organization_memberships",
  "organization_user_retention_policies",
  "organization_user_resource_authorities",
  "organization_user_resource_grants",
] as const;
const PERSONAL_RESOURCE_ATTEMPT_RESOLVER_ROUTINE =
  "resolve_session_attempt_personal_resources(uuid, uuid, uuid)";
const USER_RESOURCE_LIFECYCLE_ROUTINES = [
  "list_self_user_resource_authorities(uuid)",
  "issue_self_user_resource_grant(uuid, uuid, uuid, text, text, text, uuid, boolean)",
  "revoke_self_user_resource_grant(uuid, uuid)",
  "authorize_session_attempt_personal_resource_reads(uuid, uuid, uuid)",
] as const;
const CONNECTION_AUTHORITY_ROUTINES = [
  "list_self_connection_authorities(uuid)",
  "issue_self_connection_use_grant(uuid, uuid, uuid, text, text, uuid, boolean)",
  "revoke_self_connection_use_grant(uuid, uuid)",
  "resolve_connection_use_authority(uuid, uuid, uuid, jsonb)",
] as const;
const SCHEDULED_PERSONAL_RESOURCE_ROUTINES = [
  "freeze_scheduled_task_personal_resources(uuid, uuid, uuid, bigint)",
  "clone_scheduled_task_personal_resource_authority(uuid, uuid, uuid, bigint, bigint)",
  "materialize_scheduled_task_reusable_session_from_run(uuid, uuid, uuid, uuid, uuid, bigint, text)",
  "scheduled_task_run_personal_resource_authority(uuid, uuid, uuid)",
] as const;
const PERSONAL_RESOURCE_CAPABILITY_PREDICATE_ROUTINE =
  "personal_resource_delegation_capability_active(text)";
const PERSONAL_RESOURCE_CAPABILITY_TABLE = "personal_resource_delegation_capabilities";
const SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_PREDICATE_ROUTINE =
  "scheduled_personal_resource_capability_active(text)";
const SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_TABLE = "scheduled_personal_resource_capabilities";
const VARIABLE_SET_CAPABILITY_PREDICATE_ROUTINE = "variable_set_authority_capability_active(text)";
const VARIABLE_SET_CAPABILITY_TABLE = "variable_set_authority_capabilities";
const PERSONAL_DOCUMENT_CAPABILITY_PREDICATE_ROUTINE =
  "personal_document_authority_capability_active(text)";
const PERSONAL_DOCUMENT_CAPABILITY_TABLE = "personal_document_authority_capabilities";
const PERSONAL_DOCUMENT_AUTHORITY_ROUTINES = [
  "create_personal_document_authority(uuid, uuid, uuid)",
  "resolve_document_original_file(uuid, uuid, text, uuid)",
  "resolve_session_attempt_personal_document_reads(uuid, uuid, uuid, uuid)",
] as const;
const VARIABLE_SET_AUTHORITY_ROUTINES = [
  "create_scoped_variable_set(uuid, uuid, text, text, text, jsonb, boolean)",
  "list_scoped_variable_sets(uuid, uuid, uuid, text, text)",
  "count_scoped_variable_sets(uuid, uuid, text)",
  "mutate_scoped_variable_set(uuid, uuid, uuid, text, text, boolean, text, boolean, text, text, boolean)",
  "read_scoped_variable_set_secret(uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, integer)",
  "materialize_scoped_variable_set_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid)",
  "materialize_scoped_variable_set_for_session(uuid, uuid, uuid, uuid)",
] as const;
const SCOPED_COMPUTE_CAPABILITY_PREDICATE_ROUTINE = "scoped_compute_capability_active(text)";
const SCOPED_COMPUTE_CAPABILITY_TABLE = "scoped_compute_capabilities";
const SCOPED_COMPUTE_AUTHORITY_ROUTINES = [
  "create_scoped_rig(uuid, uuid, text, text, text, text, jsonb, boolean)",
  "list_scoped_rigs(uuid, uuid, uuid, text, text)",
  "count_scoped_rigs(uuid, uuid, text)",
  "mutate_scoped_rig(uuid, uuid, uuid, text, text, boolean, text, boolean, boolean)",
  "finalize_scoped_enrollment(uuid, uuid, text, text, boolean, boolean, text, text, text, boolean)",
  "list_scoped_enrollments(uuid, uuid, uuid, text)",
  "get_scoped_sandbox(uuid, uuid, uuid)",
  "authorize_scoped_sandbox_attach(uuid, uuid, uuid)",
  "materialize_scoped_rig_version_for_attempt(uuid, uuid, uuid, uuid, uuid, integer)",
  "assert_session_attempt_personal_machine(uuid, uuid, uuid, uuid, uuid, integer, uuid)",
] as const;
const CANONICAL_HUMAN_IDENTITY_ROUTINES = [
  "ensure_canonical_human_identity(text, text)",
  "validate_canonical_human_session(text, text, boolean)",
  "get_canonical_human_identity_projection(text)",
  "apply_canonical_human_identity_operation(uuid, text, bigint, text, uuid, text, text, text)",
] as const;
const CANONICAL_HUMAN_IDENTITY_AUTHORITY_TABLES = [
  "canonical_human_identities",
  "canonical_human_identity_subjects",
  "canonical_human_login_bindings",
  "canonical_human_identity_operations",
] as const;
const SESSION_PRIVATE_ACTOR_VISIBLE_ROUTINE =
  "session_private_actor_visible(uuid, uuid, uuid, text)";
const SESSION_REFERENCE_VISIBLE_ROUTINE = "session_reference_visible(uuid, uuid, uuid)";
const TASK_NOTE_CAPABILITY_ROUTINES = [
  "create_task_note_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, integer)",
  "archive_task_note_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, integer, text)",
  "list_task_notes_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, boolean, integer)",
] as const;
const TRANSITION_SESSION_VISIBILITY_ROUTINE =
  "transition_session_visibility(uuid, uuid, uuid, text, text, integer, text, text)";
const FORK_SESSION_CONTENT_ROUTINE =
  "fork_session_content(uuid, uuid, uuid, text, uuid, text, text, text)";
const SESSION_AUTHORITY_ROUTINES = new Set<string>([
  FORK_SESSION_CONTENT_ROUTINE,
  PERSONAL_RESOURCE_ATTEMPT_RESOLVER_ROUTINE,
  ...USER_RESOURCE_LIFECYCLE_ROUTINES,
  ...CONNECTION_AUTHORITY_ROUTINES,
  ...SCHEDULED_PERSONAL_RESOURCE_ROUTINES,
  SESSION_PRIVATE_ACTOR_VISIBLE_ROUTINE,
  SESSION_REFERENCE_VISIBLE_ROUTINE,
  TRANSITION_SESSION_VISIBILITY_ROUTINE,
  ...TASK_NOTE_CAPABILITY_ROUTINES,
]);
const XAI_CREATE_CREDENTIAL_ROUTINE =
  "create_xai_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone)";
const XAI_DISCONNECT_CREDENTIAL_ROUTINE =
  "disconnect_xai_subscription_credential(uuid, uuid, text, uuid, jsonb)";
const XAI_SNAPSHOT_VALIDATOR_ROUTINE = "xai_provider_account_authority_snapshot_v1_valid(jsonb)";
const XAI_AUTHORITY_LIVE_ROUTINE =
  "xai_subscription_authority_live(uuid, uuid, text, uuid, text, uuid, uuid, bigint)";
const XAI_POOL_VISIBLE_ROUTINE = "xai_subscription_pool_visible(uuid, uuid, text, text, uuid)";
const XAI_RESOLVE_POOL_ROUTINE = "resolve_xai_authority_pool(uuid, uuid, text, jsonb)";
const XAI_REVALIDATE_CREDENTIAL_ROUTINE =
  "revalidate_xai_subscription_authority(uuid, text, uuid, jsonb)";
const XAI_AUTHORITY_TABLES = [
  "organization_memberships",
  "organization_user_resource_authorities",
  "workspace_memberships",
  "xai_subscription_credentials",
] as const;

export const RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES = [
  FORK_SESSION_CONTENT_ROUTINE,
  XAI_AUTHORITY_LIVE_ROUTINE,
  XAI_CREATE_CREDENTIAL_ROUTINE,
  XAI_DISCONNECT_CREDENTIAL_ROUTINE,
  GOOGLE_DRIVE_DOCUMENT_CITATION_ROUTINE,
  GOOGLE_DRIVE_FILE_AUTHORIZATION_ROUTINE,
  KNOWLEDGE_SOURCE_SYNC_LOCK_AUTHORITY_ROUTINE,
  MANAGED_HUMAN_PERSONAL_WORKSPACE_ROUTINE,
  PERSONAL_RESOURCE_ATTEMPT_RESOLVER_ROUTINE,
  PREFERENCE_KNOWLEDGE_PROPOSAL_ROUTINE,
  ...VARIABLE_SET_AUTHORITY_ROUTINES,
  ...CONNECTION_AUTHORITY_ROUTINES,
  ...PERSONAL_DOCUMENT_AUTHORITY_ROUTINES,
  ...SCOPED_COMPUTE_AUTHORITY_ROUTINES,
  ...CANONICAL_HUMAN_IDENTITY_ROUTINES,
  SESSION_PRIVATE_ACTOR_VISIBLE_ROUTINE,
  SESSION_REFERENCE_VISIBLE_ROUTINE,
  TRANSITION_SESSION_VISIBILITY_ROUTINE,
  XAI_POOL_VISIBLE_ROUTINE,
  XAI_RESOLVE_POOL_ROUTINE,
  XAI_REVALIDATE_CREDENTIAL_ROUTINE,
  XAI_SNAPSHOT_VALIDATOR_ROUTINE,
] as const;

export const RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES = [
  SESSION_REFERENCE_VISIBLE_ROUTINE,
  XAI_SNAPSHOT_VALIDATOR_ROUTINE,
] as const;
const RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINE_SET = new Set<string>(
  RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES,
);

/**
 * The complete standalone tenant-table contract. Adding or removing a
 * FORCE-RLS table is an architectural change: update this list in the same
 * commit as the migration so startup cannot silently accept an unreviewed gap.
 */
export const FORCE_RLS_TABLES = [
  "agent_run_states",
  "api_keys",
  "attached_browser_devices",
  "attached_browser_inventories",
  "audit_events",
  "auth_runs",
  "billing_customers",
  "browser_identities",
  "browser_revision_components",
  "browser_revisions",
  "browser_session_associations",
  "browser_sessions",
  "browser_state_artifacts",
  "browser_state_uploads",
  "canonical_human_identities",
  "canonical_human_identity_operations",
  "canonical_human_identity_subjects",
  "canonical_human_login_bindings",
  "capability_api_facets",
  "capability_catalog_items",
  "capability_component_owners",
  "capability_facet_installations",
  "capability_facets",
  "capability_installations",
  "capability_integration_facets",
  "capability_mcp_facets",
  "capability_operations",
  "capability_plugin_installations",
  "capability_plugin_versions",
  "capability_plugins",
  "capability_skill_facets",
  "capability_skill_files",
  "channels",
  "codex_apps_settings",
  "codex_capacity_waiters",
  "codex_credential_leases",
  "codex_reset_redemption_attempts",
  "codex_rotation_settings",
  "codex_subscription_credentials",
  "company_brain_preference_proposal_receipts",
  "company_profile_activation_events",
  "company_profile_heads",
  "company_profile_revisions",
  "company_profile_snapshots",
  "composer_drafts",
  "computer_session_associations",
  "computer_sessions",
  "connection_disconnect_operations",
  "connection_use_once_consumption_receipts",
  "connections",
  "connector_action_policies",
  "connector_action_requests",
  "credit_ledger_entries",
  "device_enrollment_requests",
  "document_bases",
  "document_chunks",
  "documents",
  "editable_artifact_blob_refs",
  "editable_artifact_idempotency_receipts",
  "editable_artifact_live_outbox",
  "editable_artifact_live_tickets",
  "editable_artifact_materialization_jobs",
  "editable_artifact_materialization_results",
  "editable_artifact_operations",
  "editable_artifact_replica_leases",
  "editable_artifact_scope_authorization_heads",
  "editable_artifact_sequence_checkpoints",
  "editable_artifact_session_links",
  "editable_artifact_snapshots",
  "editable_artifact_transactions",
  "editable_artifact_undo_claims",
  "editable_artifact_versions",
  "editable_artifacts",
  "enrollments",
  "file_uploads",
  "files",
  "generated_image_artifacts",
  "generated_video_artifacts",
  "github_installation_repositories",
  "github_installations",
  "google_drive_object_acl_evidence",
  "google_drive_object_acl_principals",
  "host_export_config",
  "host_export_consumers",
  "host_export_cursor_state",
  "host_export_dead_letters",
  "host_export_outbox",
  "image_generation_operations",
  "import_batches",
  "integration_facet_binding_owners",
  "integration_facet_bindings",
  "integration_facet_definitions",
  "integration_oauth_state_nonces",
  "integration_spec_revisions",
  "integration_tools",
  "interaction_interventions",
  "interaction_operations",
  "interaction_resource_operations",
  "knowledge_change_proposals",
  "knowledge_claim_evidence",
  "knowledge_claim_relations",
  "knowledge_claim_reviews",
  "knowledge_claims",
  "knowledge_document_versions",
  "knowledge_entities",
  "knowledge_entity_aliases",
  "knowledge_facts",
  "knowledge_lifecycle_events",
  "knowledge_memories",
  "knowledge_memory_lifecycle_events",
  "knowledge_memory_relationships",
  "knowledge_operation_receipts",
  "knowledge_providers",
  "knowledge_source_acl_versions",
  "knowledge_source_objects",
  "knowledge_source_sync_index_obligations",
  "knowledge_source_sync_item_outcomes",
  "knowledge_source_sync_object_observations",
  "knowledge_source_sync_states",
  "knowledge_source_sync_wakes",
  "knowledge_sources",
  "knowledge_sync_runs",
  "machine_metrics_latest",
  "machine_metrics_series",
  "machine_removal_operations",
  "memory_slack_publication_configurations",
  "memory_slack_publication_receipts",
  "memory_slack_publications",
  "model_call_facts",
  "network_routes",
  "new_session_drafts",
  "organization_memberships",
  "organization_user_resource_authorities",
  "organization_user_resource_grants",
  "organization_user_retention_policies",
  "pack_installation_components",
  "pack_installations",
  "personal_document_once_consumption_receipts",
  "personal_resource_once_consumption_receipts",
  "preference_registry_events",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "preference_registry_snapshots",
  "retained_screenshot_artifacts",
  "rig_changes",
  "rig_versions",
  "rigs",
  "sandbox_checkpoint_artifacts",
  "sandbox_lease_holders",
  "sandbox_leases",
  "sandbox_pty_sessions",
  "sandbox_retained_processes",
  "sandbox_session_envelopes",
  "sandbox_workspace_mutation_admissions",
  "sandboxes",
  "scheduled_task_personal_resource_authorities",
  "scheduled_task_personal_resource_snapshots",
  "scheduled_task_run_personal_resource_admissions",
  "scheduled_task_run_personal_resource_once_receipts",
  "scheduled_task_run_personal_resource_snapshots",
  "scheduled_task_runs",
  "scheduled_tasks",
  "session_attempt_codemode_calls",
  "session_attempt_connected_machine_authorizations",
  "session_attempt_interruptions",
  "session_attempt_personal_document_admissions",
  "session_attempt_personal_document_snapshots",
  "session_attempt_personal_resource_admissions",
  "session_attempt_personal_resource_snapshots",
  "session_attempt_tool_catalogs",
  "session_command_receipts",
  "session_events",
  "session_goal_revisions",
  "session_goals",
  "session_history_items",
  "session_human_input_requests",
  "session_list_snapshots",
  "session_mcp_servers",
  "session_pending_tool_calls",
  "session_pins",
  "session_realtime_connections",
  "session_realtime_context_projections",
  "session_realtime_entries",
  "session_realtime_modes",
  "session_recordings",
  "session_spawn_denials",
  "session_stream_acknowledgments",
  "session_system_update_outbox",
  "session_system_updates",
  "session_turn_attempts",
  "session_turns",
  "session_visibility_write_capabilities",
  "session_workflow_wake_outbox",
  "sessions",
  "site_auth_connections",
  "slack_app_home_refreshes",
  "slack_bot_delete_operations",
  "slack_bot_post_operations",
  "slack_bot_update_operations",
  "slack_bot_user_links",
  "slack_installation_bindings",
  "slack_interaction_action_handles",
  "slack_interaction_inbox",
  "slack_interaction_progress_deliveries",
  "slack_interactions",
  "slack_shared_task_origins",
  "slack_task_policy_activation_events",
  "slack_task_policy_heads",
  "slack_task_policy_revisions",
  "slack_user_link_access_request_operations",
  "slack_user_link_access_requests",
  "social_connections",
  "social_posts",
  "task_note_events",
  "task_note_write_capabilities",
  "task_notes",
  "temporal_schedule_cleanup_outbox",
  "transcription_recording_chunks",
  "transcription_recording_objects",
  "transcription_recording_segments",
  "transcription_recordings",
  "usage_events",
  "video_generation_operations",
  "video_generation_references",
  "workspace_artifact_events",
  "workspace_artifact_versions",
  "workspace_artifacts",
  "workspace_captures",
  "workspace_control_events",
  "workspace_inference_controls",
  "workspace_instruction_policy_activation_events",
  "workspace_instruction_policy_heads",
  "workspace_instruction_policy_onboarding_proposals",
  "workspace_instruction_policy_revisions",
  "workspace_instruction_policy_snapshots",
  "workspace_interaction_revisions",
  "workspace_learning_policy_activation_events",
  "workspace_learning_policy_heads",
  "workspace_learning_policy_revisions",
  "workspace_learning_policy_snapshots",
  "workspace_model_policies",
  "workspace_packs",
  "workspace_screenshot_quotas",
  "workspace_session_activity_revisions",
  "workspace_variable_set_variables",
  "workspace_variable_sets",
  "workspace_video_generation_policies",
  "workspace_video_generation_quotas",
  "xai_capacity_waiters",
  "xai_credential_leases",
  "xai_rotation_settings",
  "xai_session_account_pins",
  "xai_subscription_credentials",
] as const;

/**
 * Deployment-global and authentication tables used by ordinary API/worker
 * traffic. They intentionally do not carry workspace RLS: their access model
 * is implemented by the authentication/access layer or by exact global keys.
 */
export const NON_RLS_RUNTIME_TABLES = [
  "auth_identities",
  "auth_rate_limits",
  "auth_sessions",
  "auth_users",
  "auth_verifications",
  "integration_oauth_clients",
  "managed_accounts",
  "nested_agent_depth_configuration",
  "stripe_webhook_events",
  "workspace_memberships",
  "workspaces",
] as const;

/**
 * Exact full-CRUD class for the standalone runtime role. This is deliberately
 * explicit instead of being derived from FORCE_RLS_TABLES: adding a protected
 * table must not silently grant it broader DML than its migration intended.
 */
export const RUNTIME_FULL_DML_TABLES = [
  "agent_run_states",
  "api_keys",
  "audit_events",
  "auth_identities",
  "auth_rate_limits",
  "auth_sessions",
  "auth_users",
  "auth_verifications",
  "billing_customers",
  "browser_session_associations",
  "capability_catalog_items",
  "capability_component_owners",
  "capability_facet_installations",
  "capability_installations",
  "capability_operations",
  "capability_plugin_installations",
  "channels",
  "codex_apps_settings",
  "codex_capacity_waiters",
  "codex_credential_leases",
  "codex_reset_redemption_attempts",
  "codex_rotation_settings",
  "codex_subscription_credentials",
  "composer_drafts",
  "computer_session_associations",
  "connection_disconnect_operations",
  "connections",
  "connector_action_policies",
  "connector_action_requests",
  "credit_ledger_entries",
  "device_enrollment_requests",
  "document_bases",
  "document_chunks",
  "documents",
  "editable_artifact_replica_leases",
  "enrollments",
  "file_uploads",
  "files",
  "generated_image_artifacts",
  "generated_video_artifacts",
  "github_installation_repositories",
  "github_installations",
  "image_generation_operations",
  "import_batches",
  "integration_facet_binding_owners",
  "integration_facet_bindings",
  "integration_oauth_clients",
  "integration_oauth_state_nonces",
  "knowledge_memories",
  "knowledge_source_sync_index_obligations",
  "knowledge_source_sync_item_outcomes",
  "knowledge_source_sync_object_observations",
  "knowledge_source_sync_states",
  "knowledge_source_sync_wakes",
  "machine_metrics_latest",
  "machine_metrics_series",
  "machine_removal_operations",
  "managed_accounts",
  "memory_slack_publication_configurations",
  "memory_slack_publication_receipts",
  "memory_slack_publications",
  "model_call_facts",
  "new_session_drafts",
  "pack_installation_components",
  "pack_installations",
  "retained_screenshot_artifacts",
  "rig_changes",
  "rig_versions",
  "rigs",
  "sandbox_checkpoint_artifacts",
  "sandbox_lease_holders",
  "sandbox_leases",
  "sandbox_pty_sessions",
  "sandbox_retained_processes",
  "sandbox_session_envelopes",
  "sandbox_workspace_mutation_admissions",
  "sandboxes",
  "scheduled_task_runs",
  "scheduled_tasks",
  "session_attempt_interruptions",
  "session_command_receipts",
  "session_events",
  "session_goals",
  "session_history_items",
  "session_human_input_requests",
  "session_list_snapshots",
  "session_mcp_servers",
  "session_pending_tool_calls",
  "session_pins",
  "session_realtime_connections",
  "session_realtime_context_projections",
  "session_realtime_entries",
  "session_realtime_modes",
  "session_recordings",
  "session_stream_acknowledgments",
  "session_system_update_outbox",
  "session_system_updates",
  "session_turn_attempts",
  "session_turns",
  "session_workflow_wake_outbox",
  "sessions",
  "slack_app_home_refreshes",
  "slack_bot_delete_operations",
  "slack_bot_post_operations",
  "slack_bot_update_operations",
  "slack_bot_user_links",
  "slack_interaction_action_handles",
  "slack_interaction_inbox",
  "slack_interaction_progress_deliveries",
  "slack_interactions",
  "social_connections",
  "social_posts",
  "stripe_webhook_events",
  "transcription_recording_chunks",
  "transcription_recording_objects",
  "transcription_recording_segments",
  "transcription_recordings",
  "usage_events",
  "video_generation_operations",
  "video_generation_references",
  "workspace_artifacts",
  "workspace_captures",
  "workspace_control_events",
  "workspace_inference_controls",
  "workspace_instruction_policy_heads",
  "workspace_memberships",
  "workspace_model_policies",
  "workspace_packs",
  "workspace_screenshot_quotas",
  "workspace_video_generation_policies",
  "workspace_video_generation_quotas",
  "workspaces",
  "xai_capacity_waiters",
  "xai_credential_leases",
  "xai_rotation_settings",
  "xai_session_account_pins",
  "xai_subscription_credentials",
] as const;

/** Configuration and lifecycle-owned audit rows are read-only at runtime. */
export const RUNTIME_READ_ONLY_TABLES = [
  "company_profile_activation_events",
  "company_profile_heads",
  "company_profile_snapshots",
  "knowledge_lifecycle_events",
  "knowledge_memory_lifecycle_events",
  "knowledge_memory_relationships",
  "nested_agent_depth_configuration",
  "preference_registry_events",
  "preference_registry_snapshots",
  "slack_installation_bindings",
  "slack_task_policy_activation_events",
  "slack_task_policy_heads",
  "slack_task_policy_revisions",
  "workspace_instruction_policy_snapshots",
  "workspace_learning_policy_activation_events",
  "workspace_learning_policy_heads",
  "workspace_learning_policy_snapshots",
] as const;

/** Existing runtime authorities that may be observed and advanced, never created or deleted. */
export const RUNTIME_READ_UPDATE_TABLES = ["workspace_session_activity_revisions"] as const;

/** Append-only evidence/revision tables are insertable and queryable, never mutable. */
export const RUNTIME_READ_INSERT_TABLES = [
  "browser_revision_components",
  "browser_revisions",
  "company_profile_revisions",
  "editable_artifact_blob_refs",
  "editable_artifact_idempotency_receipts",
  "editable_artifact_live_outbox",
  "editable_artifact_materialization_jobs",
  "editable_artifact_materialization_results",
  "editable_artifact_operations",
  "editable_artifact_sequence_checkpoints",
  "editable_artifact_snapshots",
  "editable_artifact_transactions",
  "editable_artifact_undo_claims",
  "editable_artifact_versions",
  "google_drive_object_acl_evidence",
  "google_drive_object_acl_principals",
  "knowledge_change_proposals",
  "knowledge_claim_evidence",
  "knowledge_claim_relations",
  "knowledge_claim_reviews",
  "knowledge_claims",
  "knowledge_document_versions",
  "knowledge_entities",
  "knowledge_entity_aliases",
  "knowledge_facts",
  "knowledge_operation_receipts",
  "knowledge_providers",
  "knowledge_source_acl_versions",
  "knowledge_source_objects",
  "knowledge_sources",
  "knowledge_sync_runs",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "session_attempt_tool_catalogs",
  "session_goal_revisions",
  "session_spawn_denials",
  "slack_shared_task_origins",
  "slack_user_link_access_request_operations",
  "temporal_schedule_cleanup_outbox",
  "workspace_artifact_events",
  "workspace_artifact_versions",
  "workspace_instruction_policy_activation_events",
  "workspace_instruction_policy_onboarding_proposals",
  "workspace_instruction_policy_revisions",
  "workspace_learning_policy_revisions",
] as const;

/** Durable operation journals are append/read plus claim/settle updates, never deletes. */
export const RUNTIME_READ_INSERT_UPDATE_TABLES = [
  "attached_browser_devices",
  "attached_browser_inventories",
  "auth_runs",
  "browser_identities",
  "browser_sessions",
  "browser_state_artifacts",
  "browser_state_uploads",
  "capability_api_facets",
  "capability_facets",
  "capability_integration_facets",
  "capability_mcp_facets",
  "capability_plugin_versions",
  "capability_plugins",
  "capability_skill_facets",
  "capability_skill_files",
  "computer_sessions",
  "editable_artifact_session_links",
  "editable_artifacts",
  "integration_facet_definitions",
  "integration_spec_revisions",
  "integration_tools",
  "interaction_interventions",
  "interaction_operations",
  "interaction_resource_operations",
  "network_routes",
  "session_attempt_codemode_calls",
  "site_auth_connections",
  "slack_user_link_access_requests",
  "workspace_interaction_revisions",
] as const;

/**
 * These FORCE-RLS tables are owned by security-definer host-export routines.
 * The ordinary application role must have no direct table privileges on them.
 */
export const PROTECTED_NO_DIRECT_DML_TABLES = [
  "canonical_human_identities",
  "canonical_human_identity_operations",
  "canonical_human_identity_subjects",
  "canonical_human_login_bindings",
  "company_brain_preference_proposal_receipts",
  "connection_use_once_consumption_receipts",
  "editable_artifact_live_tickets",
  "editable_artifact_scope_authorization_heads",
  "host_export_config",
  "host_export_consumers",
  "host_export_cursor_state",
  "host_export_dead_letters",
  "host_export_outbox",
  "organization_memberships",
  "organization_user_resource_authorities",
  "organization_user_resource_grants",
  "organization_user_retention_policies",
  "personal_document_once_consumption_receipts",
  "personal_resource_once_consumption_receipts",
  "scheduled_task_personal_resource_authorities",
  "scheduled_task_personal_resource_snapshots",
  "scheduled_task_run_personal_resource_admissions",
  "scheduled_task_run_personal_resource_once_receipts",
  "scheduled_task_run_personal_resource_snapshots",
  "session_attempt_personal_document_admissions",
  "session_attempt_personal_document_snapshots",
  "session_attempt_connected_machine_authorizations",
  "session_attempt_personal_resource_admissions",
  "session_attempt_personal_resource_snapshots",
  "session_visibility_write_capabilities",
  "task_note_events",
  "task_note_write_capabilities",
  "task_notes",
  "workspace_variable_set_variables",
  "workspace_variable_sets",
] as const;

export type RuntimeTableDmlPrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
export type RuntimeTablePrivilegeContract = Readonly<
  Record<string, readonly RuntimeTableDmlPrivilege[]>
>;

const FULL_DML_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** Exact per-table DML contract. Absence means no direct table privileges. */
export const RUNTIME_TABLE_PRIVILEGES: RuntimeTablePrivilegeContract = Object.freeze({
  ...Object.fromEntries(RUNTIME_FULL_DML_TABLES.map((table) => [table, FULL_DML_PRIVILEGES])),
  ...Object.fromEntries(RUNTIME_READ_ONLY_TABLES.map((table) => [table, ["SELECT"] as const])),
  ...Object.fromEntries(
    RUNTIME_READ_UPDATE_TABLES.map((table) => [table, ["SELECT", "UPDATE"] as const]),
  ),
  ...Object.fromEntries(
    RUNTIME_READ_INSERT_TABLES.map((table) => [table, ["SELECT", "INSERT"] as const]),
  ),
  ...Object.fromEntries(
    RUNTIME_READ_INSERT_UPDATE_TABLES.map((table) => [
      table,
      ["SELECT", "INSERT", "UPDATE"] as const,
    ]),
  ),
});

/** All tables with any direct runtime DML; retained as the aggregate public contract. */
export const RUNTIME_DML_TABLES = Object.freeze(
  Object.keys(RUNTIME_TABLE_PRIVILEGES).sort((a, b) => a.localeCompare(b)),
);

export type RuntimeDatabasePostureOptions = {
  rlsStrategy: RlsStrategy;
  expectedRole?: string;
  targetSchema?: string;
  protectedTables?: readonly string[];
  tablePrivileges?: RuntimeTablePrivilegeContract;
  protectedNoDirectDmlTables?: readonly string[];
};

export type RuntimeDatabaseIdentity = {
  currentUser: string;
  sessionUser: string;
  databaseOwner: string;
  canConnectDatabase: boolean;
  canCreateInDatabase: boolean;
  rowSecurity: string;
  canLogin: boolean;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDatabase: boolean;
  replication: boolean;
  bypassRls: boolean;
};

export type RuntimeSchemaPosture = {
  name: string;
  owner: string;
  usage: boolean;
  create: boolean;
};

export type RuntimeTablePosture = {
  name: string;
  owner: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  rlsActive: boolean;
  policyCount: number;
  artifactOutboxDispatcherPolicy: boolean;
  artifactMaterializerPolicy: boolean;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  references: boolean;
  trigger: boolean;
};

export type RuntimeRoutinePosture = {
  name: string;
  owner: string;
  execute: boolean;
  publicExecute?: boolean;
  securityDefiner: boolean;
};

export type RuntimeTargetRoutinePosture = RuntimeRoutinePosture & {
  publicExecute: boolean;
};

export type RuntimePrivateTablePosture = {
  name: string;
  owner: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
};

export type RuntimeDatabasePosture = {
  identity: RuntimeDatabaseIdentity;
  /** Privilege-bearing role relationships; exact PG16+ management-only grants are excluded. */
  memberships: string[];
  schemas: RuntimeSchemaPosture[];
  ownedSchemas: string[];
  ownedRelations: string[];
  tables: RuntimeTablePosture[];
  privateTables: RuntimePrivateTablePosture[];
  targetRoutines: RuntimeTargetRoutinePosture[];
  privateRoutines: RuntimeRoutinePosture[];
};

export class RuntimeDatabasePostureError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Runtime database posture check failed: ${violations.join("; ")}`);
    this.name = "RuntimeDatabasePostureError";
    this.violations = violations;
  }
}

type IdentityRow = {
  current_user: string;
  session_user: string;
  database_owner: string;
  can_connect_database: boolean;
  can_create_in_database: boolean;
  row_security: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) {
    return rows as T[];
  }
  throw new Error("Runtime database posture query returned an unsupported result shape");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return sorted([...left].filter((value) => !right.has(value)));
}

/** Inspect only PostgreSQL catalogs and privilege functions; no tenant rows. */
export async function inspectRuntimeDatabasePosture(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): Promise<RuntimeDatabasePosture> {
  const targetSchema = options.targetSchema?.trim() || "public";

  return await db.transaction(
    async (tx) => {
      const identityRows = resultRows<IdentityRow>(
        await tx.execute(sql`
          select
            current_user::text as current_user,
            session_user::text as session_user,
            pg_get_userbyid(d.datdba)::text as database_owner,
            has_database_privilege(current_user, d.oid, 'CONNECT') as can_connect_database,
            has_database_privilege(current_user, d.oid, 'CREATE') as can_create_in_database,
            current_setting('row_security')::text as row_security,
            r.rolcanlogin,
            r.rolsuper,
            r.rolinherit,
            r.rolcreaterole,
            r.rolcreatedb,
            r.rolreplication,
            r.rolbypassrls
          from pg_roles r
          join pg_database d on d.datname = current_database()
          where r.rolname = current_user
        `),
      );
      const identity = identityRows[0];
      if (!identity) {
        throw new Error("Runtime database posture could not resolve the current PostgreSQL role");
      }

      const mappedIdentity: RuntimeDatabaseIdentity = {
        currentUser: identity.current_user,
        sessionUser: identity.session_user,
        databaseOwner: identity.database_owner,
        canConnectDatabase: identity.can_connect_database,
        canCreateInDatabase: identity.can_create_in_database,
        rowSecurity: identity.row_security,
        canLogin: identity.rolcanlogin,
        superuser: identity.rolsuper,
        inherit: identity.rolinherit,
        createRole: identity.rolcreaterole,
        createDatabase: identity.rolcreatedb,
        replication: identity.rolreplication,
        bypassRls: identity.rolbypassrls,
      };

      // Scoped/embedded topology deliberately leaves ownership and isolation to
      // the host. Prove the connection identity is coherent, but do not impose
      // the standalone opengeni_app object/grant contract on the host's role.
      if (options.rlsStrategy === "scoped") {
        return {
          identity: mappedIdentity,
          memberships: [],
          schemas: [],
          ownedSchemas: [],
          ownedRelations: [],
          tables: [],
          privateTables: [],
          targetRoutines: [],
          privateRoutines: [],
        };
      }

      const relationshipRows = resultRows<RoleRelationshipCatalogRow>(
        await tx.execute(sql.raw(roleRelationshipsCatalogQuery("current_user"))),
      );
      const memberships = classifyRoleRelationships(relationshipRows).unsafeRelationships;

      const schemas = resultRows<{
        name: string;
        owner: string;
        usage: boolean;
        create: boolean;
      }>(
        await tx.execute(sql`
          select
            n.nspname::text as name,
            pg_get_userbyid(n.nspowner)::text as owner,
            has_schema_privilege(current_user, n.oid, 'USAGE') as usage,
            has_schema_privilege(current_user, n.oid, 'CREATE') as create
          from pg_namespace n
          where n.nspname in (${targetSchema}, 'opengeni_private')
          order by n.nspname
        `),
      );

      const ownedSchemas = resultRows<{ name: string }>(
        await tx.execute(sql`
          select n.nspname::text as name
          from pg_namespace n
          join pg_roles r on r.oid = n.nspowner
          where r.rolname = current_user
            and n.nspname <> 'information_schema'
            and n.nspname !~ '^pg_'
          order by n.nspname
        `),
      ).map((row) => row.name);

      const ownedRelations = resultRows<{ name: string }>(
        await tx.execute(sql`
          select (n.nspname || '.' || c.relname)::text as name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_roles r on r.oid = c.relowner
          where r.rolname = current_user
            and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
            and n.nspname <> 'information_schema'
            and n.nspname !~ '^pg_'
          order by n.nspname, c.relname
        `),
      ).map((row) => row.name);

      const tables = resultRows<{
        name: string;
        owner: string;
        rls_enabled: boolean;
        rls_forced: boolean;
        rls_active: boolean;
        policy_count: number;
        artifact_outbox_dispatcher_policy: boolean;
        artifact_materializer_policy: boolean;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
        can_references: boolean;
        can_trigger: boolean;
      }>(
        await tx.execute(sql`
          select
            c.relname::text as name,
            pg_get_userbyid(c.relowner)::text as owner,
            c.relrowsecurity as rls_enabled,
            c.relforcerowsecurity as rls_forced,
            row_security_active(c.oid) as rls_active,
            (select count(*)::int from pg_policy policy where policy.polrelid = c.oid) as policy_count,
            exists(
              select 1 from pg_policy policy
              where policy.polrelid = c.oid
                and policy.polname = 'editable_artifact_outbox_dispatcher'
            ) as artifact_outbox_dispatcher_policy,
            exists(
              select 1 from pg_policy policy
              where policy.polrelid = c.oid
                and policy.polname = 'editable_artifact_materializer_owner'
            ) as artifact_materializer_policy,
            has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
            has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
            has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
            has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
            has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate,
            has_table_privilege(current_user, c.oid, 'REFERENCES') as can_references,
            has_table_privilege(current_user, c.oid, 'TRIGGER') as can_trigger
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${targetSchema}
            and c.relkind in ('r', 'p')
          order by c.relname
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        rlsEnabled: row.rls_enabled,
        rlsForced: row.rls_forced,
        rlsActive: row.rls_active,
        policyCount: row.policy_count,
        artifactOutboxDispatcherPolicy: row.artifact_outbox_dispatcher_policy,
        artifactMaterializerPolicy: row.artifact_materializer_policy,
        select: row.can_select,
        insert: row.can_insert,
        update: row.can_update,
        delete: row.can_delete,
        truncate: row.can_truncate,
        references: row.can_references,
        trigger: row.can_trigger,
      }));

      const privateTables = resultRows<{
        name: string;
        owner: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        await tx.execute(sql`
          select
            c.relname::text as name,
            pg_get_userbyid(c.relowner)::text as owner,
            has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
            has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
            has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
            has_table_privilege(current_user, c.oid, 'DELETE') as can_delete
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'opengeni_private'
            and c.relkind in ('r', 'p')
            and c.relname in (
              ${PERSONAL_RESOURCE_CAPABILITY_TABLE},
              ${SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_TABLE},
              ${VARIABLE_SET_CAPABILITY_TABLE},
              ${PERSONAL_DOCUMENT_CAPABILITY_TABLE},
              ${SCOPED_COMPUTE_CAPABILITY_TABLE}
            )
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        select: row.can_select,
        insert: row.can_insert,
        update: row.can_update,
        delete: row.can_delete,
      }));

      const targetRoutines = resultRows<{
        name: string;
        owner: string;
        can_execute: boolean;
        public_execute: boolean;
        security_definer: boolean;
      }>(
        await tx.execute(sql`
          select
            (p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')')::text as name,
            pg_get_userbyid(p.proowner)::text as owner,
            has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute,
            exists (
              select 1
              from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            ) as public_execute,
            p.prosecdef as security_definer
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = ${targetSchema}
            and p.prokind in ('f', 'p')
            and (p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')') = any(
              array[
                ${sql.join(
                  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES.map((name) => sql`${name}`),
                  sql`, `,
                )}
              ]::text[]
            )
          order by p.proname, pg_catalog.oidvectortypes(p.proargtypes)
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        execute: row.can_execute,
        publicExecute: row.public_execute,
        securityDefiner: row.security_definer,
      }));

      const privateRoutines = resultRows<{
        name: string;
        owner: string;
        can_execute: boolean;
        public_execute: boolean;
        security_definer: boolean;
      }>(
        await tx.execute(sql`
          select
            (p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')')::text as name,
            pg_get_userbyid(p.proowner)::text as owner,
            has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute,
            exists (
              select 1
              from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
              where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
            ) as public_execute,
            p.prosecdef as security_definer
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'opengeni_private'
            and p.prokind in ('f', 'p')
          order by p.proname, pg_catalog.oidvectortypes(p.proargtypes)
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        execute: row.can_execute,
        publicExecute: row.public_execute,
        securityDefiner: row.security_definer,
      }));

      return {
        identity: mappedIdentity,
        memberships,
        schemas,
        ownedSchemas,
        ownedRelations,
        tables,
        privateTables,
        targetRoutines,
        privateRoutines,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Pure deterministic evaluator used by startup/readiness and unit tests. */
export function evaluateRuntimeDatabasePosture(
  posture: RuntimeDatabasePosture,
  options: RuntimeDatabasePostureOptions,
): string[] {
  const violations: string[] = [];
  const identity = posture.identity;

  if (!identity.currentUser || !identity.sessionUser) {
    violations.push("database identity is empty");
  }
  if (identity.currentUser !== identity.sessionUser) {
    violations.push(
      `current_user ${identity.currentUser} does not match session_user ${identity.sessionUser}`,
    );
  }
  if (!identity.canConnectDatabase) {
    violations.push("runtime role lacks CONNECT on the current database");
  }

  if (options.rlsStrategy === "scoped") {
    return violations;
  }

  const expectedRole = options.expectedRole?.trim() || "opengeni_app";
  const targetSchema = options.targetSchema?.trim() || "public";
  const protectedTables = new Set(options.protectedTables ?? FORCE_RLS_TABLES);
  const tablePrivileges = options.tablePrivileges ?? RUNTIME_TABLE_PRIVILEGES;
  const directRuntimeTables = new Set(Object.keys(tablePrivileges));
  const protectedNoDirectDmlTables = new Set(
    options.protectedNoDirectDmlTables ??
      (options.protectedTables ? [] : PROTECTED_NO_DIRECT_DML_TABLES),
  );

  if (identity.currentUser !== expectedRole || identity.sessionUser !== expectedRole) {
    violations.push(
      `runtime identity must be ${expectedRole} (current_user=${identity.currentUser}, session_user=${identity.sessionUser})`,
    );
  }
  if (!identity.canLogin) violations.push("runtime role is not LOGIN");
  if (identity.superuser) violations.push("runtime role is SUPERUSER");
  if (identity.bypassRls) violations.push("runtime role has BYPASSRLS");
  if (identity.createRole) violations.push("runtime role has CREATEROLE");
  if (identity.createDatabase) violations.push("runtime role has CREATEDB");
  if (identity.replication) violations.push("runtime role has REPLICATION");
  if (identity.inherit) violations.push("runtime role must be NOINHERIT");
  if (identity.databaseOwner === expectedRole) violations.push("runtime role owns the database");
  if (identity.canCreateInDatabase) {
    violations.push("runtime role has CREATE on the current database");
  }
  if (identity.rowSecurity.toLowerCase() !== "on") {
    violations.push(`row_security is ${identity.rowSecurity}, expected on`);
  }
  if (posture.memberships.length > 0) {
    violations.push(`runtime role has memberships: ${sorted(posture.memberships).join(", ")}`);
  }
  if (posture.ownedSchemas.length > 0) {
    violations.push(`runtime role owns schemas: ${sorted(posture.ownedSchemas).join(", ")}`);
  }
  if (posture.ownedRelations.length > 0) {
    violations.push(`runtime role owns relations: ${sorted(posture.ownedRelations).join(", ")}`);
  }

  for (const schemaName of new Set([targetSchema, "opengeni_private"])) {
    const schema = posture.schemas.find((candidate) => candidate.name === schemaName);
    if (!schema) {
      violations.push(`required schema ${schemaName} is missing`);
      continue;
    }
    if (schema.owner === expectedRole) {
      violations.push(`runtime role owns schema ${schemaName}`);
    }
    if (!schema.usage) violations.push(`runtime role lacks USAGE on schema ${schemaName}`);
    if (schema.create) violations.push(`runtime role has CREATE on schema ${schemaName}`);
  }

  const tableByName = new Map(posture.tables.map((table) => [table.name, table]));
  const actualRlsTables = new Set(
    posture.tables.filter((table) => table.rlsEnabled).map((table) => table.name),
  );
  const classifiedProtectedTables = new Set([
    ...directRuntimeTables,
    ...protectedNoDirectDmlTables,
  ]);
  const unclassifiedProtectedTables = difference(protectedTables, classifiedProtectedTables);
  if (unclassifiedProtectedTables.length > 0) {
    violations.push(
      `protected tables lack an explicit privilege class: ${unclassifiedProtectedTables.join(", ")}`,
    );
  }
  const protectedNoDirectDmlOverlap = difference(
    protectedNoDirectDmlTables,
    new Set([...protectedNoDirectDmlTables].filter((table) => !directRuntimeTables.has(table))),
  );
  if (protectedNoDirectDmlOverlap.length > 0) {
    violations.push(
      `protected no-direct-DML tables also declare runtime privileges: ${protectedNoDirectDmlOverlap.join(", ")}`,
    );
  }
  const nonProtectedNoDirectDmlTables = difference(protectedNoDirectDmlTables, protectedTables);
  if (nonProtectedNoDirectDmlTables.length > 0) {
    violations.push(
      `no-direct-DML tables are absent from the protected contract: ${nonProtectedNoDirectDmlTables.join(", ")}`,
    );
  }
  const catalogTables = new Set(tableByName.keys());
  const missingRuntimeTables = difference(directRuntimeTables, catalogTables);
  if (missingRuntimeTables.length > 0) {
    violations.push(`runtime privilege tables are missing: ${missingRuntimeTables.join(", ")}`);
  }
  const missingTables = difference(protectedTables, catalogTables);
  if (missingTables.length > 0) {
    violations.push(`protected tables are missing: ${missingTables.join(", ")}`);
  }
  const undeclaredRlsTables = difference(actualRlsTables, protectedTables);
  if (undeclaredRlsTables.length > 0) {
    violations.push(
      `RLS tables are absent from the declared contract: ${undeclaredRlsTables.join(", ")}`,
    );
  }

  for (const table of posture.tables) {
    const privileges = [
      ["SELECT", table.select],
      ["INSERT", table.insert],
      ["UPDATE", table.update],
      ["DELETE", table.delete],
      ["TRUNCATE", table.truncate],
      ["REFERENCES", table.references],
      ["TRIGGER", table.trigger],
    ] as const;
    const expectedPrivileges = new Set<string>(tablePrivileges[table.name] ?? []);
    if (table.owner === expectedRole) {
      violations.push(`runtime role owns table ${table.name}`);
    }
    const missingPrivileges = privileges
      .filter(([privilege, granted]) => expectedPrivileges.has(privilege) && !granted)
      .map(([privilege]) => privilege);
    if (missingPrivileges.length > 0) {
      violations.push(
        `table ${table.name} lacks required runtime privileges: ${missingPrivileges.join(", ")}`,
      );
    }
    const excessPrivileges = privileges
      .filter(([privilege, granted]) => !expectedPrivileges.has(privilege) && granted)
      .map(([privilege]) => privilege);
    if (excessPrivileges.length > 0) {
      violations.push(
        `table ${table.name} grants excess runtime privileges: ${excessPrivileges.join(", ")}`,
      );
    }
  }

  for (const tableName of protectedTables) {
    const table = tableByName.get(tableName);
    if (!table) continue;
    if (!table.rlsEnabled) violations.push(`table ${tableName} does not ENABLE RLS`);
    if (!table.rlsForced) violations.push(`table ${tableName} does not FORCE RLS`);
    if (!table.rlsActive) violations.push(`table ${tableName} has inactive RLS for runtime role`);
    if (table.policyCount < 1) violations.push(`table ${tableName} has no RLS policy`);
  }

  const targetSchemaOwner = posture.schemas.find((schema) => schema.name === targetSchema)?.owner;
  for (const expectedRoutine of RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES) {
    const matches = posture.targetRoutines.filter((routine) => routine.name === expectedRoutine);
    if (matches.length !== 1) {
      violations.push(
        `target-schema runtime capability ${expectedRoutine} is missing or ambiguous`,
      );
      continue;
    }
    const routine = matches[0]!;
    if (RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINE_SET.has(routine.name)) {
      if (routine.securityDefiner) {
        violations.push(
          `target-schema runtime capability ${routine.name} must be SECURITY INVOKER`,
        );
      }
    } else if (!routine.securityDefiner) {
      violations.push(`target-schema runtime capability ${routine.name} is not SECURITY DEFINER`);
    }
    if (
      routine.name === GOOGLE_DRIVE_FILE_AUTHORIZATION_ROUTINE ||
      routine.name === GOOGLE_DRIVE_DOCUMENT_CITATION_ROUTINE
    ) {
      const missingAuthorityTables = GOOGLE_DRIVE_AUTHORITY_TABLES.filter(
        (tableName) => !tableByName.has(tableName),
      );
      if (missingAuthorityTables.length > 0) {
        violations.push(
          `target-schema runtime capability ${routine.name} authority tables are missing: ${missingAuthorityTables.join(", ")}`,
        );
      } else {
        const authorityTables = GOOGLE_DRIVE_AUTHORITY_TABLES.map(
          (tableName) => tableByName.get(tableName)!,
        );
        const authorityOwners = new Set(authorityTables.map((table) => table.owner));
        if (authorityOwners.size !== 1) {
          violations.push(
            `target-schema runtime capability ${routine.name} authority table owners do not match: ${authorityTables.map((table) => `${table.name}=${table.owner}`).join(", ")}`,
          );
        } else if (routine.owner !== authorityTables[0]!.owner) {
          violations.push(
            `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match authority table owner ${authorityTables[0]!.owner}`,
          );
        }
      }
    } else if (routine.name === KNOWLEDGE_SOURCE_SYNC_LOCK_AUTHORITY_ROUTINE) {
      const missingAuthorityTables = KNOWLEDGE_SOURCE_SYNC_LOCK_AUTHORITY_TABLES.filter(
        (tableName) => !tableByName.has(tableName),
      );
      if (missingAuthorityTables.length > 0) {
        violations.push(
          `target-schema runtime capability ${routine.name} authority tables are missing: ${missingAuthorityTables.join(", ")}`,
        );
      } else {
        const authorityTables = KNOWLEDGE_SOURCE_SYNC_LOCK_AUTHORITY_TABLES.map(
          (tableName) => tableByName.get(tableName)!,
        );
        const authorityOwners = new Set(authorityTables.map((table) => table.owner));
        if (authorityOwners.size !== 1) {
          violations.push(
            `target-schema runtime capability ${routine.name} authority table owners do not match: ${authorityTables.map((table) => `${table.name}=${table.owner}`).join(", ")}`,
          );
        } else if (routine.owner !== authorityTables[0]!.owner) {
          violations.push(
            `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match authority table owner ${authorityTables[0]!.owner}`,
          );
        }
      }
    } else if (routine.name === MANAGED_HUMAN_PERSONAL_WORKSPACE_ROUTINE) {
      const authorityTables = MANAGED_HUMAN_PERSONAL_WORKSPACE_AUTHORITY_TABLES.filter(
        (tableName) => tableByName.has(tableName),
      ).map((tableName) => tableByName.get(tableName)!);
      const authorityOwners = new Set(authorityTables.map((table) => table.owner));
      if (authorityOwners.size > 1) {
        violations.push(
          `target-schema runtime capability ${routine.name} authority table owners do not match: ${authorityTables.map((table) => `${table.name}=${table.owner}`).join(", ")}`,
        );
      } else if (authorityTables[0] && routine.owner !== authorityTables[0].owner) {
        violations.push(
          `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match authority table owner ${authorityTables[0].owner}`,
        );
      }
    } else if (routine.name === PREFERENCE_KNOWLEDGE_PROPOSAL_ROUTINE) {
      if (!tableByName.has("company_brain_preference_proposal_receipts")) {
        continue;
      }
      const missingAuthorityTables = PREFERENCE_KNOWLEDGE_PROPOSAL_AUTHORITY_TABLES.filter(
        (tableName) => !tableByName.has(tableName),
      );
      if (missingAuthorityTables.length > 0) {
        violations.push(
          `target-schema runtime capability ${routine.name} authority tables are missing: ${missingAuthorityTables.join(", ")}`,
        );
      } else {
        const authorityTables = PREFERENCE_KNOWLEDGE_PROPOSAL_AUTHORITY_TABLES.map(
          (tableName) => tableByName.get(tableName)!,
        );
        const authorityOwners = new Set(authorityTables.map((table) => table.owner));
        if (authorityOwners.size !== 1) {
          violations.push(
            `target-schema runtime capability ${routine.name} authority table owners do not match: ${authorityTables.map((table) => `${table.name}=${table.owner}`).join(", ")}`,
          );
        } else if (routine.owner !== authorityTables[0]!.owner) {
          violations.push(
            `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match authority table owner ${authorityTables[0]!.owner}`,
          );
        }
      }
    } else if ((CANONICAL_HUMAN_IDENTITY_ROUTINES as readonly string[]).includes(routine.name)) {
      const authorityTables = CANONICAL_HUMAN_IDENTITY_AUTHORITY_TABLES.filter((tableName) =>
        tableByName.has(tableName),
      ).map((tableName) => tableByName.get(tableName)!);
      const authorityOwners = new Set(authorityTables.map((table) => table.owner));
      if (authorityTables.length !== CANONICAL_HUMAN_IDENTITY_AUTHORITY_TABLES.length) {
        violations.push(
          `target-schema runtime capability ${routine.name} canonical identity authority tables are missing`,
        );
      } else if (authorityOwners.size !== 1) {
        violations.push(
          `target-schema runtime capability ${routine.name} authority table owners do not match: ${authorityTables.map((table) => `${table.name}=${table.owner}`).join(", ")}`,
        );
      } else if (routine.owner !== authorityTables[0]!.owner) {
        violations.push(
          `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match authority table owner ${authorityTables[0]!.owner}`,
        );
      }
    } else if ((PERSONAL_DOCUMENT_AUTHORITY_ROUTINES as readonly string[]).includes(routine.name)) {
      const authorityOwner = tableByName.get("documents")?.owner ?? targetSchemaOwner;
      if (authorityOwner && routine.owner !== authorityOwner) {
        violations.push(
          `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match document authority owner ${authorityOwner}`,
        );
      }
    } else if ((VARIABLE_SET_AUTHORITY_ROUTINES as readonly string[]).includes(routine.name)) {
      const authorityTables = ["workspace_variable_sets", "workspace_variable_set_variables"]
        .map((tableName) => tableByName.get(tableName))
        .filter((table): table is RuntimeTablePosture => table !== undefined);
      const authorityOwners = new Set(authorityTables.map((table) => table.owner));
      if (authorityOwners.size > 1) {
        violations.push(
          `target-schema runtime capability ${routine.name} variable-set table owners do not match`,
        );
      } else {
        const authorityOwner = authorityTables[0]?.owner ?? targetSchemaOwner;
        if (authorityOwner && routine.owner !== authorityOwner) {
          violations.push(
            `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match variable-set authority owner ${authorityOwner}`,
          );
        }
      }
    } else if ((SCOPED_COMPUTE_AUTHORITY_ROUTINES as readonly string[]).includes(routine.name)) {
      const authorityTables = ["rigs", "rig_versions", "enrollments", "sandboxes"]
        .map((tableName) => tableByName.get(tableName))
        .filter((table): table is RuntimeTablePosture => table !== undefined);
      const authorityOwners = new Set(authorityTables.map((table) => table.owner));
      if (authorityOwners.size > 1) {
        violations.push(
          `target-schema runtime capability ${routine.name} scoped-compute table owners do not match`,
        );
      } else {
        const authorityOwner = authorityTables[0]?.owner ?? targetSchemaOwner;
        if (authorityOwner && routine.owner !== authorityOwner) {
          violations.push(
            `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match scoped-compute authority owner ${authorityOwner}`,
          );
        }
      }
    } else if (SESSION_AUTHORITY_ROUTINES.has(routine.name)) {
      const authorityOwner = tableByName.get("sessions")?.owner ?? targetSchemaOwner;
      if (authorityOwner && routine.owner !== authorityOwner) {
        violations.push(
          `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match session authority owner ${authorityOwner}`,
        );
      }
    } else if (routine.name === XAI_SNAPSHOT_VALIDATOR_ROUTINE) {
      // The immutable SQL validator is invoker-rights and reads no table. Its
      // exact ACL is posture-checked above; it does not participate in the
      // SECURITY DEFINER same-owner authority graph.
    } else if (
      routine.name === XAI_CREATE_CREDENTIAL_ROUTINE ||
      routine.name === XAI_DISCONNECT_CREDENTIAL_ROUTINE ||
      routine.name === XAI_AUTHORITY_LIVE_ROUTINE ||
      routine.name === XAI_POOL_VISIBLE_ROUTINE ||
      routine.name === XAI_RESOLVE_POOL_ROUTINE ||
      routine.name === XAI_REVALIDATE_CREDENTIAL_ROUTINE
    ) {
      if (!tableByName.has("xai_subscription_credentials")) {
        continue;
      }
      const missingAuthorityTables = XAI_AUTHORITY_TABLES.filter(
        (tableName) => !tableByName.has(tableName),
      );
      if (missingAuthorityTables.length > 0) {
        violations.push(
          `target-schema runtime capability ${routine.name} authority tables are missing: ${missingAuthorityTables.join(", ")}`,
        );
      } else {
        const authorityTables = XAI_AUTHORITY_TABLES.map(
          (tableName) => tableByName.get(tableName)!,
        );
        const authorityOwners = new Set(authorityTables.map((table) => table.owner));
        if (authorityOwners.size !== 1) {
          violations.push(
            `target-schema runtime capability ${routine.name} authority table owners do not match: ${authorityTables.map((table) => `${table.name}=${table.owner}`).join(", ")}`,
          );
        } else if (routine.owner !== authorityTables[0]!.owner) {
          violations.push(
            `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match authority table owner ${authorityTables[0]!.owner}`,
          );
        }
      }
    } else if (targetSchemaOwner && routine.owner !== targetSchemaOwner) {
      violations.push(
        `target-schema runtime capability ${routine.name} owner ${routine.owner} does not match schema owner ${targetSchemaOwner}`,
      );
    }
    if (!routine.execute) {
      violations.push(`runtime role lacks target-schema capability ${routine.name}`);
    }
    if (routine.publicExecute) {
      violations.push(`PUBLIC has forbidden target-schema capability ${routine.name}`);
    }
  }

  const artifactOutbox = tableByName.get("editable_artifact_live_outbox");
  if (artifactOutbox) {
    if (!artifactOutbox.artifactOutboxDispatcherPolicy) {
      violations.push("table editable_artifact_live_outbox lacks its owner dispatcher RLS policy");
    }
    for (const expectedRoutine of ARTIFACT_OUTBOX_CAPABILITY_ROUTINES) {
      const matches = posture.privateRoutines.filter((routine) => routine.name === expectedRoutine);
      if (matches.length !== 1) {
        violations.push(`artifact outbox capability ${expectedRoutine} is missing or ambiguous`);
        continue;
      }
      const routine = matches[0]!;
      if (!routine.securityDefiner) {
        violations.push(`artifact outbox capability ${routine.name} is not SECURITY DEFINER`);
      }
      if (routine.owner !== artifactOutbox.owner) {
        violations.push(
          `artifact outbox capability ${routine.name} owner ${routine.owner} does not match table owner ${artifactOutbox.owner}`,
        );
      }
      if (routine.execute) {
        violations.push(
          `generic runtime role has forbidden global artifact outbox capability ${routine.name}`,
        );
      }
    }
  }

  const artifactMaterializationJobs = tableByName.get("editable_artifact_materialization_jobs");
  if (artifactMaterializationJobs) {
    for (const tableName of [
      "editable_artifact_materialization_jobs",
      "editable_artifact_materialization_results",
      "editable_artifact_blob_refs",
      "editable_artifact_sequence_checkpoints",
      "editable_artifact_versions",
      "editable_artifact_idempotency_receipts",
    ]) {
      const table = tableByName.get(tableName);
      if (table && !table.artifactMaterializerPolicy) {
        violations.push(`table ${tableName} lacks its owner materializer RLS policy`);
      }
    }
    for (const expectedRoutine of ARTIFACT_MATERIALIZER_CAPABILITY_ROUTINES) {
      const matches = posture.privateRoutines.filter((routine) => routine.name === expectedRoutine);
      if (matches.length !== 1) {
        violations.push(
          `artifact materializer capability ${expectedRoutine} is missing or ambiguous`,
        );
        continue;
      }
      const routine = matches[0]!;
      if (!routine.securityDefiner) {
        violations.push(`artifact materializer capability ${routine.name} is not SECURITY DEFINER`);
      }
      if (routine.owner !== artifactMaterializationJobs.owner) {
        violations.push(
          `artifact materializer capability ${routine.name} owner ${routine.owner} does not match table owner ${artifactMaterializationJobs.owner}`,
        );
      }
      if (routine.execute) {
        violations.push(
          `generic runtime role has forbidden global artifact materializer capability ${routine.name}`,
        );
      }
    }
  }
  const artifactAuthority = tableByName.get("editable_artifacts");
  if (artifactAuthority) {
    const matches = posture.privateRoutines.filter((routine) =>
      routine.name.startsWith("advance_editable_artifact_authorization_revision("),
    );
    if (matches.length !== 1) {
      violations.push(
        "editable artifact authorization revision capability is missing or ambiguous",
      );
    } else {
      const routine = matches[0]!;
      if (!routine.securityDefiner) {
        violations.push(
          `editable artifact authorization revision capability ${routine.name} is not SECURITY DEFINER`,
        );
      }
      if (routine.owner !== artifactAuthority.owner) {
        violations.push(
          `editable artifact authorization revision capability ${routine.name} owner ${routine.owner} does not match table owner ${artifactAuthority.owner}`,
        );
      }
    }
    for (const expectedRoutine of ARTIFACT_AUTHORIZATION_CAPABILITY_ROUTINES) {
      const capabilityMatches = posture.privateRoutines.filter(
        (routine) => routine.name === expectedRoutine,
      );
      if (capabilityMatches.length !== 1) {
        violations.push(
          `editable artifact authorization capability ${expectedRoutine} is missing or ambiguous`,
        );
        continue;
      }
      const routine = capabilityMatches[0]!;
      if (!routine.securityDefiner) {
        violations.push(
          `editable artifact authorization capability ${routine.name} is not SECURITY DEFINER`,
        );
      }
      if (routine.owner !== artifactAuthority.owner) {
        violations.push(
          `editable artifact authorization capability ${routine.name} owner ${routine.owner} does not match table owner ${artifactAuthority.owner}`,
        );
      }
      if (!routine.execute) {
        violations.push(
          `runtime role lacks editable artifact authorization capability ${routine.name}`,
        );
      }
    }
  }

  const artifactLiveTickets = tableByName.get("editable_artifact_live_tickets");
  if (artifactLiveTickets) {
    for (const expectedRoutine of ARTIFACT_LIVE_TICKET_CAPABILITY_ROUTINES) {
      const matches = posture.privateRoutines.filter((routine) => routine.name === expectedRoutine);
      if (matches.length !== 1) {
        violations.push(
          `artifact live ticket capability ${expectedRoutine} is missing or ambiguous`,
        );
        continue;
      }
      const routine = matches[0]!;
      if (!routine.securityDefiner) {
        violations.push(`artifact live ticket capability ${routine.name} is not SECURITY DEFINER`);
      }
      if (routine.owner !== artifactLiveTickets.owner) {
        violations.push(
          `artifact live ticket capability ${routine.name} owner ${routine.owner} does not match table owner ${artifactLiveTickets.owner}`,
        );
      }
      if (!routine.execute) {
        violations.push(`runtime role lacks artifact live ticket capability ${routine.name}`);
      }
    }
    for (const internalRoutine of ARTIFACT_LIVE_TICKET_INTERNAL_ROUTINES) {
      const matches = posture.privateRoutines.filter((routine) => routine.name === internalRoutine);
      if (matches.length !== 1) {
        violations.push(
          `artifact live ticket internal routine ${internalRoutine} is missing or ambiguous`,
        );
        continue;
      }
      const routine = matches[0]!;
      if (!routine.securityDefiner) {
        violations.push(
          `artifact live ticket internal routine ${routine.name} is not SECURITY DEFINER`,
        );
      }
      if (routine.owner !== artifactLiveTickets.owner) {
        violations.push(
          `artifact live ticket internal routine ${routine.name} owner ${routine.owner} does not match table owner ${artifactLiveTickets.owner}`,
        );
      }
      if (routine.execute) {
        violations.push(`runtime role has forbidden ticket schema resolver ${routine.name}`);
      }
    }
  }

  const personalResourceCapabilityTables = posture.privateTables.filter(
    (table) => table.name === PERSONAL_RESOURCE_CAPABILITY_TABLE,
  );
  const personalResourceCapabilityRoutines = posture.privateRoutines.filter(
    (routine) => routine.name === PERSONAL_RESOURCE_CAPABILITY_PREDICATE_ROUTINE,
  );
  if (personalResourceCapabilityTables.length !== 1) {
    violations.push(
      `personal-resource capability table ${PERSONAL_RESOURCE_CAPABILITY_TABLE} is missing or ambiguous`,
    );
  }
  if (personalResourceCapabilityRoutines.length !== 1) {
    violations.push(
      `personal-resource capability predicate ${PERSONAL_RESOURCE_CAPABILITY_PREDICATE_ROUTINE} is missing or ambiguous`,
    );
  }
  if (
    personalResourceCapabilityTables.length === 1 &&
    personalResourceCapabilityRoutines.length === 1
  ) {
    const table = personalResourceCapabilityTables[0]!;
    const routine = personalResourceCapabilityRoutines[0]!;
    if (routine.owner !== table.owner) {
      violations.push(
        `personal-resource capability predicate ${routine.name} owner ${routine.owner} does not match table owner ${table.owner}`,
      );
    }
    if (!routine.securityDefiner) {
      violations.push(
        `personal-resource capability predicate ${routine.name} is not SECURITY DEFINER`,
      );
    }
    if (!routine.execute) {
      violations.push(`runtime role lacks personal-resource capability predicate ${routine.name}`);
    }
    if (routine.publicExecute) {
      violations.push(
        `PUBLIC has forbidden personal-resource capability predicate ${routine.name}`,
      );
    }
    const directPrivileges = [
      ["SELECT", table.select],
      ["INSERT", table.insert],
      ["UPDATE", table.update],
      ["DELETE", table.delete],
    ].filter(([, granted]) => granted);
    if (directPrivileges.length > 0) {
      violations.push(
        `runtime role has forbidden direct privileges on private table ${table.name}: ${directPrivileges.map(([privilege]) => privilege).join(", ")}`,
      );
    }
  }

  const personalDocumentCapabilityTables = posture.privateTables.filter(
    (table) => table.name === PERSONAL_DOCUMENT_CAPABILITY_TABLE,
  );
  const personalDocumentCapabilityRoutines = posture.privateRoutines.filter(
    (routine) => routine.name === PERSONAL_DOCUMENT_CAPABILITY_PREDICATE_ROUTINE,
  );
  if (personalDocumentCapabilityTables.length !== 1) {
    violations.push(
      `personal-document capability table ${PERSONAL_DOCUMENT_CAPABILITY_TABLE} is missing or ambiguous`,
    );
  }
  if (personalDocumentCapabilityRoutines.length !== 1) {
    violations.push(
      `personal-document capability predicate ${PERSONAL_DOCUMENT_CAPABILITY_PREDICATE_ROUTINE} is missing or ambiguous`,
    );
  }
  if (
    personalDocumentCapabilityTables.length === 1 &&
    personalDocumentCapabilityRoutines.length === 1
  ) {
    const table = personalDocumentCapabilityTables[0]!;
    const routine = personalDocumentCapabilityRoutines[0]!;
    if (routine.owner !== table.owner) {
      violations.push(
        `personal-document capability predicate ${routine.name} owner ${routine.owner} does not match table owner ${table.owner}`,
      );
    }
    if (!routine.securityDefiner) {
      violations.push(
        `personal-document capability predicate ${routine.name} is not SECURITY DEFINER`,
      );
    }
    if (!routine.execute) {
      violations.push(`runtime role lacks personal-document capability predicate ${routine.name}`);
    }
    if (routine.publicExecute) {
      violations.push(
        `PUBLIC has forbidden personal-document capability predicate ${routine.name}`,
      );
    }
    const directPrivileges = [
      ["SELECT", table.select],
      ["INSERT", table.insert],
      ["UPDATE", table.update],
      ["DELETE", table.delete],
    ].filter(([, granted]) => granted);
    if (directPrivileges.length > 0) {
      violations.push(
        `runtime role has forbidden direct privileges on private table ${table.name}: ${directPrivileges.map(([privilege]) => privilege).join(", ")}`,
      );
    }
  }

  const scheduledCapabilityTables = posture.privateTables.filter(
    (table) => table.name === SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_TABLE,
  );
  const scheduledCapabilityRoutines = posture.privateRoutines.filter(
    (routine) => routine.name === SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_PREDICATE_ROUTINE,
  );
  if (scheduledCapabilityTables.length !== 1) {
    violations.push(
      `scheduled personal-resource capability table ${SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_TABLE} is missing or ambiguous`,
    );
  }
  if (scheduledCapabilityRoutines.length !== 1) {
    violations.push(
      `scheduled personal-resource capability predicate ${SCHEDULED_PERSONAL_RESOURCE_CAPABILITY_PREDICATE_ROUTINE} is missing or ambiguous`,
    );
  }
  if (scheduledCapabilityTables.length === 1 && scheduledCapabilityRoutines.length === 1) {
    const table = scheduledCapabilityTables[0]!;
    const routine = scheduledCapabilityRoutines[0]!;
    if (routine.owner !== table.owner) {
      violations.push(
        `scheduled personal-resource capability predicate ${routine.name} owner ${routine.owner} does not match table owner ${table.owner}`,
      );
    }
    if (!routine.securityDefiner) {
      violations.push(
        `scheduled personal-resource capability predicate ${routine.name} is not SECURITY DEFINER`,
      );
    }
    if (!routine.execute) {
      violations.push(
        `runtime role lacks scheduled personal-resource capability predicate ${routine.name}`,
      );
    }
    if (routine.publicExecute) {
      violations.push(
        `PUBLIC has forbidden scheduled personal-resource capability predicate ${routine.name}`,
      );
    }
    const directPrivileges = [
      ["SELECT", table.select],
      ["INSERT", table.insert],
      ["UPDATE", table.update],
      ["DELETE", table.delete],
    ].filter(([, granted]) => granted);
    if (directPrivileges.length > 0) {
      violations.push(
        `runtime role has forbidden direct privileges on private table ${table.name}: ${directPrivileges.map(([privilege]) => privilege).join(", ")}`,
      );
    }
  }

  if (options.protectedTables === undefined) {
    const variableSetCapabilityTables = posture.privateTables.filter(
      (table) => table.name === VARIABLE_SET_CAPABILITY_TABLE,
    );
    const variableSetCapabilityRoutines = posture.privateRoutines.filter(
      (routine) => routine.name === VARIABLE_SET_CAPABILITY_PREDICATE_ROUTINE,
    );
    if (variableSetCapabilityTables.length !== 1) {
      violations.push(
        `variable-set capability table ${VARIABLE_SET_CAPABILITY_TABLE} is missing or ambiguous`,
      );
    }
    if (variableSetCapabilityRoutines.length !== 1) {
      violations.push(
        `variable-set capability predicate ${VARIABLE_SET_CAPABILITY_PREDICATE_ROUTINE} is missing or ambiguous`,
      );
    }
    if (variableSetCapabilityTables.length === 1 && variableSetCapabilityRoutines.length === 1) {
      const table = variableSetCapabilityTables[0]!;
      const routine = variableSetCapabilityRoutines[0]!;
      if (routine.owner !== table.owner) {
        violations.push(
          `variable-set capability predicate ${routine.name} owner ${routine.owner} does not match table owner ${table.owner}`,
        );
      }
      if (!routine.securityDefiner) {
        violations.push(
          `variable-set capability predicate ${routine.name} is not SECURITY DEFINER`,
        );
      }
      if (!routine.execute) {
        violations.push(`runtime role lacks variable-set capability predicate ${routine.name}`);
      }
      if (routine.publicExecute) {
        violations.push(`PUBLIC has forbidden variable-set capability predicate ${routine.name}`);
      }
      const directPrivileges = [
        ["SELECT", table.select],
        ["INSERT", table.insert],
        ["UPDATE", table.update],
        ["DELETE", table.delete],
      ].filter(([, granted]) => granted);
      if (directPrivileges.length > 0) {
        violations.push(
          `runtime role has forbidden direct privileges on private table ${table.name}: ${directPrivileges.map(([privilege]) => privilege).join(", ")}`,
        );
      }
    }
    const scopedComputeCapabilityTables = posture.privateTables.filter(
      (table) => table.name === SCOPED_COMPUTE_CAPABILITY_TABLE,
    );
    const scopedComputeCapabilityRoutines = posture.privateRoutines.filter(
      (routine) => routine.name === SCOPED_COMPUTE_CAPABILITY_PREDICATE_ROUTINE,
    );
    if (scopedComputeCapabilityTables.length !== 1) {
      violations.push(
        `scoped-compute capability table ${SCOPED_COMPUTE_CAPABILITY_TABLE} is missing or ambiguous`,
      );
    }
    if (scopedComputeCapabilityRoutines.length !== 1) {
      violations.push(
        `scoped-compute capability predicate ${SCOPED_COMPUTE_CAPABILITY_PREDICATE_ROUTINE} is missing or ambiguous`,
      );
    }
    if (
      scopedComputeCapabilityTables.length === 1 &&
      scopedComputeCapabilityRoutines.length === 1
    ) {
      const table = scopedComputeCapabilityTables[0]!;
      const routine = scopedComputeCapabilityRoutines[0]!;
      if (routine.owner !== table.owner) {
        violations.push(
          `scoped-compute capability predicate ${routine.name} owner ${routine.owner} does not match table owner ${table.owner}`,
        );
      }
      if (!routine.securityDefiner) {
        violations.push(
          `scoped-compute capability predicate ${routine.name} is not SECURITY DEFINER`,
        );
      }
      if (!routine.execute) {
        violations.push(`runtime role lacks scoped-compute capability predicate ${routine.name}`);
      }
      if (routine.publicExecute) {
        violations.push(`PUBLIC has forbidden scoped-compute capability predicate ${routine.name}`);
      }
      const directPrivileges = [
        ["SELECT", table.select],
        ["INSERT", table.insert],
        ["UPDATE", table.update],
        ["DELETE", table.delete],
      ].filter(([, granted]) => granted);
      if (directPrivileges.length > 0) {
        violations.push(
          `runtime role has forbidden direct privileges on private table ${table.name}: ${directPrivileges.map(([privilege]) => privilege).join(", ")}`,
        );
      }
    }
  }

  if (posture.privateRoutines.length === 0) {
    violations.push("opengeni_private has no helper routines");
  }
  for (const routine of posture.privateRoutines) {
    if (routine.owner === expectedRole) {
      violations.push(`runtime role owns private routine ${routine.name}`);
    }
    const dedicatedArtifactCapability = DEDICATED_ARTIFACT_CAPABILITY_ROUTINES.has(routine.name);
    if (!routine.execute && !dedicatedArtifactCapability) {
      violations.push(`runtime role lacks EXECUTE on private routine ${routine.name}`);
    }
  }

  return violations;
}

export async function assertRuntimeDatabasePosture(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): Promise<RuntimeDatabasePosture> {
  const posture = await inspectRuntimeDatabasePosture(db, options);
  const violations = evaluateRuntimeDatabasePosture(posture, options);
  if (violations.length > 0) {
    throw new RuntimeDatabasePostureError(violations);
  }
  return posture;
}

export function runtimeDatabaseReadyCheck(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): () => Promise<void> {
  return async () => {
    await assertRuntimeDatabasePosture(db, options);
  };
}
