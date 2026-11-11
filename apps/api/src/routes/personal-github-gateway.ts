import {
  PERSONAL_GITHUB_API_ORIGIN,
  PERSONAL_GITHUB_RECONNECT_MESSAGE,
  type PersonalGitHubConnectionMetadata,
  type PersonalGitHubRepositoryAccess,
  type PersonalGitHubRepositorySelectionState,
} from "@opengeni/contracts/personal-github";
import {
  findSessionRemovedRepository,
  type McpPersonalConnectionDelegation,
  type SessionRemovedRepository,
} from "@opengeni/contracts";
import {
  personalGitHubRepositoryAuthority,
  personalGitHubRepositoryDenialMessage,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getSessionGitHubGatewayState } from "@opengeni/db";
import {
  openPersonalGitHubGitBrokerClaims,
  type PersonalGitHubGitBrokerClaims,
} from "@opengeni/github";
import type { Hono } from "hono";
import {
  classifyGitHubGraphqlRequest,
  classifyGitHubRestRequest,
  GRAPHQL_NODE_IDS_MAX,
  refRewriteFollowsPolicy,
  unscopedWrite,
  type GitHubGatewayAction,
  type GitHubGatewayRepositoryRef,
} from "../integrations/github-gateway-requests";
import {
  assertCurrentPersonalGitHubConnection,
  authorizePersonalGitHubProviderRequest,
  BrokerProviderUnavailableError,
  BrokerReconnectRequiredError,
  fetchLiveGitHubJson,
  handlePersonalGitHubGitBrokerRequest,
  personalGitHubPushPolicyServices,
  resolvePersonalGitHubPassTurn,
  BrokerForbiddenError,
  type BrokerAuthority,
  type PersonalGitHubGitBrokerServices,
} from "./personal-github-git-broker";
import {
  databaseGatewayCompleter,
  databaseGatewayDecider,
  readBodyPrefix,
  requestDigest,
  type GatewayCompleter,
  type GatewayDecider,
  type GatewayDecisionIdentity,
} from "./personal-github-gateway-policy";

/**
 * The personal GitHub gateway: `gh` in a sandbox reaches GitHub as the person
 * through these routes. The sandbox holds only the session's short-lived
 * broker pass; the person's token is added here, per request, after the
 * pass, the connection, the repository allowlist and the GitHub action policy
 * are checked again.
 */
export const PERSONAL_GITHUB_GATEWAY_PATH_PREFIX = "/v1/github/personal/gateway/";

const GATEWAY_API_BODY_MAX_BYTES = 32 * 1024 * 1024;
const GATEWAY_AUTHORIZATION_MAX_BYTES = 8 * 1024;
const GITHUB_UPLOADS_ORIGIN = "https://uploads.github.com";

type GatewayTarget = "api" | "uploads";

export type PersonalGitHubGatewayAuthority = {
  claims: PersonalGitHubGitBrokerClaims;
  identity: GatewayDecisionIdentity;
  providerPrincipalId: string;
  metadata: PersonalGitHubConnectionMetadata;
  selection: PersonalGitHubRepositorySelectionState;
  removedRepositories: SessionRemovedRepository[];
};

export type PersonalGitHubGatewayServices = {
  openClaims: (token: string) => PersonalGitHubGitBrokerClaims | null;
  /** The pass's turn, connection and session, all still current. Throws otherwise. */
  resolveAuthority: (
    claims: PersonalGitHubGitBrokerClaims,
  ) => Promise<PersonalGitHubGatewayAuthority>;
  /**
   * The `Authorization` header for one physical GitHub request, after the
   * authority (and `repositories` at `access`) was checked again.
   */
  authorizeProviderRequest: (
    authority: PersonalGitHubGatewayAuthority,
    destinationUrl: string,
    toolName: string,
    repositories: GatewayRepositoryCheck[],
    /**
     * The write went through only because every repository was allowed for
     * writing; the re-check refuses it if that is no longer so.
     */
    options?: { everyRepository?: boolean },
  ) => Promise<string>;
  decide: GatewayDecider;
  complete: GatewayCompleter;
  /** Git smart HTTP for `owner/name` routes (clones through `gh`). */
  git: PersonalGitHubGitBrokerServices;
  fetch: typeof fetch;
  /** Repository default branches, looked up with the person's token. */
  defaultBranches?: DefaultBranchCache;
};

/** Default branch by connection and repository, kept for a minute. */
export type DefaultBranchCache = Map<string, { branch: string; expiresAt: number }>;

const DEFAULT_BRANCH_TTL_MS = 60_000;
const DEFAULT_BRANCH_CACHE_MAX = 1_000;

export type GatewayRepositoryCheck = {
  repository: GitHubGatewayRepositoryRef;
  access: PersonalGitHubRepositoryAccess;
};

export function registerPersonalGitHubGatewayRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  services = personalGitHubGatewayServices(deps),
): void {
  for (const target of ["api", "uploads"] as const) {
    const prefix = `${PERSONAL_GITHUB_GATEWAY_PATH_PREFIX}${target}`;
    app.all(prefix, (c) => handlePersonalGitHubGatewayRequest(c.req.raw, target, services));
    app.all(`${prefix}/*`, (c) => handlePersonalGitHubGatewayRequest(c.req.raw, target, services));
  }
  const git = `${PERSONAL_GITHUB_GATEWAY_PATH_PREFIX}git/:owner/:repo`;
  const routeKey = (owner: string, repo: string) => `${owner}/${repo.replace(/\.git$/u, "")}`;
  app.get(`${git}/info/refs`, (c) =>
    handlePersonalGitHubGitBrokerRequest(
      c.req.raw,
      routeKey(c.req.param("owner"), c.req.param("repo")),
      "info_refs",
      services.git,
    ),
  );
  for (const [suffix, operation] of [
    ["git-upload-pack", "upload_pack"],
    ["git-receive-pack", "receive_pack"],
  ] as const) {
    app.post(`${git}/${suffix}`, (c) =>
      handlePersonalGitHubGitBrokerRequest(
        c.req.raw,
        routeKey(c.req.param("owner"), c.req.param("repo")),
        operation,
        services.git,
      ),
    );
  }
}

/** Gateway routes stream their own bounded bodies. */
export function isPersonalGitHubGatewayRequest(pathname: string): boolean {
  return pathname.startsWith(PERSONAL_GITHUB_GATEWAY_PATH_PREFIX);
}

function gatewayError(
  status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 502,
  message: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ message, documentation_url: "https://docs.github.com/rest" }),
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        ...extra,
      },
    },
  );
}

class GatewayRepositoryDeniedError extends BrokerForbiddenError {}

function authorityError(error: unknown): Response {
  if (error instanceof GatewayRepositoryDeniedError) return gatewayError(403, error.message);
  if (error instanceof BrokerReconnectRequiredError) {
    return gatewayError(403, PERSONAL_GITHUB_RECONNECT_MESSAGE);
  }
  if (error instanceof BrokerProviderUnavailableError) {
    return gatewayError(502, "GitHub is temporarily unavailable. Try again.");
  }
  return gatewayError(
    401,
    "GitHub access for this command is no longer current. Run it again in a new turn.",
  );
}

