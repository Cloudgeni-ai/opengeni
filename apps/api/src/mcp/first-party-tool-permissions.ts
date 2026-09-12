import { type FirstPartyMcpToolName, type Permission } from "@opengeni/contracts";

export type FirstPartyToolAuthorization = {
  sessionRequired?: true;
  allOf?: readonly Permission[];
  anyOf?: readonly Permission[];
};

/**
 * Authorization is deliberately complete and separate from visibility. The
 * `satisfies Record` check makes every catalog addition choose an explicit
 * registration predicate before it can compile.
 */
export const FIRST_PARTY_TOOL_AUTHORIZATION = {
  set_session_title: { sessionRequired: true, allOf: ["sessions:control"] },
  goal_set: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_update: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_progress: { sessionRequired: true, allOf: ["goals:manage"] },
  wait_for_input: { sessionRequired: true, allOf: ["sessions:control"] },
  goal_complete: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_pause: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_resume: { sessionRequired: true, allOf: ["goals:manage"] },
  knowledge_search: { sessionRequired: true, allOf: ["documents:search"] },
  knowledge_get: { sessionRequired: true, allOf: ["documents:search"] },
  knowledge_browse: { sessionRequired: true, allOf: ["documents:search"] },
  knowledge_retain_file: { sessionRequired: true, allOf: ["documents:search", "files:read"] },
  knowledge_retain_message: { sessionRequired: true, allOf: ["documents:search", "sessions:read"] },
  knowledge_save: { sessionRequired: true, allOf: ["documents:search"] },
  knowledge_archive: { sessionRequired: true, allOf: ["documents:search"] },
  instruction_policy_save: { sessionRequired: true, allOf: ["documents:search"] },
  instruction_policy_get: { sessionRequired: true, allOf: ["documents:search"] },
  memory_search: { sessionRequired: true, allOf: ["documents:search"] },
  memory_save: { sessionRequired: true, allOf: ["documents:search"] },
  memory_correct: { sessionRequired: true, allOf: ["documents:search"] },
  preference_registry_summary: {
    sessionRequired: true,
    allOf: ["workspace:read"],
  },
  preference_registry_get: { sessionRequired: true, allOf: ["workspace:read"] },
  task_notes_list: { sessionRequired: true, allOf: ["sessions:read"] },
  task_note_save: { sessionRequired: true, allOf: ["sessions:control"] },
  task_note_archive: { sessionRequired: true, allOf: ["sessions:control"] },
  task_note_replace: { sessionRequired: true, allOf: ["sessions:control"] },
  work_claim_upsert: { sessionRequired: true, allOf: ["sessions:control"] },
  work_claim_release: { sessionRequired: true, allOf: ["sessions:control"] },
  knowledge_propose: { sessionRequired: true, allOf: ["documents:search"] },
  knowledge_correct: { sessionRequired: true, allOf: ["documents:search"] },
  task_note_promote_knowledge: {
    sessionRequired: true,
    allOf: ["documents:search", "sessions:control"],
  },
  task_note_promote_instruction_policy: {
    sessionRequired: true,
    allOf: ["documents:search", "sessions:control", "workspace:read"],
  },
  task_note_promote_preference: {
    sessionRequired: true,
    allOf: ["documents:search", "sessions:control", "workspace:read"],
  },
  instruction_policy_propose: {
    sessionRequired: true,
    allOf: ["documents:search", "workspace:read"],
  },
  preference_propose: {
    sessionRequired: true,
    allOf: ["documents:search", "workspace:read"],
  },
  // Explicit user-directed remember composes task-note evidence with the
  // governed promotion path, so it needs the union of both permission sets.
  remember: {
    sessionRequired: true,
    allOf: ["documents:search", "sessions:control", "workspace:read"],
  },
  remember_confirm: {
    sessionRequired: true,
    allOf: ["documents:search", "sessions:control", "workspace:read"],
  },
  company_profile_propose: {
    sessionRequired: true,
    allOf: ["sessions:control", "workspace:read"],
  },
  company_profile_confirm: {
    sessionRequired: true,
    allOf: ["sessions:control", "workspace:read"],
  },
  sandboxes_list: { sessionRequired: true, allOf: ["sessions:read"] },
  sandbox_attach: { sessionRequired: true, allOf: ["sessions:control"] },
  sandbox_swap: { sessionRequired: true, allOf: ["sessions:control"] },
  run_on: { sessionRequired: true, allOf: ["sessions:control"] },
  sandbox_provision: { sessionRequired: true, allOf: ["sessions:control"] },
  connected_machine_remove: { allOf: ["enrollments:manage"] },
  rig_list: { allOf: ["rigs:use"] },
  rig_get: { allOf: ["rigs:use"] },
  rig_propose_change: { allOf: ["rigs:use"] },
  rig_verify: { allOf: ["rigs:use"] },
  rig_promote: { allOf: ["rigs:manage"] },
  sessions_list: { allOf: ["sessions:read"] },
  session_get: { allOf: ["sessions:read"] },
  session_events: { allOf: ["sessions:read"] },
  // Blocking wait inside a running turn: the live attempt's own session is the
  // self target, so the tool exists only for session-scoped grants.
  session_wait: { sessionRequired: true, allOf: ["sessions:read"] },
  command_wait: { sessionRequired: true, allOf: ["sessions:read"] },
  command_read: { sessionRequired: true, allOf: ["sessions:read"] },
  session_create: { allOf: ["sessions:create"] },
  session_send_message: { allOf: ["sessions:control"] },
  session_pause: { allOf: ["sessions:control"] },
  session_resume: { allOf: ["sessions:control"] },
  session_steer: { sessionRequired: true, allOf: ["sessions:control"] },
  // A live attempt may answer another session's structured human-input
  // request (never a tool approval, which stays human-only).
  session_human_input_respond: { sessionRequired: true, allOf: ["sessions:control"] },
  set_other_session_title: { allOf: ["sessions:control"] },
  interaction_discover: { sessionRequired: true, allOf: ["sessions:read"] },
  browser_open: { sessionRequired: true, allOf: ["sessions:control"] },
  browser_tabs: { sessionRequired: true, allOf: ["sessions:control"] },
  browser_observe: { sessionRequired: true, allOf: ["sessions:read"] },
  browser_act: { sessionRequired: true, allOf: ["sessions:control"] },
  browser_clipboard: { sessionRequired: true, allOf: ["sessions:read"] },
  browser_debug: { sessionRequired: true, allOf: ["sessions:read"] },
  browser_auth: { sessionRequired: true, allOf: ["sessions:control"] },
  interaction_request_human: {
    sessionRequired: true,
    allOf: ["sessions:control"],
  },
  browser_identity: { sessionRequired: true, allOf: ["sessions:control"] },
  browser_publish: { sessionRequired: true, allOf: ["sessions:control"] },
  browser_lifecycle: { sessionRequired: true, allOf: ["sessions:control"] },
  computer_open: { sessionRequired: true, allOf: ["sessions:control"] },
  computer_targets: { sessionRequired: true, allOf: ["sessions:read"] },
  computer_observe: { sessionRequired: true, allOf: ["sessions:read"] },
  computer_clipboard: { sessionRequired: true, allOf: ["sessions:read"] },
  computer_act: { sessionRequired: true, allOf: ["sessions:control"] },
  computer_lifecycle: { sessionRequired: true, allOf: ["sessions:control"] },
  variable_set_list: { allOf: ["variable-sets:list", "secrets:list"] },
  environment_list: { allOf: ["variable-sets:list", "secrets:list"] },
  variable_set_get_variable: {
    sessionRequired: true,
    allOf: ["variable-sets:read", "secrets:read"],
  },
  variable_set_set_variable: {
    allOf: ["variable-sets:write", "secrets:write"],
  },
  environment_set_variable: { allOf: ["variable-sets:write", "secrets:write"] },
  capability_catalog_search: {
    sessionRequired: true,
    allOf: ["workspace:read"],
  },
  capability_authorization_request: {
    sessionRequired: true,
    allOf: ["workspace:read"],
  },
  github_connect_link: { allOf: ["github:use"] },
  github_repositories_list: { allOf: ["github:use"] },
  social_connections_list: { allOf: ["connections:read"] },
  social_posts_recent: { allOf: ["connections:read"] },
  social_daily_analysis_context: { allOf: ["connections:read"] },
  social_search_live: { allOf: ["connections:read"] },
  social_mentions_live: { allOf: ["connections:read"] },
  social_thread_fetch: { allOf: ["connections:read"] },
  // Writes the social_posts store, so it takes the write scope like the REST
  // equivalent (POST /social/posts is workspace:admin).
  social_posts_sync: { allOf: ["connections:write"] },
  // Publishes under the user's identity: connections:write keeps it out of the
  // default agent permission set, unlike the read-only social tools above.
  social_post_reply: { allOf: ["connections:write"] },
  x_accounts_list: { allOf: ["connections:read"] },
  x_search_live: { allOf: ["connections:read"] },
  x_mentions_live: { allOf: ["connections:read"] },
  x_thread_fetch: { allOf: ["connections:read"] },
  x_posts_sync: { allOf: ["connections:write"] },
  x_post_reply: { allOf: ["connections:write"] },
  reddit_accounts_list: { allOf: ["connections:read"] },
  reddit_search_live: { allOf: ["connections:read"] },
  reddit_mentions_live: { allOf: ["connections:read"] },
  reddit_thread_fetch: { allOf: ["connections:read"] },
  reddit_posts_sync: { allOf: ["connections:write"] },
  reddit_post_reply: { allOf: ["connections:write"] },
  scheduled_tasks_list: {
    anyOf: ["scheduled_tasks:manage", "scheduled_tasks:run"],
  },
  scheduled_tasks_get: {
    anyOf: ["scheduled_tasks:manage", "scheduled_tasks:run"],
  },
  scheduled_tasks_create: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_update: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_pause: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_resume: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_trigger: { allOf: ["scheduled_tasks:run"] },
  scheduled_tasks_delete: { allOf: ["scheduled_tasks:manage"] },
  scheduled_task_runs_list: {
    anyOf: ["scheduled_tasks:manage", "scheduled_tasks:run"],
  },
  slack_bot_list_channels: { allOf: ["connections:read"] },
  slack_bot_search: { allOf: ["connections:read"] },
  slack_bot_channel_history: { allOf: ["connections:read"] },
  slack_bot_thread_replies: { allOf: ["connections:read"] },
  slack_bot_list_users: { allOf: ["connections:read"] },
  slack_bot_list_files: { allOf: ["connections:read"] },
  slack_bot_file_info: { allOf: ["connections:read"] },
  slack_bot_file_content: { allOf: ["connections:read"] },
  slack_bot_post_message: { allOf: ["connections:read"] },
  slack_bot_delete_message: { allOf: ["connections:read"] },
  fiken_companies_list: { allOf: ["connections:read"] },
  fiken_contacts_list: { allOf: ["connections:read"] },
  fiken_products_list: { allOf: ["connections:read"] },
  fiken_invoices_list: { allOf: ["connections:read"] },
  fiken_invoice_get: { allOf: ["connections:read"] },
  fiken_bank_accounts_list: { allOf: ["connections:read"] },
  fiken_purchases_list: { allOf: ["connections:read"] },
  fiken_sales_list: { allOf: ["connections:read"] },
  // Writes into the workspace's real accounting ledger surface take the write
  // scope, keeping them out of the default agent permission set.
  fiken_contact_create: { allOf: ["connections:write"] },
  fiken_invoice_draft_create: { allOf: ["connections:write"] },
  atlassian_sources_list: { allOf: ["connections:read"] },
  atlassian_search: { allOf: ["connections:read"] },
  atlassian_get: { allOf: ["connections:read"] },
  artifacts_list: { allOf: ["artifacts:read"] },
  artifacts_get_source: { sessionRequired: true, allOf: ["artifacts:read"] },
  artifacts_prepare_upload: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_create: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_publish: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_rollback: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_archive: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_restore: { sessionRequired: true, allOf: ["artifacts:publish"] },
  sandbox_file_publish: {
    sessionRequired: true,
    allOf: ["files:read", "files:upload"],
  },
  editable_artifact_list: { sessionRequired: true, allOf: ["artifacts:read"] },
  editable_artifact_create: {
    sessionRequired: true,
    allOf: ["artifacts:publish"],
  },
  editable_artifact_import: {
    sessionRequired: true,
    allOf: ["artifacts:publish", "files:read"],
  },
  editable_artifact_get: { sessionRequired: true, allOf: ["artifacts:read"] },
  editable_artifact_inspect: {
    sessionRequired: true,
    allOf: ["artifacts:read"],
  },
  editable_artifact_apply: {
    sessionRequired: true,
    allOf: ["artifacts:publish"],
  },
  editable_artifact_export: {
    sessionRequired: true,
    allOf: ["artifacts:read"],
  },
  editable_artifact_export_status: {
    sessionRequired: true,
    allOf: ["artifacts:read", "files:upload"],
  },
  project_list: { allOf: ["sessions:read"] },
  project_get: { allOf: ["sessions:read"] },
  project_create: { allOf: ["sessions:create"] },
  project_update: { allOf: ["sessions:create"] },
  project_reorder: { allOf: ["sessions:create"] },
  project_delete: { allOf: ["sessions:create"] },
  session_set_project: { allOf: ["sessions:control"] },
} satisfies Record<FirstPartyMcpToolName, FirstPartyToolAuthorization>;

/**
 * The permissions a session's first-party tool selection can possibly
 * exercise, derived from the same per-tool registration data that gates the
 * MCP surface. A caller that only proxies REST handlers on behalf of a
 * selection (the Codemode SDK proxy) must never hold more than this: a
 * selection without any session_* orchestration tool cannot need
 * sessions:create or sessions:control, so a delegated token for it must not
 * carry them either. `anyOf` alternatives are all counted because any one of
 * them could be the permission the selection actually holds.
 */
export function permissionsRequiredByFirstPartyTools(
  tools: readonly FirstPartyMcpToolName[],
): Permission[] {
  const required = new Set<Permission>();
  for (const tool of tools) {
    const policy: FirstPartyToolAuthorization | undefined = FIRST_PARTY_TOOL_AUTHORIZATION[tool];
    if (!policy) continue;
    for (const permission of policy.allOf ?? []) required.add(permission);
    for (const permission of policy.anyOf ?? []) required.add(permission);
  }
  return [...required];
}
