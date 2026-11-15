/**
 * Fresh-chat tasks for turns.ts. Each `needs` entry lists the tool names (after
 * the server prefix) any one of which meets that need. They name common
 * first-party tools and widely used integrations; a catalog without one of them
 * simply cannot meet that need.
 */
export type TurnScenario = { id: string; task: string; needs: string[][] };

export const DEFAULT_TURN_SCENARIOS: TurnScenario[] = [
  {
    id: "notify",
    task: "Send me a phone notification saying the nightly build passed.",
    needs: [["notify_user"]],
  },
  {
    id: "schedule",
    task: "Every weekday at 09:00 Oslo time, check whether CI on main is green and tell me if it is not. Set that up.",
    needs: [["scheduled_tasks_create"]],
  },
  {
    id: "worker",
    task: "Start a separate worker chat that audits the README for broken links, then send it a follow-up asking it to also check the docs folder.",
    needs: [["session_create"], ["session_send_message", "session_steer"]],
  },
  {
    id: "remember",
    task: "Remember for later that our staging database listens on port 6543.",
    needs: [["knowledge_save", "knowledge_prepare_save"]],
  },
  {
    id: "issues",
    task: "Which Linear issues are assigned to me right now?",
    needs: [["list_issues"]],
  },
  {
    id: "error-to-slack",
    task: "Find the newest unresolved Sentry issue and post a two-line summary of it in the #dev Slack channel.",
    needs: [["search_issues", "search_errors", "get_issue_details"], ["slack_send_message", "slack_bot_send_prepared_message"]],
  },
  {
    id: "draft",
    task: "Draft an email to anna@example.com saying the planning meeting moves to Friday. Don't send it.",
    needs: [["create_draft"]],
  },
  {
    id: "secret",
    task: "Do we have a saved login for the Hetzner console?",
    needs: [["secret_search"]],
  },
  {
    id: "alerts",
    task: "Are any Grafana alerts firing right now?",
    needs: [["alerting_rules_read", "list_alert_groups"]],
  },
  {
    id: "sessions",
    task: "List my most recent chats and tell me which ones are still running.",
    needs: [["sessions_list"]],
  },
];
