import type { Settings } from "@opengeni/config";
import {
  buildConnectionTokenResolver,
  resolveAcceptedConnectionUse,
  sessionTenancyProductActivated,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type SessionTurnForExecution,
} from "@opengeni/db";
import { recordTenancyCompatibilityLaneUse, type Observability } from "@opengeni/observability";
import { mcpOperationAuthorityDigest } from "./mcp-operation-authority";

type TurnConnectionInput = {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  turn: SessionTurnForExecution;
  authorizeAcceptedUse?: typeof resolveAcceptedConnectionUse;
  /** Test seam for the activation fence on pre-snapshot workspace refs. */
  isSessionTenancyProductActivated?: typeof sessionTenancyProductActivated;
  /** Optional; used only for content-free compatibility-lane counters. */
  observability?: Observability | null | undefined;
};

type CredentialResolver = (
  request: ResolveConnectionCredentialInput,
) => Promise<ResolveConnectionCredentialResult>;

export function connectionTokenResolverForTurn(input: TurnConnectionInput): CredentialResolver {
  return bindNativeConnectionCredentialsToTurn(
    input,
    buildConnectionTokenResolver(input.db, input.settings),
  );
}

/** Bind the ordinary credential resolver to one immutable accepted turn.
 * Credential acquisition and refresh stay inside the native connection engine;
 * this layer adds the exact execution context and physical-request checks. */
export function bindNativeConnectionCredentialsToTurn(
  input: TurnConnectionInput,
  nativeResolver: CredentialResolver,
): CredentialResolver {
  const recoveryEnabled = (serverId: string) =>
    input.settings.mcpServers.some(
      (server) =>
        server.id === serverId &&
        "operationRecovery" in server &&
        server.operationRecovery !== undefined &&
        Object.keys(server.operationRecovery ?? {}).length > 0,
    );
  return async (request) => {
    // Superseded host references must never fall through to native lookup,
    // even when their opaque identifier happens to be a valid native UUID.
    if (request.connectionRef.authoritySource === "host") {
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
      return await nativeResolver(request);
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
    // The native resolver returns the scope it actually authorized.
    const recordAuthorizedScope = (scope: "workspace" | "user" | "legacy_user" | undefined) => {
      if (scope === "legacy_user") {
        recordTenancyCompatibilityLaneUse(input.observability, "connection_legacy_user");
      }
    };
    const result = await nativeResolver({
      ...request,
      connectionUseContext: credentialUseContext,
    });
    if (result.status === "ok") recordAuthorizedScope(result.connectionUseAttribution?.scope);
    return withProviderRequestAuthorization(result);
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
