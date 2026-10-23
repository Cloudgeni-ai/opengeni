/** 0927 rewrites, by name, every foreign key between two tables a workspace
 * deletion removes, including keys on the post-0461 Knowledge tables and keys
 * that later cutovers add. 0928 validates them. Historical fixtures that
 * withhold any of those tables or keys withhold this tail too and replay it
 * after them. */
export const workspaceDeletionMigrationTail = [
  "0927_workspace_deletion_deferrable_foreign_keys.sql",
  "0928_workspace_deletion_foreign_keys_validate.sql",
] as const;
