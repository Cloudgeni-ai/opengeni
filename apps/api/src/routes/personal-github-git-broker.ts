import {
  PERSONAL_GITHUB_API_ORIGIN,
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  PersonalGitHubConnectionMetadata,
  isPersonalGitHubConnection,
  type PersonalGitHubRepositoryPermissions,
} from "@opengeni/contracts/personal-github";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  getConnectionMetadata,
  getPersonalGitHubRepositorySelectionState,
  getSessionAuthorityProjection,
  getSessionTurnForAttempt,
  resolveAcceptedConnectionUse,
} from "@opengeni/db";
import {
  openPersonalGitHubGitBrokerClaims,
  personalGitHubGitBrokerRouteId,
  type PersonalGitHubGitBrokerClaims,
  type PersonalGitHubGitBrokerRepositoryClaim,
} from "@opengeni/github";
import { readResponseTextBounded } from "@opengeni/network";
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import JSONBig from "json-bigint";

const PERSONAL_GITHUB_SERVER_ID = "github:personal";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_RESPONSE_MAX_BYTES = 256 * 1024;
const GIT_BROKER_IDLE_TIMEOUT_MS = 60_000;
const GIT_BROKER_AUTHORIZATION_MAX_BYTES = 8 * 1024;

export const PERSONAL_GITHUB_GIT_BROKER_PATH_PREFIX = "/v1/git/personal/";

type BrokerOperation = "info_refs" | "upload_pack" | "receive_pack";

type BrokerRepository = Omit<PersonalGitHubGitBrokerRepositoryClaim, "routeId">;

type BrokerAuthority = {
  claims: PersonalGitHubGitBrokerClaims;
  repository: BrokerRepository;
  providerPrincipalId: string;
};

export type PersonalGitHubGitBrokerServices = {
  openClaims: (token: string) => PersonalGitHubGitBrokerClaims | null;
  resolveAuthority: (
    claims: PersonalGitHubGitBrokerClaims,
    routeId: string,
  ) => Promise<BrokerAuthority>;
  authorizeProviderRequest: (
    authority: BrokerAuthority,
    destinationUrl: string,
    operation: "identity_verify" | "repository_verify" | BrokerOperation,
  ) => Promise<string>;
  fetch: typeof fetch;
  idleTimeoutMs?: number;
};

/**
 * Register the three closed Git smart-HTTP operations. These routes are not a
 * product-auth bypass: their only credential is the short-lived encrypted,
 * exact-attempt broker bearer and every physical provider request is fenced
 * again against current database authority.
 */
export function registerPersonalGitHubGitBrokerRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  services = personalGitHubGitBrokerServices(deps),
): void {
  app.get(`${PERSONAL_GITHUB_GIT_BROKER_PATH_PREFIX}:routeId/info/refs`, (c) =>
    handlePersonalGitHubGitBrokerRequest(c.req.raw, c.req.param("routeId"), "info_refs", services),
  );
  app.post(`${PERSONAL_GITHUB_GIT_BROKER_PATH_PREFIX}:routeId/git-upload-pack`, (c) =>
    handlePersonalGitHubGitBrokerRequest(
      c.req.raw,
      c.req.param("routeId"),
      "upload_pack",
      services,
    ),
  );
  app.post(`${PERSONAL_GITHUB_GIT_BROKER_PATH_PREFIX}:routeId/git-receive-pack`, (c) =>
    handlePersonalGitHubGitBrokerRequest(
      c.req.raw,
      c.req.param("routeId"),
      "receive_pack",
      services,
    ),
  );
}

export function isPersonalGitHubGitBrokerPath(pathname: string): boolean {
  return /^\/v1\/git\/personal\/[A-Za-z0-9_-]{43}\/(?:info\/refs|git-upload-pack|git-receive-pack)$/u.test(
    pathname,
  );
}

export function isPersonalGitHubGitBrokerRequest(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (
    normalizedMethod === "GET" &&
    /^\/v1\/git\/personal\/[A-Za-z0-9_-]{43}\/info\/refs$/u.test(pathname)
  ) {
    return true;
  }
  return (
    normalizedMethod === "POST" &&
    /^\/v1\/git\/personal\/[A-Za-z0-9_-]{43}\/git-(?:upload|receive)-pack$/u.test(pathname)
  );
}

