import type { Settings } from "@opengeni/config";
import type { ConnectionCredentialsPort } from "@opengeni/contracts";
import {
  buildConnectionTokenResolver,
  buildHostConnectionTokenResolver,
  resolveAcceptedConnectionUse,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type SessionTurnForExecution,
} from "@opengeni/db";

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
}): (request: ResolveConnectionCredentialInput) => Promise<ResolveConnectionCredentialResult> {
  const hostResolver = input.connectionCredentials?.mcpCredentials;
  const baseResolver = hostResolver
    ? buildHostConnectionTokenResolver(hostResolver, {
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
        allowOfficialGmailRestDestination: input.settings.gmailRestAdapterEnabled,
      })
    : buildConnectionTokenResolver(input.db, input.settings);
  return async (request) => {
    const acceptedDelegation = input.turn.personalConnectionDelegations.find(
      (delegation) =>
        (delegation.connectionType === undefined || delegation.connectionType === "mcp") &&
        delegation.serverId === request.serverId &&
        delegation.connectionId === request.connectionRef.connectionId,
    );
    const subjectScope = request.connectionRef.subjectScope === "subject" ? "subject" : "workspace";
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
      connectionId: request.connectionRef.connectionId,
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
    ): ResolveConnectionCredentialResult => {
      if (result.status !== "ok") return result;
      return {
        ...result,
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
    if (!hostResolver) {
      const result = await baseResolver({
        ...request,
        connectionUseContext: credentialUseContext,
      });
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
    return withProviderRequestAuthorization(result);
  };
}
