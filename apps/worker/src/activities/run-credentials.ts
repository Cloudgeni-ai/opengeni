import type {
  ConnectionCredentialsPort,
  CredentialAuthNeededPayload,
  SandboxBackend,
  RunCredentialsRequest,
  Session,
  SessionTurn,
} from "@opengeni/contracts";
import { getSessionRootId, type Database } from "@opengeni/db";
import {
  normalizeRunCredentialsResolution,
  type NormalizedRunCredentialMaterial,
} from "@opengeni/runtime";

export type RunCredentialResolutionContext = {
  db: Database;
  connectionCredentials?: ConnectionCredentialsPort | null;
  accountId: string;
  workspaceId: string;
  session: Session;
  turn: SessionTurn;
  attemptId: string;
  effectiveSandboxBackend: SandboxBackend;
  variableSet: { id: string; name: string } | null;
};

export type BoundRunCredentialResolver = {
  resolve(input: {
    purpose: "provision" | "renewal";
    forceRefresh: boolean;
  }): Promise<NormalizedRunCredentialMaterial | null>;
};

export function buildRunCredentialsRequest(
  input: Omit<RunCredentialResolutionContext, "db" | "connectionCredentials"> & {
    rootSessionId: string;
    purpose: "provision" | "renewal";
    forceRefresh: boolean;
  },
): RunCredentialsRequest {
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.session.id,
    parentSessionId: input.session.parentSessionId,
    rootSessionId: input.rootSessionId,
    sandboxGroupId: input.session.sandboxGroupId,
    turnId: input.turn.id,
    attemptId: input.attemptId,
    executionGeneration: input.turn.executionGeneration,
    initiator: input.turn.initiator,
    initiatorContext: input.turn.initiatorContext,
    effectiveSandboxBackend: input.effectiveSandboxBackend,
    sandboxOs: input.turn.sandboxOs ?? input.session.sandboxOs,
    purpose: input.purpose,
    forceRefresh: input.forceRefresh,
    variableSet: input.variableSet,
  };
}

export function runCredentialAuthNeededPayloads(
  material: NormalizedRunCredentialMaterial,
): CredentialAuthNeededPayload[] {
  return material.authNeeded.map((notice) => ({
    credentialClass: "run",
    reason: notice.reason,
    ...(notice.providerDomain ? { providerDomain: notice.providerDomain } : {}),
    ...(notice.connectionId ? { connectionId: notice.connectionId } : {}),
    ...(notice.scopes?.length ? { scopes: notice.scopes } : {}),
    ...(notice.resource ? { resource: notice.resource } : {}),
    ...(notice.authorizationUrl ? { authorizationUrl: notice.authorizationUrl } : {}),
    ...(notice.message ? { message: notice.message } : {}),
  }));
}

export function runCredentialModelNote(
  material: NormalizedRunCredentialMaterial,
): string | undefined {
  if (material.authNeeded.length === 0) return undefined;
  return [
    "[OpenGeni connected-service status]",
    "One or more host-managed credentials need user attention. Continue with available capabilities, but do not claim the affected service is usable until it is reconnected.",
    JSON.stringify({
      credentials: material.authNeeded.map((notice) => ({
        reason: notice.reason,
        ...(notice.providerDomain ? { providerDomain: notice.providerDomain } : {}),
        ...(notice.resource ? { resource: notice.resource } : {}),
        ...(notice.message ? { message: notice.message } : {}),
      })),
    }),
  ].join("\n");
}

/**
 * Freeze the provider-neutral host credential request to this exact admitted
 * turn. The host selects connections and material; the worker never infers a
 * provider from repositories, environment names, or an OpenGeni variable set.
 */
export async function bindRunCredentialResolver(
  input: RunCredentialResolutionContext,
): Promise<BoundRunCredentialResolver | null> {
  const resolver = input.connectionCredentials?.runCredentials;
  if (!resolver) return null;
  const rootSessionId = await getSessionRootId(input.db, input.workspaceId, input.session.id);
  if (!rootSessionId) {
    throw new Error(`cannot resolve run credentials for missing session ${input.session.id}`);
  }
  const scope = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.session.id,
  };
  return {
    resolve: async ({ purpose, forceRefresh }) => {
      const resolution = await resolver(
        buildRunCredentialsRequest({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          session: input.session,
          turn: input.turn,
          attemptId: input.attemptId,
          effectiveSandboxBackend: input.effectiveSandboxBackend,
          variableSet: input.variableSet,
          rootSessionId,
          purpose,
          forceRefresh,
        }),
      );
      return normalizeRunCredentialsResolution(resolution, scope);
    },
  };
}
