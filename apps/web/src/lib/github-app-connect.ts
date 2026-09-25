import type { NativeConnectRequest } from "@/components/capabilities/native-connect-setup";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

/**
 * Workspace GitHub App setup through the same durable Connect flow as the
 * Plugins page GitHub card. The authorization link is minted when this attempt
 * starts, not when the page loaded: a page-load link expires after ten minutes
 * and then shows a raw error. Cancel on GitHub, owner approval pending, and a
 * failed proof are all reported by the Connect dialog.
 */
export function githubAppConnectRequest(
  workspaceId: string,
  transport: NativeConnectRequest["scope"]["transport"],
): NativeConnectRequest {
  return {
    scope: { workspaceId, transport },
    providerId: "github-app",
    displayName: "GitHub App",
    description:
      "Choose the GitHub account or organization whose repositories this workspace uses.",
    ownership: "workspace",
    returnUrl: window.location.href,
    idempotencyKey: crypto.randomUUID(),
  };
}

/**
 * Opens GitHub's repository settings for one installation through a link
 * minted now. Installation settings links carry the same ten-minute state as
 * the connect link, so a copy captured at page load cannot be used.
 */
export async function openGitHubInstallationSettings(
  client: Pick<OpenGeniBrowserClient, "getGitHubApp">,
  workspaceId: string,
  installationId: number,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const status = await client.getGitHubApp(workspaceId);
  const url = status.installations.find(
    (installation) => installation.installationId === installationId,
  )?.configureUrl;
  if (!url) {
    throw new Error(
      "You can't change this installation's repositories. Ask a workspace admin to update it on GitHub.",
    );
  }
  navigate(url);
}