export async function handlePersonalGitHubGitBrokerRequest(
  request: Request,
  routeId: string,
  operation: BrokerOperation,
  services: PersonalGitHubGitBrokerServices,
): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(routeId) || !validGitRequestShape(request, operation)) {
    return brokerError(404, "Git repository route not found.");
  }
  const token = brokerBearer(request.headers.get("authorization"));
  const claims = token ? services.openClaims(token) : null;
  if (!claims) return brokerError(401, "Git broker authorization is unavailable.");

  let authority: BrokerAuthority;
  try {
    authority = await services.resolveAuthority(claims, routeId);
  } catch {
    return brokerError(401, "Git broker authorization is no longer current.");
  }
  if (authority.repository.access !== "write" && requestsReceivePack(request, operation)) {
    return brokerError(403, "This repository is not authorized for Git pushes.");
  }

  const userApiUrl = new URL("/user", PERSONAL_GITHUB_API_ORIGIN);
  let userAuthorization: string;
  try {
    userAuthorization = await services.authorizeProviderRequest(
      authority,
      userApiUrl.toString(),
      "identity_verify",
    );
  } catch {
    return brokerError(401, "Git broker authorization is no longer current.");
  }
  if (
    !(await fetchLiveProviderUser(
      services.fetch,
      userApiUrl,
      userAuthorization,
      authority.providerPrincipalId,
    ))
  ) {
    return brokerError(403, "The connected GitHub identity is no longer available.");
  }

  const repositoryApiUrl = new URL(
    `/repositories/${authority.repository.repositoryId}`,
    PERSONAL_GITHUB_API_ORIGIN,
  );
  let repositoryAuthorization: string;
  try {
    repositoryAuthorization = await services.authorizeProviderRequest(
      authority,
      repositoryApiUrl.toString(),
      "repository_verify",
    );
  } catch {
    return brokerError(401, "Git broker authorization is no longer current.");
  }
  const repositoryLive = await fetchLiveRepository(
    services.fetch,
    repositoryApiUrl,
    repositoryAuthorization,
    authority.repository,
  );
  if (!repositoryLive) {
    return brokerError(403, "The selected GitHub repository is no longer available.");
  }

  const upstreamUrl = githubGitUrl(authority.repository, operation, request.url);
  let gitAuthorization: string;
  try {
    gitAuthorization = await services.authorizeProviderRequest(
      authority,
      upstreamUrl.toString(),
      operation,
    );
  } catch {
    return brokerError(401, "Git broker authorization is no longer current.");
  }
  const providerToken = bearerToken(gitAuthorization);
  if (!providerToken) {
    return brokerError(401, "Git broker authorization is unavailable.");
  }

  const controller = new AbortController();
  const deadline = idleDeadline(controller, services.idleTimeoutMs ?? GIT_BROKER_IDLE_TIMEOUT_MS);
  const body = operation === "info_refs" ? undefined : request.body;
  const streamedBody = body
    ? streamWithActivity(
        body,
        deadline.activity,
        () => undefined,
        () => controller.abort(),
      )
    : undefined;
  try {
    const headers = upstreamRequestHeaders(request, operation, providerToken);
    const init: RequestInit & { duplex?: "half" } = {
      method: operation === "info_refs" ? "GET" : "POST",
      redirect: "manual",
      headers,
      signal: controller.signal,
      ...(streamedBody ? { body: streamedBody, duplex: "half" } : {}),
    };
    const upstream = await services.fetch(upstreamUrl, init);
    deadline.activity();
    if (
      !upstream.ok ||
      !validUpstreamContentType(upstream, operation, request.url) ||
      !upstream.body
    ) {
      await upstream.body?.cancel().catch(() => undefined);
      deadline.clear();
      return brokerError(
        502,
        operation === "receive_pack"
          ? "GitHub push outcome is unknown. Inspect the remote before retrying."
          : "GitHub Git transport is unavailable.",
      );
    }
    const responseBody = streamWithActivity(upstream.body, deadline.activity, deadline.clear);
    return new Response(responseBody, {
      status: upstream.status,
      headers: upstreamResponseHeaders(upstream, operation),
    });
  } catch {
    deadline.clear();
    return brokerError(
      502,
      operation === "receive_pack"
        ? "GitHub push outcome is unknown. Inspect the remote before retrying."
        : "GitHub Git transport is unavailable.",
    );
  }
}

