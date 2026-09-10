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
  repositories: readonly GitHubRestRepository[];
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
    if (options.repositories.length === 0 || options.repositories.length > 100) {
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
    return GITHUB_REST_MCP_TOOLS.map((entry) => ({ ...entry }));
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
        const authority = await this.options.resolveAuthority({
          serverId: this.options.serverId,
          toolName,
          destinationUrl: `${GITHUB_REST_API_ORIGIN}/repos/${repository.fullName}`,
          repository,
          write: false,
          forceRefresh: false,
        });
        assertResolvedAuthority(repository, authority);
        if (authority.authorizeProviderRequest && !(await authority.authorizeProviderRequest())) {
          throw new GitHubRestAuthorityError("GitHub repository authority is no longer current");
        }
        repositories.push(projectAcceptedRepository(repository, authority.actor));
      }
      return { repositories };
    }
    const repository = this.repository(args.repository);
    switch (toolName) {
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
            body: optionalString(args.body, "body", MAX_TEXT),
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
              body: optionalString(args.body, "body", MAX_TEXT),
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
            body: requiredString(args.body, "body", MAX_TEXT),
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
            body: optionalString(args.body, "body", MAX_TEXT),
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
              body: optionalString(args.body, "body", MAX_TEXT),
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
            body: requiredString(args.body, "body", MAX_TEXT),
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
            commit_message: optionalString(args.commitMessage, "commitMessage", MAX_TEXT),
          }),
          projectMerge,
        );
    }
  }

  private repository(value: unknown): GitHubRestRepository {
    const fullName = requiredString(value, "repository", 256).toLowerCase();
    const repository = this.repositoriesByName.get(fullName);
    if (!repository)
      throw new GitHubRestInputError("Repository is outside the accepted GitHub resource set");
    return repository;
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

  private async request(
    toolName: string,
    repository: GitHubRestRepository,
    pathInput: string | URL,
    init: RequestInit,
    replaySafe: boolean,
  ): Promise<GitHubProviderResult> {
    const url = new URL(pathInput, GITHUB_REST_API_ORIGIN);
    assertGitHubDestination(url);
    const resolve = async (forceRefresh: boolean) =>
      await this.options.resolveAuthority({
        serverId: this.options.serverId,
        toolName,
        destinationUrl: url.toString(),
        repository,
        write: !replaySafe,
        forceRefresh,
      });
    const send = async (authority: GitHubRestResolvedAuthority): Promise<Response> => {
      assertResolvedAuthority(repository, authority);
      if (authority.authorizeProviderRequest && !(await authority.authorizeProviderRequest())) {
        throw new GitHubRestAuthorityError("GitHub repository authority is no longer current");
      }
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
  const body = optionalString(args.body, "body", MAX_TEXT);
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
  repository: GitHubRestRepository,
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
