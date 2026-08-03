-- deployment-mode: maintenance
-- One durable session-level tool policy. OpenGeni-native tools are selected by
-- default, and historical NULL/legacy shapes are eliminated before the new
-- API starts.

CREATE INDEX IF NOT EXISTS "session_history_items_turn_id_idx"
  ON "session_history_items" ("turn_id")
  WHERE "turn_id" IS NOT NULL;

ALTER TABLE "sessions"
  ALTER COLUMN "first_party_mcp_tools"
  SET DEFAULT '[
    "set_session_title",
    "goal_set",
    "goal_update",
    "goal_complete",
    "goal_pause",
    "memory_search",
    "memory_save",
    "memory_correct",
    "sandboxes_list",
    "sandbox_attach",
    "sandbox_swap",
    "run_on",
    "sandbox_provision",
    "rig_list",
    "rig_get",
    "rig_propose_change",
    "rig_verify",
    "rig_promote",
    "sessions_list",
    "session_get",
    "session_events",
    "session_create",
    "session_send_message",
    "session_pause",
    "session_resume",
    "session_steer",
    "set_other_session_title",
    "variable_set_list",
    "environment_list",
    "variable_set_set_variable",
    "environment_set_variable",
    "github_connect_link",
    "github_token",
    "github_repositories_list",
    "social_connections_list",
    "social_posts_recent",
    "social_daily_analysis_context",
    "scheduled_tasks_list",
    "scheduled_tasks_get",
    "scheduled_tasks_create",
    "scheduled_tasks_update",
    "scheduled_tasks_pause",
    "scheduled_tasks_resume",
    "scheduled_tasks_trigger",
    "scheduled_tasks_delete",
    "scheduled_task_runs_list",
    "slack_bot_list_channels",
    "slack_bot_channel_history",
    "slack_bot_list_users",
    "slack_bot_post_message"
  ]'::jsonb;

UPDATE "sessions"
SET "first_party_mcp_tools" = DEFAULT
WHERE "first_party_mcp_tools" IS NULL;

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "sessions"
  ALTER COLUMN "first_party_mcp_tools" SET NOT NULL;

UPDATE "sessions"
SET "tool_policy" = jsonb_build_object(
  'mode', 'explicit',
  'inheritedFromSessionId', "parent_session_id"
)
WHERE "tool_policy" IS NULL
   OR "tool_policy" ->> 'mode' = 'legacy';

SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "sessions"
  ALTER COLUMN "tool_policy" SET NOT NULL;

ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_tool_policy_shape_check";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_tool_policy_shape_check"
  CHECK (
    jsonb_typeof("tool_policy") = 'object'
    AND "tool_policy" ? 'mode'
    AND ("tool_policy" ->> 'mode') IN ('workspace_default', 'explicit', 'inherited')
    AND "tool_policy" ? 'inheritedFromSessionId'
    AND (
      ("tool_policy" ->> 'inheritedFromSessionId') IS NULL
      OR ("tool_policy" ->> 'inheritedFromSessionId') ~ '^[0-9a-fA-F-]{36}$'
    )
  );

-- Existing-session drafts no longer carry a one-turn tool policy. Keep only
-- the message, resources, model, and effort represented by the current API.
UPDATE "composer_drafts"
SET "tools" = '[]'::jsonb,
    "tools_provided" = false
WHERE "tools" <> '[]'::jsonb
   OR "tools_provided" = true;