function personalGitHubGitBrokerServices(deps: ApiRouteDeps): PersonalGitHubGitBrokerServices {
  const secret = deps.settings.integrationsStateSecret?.trim();
  return {
    openClaims: (token) =>
      deps.settings.githubPersonalOauthEnabled && secret
        ? openPersonalGitHubGitBrokerClaims(secret, token)
        : null,
    resolveAuthority: async (claims, routeId) => {
      if (!deps.settings.githubPersonalOauthEnabled || !secret) {
        throw new Error("personal GitHub Git broker is disabled");
      }
      return await resolveBrokerAuthority(deps, secret, claims, routeId);
    },
    authorizeProviderRequest: async (authority, destinationUrl, operation) =>
      await authorizeBrokerProviderRequest(deps, authority, destinationUrl, operation),
    fetch: deps.githubPersonalFetch ?? fetch,
  };
}

async function resolveBrokerAuthority(
  deps: ApiRouteDeps,
  secret: string,
  claims: PersonalGitHubGitBrokerClaims,
  routeId: string,
): Promise<BrokerAuthority> {
  const turn = await getSessionTurnForAttempt(
    deps.db,
    claims.workspaceId,
    claims.sessionId,
    claims.attemptId,
  );
  const session = await getSessionAuthorityProjection(
    deps.db,
    claims.workspaceId,
    claims.sessionId,
  );
  if (
    !turn ||
    !session ||
    turn.id !== claims.turnId ||
    turn.executionGeneration !== claims.executionGeneration ||
    session.rootSessionId !== claims.rootSessionId ||
    (session.visibility === "user_private" && session.ownerSubjectId !== claims.ownerSubjectId)
  ) {
    throw new Error("accepted Git broker attempt is no longer current");
  }
  const delegation = exactDelegation(turn.personalConnectionDelegations, claims);
  const repository = exactRouteRepository(secret, claims, delegation, routeId);
  const providerIdentity = await assertCurrentConnectionAndSelection(deps, claims, repository);
  return { claims, repository, ...providerIdentity };
}

async function authorizeBrokerProviderRequest(
  deps: ApiRouteDeps,
  authority: BrokerAuthority,
  destinationUrl: string,
  operation: "identity_verify" | "repository_verify" | BrokerOperation,
): Promise<string> {
  const { claims, repository } = authority;
  // Re-read every mutable connection/repository fence before this physical
  // provider request. A previous request's successful check grants nothing to
  // this one.
  const currentIdentity = await assertCurrentConnectionAndSelection(deps, claims, repository);
  if (currentIdentity.providerPrincipalId !== authority.providerPrincipalId) {
    throw new Error("personal GitHub provider identity changed");
  }
  const resolver = buildConnectionTokenResolver(deps.db, deps.settings, undefined, {
    ...(deps.githubPersonalFetch
      ? { refreshTransport: { fetchImpl: deps.githubPersonalFetch } }
      : {}),
  });
  const credential = await resolver({
    workspaceId: claims.workspaceId,
    subjectId: claims.ownerSubjectId,
    serverId: PERSONAL_GITHUB_SERVER_ID,
    toolName: `git_${operation}`,
    connectionRef: {
      connectionId: claims.connectionId,
      provider: "github",
      providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
      kind: "oauth2",
      subjectScope: "subject",
      scopes: ["repo"],
    },
    destinationUrl,
    credentialTarget: "http_api",
    connectionUseContext: {
      accountId: claims.accountId,
      workspaceId: claims.workspaceId,
      sessionId: claims.sessionId,
      turnId: claims.turnId,
      attemptId: claims.attemptId,
      executionGeneration: claims.executionGeneration,
      physicalRequestId: randomUUID(),
      usePhase: "credential_resolution",
    },
  });
  if (
    credential.status !== "ok" ||
    credential.connectionId !== claims.connectionId ||
    credential.connectionUseAttribution?.connectionGeneration !==
      claims.connectionAuthorityGeneration ||
    credential.connectionUseAttribution.ownerSubjectId !== claims.ownerSubjectId ||
    credential.connectionUseAttribution.workspaceId !== claims.workspaceId
  ) {
    throw new Error("personal GitHub credential resolution was denied");
  }
  await assertCurrentConnectionAndSelection(deps, claims, repository);
  const providerRequest = await resolveAcceptedConnectionUse(deps.db, {
    accountId: claims.accountId,
    workspaceId: claims.workspaceId,
    sessionId: claims.sessionId,
    turnId: claims.turnId,
    attemptId: claims.attemptId,
    executionGeneration: claims.executionGeneration,
    physicalRequestId: randomUUID(),
    usePhase: "provider_request",
    serverId: PERSONAL_GITHUB_SERVER_ID,
    connectionId: claims.connectionId,
    providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
    connectionKind: "oauth2",
    subjectScope: "subject",
    ownerSubjectId: claims.ownerSubjectId,
  });
  if (
    providerRequest.status !== "authorized" ||
    providerRequest.originWorkspaceId !== claims.originWorkspaceId ||
    providerRequest.attribution.connectionId !== claims.connectionId ||
    providerRequest.attribution.connectionGeneration !== claims.connectionAuthorityGeneration ||
    providerRequest.attribution.ownerSubjectId !== claims.ownerSubjectId
  ) {
    throw new Error("personal GitHub provider request was denied");
  }
  const authorization = Object.entries(credential.headers).find(
    ([name]) => name.toLowerCase() === "authorization",
  )?.[1];
  if (!authorization) throw new Error("personal GitHub credential has no authorization header");
  return authorization;
}