export function gatewayBearer(authorization: string | null): string | null {
  if (
    !authorization ||
    Buffer.byteLength(authorization, "utf8") > GATEWAY_AUTHORIZATION_MAX_BYTES
  ) {
    return null;
  }
  const match = /^(?:Bearer|token)\s+(\S+)$/iu.exec(authorization.trim());
  if (match) return match[1]!;
  if (!/^Basic\s+/iu.test(authorization)) return null;
  try {
    const decoded = Buffer.from(authorization.replace(/^Basic\s+/iu, ""), "base64").toString(
      "utf8",
    );
    const separator = decoded.indexOf(":");
    return separator >= 0 && decoded.length > separator + 1 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Repository allowlist
// ---------------------------------------------------------------------------

function repositoryLabel(repository: GitHubGatewayRepositoryRef): string {
  return repository.kind === "name"
    ? `${repository.owner}/${repository.name}`
    : `repository ${repository.id}`;
}

/**
 * May `gh` use this repository as the person at `access`? The person's
 * current Your GitHub choice decides (the listed repositories, or every
 * repository with All my repositories), minus repositories removed from
 * this chat. GitHub enforces the person's own permission on the request.
 */
export function gatewayRepositoryDecision(
  authority: Pick<PersonalGitHubGatewayAuthority, "selection" | "metadata" | "removedRepositories">,
  repository: GitHubGatewayRepositoryRef,
  access: PersonalGitHubRepositoryAccess,
): { allowed: true } | { allowed: false; message: string } {
  const label = repositoryLabel(repository);
  const selected = authority.selection.repositories.find((candidate) =>
    repository.kind === "id"
      ? candidate.repositoryId === repository.id
      : candidate.fullName.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase(),
  );
  const removed =
    repository.kind === "name"
      ? findSessionRemovedRepository(
          authority.removedRepositories,
          `https://github.com/${repository.owner}/${repository.name}`,
        )
      : selected
        ? (findSessionRemovedRepository(authority.removedRepositories, selected.canonicalUrl) ??
          findSessionRemovedRepository(
            authority.removedRepositories,
            `https://github.com/${selected.fullName}`,
          ))
        : null;
  if (removed) {
    return { allowed: false, message: `${label} was removed from this chat.` };
  }
  const decision = personalGitHubRepositoryAuthority({
    current: {
      ...authority.selection,
      allRepositoriesAccess: authority.selection.allRepositoriesAccess ?? null,
    },
    metadata: authority.metadata,
    repository:
      repository.kind === "id"
        ? { repositoryId: repository.id }
        : { fullName: `${repository.owner}/${repository.name}` },
    access,
  });
  if (decision.allowed) return { allowed: true };
  switch (decision.reason) {
    case "not_selected":
      return {
        allowed: false,
        message: `${label} is not one of the repositories the person allowed under Your GitHub.`,
      };
    case "read_denied":
      return { allowed: false, message: `You cannot read ${label} on GitHub.` };
    case "write_denied":
      return { allowed: false, message: `${label} may only be read as the person.` };
    default:
      return { allowed: false, message: personalGitHubRepositoryDenialMessage(decision.reason) };
  }
}

/** All my repositories with write access, and none removed from this chat. */
export function allowlistCoversEveryRepository(
  authority: Pick<PersonalGitHubGatewayAuthority, "selection" | "removedRepositories">,
): boolean {
  return (
    authority.selection.allRepositoriesAccess === "write" &&
    authority.removedRepositories.length === 0
  );
}

/**
 * Name the repositories a request addresses by ID (`/repositories/{id}`), so
 * the removed-from-chat check sees them. A selected repository is named from
 * the selection; with All my repositories GitHub names it.
 */
async function nameRepositoryIds(
  services: PersonalGitHubGatewayServices,
  authority: PersonalGitHubGatewayAuthority,
  checks: GatewayRepositoryCheck[],
): Promise<GatewayRepositoryCheck[]> {
  const named: GatewayRepositoryCheck[] = [];
  for (const check of checks) {
    const { repository } = check;
    if (repository.kind !== "id") {
      named.push(check);
      continue;
    }
    const selected = authority.selection.repositories.find(
      (candidate) => candidate.repositoryId === repository.id,
    );
    const fullName =
      selected?.fullName ?? (await githubRepositoryName(services, authority, repository.id));
    const [owner, name] = fullName?.split("/", 2) ?? [];
    named.push(owner && name ? { ...check, repository: { kind: "name", owner, name } } : check);
  }
  return named;
}

async function githubRepositoryName(
  services: PersonalGitHubGatewayServices,
  authority: PersonalGitHubGatewayAuthority,
  repositoryId: string,
): Promise<string | null> {
  if (!authority.selection.allRepositoriesAccess) return null;
  const url = new URL(`/repositories/${repositoryId}`, PERSONAL_GITHUB_API_ORIGIN);
  try {
    const authorization = await services.authorizeProviderRequest(
      authority,
      url.toString(),
      "github_read",
      [],
    );
    const payload = await fetchLiveGitHubJson(services.fetch, url, authorization);
    if (payload && typeof payload.full_name === "string" && payload.full_name.includes("/")) {
      return payload.full_name;
    }
  } catch {
    // Unnamed: refused below.
  }
  throw new GatewayRepositoryDeniedError(
    `Could not check repository ${repositoryId} on GitHub. Use its owner/name instead.`,
  );
}

function assertRepositories(
  authority: PersonalGitHubGatewayAuthority,
  checks: GatewayRepositoryCheck[],
): void {
  for (const check of checks) {
    const decision = gatewayRepositoryDecision(authority, check.repository, check.access);
    if (!decision.allowed) throw new GatewayRepositoryDeniedError(decision.message);
  }
}

// ---------------------------------------------------------------------------
// REST and GraphQL
// ---------------------------------------------------------------------------

/** Request headers `gh` sends that GitHub needs; nothing else is forwarded. */
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "x-github-api-version",
  "graphql-features",
  "time-zone",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "range",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "strict-transport-security",
]);

function upstreamHeaders(request: Request, authorization: string, streamed: boolean): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("authorization", authorization);
  headers.set("accept-encoding", "identity");
  // Release asset uploads need their length; the body streams through.
  const contentLength = request.headers.get("content-length");
  if (streamed && contentLength && /^\d+$/u.test(contentLength)) {
    headers.set("content-length", contentLength);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", "Opengeni-GitHub-Gateway/1");
  return headers;
}

function downstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.set("cache-control", upstream.headers.get("cache-control") ?? "no-store");
  // Read by gh, never rendered: a browser that opens it gets inert bytes.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox; default-src 'none'");
  return headers;
}

function upstreamPath(request: Request, target: GatewayTarget): string | null {
  const url = new URL(request.url);
  const prefix = `${PERSONAL_GITHUB_GATEWAY_PATH_PREFIX}${target}`;
  if (!url.pathname.startsWith(prefix)) return null;
  let path = url.pathname.slice(prefix.length) || "/";
  // GitHub Enterprise-style `/api/v3/...` paths are accepted too.
  if (path === "/api/v3" || path.startsWith("/api/v3/")) path = path.slice("/api/v3".length) || "/";
  if (path === "/api/graphql") path = "/graphql";
  if (!path.startsWith("/") || path.startsWith("//") || /(?:^|\/)\.\.?(?:\/|$)/u.test(path)) {
    return null;
  }
  return `${path}${url.search}`;
}

function parseJsonBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const NON_REPOSITORY_NODE_TYPES = new Set([
  "User",
  "Organization",
  "Bot",
  "Mannequin",
  "Enterprise",
  "Team",
  "ProjectV2",
  "ProjectV2Item",
  "ProjectV2Field",
  "ProjectV2IterationField",
  "ProjectV2SingleSelectField",
  "ProjectV2View",
  "ProjectV2Workflow",
  "UserList",
  "Gist",
  "GistComment",
  "SponsorsListing",
  "Sponsorship",
]);

const NODE_REPOSITORIES_QUERY = `query OpengeniGatewayNodes($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Repository { nameWithOwner }
    ... on RepositoryNode { repository { nameWithOwner } }
    ... on Ref { repository { nameWithOwner } }
    ... on Commit { repository { nameWithOwner } }
    ... on Label { repository { nameWithOwner } }
    ... on Milestone { repository { nameWithOwner } }
    ... on PullRequestReviewThread { repository { nameWithOwner } }
    ... on Release { repository { nameWithOwner } }
    ... on Deployment { repository { nameWithOwner } }
  }
}`;

/**
 * What each of a GraphQL mutation's node IDs is: the repository it belongs to,
 * `"other"` for a node outside any repository (an organization, a project),
 * or `"unseen"` for one GitHub can't show the person. Null when they cannot
 * all be resolved (then the request asks the person).
 */
