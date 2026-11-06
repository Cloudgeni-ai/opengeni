import {
  PERSONAL_GITHUB_API_ORIGIN,
  PERSONAL_GITHUB_PROVIDER_DOMAIN,
  PERSONAL_GITHUB_RECONNECT_MESSAGE,
  PersonalGitHubConnectionMetadata,
  isPersonalGitHubConnection,
  personalGitHubConnectionNeedsReconnect,
  type PersonalGitHubRepositoryPermissions,
  type PersonalGitHubRepositorySelectionState,
} from "@opengeni/contracts/personal-github";
import {
  resourcesIncludeRepository,
  type McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  getConnectionMetadata,
  type ConnectorActionAttemptIdentity,
  getPersonalGitHubRepositorySelectionState,
  getSessionAuthorityProjection,
  getSessionGitHubGatewayState,
  getSessionResourcesForAuthority,
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
import {
  databaseGatewayCompleter,
  databaseGatewayDecider,
  inspectPersonalGitHubPush,
  type GatewayDecisionIdentity,
  type PushInspection,
} from "./personal-github-gateway-policy";

const PERSONAL_GITHUB_SERVER_ID = "github:personal";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_RESPONSE_MAX_BYTES = 256 * 1024;
const GIT_BROKER_IDLE_TIMEOUT_MS = 60_000;
const GIT_BROKER_AUTHORIZATION_MAX_BYTES = 8 * 1024;

export const PERSONAL_GITHUB_GIT_BROKER_PATH_PREFIX = "/v1/git/personal/";

export type BrokerOperation = "info_refs" | "upload_pack" | "receive_pack";

export type BrokerRepository = Omit<PersonalGitHubGitBrokerRepositoryClaim, "routeId">;

export type BrokerAuthority = {
  claims: PersonalGitHubGitBrokerClaims;
  repository: BrokerRepository;
  providerPrincipalId: string;
  /** Who decides pushes that need the person's approval. */
  identity?: GatewayDecisionIdentity;
};

export type PersonalGitHubGitBrokerServices = {
  openClaims: (token: string) => PersonalGitHubGitBrokerClaims | null;
  /** Whether a route key has the shape this service resolves; default a broker route id. */
  validRouteKey?: (routeKey: string) => boolean;
  resolveAuthority: (
    claims: PersonalGitHubGitBrokerClaims,
    routeId: string,
  ) => Promise<BrokerAuthority>;
  authorizeProviderRequest: (
    authority: BrokerAuthority,
    destinationUrl: string,
    operation: "identity_verify" | "repository_verify" | BrokerOperation,
  ) => Promise<string>;
  /**
   * Hold a force push or a ref deletion for the person's approval. Other
   * pushes are forwarded unchanged.
   */
  inspectPush?: (
    authority: BrokerAuthority,
    body: ReadableStream<Uint8Array> | null,
    gzip: boolean,
  ) => Promise<PushInspection>;
  completePush?: (
    authority: BrokerAuthority,
    requestId: string,
    outcome: "completed" | "uncertain",
  ) => Promise<void>;
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
  const validRouteKey =
    services.validRouteKey ?? ((key: string) => /^[A-Za-z0-9_-]{43}$/u.test(key));
  if (!validRouteKey(routeId) || !validGitRequestShape(request, operation)) {
    return brokerError(404, "Git repository route not found.");
  }
  const token = brokerBearer(request.headers.get("authorization"));
  const claims = token ? services.openClaims(token) : null;
  if (!claims) return brokerError(401, "Git broker authorization is unavailable.");

  let authority: BrokerAuthority;
  try {
    authority = await services.resolveAuthority(claims, routeId);
  } catch (error) {
    return brokerAuthorityError(error);
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
  } catch (error) {
    return brokerAuthorityError(error);
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
  } catch (error) {
    return brokerAuthorityError(error);
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
  } catch (error) {
    return brokerAuthorityError(error);
  }
  const providerToken = bearerToken(gitAuthorization);
  if (!providerToken) {
    return brokerError(401, "Git broker authorization is unavailable.");
  }

  let body: ReadableStream<Uint8Array> | Uint8Array | null | undefined =
    operation === "info_refs" ? undefined : request.body;
  let pushRequestId: string | null = null;
  const controller = new AbortController();
  const deadline = idleDeadline(controller, services.idleTimeoutMs ?? GIT_BROKER_IDLE_TIMEOUT_MS);
  if (operation === "receive_pack" && services.inspectPush) {
    let inspection: PushInspection;
    try {
      // The idle deadline covers reading the push for inspection too.
      const inspected = request.body
        ? streamWithActivity(
            abortableStream(request.body, controller.signal),
            deadline.activity,
            () => undefined,
            () => controller.abort(),
          )
        : null;
      inspection = await services.inspectPush(
        authority,
        inspected,
        request.headers.get("content-encoding")?.trim().toLowerCase() === "gzip",
      );
    } catch (error) {
      deadline.clear();
      if (controller.signal.aborted) return brokerError(502, "The Git client stopped sending.");
      return brokerAuthorityError(error);
    }
    if (inspection.kind === "respond") {
      deadline.clear();
      return inspection.response;
    }
    body = inspection.body instanceof Uint8Array ? bytesStream(inspection.body) : inspection.body;
    pushRequestId = inspection.requestId;
  }
  const completePush = async (outcome: "completed" | "uncertain") => {
    if (!pushRequestId || !services.completePush) return;
    const requestId = pushRequestId;
    pushRequestId = null;
    await services.completePush(authority, requestId, outcome).catch(() => undefined);
  };

  const streamedBody =
    body instanceof ReadableStream
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
      await completePush("uncertain");
      return brokerError(
        502,
        operation === "receive_pack"
          ? "GitHub push outcome is unknown. Inspect the remote before retrying."
          : "GitHub Git transport is unavailable.",
      );
    }
    // GitHub accepted the push request; per-ref results follow in the body.
    await completePush("completed");
    const responseBody = streamWithActivity(upstream.body, deadline.activity, deadline.clear);
    return new Response(responseBody, {
      status: upstream.status,
      headers: upstreamResponseHeaders(upstream, operation),
    });
  } catch {
    deadline.clear();
    await completePush("uncertain");
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
    ...personalGitHubPushPolicyServices(deps, (authority, url) =>
      authorizeBrokerProviderRequest(deps, authority, url, "repository_verify"),
    ),
    fetch: deps.githubPersonalFetch ?? fetch,
  };
}