function exactDelegation(
  delegations: McpPersonalConnectionDelegation[],
  claims: PersonalGitHubGitBrokerClaims,
): McpPersonalConnectionDelegation {
  const matches = delegations.filter(
    (delegation) =>
      delegation.serverId === PERSONAL_GITHUB_SERVER_ID &&
      delegation.connectionType === "github_personal" &&
      delegation.connectionId === claims.connectionId &&
      delegation.originWorkspaceId === claims.originWorkspaceId &&
      delegation.ownerSubjectId === claims.ownerSubjectId &&
      delegation.providerDomain === PERSONAL_GITHUB_PROVIDER_DOMAIN &&
      delegation.kind === "oauth2" &&
      delegation.personalGitHubRepositorySelection?.credentialBindingId ===
        claims.credentialBindingId &&
      delegation.personalGitHubRepositorySelection.connectionAuthorityGeneration ===
        claims.connectionAuthorityGeneration &&
      delegation.personalGitHubRepositorySelection.selectionGeneration ===
        claims.selectionGeneration,
  );
  const delegation = matches[0];
  if (matches.length !== 1 || !delegation?.personalGitHubRepositorySelection) {
    throw new Error("personal GitHub delegation changed");
  }
  return delegation;
}

function exactRouteRepository(
  secret: string,
  claims: PersonalGitHubGitBrokerClaims,
  delegation: McpPersonalConnectionDelegation,
  routeId: string,
): BrokerRepository {
  const repositories = delegation
    .personalGitHubRepositorySelection!.repositories.map((repository) => ({
      ...repository,
      routeId: personalGitHubGitBrokerRouteId(secret, { ...claims, repository }),
    }))
    .filter((repository) => repository.routeId === routeId);
  const match = repositories[0];
  if (repositories.length !== 1 || !match) throw new Error("Git broker route changed");
  const { routeId: _routeId, ...repository } = match;
  return repository;
}

