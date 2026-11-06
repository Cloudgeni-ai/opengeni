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
import type { ApiRouteDeps } from "@opengeni/core";
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
  ) => Promise<string>;
  decide: GatewayDecider;
  complete: GatewayCompleter;
  /** Git smart HTTP for `owner/name` routes (clones through `gh`). */
  git: PersonalGitHubGitBrokerServices;
  fetch: typeof fetch;
};

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
    "Opengeni's GitHub access for this command is no longer current. Run it again in a new turn.",
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

function canRead(permissions: {
  pull: boolean;
  triage: boolean;
  push: boolean;
  maintain: boolean;
  admin: boolean;
}) {
  return (
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin
  );
}

function canWrite(permissions: { push: boolean; maintain: boolean; admin: boolean }) {
  return permissions.push || permissions.maintain || permissions.admin;
}

function accessCovers(granted: unknown, requested: PersonalGitHubRepositoryAccess): boolean {
  return granted === "write" || (granted === "read" && requested === "read");
}

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
  authority: Pick<PersonalGitHubGatewayAuthority, "selection" | "removedRepositories">,
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
  const allRepositoriesAccess = (authority.selection as { allRepositoriesAccess?: unknown })
    .allRepositoriesAccess;
  if (allRepositoriesAccess === "read" || allRepositoriesAccess === "write") {
    if (accessCovers(allRepositoriesAccess, access)) return { allowed: true };
    return { allowed: false, message: `Opengeni may only read ${label} as you.` };
  }
  if (!selected) {
    return {
      allowed: false,
      message: `${label} is not one of the repositories Opengeni may use as you. Add it under Your GitHub in Opengeni.`,
    };
  }
  if (selected.disabled || !canRead(selected.permissions)) {
    return { allowed: false, message: `You cannot read ${label} on GitHub.` };
  }
  if (
    access === "write" &&
    (selected.selectedAccess !== "write" || selected.archived || !canWrite(selected.permissions))
  ) {
    return { allowed: false, message: `Opengeni may only read ${label} as you.` };
  }
  return { allowed: true };
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
  const all = (authority.selection as { allRepositoriesAccess?: unknown }).allRepositoriesAccess;
  if (all !== "read" && all !== "write") return null;
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
    `Opengeni could not check repository ${repositoryId} on GitHub. Use its owner/name instead.`,
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
 * The repositories a GraphQL mutation's node IDs belong to, or null when they
 * cannot all be resolved (then the request asks the person).
 */
async function resolveNodeRepositories(
  services: PersonalGitHubGatewayServices,
  authority: PersonalGitHubGatewayAuthority,
  nodeIds: string[],
): Promise<GitHubGatewayRepositoryRef[] | null> {
  if (nodeIds.length === 0) return [];
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
  const repositories: GitHubGatewayRepositoryRef[] = [];
  for (const node of nodes) {
    // An ID GitHub cannot see: the mutation fails there too.
    if (node === null) continue;
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
      repositories.push({ kind: "name", owner, name });
      continue;
    }
    if (typeof record.__typename === "string" && NON_REPOSITORY_NODE_TYPES.has(record.__typename)) {
      continue;
    }
    return null;
  }
  return repositories;
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
    return gatewayError(401, "Opengeni's GitHub access for this command is unavailable.");
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
      return gatewayError(413, "The request body is too large for Opengeni's GitHub gateway.");
    }
    bodyBytes = prefix.bytes;
  } else if (hasBody) {
    bodyStream = request.body;
  }
  const parsedBody = bodyBytes ? parseJsonBody(bodyBytes) : null;

  let action: GitHubGatewayAction;
  let checks: GatewayRepositoryCheck[] = [];
  let reviewExtra: Record<string, unknown> = {};
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
      let writeTargets = graphql.mutationRepositories.length;
      for (const repository of graphql.mutationRepositories) {
        checks.push({ repository: { kind: "name", ...repository }, access: "write" });
      }
      const nodeRepositories = await resolveNodeRepositories(services, authority, graphql.nodeIds);
      if (nodeRepositories === null) {
        action = { ...action, alwaysAsk: true };
      } else {
        writeTargets += nodeRepositories.length;
        for (const repository of nodeRepositories) checks.push({ repository, access: "write" });
      }
      // A repository mutation whose repository the gateway could not find
      // (an input shape it does not know) asks.
      if (writeTargets === 0 && !graphql.accountLevel) action = { ...action, alwaysAsk: true };
    }
  } else {
    const rest = classifyGitHubRestRequest(method, pathname, parsedBody ?? null);
    action = rest.action;
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
      return gatewayError(
        502,
        "Opengeni could not check your GitHub permission settings. Try again.",
      );
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
    selection: connection.selection,
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
    authorizeProviderRequest: async (authority, destinationUrl, toolName, repositories) =>
      await authorizePersonalGitHubProviderRequest(deps, {
        claims: authority.claims,
        providerPrincipalId: authority.providerPrincipalId,
        destinationUrl,
        toolName,
        recheck: async () => {
          const current = await resolveAuthority(authority.claims);
          assertRepositories(current, repositories);
          return current;
        },
      }),
    decide: databaseGatewayDecider(deps.db),
    complete: databaseGatewayCompleter(deps.db),
    git: gatewayGitServices(deps, { openClaims, resolveAuthority }, fetchImpl),
    fetch: fetchImpl,
  };
}
