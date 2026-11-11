/**
 * Classifies GitHub REST and GraphQL requests that `gh` sends through the
 * personal GitHub gateway, so one GitHub action policy covers the
 * `github_personal` tools and `gh` alike.
 *
 * Reads pass. Ordinary writes follow the policy of the matching action
 * (`issue_create`, `pull_request_merge`, ...), or the strictest policy of the
 * routine group when no single action matches. Destructive or hard-to-undo
 * requests, and writes this module does not recognise, are `sensitive`: they
 * also follow the person's Settings and deletions policy, which asks unless
 * the person chose otherwise.
 * Force-updating or deleting a branch other than the repository's default
 * branch follows the `ref_create` policy once the gateway has confirmed the
 * branch (see `refRewrites`).
 */

export const GITHUB_GATEWAY_ROUTINE_TOOLS = [
  "ref_create",
  "issue_create",
  "issue_update",
  "issue_comment",
  "pull_request_create",
  "pull_request_update",
  "pull_request_comment",
  "pull_request_request_review",
] as const;

export type GitHubGatewayRepositoryRef =
  | { kind: "name"; owner: string; name: string }
  | { kind: "id"; id: string };

/**
 * A ref a request force-updates or deletes: a full ref name (`refs/heads/x`)
 * in the request's repository or in a GraphQL repository node, or a GraphQL
 * Ref node.
 */
export type GitHubGatewayRefTarget =
  | { kind: "name"; ref: string; repositoryNodeId?: string }
  | { kind: "node"; refNodeId: string };

export type GitHubGatewayAction =
  | { kind: "read"; title: string }
  | {
      kind: "write";
      /** Policy actions whose strictest decision applies. */
      tools: readonly string[];
      /**
       * Also apply the person's Settings and deletions policy (Ask unless
       * they chose otherwise); the strictest decision wins.
       */
      sensitive: boolean;
      /**
       * The gateway can't confirm which repositories this changes, so the
       * repository allowlist can't apply: it asks whatever the policy says
       * (Block still wins). Always also sensitive.
       */
      unscoped?: true;
      title: string;
      /**
       * Force updates and deletions of these refs. They set `sensitive`; the
       * gateway lowers it to `sensitiveOtherwise` only after confirming that
       * every ref is a branch other than the repository's default branch.
       */
      refRewrites?: { targets: GitHubGatewayRefTarget[]; sensitiveOtherwise: boolean };
    };

