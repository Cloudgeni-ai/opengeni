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
];
