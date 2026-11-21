/**
 * The names of Opengeni's built-in GitHub tools (the `github_app` and
 * `github_personal` servers, `packages/runtime/src/github-rest-mcp.ts`). They
 * live here so clients can list them, for example for an agent's Can use
 * rules on the built-in GitHub tools.
 *
 * This module must not import `./index`.
 */

export const GITHUB_REST_READ_TOOL_NAMES = Object.freeze([
  "repositories_list",
  "repository_get",
  "branches_list",
  "ref_get",
  "file_get",
  "issues_list",
  "issue_get",
  "pull_requests_list",
  "pull_request_get",
  "pull_request_reviews_list",
  "checks_summary",
  "code_search",
  "workflow_runs_list",
  "workflow_run_get",
  "workflow_job_logs_get",
  "organizations_list",
  "owner_repositories_list",
] as const);

export const GITHUB_REST_WRITE_TOOL_NAMES = Object.freeze([
  "ref_create",
  "issue_create",
  "issue_update",
  "issue_comment",
  "pull_request_create",
  "pull_request_update",
  "pull_request_comment",
  "pull_request_request_review",
  "pull_request_review_submit",
  "pull_request_merge",
] as const);

export const GITHUB_REST_TOOL_NAMES = Object.freeze([
  ...GITHUB_REST_READ_TOOL_NAMES,
  ...GITHUB_REST_WRITE_TOOL_NAMES,
] as const);
