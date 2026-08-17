import {
  applyGitAuthPointerEnvironment,
  hasGitCredentialRepositorySelection,
  hasGitHubRepositorySelection,
  stableSandboxEnvironmentForRun,
  type Settings,
} from "@opengeni/config";
import type { Session } from "@opengeni/contracts";
import {
  loadRigDefaultVariableSetEnvironment,
  mergeRigDefaultVariableSetEnvironment,
} from "@opengeni/core";
import { getRigVersion, loadWorkspaceEnvironmentForRun, type Database } from "@opengeni/db";
import { githubAppBotIdentity } from "@opengeni/github";

export type SessionEnvironmentServices = {
  db: Database;
  settings: Settings;
};

/**
 * Reproduce the worker's stable sandbox environment for API-direct cold creates.
 * The frozen rig defaults layer in listed order below the session's own set.
 */
export async function sessionAttachEnvironment(
  services: SessionEnvironmentServices,
  workspaceId: string,
  session: Session,
): Promise<Record<string, string>> {
  const [workspaceVariableSet, rigVersion] = await Promise.all([
    loadWorkspaceEnvironmentForRun(
      services.db,
      services.settings,
      workspaceId,
      session.environmentId,
    ),
    session.rigId && session.rigVersionId
      ? getRigVersion(services.db, workspaceId, session.rigId, session.rigVersionId)
      : null,
  ]);
  const rigDefaultValues = await loadRigDefaultVariableSetEnvironment(
    rigVersion?.defaultVariableSetIds ?? [],
    async (variableSetId) =>
      await loadWorkspaceEnvironmentForRun(
        services.db,
        services.settings,
        workspaceId,
        variableSetId,
      ),
  );
  const workspaceEnvironmentValues = mergeRigDefaultVariableSetEnvironment(
    rigDefaultValues,
    workspaceVariableSet?.values ?? {},
  );
  const settingsForSession =
    session.sandboxBackend !== services.settings.sandboxBackend
      ? { ...services.settings, sandboxBackend: session.sandboxBackend }
      : services.settings;
  const environment = stableSandboxEnvironmentForRun(
    settingsForSession,
    workspaceEnvironmentValues,
    { workspaceId },
  );
  if (hasGitCredentialRepositorySelection(session.resources)) {
    applyGitAuthPointerEnvironment(
      environment,
      hasGitHubRepositorySelection(session.resources)
        ? githubAppBotIdentity(services.settings)
        : null,
    );
  }
  return environment;
}
