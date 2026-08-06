-- deployment-mode: maintenance
-- GitHub App installation credentials are host-owned run material. Retire the
-- model-visible github_token MCP tool from every durable session selection and
-- prevent an old writer from reintroducing it after the coordinated cutover.

UPDATE "sessions"
SET "first_party_mcp_tools" = "first_party_mcp_tools" - 'github_token'
WHERE "first_party_mcp_tools" ? 'github_token';

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
    "preference_registry_summary",
    "preference_registry_get",
    "sandboxes_list",
    "sandbox_attach",
    "sandbox_swap",
    "run_on",
    "sandbox_provision",
    "connected_machine_remove",
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
    "github_repositories_list",
    "social_connections_list",
    "social_posts_recent",
    "social_daily_analysis_context",
    "social_search_live",
    "social_mentions_live",
    "social_thread_fetch",
    "social_posts_sync",
    "social_post_reply",
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
    "slack_bot_thread_replies",
    "slack_bot_list_users",
    "slack_bot_list_files",
    "slack_bot_file_info",
    "slack_bot_file_content",
    "slack_bot_post_message",
    "slack_bot_delete_message",
    "artifacts_list",
    "artifacts_get_source",
    "artifacts_create",
    "artifacts_publish",
    "artifacts_rollback"
  ]'::jsonb;

ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_first_party_mcp_tools_no_model_credentials_chk";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_first_party_mcp_tools_no_model_credentials_chk"
  CHECK (NOT ("first_party_mcp_tools" @> '["github_token"]'::jsonb));