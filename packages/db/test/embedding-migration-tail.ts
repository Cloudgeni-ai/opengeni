/** These migrations extend the post-0299 lifecycle and accepted-work ledgers.
 * Historical cutover fixtures must withhold and replay this entire ordered tail. */
export const embeddingMigrationTail = [
  "0425_organization_scoped_external_workspaces.sql",
  "0426_durable_connect_attempts.sql",
  "0427_external_identity_provisioning.sql",
  "0428_external_workspace_member_removal.sql",
  "0429_external_identity_membership_lifecycle.sql",
  "0430_external_owning_user_authority.sql",
  "0431_host_mcp_binding_registry.sql",
  "0432_host_mcp_delegations.sql",
  "0433_host_mcp_turn_authorities.sql",
  "0434_host_mcp_causal_continuation.sql",
  "0435_host_mcp_task_authorities.sql",
  "0436_host_mcp_child_authority.sql",
  "0437_external_identity_link_lifecycle.sql",
  "0438_external_identity_link_work.sql",
  "0439_external_link_preview_and_permission_ceiling.sql",
  "0440_external_link_scheduled_origin.sql",
  "0441_host_mcp_native_owner.sql",
  "0442_connect_origin_authority.sql",
  "0443_external_link_inventory_labels.sql",
  "0444_social_connection_versions.sql",
];
