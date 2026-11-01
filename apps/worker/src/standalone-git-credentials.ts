import type { Settings } from "@opengeni/config";
import type {
  ConnectionCredentialsPort,
  GitCredentials,
  GitCredentialsRequest,
} from "@opengeni/contracts";
import { createGitHubAppInstallationTokenWithExpiry } from "@opengeni/github";

/** Standalone credential broker: the deployment's GitHub App installation tokens.
 * Embedded hosts keep precedence by supplying their own connectionCredentials.
 * A session with several GitHub bindings (more than one App installation, or an
 * installation next to the user's own GitHub) requires every provider to echo
 * the exact binding it minted for, so this port echoes the requested binding. */
export function createStandaloneConnectionCredentialsPort(
  settings: Settings,
): ConnectionCredentialsPort {
  return {
    gitCredentials: async (request) => await resolveStandaloneGitCredentials(settings, request),
  };
}

async function resolveStandaloneGitCredentials(
  settings: Settings,
  request: GitCredentialsRequest,
): Promise<GitCredentials> {
  const provider = request.provider ?? "github";
  if (provider !== "github") {
    throw new Error(`${provider} Git credentials require an explicit host binding`);
  }
  const bindingEcho = {
    ...(request.credentialBindingId ? { credentialBindingId: request.credentialBindingId } : {}),
    ...(request.credentialBindingId ? { provider: "github" as const } : {}),
    ...(request.providerHost ? { providerHost: request.providerHost } : {}),
  };
  if (request.purpose === "identity") {
    return { workspaceId: request.workspaceId, ...bindingEcho };
  }
  const minted = await createGitHubAppInstallationTokenWithExpiry(settings, {
    installationId: request.installationId,
    repositoryIds: request.repositoryIds,
  });
  return {
    token: minted.token,
    workspaceId: request.workspaceId,
    ...bindingEcho,
    ...(minted.expiresAt ? { expiresAt: minted.expiresAt } : {}),
  };
}