export type GitHubRestClassification = {
  action: GitHubGatewayAction;
  repository: GitHubGatewayRepositoryRef | null;
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function write(tools: readonly string[], title: string, sensitive = false): GitHubGatewayAction {
  return { kind: "write", tools, sensitive, title };
}

function routine(title: string): GitHubGatewayAction {
  return write(GITHUB_GATEWAY_ROUTINE_TOOLS, title);
}

function sensitive(title: string, tools: readonly string[] = []): GitHubGatewayAction {
  return write(tools, title, true);
}

/** A write the repository allowlist can't cover: see `unscoped`. */
export function unscopedWrite(action: GitHubGatewayAction): GitHubGatewayAction {
  if (action.kind !== "write") return action;
  const { refRewrites: _ignored, ...rest } = action;
  return { ...rest, sensitive: true, unscoped: true };
}

/**
 * Force-updating or deleting `ref` follows the person's policy when it is a
 * branch other than the repository's default branch. Tags, other refs, the
 * default branch, and an unknown default branch are sensitive (Settings and deletions).
 */
export function refRewriteFollowsPolicy(ref: string, defaultBranch: string | null): boolean {
  if (!defaultBranch || !ref.startsWith("refs/heads/")) return false;
  const branch = ref.slice("refs/heads/".length);
  return (
    branch.length > 0 &&
    branch.split("/").every((part) => part.length > 0 && !part.startsWith(".")) &&
    !branch.includes("..") &&
    // `%`: a name the gateway couldn't decode could reach GitHub as another ref.
    !/[\u0000-\u0020\u007f~^:?*[\\%]/u.test(branch) &&
    branch.toLowerCase() !== defaultBranch.toLowerCase()
  );
}

/**
 * A force update or deletion of the ref at `refs/{refPath}`. Only a path
 * under `heads/` can follow the person's branch policy; any other path is
 * sensitive. `gh` encodes the slashes of a ref (`heads%2Fmy%2Fbranch`), so
 * one segment can hold the whole path.
 */
function refRewrite(title: string, refPath: string[]): GitHubGatewayAction {
  const path = refPath.join("/");
  const action: Extract<GitHubGatewayAction, { kind: "write" }> = {
    kind: "write",
    tools: ["ref_create"],
    sensitive: true,
    title,
  };
  if (path.startsWith("heads/")) {
    action.refRewrites = {
      targets: [{ kind: "name", ref: `refs/${path}` }],
      sensitiveOtherwise: false,
    };
  }
  return action;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Path segments of a REST path, without the GitHub Enterprise `/api/v3` prefix. */
export function githubRestPathSegments(pathname: string): string[] {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] === "api" && segments[1] === "v3") segments.splice(0, 2);
  return segments.map(decodeSegment);
}

/** Repository-scoped tail: what follows `/repos/{owner}/{repo}` or `/repositories/{id}`. */
function repositoryScope(segments: string[]): {
  repository: GitHubGatewayRepositoryRef;
  rest: string[];
} | null {
  if (segments[0] === "repos" && segments.length >= 3) {
    return {
      repository: { kind: "name", owner: segments[1]!, name: segments[2]! },
      rest: segments.slice(3),
    };
  }
  if (segments[0] === "repositories" && segments.length >= 2 && /^\d+$/u.test(segments[1]!)) {
    return { repository: { kind: "id", id: segments[1]! }, rest: segments.slice(2) };
  }
  return null;
}

/** Repository paths that change settings, access or secrets: sensitive (Settings and deletions). */
const SENSITIVE_REPOSITORY_AREAS = new Set([
  "collaborators",
  "invitations",
  "hooks",
  "keys",
  "secrets",
  "variables",
  "environments",
  "rulesets",
  "pages",
  "teams",
  "topics",
  "properties",
  "autolinks",
  "transfer",
  "vulnerability-alerts",
  "automated-security-fixes",
  "private-vulnerability-reporting",
  "interaction-limits",
  "lfs",
  "dependabot",
  "codespaces",
  "code-scanning",
  "secret-scanning",
  "security-advisories",
  "deployment_protection_rules",
  "immutable-releases",
  "custom-properties",
]);

function classifyRepositoryWrite(
  method: string,
  rest: string[],
  body: unknown,
): GitHubGatewayAction {
  const [area, id, sub, subId, leaf] = rest;
  if (rest.length === 0) {
    return method === "DELETE"
      ? sensitive("Delete repository")
      : sensitive("Change repository settings");
  }
  if (area && SENSITIVE_REPOSITORY_AREAS.has(area)) {
    return sensitive(area === "transfer" ? "Transfer repository" : `Change repository ${area}`);
  }
  if (area === "actions") {
    // actions/{secrets,variables,permissions,runners,...} are settings.
    if (id === "runs" && sub) {
      if (method === "DELETE") return sensitive("Delete workflow run data");
      if (method === "POST" && (subId === "cancel" || subId === "force-cancel")) {
        return routine("Cancel workflow run");
      }
      if (method === "POST" && (subId === "rerun" || subId === "rerun-failed-jobs")) {
        return routine("Rerun workflow");
      }
      // Approving deployments or fork runs, protection rules: human gates.
      return sensitive(
        subId === "pending_deployments" ? "Approve deployment" : "Change workflow run",
      );
    }
    if (id === "jobs" && subId === "rerun" && method === "POST") {
      return routine("Rerun workflow job");
    }
    if (
      id === "workflows" &&
      sub &&
      (subId === "dispatches" || subId === "enable" || subId === "disable")
    ) {
      return routine(subId === "dispatches" ? "Run workflow" : `${capitalize(subId)} workflow`);
    }
    if (id === "caches" || method === "DELETE") return sensitive("Delete GitHub Actions data");
    return sensitive("Change GitHub Actions settings");
  }
  if (area === "branches") {
    // branches/{branch}/protection..., branches/{branch}/rename
    return sensitive("Change branch settings");
  }
  if (area === "dispatches") return routine("Trigger repository dispatch");
  if (area === "forks") return routine("Fork repository");
  if (area === "merges") return write(["pull_request_merge"], "Merge branch");
  if (area === "merge-upstream") return routine("Sync fork with upstream");
  if (area === "git") {
    if (id === "refs") {
      if (method === "POST" && sub === undefined)
        return write(["ref_create"], "Create branch or tag");
      if (method === "DELETE") return refRewrite("Delete branch or tag", rest.slice(2));
      if (method === "PATCH") {
        // `force` counts unless it is absent or exactly false.
        const force =
          body !== null &&
          typeof body === "object" &&
          Object.hasOwn(body, "force") &&
          (body as Record<string, unknown>).force !== false;
        return force ? refRewrite("Force-update branch", rest.slice(2)) : routine("Update branch");
      }
    }
    if (
      method === "POST" &&
      (id === "blobs" || id === "trees" || id === "commits" || id === "tags")
    ) {
      return routine("Create Git object");
    }
    return sensitive("Change Git data");
  }
  if (area === "contents") {
    return routine(method === "DELETE" ? "Commit a file deletion" : "Commit file changes");
  }
  if (area === "issues") {
    if (id === "comments") {
      if (subId === "reactions") {
        return method === "DELETE" ? routine("Remove reaction") : routine("Add reaction");
      }
      if (method === "PATCH") return write(["issue_comment"], "Edit comment");
      if (method === "DELETE") return sensitive("Delete comment", ["issue_comment"]);
    }
    if (id === undefined && method === "POST") return write(["issue_create"], "Create issue");
    if (id && /^\d+$/u.test(id)) {
      if (sub === undefined && method === "PATCH") {
        return write(["issue_update", "pull_request_update"], "Update issue or pull request");
      }
      if (sub === "comments" && method === "POST") {
        return write(["issue_comment", "pull_request_comment"], "Comment");
      }
      if (
        sub === "labels" ||
        sub === "assignees" ||
        sub === "lock" ||
        sub === "sub_issues" ||
        sub === "sub_issue" ||
        sub === "dependencies"
      ) {
        return write(["issue_update", "pull_request_update"], "Update issue or pull request");
      }
      if (sub === "reactions") {
        return method === "DELETE" ? routine("Remove reaction") : routine("Add reaction");
      }
    }
    if (method === "DELETE") return sensitive("Delete issue data");
    return sensitive("Change issues");
  }
  if (area === "pulls") {
    if (id === "comments") {
      if (subId === "reactions") {
        return method === "DELETE" ? routine("Remove reaction") : routine("Add reaction");
      }
      if (method === "PATCH") return write(["pull_request_comment"], "Edit review comment");
      if (method === "DELETE") return sensitive("Delete review comment", ["pull_request_comment"]);
    }
    if (id === undefined && method === "POST")
      return write(["pull_request_create"], "Open pull request");
    if (id && /^\d+$/u.test(id)) {
      if (sub === undefined && method === "PATCH")
        return write(["pull_request_update"], "Update pull request");
      if (sub === "update-branch")
        return write(["pull_request_update"], "Update pull request branch");
      if (sub === "merge" && method === "PUT")
        return write(["pull_request_merge"], "Merge pull request");
      if (sub === "requested_reviewers") {
        return write(["pull_request_request_review"], "Request review");
      }
      if (sub === "comments" && method === "POST")
        return write(["pull_request_comment"], "Comment on code");
      if (sub === "comments" && subId && leaf === "replies") {
        return write(["pull_request_comment"], "Reply to review comment");
      }
      if (sub === "reviews") {
        if (subId && leaf === "dismissals")
          return sensitive("Dismiss review", ["pull_request_review_submit"]);
        if (method === "DELETE") return routine("Delete pending review");
        return write(["pull_request_review_submit"], "Submit review");
      }
    }
    if (method === "DELETE") return sensitive("Delete pull request data");
    return sensitive("Change pull requests");
  }
  if (area === "releases") {
    if (id === "generate-notes" && method === "POST")
      return { kind: "read", title: "Generate release notes" };
    if (method === "DELETE")
      return sensitive(id === "assets" ? "Delete release asset" : "Delete release");
    return routine(id === undefined ? "Create release" : "Update release");
  }
  if (area === "labels" || area === "milestones") {
    return method === "DELETE"
      ? sensitive(`Delete ${area.slice(0, -1)}`)
      : routine(`Change ${area}`);
  }
  if (area === "comments" || area === "commits") {
    // Commit comments and their reactions.
    if (method === "DELETE" && !(sub === "reactions" || subId === "reactions")) {
      return sensitive("Delete commit comment");
    }
    return routine("Comment on commit");
  }
  if (area === "statuses" || area === "check-runs" || area === "check-suites") {
    return routine("Report commit status");
  }
  if (area === "deployments") {
    return method === "DELETE" ? sensitive("Delete deployment") : routine("Report deployment");
  }
  if (area === "subscription" || area === "notifications") return routine("Change notifications");
  return method === "DELETE" ? sensitive("Delete repository data") : sensitive("Change repository");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Classify one REST request (GraphQL is classified by {@link classifyGitHubGraphqlRequest}). */
export function classifyGitHubRestRequest(
  method: string,
  pathname: string,
  body: unknown,
): GitHubRestClassification {
  const normalizedMethod = method.toUpperCase();
  const segments = githubRestPathSegments(pathname);
  const scoped = repositoryScope(segments);
  if (READ_METHODS.has(normalizedMethod)) {
    return { action: { kind: "read", title: "Read" }, repository: scoped?.repository ?? null };
  }
  if (scoped) {
    return {
      action: classifyRepositoryWrite(normalizedMethod, scoped.rest, body),
      repository: scoped.repository,
    };
  }
  // Rendering Markdown changes nothing.
  if (normalizedMethod === "POST" && segments[0] === "markdown") {
    return { action: { kind: "read", title: "Render Markdown" }, repository: null };
  }
  if (segments[0] === "notifications") {
    return { action: routine("Change notifications"), repository: null };
  }
  // Account and organization writes name no repository the allowlist covers.
  return {
    action: unscopedWrite(
      sensitive(normalizedMethod === "DELETE" ? "Delete on GitHub" : "Change GitHub account data"),
    ),
    repository: null,
  };
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

/** GraphQL mutations mapped to policy actions. Anything not listed is sensitive (Settings and deletions). */
const GRAPHQL_MUTATIONS: Record<
  string,
  { tools: readonly string[]; title: string; sensitive?: true }
> = {
  createPullRequest: { tools: ["pull_request_create"], title: "Open pull request" },
  updatePullRequest: { tools: ["pull_request_update"], title: "Update pull request" },
  closePullRequest: { tools: ["pull_request_update"], title: "Close pull request" },
  reopenPullRequest: { tools: ["pull_request_update"], title: "Reopen pull request" },
  markPullRequestReadyForReview: { tools: ["pull_request_update"], title: "Mark ready for review" },
  convertPullRequestToDraft: { tools: ["pull_request_update"], title: "Convert to draft" },
  updatePullRequestBranch: { tools: ["pull_request_update"], title: "Update pull request branch" },
  revertPullRequest: { tools: ["pull_request_create"], title: "Revert pull request" },
  mergePullRequest: { tools: ["pull_request_merge"], title: "Merge pull request" },
  enablePullRequestAutoMerge: { tools: ["pull_request_merge"], title: "Enable auto-merge" },
  disablePullRequestAutoMerge: { tools: ["pull_request_merge"], title: "Disable auto-merge" },
  enqueuePullRequest: { tools: ["pull_request_merge"], title: "Add to merge queue" },
  dequeuePullRequest: { tools: ["pull_request_merge"], title: "Remove from merge queue" },
  addPullRequestReview: { tools: ["pull_request_review_submit"], title: "Submit review" },
  submitPullRequestReview: { tools: ["pull_request_review_submit"], title: "Submit review" },
  deletePullRequestReview: {
    tools: ["pull_request_review_submit"],
    title: "Delete pending review",
  },
  dismissPullRequestReview: {
    tools: ["pull_request_review_submit"],
    title: "Dismiss review",
    sensitive: true,
  },
  addPullRequestReviewComment: { tools: ["pull_request_comment"], title: "Comment on code" },
  addPullRequestReviewThread: { tools: ["pull_request_comment"], title: "Comment on code" },
  addPullRequestReviewThreadReply: { tools: ["pull_request_comment"], title: "Reply to review" },
  updatePullRequestReviewComment: { tools: ["pull_request_comment"], title: "Edit review comment" },
  resolveReviewThread: { tools: ["pull_request_comment"], title: "Resolve conversation" },
  unresolveReviewThread: { tools: ["pull_request_comment"], title: "Unresolve conversation" },
  requestReviews: { tools: ["pull_request_request_review"], title: "Request review" },
  requestReviewsByLogin: { tools: ["pull_request_request_review"], title: "Request review" },
  addComment: { tools: ["issue_comment", "pull_request_comment"], title: "Comment" },
  updateIssueComment: { tools: ["issue_comment", "pull_request_comment"], title: "Edit comment" },
  createIssue: { tools: ["issue_create"], title: "Create issue" },
  updateIssue: { tools: ["issue_update"], title: "Update issue" },
  closeIssue: { tools: ["issue_update"], title: "Close issue" },
  reopenIssue: { tools: ["issue_update"], title: "Reopen issue" },
  pinIssue: { tools: ["issue_update"], title: "Pin issue" },
  unpinIssue: { tools: ["issue_update"], title: "Unpin issue" },
  addSubIssue: { tools: ["issue_update"], title: "Add sub-issue" },
  removeSubIssue: { tools: ["issue_update"], title: "Remove sub-issue" },
  addLabelsToLabelable: { tools: ["issue_update", "pull_request_update"], title: "Add labels" },
  removeLabelsFromLabelable: {
    tools: ["issue_update", "pull_request_update"],
    title: "Remove labels",
  },
  clearLabelsFromLabelable: {
    tools: ["issue_update", "pull_request_update"],
    title: "Clear labels",
  },
  addAssigneesToAssignable: { tools: ["issue_update", "pull_request_update"], title: "Assign" },
  removeAssigneesFromAssignable: {
    tools: ["issue_update", "pull_request_update"],
    title: "Unassign",
  },
  replaceActorsForAssignable: { tools: ["issue_update", "pull_request_update"], title: "Assign" },
  lockLockable: { tools: ["issue_update", "pull_request_update"], title: "Lock conversation" },
  unlockLockable: { tools: ["issue_update", "pull_request_update"], title: "Unlock conversation" },
  createRef: { tools: ["ref_create"], title: "Create branch or tag" },
  createLinkedBranch: { tools: ["ref_create"], title: "Create branch" },
  createCommitOnBranch: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Commit to branch" },
  addReaction: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Add reaction" },
  removeReaction: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Remove reaction" },
  minimizeComment: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Hide comment" },
  unminimizeComment: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Unhide comment" },
  updateSubscription: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Change notifications" },
  markNotificationAsDone: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Change notifications" },
  markFileAsViewed: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Mark file as viewed" },
  unmarkFileAsViewed: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Mark file as viewed" },
  addStar: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Star repository" },
  removeStar: { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Unstar repository" },
  deleteIssue: { tools: ["issue_update"], title: "Delete issue", sensitive: true },
  deleteIssueComment: { tools: ["issue_comment"], title: "Delete comment", sensitive: true },
  deletePullRequestReviewComment: {
    tools: ["pull_request_comment"],
    title: "Delete review comment",
    sensitive: true,
  },
  transferIssue: { tools: ["issue_update"], title: "Transfer issue", sensitive: true },
};

export type GraphqlValue =
  | { kind: "variable"; name: string }
  | { kind: "scalar"; value: string | number | boolean | null }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: GraphqlValue[] }
  | { kind: "object"; fields: Record<string, GraphqlValue> };

type GraphqlField = {
  name: string;
  args: Record<string, GraphqlValue>;
  selections: GraphqlSelection[];
};

type GraphqlSelection =
  | { kind: "field"; field: GraphqlField }
  | { kind: "spread"; name: string }
  | { kind: "inline"; selections: GraphqlSelection[] };

type GraphqlOperation = {
  type: "query" | "mutation" | "subscription";
  name: string | null;
  selections: GraphqlSelection[];
  /** Variable defaults, which GitHub applies to variables the request omits. */
  variableDefaults: Record<string, GraphqlValue>;
};

type GraphqlDocument = {
  operations: GraphqlOperation[];
  fragments: Map<string, GraphqlSelection[]>;
};

type Token =
  | { kind: "punct"; value: string }
  | { kind: "name"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string };

const GRAPHQL_QUERY_MAX_BYTES = 256 * 1024;
const GRAPHQL_MAX_DEPTH = 64;

/**
 * A block string's value as GitHub reads it (GraphQL spec BlockStringValue):
 * the common indent of the lines after the first is removed, and blank first
 * and last lines are dropped.
 */
function blockStringValue(raw: string): string {
  const lines = raw.split(/\r\n|[\n\r]/u);
  let common: number | null = null;
  for (const line of lines.slice(1)) {
    const indent = /^[\t ]*/u.exec(line)![0].length;
    if (indent < line.length && (common === null || indent < common)) common = indent;
  }
  const dedented = lines.map((line, index) =>
    index > 0 && common !== null ? line.slice(common) : line,
  );
  const blank = (line: string) => /^[\t ]*$/u.test(line);
  while (dedented.length > 0 && blank(dedented[0]!)) dedented.shift();
  while (dedented.length > 0 && blank(dedented.at(-1)!)) dedented.pop();
  return dedented.join("\n");
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "#") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    if (/[\s,\uFEFF]/u.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith("...", index)) {
      tokens.push({ kind: "punct", value: "..." });
      index += 3;
      continue;
    }
    if ("!$&()[]{}:=@|".includes(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }
    if (source.startsWith('"""', index)) {
      // Escaped triple quotes (\""") do not end a block string.
      let close = source.indexOf('"""', index + 3);
      while (close >= 0 && source[close - 1] === "\\") close = source.indexOf('"""', close + 3);
      if (close < 0) throw new Error("Unterminated block string");
      tokens.push({
        kind: "string",
        value: blockStringValue(source.slice(index + 3, close).replace(/\\"""/gu, '"""')),
      });
      index = close + 3;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      let value = "";
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === "\n") throw new Error("Unterminated string");
        if (source[cursor] === "\\") {
          const escaped = source[cursor + 1];
          if (escaped === "u") {
            value += String.fromCharCode(Number.parseInt(source.slice(cursor + 2, cursor + 6), 16));
            cursor += 6;
            continue;
          }
          const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
          value += map[escaped ?? ""] ?? escaped ?? "";
          cursor += 2;
          continue;
        }
        value += source[cursor];
        cursor += 1;
      }
      if (cursor >= source.length) throw new Error("Unterminated string");
      tokens.push({ kind: "string", value });
      index = cursor + 1;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/u.exec(source.slice(index, index + 256));
    if (name) {
      tokens.push({ kind: "name", value: name[0] });
      index += name[0].length;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(source.slice(index, index + 64));
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    throw new Error(`Unexpected character in GraphQL document: ${char}`);
  }
  return tokens;
}

class GraphqlParser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error("Unexpected end of GraphQL document");
    this.index += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === "punct" && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== "punct" || token.value !== value) {
      throw new Error(`Expected ${value} in GraphQL document`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== "name") throw new Error("Expected a name in GraphQL document");
    return token.value;
  }

  parseDocument(): GraphqlDocument {
    const operations: GraphqlOperation[] = [];
    const fragments = new Map<string, GraphqlSelection[]>();
    while (this.peek()) {
      if (this.isPunct("{")) {
        operations.push({
          type: "query",
          name: null,
          selections: this.parseSelectionSet(0),
          variableDefaults: {},
        });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === "fragment") {
        const name = this.expectName();
        if (this.expectName() !== "on") throw new Error("Expected on in fragment");
        this.expectName();
        this.skipDirectives();
        fragments.set(name, this.parseSelectionSet(0));
        continue;
      }
      if (keyword !== "query" && keyword !== "mutation" && keyword !== "subscription") {
        throw new Error(`Unsupported GraphQL definition: ${keyword}`);
      }
      let name: string | null = null;
      if (this.peek()?.kind === "name") name = this.expectName();
      const variableDefaults = this.isPunct("(") ? this.parseVariableDefinitions() : {};
      this.skipDirectives();
      operations.push({
        type: keyword,
        name,
        selections: this.parseSelectionSet(0),
        variableDefaults,
      });
    }
    return { operations, fragments };
  }

  /** `($name: Type = default @directive, ...)`: the defaults by variable name. */
  private parseVariableDefinitions(): Record<string, GraphqlValue> {
    this.expectPunct("(");
    const defaults: Record<string, GraphqlValue> = {};
    while (!this.isPunct(")")) {
      this.expectPunct("$");
      const name = this.expectName();
      this.expectPunct(":");
      this.skipType(0);
      if (this.isPunct("=")) {
        this.next();
        defaults[name] = this.parseValue(1);
      }
      this.skipDirectives();
    }
    this.expectPunct(")");
    return defaults;
  }

  private skipType(depth: number): void {
    if (depth > GRAPHQL_MAX_DEPTH) throw new Error("GraphQL document is too deep");
    if (this.isPunct("[")) {
      this.next();
      this.skipType(depth + 1);
      this.expectPunct("]");
    } else {
      this.expectName();
    }
    if (this.isPunct("!")) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct("@")) {
      this.next();
      this.expectName();
      if (this.isPunct("(")) this.parseArguments(0);
    }
  }

  private parseSelectionSet(depth: number): GraphqlSelection[] {
    if (depth > GRAPHQL_MAX_DEPTH) throw new Error("GraphQL document is too deep");
    this.expectPunct("{");
    const selections: GraphqlSelection[] = [];
    while (!this.isPunct("}")) {
      if (this.isPunct("...")) {
        this.next();
        const token = this.peek();
        if (token?.kind === "name" && token.value !== "on") {
          selections.push({ kind: "spread", name: this.expectName() });
          this.skipDirectives();
          continue;
        }
        if (token?.kind === "name" && token.value === "on") {
          this.next();
          this.expectName();
        }
        this.skipDirectives();
        selections.push({ kind: "inline", selections: this.parseSelectionSet(depth + 1) });
        continue;
      }
      let name = this.expectName();
      if (this.isPunct(":")) {
        this.next();
        name = this.expectName();
      }
      const args = this.isPunct("(") ? this.parseArguments(depth) : {};
      this.skipDirectives();
      const children = this.isPunct("{") ? this.parseSelectionSet(depth + 1) : [];
      selections.push({ kind: "field", field: { name, args, selections: children } });
    }
    this.expectPunct("}");
    return selections;
  }

  private parseArguments(depth: number): Record<string, GraphqlValue> {
    this.expectPunct("(");
    const args: Record<string, GraphqlValue> = {};
    while (!this.isPunct(")")) {
      const name = this.expectName();
      this.expectPunct(":");
      args[name] = this.parseValue(depth + 1);
    }
    this.expectPunct(")");
    return args;
  }

  private parseValue(depth: number): GraphqlValue {
    if (depth > GRAPHQL_MAX_DEPTH) throw new Error("GraphQL document is too deep");
    const token = this.next();
    if (token.kind === "punct" && token.value === "$") {
      return { kind: "variable", name: this.expectName() };
    }
    if (token.kind === "string") return { kind: "scalar", value: token.value };
    if (token.kind === "number") return { kind: "scalar", value: Number(token.value) };
    if (token.kind === "name") {
      if (token.value === "true" || token.value === "false") {
        return { kind: "scalar", value: token.value === "true" };
      }
      if (token.value === "null") return { kind: "scalar", value: null };
      return { kind: "enum", value: token.value };
    }
    if (token.kind === "punct" && token.value === "[") {
      const values: GraphqlValue[] = [];
      while (!this.isPunct("]")) values.push(this.parseValue(depth + 1));
      this.next();
      return { kind: "list", values };
    }
    if (token.kind === "punct" && token.value === "{") {
      const fields: Record<string, GraphqlValue> = {};
      while (!this.isPunct("}")) {
        const name = this.expectName();
        this.expectPunct(":");
        fields[name] = this.parseValue(depth + 1);
      }
      this.next();
      return { kind: "object", fields };
    }
    throw new Error("Unexpected GraphQL value");
  }
}

/** Resolve a parsed argument value against the request variables into plain JSON. */
function resolveValue(value: GraphqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case "variable":
      return variables[value.name];
    case "scalar":
      return value.value;
    case "enum":
      return value.value;
    case "list":
      return value.values.map((item) => resolveValue(item, variables));
    case "object":
      return Object.fromEntries(
        Object.entries(value.fields).map(([key, item]) => [key, resolveValue(item, variables)]),
      );
  }
}

