import {
  defineLocalMcpBridgeDescriptor,
  type LocalMcpBridgeDescriptor,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { MCPServer } from "@openai/agents";

export const GITHUB_REST_API_ORIGIN = "https://api.github.com";
export const GITHUB_REST_MCP_APP_SERVER_ID = "github_app";
export const GITHUB_REST_MCP_PERSONAL_SERVER_ID = "github_personal";

const GITHUB_API_VERSION = "2022-11-28";
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGE_SIZE = 50;
const MAX_TEXT = 64 * 1024;
const LOG_DEFAULT_BYTES = 32 * 1024;
const LOG_MAX_BYTES = 256 * 1024;
/**
 * Without range support from the log host, a read streams the log and stops
 * here. Hosts that honour Range (GitHub's log storage does) have no limit.
 */
const LOG_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const ORGANIZATION_SCAN_PAGES = 10;
const CONNECTOR_OUTCOME_META_KEY = "opengeni/connectorActionOutcome";

export type GitHubRestAuthorityKind = "workspace_app" | "personal_oauth";

export type GitHubRestRepository = Readonly<{
  repositoryId: string;
  fullName: string;
  canonicalUrl: string;
  defaultRef: string;
  access: "read" | "write";
  authorityKind: GitHubRestAuthorityKind;
  /** Private policy identity. It never enters schemas or tool results. */
  connectionId: string;
}>;

export type GitHubRestResolvedAuthority = Readonly<{
  headers: Readonly<Record<string, string>>;
  connectionId: string;
  actor: Readonly<{
    kind: GitHubRestAuthorityKind;
    login: string;
  }>;
  authorizeProviderRequest?: () => Promise<boolean>;
}>;

export type GitHubRestMcpServerOptions = {
  serverId: string;
  authorityKind: GitHubRestAuthorityKind;
  /** The repositories accepted for the task. May be empty with `resolveRepository`. */
  repositories: readonly GitHubRestRepository[];
  /**
   * All my repositories: a repository outside `repositories`, by `owner/name`,
   * as the actor may use it now (checked with GitHub), or null when it may
   * not be used. Without it only `repositories` can be used.
   */
  resolveRepository?: (fullName: string) => Promise<GitHubRestRepository | null>;
  /**
   * Account-level reads that name no single repository (the person's
   * organizations and an owner's repositories). Without it those tools are
   * not offered.
   */
  account?: {
    connectionId: string;
    resolveAuthority: (input: {
      serverId: string;
      toolName: string;
      destinationUrl: string;
      forceRefresh: boolean;
    }) => Promise<GitHubRestResolvedAuthority>;
  };
  resolveAuthority: (input: {
    serverId: string;
    toolName: string;
    destinationUrl: string;
    repository: GitHubRestRepository;
    write: boolean;
    forceRefresh: boolean;
  }) => Promise<GitHubRestResolvedAuthority>;
  fetchImpl?: FetchLike;
};

type GitHubTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

export const GITHUB_REST_MCP_APP_DESCRIPTOR = githubDescriptor("github-rest-workspace-app", "host");
export const GITHUB_REST_MCP_PERSONAL_DESCRIPTOR = githubDescriptor(
  "github-rest-personal-oauth",
  "connection",
);

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

/** Reads that name no repository; offered only with account authority. */
export const GITHUB_REST_ACCOUNT_TOOL_NAMES = Object.freeze([
  "organizations_list",
  "owner_repositories_list",
] as const);

/** Tools that do not take one repository argument. */
export const GITHUB_REST_REPOSITORYLESS_TOOL_NAMES = Object.freeze([
  "repositories_list",
  ...GITHUB_REST_ACCOUNT_TOOL_NAMES,
] as const);

const ACCOUNT_TOOLS = new Set<string>(GITHUB_REST_ACCOUNT_TOOL_NAMES);

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

const WRITE_TOOLS = new Set<string>(GITHUB_REST_WRITE_TOOL_NAMES);

export function githubRestToolIsMutation(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export const GITHUB_REST_MCP_TOOLS: GitHubTool[] = [
  tool("repositories_list", "List the GitHub repositories accepted for this task and actor.", {}),
  tool("repository_get", "Get bounded repository metadata.", repositoryProperties()),
  tool("branches_list", "List branches with bounded pagination.", {
    ...repositoryProperties(),
    limit: integer(1, MAX_PAGE_SIZE),
    page: integer(1, 100),
  }),
  tool(
    "ref_get",
    "Get one exact Git ref.",
    {
      ...repositoryProperties(),
      ref: stringProperty("Git ref such as heads/main.", 512),
    },
    ["repository", "ref"],
  ),
  tool(
    "file_get",
    "Read one repository file or directory at an exact ref.",
    {
      ...repositoryProperties(),
      path: stringProperty("Repository-relative path.", 4_096),
      ref: stringProperty("Branch, tag, or commit. Defaults to the accepted resource ref.", 512),
    },
    ["repository", "path"],
  ),
  tool("issues_list", "List issues with bounded pagination.", {
    ...repositoryProperties(),
    state: enumProperty(["open", "closed", "all"]),
    limit: integer(1, MAX_PAGE_SIZE),
    page: integer(1, 100),
  }),
  tool(
    "issue_get",
    "Get one issue.",
    {
      ...repositoryProperties(),
      issueNumber: integer(1, Number.MAX_SAFE_INTEGER),
    },
    ["repository", "issueNumber"],
  ),
  tool("pull_requests_list", "List pull requests with bounded pagination.", {
    ...repositoryProperties(),
    state: enumProperty(["open", "closed", "all"]),
    limit: integer(1, MAX_PAGE_SIZE),
    page: integer(1, 100),
  }),
  tool(
    "pull_request_get",
    "Get one pull request.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
    },
    ["repository", "pullNumber"],
  ),
  tool(
    "pull_request_reviews_list",
    "List reviews on a pull request with bounded pagination.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
      limit: integer(1, MAX_PAGE_SIZE),
      page: integer(1, 100),
    },
    ["repository", "pullNumber"],
  ),
  tool("checks_summary", "Summarize check runs and commit statuses for one ref.", {
    ...repositoryProperties(),
    ref: stringProperty("Branch, tag, or commit. Defaults to the accepted resource ref.", 512),
  }),
  tool(
    "code_search",
    "Search code only inside one accepted repository.",
    {
      ...repositoryProperties(),
      query: stringProperty("GitHub code-search query, without a repo qualifier.", 512),
      limit: integer(1, 20),
      page: integer(1, 10),
    },
    ["repository", "query"],
  ),
  tool("workflow_runs_list", "List GitHub Actions workflow runs, newest first.", {
    ...repositoryProperties(),
    workflow: stringProperty("Workflow file name (ci.yml) or numeric id.", 256),
    branch: stringProperty("Head branch.", 512),
    pullNumber: {
      ...integer(1, Number.MAX_SAFE_INTEGER),
      description: "Runs for this pull request's current head commit.",
    },
    headSha: stringProperty("Exact head commit SHA.", 40),
    event: stringProperty("Triggering event, such as push or pull_request.", 64),
    status: {
      description: "A run status or conclusion.",
      ...enumProperty([
        "queued",
        "in_progress",
        "completed",
        "requested",
        "waiting",
        "pending",
        "success",
        "failure",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "neutral",
        "stale",
      ]),
    },
    limit: integer(1, MAX_PAGE_SIZE),
    page: integer(1, 100),
  }),
  tool(
    "workflow_run_get",
    "Get one workflow run with its jobs and their steps.",
    {
      ...repositoryProperties(),
      runId: integer(1, Number.MAX_SAFE_INTEGER),
      attempt: integer(1, 1_000),
    },
    ["repository", "runId"],
  ),
  tool(
    "workflow_job_logs_get",
    "Read one workflow job's log. Returns the end of the log by default. To read further, pass offset = nextOffset; to read earlier, pass offset = max(0, startByte - maxBytes). totalBytes is null when the log's length is unknown.",
    {
      ...repositoryProperties(),
      jobId: integer(1, Number.MAX_SAFE_INTEGER),
      offset: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "Byte to start from. Omit for the end of the log.",
      },
      maxBytes: integer(1_024, LOG_MAX_BYTES),
    },
    ["repository", "jobId"],
  ),
  tool(
    "organizations_list",
    "List the GitHub organizations the connected person can reach repositories in. complete is false when there were too many repositories to look through.",
    {},
    [],
  ),
  tool(
    "owner_repositories_list",
    "List repositories of one GitHub user or organization that the connected person can see, optionally filtered by name.",
    {
      owner: stringProperty("User or organization login.", 39),
      filter: stringProperty("Text the repository name must contain.", 100),
      limit: integer(1, 100),
      page: integer(1, 100),
    },
    ["owner"],
  ),
  mutationTool(
    "ref_create",
    "Create a new Git ref from an exact commit SHA.",
    {
      ...repositoryProperties(),
      ref: stringProperty("Full ref beginning with refs/heads/.", 512),
      sha: stringProperty("Exact 40-character commit SHA.", 40),
    },
    ["repository", "ref", "sha"],
  ),
  mutationTool(
    "issue_create",
    "Create an issue.",
    {
      ...repositoryProperties(),
      title: stringProperty("Issue title.", 256),
      body: stringProperty("Issue body.", MAX_TEXT),
      labels: stringArrayProperty(20, 128),
      assignees: stringArrayProperty(20, 128),
    },
    ["repository", "title"],
  ),
  mutationTool(
    "issue_update",
    "Update an issue's title, body, state, labels, or assignees.",
    {
      ...repositoryProperties(),
      issueNumber: integer(1, Number.MAX_SAFE_INTEGER),
      title: stringProperty("Replacement issue title.", 256),
      body: stringProperty("Replacement issue body.", MAX_TEXT),
      state: enumProperty(["open", "closed"]),
      labels: stringArrayProperty(20, 128),
      assignees: stringArrayProperty(20, 128),
    },
    ["repository", "issueNumber"],
  ),
  mutationTool(
    "issue_comment",
    "Comment on an issue.",
    {
      ...repositoryProperties(),
      issueNumber: integer(1, Number.MAX_SAFE_INTEGER),
      body: stringProperty("Comment body.", MAX_TEXT),
    },
    ["repository", "issueNumber", "body"],
  ),
  mutationTool(
    "pull_request_create",
    "Create a pull request.",
    {
      ...repositoryProperties(),
      title: stringProperty("Pull request title.", 256),
      head: stringProperty("Source branch or owner:branch.", 512),
      base: stringProperty("Target branch.", 512),
      body: stringProperty("Pull request body.", MAX_TEXT),
      draft: { type: "boolean" },
    },
    ["repository", "title", "head", "base"],
  ),
  mutationTool(
    "pull_request_update",
    "Update a pull request's title, body, state, or base.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
      title: stringProperty("Replacement pull request title.", 256),
      body: stringProperty("Replacement pull request body.", MAX_TEXT),
      state: enumProperty(["open", "closed"]),
      base: stringProperty("Replacement target branch.", 512),
    },
    ["repository", "pullNumber"],
  ),
  mutationTool(
    "pull_request_comment",
    "Comment on a pull request conversation.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
      body: stringProperty("Comment body.", MAX_TEXT),
    },
    ["repository", "pullNumber", "body"],
  ),
  mutationTool(
    "pull_request_request_review",
    "Request reviewers for a pull request.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
      reviewers: stringArrayProperty(20, 128),
      teamReviewers: stringArrayProperty(20, 128),
    },
    ["repository", "pullNumber"],
  ),
  mutationTool(
    "pull_request_review_submit",
    "Submit a comment, approval, or change request as the connected GitHub user.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
      event: enumProperty(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: stringProperty("Review summary.", MAX_TEXT),
      commitId: stringProperty("Optional exact commit SHA to review.", 40),
    },
    ["repository", "pullNumber", "event"],
  ),
  destructiveMutationTool(
    "pull_request_merge",
    "Merge a pull request as the connected GitHub user.",
    {
      ...repositoryProperties(),
      pullNumber: integer(1, Number.MAX_SAFE_INTEGER),
      method: enumProperty(["merge", "squash", "rebase"]),
      expectedHeadSha: stringProperty("Optional exact expected head commit SHA.", 40),
      commitTitle: stringProperty("Optional merge commit title.", 256),
      commitMessage: stringProperty("Optional merge commit message.", MAX_TEXT),
    },
    ["repository", "pullNumber"],
  ),
];