/**
 * Push approvals for a Git route: force pushes and ref deletions ask the
 * person (Block in their GitHub settings still wins).
 */
export function personalGitHubPushPolicyServices(
  deps: ApiRouteDeps,
  authorize: (authority: BrokerAuthority, destinationUrl: string) => Promise<string>,
): Pick<PersonalGitHubGitBrokerServices, "inspectPush" | "completePush"> {
  const fetchImpl = deps.githubPersonalFetch ?? fetch;
  const decide = databaseGatewayDecider(deps.db);
  const complete = databaseGatewayCompleter(deps.db);
  return {
    inspectPush: async (authority, body, gzip) => {
      const identity = authority.identity;
      if (!identity) throw new Error("personal GitHub push identity is unavailable");
      return await inspectPersonalGitHubPush({
        body,
        gzip,
        repositoryFullName: authority.repository.fullName,
        identity,
        decide,
        isAncestor: async (base, head) => {
          const url = new URL(
            `/repos/${authority.repository.fullName}/compare/${base}...${head}`,
            PERSONAL_GITHUB_API_ORIGIN,
          );
          url.searchParams.set("per_page", "1");
          const authorization = await authorize(authority, url.toString());
          const payload = await fetchLiveGitHubJson(fetchImpl, url, authorization, 1024 * 1024);
          if (!payload || typeof payload.status !== "string") return null;
          if (payload.status === "ahead" || payload.status === "identical") return true;
          if (payload.status === "behind" || payload.status === "diverged") return false;
          return null;
        },
      });
    },
    completePush: async (authority, requestId, outcome) => {
      if (authority.identity) await complete(authority.identity, requestId, outcome);
    },
  };
}

