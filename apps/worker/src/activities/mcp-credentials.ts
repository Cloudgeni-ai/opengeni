import type { Settings } from "@opengeni/config";
import type { ConnectionCredentialsPort } from "@opengeni/contracts";
import type { HostMcpAcceptedAuthority } from "@opengeni/contracts/host-mcp-bindings";
import {
  buildConnectionTokenResolver,
  buildHostConnectionTokenResolver,
  getSessionTurnForAttempt,
  authorizeDirectHostMcpUse,
  resolveAcceptedHostMcpBinding,
  resolveAcceptedConnectionUse,
  sessionTenancyProductActivated,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type SessionTurnForExecution,
} from "@opengeni/db";
import { recordTenancyCompatibilityLaneUse, type Observability } from "@opengeni/observability";
import { mcpOperationAuthorityDigest } from "./mcp-operation-authority";

const OPENGENI_CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function connectionTokenResolverForTurn(input: {
  db: Database;
  settings: Settings;
  connectionCredentials?: ConnectionCredentialsPort | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  attemptId: string;
  turn: SessionTurnForExecution;
  authorizeAcceptedUse?: typeof resolveAcceptedConnectionUse;
  /** Test seam; production always reads the canonical active-attempt projection. */
  getHostTurnForAttempt?: typeof getSessionTurnForAttempt;
  /** Test seam for the activation fence on pre-snapshot workspace refs. */
  isSessionTenancyProductActivated?: typeof sessionTenancyProductActivated;
  /** Optional; used only for content-free compatibility-lane counters. */
  observability?: Observability | null | undefined;
}): (request: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult> {
  const hostResolver = input.connectionCredentials?.mcpCredentials;
  const readHostTurn = input.getHostTurnForAttempt ?? getSessionTurnForAttempt;
  const hostDb = input.db;
  const nativeResolver = buildConnectionTokenResolver(input.db, input.settings);
  const recoveryEnabled = (serverId: string) =>
    input.settings.mcpServers.some(
      (server) =>
        server.id === serverId &&
        "operationRecovery" in server &&
        server.operationRecovery !== undefined &&
        Object.keys(server.operationRecovery ?? {}).length > 0,
    );
  const configuredResolver = hostResolver
    ? async (
        credentialRequest: ResolveConnectionCredentialInput,
      ): Promise<ResolveConnectionCredentialResult> => {
        let authorizedSnapshot: HostMcpAcceptedAuthority | undefined;
        const wantsDigest = recoveryEnabled(credentialRequest.serverId);
        const resolver = buildHostConnectionTokenResolver(hostResolver, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          rootSessionId: input.rootSessionId,
          turnId: input.turn.id,
          attemptId: input.attemptId,
          executionGeneration: input.turn.executionGeneration,
          initiator: input.turn.initiator,
          initiatorContext: input.turn.initiatorContext,
          surface: "model",
          resolveAcceptedBinding: (request) => resolveAcceptedHostMcpBinding(hostDb, request),
          // Only immutable captured direct-turn authority is currently supported.
          // Direct, scheduled and exact causal/child snapshots are validated;
          // no authority follows merely from a binding or creator identity.
          authorizeDurableBinding: (request) =>
            authorizeDirectHostMcpUse(
              hostDb,
              request,
              wantsDigest
                ? (snapshot) => {
                    authorizedSnapshot = snapshot;
                  }
                : undefined,
            ),
          authorizeExecution: async (request) => {
            // Native UUID references already pass the accepted-use boundary below.
            // Legacy opaque host IDs retain their compatibility path, but not a
            // right to execute after their accepted attempt has stopped.
            if (
              request.connectionRef.authoritySource !== "host" &&
              (!request.connectionRef.connectionId ||
                OPENGENI_CONNECTION_ID_PATTERN.test(request.connectionRef.connectionId))
            )
              return true;
            if (!request.attemptId) return false;
            const current = await readHostTurn(
              hostDb,
              request.workspaceId,
              request.sessionId,
              request.attemptId,
            );
            return (
              current !== null &&
              current.id === request.turnId &&
              current.executionGeneration === request.executionGeneration
            );
          },
        });
        const result = await resolver(credentialRequest);
        return result.status === "ok" && authorizedSnapshot
          ? {
              ...result,
              operationAuthorityDigest: mcpOperationAuthorityDigest(credentialRequest, {
                host: authorizedSnapshot,
              }),
            }
          : result;
      }
    : nativeResolver;
  const baseResolver = (request: ResolveConnectionCredentialInput) =>
    input.connectionCredentials?.mcpAuthoritySource === "host" &&
    request.connectionRef.authoritySource !== "host"
      ? nativeResolver(request)
      : configuredResolver(request);
  return async (request) => {
    // Host-owned refs carry explicit provenance because their opaque ids may
    // themselves be valid UUIDs. They never enter OpenGeni's native connection
    // authority or PostgreSQL UUID lookup; the bound host authorizes the exact
    // immutable turn context on every credential request.
    if (request.connectionRef.authoritySource === "host") {
      if (hostResolver) return await baseResolver(request);
      return {
        status: "auth_needed",
        reason: "unsupported_auth",
        providerDomain: request.connectionRef.providerDomain,
        authoritySource: "host",
        ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
        ...(request.connectionRef.connectionId
          ? { connectionId: request.connectionRef.connectionId }
          : {}),
        ...(request.connectionRef.scopes ? { scopes: request.connectionRef.scopes } : {}),
        ...(request.connectionRef.resource ? { resource: request.connectionRef.resource } : {}),
        ...(request.connectionRef.selectedResources
          ? { selectedResources: request.connectionRef.selectedResources }
          : {}),
      };
    }
    // Before explicit provenance existed, the public embedding contract let a
    // bound host use any non-UUID opaque id. Preserve those frozen/stored refs
    // during upgrades while keeping every UUID-shaped omission on OpenGeni's
    // native accepted-use authority. New host refs must carry authoritySource
    // so UUID-shaped host ids are unambiguous.
    if (
      hostResolver &&
      input.connectionCredentials?.mcpAuthoritySource !== "host" &&
      request.connectionRef.connectionId &&
      !OPENGENI_CONNECTION_ID_PATTERN.test(request.connectionRef.connectionId)
    ) {
      try {
        return await baseResolver(request);
      } catch {
        return {
          status: "auth_needed",
          reason: "refresh_failed",
          providerDomain: request.connectionRef.providerDomain,
          authoritySource: "host",
          ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
          connectionId: request.connectionRef.connectionId,
          ...(request.connectionRef.scopes ? { scopes: request.connectionRef.scopes } : {}),
          ...(request.connectionRef.resource ? { resource: request.connectionRef.resource } : {}),
          ...(request.connectionRef.selectedResources
            ? { selectedResources: request.connectionRef.selectedResources }
            : {}),
        };
      }
    }
    const acceptedDelegation = input.turn.personalConnectionDelegations.find(
      (delegation) =>
        (delegation.connectionType === undefined ||
          delegation.connectionType === "mcp" ||
          (delegation.connectionType === "github_personal" &&
            delegation.serverId === "github:personal" &&
            request.serverId === "github:personal" &&
            request.connectionRef.provider === "github" &&
            request.connectionRef.kind === "oauth2" &&
            request.connectionRef.providerDomain === "github.com" &&
            request.credentialTarget === "http_api" &&
            isGitHubApiDestination(request.destinationUrl))) &&
        delegation.serverId === request.serverId &&
        delegation.connectionId === request.connectionRef.connectionId,
    );
    const subjectScope: "subject" | "workspace" =
      request.connectionRef.subjectScope === "subject" ? "subject" : "workspace";
    // Every subject-scoped request must match an exact connection frozen on the
    // accepted turn. This also hard-fences pre-cutover common-user turns that
    // lack a userDelegation: the DB resolver denies those rows because only a
    // true legacy_user connection is eligible for bounded compatibility.
    if (
      subjectScope === "subject" &&
      (!acceptedDelegation || !request.connectionRef.connectionId)
    ) {
      return {
        status: "auth_needed",
        reason: "personal_authority_unavailable",
        providerDomain: request.connectionRef.providerDomain,
        ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
      };
    }
    // Workspace-scope requests now run through the same accepted-use authority
    // (migration 0279): the exact workspace-owned connection is revalidated
    // inside the canonical lifecycle fences and every use leaves an idempotent
    // audit fact. A ref with no connection id is the bounded pre-snapshot
    // legacy path - it cannot be authorized by exact identity, so it keeps the
    // unprivileged resolution the old short-circuit used.
    if (subjectScope === "workspace" && !request.connectionRef.connectionId) {
      if (
        await (input.isSessionTenancyProductActivated ?? sessionTenancyProductActivated)(
          input.db,
          input.workspaceId,
        )
      ) {
        return {
          status: "auth_needed",
          reason: "missing_connection",
          providerDomain: request.connectionRef.providerDomain,
          ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
        };
      }
      // This lane writes no `connection_use_audit_facts` row, so this counter is
      // the only evidence it was taken. Lane name only - never the server,
      // provider domain, connection, or subject.
      recordTenancyCompatibilityLaneUse(input.observability, "connection_pre_snapshot_ref");
      return await baseResolver(request);
    }
    const credentialUseContext = {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turn.id,
      attemptId: input.attemptId,
      executionGeneration: input.turn.executionGeneration,
      physicalRequestId: crypto.randomUUID(),
      usePhase: "credential_resolution" as const,
    };
    const authorityBinding = {
      serverId: request.serverId,
      // Both lane guards above require an exact connection id at this point.
      ...(request.connectionRef.connectionId
        ? { connectionId: request.connectionRef.connectionId }
        : {}),
      providerDomain: request.connectionRef.providerDomain,
      ...(request.connectionRef.kind ? { connectionKind: request.connectionRef.kind } : {}),
      subjectScope,
      ...(subjectScope === "subject" && request.subjectId
        ? { ownerSubjectId: request.subjectId }
        : {}),
    };
    const authorize = async (
      context: Omit<typeof credentialUseContext, "usePhase"> & {
        usePhase: "credential_resolution" | "provider_request";
      },
    ) =>
      await (input.authorizeAcceptedUse ?? resolveAcceptedConnectionUse)(input.db, {
        ...context,
        ...authorityBinding,
      });
    const withProviderRequestAuthorization = (
      result: ResolveConnectionCredentialResult,
      attribution = result.status === "ok" ? result.connectionUseAttribution : undefined,
    ): ResolveConnectionCredentialResult => {
      if (result.status !== "ok") return result;
      return {
        ...result,
        ...(attribution && recoveryEnabled(request.serverId)
          ? {
              operationAuthorityDigest: mcpOperationAuthorityDigest(request, {
                native: attribution,
                // Match the canonical DB recovery principal: a causal human
                // survives goal/service continuations. These fields come from
                // the accepted turn, never request.subjectId or caller JSON.
                principal: input.turn.initiatingHumanSubjectId
                  ? { kind: "subject", subjectId: input.turn.initiatingHumanSubjectId }
                  : {
                      kind: input.turn.initiator.kind,
                      ...(input.turn.initiator.kind === "subject" ||
                      input.turn.initiator.kind === "service"
                        ? { subjectId: input.turn.initiator.subjectId }
                        : {}),
                    },
              }),
            }
          : {}),
        authorizeProviderRequest: async () => {
          const authorization = await authorize({
            ...credentialUseContext,
            physicalRequestId: crypto.randomUUID(),
            usePhase: "provider_request",
          });
          return authorization.status === "authorized";
        },
      };
    };
    // One place records the `legacy_user` lane for both resolution paths: the
    // scope comes back on the resolver result when the DB resolver authorized
    // internally, and on the resolution itself when the host resolver did.
    const recordAuthorizedScope = (scope: "workspace" | "user" | "legacy_user" | undefined) => {
      if (scope === "legacy_user") {
        recordTenancyCompatibilityLaneUse(input.observability, "connection_legacy_user");
      }
    };
    if (!hostResolver) {
      const result = await baseResolver({
        ...request,
        connectionUseContext: credentialUseContext,
      });
      if (result.status === "ok") recordAuthorizedScope(result.connectionUseAttribution?.scope);
      return withProviderRequestAuthorization(result);
    }
    const authorization = await authorize(credentialUseContext);
    if (authorization.status === "denied") {
      return {
        status: "auth_needed",
        reason:
          request.connectionRef.subjectScope === "subject"
            ? "personal_authority_unavailable"
            : "missing_connection",
        providerDomain: request.connectionRef.providerDomain,
        ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
      };
    }
    recordAuthorizedScope(authorization.attribution.scope);
    const result = await baseResolver({
      ...request,
      connectionUseContext: credentialUseContext,
      connectionUseAuthority: authorization.attribution,
      connectionRef: {
        ...request.connectionRef,
        connectionId: authorization.attribution.connectionId,
        kind: authorization.connectionKind,
        subjectScope: authorization.attribution.scope === "workspace" ? "workspace" : "subject",
      },
      ...(authorization.attribution.ownerSubjectId
        ? { subjectId: authorization.attribution.ownerSubjectId }
        : {}),
    });
    return withProviderRequestAuthorization(result, authorization.attribution);
  };
}

function isGitHubApiDestination(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === "https://api.github.com" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
