import type { Settings } from "@opengeni/config";
import {
  type ConnectionCredentialsPort,
  type GitCredentialRepositoryRef,
  type McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import {
  isPersonalGitHubConnection,
  PersonalGitHubConnectionMetadata,
} from "@opengeni/contracts/personal-github";
import {
  getConnectionMetadata,
  getPersonalGitHubRepositorySelectionState,
  getSessionAuthorityProjection,
  getSessionTurnForAttempt,
  resolveAcceptedConnectionUse,
  type Database,
} from "@opengeni/db";
import {
  PERSONAL_GITHUB_GIT_BROKER_TOKEN_TTL_SECONDS,
  personalGitHubGitBrokerRouteId,
  sealPersonalGitHubGitBrokerClaims,
  type PersonalGitHubGitBrokerClaims,
  type PersonalGitHubGitBrokerRepositoryClaim,
} from "@opengeni/github";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const PERSONAL_GITHUB_SERVER_ID = "github:personal";

/**
 * Build the standalone personal-GitHub credential consumer. It returns only an
 * OpenGeni broker bearer: the broad provider OAuth token remains encrypted in
 * the API/database process and never crosses into a sandbox or worker result.
 */
export function buildPersonalGitHubGitCredentials(
  db: Database,
  settings: Settings,
): NonNullable<ConnectionCredentialsPort["gitCredentials"]> | null {
  if (!settings.githubPersonalOauthEnabled) return null;
  const secret = settings.integrationsStateSecret?.trim();
  const publicOrigin = personalGitBrokerOrigin(settings.publicBaseUrl);
  if (!secret || !publicOrigin) {
    throw new Error("personal GitHub Git broker configuration is unavailable");
  }

  return async (request) => {
    if (request.provider && request.provider !== "github") {
      throw new Error("personal GitHub Git broker accepts only GitHub repositories");
    }
    if (!request.credentialBindingId || !request.repositoryRefs?.length) {
      throw new Error("personal GitHub Git broker requires one exact credential binding");
    }
    const turn = await getSessionTurnForAttempt(
      db,
      request.workspaceId,
      request.sessionId,
      request.attemptId,
    );
    const session = await getSessionAuthorityProjection(db, request.workspaceId, request.sessionId);
    if (
      !turn ||
      !session ||
      turn.id !== request.turnId ||
      turn.executionGeneration !== request.executionGeneration ||
      !isDeepStrictEqual(turn.initiator, request.initiator) ||
      !isDeepStrictEqual(turn.initiatorContext, request.initiatorContext) ||
      session.rootSessionId !== request.rootSessionId
    ) {
      throw new Error("personal GitHub Git credential authority is no longer current");
    }
    const delegation = exactPersonalGitHubDelegation(
      turn.personalConnectionDelegations,
      request.credentialBindingId,
    );
    const snapshot = delegation.personalGitHubRepositorySelection!;
    const repositories = exactRequestedRepositories(
      request.repositoryRefs,
      snapshot.credentialBindingId,
      snapshot.repositories,
    );

    const resolution = await resolveAcceptedConnectionUse(db, {
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      executionGeneration: request.executionGeneration,
      physicalRequestId: randomUUID(),
      usePhase: "credential_resolution",
      serverId: PERSONAL_GITHUB_SERVER_ID,
      connectionId: delegation.connectionId,
      providerDomain: "github.com",
      connectionKind: "oauth2",
      subjectScope: "subject",
      ownerSubjectId: delegation.ownerSubjectId,
    });
    if (
      resolution.status !== "authorized" ||
      resolution.originWorkspaceId !== delegation.originWorkspaceId ||
      resolution.attribution.connectionId !== delegation.connectionId ||
      resolution.attribution.connectionGeneration !== snapshot.connectionAuthorityGeneration ||
      resolution.attribution.ownerSubjectId !== delegation.ownerSubjectId
    ) {
      throw new Error("personal GitHub Git connection authority is no longer current");
    }

    const connection = await getConnectionMetadata(
      db,
      delegation.originWorkspaceId!,
      delegation.connectionId,
      delegation.ownerSubjectId,
    );
    if (
      !connection ||
      connection.accountId !== request.accountId ||
      connection.workspaceId !== delegation.originWorkspaceId ||
      connection.subjectId !== delegation.ownerSubjectId ||
      connection.status !== "active" ||
      // connections.version is credential-refresh CAS, not use authority.
      // resolveAcceptedConnectionUse above fences the independent common
      // connection-authority generation carried by the accepted snapshot.
      connection.grantedScopes.length !== 1 ||
      connection.grantedScopes[0] !== "repo" ||
      !isPersonalGitHubConnection(connection)
    ) {
      throw new Error("personal GitHub Git connection is unavailable");
    }
    const metadata = PersonalGitHubConnectionMetadata.parse(connection.metadata);
    const currentSelection = await getPersonalGitHubRepositorySelectionState(db, {
      accountId: request.accountId,
      originWorkspaceId: delegation.originWorkspaceId!,
      subjectId: delegation.ownerSubjectId,
      connectionId: delegation.connectionId,
    });
    if (
      !currentSelection ||
      currentSelection.connectionAuthorityGeneration !== snapshot.connectionAuthorityGeneration ||
      currentSelection.selectionGeneration !== snapshot.selectionGeneration ||
      currentSelection.credentialBindingId !== snapshot.credentialBindingId ||
      currentSelection.credentialBindingId !== metadata.credentialBindingId ||
      currentSelection.providerPrincipalId !== metadata.providerPrincipalId ||
      metadata.githubUserId !== metadata.providerPrincipalId
    ) {
      throw new Error("personal GitHub repository authority changed");
    }
    const currentById = new Map(
      currentSelection.repositories.map((repository) => [repository.repositoryId, repository]),
    );
    for (const repository of repositories) {
      const current = currentById.get(repository.repositoryId);
      if (
        !current ||
        current.fullName !== repository.fullName ||
        current.canonicalUrl !== repository.canonicalUrl ||
        current.selectionGeneration !== repository.selectionGeneration ||
        current.disabled ||
        (repository.access === "write" &&
          (current.selectedAccess !== "write" ||
            current.archived ||
            !personalGitHubCanWrite(current.permissions))) ||
        !personalGitHubCanRead(current.permissions)
      ) {
        throw new Error("personal GitHub repository authority changed");
      }
    }

    const identity = {
      name: metadata.githubLogin,
      email: `${metadata.githubUserId}+${metadata.githubLogin}@users.noreply.github.com`,
    };
    if (request.purpose === "identity") {
      return {
        workspaceId: request.workspaceId,
        credentialBindingId: request.credentialBindingId,
        provider: "github",
        providerHost: "github.com",
        identity,
      };
    }

    const now = Math.floor(Date.now() / 1_000);
    const baseClaims = {
      version: 1 as const,
      accountId: request.accountId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      rootSessionId: request.rootSessionId,
      turnId: request.turnId,
      attemptId: request.attemptId,
      executionGeneration: request.executionGeneration,
      originWorkspaceId: delegation.originWorkspaceId!,
      connectionId: delegation.connectionId,
      connectionAuthorityGeneration: snapshot.connectionAuthorityGeneration,
      ownerSubjectId: delegation.ownerSubjectId,
      credentialBindingId: snapshot.credentialBindingId,
      selectionGeneration: snapshot.selectionGeneration,
    };
    const repositoryClaims: PersonalGitHubGitBrokerRepositoryClaim[] = repositories.map(
      (repository) => ({
        ...repository,
        routeId: personalGitHubGitBrokerRouteId(secret, {
          ...baseClaims,
          repository,
        }),
      }),
    );
    const claims: PersonalGitHubGitBrokerClaims = {
      ...baseClaims,
      nonce: randomBytes(24).toString("base64url"),
      issuedAt: now,
      expiresAt: now + PERSONAL_GITHUB_GIT_BROKER_TOKEN_TTL_SECONDS,
    };
    return {
      token: sealPersonalGitHubGitBrokerClaims(secret, claims),
      expiresAt: new Date(claims.expiresAt * 1_000).toISOString(),
      workspaceId: request.workspaceId,
      credentialBindingId: request.credentialBindingId,
      provider: "github",
      providerHost: "github.com",
      identity,
      transport: {
        kind: "http_broker",
        repositories: repositoryClaims.map((repository) => ({
          repositoryUri: repository.canonicalUrl,
          brokerUri: `${publicOrigin}/v1/git/personal/${repository.routeId}`,
        })),
      },
    };
  };
}

function personalGitHubCanRead(permissions: {
  pull: boolean;
  triage: boolean;
  push: boolean;
  maintain: boolean;
  admin: boolean;
}): boolean {
  return (
    permissions.pull ||
    permissions.triage ||
    permissions.push ||
    permissions.maintain ||
    permissions.admin
  );
}

function personalGitHubCanWrite(permissions: {
  push: boolean;
  maintain: boolean;
  admin: boolean;
}): boolean {
  return permissions.push || permissions.maintain || permissions.admin;
}

function personalGitBrokerOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.origin;
}