async function assertCurrentConnectionAndSelection(
  deps: ApiRouteDeps,
  claims: PersonalGitHubGitBrokerClaims,
  repository: BrokerRepository,
): Promise<{ providerPrincipalId: string }> {
  const connection = await getConnectionMetadata(
    deps.db,
    claims.originWorkspaceId,
    claims.connectionId,
    claims.ownerSubjectId,
  );
  if (
    !connection ||
    connection.accountId !== claims.accountId ||
    connection.workspaceId !== claims.originWorkspaceId ||
    connection.subjectId !== claims.ownerSubjectId ||
    connection.status !== "active" ||
    connection.grantedScopes.length !== 1 ||
    connection.grantedScopes[0] !== "repo" ||
    !isPersonalGitHubConnection(connection)
  ) {
    throw new Error("personal GitHub connection changed");
  }
  // `connections.version` is the credential-refresh CAS and may rotate while
  // an accepted turn runs. Repository use is fenced by the distinct common
  // connection-authority generation returned below by the lifecycle function.
  const metadata = PersonalGitHubConnectionMetadata.parse(connection.metadata);
  if (metadata.credentialBindingId !== claims.credentialBindingId) {
    throw new Error("personal GitHub credential binding changed");
  }
  const selection = await getPersonalGitHubRepositorySelectionState(deps.db, {
    accountId: claims.accountId,
    originWorkspaceId: claims.originWorkspaceId,
    subjectId: claims.ownerSubjectId,
    connectionId: claims.connectionId,
  });
  const current = selection?.repositories.find(
    (candidate) => candidate.repositoryId === repository.repositoryId,
  );
  if (
    !selection ||
    selection.connectionAuthorityGeneration !== claims.connectionAuthorityGeneration ||
    selection.credentialBindingId !== claims.credentialBindingId ||
    selection.credentialBindingId !== metadata.credentialBindingId ||
    selection.providerPrincipalId !== metadata.providerPrincipalId ||
    selection.selectionGeneration !== claims.selectionGeneration ||
    !current ||
    current.fullName !== repository.fullName ||
    current.canonicalUrl !== repository.canonicalUrl ||
    current.selectionGeneration !== repository.selectionGeneration ||
    current.disabled ||
    !canRead(current.permissions) ||
    (repository.access === "write" &&
      (current.selectedAccess !== "write" || current.archived || !canWrite(current.permissions)))
  ) {
    throw new Error("personal GitHub repository selection changed");
  }
  if (metadata.githubUserId !== metadata.providerPrincipalId) {
    throw new Error("personal GitHub provider identity changed");
  }
  return {
    providerPrincipalId: metadata.providerPrincipalId,
  };
}

async function fetchLiveRepository(
  fetchImpl: typeof fetch,
  url: URL,
  authorization: string,
  expected: BrokerRepository,
): Promise<boolean> {
  const payload = await fetchLiveGitHubJson(fetchImpl, url, authorization);
  if (!payload) return false;
  try {
    const permissions = providerPermissions(payload.permissions);
    return (
      String(payload.id) === expected.repositoryId &&
      payload.full_name === expected.fullName &&
      payload.html_url === expected.canonicalUrl &&
      payload.disabled !== true &&
      canRead(permissions) &&
      (expected.access !== "write" || (payload.archived !== true && canWrite(permissions)))
    );
  } catch {
    return false;
  }
}

async function fetchLiveProviderUser(
  fetchImpl: typeof fetch,
  url: URL,
  authorization: string,
  expectedPrincipalId: string,
): Promise<boolean> {
  const payload = await fetchLiveGitHubJson(fetchImpl, url, authorization);
  return (
    payload !== null &&
    String(payload.id) === expectedPrincipalId &&
    typeof payload.login === "string" &&
    payload.login.length > 0
  );
}

async function fetchLiveGitHubJson(
  fetchImpl: typeof fetch,
  url: URL,
  authorization: string,
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": "OpenGeni",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!response.ok || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return providerJson.parse(
      await readResponseTextBounded(response, GITHUB_API_RESPONSE_MAX_BYTES, "GitHub response"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const providerJson = JSONBig({
  storeAsString: true,
  protoAction: "error",
  constructorAction: "error",
});

function providerPermissions(value: unknown): PersonalGitHubRepositoryPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { pull: false, triage: false, push: false, maintain: false, admin: false };
  }
  const permissions = value as Record<string, unknown>;
  return {
    pull: permissions.pull === true,
    triage: permissions.triage === true,
    push: permissions.push === true,
    maintain: permissions.maintain === true,
    admin: permissions.admin === true,
  };
}

function canRead(permissions: PersonalGitHubRepositoryPermissions): boolean {
  return (
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin
  );
}

function canWrite(permissions: PersonalGitHubRepositoryPermissions): boolean {
  return permissions.push || permissions.maintain || permissions.admin;
}