export class GitHubRestMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = true;
  readonly bridge: LocalMcpBridgeDescriptor;
  private readonly fetchImpl: FetchLike;
  private readonly repositoriesByName: ReadonlyMap<string, GitHubRestRepository>;

  constructor(private readonly options: GitHubRestMcpServerOptions) {
    if (
      (options.repositories.length === 0 && !options.resolveRepository) ||
      options.repositories.length > 100
    ) {
      throw new Error("GitHub REST bridge requires 1-100 accepted repositories");
    }
    const byName = new Map<string, GitHubRestRepository>();
    for (const repository of options.repositories) {
      assertRepository(repository, options.authorityKind);
      const key = repository.fullName.toLowerCase();
      if (byName.has(key))
        throw new Error("GitHub REST bridge repository identities must be unique");
      byName.set(key, Object.freeze({ ...repository }));
    }
    this.repositoriesByName = byName;
    this.name = `opengeni-github-rest-${safeIdentity(options.serverId)}`;
    this.bridge =
      options.authorityKind === "workspace_app"
        ? GITHUB_REST_MCP_APP_DESCRIPTOR
        : GITHUB_REST_MCP_PERSONAL_DESCRIPTOR;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<GitHubTool[]> {
    return GITHUB_REST_MCP_TOOLS.filter(
      (entry) => this.options.account || !ACCOUNT_TOOLS.has(entry.name),
    ).map((entry) => {
      if (!this.options.resolveRepository) return { ...entry };
      if (entry.name === "repositories_list") {
        return {
          ...entry,
          description:
            "List the GitHub repositories attached to this task. Every other repository the connected person can access works too, by owner/name; find them with owner_repositories_list.",
        };
      }
      const schema = entry.inputSchema as { properties?: Record<string, unknown> };
      if (!schema.properties?.repository) return { ...entry };
      return {
        ...entry,
        inputSchema: {
          ...entry.inputSchema,
          properties: {
            ...schema.properties,
            repository: stringProperty(
              "Exact owner/name of any repository the person can access.",
              256,
            ),
          },
        },
      } as GitHubTool;
    });
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    return (await this.callToolResult(toolName, args)).content;
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    meta?: Record<string, unknown> | null,
  ): Promise<any> {
    const operationId =
      meta && typeof meta.opengeniOperationId === "string" ? meta.opengeniOperationId : null;
    try {
      const output = await this.execute(toolName, args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      if (error instanceof GitHubRestMutationOutcomeUnknownError) {
        if (operationId) {
          throw error;
        }
        return connectorErrorResult(error, "uncertain");
      }
      if (githubRestToolIsMutation(toolName)) {
        const mutationError = new GitHubRestMutationNotExecutedError(safeErrorMessage(error));
        if (operationId) {
          throw mutationError;
        }
        return connectorErrorResult(mutationError, "not_executed");
      }
      return {
        isError: true,
        content: [{ type: "text", text: safeErrorMessage(error) }],
      };
    }
  }

  private async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!GITHUB_REST_TOOL_NAMES.includes(toolName as (typeof GITHUB_REST_TOOL_NAMES)[number])) {
      throw new GitHubRestInputError(`Unsupported GitHub tool: ${toolName}`);
    }
    if (toolName === "repositories_list") {
      const repositories = [];
      for (const repository of this.repositoriesByName.values()) {
        let authority: GitHubRestResolvedAuthority;
        try {
          authority = await this.options.resolveAuthority({
            serverId: this.options.serverId,
            toolName,
            destinationUrl: `${GITHUB_REST_API_ORIGIN}/repos/${repository.fullName}`,
            repository,
            write: false,
            forceRefresh: false,
          });
        } catch (error) {
          if (error instanceof GitHubRestRepositoryDetachedError) continue;
          throw error;
        }
        assertResolvedAuthority(repository, authority);
        if (authority.authorizeProviderRequest && !(await authority.authorizeProviderRequest())) {
          throw new GitHubRestAuthorityError("GitHub repository authority is no longer current");
        }
        repositories.push(projectAcceptedRepository(repository, authority.actor));
      }
      return this.options.resolveRepository
        ? { repositories, allRepositories: true }
        : { repositories };
    }
    if (ACCOUNT_TOOLS.has(toolName)) {
      return await this.executeAccount(toolName, args);
    }
    const repository = await this.repository(args.repository);
    switch (toolName) {
      case "workflow_runs_list":
        return await this.workflowRunsList(repository, args);
      case "workflow_run_get":
        return await this.workflowRunGet(repository, args);
      case "workflow_job_logs_get":
        return await this.workflowJobLogs(repository, args);
      case "repository_get":
        return await this.get(
          toolName,
          repository,
          `/repos/${repository.fullName}`,
          projectRepository,
        );
      case "branches_list":
        return await this.getList(
          toolName,
          repository,
          `/repos/${repository.fullName}/branches`,
          args,
          projectBranch,
        );
      case "ref_get":
        return await this.get(
          toolName,
          repository,
          `/repos/${repository.fullName}/git/ref/${encodeGitRef(requiredString(args.ref, "ref", 512))}`,
          projectRef,
        );
      case "file_get": {
        const path = repositoryPath(requiredString(args.path, "path", 4_096));
        const ref = optionalString(args.ref, "ref", 512) ?? repository.defaultRef;
        return await this.get(
          toolName,
          repository,
          `/repos/${repository.fullName}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(ref)}`,
          projectContent,
        );
      }
      case "issues_list":
        return await this.getList(
          toolName,
          repository,
          `/repos/${repository.fullName}/issues`,
          args,
          projectIssue,
          {
            state: optionalEnum(args.state, "state", ["open", "closed", "all"]) ?? "open",
          },
          (value) => objectRecord(value).pull_request === undefined,
        );
      case "issue_get":
        return await this.get(
          toolName,
          repository,
          `/repos/${repository.fullName}/issues/${positiveInteger(args.issueNumber, "issueNumber")}`,
          projectIssue,
        );
      case "pull_requests_list":
        return await this.getList(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls`,
          args,
          projectPullRequest,
          {
            state: optionalEnum(args.state, "state", ["open", "closed", "all"]) ?? "open",
          },
        );
      case "pull_request_get":
        return await this.get(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}`,
          projectPullRequest,
        );
      case "pull_request_reviews_list":
        return await this.getList(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}/reviews`,
          args,
          projectReview,
        );
      case "checks_summary":
        return await this.checksSummary(repository, args);
      case "code_search":
        return await this.codeSearch(repository, args);
      case "ref_create":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/git/refs`,
          "POST",
          {
            ref: requiredBranchRef(args.ref),
            sha: requiredSha(args.sha),
          },
          projectRef,
        );
      case "issue_create":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/issues`,
          "POST",
          compact({
            title: requiredString(args.title, "title", 256),
            body: optionalText(args.body, "body", MAX_TEXT),
            labels: optionalStringArray(args.labels, "labels", 20, 128),
            assignees: optionalStringArray(args.assignees, "assignees", 20, 128),
          }),
          projectIssue,
        );
      case "issue_update":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/issues/${positiveInteger(args.issueNumber, "issueNumber")}`,
          "PATCH",
          requireMutationFields(
            compact({
              title: optionalString(args.title, "title", 256),
              body: optionalText(args.body, "body", MAX_TEXT),
              state: optionalEnum(args.state, "state", ["open", "closed"]),
              labels: optionalStringArray(args.labels, "labels", 20, 128),
              assignees: optionalStringArray(args.assignees, "assignees", 20, 128),
            }),
          ),
          projectIssue,
        );
      case "issue_comment":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/issues/${positiveInteger(args.issueNumber, "issueNumber")}/comments`,
          "POST",
          {
            body: requiredText(args.body, "body", MAX_TEXT),
          },
          projectComment,
        );
      case "pull_request_create":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls`,
          "POST",
          compact({
            title: requiredString(args.title, "title", 256),
            head: requiredString(args.head, "head", 512),
            base: requiredString(args.base, "base", 512),
            body: optionalText(args.body, "body", MAX_TEXT),
            draft: optionalBoolean(args.draft, "draft"),
          }),
          projectPullRequest,
        );
      case "pull_request_update":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}`,
          "PATCH",
          requireMutationFields(
            compact({
              title: optionalString(args.title, "title", 256),
              body: optionalText(args.body, "body", MAX_TEXT),
              state: optionalEnum(args.state, "state", ["open", "closed"]),
              base: optionalString(args.base, "base", 512),
            }),
          ),
          projectPullRequest,
        );
      case "pull_request_comment":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/issues/${positiveInteger(args.pullNumber, "pullNumber")}/comments`,
          "POST",
          {
            body: requiredText(args.body, "body", MAX_TEXT),
          },
          projectComment,
        );
      case "pull_request_request_review":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}/requested_reviewers`,
          "POST",
          requireMutationFields(
            compact({
              reviewers: optionalStringArray(args.reviewers, "reviewers", 20, 128),
              team_reviewers: optionalStringArray(args.teamReviewers, "teamReviewers", 20, 128),
            }),
          ),
          projectReviewRequest,
        );
      case "pull_request_review_submit":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}/reviews`,
          "POST",
          reviewSubmissionBody(args),
          projectReview,
        );
      case "pull_request_merge":
        return await this.mutate(
          toolName,
          repository,
          `/repos/${repository.fullName}/pulls/${positiveInteger(args.pullNumber, "pullNumber")}/merge`,
          "PUT",
          compact({
            merge_method: optionalEnum(args.method, "method", ["merge", "squash", "rebase"]),
            sha: optionalSha(args.expectedHeadSha, "expectedHeadSha"),
            commit_title: optionalString(args.commitTitle, "commitTitle", 256),
            commit_message: optionalText(args.commitMessage, "commitMessage", MAX_TEXT),
          }),
          projectMerge,
        );
    }
  }

  private async repository(value: unknown): Promise<GitHubRestRepository> {
    const requested = requiredString(value, "repository", 256);
    const repository = this.repositoriesByName.get(requested.toLowerCase());
    if (repository) return repository;
    if (this.options.resolveRepository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(requested)) {
      const resolved = await this.options.resolveRepository(requested);
      if (resolved) {
        assertRepository(resolved, this.options.authorityKind);
        if (resolved.fullName.toLowerCase() !== requested.toLowerCase()) {
          throw new GitHubRestInputError(
            `GitHub knows this repository as ${resolved.fullName}; use that name`,
          );
        }
        return Object.freeze({ ...resolved });
      }
      throw new GitHubRestInputError(
        "GitHub has no repository by that name that the connected person can use",
      );
    }
    throw new GitHubRestInputError("Repository is outside the accepted GitHub resource set");
  }

  /**
   * Your GitHub holds only the repo scope, and GitHub's organization list
   * needs read:org, so organizations come from the repositories the person
   * can reach as a member or collaborator.
   */
  private async listOrganizations(toolName: string): Promise<unknown> {
    const organizations = new Map<string, { id: number | null; login: string }>();
    let last: GitHubProviderResult | null = null;
    let complete = false;
    for (let page = 1; page <= ORGANIZATION_SCAN_PAGES; page += 1) {
      const url = new URL("/user/repos", GITHUB_REST_API_ORIGIN);
      url.searchParams.set("affiliation", "organization_member,collaborator");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      last = await this.request(toolName, null, url, { method: "GET" }, true);
      if (!Array.isArray(last.payload)) {
        throw new GitHubRestProviderError("GitHub returned an invalid list response");
      }
      for (const repository of last.payload) {
        const owner = objectRecord(objectRecord(repository).owner);
        const login = optionalOutputString(owner.login, 128);
        if (owner.type !== "Organization" || !login) continue;
        organizations.set(login.toLowerCase(), { id: outputInteger(owner.id), login });
      }
      if (last.payload.length < 100) {
        complete = true;
        break;
      }
    }
    return resultEnvelope(
      {
        organizations: [...organizations.values()].sort((a, b) => a.login.localeCompare(b.login)),
        complete,
      },
      last!,
    );
  }

  private async executeAccount(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const limit = String(optionalPositiveInteger(args.limit, "limit", 100) ?? 30);
    const page = String(optionalPositiveInteger(args.page, "page", 100) ?? 1);
    if (toolName === "organizations_list") return await this.listOrganizations(toolName);
    const owner = requiredString(args.owner, "owner", 39);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)) {
      throw new GitHubRestInputError("owner must be a GitHub user or organization login");
    }
    const filter = optionalString(args.filter, "filter", 100);
    const ownerResult = await this.request(
      toolName,
      null,
      `/users/${encodeURIComponent(owner)}`,
      { method: "GET" },
      true,
    );
    const ownerRow = objectRecord(ownerResult.payload);
    const login = optionalOutputString(ownerRow.login, 39) ?? owner;
    const organization = ownerRow.type === "Organization";
    let url: URL;
    if (filter) {
      if (/[:"]/u.test(filter)) throw new GitHubRestInputError("filter must be plain text");
      url = new URL("/search/repositories", GITHUB_REST_API_ORIGIN);
      url.searchParams.set("q", `${filter} in:name ${organization ? "org" : "user"}:${login}`);
    } else if (organization) {
      url = new URL(`/orgs/${encodeURIComponent(login)}/repos`, GITHUB_REST_API_ORIGIN);
      url.searchParams.set("type", "all");
      url.searchParams.set("sort", "full_name");
    } else if (login.toLowerCase() === ownerResult.actor.login.toLowerCase()) {
      // The person's own repositories, private ones included.
      url = new URL("/user/repos", GITHUB_REST_API_ORIGIN);
      url.searchParams.set("affiliation", "owner");
      url.searchParams.set("sort", "full_name");
    } else {
      url = new URL(`/users/${encodeURIComponent(login)}/repos`, GITHUB_REST_API_ORIGIN);
      url.searchParams.set("type", "owner");
      url.searchParams.set("sort", "full_name");
    }
    url.searchParams.set("per_page", limit);
    url.searchParams.set("page", page);
    const result = await this.request(toolName, null, url, { method: "GET" }, true);
    const items = filter ? objectRecord(result.payload).items : result.payload;
    if (!Array.isArray(items))
      throw new GitHubRestProviderError("GitHub returned an invalid list response");
    return resultEnvelope(
      {
        owner: { login, type: organization ? "Organization" : "User" },
        repositories: items.map(projectListedRepository),
        page: Number(page),
        hasMore: items.length === Number(limit),
        ...(filter ? { totalCount: outputInteger(objectRecord(result.payload).total_count) } : {}),
      },
      result,
    );
  }

  private async workflowRunsList(repository: GitHubRestRepository, args: Record<string, unknown>) {
    const workflow = optionalString(args.workflow, "workflow", 256);
    if (workflow !== undefined && !/^(?:\d+|[A-Za-z0-9_.-]+\.ya?ml)$/u.test(workflow)) {
      throw new GitHubRestInputError("workflow must be a workflow file name or numeric id");
    }
    const url = new URL(
      workflow
        ? `/repos/${repository.fullName}/actions/workflows/${encodeURIComponent(workflow)}/runs`
        : `/repos/${repository.fullName}/actions/runs`,
      GITHUB_REST_API_ORIGIN,
    );
    url.searchParams.set(
      "per_page",
      String(optionalPositiveInteger(args.limit, "limit", MAX_PAGE_SIZE) ?? 20),
    );
    url.searchParams.set("page", String(optionalPositiveInteger(args.page, "page", 100) ?? 1));
    const branch = optionalString(args.branch, "branch", 512);
    const event = optionalString(args.event, "event", 64);
    const status = optionalString(args.status, "status", 64);
    let headSha = optionalSha(args.headSha, "headSha");
    const pullNumber = optionalPositiveInteger(
      args.pullNumber,
      "pullNumber",
      Number.MAX_SAFE_INTEGER,
    );
    if (pullNumber !== undefined) {
      const pull = await this.request(
        "workflow_runs_list",
        repository,
        `/repos/${repository.fullName}/pulls/${pullNumber}`,
        { method: "GET" },
        true,
      );
      const sha = optionalOutputString(objectRecord(objectRecord(pull.payload).head).sha, 40);
      if (!sha) throw new GitHubRestProviderError("GitHub returned an invalid pull request");
      if (headSha && headSha !== sha.toLowerCase()) {
        throw new GitHubRestInputError("headSha is not the pull request's head commit");
      }
      headSha = sha.toLowerCase();
    }
    if (branch) url.searchParams.set("branch", branch);
    if (event) url.searchParams.set("event", event);
    if (status) url.searchParams.set("status", status);
    if (headSha) url.searchParams.set("head_sha", headSha);
    const result = await this.request(
      "workflow_runs_list",
      repository,
      url,
      { method: "GET" },
      true,
    );
    const payload = objectRecord(result.payload);
    if (!Array.isArray(payload.workflow_runs))
      throw new GitHubRestProviderError("GitHub returned an invalid list response");
    return resultEnvelope(
      {
        totalCount: outputInteger(payload.total_count),
        runs: payload.workflow_runs.map(projectWorkflowRun),
      },
      result,
    );
  }

  private async workflowRunGet(repository: GitHubRestRepository, args: Record<string, unknown>) {
    const runId = positiveInteger(args.runId, "runId");
    const attempt = optionalPositiveInteger(args.attempt, "attempt", 1_000);
    const run = await this.request(
      "workflow_run_get",
      repository,
      attempt
        ? `/repos/${repository.fullName}/actions/runs/${runId}/attempts/${attempt}`
        : `/repos/${repository.fullName}/actions/runs/${runId}`,
      { method: "GET" },
      true,
    );
    const jobsUrl = new URL(
      attempt
        ? `/repos/${repository.fullName}/actions/runs/${runId}/attempts/${attempt}/jobs`
        : `/repos/${repository.fullName}/actions/runs/${runId}/jobs`,
      GITHUB_REST_API_ORIGIN,
    );
    jobsUrl.searchParams.set("per_page", "100");
    if (!attempt) jobsUrl.searchParams.set("filter", "latest");
    const jobs = await this.request(
      "workflow_run_get",
      repository,
      jobsUrl,
      { method: "GET" },
      true,
    );
    const jobsPayload = objectRecord(jobs.payload);
    const jobList = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];
    return resultEnvelope(
      {
        run: projectWorkflowRun(run.payload),
        totalJobs: outputInteger(jobsPayload.total_count),
        jobs: jobList.slice(0, 100).map(projectWorkflowJob),
      },
      jobs,
    );
  }

  /**
   * GitHub answers a job log request with a redirect to short-lived signed
   * storage on another host. That URL is fetched without the GitHub
   * credential, and only a bounded window of the log is kept.
   */
  private async workflowJobLogs(repository: GitHubRestRepository, args: Record<string, unknown>) {
    const jobId = positiveInteger(args.jobId, "jobId");
    const offset =
      args.offset === undefined
        ? undefined
        : typeof args.offset === "number" && Number.isSafeInteger(args.offset) && args.offset >= 0
          ? args.offset
          : (() => {
              throw new GitHubRestInputError("offset is invalid");
            })();
    const maxBytes =
      args.maxBytes === undefined
        ? LOG_DEFAULT_BYTES
        : Math.max(1_024, optionalPositiveInteger(args.maxBytes, "maxBytes", LOG_MAX_BYTES)!);
    const url = new URL(
      `/repos/${repository.fullName}/actions/jobs/${jobId}/logs`,
      GITHUB_REST_API_ORIGIN,
    );
    const resolve = async (forceRefresh: boolean) =>
      await this.resolve("workflow_job_logs_get", repository, url, false, forceRefresh);
    const send = async (authority: GitHubRestResolvedAuthority): Promise<Response> => {
      await this.authorize(repository, authority);
      try {
        return await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "OpenGeni-GitHub-Bridge/1",
            ...authority.headers,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GitHubRestProviderError(`GitHub request failed: ${safeTransportMessage(error)}`);
      }
    };
    let authority = await resolve(false);
    let response = await send(authority);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      authority = await resolve(true);
      response = await send(authority);
    }
    const meta = {
      actor: authority.actor,
      requestId: safeHeader(response.headers.get("x-github-request-id"), 128),
      rateLimit: projectRateLimit(response.headers),
    };
    let logResponse = response;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      let target: URL;
      try {
        target = new URL(location ?? "", url);
      } catch {
        throw new GitHubRestProviderError("GitHub returned an invalid log location");
      }
      if (target.protocol !== "https:" || target.username || target.password) {
        throw new GitHubRestProviderError("GitHub returned an invalid log location");
      }
      try {
        // No GitHub credential and no GitHub headers on the storage host;
        // only the byte range wanted.
        logResponse = await this.fetchImpl(target, {
          method: "GET",
          redirect: "follow",
          headers: {
            "user-agent": "OpenGeni-GitHub-Bridge/1",
            range:
              offset === undefined
                ? `bytes=-${maxBytes}`
                : `bytes=${offset}-${offset + maxBytes - 1}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new GitHubRestProviderError(
          `GitHub log download failed: ${safeTransportMessage(error)}`,
        );
      }
    } else if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = await readResponseJsonBounded(response, 64 * 1024, "GitHub REST response");
      } catch {
        payload = null;
      }
      throw new GitHubRestProviderError(providerError(response.status, payload));
    }
    if (logResponse.status === 416) {
      // The offset is past the end of the log.
      await logResponse.body?.cancel().catch(() => undefined);
      const total = contentRangeTotal(logResponse.headers.get("content-range"));
      const at = offset ?? 0;
      return resultEnvelope(
        { jobId, text: "", startByte: at, endByte: at, totalBytes: total, nextOffset: null },
        meta,
      );
    }
    if (logResponse.status === 206 && logResponse.body) {
      const range = parseContentRange(logResponse.headers.get("content-range"));
      if (range) {
        const window = await readRangedLogWindow(logResponse.body, range, {
          tail: offset === undefined,
          maxBytes,
        });
        return resultEnvelope({ jobId, ...window }, meta);
      }
    }
    if (!logResponse.ok || !logResponse.body) {
      await logResponse.body?.cancel().catch(() => undefined);
      throw new GitHubRestProviderError(
        logResponse.status === 410 || logResponse.status === 404
          ? "This job's log is no longer available"
          : `GitHub log download failed (${logResponse.status})`,
      );
    }
    const window = await readLogWindow(logResponse.body, { offset, maxBytes });
    return resultEnvelope({ jobId, ...window }, meta);
  }

  private async get<T>(
    toolName: string,
    repository: GitHubRestRepository,
    path: string,
    project: (payload: unknown) => T,
  ): Promise<unknown> {
    const result = await this.request(toolName, repository, path, { method: "GET" }, true);
    return resultEnvelope(project(result.payload), result);
  }

  private async getList<T>(
    toolName: string,
    repository: GitHubRestRepository,
    path: string,
    args: Record<string, unknown>,
    project: (payload: unknown) => T,
    extra: Record<string, string> = {},
    include: (payload: unknown) => boolean = () => true,
  ): Promise<unknown> {
    const url = new URL(path, GITHUB_REST_API_ORIGIN);
    url.searchParams.set(
      "per_page",
      String(optionalPositiveInteger(args.limit, "limit", MAX_PAGE_SIZE) ?? 30),
    );
    url.searchParams.set("page", String(optionalPositiveInteger(args.page, "page", 100) ?? 1));
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    const result = await this.request(toolName, repository, url, { method: "GET" }, true);
    if (!Array.isArray(result.payload))
      throw new GitHubRestProviderError("GitHub returned an invalid list response");
    return resultEnvelope(result.payload.filter(include).map(project), result);
  }

  private async mutate<T>(
    toolName: string,
    repository: GitHubRestRepository,
    path: string,
    method: "POST" | "PATCH" | "PUT",
    body: Record<string, unknown>,
    project: (payload: unknown) => T,
  ): Promise<unknown> {
    if (repository.access !== "write") {
      throw new GitHubRestInputError("This repository was accepted with read-only authority");
    }
    const result = await this.request(
      toolName,
      repository,
      path,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      false,
    );
    return resultEnvelope(project(result.payload), result);
  }

  private async checksSummary(repository: GitHubRestRepository, args: Record<string, unknown>) {
    const ref = optionalString(args.ref, "ref", 512) ?? repository.defaultRef;
    const checks = await this.request(
      "checks_summary",
      repository,
      `/repos/${repository.fullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`,
      { method: "GET" },
      true,
    );
    const statuses = await this.request(
      "checks_summary",
      repository,
      `/repos/${repository.fullName}/commits/${encodeURIComponent(ref)}/status`,
      { method: "GET" },
      true,
    );
    const checkPayload = objectRecord(checks.payload);
    const statusPayload = objectRecord(statuses.payload);
    const checkRuns = Array.isArray(checkPayload.check_runs)
      ? checkPayload.check_runs.slice(0, 50).map(projectCheckRun)
      : [];
    const statusItems = Array.isArray(statusPayload.statuses)
      ? statusPayload.statuses.slice(0, 50).map(projectStatus)
      : [];
    return resultEnvelope(
      {
        ref,
        checkRuns,
        status: optionalOutputString(statusPayload.state, 64),
        statuses: statusItems,
      },
      statuses,
    );
  }

  private async codeSearch(repository: GitHubRestRepository, args: Record<string, unknown>) {
    const query = requiredString(args.query, "query", 512);
    if (/\brepo\s*:/iu.test(query))
      throw new GitHubRestInputError("Do not include a repo qualifier");
    const url = new URL("/search/code", GITHUB_REST_API_ORIGIN);
    url.searchParams.set("q", `${query} repo:${repository.fullName}`);
    url.searchParams.set(
      "per_page",
      String(optionalPositiveInteger(args.limit, "limit", 20) ?? 20),
    );
    url.searchParams.set("page", String(optionalPositiveInteger(args.page, "page", 10) ?? 1));
    const result = await this.request("code_search", repository, url, { method: "GET" }, true);
    const payload = objectRecord(result.payload);
    const items = Array.isArray(payload.items)
      ? payload.items.slice(0, 20).map(projectCodeSearch)
      : [];
    return resultEnvelope({ totalCount: outputInteger(payload.total_count), items }, result);
  }

  private async resolve(
    toolName: string,
    repository: GitHubRestRepository | null,
    url: URL,
    write: boolean,
    forceRefresh: boolean,
  ): Promise<GitHubRestResolvedAuthority> {
    assertGitHubDestination(url);
    if (repository) {
      return await this.options.resolveAuthority({
        serverId: this.options.serverId,
        toolName,
        destinationUrl: url.toString(),
        repository,
        write,
        forceRefresh,
      });
    }
    if (!this.options.account) {
      throw new GitHubRestInputError(`Unsupported GitHub tool: ${toolName}`);
    }
    return await this.options.account.resolveAuthority({
      serverId: this.options.serverId,
      toolName,
      destinationUrl: url.toString(),
      forceRefresh,
    });
  }

  private async authorize(
    repository: GitHubRestRepository | null,
    authority: GitHubRestResolvedAuthority,
  ): Promise<void> {
    assertResolvedAuthority(
      repository ?? {
        connectionId: this.options.account!.connectionId,
        authorityKind: this.options.authorityKind,
      },
      authority,
    );
    if (authority.authorizeProviderRequest && !(await authority.authorizeProviderRequest())) {
      throw new GitHubRestAuthorityError("GitHub repository authority is no longer current");
    }
  }

  private async request(
    toolName: string,
    repository: GitHubRestRepository | null,
    pathInput: string | URL,
    init: RequestInit,
    replaySafe: boolean,
  ): Promise<GitHubProviderResult> {
    const url = new URL(pathInput, GITHUB_REST_API_ORIGIN);
    assertGitHubDestination(url);
    const resolve = async (forceRefresh: boolean) =>
      await this.resolve(toolName, repository, url, !replaySafe, forceRefresh);
    const send = async (authority: GitHubRestResolvedAuthority): Promise<Response> => {
      await this.authorize(repository, authority);
      try {
        return await this.fetchImpl(url, {
          ...init,
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "OpenGeni-GitHub-Bridge/1",
            ...authority.headers,
            ...headersRecord(init.headers),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (!replaySafe) {
          throw new GitHubRestMutationOutcomeUnknownError(
            "GitHub mutation transport failed after submission; outcome is uncertain",
          );
        }
        throw new GitHubRestProviderError(`GitHub request failed: ${safeTransportMessage(error)}`);
      }
    };
    let authority = await resolve(false);
    let response = await send(authority);
    if (response.status === 401 && replaySafe) {
      await response.body?.cancel().catch(() => undefined);
      authority = await resolve(true);
      response = await send(authority);
    }
    let payload: unknown;
    try {
      payload = await readResponseJsonBounded(response, RESPONSE_MAX_BYTES, "GitHub REST response");
    } catch (error) {
      if (!replaySafe) {
        throw new GitHubRestMutationOutcomeUnknownError(
          "GitHub mutation returned an unreadable response; outcome is uncertain",
        );
      }
      throw new GitHubRestProviderError(
        `GitHub returned an unreadable response (${response.status}): ${safeErrorMessage(error)}`,
      );
    }
    if (!response.ok) {
      if (!replaySafe) {
        throw new GitHubRestMutationOutcomeUnknownError(
          `GitHub mutation returned HTTP ${response.status}; outcome is uncertain`,
        );
      }
      throw new GitHubRestProviderError(providerError(response.status, payload));
    }
    return {
      payload,
      actor: authority.actor,
      requestId: safeHeader(response.headers.get("x-github-request-id"), 128),
      rateLimit: projectRateLimit(response.headers),
    };
  }
}

type GitHubProviderResult = {
  payload: unknown;
  actor: GitHubRestResolvedAuthority["actor"];
  requestId: string | null;
  rateLimit: ReturnType<typeof projectRateLimit>;
};

export class GitHubRestInputError extends Error {}
export class GitHubRestAuthorityError extends Error {}
/**
 * The repository was removed from the chat. Its tools refuse it and
 * `repositories_list` leaves it out instead of failing the whole listing.
 */
export class GitHubRestRepositoryDetachedError extends GitHubRestAuthorityError {}
export class GitHubRestProviderError extends Error {}
export class GitHubRestMutationNotExecutedError extends Error {
  readonly connectorActionOutcome = "not_executed" as const;
}
export class GitHubRestMutationOutcomeUnknownError extends Error {
  readonly connectorActionOutcome = "uncertain" as const;
}

export function githubRestConnectorActionOutcome(
  output: unknown,
): "not_executed" | "uncertain" | null {
  const row = objectRecord(output);
  const outcome = objectRecord(row._meta)[CONNECTOR_OUTCOME_META_KEY];
  if (outcome === "not_executed" || outcome === "uncertain") return outcome;
  return row.isError === true ? "not_executed" : null;
}

function connectorErrorResult(
  error: GitHubRestMutationNotExecutedError | GitHubRestMutationOutcomeUnknownError,
  outcome: "not_executed" | "uncertain",
) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error.message.slice(0, 1_024),
        _meta: { [CONNECTOR_OUTCOME_META_KEY]: outcome },
      },
    ],
    _meta: { [CONNECTOR_OUTCOME_META_KEY]: outcome },
  };
}

function githubDescriptor(
  adapterId: string,
  authority: "host" | "connection",
): LocalMcpBridgeDescriptor {
  return defineLocalMcpBridgeDescriptor({
    adapterId,
    providerId: "github",
    catalogIdentity: "api:github-app",
    authority,
    toolSurface: "static_reviewed",
    mutationReplay: "safe_reads_only",
    destinations: [{ origin: GITHUB_REST_API_ORIGIN, pathPrefix: "/" }],
  });
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = name === "repositories_list" ? [] : ["repository"],
): GitHubTool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  } as GitHubTool;
}

function mutationTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): GitHubTool {
  return {
    ...tool(
      name,
      `${description} This external write follows the task's GitHub action policy.`,
      properties,
      required,
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  } as GitHubTool;
}

function destructiveMutationTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): GitHubTool {
  const entry = mutationTool(name, description, properties, required);
  return {
    ...entry,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  } as GitHubTool;
}

function repositoryProperties() {
  return {
    repository: stringProperty("Exact owner/name from repositories_list.", 256),
  };
}
function stringProperty(description: string, maxLength: number) {
  return { type: "string", minLength: 1, maxLength, description };
}
function stringArrayProperty(maxItems: number, maxLength: number) {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}
function integer(minimum: number, maximum: number) {
  return { type: "integer", minimum, maximum };
}
function enumProperty(values: readonly string[]) {
  return { type: "string", enum: [...values] };
}

function assertRepository(
  repository: GitHubRestRepository,
  authorityKind: GitHubRestAuthorityKind,
) {
  if (
    repository.authorityKind !== authorityKind ||
    !/^[1-9]\d*$/u.test(repository.repositoryId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.fullName) ||
    repository.canonicalUrl !== `https://github.com/${repository.fullName}` ||
    !repository.defaultRef ||
    !repository.connectionId
  ) {
    throw new Error("GitHub REST bridge repository authority is invalid");
  }
}

function assertGitHubDestination(url: URL) {
  if (
    url.protocol !== "https:" ||
    url.origin !== GITHUB_REST_API_ORIGIN ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new GitHubRestAuthorityError("GitHub REST destination binding mismatch");
  }
}

function requiredString(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GitHubRestInputError(`${name} is invalid`);
  }
  return value;
}
function optionalString(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, name, max);
}
/** Markdown text such as a body or commit message: tabs and line breaks are kept. */
function requiredText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new GitHubRestInputError(`${name} is invalid`);
  }
  return value;
}
function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, max);
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new GitHubRestInputError(`${name} is invalid`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new GitHubRestInputError(`${name} is invalid`);
  return value;
}
function optionalPositiveInteger(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = positiveInteger(value, name);
  if (parsed > max) throw new GitHubRestInputError(`${name} is invalid`);
  return parsed;
}
function optionalEnum<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new GitHubRestInputError(`${name} is invalid`);
  return value as T;
}
function requiredEnum<T extends string>(value: unknown, name: string, values: readonly T[]): T {
  const parsed = optionalEnum(value, name, values);
  if (parsed === undefined) throw new GitHubRestInputError(`${name} is invalid`);
  return parsed;
}
function optionalStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems)
    throw new GitHubRestInputError(`${name} is invalid`);
  return value.map((entry) => requiredString(entry, name, maxLength));
}
function requiredBranchRef(value: unknown): string {
  const ref = requiredString(value, "ref", 512);
  if (!ref.startsWith("refs/heads/") || ref.includes("..") || ref.endsWith("/"))
    throw new GitHubRestInputError("ref must be a new refs/heads/* ref");
  return ref;
}
function requiredSha(value: unknown): string {
  const sha = requiredString(value, "sha", 40);
  if (!/^[0-9a-f]{40}$/iu.test(sha))
    throw new GitHubRestInputError("sha must be an exact commit SHA");
  return sha.toLowerCase();
}
function optionalSha(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const sha = requiredString(value, name, 40);
  if (!/^[0-9a-f]{40}$/iu.test(sha))
    throw new GitHubRestInputError(`${name} must be an exact commit SHA`);
  return sha.toLowerCase();
}
function repositoryPath(value: string): string {
  const parts = value.split("/");
  if (value.startsWith("/") || parts.some((part) => !part || part === "." || part === ".."))
    throw new GitHubRestInputError("path must be repository-relative");
  return value;
}
function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
function encodeGitRef(ref: string): string {
  const normalized = ref.replace(/^refs\//u, "");
  if (!normalized || normalized.includes("..")) throw new GitHubRestInputError("ref is invalid");
  return normalized.split("/").map(encodeURIComponent).join("/");
}
function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
function requireMutationFields(input: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(input).length === 0)
    throw new GitHubRestInputError("At least one update field is required");
  return input;
}
function reviewSubmissionBody(args: Record<string, unknown>): Record<string, unknown> {
  const event = requiredEnum(args.event, "event", ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
  const body = optionalText(args.body, "body", MAX_TEXT);
  if ((event === "COMMENT" || event === "REQUEST_CHANGES") && !body) {
    throw new GitHubRestInputError(`body is required when event is ${event}`);
  }
  return compact({
    event,
    body,
    commit_id: optionalSha(args.commitId, "commitId"),
  });
}
function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}
function safeIdentity(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 128) || "github";
}
function safeHeader(value: string | null, max: number): string | null {
  return value && value.length <= max && /^[\x20-\x7e]+$/u.test(value) ? value : null;
}
function projectRateLimit(headers: Headers) {
  return {
    limit: safeRateInteger(headers.get("x-ratelimit-limit")),
    remaining: safeRateInteger(headers.get("x-ratelimit-remaining")),
    used: safeRateInteger(headers.get("x-ratelimit-used")),
    resetAt: rateReset(headers.get("x-ratelimit-reset")),
    resource: safeHeader(headers.get("x-ratelimit-resource"), 64),
  };
}
function safeRateInteger(value: string | null): number | null {
  if (!value || !/^\d{1,12}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function rateReset(value: string | null): string | null {
  const seconds = safeRateInteger(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function resultEnvelope(
  data: unknown,
  result: Pick<GitHubProviderResult, "actor" | "requestId" | "rateLimit">,
) {
  return {
    data,
    attribution: result.actor,
    provider: { requestId: result.requestId, rateLimit: result.rateLimit },
  };
}
function projectAcceptedRepository(
  repository: GitHubRestRepository,
  actor: GitHubRestResolvedAuthority["actor"],
) {
  return {
    repositoryId: repository.repositoryId,
    fullName: repository.fullName,
    canonicalUrl: repository.canonicalUrl,
    defaultRef: repository.defaultRef,
    access: repository.access,
    attribution: actor,
  };
}

function assertResolvedAuthority(
  repository: Pick<GitHubRestRepository, "connectionId" | "authorityKind">,
  authority: GitHubRestResolvedAuthority,
): void {
  if (authority.connectionId !== repository.connectionId) {
    throw new GitHubRestAuthorityError("GitHub authority identity changed");
  }
  if (authority.actor.kind !== repository.authorityKind) {
    throw new GitHubRestAuthorityError("GitHub actor authority changed");
  }
}
function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function outputInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function optionalOutputString(value: unknown, max = 8_192): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}
function projectUser(value: unknown) {
  const row = objectRecord(value);
  return {
    id: outputInteger(row.id),
    login: optionalOutputString(row.login, 128),
    type: optionalOutputString(row.type, 64),
  };
}
function projectRepository(value: unknown) {
  const row = objectRecord(value);
  return {
    id: outputInteger(row.id),
    fullName: optionalOutputString(row.full_name, 256),
    private: row.private === true,
    archived: row.archived === true,
    defaultBranch: optionalOutputString(row.default_branch, 512),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
    permissions: projectPermissions(row.permissions),
    owner: projectUser(row.owner),
  };
}
function projectPermissions(value: unknown) {
  const row = objectRecord(value);
  return {
    pull: row.pull === true,
    triage: row.triage === true,
    push: row.push === true,
    maintain: row.maintain === true,
    admin: row.admin === true,
  };
}
function projectBranch(value: unknown) {
  const row = objectRecord(value);
  const commit = objectRecord(row.commit);
  return {
    name: optionalOutputString(row.name, 512),
    protected: row.protected === true,
    commitSha: optionalOutputString(commit.sha, 40),
  };
}
function projectRef(value: unknown) {
  const row = objectRecord(value);
  const object = objectRecord(row.object);
  return {
    ref: optionalOutputString(row.ref, 512),
    nodeId: optionalOutputString(row.node_id, 256),
    object: {
      type: optionalOutputString(object.type, 64),
      sha: optionalOutputString(object.sha, 40),
      url: optionalOutputString(object.url, 1_024),
    },
  };
}
function projectContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 1_000).map(projectContent);
  const row = objectRecord(value);
  return {
    type: optionalOutputString(row.type, 64),
    name: optionalOutputString(row.name, 512),
    path: optionalOutputString(row.path, 4_096),
    sha: optionalOutputString(row.sha, 40),
    size: outputInteger(row.size),
    encoding: optionalOutputString(row.encoding, 64),
    content: optionalOutputString(row.content, 768 * 1024),
    downloadUrl: null,
    htmlUrl: optionalOutputString(row.html_url, 1_024),
  };
}
function projectIssue(value: unknown) {
  const row = objectRecord(value);
  return {
    id: outputInteger(row.id),
    number: outputInteger(row.number),
    title: optionalOutputString(row.title, 512),
    body: optionalOutputString(row.body, MAX_TEXT),
    state: optionalOutputString(row.state, 64),
    locked: row.locked === true,
    author: projectUser(row.user),
    assignees: Array.isArray(row.assignees) ? row.assignees.slice(0, 50).map(projectUser) : [],
    labels: Array.isArray(row.labels)
      ? row.labels
          .slice(0, 50)
          .map((label) =>
            typeof label === "string"
              ? label.slice(0, 128)
              : optionalOutputString(objectRecord(label).name, 128),
          )
      : [],
    comments: outputInteger(row.comments),
    createdAt: optionalOutputString(row.created_at, 64),
    updatedAt: optionalOutputString(row.updated_at, 64),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
  };
}
function projectPullRequest(value: unknown) {
  const row = objectRecord(value);
  const head = objectRecord(row.head);
  const base = objectRecord(row.base);
  return {
    id: outputInteger(row.id),
    number: outputInteger(row.number),
    title: optionalOutputString(row.title, 512),
    body: optionalOutputString(row.body, MAX_TEXT),
    state: optionalOutputString(row.state, 64),
    draft: row.draft === true,
    merged: row.merged === true,
    mergeable: typeof row.mergeable === "boolean" ? row.mergeable : null,
    author: projectUser(row.user),
    head: {
      ref: optionalOutputString(head.ref, 512),
      sha: optionalOutputString(head.sha, 40),
    },
    base: {
      ref: optionalOutputString(base.ref, 512),
      sha: optionalOutputString(base.sha, 40),
    },
    requestedReviewers: Array.isArray(row.requested_reviewers)
      ? row.requested_reviewers.slice(0, 50).map(projectUser)
      : [],
    createdAt: optionalOutputString(row.created_at, 64),
    updatedAt: optionalOutputString(row.updated_at, 64),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
  };
}
function projectComment(value: unknown) {
  const row = objectRecord(value);
  return {
    id: outputInteger(row.id),
    body: optionalOutputString(row.body, MAX_TEXT),
    author: projectUser(row.user),
    createdAt: optionalOutputString(row.created_at, 64),
    updatedAt: optionalOutputString(row.updated_at, 64),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
  };
}
function projectReviewRequest(value: unknown) {
  const row = objectRecord(value);
  return {
    requestedReviewers: Array.isArray(row.requested_reviewers)
      ? row.requested_reviewers.slice(0, 50).map(projectUser)
      : [],
    requestedTeams: Array.isArray(row.requested_teams)
      ? row.requested_teams.slice(0, 50).map((team) => ({
          id: outputInteger(objectRecord(team).id),
          slug: optionalOutputString(objectRecord(team).slug, 128),
        }))
      : [],
  };
}
function projectReview(value: unknown) {
  const row = objectRecord(value);
  return {
    id: outputInteger(row.id),
    state: optionalOutputString(row.state, 64),
    body: optionalOutputString(row.body, MAX_TEXT),
    commitId: optionalOutputString(row.commit_id, 40),
    author: projectUser(row.user),
    submittedAt: optionalOutputString(row.submitted_at, 64),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
  };
}
function projectMerge(value: unknown) {
  const row = objectRecord(value);
  return {
    sha: optionalOutputString(row.sha, 40),
    merged: row.merged === true,
    message: optionalOutputString(row.message, 512),
  };
}
function projectCheckRun(value: unknown) {
  const row = objectRecord(value);
  const app = objectRecord(row.app);
  return {
    id: outputInteger(row.id),
    name: optionalOutputString(row.name, 256),
    status: optionalOutputString(row.status, 64),
    conclusion: optionalOutputString(row.conclusion, 64),
    startedAt: optionalOutputString(row.started_at, 64),
    completedAt: optionalOutputString(row.completed_at, 64),
    app: {
      id: outputInteger(app.id),
      slug: optionalOutputString(app.slug, 128),
    },
    htmlUrl: optionalOutputString(row.html_url, 1_024),
  };
}
function projectStatus(value: unknown) {
  const row = objectRecord(value);
  return {
    id: outputInteger(row.id),
    state: optionalOutputString(row.state, 64),
    context: optionalOutputString(row.context, 256),
    description: optionalOutputString(row.description, 512),
    targetUrl: optionalOutputString(row.target_url, 1_024),
    creator: projectUser(row.creator),
    createdAt: optionalOutputString(row.created_at, 64),
  };
}
function projectCodeSearch(value: unknown) {
  const row = objectRecord(value);
  const repository = objectRecord(row.repository);
  return {
    name: optionalOutputString(row.name, 512),
    path: optionalOutputString(row.path, 4_096),
    sha: optionalOutputString(row.sha, 40),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
    repository: {
      id: outputInteger(repository.id),
      fullName: optionalOutputString(repository.full_name, 256),
    },
  };
}
function projectListedRepository(value: unknown) {
  const row = objectRecord(value);
  return {
    ...projectRepository(value),
    description: optionalOutputString(row.description, 512),
    visibility: optionalOutputString(row.visibility, 32),
    pushedAt: optionalOutputString(row.pushed_at, 64),
  };
}
function projectWorkflowRun(value: unknown) {
  const row = objectRecord(value);
  const pullRequests = Array.isArray(row.pull_requests) ? row.pull_requests : [];
  return {
    id: outputInteger(row.id),
    name: optionalOutputString(row.name, 256),
    displayTitle: optionalOutputString(row.display_title, 512),
    workflowId: outputInteger(row.workflow_id),
    path: optionalOutputString(row.path, 512),
    event: optionalOutputString(row.event, 64),
    status: optionalOutputString(row.status, 64),
    conclusion: optionalOutputString(row.conclusion, 64),
    headBranch: optionalOutputString(row.head_branch, 512),
    headSha: optionalOutputString(row.head_sha, 40),
    runNumber: outputInteger(row.run_number),
    runAttempt: outputInteger(row.run_attempt),
    createdAt: optionalOutputString(row.created_at, 64),
    updatedAt: optionalOutputString(row.updated_at, 64),
    runStartedAt: optionalOutputString(row.run_started_at, 64),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
    actor: projectUser(row.actor),
    pullRequests: pullRequests
      .slice(0, 20)
      .map((entry) => outputInteger(objectRecord(entry).number))
      .filter((entry): entry is number => entry !== null),
  };
}
function projectWorkflowJob(value: unknown) {
  const row = objectRecord(value);
  const steps = Array.isArray(row.steps) ? row.steps : [];
  return {
    id: outputInteger(row.id),
    name: optionalOutputString(row.name, 256),
    status: optionalOutputString(row.status, 64),
    conclusion: optionalOutputString(row.conclusion, 64),
    startedAt: optionalOutputString(row.started_at, 64),
    completedAt: optionalOutputString(row.completed_at, 64),
    runAttempt: outputInteger(row.run_attempt),
    runnerName: optionalOutputString(row.runner_name, 256),
    htmlUrl: optionalOutputString(row.html_url, 1_024),
    steps: steps.slice(0, 200).map((step) => {
      const entry = objectRecord(step);
      return {
        number: outputInteger(entry.number),
        name: optionalOutputString(entry.name, 256),
        status: optionalOutputString(entry.status, 64),
        conclusion: optionalOutputString(entry.conclusion, 64),
      };
    }),
  };
}

function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value?.trim() ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || end >= total)) return null;
  return { start, end, total };
}

