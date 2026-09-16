import type { Settings } from "@opengeni/config";
import {
  buildConnectionTokenResolver,
  resolveAcceptedConnectionUse,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type SessionTurnForExecution,
} from "@opengeni/db";
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
    // accepted turn. The database then checks its immutable sender snapshot.
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
    // Workspace connections also need an exact identity for accepted-use
    // validation and attribution. Never rediscover a credential by domain here.
    if (subjectScope === "workspace" && !request.connectionRef.connectionId) {
      return {
        status: "auth_needed",
        reason: "missing_connection",
        providerDomain: request.connectionRef.providerDomain,
        ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
      };
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
    const result = await nativeResolver({
      ...request,
      connectionUseContext: credentialUseContext,
    });
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