/** Refused for a reason Git should show as is. */
export class BrokerForbiddenError extends Error {}

export class BrokerRepositoryRemovedError extends Error {
  constructor() {
    super("personal GitHub repository was removed from the session");
  }
}

/** GitHub refused the stored grant; only the person reconnecting fixes it. */
export class BrokerReconnectRequiredError extends Error {
  constructor() {
    super("personal GitHub connection must be reconnected");
  }
}

/** The token refresh failed for a passing reason (GitHub 5xx, timeout). */
export class BrokerProviderUnavailableError extends Error {
  constructor() {
    super("personal GitHub token refresh is temporarily unavailable");
  }
}

function brokerAuthorityError(error: unknown): Response {
  if (error instanceof BrokerForbiddenError) return brokerError(403, error.message);
  if (error instanceof BrokerRepositoryRemovedError) {
    return brokerError(403, "This repository was removed from this chat.");
  }
  if (error instanceof BrokerReconnectRequiredError) {
    return brokerError(403, PERSONAL_GITHUB_RECONNECT_MESSAGE);
  }
  if (error instanceof BrokerProviderUnavailableError) {
    return brokerError(502, "GitHub is temporarily unavailable. Try again.");
  }
  return brokerError(401, "Git broker authorization is no longer current.");
}

async function resolveBrokerAuthority(
  deps: ApiRouteDeps,
  secret: string,
  claims: PersonalGitHubGitBrokerClaims,
  routeId: string,
): Promise<BrokerAuthority> {
  const { delegation, initiator } = await resolvePersonalGitHubPassTurn(deps, claims);
  const repository = exactRouteRepository(secret, claims, delegation, routeId);
  const providerIdentity = await assertCurrentConnectionAndSelection(deps, claims, repository);
  const session = await getSessionGitHubGatewayState(deps.db, claims.workspaceId, claims.sessionId);
  return {
    claims,
    repository,
    ...providerIdentity,
    identity: { claims, initiator, unattended: session?.unattended ?? false },
  };
}

/**
 * The accepted turn and personal GitHub delegation a broker pass was minted
 * for, when they are still current. Throws otherwise.
 */
export async function resolvePersonalGitHubPassTurn(
  deps: ApiRouteDeps,
  claims: PersonalGitHubGitBrokerClaims,
): Promise<{
  delegation: McpPersonalConnectionDelegation;
  initiator: ConnectorActionAttemptIdentity["initiator"];
}> {
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
  return {
    delegation,
    initiator: { kind: turn.initiator.kind, subjectId: turn.initiator.subjectId },
  };
}

async function authorizeBrokerProviderRequest(
  deps: ApiRouteDeps,
  authority: BrokerAuthority,
  destinationUrl: string,
  operation: "identity_verify" | "repository_verify" | BrokerOperation,
): Promise<string> {
  const { claims, repository } = authority;
  return await authorizePersonalGitHubProviderRequest(deps, {
    claims,
    providerPrincipalId: authority.providerPrincipalId,
    destinationUrl,
    toolName: `git_${operation}`,
    // Re-read every mutable connection/repository fence before this physical
    // provider request. A previous request's successful check grants nothing to
    // this one.
    recheck: async () => await assertCurrentConnectionAndSelection(deps, claims, repository),
  });
}

/**
 * The `Authorization` header for one physical GitHub request with the
 * person's token, after `recheck` confirmed the caller's authority is still
 * current (before and after token resolution). The token never leaves the
 * API process.
 */