async function resolveNodeRepositories(
  services: PersonalGitHubGatewayServices,
  authority: PersonalGitHubGatewayAuthority,
  nodeIds: string[],
): Promise<Map<string, GitHubGatewayRepositoryRef | "other" | "unseen"> | null> {
  const resolved = new Map<string, GitHubGatewayRepositoryRef | "other" | "unseen">();
  if (nodeIds.length === 0) return resolved;
  if (nodeIds.length > GRAPHQL_NODE_IDS_MAX) return null;
  const url = new URL("/graphql", PERSONAL_GITHUB_API_ORIGIN);
  let response: Response;
  try {
    const authorization = await services.authorizeProviderRequest(
      authority,
      url.toString(),
      "github_request",
      [],
    );
    response = await services.fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
        "user-agent": "Opengeni-GitHub-Gateway/1",
      },
      body: JSON.stringify({ query: NODE_REPOSITORIES_QUERY, variables: { ids: nodeIds } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  let payload: { data?: { nodes?: unknown[] }; errors?: unknown[] };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return null;
  }
  const nodes = payload.data?.nodes;
  if (!Array.isArray(nodes) || nodes.length !== nodeIds.length) return null;
  for (const [index, node] of nodes.entries()) {
    const id = nodeIds[index]!;
    // An ID GitHub cannot see: the mutation fails there too.
    if (node === null) {
      resolved.set(id, "unseen");
      continue;
    }
    if (!node || typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    const nameWithOwner =
      typeof record.nameWithOwner === "string"
        ? record.nameWithOwner
        : record.repository && typeof record.repository === "object"
          ? (record.repository as Record<string, unknown>).nameWithOwner
          : undefined;
    if (typeof nameWithOwner === "string" && nameWithOwner.includes("/")) {
      const [owner, name] = nameWithOwner.split("/", 2) as [string, string];
      resolved.set(id, { kind: "name", owner, name });
      continue;
    }
    if (typeof record.__typename === "string" && NON_REPOSITORY_NODE_TYPES.has(record.__typename)) {
      resolved.set(id, "other");
      continue;
    }
    return null;
  }
  return resolved;
}

/**
 * A repository's default branch, read with the person's token and kept for a
 * minute. Null when GitHub does not say.
 */
export async function repositoryDefaultBranch(
  services: Pick<
    PersonalGitHubGatewayServices,
    "authorizeProviderRequest" | "fetch" | "defaultBranches"
  >,
  authority: PersonalGitHubGatewayAuthority,
  repository: GitHubGatewayRepositoryRef,
): Promise<string | null> {
  const path =
    repository.kind === "id"
      ? `/repositories/${encodeURIComponent(repository.id)}`
      : `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const key = `${authority.claims.connectionId}\u0000${path.toLowerCase()}`;
  const cache = services.defaultBranches;
  const cached = cache?.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.branch;
  const url = new URL(path, PERSONAL_GITHUB_API_ORIGIN);
  let branch: unknown;
  try {
    const authorization = await services.authorizeProviderRequest(
      authority,
      url.toString(),
      "github_read",
      [],
    );
    branch = (await fetchLiveGitHubJson(services.fetch, url, authorization))?.default_branch;
  } catch {
    return null;
  }
  if (typeof branch !== "string" || branch.length === 0) return null;
  if (cache) {
    cache.delete(key);
    if (cache.size >= DEFAULT_BRANCH_CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { branch, expiresAt: Date.now() + DEFAULT_BRANCH_TTL_MS });
  }
  return branch;
}

const REF_TARGETS_QUERY = `query OpengeniGatewayRefs($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Ref { name prefix repository { nameWithOwner defaultBranchRef { name } } }
    ... on Repository { nameWithOwner defaultBranchRef { name } }
  }
}`;

/** GraphQL Ref and Repository nodes by ID, or null when GitHub can't say. */
async function graphqlRefNodes(
  services: PersonalGitHubGatewayServices,
  authority: PersonalGitHubGatewayAuthority,
  ids: string[],
): Promise<Map<string, Record<string, unknown>> | null> {
  if (ids.length === 0) return new Map();
  if (ids.length > GRAPHQL_NODE_IDS_MAX) return null;
  const url = new URL("/graphql", PERSONAL_GITHUB_API_ORIGIN);
  try {
    const authorization = await services.authorizeProviderRequest(
      authority,
      url.toString(),
      "github_request",
      [],
    );
    const response = await services.fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json",
        "user-agent": "Opengeni-GitHub-Gateway/1",
      },
      body: JSON.stringify({ query: REF_TARGETS_QUERY, variables: { ids } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const payload = (await response.json()) as { data?: { nodes?: unknown[] } };
    const nodes = payload.data?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== ids.length) return null;
    const byId = new Map<string, Record<string, unknown>>();
    nodes.forEach((node, index) => {
      if (node !== null && typeof node === "object") {
        byId.set(ids[index]!, node as Record<string, unknown>);
      }
    });
    return byId;
  } catch {
    return null;
  }
}

function defaultBranchRefName(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * A force update or deletion is sensitive unless every ref it touches is a
 * branch other than its repository's default branch, in a repository the
 * gateway has already checked; then the person's branch policy decides.
 * Anything the gateway can't confirm stays sensitive.
 */
async function applyRefRewritePolicy(
  services: PersonalGitHubGatewayServices,
  authority: PersonalGitHubGatewayAuthority,
  action: GitHubGatewayAction,
  repository: GitHubGatewayRepositoryRef | null,
  checks: GatewayRepositoryCheck[],
): Promise<GitHubGatewayAction> {
  if (action.kind !== "write" || !action.refRewrites) return action;
  const { targets, sensitiveOtherwise } = action.refRewrites;
  const nodeIds = [
    ...new Set(
      targets.flatMap((target) =>
        target.kind === "node"
          ? [target.refNodeId]
          : target.repositoryNodeId
            ? [target.repositoryNodeId]
            : [],
      ),
    ),
  ];
  const nodes = await graphqlRefNodes(services, authority, nodeIds);
  if (!nodes) return action;
  const checked = new Set(
    checks.flatMap((check) =>
      check.access === "write" && check.repository.kind === "name"
        ? [`${check.repository.owner}/${check.repository.name}`.toLowerCase()]
        : [],
    ),
  );
  const isChecked = (node: Record<string, unknown>) =>
    typeof node.nameWithOwner === "string" && checked.has(node.nameWithOwner.toLowerCase());
  for (const target of targets) {
    let ref: string | null = null;
    let defaultBranch: string | null = null;
    if (target.kind === "node") {
      const node = nodes.get(target.refNodeId);
      if (
        node?.__typename === "Ref" &&
        typeof node.prefix === "string" &&
        typeof node.name === "string" &&
        node.repository !== null &&
        typeof node.repository === "object" &&
        isChecked(node.repository as Record<string, unknown>)
      ) {
        ref = `${node.prefix}${node.name}`;
        defaultBranch = defaultBranchRefName(
          (node.repository as Record<string, unknown>).defaultBranchRef,
        );
      }
    } else if (target.repositoryNodeId) {
      const node = nodes.get(target.repositoryNodeId);
      if (node?.__typename === "Repository" && isChecked(node)) {
        ref = target.ref;
        defaultBranch = defaultBranchRefName(node.defaultBranchRef);
      }
    } else if (repository) {
      ref = target.ref;
      defaultBranch = await repositoryDefaultBranch(services, authority, repository);
    }
    if (!ref || !refRewriteFollowsPolicy(ref, defaultBranch)) return action;
  }
  return { ...action, sensitive: sensitiveOtherwise };
}

function reviewArgumentsFor(
  method: string,
  path: string,
  body: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const review: Record<string, unknown> = { request: `${method} ${path}`, ...extra };
  if (body !== null && body !== undefined) {
    const text = JSON.stringify(body);
    review.body = text.length <= 16_384 ? body : `${text.slice(0, 16_384)}…`;
  }
  return review;
}

/** One `gh` REST, GraphQL or upload request, as the person. */
export async function handlePersonalGitHubGatewayRequest(
  request: Request,
  target: GatewayTarget,
  services: PersonalGitHubGatewayServices,
): Promise<Response> {
  const path = upstreamPath(request, target);
  if (!path) return gatewayError(404, "Not Found");
  const token = gatewayBearer(request.headers.get("authorization"));
  const claims = token ? services.openClaims(token) : null;
  if (!claims) {
    return gatewayError(401, "GitHub access for this command is unavailable.");
  }
  let authority: PersonalGitHubGatewayAuthority;
  try {
    authority = await services.resolveAuthority(claims);
  } catch (error) {
    return authorityError(error);
  }

  const method = request.method.toUpperCase();
  const pathname = path.split("?", 1)[0]!;
  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
  let bodyBytes: Uint8Array | null = null;
  let bodyStream: ReadableStream<Uint8Array> | null = null;
  if (hasBody && target === "api") {
    const prefix = await readBodyPrefix(request.body, GATEWAY_API_BODY_MAX_BYTES);
    if (!prefix.complete) {
      await prefix.stream?.cancel().catch(() => undefined);
      return gatewayError(413, "The request body is too large for the GitHub gateway.");
    }
    bodyBytes = prefix.bytes;
  } else if (hasBody) {
    bodyStream = request.body;
  }
  const parsedBody = bodyBytes ? parseJsonBody(bodyBytes) : null;

  let action: GitHubGatewayAction;
  let checks: GatewayRepositoryCheck[] = [];
  let reviewExtra: Record<string, unknown> = {};
  let restRepository: GitHubGatewayRepositoryRef | null = null;
  if (target === "api" && pathname === "/graphql" && method !== "POST") {
    return gatewayError(405, "GitHub GraphQL takes POST requests.");
  }
  if (target === "api" && pathname === "/graphql") {
    const graphql = classifyGitHubGraphqlRequest(parsedBody);
    action = graphql.action;
    for (const repository of graphql.repositories) {
      // `viewer { repository(name:) }`: the person's own repository.
      const owner = repository.owner ?? authority.metadata.githubLogin;
      checks.push({ repository: { kind: "name", owner, name: repository.name }, access: "read" });
    }
    if (action.kind === "write") {
      reviewExtra = { mutations: graphql.mutations };
      for (const repository of graphql.mutationRepositories) {
        checks.push({ repository: { kind: "name", ...repository }, access: "write" });
      }
      const nodeRepositories = await resolveNodeRepositories(services, authority, graphql.nodeIds);
      if (nodeRepositories === null) {
        action = unscopedWrite(action);
      } else {
        for (const resolved of nodeRepositories.values()) {
          if (typeof resolved === "object") checks.push({ repository: resolved, access: "write" });
        }
        // Each mutation needs a repository of its own: one on an allowed
        // repository can't vouch for an organization or project write
        // bundled with it. An unrecognised or sensitive mutation that also
        // touches a node outside any repository, or one GitHub won't show,
        // can't be confirmed either.
        const scoped = graphql.fields.every((field) => {
          if (field.unreadableId) return false;
          if (field.accountLevel) return true;
          const targets = field.nodeIds.map((id) => nodeRepositories.get(id));
          if (field.sensitive && targets.some((t) => t === "other" || t === "unseen")) return false;
          return field.namesRepository || targets.some((resolved) => typeof resolved === "object");
        });
        if (!scoped) action = unscopedWrite(action);
      }
    }
  } else {
    const rest = classifyGitHubRestRequest(method, pathname, parsedBody ?? null);
    action = rest.action;
    restRepository = rest.repository;
    if (rest.repository) {
      checks.push({
        repository: rest.repository,
        access: action.kind === "read" ? "read" : "write",
      });
    }
  }
  try {
    checks = await nameRepositoryIds(services, authority, checks);
    assertRepositories(authority, checks);
  } catch (error) {
    return authorityError(error);
  }
  action = await applyRefRewritePolicy(services, authority, action, restRepository, checks);
  // With every repository allowed for writing, there is no allowlist an
  // unconfirmed write could step around: the person's policy decides.
  let everyRepository = false;
  if (action.kind === "write" && action.unscoped && allowlistCoversEveryRepository(authority)) {
    const { unscoped: _covered, ...scoped } = action;
    action = scoped;
    everyRepository = true;
  }

  let requestId: string | null = null;
  if (action.kind === "write") {
    const repositoryNames = checks.map((check) => repositoryLabel(check.repository));
    const where =
      repositoryNames.length > 0 ? ` on ${[...new Set(repositoryNames)].join(", ")}` : "";
    const title = `${action.title}${where}`.slice(0, 240);
    const contentLength = request.headers.get("content-length");
    const decision = await services
      .decide(authority.identity, {
        action,
        title,
        digest: requestDigest([
          target,
          method,
          path,
          bodyBytes,
          bodyStream ? { contentLength, contentType: request.headers.get("content-type") } : null,
        ]),
        reviewArguments: reviewArgumentsFor(method, path, parsedBody ?? null, {
          ...reviewExtra,
          ...(bodyStream && contentLength ? { bytes: Number(contentLength) } : {}),
        }),
      })
      .catch(() => null);
    if (decision === null) {
      return gatewayError(502, "Could not check the person's GitHub action settings. Try again.");
    }
    if (decision.kind === "refuse") {
      return gatewayError(decision.status, decision.message, {
        ...(decision.waiting ? { "x-opengeni-approval": "pending" } : {}),
      });
    }
    if (decision.kind === "run") requestId = decision.requestId;
  }

  const origin = target === "api" ? PERSONAL_GITHUB_API_ORIGIN : GITHUB_UPLOADS_ORIGIN;
  const upstreamUrl = new URL(path, origin);
  if (upstreamUrl.origin !== origin) return gatewayError(404, "Not Found");
  const complete = async (outcome: "completed" | "uncertain" | "not_executed") => {
    if (!requestId) return;
    const id = requestId;
    requestId = null;
    await services.complete(authority.identity, id, outcome).catch(() => undefined);
  };
  let authorization: string;
  try {
    authorization = await services.authorizeProviderRequest(
      authority,
      upstreamUrl.toString(),
      action.kind === "write" ? (action.tools[0] ?? "github_request") : "github_read",
      checks,
      { everyRepository },
    );
  } catch (error) {
    await complete("not_executed");
    return authorityError(error);
  }
  let upstream: Response;
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method,
      redirect: "manual",
      headers: upstreamHeaders(request, authorization, bodyStream !== null),
      ...(bodyBytes ? { body: bodyBytes as unknown as BodyInit } : {}),
      ...(bodyStream ? { body: bodyStream, duplex: "half" } : {}),
    };
    upstream = await services.fetch(upstreamUrl, init);
  } catch {
    await complete("uncertain");
    return gatewayError(
      502,
      action.kind === "write"
        ? "GitHub did not answer; the outcome is unknown. Check GitHub before trying again."
        : "GitHub is temporarily unavailable. Try again.",
    );
  }
  if (upstream.status >= 500) await complete("uncertain");
  else if (upstream.status >= 400) await complete("not_executed");
  else await complete("completed");
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: downstreamHeaders(upstream),
  });
}

// ---------------------------------------------------------------------------
// Database-backed services
// ---------------------------------------------------------------------------

function exactGitHubDelegation(
  claims: PersonalGitHubGitBrokerClaims,
  delegation: McpPersonalConnectionDelegation,
): void {
  const selection = delegation.personalGitHubRepositorySelection;
  if (
    !selection ||
    selection.credentialBindingId !== claims.credentialBindingId ||
    selection.connectionAuthorityGeneration !== claims.connectionAuthorityGeneration
  ) {
    throw new Error("personal GitHub delegation changed");
  }
}

export async function resolvePersonalGitHubGatewayAuthority(
  deps: ApiRouteDeps,
  claims: PersonalGitHubGitBrokerClaims,
): Promise<PersonalGitHubGatewayAuthority> {
  const { delegation, initiator } = await resolvePersonalGitHubPassTurn(deps, claims);
  exactGitHubDelegation(claims, delegation);
  const connection = await assertCurrentPersonalGitHubConnection(deps, claims);
  const session = await getSessionGitHubGatewayState(deps.db, claims.workspaceId, claims.sessionId);
  if (!session) throw new Error("session is unavailable");
  return {
    claims,
    identity: { claims, initiator, unattended: session.unattended },
    providerPrincipalId: connection.providerPrincipalId,
    metadata: connection.metadata,
    // All my repositories applies only while the rollout setting is on.
    selection: deps.settings.githubPersonalAllRepositoriesEnabled
      ? connection.selection
      : { ...connection.selection, allRepositoriesAccess: null },
    removedRepositories: session.removedRepositories,
  };
}

function gatewayGitServices(
  deps: ApiRouteDeps,
  gateway: Pick<PersonalGitHubGatewayServices, "openClaims" | "resolveAuthority">,
  fetchImpl: typeof fetch,
): PersonalGitHubGitBrokerServices {
  const authorities = new WeakMap<BrokerAuthority, PersonalGitHubGatewayAuthority>();
  const authorize = async (
    authority: BrokerAuthority,
    destinationUrl: string,
    toolName: string,
  ) => {
    const gatewayAuthority = authorities.get(authority);
    if (!gatewayAuthority) throw new Error("personal GitHub gateway authority is unavailable");
    const [owner, name] = authority.repository.fullName.split("/", 2) as [string, string];
    return await authorizePersonalGitHubProviderRequest(deps, {
      claims: authority.claims,
      providerPrincipalId: authority.providerPrincipalId,
      destinationUrl,
      toolName,
      recheck: async () => {
        const current = await gateway.resolveAuthority(authority.claims);
        assertRepositories(current, [
          { repository: { kind: "name", owner, name }, access: authority.repository.access },
        ]);
        return current;
      },
    });
  };
  return {
    openClaims: gateway.openClaims,
    validRouteKey: (key) =>
      /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u.test(key) &&
      !key.endsWith("/.") &&
      !key.endsWith("/.."),
    resolveAuthority: async (claims, routeKey) => {
      const current = await gateway.resolveAuthority(claims);
      const [owner, name] = routeKey.split("/", 2) as [string, string];
      const read = gatewayRepositoryDecision(current, { kind: "name", owner, name }, "read");
      if (!read.allowed) throw new GatewayRepositoryDeniedError(read.message);
      const write = gatewayRepositoryDecision(current, { kind: "name", owner, name }, "write");
      const selected = current.selection.repositories.find(
        (candidate) => candidate.fullName.toLowerCase() === routeKey.toLowerCase(),
      );
      let repository: BrokerAuthority["repository"];
      if (selected) {
        repository = {
          repositoryId: selected.repositoryId,
          fullName: selected.fullName,
          canonicalUrl: selected.canonicalUrl,
          access: write.allowed ? "write" : "read",
          selectionGeneration: selected.selectionGeneration,
          ref: "HEAD",
        };
      } else {
        // All my repositories: GitHub names the repository.
        const url = new URL(`/repos/${owner}/${name}`, PERSONAL_GITHUB_API_ORIGIN);
        const probe: BrokerAuthority = {
          claims,
          providerPrincipalId: current.providerPrincipalId,
          repository: {
            repositoryId: "0",
            fullName: `${owner}/${name}`,
            canonicalUrl: `https://github.com/${owner}/${name}`,
            access: "read",
            selectionGeneration: current.selection.selectionGeneration,
            ref: "HEAD",
          },
        };
        authorities.set(probe, current);
        const payload = await fetchLiveGitHubJson(
          fetchImpl,
          url,
          await authorize(probe, url.toString(), "git_repository_verify"),
        );
        if (
          !payload ||
          typeof payload.full_name !== "string" ||
          typeof payload.html_url !== "string" ||
          payload.id === undefined
        ) {
          throw new GatewayRepositoryDeniedError(
            `GitHub has no repository ${routeKey} you can use.`,
          );
        }
        repository = {
          repositoryId: String(payload.id),
          fullName: payload.full_name,
          canonicalUrl: payload.html_url,
          access: write.allowed ? "write" : "read",
          selectionGeneration: current.selection.selectionGeneration,
          ref: "HEAD",
        };
      }
      const authority: BrokerAuthority = {
        claims,
        repository,
        providerPrincipalId: current.providerPrincipalId,
        identity: current.identity,
      };
      authorities.set(authority, current);
      return authority;
    },
    authorizeProviderRequest: async (authority, destinationUrl, operation) =>
      await authorize(authority, destinationUrl, `git_${operation}`),
    ...personalGitHubPushPolicyServices(deps, (authority, url) =>
      authorize(authority, url, "git_repository_verify"),
    ),
    fetch: fetchImpl,
  };
}

