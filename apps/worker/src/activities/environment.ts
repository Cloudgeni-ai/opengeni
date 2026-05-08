import {
  collectGitIdentityEnvironment,
  collectSandboxEnvironment,
  type Settings,
} from "@infra-agents/config";
import type { ResourceRef } from "@infra-agents/contracts";
import {
  createGitHubAppInstallationToken,
  githubAppBotIdentity,
} from "@infra-agents/github";

export async function sandboxEnvironmentForRun(settings: Settings, resources: ResourceRef[]): Promise<Record<string, string>> {
  const environment = {
    ...collectSandboxEnvironment(settings),
    ...collectGitIdentityEnvironment(settings),
  };
  if (settings.sandboxBackend === "docker" || settings.sandboxBackend === "modal") {
    environment.HOME ??= "/workspace";
    environment.AZURE_CONFIG_DIR ??= "/workspace/.azure";
  }
  const selection = githubRepositorySelection(resources);
  if (!selection) {
    return environment;
  }
  const token = await createGitHubAppInstallationToken(settings, {
    installationId: selection.installationId,
    repositoryIds: selection.repositoryIds,
  });
  const identity = githubAppBotIdentity(settings);
  const authHeader = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  environment.GH_TOKEN = token;
  environment.GITHUB_TOKEN = token;
  environment.GIT_ASKPASS = "/usr/local/bin/infra-agent-git-askpass";
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
