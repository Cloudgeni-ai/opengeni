import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import type {
  ConnectionCredentialsPort,
  GitCredentials,
  GitCredentialsRequest,
} from "@opengeni/contracts";
import { lensRegistrationIdFromCredentialBinding } from "@opengeni/core";
import { decryptVariableSetValue, resolveLensGitCredential, type Database } from "@opengeni/db";
import {
  createGitHubAppInstallationTokenWithExpiry,
  createGitHubAppInstallationTokenWithSigningSettings,
} from "@opengeni/github";

/** Standalone credential broker for Lens plus the existing GitHub App path.
 * Embedded hosts keep precedence by supplying their own connectionCredentials. */
export function createStandaloneConnectionCredentialsPort(
  settings: Settings,
  db: Database,
): ConnectionCredentialsPort {
  return {
    gitCredentials: async (request) => await resolveStandaloneGitCredentials(settings, db, request),
  };
}

async function resolveStandaloneGitCredentials(
  settings: Settings,
  db: Database,
  request: GitCredentialsRequest,
): Promise<GitCredentials> {
  const provider = request.provider ?? "github";
  const registrationId = request.credentialBindingId
    ? lensRegistrationIdFromCredentialBinding(request.credentialBindingId)
    : null;
  if (!registrationId) {
    if (provider !== "github") {
      throw new Error(`${provider} Git credentials require an explicit Lens or host binding`);
    }
    if (request.purpose === "identity") {
      return { workspaceId: request.workspaceId };
    }
    const minted = await createGitHubAppInstallationTokenWithExpiry(settings, {
      installationId: request.installationId,
      repositoryIds: request.repositoryIds,
    });
    return {
      token: minted.token,
      workspaceId: request.workspaceId,
      ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
    };
  }

  const authority = await resolveLensGitCredential(db, {
    accountId: request.accountId,
    workspaceId: request.workspaceId,
    registrationId,
    provider,
    sessionId: request.sessionId,
    rootSessionId: request.rootSessionId,
    turnId: request.turnId,
    attemptId: request.attemptId,
    executionGeneration: request.executionGeneration,
    repositoryRefs: (request.repositoryRefs ?? []).map((reference) => ({
      uri: reference.uri,
      ...(reference.expectedCommitSha !== undefined
        ? { expectedCommitSha: reference.expectedCommitSha }
        : {}),
      ...(reference.repositoryId !== undefined ? { repositoryId: reference.repositoryId } : {}),
      ...(reference.installationId !== undefined
        ? { installationId: reference.installationId }
        : {}),
      ...(reference.projectId !== undefined ? { projectId: reference.projectId } : {}),
    })),
  });
  const echoes = {
    workspaceId: request.workspaceId,
    ...(request.credentialBindingId ? { credentialBindingId: request.credentialBindingId } : {}),
    provider,
    ...(request.providerHost ? { providerHost: request.providerHost } : {}),
  };
  if (request.purpose === "identity") {
    return authority.credentialKind === "github_app"
      ? {
          ...echoes,
          identity: {
            name: "opengeni-lens[bot]",
            email: `${authority.appId ?? "opengeni-lens"}+opengeni-lens[bot]@users.noreply.github.com`,
          },
        }
      : echoes;
  }
  if (authority.credentialKind === "github_app") {
    assertGitHubMintMatchesRepositoryRefs(request);
    const encryptionKey = environmentsEncryptionKeyBytes(settings);
    if (!encryptionKey || !authority.appId || !authority.credentialEncrypted) {
      throw new Error("Lens GitHub App credential is unavailable");
    }
    const minted = await createGitHubAppInstallationTokenWithSigningSettings(
      {
        githubAppId: authority.appId,
        githubAppPrivateKey: decryptVariableSetValue(encryptionKey, authority.credentialEncrypted),
      },
      {
        installationId: request.installationId,
        repositoryIds: request.repositoryIds,
      },
    );
    return {
      ...echoes,
      token: minted.token,
      ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
    };
  }
  if (authority.expiresAt && Date.parse(authority.expiresAt) <= Date.now()) {
    throw new Error(`Lens ${provider} provider credential has expired`);
  }
  const encryptionKey = environmentsEncryptionKeyBytes(settings);
  if (!encryptionKey || !authority.credentialEncrypted) {
    throw new Error(`Lens ${provider} provider credential is unavailable`);
  }
  return {
    ...echoes,
    token: decryptVariableSetValue(encryptionKey, authority.credentialEncrypted),
    ...(authority.expiresAt ? { expiresAt: authority.expiresAt } : {}),
  };
}

function assertGitHubMintMatchesRepositoryRefs(request: GitCredentialsRequest): void {
  const refs = request.repositoryRefs ?? [];
  const repositoryIds = refs.map((reference) => positiveInteger(reference.repositoryId));
  const installationIds = refs.map((reference) => positiveInteger(reference.installationId));
  if (
    repositoryIds.some((value) => value === null) ||
    installationIds.some((value) => value === null)
  ) {
    throw new Error("Lens GitHub credential request lacks exact repository authority");
  }
  const exactRepositoryIds = [...new Set(repositoryIds as number[])].sort(
    (left, right) => left - right,
  );
  const requestedRepositoryIds = [...new Set(request.repositoryIds)].sort(
    (left, right) => left - right,
  );
  const exactInstallationIds = [...new Set(installationIds as number[])];
  if (
    exactInstallationIds.length !== 1 ||
    exactInstallationIds[0] !== request.installationId ||
    exactRepositoryIds.length !== request.repositoryIds.length ||
    exactRepositoryIds.some((value, index) => value !== requestedRepositoryIds[index])
  ) {
    throw new Error("Lens GitHub token mint authority does not match its repository resources");
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}