function exactPersonalGitHubDelegation(
  delegations: McpPersonalConnectionDelegation[],
  credentialBindingId: string,
): McpPersonalConnectionDelegation {
  const matches = delegations.filter(
    (delegation) =>
      delegation.serverId === PERSONAL_GITHUB_SERVER_ID &&
      delegation.connectionType === "github_personal" &&
      delegation.personalGitHubRepositorySelection?.credentialBindingId === credentialBindingId,
  );
  const delegation = matches[0];
  if (
    matches.length !== 1 ||
    !delegation ||
    delegation.providerDomain !== "github.com" ||
    delegation.kind !== "oauth2" ||
    !delegation.originWorkspaceId ||
    !delegation.userDelegation ||
    !delegation.personalGitHubRepositorySelection
  ) {
    throw new Error("personal GitHub Git delegation is unavailable");
  }
  return delegation;
}

function exactRequestedRepositories(
  refs: GitCredentialRepositoryRef[],
  credentialBindingId: string,
  snapshots: NonNullable<
    McpPersonalConnectionDelegation["personalGitHubRepositorySelection"]
  >["repositories"],
): Array<Omit<PersonalGitHubGitBrokerRepositoryClaim, "routeId">> {
  if (refs.length !== snapshots.length) {
    throw new Error("personal GitHub Git request does not match the accepted repository set");
  }
  const byCanonicalUrl = new Map(
    snapshots.map((repository) => [repository.canonicalUrl, repository]),
  );
  const seen = new Set<string>();
  return refs.map((ref) => {
    const snapshot = byCanonicalUrl.get(ref.uri);
    if (
      !snapshot ||
      seen.has(ref.uri) ||
      ref.provider !== "github" ||
      ref.credentialBindingId !== credentialBindingId ||
      ref.connectionId !== undefined ||
      ref.installationId !== undefined ||
      String(ref.repositoryId) !== snapshot.repositoryId ||
      ref.ref !== snapshot.ref ||
      ref.access !== snapshot.access
    ) {
      throw new Error("personal GitHub Git request exceeds the accepted repository authority");
    }
    seen.add(ref.uri);
    return snapshot;
  });
}
