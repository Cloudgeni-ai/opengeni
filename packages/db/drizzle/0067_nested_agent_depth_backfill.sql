-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=1000 lock-timeout=5s statement-timeout=30s
-- OPE-53 data phase. migrate.ts repeats this one idempotent batch in separate
-- autocommit transactions. Roots are eligible immediately; children become
-- eligible only after their parent has a complete snapshot.
WITH candidates AS (
  SELECT
    session.ctid AS target_ctid,
    CASE
      WHEN session."parent_session_id" IS NULL THEN session."id"
      ELSE parent."root_session_id"
    END AS root_session_id,
    CASE
      WHEN session."parent_session_id" IS NULL THEN 0
      ELSE parent."nested_agent_depth" + 1
    END AS nested_agent_depth,
    CASE
      WHEN jsonb_typeof(workspace."settings" -> 'maxNestedAgentDepth') = 'number'
       AND workspace."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (workspace."settings" ->> 'maxNestedAgentDepth')::numeric
             BETWEEN 0 AND 2147483647
      THEN (workspace."settings" ->> 'maxNestedAgentDepth')::integer
      ELSE configuration."max_nested_agent_depth"
    END AS effective_max_nested_agent_depth,
    CASE
      WHEN jsonb_typeof(workspace."settings" -> 'maxNestedAgentDepth') = 'number'
       AND workspace."settings" ->> 'maxNestedAgentDepth' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (workspace."settings" ->> 'maxNestedAgentDepth')::numeric
             BETWEEN 0 AND 2147483647
      THEN 'workspace'
      ELSE configuration."policy_source"
    END AS nested_agent_depth_policy_source
  FROM "sessions" session
  LEFT JOIN "sessions" parent
    ON parent."workspace_id" = session."workspace_id"
   AND parent."id" = session."parent_session_id"
  JOIN "workspaces" workspace ON workspace."id" = session."workspace_id"
  JOIN "nested_agent_depth_configuration" configuration
    ON configuration."singleton"
  WHERE (
      session."root_session_id" IS NULL
      OR session."nested_agent_depth" IS NULL
      OR session."effective_max_nested_agent_depth" IS NULL
      OR session."nested_agent_depth_policy_source" IS NULL
    )
    AND (
      session."parent_session_id" IS NULL
      OR (
        parent."root_session_id" IS NOT NULL
        AND parent."nested_agent_depth" IS NOT NULL
      )
    )
  ORDER BY session."created_at", session."id"
  LIMIT 1000
  FOR UPDATE OF session SKIP LOCKED
)
UPDATE "sessions" session
SET "root_session_id" = candidates.root_session_id,
    "nested_agent_depth" = candidates.nested_agent_depth,
    "max_nested_agent_depth_override" = NULL,
    "effective_max_nested_agent_depth" = candidates.effective_max_nested_agent_depth,
    "nested_agent_depth_policy_source" = candidates.nested_agent_depth_policy_source,
    "nested_agent_depth_policy_session_id" = NULL
FROM candidates
WHERE session.ctid = candidates.target_ctid
RETURNING session."id";