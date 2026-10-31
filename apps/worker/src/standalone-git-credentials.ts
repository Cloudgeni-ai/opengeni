import type { Settings } from "@opengeni/config";
import type {
  ConnectionCredentialsPort,
  GitCredentials,
  GitCredentialsRequest,
} from "@opengeni/contracts";
import { createGitHubAppInstallationTokenWithExpiry } from "@opengeni/github";

/** Standalone credential broker: the deployment's GitHub App installation tokens.
 * Embedded hosts keep precedence by supplying their own connectionCredentials. */
export function createStandaloneConnectionCredentialsPort(
  settings: Settings,
): ConnectionCredentialsPort {
  const port: ConnectionCredentialsPort = {
    gitCredentials: async (request) => await resolveStandaloneGitCredentials(settings, request),
  };
  standalonePorts.add(port);
  return port;
}

const standalonePorts = new WeakSet<ConnectionCredentialsPort>();

/**
 * True when Git tokens come from Opengeni's own GitHub App (the standalone
 * port, or no port at all), not from a host credential callback.
 */
export function gitTokensMintedByOpengeni(
  port: ConnectionCredentialsPort | null | undefined,
): boolean {
  return !port?.gitCredentials || standalonePorts.has(port);
}

async function resolveStandaloneGitCredentials(
  settings: Settings,
  request: GitCredentialsRequest,
): Promise<GitCredentials> {
  const provider = request.provider ?? "github";
  if (provider !== "github") {
    throw new Error(`${provider} Git credentials require an explicit host binding`);
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
