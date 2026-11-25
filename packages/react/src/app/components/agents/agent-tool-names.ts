/**
 * Readable names for the tools an agent's Can use rules name. A tool's own
 * title comes first; GitHub tools have curated names, and one GitHub action
 * is one row whichever server offers it (Opengeni's built-in GitHub tools or
 * GitHub's MCP server), so a rule set on it covers both. Anything else is
 * its code name in words.
 */
import { AGENT_BUILT_IN_GITHUB_CONNECTOR } from "@opengeni/contracts";
import type { AgentToolPermission, AgentToolPermissionRule } from "@opengeni/sdk";

/** A tool as a connection lists it. */
export interface ListedTool {
  name: string;
  title?: string | undefined;
}

/** One row of tools: its readable name and every tool name a rule on it sets. */
export interface CanUseTool {
  /** Stable row key: the first of its names. */
  key: string;
  label: string;
  names: string[];
}

/**
 * GitHub actions by readable name: Opengeni's built-in tool names
 * (GITHUB_REST_TOOL_NAMES) and GitHub MCP server names for the same action.
 */
const GITHUB_ACTIONS: readonly (readonly [label: string, ...names: string[]])[] = [
  ["List repositories", "repositories_list"],
  ["Read repository", "repository_get"],
  ["List an owner's repositories", "owner_repositories_list"],
  ["Search repositories", "search_repositories"],
  ["Create repository", "create_repository"],
  ["Fork repository", "fork_repository"],
  ["List organizations", "organizations_list"],
  ["List branches", "branches_list", "list_branches"],
  ["Read branch or tag", "ref_get"],
  ["Create branch", "ref_create", "create_branch"],
  ["Read file", "file_get", "get_file_contents"],
  ["Create or update file", "create_or_update_file"],
  ["Delete file", "delete_file"],
  ["Push files", "push_files"],
  ["List commits", "list_commits"],
  ["Read commit", "get_commit"],
  ["Search code", "code_search", "search_code"],
  ["List issues", "issues_list", "list_issues"],
  ["Read issue", "issue_get", "get_issue", "issue_read"],
  ["Search issues", "search_issues"],
  ["Create issue", "issue_create", "create_issue"],
  ["Update issue", "issue_update", "update_issue"],
  ["Comment on issue", "issue_comment", "add_issue_comment"],
  ["List pull requests", "pull_requests_list", "list_pull_requests"],
  ["Read pull request", "pull_request_get", "get_pull_request", "pull_request_read"],
  ["Search pull requests", "search_pull_requests"],
  ["Create pull request", "pull_request_create", "create_pull_request"],
  ["Update pull request", "pull_request_update", "update_pull_request"],
  ["Update pull request branch", "update_pull_request_branch"],
  ["Comment on pull request", "pull_request_comment"],
  ["List pull request reviews", "pull_request_reviews_list", "get_pull_request_reviews"],
  ["Request review", "pull_request_request_review"],
  ["Request Copilot review", "request_copilot_review"],
  [
    "Submit review",
    "pull_request_review_submit",
    "create_pull_request_review",
    "submit_pending_pull_request_review",
  ],
  ["Merge pull request", "pull_request_merge", "merge_pull_request"],
  ["Read checks", "checks_summary"],
  ["List workflow runs", "workflow_runs_list", "list_workflow_runs"],
  ["Read workflow run", "workflow_run_get", "get_workflow_run"],
  ["Read job logs", "workflow_job_logs_get", "get_job_logs"],
  ["Run workflow", "run_workflow"],
  ["Read your profile", "get_me"],
];

const GITHUB_ACTION_BY_NAME = new Map(
  GITHUB_ACTIONS.flatMap(([label, ...names]) =>
    names.map((name) => [name, { label, names }] as const),
  ),
);

/** A code name in words: `merge_pull_request` and `mergePullRequest` read "Merge pull request". */
export function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.\-/]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return name;
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * One connection's tool rows, from the tools it lists and the tools its rules
 * name (a rule for a tool not listed still shows). On GitHub, one row per
 * action covers each of its names.
 */
export function canUseTools(connector: string, tools: readonly ListedTool[]): CanUseTool[] {
  const github = connector === AGENT_BUILT_IN_GITHUB_CONNECTOR;
  const rows = new Map<string, CanUseTool & { titled: boolean }>();
  for (const tool of tools) {
    const action = github ? GITHUB_ACTION_BY_NAME.get(tool.name) : undefined;
    const key = action ? action.names[0]! : tool.name;
    const title = tool.title?.trim() || null;
    const known = rows.get(key);
    if (known) {
      if (title && !known.titled) Object.assign(known, { label: title, titled: true });
      continue;
    }
    rows.set(key, {
      key,
      label: title ?? action?.label ?? humanizeToolName(tool.name),
      names: action ? [...action.names] : [tool.name],
      titled: title !== null,
    });
  }
  return [...rows.values()].map(({ key, label, names }) => ({ key, label, names }));
}

const STRICTNESS: Record<AgentToolPermission, number> = { allow: 0, ask: 1, block: 2 };

/**
 * The choice a row shows: its tools' rules, or the strictest when they differ.
 * Undefined: none of its tools has a rule.
 */
export function canUseToolPermission(
  rules: readonly AgentToolPermissionRule[],
  connector: string,
  tool: CanUseTool,
): AgentToolPermission | undefined {
  let shown: AgentToolPermission | undefined;
  for (const rule of rules) {
    if (rule.connector !== connector || !tool.names.includes(rule.tool)) continue;
    if (shown === undefined || STRICTNESS[rule.permission] > STRICTNESS[shown])
      shown = rule.permission;
  }
  return shown;
}

/** The rules with one choice for every name of a row set, or cleared with null. */
export function withAgentToolRules(
  rules: readonly AgentToolPermissionRule[],
  connector: string,
  names: readonly string[],
  permission: AgentToolPermission | null,
): AgentToolPermissionRule[] {
  const rest = rules.filter((rule) => !(rule.connector === connector && names.includes(rule.tool)));
  return permission === null
    ? rest
    : [...rest, ...names.map((tool) => ({ connector, tool, permission }))];
}