function validGitRequestShape(request: Request, operation: BrokerOperation): boolean {
  const url = new URL(request.url);
  if (operation === "info_refs") {
    if (request.method !== "GET") return false;
    const entries = [...url.searchParams.entries()];
    return (
      entries.length === 1 &&
      entries[0]?.[0] === "service" &&
      (entries[0][1] === "git-upload-pack" || entries[0][1] === "git-receive-pack")
    );
  }
  if (request.method !== "POST" || url.search || request.body === null) return false;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  return (
    contentType === `application/x-git-${operation.replace("_", "-")}-request` &&
    (!contentEncoding || contentEncoding === "gzip")
  );
}

function requestsReceivePack(request: Request, operation: BrokerOperation): boolean {
  return (
    operation === "receive_pack" ||
    (operation === "info_refs" &&
      new URL(request.url).searchParams.get("service") === "git-receive-pack")
  );
}

function githubGitUrl(
  repository: BrokerRepository,
  operation: BrokerOperation,
  requestUrl: string,
): URL {
  const url = new URL(`https://github.com/${repository.fullName}.git`);
  if (operation === "info_refs") {
    url.pathname += "/info/refs";
    url.searchParams.set("service", new URL(requestUrl).searchParams.get("service")!);
  } else {
    url.pathname += `/git-${operation.replace("_", "-")}`;
  }
  return url;
}

function upstreamRequestHeaders(
  request: Request,
  operation: BrokerOperation,
  token: string,
): Headers {
  const headers = new Headers({
    accept:
      operation === "info_refs" ? "*/*" : `application/x-git-${operation.replace("_", "-")}-result`,
    "accept-encoding": "identity",
    authorization: `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
    "user-agent": "OpenGeni-Git-Broker/1",
  });
  if (operation !== "info_refs") {
    headers.set("content-type", `application/x-git-${operation.replace("_", "-")}-request`);
    if (request.headers.get("content-encoding")?.trim().toLowerCase() === "gzip") {
      headers.set("content-encoding", "gzip");
    }
  }
  const gitProtocol = request.headers.get("git-protocol");
  if (gitProtocol === "version=2") headers.set("git-protocol", gitProtocol);
  return headers;
}

function validUpstreamContentType(
  response: Response,
  operation: BrokerOperation,
  requestUrl: string,
): boolean {
  const actual = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (operation !== "info_refs") {
    return actual === `application/x-git-${operation.replace("_", "-")}-result`;
  }
  const requestedService = new URL(requestUrl).searchParams.get("service");
  return actual === `application/x-${requestedService}-advertisement`;
}

function upstreamResponseHeaders(response: Response, operation: BrokerOperation): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": response.headers.get("content-type")!,
    "x-content-type-options": "nosniff",
  });
  if (operation === "receive_pack") {
    headers.set("x-opengeni-push-retry-policy", "inspect-remote-before-retry");
  }
  return headers;
}

function brokerBearer(authorization: string | null): string | null {
  if (
    !authorization ||
    Buffer.byteLength(authorization, "utf8") > GIT_BROKER_AUTHORIZATION_MAX_BYTES
  ) {
    return null;
  }
  if (authorization.startsWith("Bearer ")) return authorization.slice("Bearer ".length) || null;
  if (!authorization.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 && decoded.length > separator + 1 ? decoded.slice(separator + 1) : null;
  } catch {
    return null;
  }
}

function bearerToken(authorization: string): string | null {
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim() || null
    : null;
}

function idleDeadline(
  controller: AbortController,
  timeoutMs: number,
): {
  activity: () => void;
  clear: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const activity = () => {
    clear();
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  activity();
  return { activity, clear };
}

function streamWithActivity(
  source: ReadableStream<Uint8Array>,
  activity: () => void,
  finish: () => void,
  fail = finish,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
          return;
        }
        activity();
        controller.enqueue(result.value);
      } catch {
        fail();
        controller.error(new Error("Git provider stream failed"));
      }
    },
    async cancel(reason) {
      fail();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

function brokerError(status: 401 | 403 | 404 | 502, message: string): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (status === 401) {
    headers.set("www-authenticate", 'Basic realm="OpenGeni Git broker", charset="UTF-8"');
  }
  return new Response(`${message}\n`, {
    status,
    headers,
  });
}
