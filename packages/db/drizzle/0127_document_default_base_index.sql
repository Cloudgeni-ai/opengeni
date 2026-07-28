-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "document_bases_workspace_default_name_uq"
  ON "document_bases" ("workspace_id")
  WHERE lower(btrim("name")) = 'default';