const GITHUB_REPOSITORY_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,100})\/([A-Za-z0-9._-]{1,100})(?:[/?#]|$)/iu;

/** First path segments of github.com URLs that are not repository owners. */
const GITHUB_RESERVED_OWNERS = new Set([
  "orgs",
  "users",
  "enterprises",
  "settings",
  "apps",
  "marketplace",
  "sponsors",
  "topics",
  "collections",
  "search",
  "notifications",
  "login",
  "features",
]);

/**
 * Repositories a mutation's input names directly rather than by node ID:
 * `repositoryNameWithOwner` (createCommitOnBranch) and github.com URLs
 * (addSubIssue's `subIssueUrl`, ...).
 */
function collectNamedRepositories(
  value: unknown,
  into: Map<string, { owner: string; name: string }>,
  key: string | null = null,
  depth = 0,
): void {
  if (depth > GRAPHQL_MAX_DEPTH || into.size > GRAPHQL_NODE_IDS_MAX) return;
  if (typeof value === "string") {
    let owner: string | undefined;
    let name: string | undefined;
    if (key === "repositoryNameWithOwner" && /^[^/\s]+\/[^/\s]+$/u.test(value)) {
      [owner, name] = value.split("/") as [string, string];
    } else if (key !== null && /url$/iu.test(key)) {
      // URL-typed inputs only (`subIssueUrl`), never free text such as a body.
      const match = GITHUB_REPOSITORY_URL.exec(value);
      if (match && !GITHUB_RESERVED_OWNERS.has(match[1]!.toLowerCase())) {
        [owner, name] = [match[1]!, match[2]!.replace(/\.git$/iu, "")];
      }
    }
    if (owner && name) into.set(`${owner}/${name}`.toLowerCase(), { owner, name });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedRepositories(item, into, key, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) {
      collectNamedRepositories(item, into, childKey, depth + 1);
    }
  }
}

/** Mutations that act on the person's own account, not on a repository. */
const ACCOUNT_LEVEL_MUTATIONS = new Set([
  "addStar",
  "removeStar",
  "markNotificationAsDone",
  "updateSubscription",
]);

/**
 * Strings in a mutation's input that look like GitHub global node IDs
 * (`PR_kwDO…`, `I_kwDO…`, legacy base64 `MDEx…`). The gateway resolves them
 * to their repositories before the mutation runs.
 */
function collectNodeIds(value: unknown, into: Set<string>, depth = 0): void {
  // One past the limit, so a request with too many IDs is seen as such.
  if (depth > GRAPHQL_MAX_DEPTH || into.size > GRAPHQL_NODE_IDS_MAX) return;
  if (typeof value === "string") {
    if (looksLikeGitHubNodeId(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNodeIds(item, into, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNodeIds(item, into, depth + 1);
  }
}

export const GRAPHQL_NODE_IDS_MAX = 50;

/**
 * Input keys GitHub type-checks as node IDs (`subjectId`, `labelIds`, `id`),
 * so a value there can only name what that argument acts on. Free text such
 * as `clientMutationId` can't scope a mutation.
 */
function isNodeIdKey(key: string | null): boolean {
  return (
    key !== null &&
    key !== "clientMutationId" &&
    (key === "id" || key === "ids" || /[a-z](?:Id|Ids)$/u.test(key))
  );
}

/** Input keys that name the repository a mutation acts on. */
const REPOSITORY_NAMING_KEYS = new Set(["repositoryNameWithOwner", "subIssueUrl"]);

/**
 * The targets that scope one mutation: node IDs under ID-typed keys, and
 * whether a repository-naming key names a repository.
 */
function collectScopeTargets(
  value: unknown,
  into: { nodeIds: Set<string>; namesRepository: boolean; unreadableId: boolean },
  key: string | null = null,
  depth = 0,
): void {
  if (depth > GRAPHQL_MAX_DEPTH || into.nodeIds.size > GRAPHQL_NODE_IDS_MAX) return;
  if (typeof value === "string") {
    if (isNodeIdKey(key) && value !== "") {
      // A value GitHub might read as an ID that the gateway can't: unscoped.
      if (looksLikeGitHubNodeId(value)) into.nodeIds.add(value);
      else into.unreadableId = true;
    }
    if (key !== null && REPOSITORY_NAMING_KEYS.has(key)) {
      const named = new Map<string, { owner: string; name: string }>();
      collectNamedRepositories(value, named, key);
      if (named.size > 0) into.namesRepository = true;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScopeTargets(item, into, key, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [child, item] of Object.entries(value)) {
      collectScopeTargets(item, into, child, depth + 1);
    }
  }
}

export function looksLikeGitHubNodeId(value: string): boolean {
  return (
    value.length <= 128 &&
    (/^[A-Z][A-Za-z]{0,7}_[A-Za-z0-9_-]{8,}$/u.test(value) ||
      /^MD[A-Za-z0-9+/]{6,}={0,2}$/u.test(value))
  );
}

export type GitHubGraphqlClassification = {
  action: GitHubGatewayAction;
  /**
   * `repository(owner:, name:)` references found anywhere in the operation,
   * also under `organization`/`user`/`repositoryOwner(login:)`. A null owner
   * means the signed-in person (`viewer { repository(name:) }`).
   */
  repositories: Array<{ owner: string | null; name: string }>;
  /** Repositories a mutation's input names directly; checked for write. */
  mutationRepositories: Array<{ owner: string; name: string }>;
  /** Every mutation acts on the person's account only (stars, notifications). */
  accountLevel: boolean;
  /** Node IDs a mutation acts on; resolved to repositories before it runs. */
  nodeIds: string[];
  /**
   * Each top-level mutation with the targets its own input names. A write is
   * scoped only when every mutation that isn't account-level names a
   * repository of its own, so bundling a mutation on an allowed repository
   * can't vouch for another one (an organization or project write).
   */
  fields: GitHubGraphqlMutationField[];
  /** Top-level mutation fields, for the approval card. */
  mutations: string[];
};

export type GitHubGraphqlMutationField = {
  name: string;
  /** Node IDs in this mutation's input. */
  nodeIds: string[];
  /** Its input names a repository directly (`repositoryNameWithOwner`, a URL). */
  namesRepository: boolean;
  /** An ID-typed input holds a value the gateway can't read as a node ID. */
  unreadableId: boolean;
  /** It acts on the person's account only (stars, notifications). */
  accountLevel: boolean;
  /** Unrecognised, or mapped as sensitive: any node outside a repository leaves it unscoped. */
  sensitive: boolean;
};

/**
 * Classify one GraphQL request body (`{query, variables, operationName}`).
 * A document this parser cannot read is treated as an unknown mutation.
 */
export function classifyGitHubGraphqlRequest(body: unknown): GitHubGraphqlClassification {
  const unknown = (title: string): GitHubGraphqlClassification => ({
    action: unscopedWrite(sensitive(title)),
    repositories: [],
    mutationRepositories: [],
    accountLevel: false,
    nodeIds: [],
    fields: [],
    mutations: [],
  });
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return unknown("Unrecognised GitHub GraphQL request");
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== "string" || Buffer.byteLength(query, "utf8") > GRAPHQL_QUERY_MAX_BYTES) {
    return unknown("Unrecognised GitHub GraphQL request");
  }
  const requestVariables =
    record.variables && typeof record.variables === "object" && !Array.isArray(record.variables)
      ? (record.variables as Record<string, unknown>)
      : {};
  let document: GraphqlDocument;
  try {
    document = new GraphqlParser(tokenize(query)).parseDocument();
  } catch {
    return unknown("Unrecognised GitHub GraphQL request");
  }
  const operationName = typeof record.operationName === "string" ? record.operationName : null;
  const operation = operationName
    ? document.operations.find((candidate) => candidate.name === operationName)
    : document.operations.length === 1
      ? document.operations[0]
      : undefined;
  if (!operation) return unknown("Unrecognised GitHub GraphQL request");
  // GitHub uses a variable's default when the request omits it.
  const variables: Record<string, unknown> = { ...requestVariables };
  for (const [name, value] of Object.entries(operation.variableDefaults)) {
    if (!Object.hasOwn(requestVariables, name)) variables[name] = resolveValue(value, {});
  }

  const repositories: Array<{ owner: string | null; name: string }> = [];
  // `owner` is the login of an enclosing organization/user/repositoryOwner
  // (null for viewer), so `repository(name:)` under it is scoped too. A
  // fragment is visited once per owner context.
  const visitedFragments = new Set<string>();
  // Anything nested past the limit is unread, so the request is unrecognised.
  let tooDeep = false;
  const visit = (
    selections: GraphqlSelection[],
    depth: number,
    owner: string | null | undefined,
  ) => {
    if (depth > GRAPHQL_MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    for (const selection of selections) {
      if (selection.kind === "spread") {
        const key = `${selection.name}\u0000${owner === undefined ? "" : (owner ?? "@viewer")}`;
        if (visitedFragments.has(key)) continue;
        visitedFragments.add(key);
        visit(document.fragments.get(selection.name) ?? [], depth + 1, owner);
        continue;
      }
      if (selection.kind === "inline") {
        visit(selection.selections, depth + 1, owner);
        continue;
      }
      const { field } = selection;
      let childOwner = owner;
      if (
        (field.name === "organization" ||
          field.name === "user" ||
          field.name === "repositoryOwner") &&
        field.args.login
      ) {
        const login = resolveValue(field.args.login, variables);
        childOwner = typeof login === "string" ? login : undefined;
      } else if (field.name === "viewer") {
        childOwner = null;
      } else if (field.name === "repository" && field.args.name) {
        const name = resolveValue(field.args.name, variables);
        const explicitOwner = field.args.owner
          ? resolveValue(field.args.owner, variables)
          : undefined;
        const repositoryOwner = typeof explicitOwner === "string" ? explicitOwner : owner;
        if (typeof name === "string" && repositoryOwner !== undefined) {
          repositories.push({ owner: repositoryOwner, name });
        }
        childOwner = undefined;
      }
      visit(field.selections, depth + 1, childOwner);
    }
  };
  visit(operation.selections, 0, undefined);
  if (tooDeep) return unknown("Unrecognised GitHub GraphQL request");

  if (operation.type !== "mutation") {
    return {
      action: { kind: "read", title: "Read" },
      repositories,
      mutationRepositories: [],
      accountLevel: false,
      nodeIds: [],
      fields: [],
      mutations: [],
    };
  }

  const topLevel: GraphqlField[] = [];
  const expanded = new Set<string>();
  const collectTopLevel = (selections: GraphqlSelection[], depth: number) => {
    if (depth > GRAPHQL_MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    for (const selection of selections) {
      if (selection.kind === "field") topLevel.push(selection.field);
      else if (selection.kind === "inline") collectTopLevel(selection.selections, depth + 1);
      else if (!expanded.has(selection.name)) {
        expanded.add(selection.name);
        collectTopLevel(document.fragments.get(selection.name) ?? [], depth + 1);
      }
    }
  };
  collectTopLevel(operation.selections, 0);
  if (tooDeep) return unknown("Unrecognised GitHub GraphQL request");
  const mutations = topLevel.map((field) => field.name).filter((name) => name !== "__typename");
  if (mutations.length === 0) return unknown("Unrecognised GitHub GraphQL request");

  const tools = new Set<string>();
  let anySensitive = false;
  const titles: string[] = [];
  const nodeIds = new Set<string>();
  const named = new Map<string, { owner: string; name: string }>();
  const fields: GitHubGraphqlMutationField[] = [];
  // Force updates and deletions: they ask unless the gateway confirms every
  // ref is a branch other than the default branch.
  const rewriteTargets: GitHubGatewayRefTarget[] = [];
  let unknownRewrite = false;
  for (const field of topLevel) {
    if (field.name === "__typename") continue;
    const args = Object.fromEntries(
      Object.entries(field.args).map(([key, value]) => [key, resolveValue(value, variables)]),
    );
    // Every ID and repository found is checked; only typed targets scope it.
    collectNodeIds(args, nodeIds);
    collectNamedRepositories(args, named);
    const scope = { nodeIds: new Set<string>(), namesRepository: false, unreadableId: false };
    collectScopeTargets(args, scope);
    const fieldTargets = {
      name: field.name,
      nodeIds: [...scope.nodeIds],
      namesRepository: scope.namesRepository,
      unreadableId: scope.unreadableId,
      accountLevel: ACCOUNT_LEVEL_MUTATIONS.has(field.name),
    };
    let mapped = GRAPHQL_MUTATIONS[field.name];
    const input =
      args.input !== null && typeof args.input === "object" && !Array.isArray(args.input)
        ? (args.input as Record<string, unknown>)
        : undefined;
    // `force` counts unless it is exactly false, and an input the gateway
    // can't read is treated as a rewrite it can't confirm.
    const forced = (update: Record<string, unknown> | undefined) =>
      update === undefined || (Object.hasOwn(update, "force") && update.force !== false);
    if (field.name === "deleteRef" || field.name === "updateRef") {
      const rewrite = field.name === "deleteRef" || forced(input);
      if (rewrite) {
        if (typeof input?.refId === "string") {
          rewriteTargets.push({ kind: "node", refNodeId: input.refId });
        } else {
          unknownRewrite = true;
        }
      }
      mapped =
        field.name === "deleteRef"
          ? { tools: ["ref_create"], title: "Delete branch or tag" }
          : rewrite
            ? { tools: ["ref_create"], title: "Force-update branch" }
            : { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Update branch" };
    } else if (field.name === "updateRefs") {
      const updates = Array.isArray(input?.refUpdates) ? input.refUpdates : [input];
      const records = updates.map((update) =>
        update !== null && typeof update === "object" ? (update as Record<string, unknown>) : {},
      );
      // A ref whose `afterOid` is all zeros is deleted.
      const deletes = (update: Record<string, unknown>) =>
        typeof update.afterOid !== "string" || /^0+$/u.test(update.afterOid);
      const rewrites = records.filter((update) => deletes(update) || forced(update));
      for (const update of rewrites) {
        if (typeof update.name === "string" && typeof input?.repositoryId === "string") {
          rewriteTargets.push({
            kind: "name",
            ref: update.name,
            repositoryNodeId: input.repositoryId,
          });
        } else {
          unknownRewrite = true;
        }
      }
      mapped = records.some(deletes)
        ? { tools: ["ref_create"], title: "Delete branch or tag" }
        : rewrites.length > 0
          ? { tools: ["ref_create"], title: "Force-update branch" }
          : { tools: GITHUB_GATEWAY_ROUTINE_TOOLS, title: "Update branch" };
    }
    if (!mapped) {
      anySensitive = true;
      titles.push(`GitHub ${field.name}`);
      fields.push({ ...fieldTargets, sensitive: true });
      continue;
    }
    fields.push({ ...fieldTargets, sensitive: mapped.sensitive === true });
    for (const tool of mapped.tools) tools.add(tool);
    if (mapped.sensitive) anySensitive = true;
    titles.push(mapped.title);
  }
  const action = write(
    [...tools],
    [...new Set(titles)].join(", ").slice(0, 200),
    anySensitive || unknownRewrite || rewriteTargets.length > 0,
  );
  const confirmed =
    rewriteTargets.length > 0 && !unknownRewrite && action.kind === "write"
      ? { ...action, refRewrites: { targets: rewriteTargets, sensitiveOtherwise: anySensitive } }
      : action;
  return {
    // Too many named repositories to check: ask.
    action: named.size > GRAPHQL_NODE_IDS_MAX ? unscopedWrite(action) : confirmed,
    repositories,
    mutationRepositories: [...named.values()],
    accountLevel: mutations.every((name) => ACCOUNT_LEVEL_MUTATIONS.has(name)),
    nodeIds: [...nodeIds],
    fields,
    mutations,
  };
}