function contentRangeTotal(value: string | null): number | null {
  const match = /^bytes \*\/(\d+)$/u.exec(value?.trim() ?? "");
  const total = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(total) ? total : null;
}

/** One ranged response (206) as a log window; a tail starts on a whole line. */
export async function readRangedLogWindow(
  body: ReadableStream<Uint8Array>,
  range: { start: number; end: number; total: number | null },
  options: { tail: boolean; maxBytes: number },
): Promise<{
  text: string;
  startByte: number;
  endByte: number;
  totalBytes: number | null;
  nextOffset: number | null;
}> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  const limit = Math.min(options.maxBytes, range.end - range.start + 1);
  try {
    while (kept < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = value.subarray(0, limit - kept);
      chunks.push(piece);
      kept += piece.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  let bytes = new Uint8Array(kept);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  let startByte = range.start;
  if (options.tail && startByte > 0) {
    const newline = bytes.indexOf(10);
    if (newline >= 0 && newline < bytes.byteLength - 1) {
      bytes = bytes.subarray(newline + 1);
      startByte += newline + 1;
    }
  }
  const endByte = startByte + bytes.byteLength;
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    startByte,
    endByte,
    totalBytes: range.total,
    nextOffset: range.total === null || endByte < range.total ? endByte : null,
  };
}

