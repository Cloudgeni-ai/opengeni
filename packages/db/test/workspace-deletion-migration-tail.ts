/** 0926 rewrites the legacy scoped Knowledge guards, 0927 rewrites foreign keys
 * across the current schema by their exact constraint names, and 0928
 * validates what 0927 rewrote. Historical fixtures that withhold the
 * migrations creating those tables or constraints withhold this tail too and
 * replay it after them, in this order. */
export const workspaceDeletionMigrationTail = [
  "0926_workspace_deletion_scoped_knowledge_cascade.sql",
  "0927_workspace_deletion_deferrable_foreign_keys.sql",
  "0928_workspace_deletion_foreign_keys_validate.sql",
] as const;
