import { allowanceMigrationTail } from "./allowance-migration-tail";

/** These migrations extend the post-0299 lifecycle and accepted-work ledgers.
 * Historical cutover fixtures must withhold and replay this entire ordered tail. */
export const embeddingMigrationTail = [
  "0437_organization_scoped_external_workspaces.sql",
  "0438_durable_connect_attempts.sql",
  "0439_external_identity_provisioning.sql",
  "0440_external_workspace_member_removal.sql",
  "0441_external_identity_membership_lifecycle.sql",
  "0442_external_owning_user_authority.sql",
  "0443_host_mcp_binding_registry.sql",
  "0444_host_mcp_delegations.sql",
  "0445_host_mcp_turn_authorities.sql",
  "0446_host_mcp_causal_continuation.sql",
  "0447_host_mcp_task_authorities.sql",
  "0448_host_mcp_child_authority.sql",
  "0449_external_identity_link_lifecycle.sql",
  "0450_external_identity_link_work.sql",
  "0451_external_link_preview_and_permission_ceiling.sql",
  "0452_external_link_scheduled_origin.sql",
  "0453_host_mcp_native_owner.sql",
  "0454_connect_origin_authority.sql",
  "0455_external_link_inventory_labels.sql",
  "0456_social_connection_versions.sql",
  "0457_canonical_session_scope_subject.sql",
  "0458_skill_review_wire_compatibility.sql",
  // Compiles against the linked-authority row type from 0449 and validates
  // scheduled/host authority. It must not run while those prerequisites are
  // marked applied but deliberately absent in a historical cutover fixture.
  "0459_mcp_operations.sql",
  "0461_unified_knowledge.sql",
  // Patches the instruction writer introduced by 0461, so historical fixtures
  // must replay it after that writer rather than before its original creation.
  "0462_agent_instruction_non_destructive_edits.sql",
  "0466_agent_instruction_activation_preservation.sql",
  // Compiles against the Knowledge tables and visibility helper from 0461.
  "0468_knowledge_relationship_projection.sql",
  "0469_knowledge_source_discovery.sql",
  "0478_sender_owned_connections.sql",
  // Replayed 0402/0433 still consume historical Pack tables. Remove them only
  // after those earlier accepted-work and Skill cutovers have completed.
  "0482_remove_packs.sql",
  // Patches the exact Skill lifecycle rewritten by 0461; replay after it.
  "0488_permanent_skill_removal.sql",
  // Rewrites the original-file policy introduced by 0461.
  "0499_session_attachment_access.sql",
  "0501_session_sharing_execution.sql",
  // Reads the cursor table from 0374, withheld by these historical fixtures.
  "0503_session_meaningful_attention.sql",
  // New trial/Knowledge cutovers depend on the 0299 lifecycle and 0461 tables
  // withheld above. Keep historical replay fixtures on their original side.
  "0509_verified_signup_trial_credits.sql",
  "0510_knowledge_index_funding_wait.sql",
  "0511_knowledge_visible_index_status.sql",
  // Patches learning resolvers introduced by the withheld 0461 migration.
  "0515_autonomous_learning_defaults.sql",
  // Patches the 0509 trial grant trigger; replay after it.
  "0521_verified_signup_trial_runtime_switch.sql",
  // Replaces scheduled-run triggers installed by withheld 0275 and 0478.
  "0534_scheduled_admission_diagnostics.sql",
  // References the files scope identity introduced by withheld 0461.
  "0535_slack_file_upload_operations.sql",
  // Replaces scheduled-run triggers installed by withheld-then-replayed 0534.
  "0539_scheduled_admission_refusals.sql",
  // Installs inventory read policies with the session-tenancy fence helper
  // from withheld 0345; replay after it.
  "0547_idle_command_containment.sql",
  "0599_paused_recovery_command_containment.sql",
  // Allowance receipts compile against the withheld Knowledge/embedding and
  // scheduled-refusal lifecycle. Replay them after those prerequisites.
  ...allowanceMigrationTail,
  // Extends the attachment helper from withheld 0499; replay after it.
  "0560_archived_session_imports.sql",
  // Patches the scheduled producer fence after its withheld prerequisites.
  "0561_scheduled_session_agent_identity.sql",
  // Patches the reaper installed by withheld 0345/0388/0391/0397.
  "0564_browser_deadline_checkpoints.sql",
  // Patches the producer fence from withheld 0275/0414/0561; replay after them.
  "0582_scheduled_setup_policy_identity.sql",
  // Replaces the private instruction helper from withheld 0466; replay after it.
  "0584_agent_instruction_size_parity.sql",
  // Extends the cursor table and meaningful index withheld by these fixtures.
  "0585_session_attention_cursor.sql",
  // Uses the existing session inventory/capability routines withheld by these fixtures.
  "0599_insights_raw_usage_api.sql",
];
