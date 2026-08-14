-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "enrollments_account_workspace_id_uq"
  ON "enrollments" ("account_id", "workspace_id", "id");