export function personalGitHubGatewayServices(deps: ApiRouteDeps): PersonalGitHubGatewayServices {
  const secret = deps.settings.integrationsStateSecret?.trim();
  const fetchImpl = deps.githubPersonalFetch ?? fetch;
  const openClaims = (token: string) =>
    deps.settings.githubPersonalOauthEnabled && secret
      ? openPersonalGitHubGitBrokerClaims(secret, token)
      : null;
  const resolveAuthority = async (claims: PersonalGitHubGitBrokerClaims) => {
    if (!deps.settings.githubPersonalOauthEnabled || !secret) {
      throw new Error("personal GitHub gateway is disabled");
    }
    return await resolvePersonalGitHubGatewayAuthority(deps, claims);
  };
  return {
    openClaims,
    resolveAuthority,
    authorizeProviderRequest: async (authority, destinationUrl, toolName, repositories, options) =>
      await authorizePersonalGitHubProviderRequest(deps, {
        claims: authority.claims,
        providerPrincipalId: authority.providerPrincipalId,
        destinationUrl,
        toolName,
        recheck: async () => {
          const current = await resolveAuthority(authority.claims);
          assertRepositories(current, repositories);
          if (options?.everyRepository && !allowlistCoversEveryRepository(current)) {
            throw new GatewayRepositoryDeniedError(
              "The repositories this chat can write to changed. Run the command again.",
            );
          }
          return current;
        },
      }),
    decide: databaseGatewayDecider(deps.db),
    complete: databaseGatewayCompleter(deps.db),
    git: gatewayGitServices(deps, { openClaims, resolveAuthority }, fetchImpl),
    fetch: fetchImpl,
    defaultBranches: new Map(),
  };
}
