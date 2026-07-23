-- deployment-mode: maintenance
-- Backfill immutable root lineage for the pre-0103 durable outbox population.
-- Migration 0103 already captures every new row, so this unbounded rewrite is
-- isolated to an explicitly reviewed maintenance step instead of hiding in the
-- rolling expand migration. Deleted source sessions remain unresolved (NULL).

WITH distinct_sessions AS MATERIALIZED (
  SELECT DISTINCT "workspace_id", "session_id"
  FROM "host_export_outbox"
  WHERE "session_id" IS NOT NULL
    AND "root_session_id" IS NULL
), resolved_roots AS MATERIALIZED (
  SELECT
    "workspace_id",
    "session_id",
    opengeni_private.host_export_session_root(
      "workspace_id",
      "session_id"
    ) AS "root_session_id"
  FROM distinct_sessions
)
UPDATE "host_export_outbox" o
SET "root_session_id" = roots."root_session_id"
FROM resolved_roots roots
WHERE o."workspace_id" = roots."workspace_id"
  AND o."session_id" = roots."session_id"
  AND o."root_session_id" IS NULL;