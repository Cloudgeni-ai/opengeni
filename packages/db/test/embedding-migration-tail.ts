/** These migrations extend the post-0299 lifecycle and accepted-work ledgers.
 * Historical cutover fixtures must withhold and replay this entire ordered tail. */
export const embeddingMigrationTail = [
  "0426_organization_scoped_external_workspaces.sql",
  "0427_durable_connect_attempts.sql",
  "0428_external_identity_provisioning.sql",
  "0429_external_workspace_member_removal.sql",
  "0430_external_identity_membership_lifecycle.sql",
  "0431_external_owning_user_authority.sql",
  "0432_host_mcp_binding_registry.sql",
  "0433_host_mcp_delegations.sql",
  "0434_host_mcp_turn_authorities.sql",
  "0435_host_mcp_causal_continuation.sql",
  "0436_host_mcp_task_authorities.sql",
  "0437_host_mcp_child_authority.sql",
  "0438_external_identity_link_lifecycle.sql",
  "0439_external_identity_link_work.sql",
  "0440_external_link_preview_and_permission_ceiling.sql",
  "0441_external_link_scheduled_origin.sql",
  "0442_host_mcp_native_owner.sql",
  "0443_connect_origin_authority.sql",
  "0444_external_link_inventory_labels.sql",
  "0445_social_connection_versions.sql",
];
