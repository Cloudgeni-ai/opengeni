import {
  collectGitIdentityEnvironment,
  collectSandboxEnvironment,
  environmentsEncryptionKeyBytes,
  type Settings,
} from "@opengeni/config";
import type { ResourceRef } from "@opengeni/contracts";
import {
  decryptEnvironmentValue,
  getWorkspaceEnvironmentValuesForRun,
  type Database,
} from "@opengeni/db";
import {
  createGitHubAppInstallationToken,
  githubAppBotIdentity,
} from "@opengeni/github";

export type WorkspaceEnvironmentForRun = {
  id: string;
  name: string;
  values: Record<string, string>;
};

/**
 * Loads and decrypts the workspace environment attached to a run's session.
 * `environmentId === null` is the unattached path: zero DB work and behavior
 * byte-identical to deployments without this feature. Attached runs fail
 * closed: a missing key or a deleted environment throws (names/ids only in
 * messages) instead of silently running without the secrets the run expects.
 */
export async function loadWorkspaceEnvironmentForRun(
  db: Database,
  settings: Settings,
  workspaceId: string,
  environmentId: string | null,
): Promise<WorkspaceEnvironmentForRun | null> {
  if (!environmentId) {
    return null;
  }
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error("workspace environment attached but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
  }
  const stored = await getWorkspaceEnvironmentValuesForRun(db, workspaceId, environmentId);
  if (!stored) {
    throw new Error(`workspace environment not found: ${environmentId}`);
  }
  const values: Record<string, string> = {};
  for (const [name, encrypted] of Object.entries(stored.values)) {
    try {
      values[name] = decryptEnvironmentValue(key, encrypted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to decrypt workspace environment variable ${name}: ${reason}`);
    }
  }
  return { id: stored.environment.id, name: stored.environment.name, values };
}

export async function sandboxEnvironmentForRun(
  settings: Settings,
  resources: ResourceRef[],
  workspaceEnvironment: Record<string, string> = {},
): Promise<Record<string, string>> {
  // Precedence: deployment allowlist < git identity < workspace environment
  // < platform run-scoped GitHub auth (applied below, always last). Reserved
  // name validation at write time prevents workspace values from colliding
  // with the platform-managed entries.
  const environment = {
    ...collectSandboxEnvironment(settings),
    ...collectGitIdentityEnvironment(settings),
    ...workspaceEnvironment,
  };
  if (settings.sandboxBackend === "docker" || settings.sandboxBackend === "modal") {
    environment.HOME ??= "/workspace";
  }
  const selection = githubRepositorySelection(resources);
  if (!selection) {
    return environment;
  }
  // Run-scoped sandbox preparation for GitHub App repository resources.
  const token = await createGitHubAppInstallationToken(settings, {
    installationId: selection.installationId,
    repositoryIds: selection.repositoryIds,
  });
  const identity = githubAppBotIdentity(settings);
  const authHeader = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  environment.GH_TOKEN = token;
  environment.GITHUB_TOKEN = token;
  environment.GIT_ASKPASS = "/usr/local/bin/opengeni-git-askpass";
  environment.GIT_CONFIG_COUNT = "1";
  environment.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  environment.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${authHeader}`;
  environment.GIT_TERMINAL_PROMPT = "0";
  if (identity) {
    environment.GIT_AUTHOR_NAME = environment.GIT_AUTHOR_NAME || identity.name;
    environment.GIT_AUTHOR_EMAIL = environment.GIT_AUTHOR_EMAIL || identity.email;
    environment.GIT_COMMITTER_NAME = environment.GIT_COMMITTER_NAME || identity.name;
    environment.GIT_COMMITTER_EMAIL = environment.GIT_COMMITTER_EMAIL || identity.email;
  }
  return environment;
}

function githubRepositorySelection(resources: ResourceRef[]): { installationId: number; repositoryIds: number[] } | null {
  const selected = resources.flatMap((resource) => {
    if (resource.kind !== "repository") {
      return [];
    }
    const installationId = positiveInteger(resource.githubInstallationId);
    const repositoryId = positiveInteger(resource.githubRepositoryId);
    return installationId && repositoryId ? [{ installationId, repositoryId }] : [];
  });
  if (selected.length === 0) {
    return null;
  }
  const installationId = selected[0]!.installationId;
  if (selected.some((item) => item.installationId !== installationId)) {
    throw new Error("GitHub App repository resources must belong to one installation");
  }
  return {
    installationId,
    repositoryIds: selected.map((item) => item.repositoryId),
  };
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return null;
}
