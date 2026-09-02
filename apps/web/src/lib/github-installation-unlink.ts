import { OpenGeniApiError } from "@opengeni/sdk/browser";

import type { GitHubAppInfo } from "@/types";

function installationIsAbsent(status: GitHubAppInfo, installationId: number): boolean {
  return !status.installations.some(
    (installation) => installation.installationId === installationId,
  );
}

function shouldReconcile(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof OpenGeniApiError && (error.status === 404 || error.outcomeUnknown))
  );
}

export async function unlinkGitHubInstallationWithReconciliation(input: {
  installationId: number;
  unlink: () => Promise<void>;
  readStatus: () => Promise<GitHubAppInfo>;
}): Promise<void> {
  try {
    await input.unlink();
  } catch (error) {
    if (!shouldReconcile(error)) throw error;
    const status = await input.readStatus();
    if (!installationIsAbsent(status, input.installationId)) throw error;
  }
}