/**
 * Keep one window of a streamed log: `maxBytes` from `offset`, or the last
 * `maxBytes` when no offset is given. Stops reading after LOG_SCAN_MAX_BYTES,
 * and keeps what it has when the stream fails part way.
 */
export async function readLogWindow(
  body: ReadableStream<Uint8Array>,
  options: { offset?: number | undefined; maxBytes: number; scanMaxBytes?: number },
): Promise<{
  text: string;
  startByte: number;
  endByte: number;
  /** Null when the log is longer than one read scans. */
  totalBytes: number | null;
  nextOffset: number | null;
}> {
  const scanMax = options.scanMaxBytes ?? LOG_SCAN_MAX_BYTES;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let seen = 0;
  let complete = false;
  const tail = options.offset === undefined;
  const start = options.offset ?? 0;
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        if (seen === 0) throw error;
        break;
      }
      const { done, value } = next;
      if (done) {
        complete = true;
        break;
      }
      const chunkStart = seen;
      seen += value.byteLength;
      if (tail) {
        chunks.push(value);
        kept += value.byteLength;
        while (chunks.length > 1 && kept - chunks[0]!.byteLength >= options.maxBytes) {
          kept -= chunks.shift()!.byteLength;
        }
      } else if (seen > start && kept < options.maxBytes) {
        const from = Math.max(0, start - chunkStart);
        const piece = value.subarray(from, from + options.maxBytes - kept);
        chunks.push(piece);
        kept += piece.byteLength;
      }
      if (!tail && kept >= options.maxBytes) break;
      if (seen >= scanMax) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(kept);
  let position = 0;
  for (const chunk of chunks) {
    joined.set(chunk, position);
    position += chunk.byteLength;
  }
  let bytes = joined;
  let startByte = tail ? seen - kept : Math.min(start, seen);
  if (tail && bytes.byteLength > options.maxBytes) {
    const cut = bytes.byteLength - options.maxBytes;
    bytes = bytes.subarray(cut);
    startByte += cut;
  }
  if (tail && startByte > 0) {
    // Start on a whole line.
    const newline = bytes.indexOf(10);
    if (newline >= 0 && newline < bytes.byteLength - 1) {
      bytes = bytes.subarray(newline + 1);
      startByte += newline + 1;
    }
  }
  const endByte = startByte + bytes.byteLength;
  // An offset past what one read scans cannot page forward from here.
  const more = (!complete || endByte < seen) && (tail || endByte > start);
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
    startByte,
    endByte,
    totalBytes: complete ? seen : null,
    nextOffset: more ? endByte : null,
  };
}

function providerError(status: number, payload: unknown): string {
  const message = optionalOutputString(objectRecord(payload).message, 512);
  return message
    ? `GitHub request failed (${status}): ${message}`
    : `GitHub request failed (${status})`;
}
function safeTransportMessage(error: unknown): string {
  return error instanceof Error && /^(AbortError|TimeoutError)$/u.test(error.name)
    ? "request timed out"
    : "provider transport unavailable";
}
function safeErrorMessage(error: unknown): string {
  if (
    error instanceof GitHubRestInputError ||
    error instanceof GitHubRestAuthorityError ||
    error instanceof GitHubRestProviderError
  )
    return error.message.slice(0, 1_024);
  return "GitHub request failed";
}