export async function authorizePersonalGitHubProviderRequest(
  deps: ApiRouteDeps,
  input: {
    claims: PersonalGitHubGitBrokerClaims;
    providerPrincipalId: string;
    destinationUrl: string;
    toolName: string;
    recheck: () => Promise<{ providerPrincipalId: string }>;
  },
): Promise<string> {
  const { claims } = input;
  const currentIdentity = await input.recheck();
  if (currentIdentity.providerPrincipalId !== input.providerPrincipalId) {
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
    toolName: input.toolName,
    connectionRef: {
      connectionId: claims.connectionId,
      provider: "github",
      providerDomain: PERSONAL_GITHUB_PROVIDER_DOMAIN,
      kind: "oauth2",
      subjectScope: "subject",
      scopes: ["repo"],
    },
    destinationUrl: input.destinationUrl,
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
    // A refused refresh has just moved the connection to needs_reauth; say so.
    await input.recheck();
    // Still current and active: the refresh failed for a passing reason, so
    // Git hears "try again", not that its authorization ended.
    if (credential.status !== "ok" && credential.reason === "refresh_failed") {
      throw new BrokerProviderUnavailableError();
    }
    throw new Error("personal GitHub credential resolution was denied");
  }
  await input.recheck();
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
  // Session membership is live authority: a repository removed from the chat
  // (or from the parent chat of this child) stops on its next Git request,
  // even for a turn or goal continuation that captured an older snapshot.
  const sessionResources = await getSessionResourcesForAuthority(
    deps.db,
    claims.workspaceId,
    claims.sessionId,
  );
  if (!sessionResources || !resourcesIncludeRepository(sessionResources, repository.canonicalUrl)) {
    throw new BrokerRepositoryRemovedError();
  }
  const { selection, metadata } = await assertCurrentPersonalGitHubConnection(deps, claims);
  const current = selection.repositories.find(
    (candidate) => candidate.repositoryId === repository.repositoryId,
  );
  if (
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
  return {
    providerPrincipalId: metadata.providerPrincipalId,
  };
}

/**
 * The person's GitHub connection and live repository selection behind a
 * broker pass, when the connection is still the active one the pass was
 * minted for. Throws {@link BrokerReconnectRequiredError} when GitHub refused
 * the stored grant.
 */
export async function assertCurrentPersonalGitHubConnection(
  deps: ApiRouteDeps,
  claims: PersonalGitHubGitBrokerClaims,
): Promise<{
  providerPrincipalId: string;
  metadata: PersonalGitHubConnectionMetadata;
  selection: PersonalGitHubRepositorySelectionState;
}> {
  const connection = await getConnectionMetadata(
    deps.db,
    claims.originWorkspaceId,
    claims.connectionId,
    claims.ownerSubjectId,
  );
  if (
    connection &&
    connection.accountId === claims.accountId &&
    connection.workspaceId === claims.originWorkspaceId &&
    connection.subjectId === claims.ownerSubjectId &&
    personalGitHubConnectionNeedsReconnect(connection) &&
    PersonalGitHubConnectionMetadata.safeParse(connection.metadata).data?.credentialBindingId ===
      claims.credentialBindingId
  ) {
    throw new BrokerReconnectRequiredError();
  }
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
  if (
    !selection ||
    selection.connectionAuthorityGeneration !== claims.connectionAuthorityGeneration ||
    selection.credentialBindingId !== claims.credentialBindingId ||
    selection.credentialBindingId !== metadata.credentialBindingId ||
    selection.providerPrincipalId !== metadata.providerPrincipalId
  ) {
    throw new Error("personal GitHub repository selection changed");
  }
  if (metadata.githubUserId !== metadata.providerPrincipalId) {
    throw new Error("personal GitHub provider identity changed");
  }
  return { providerPrincipalId: metadata.providerPrincipalId, metadata, selection };
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

export async function fetchLiveGitHubJson(
  fetchImpl: typeof fetch,
  url: URL,
  authorization: string,
  maxBytes = GITHUB_API_RESPONSE_MAX_BYTES,
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": "Opengeni",
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
      await readResponseTextBounded(response, maxBytes, "GitHub response"),
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

/** `source`, ending with an error once `signal` aborts (a stalled client). */
function abortableStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("Git client stopped sending"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await Promise.race([reader.read(), aborted]);
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
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

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
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
    headers.set("www-authenticate", 'Basic realm="Opengeni Git broker", charset="UTF-8"');
  }
  return new Response(`${message}\n`, {
    status,
    headers,
  });
}
