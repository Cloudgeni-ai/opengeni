import { dbSearchPath, getSettings, resolveNatsControlPlaneAuth } from "@opengeni/config";
import { configureChildLifecycleNotices, createDb } from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { resolveCatalogSettings } from "@opengeni/core";
import { createObjectStorage } from "@opengeni/storage";
import type { ActivityDependencies, SharedActivityServices } from "./activities/types";
import { observabilityEventLogger } from "./observability-metrics";
import { buildPersonalGitHubGitCredentials } from "./personal-github-git-credentials";
import { createStandaloneConnectionCredentialsPort } from "./pr-review-credentials";

/**
 * Build the dependency graph common to both worker roles exactly once.
 *
 * This module deliberately has no import edge to @opengeni/runtime or
 * @opengeni/documents. Those graphs are added by the role-specific factories,
 * preventing an idle process from retaining an unused model SDK or parser
 * stack for its entire lifetime.
 */
export function createSharedActivityServices(
  dependencies: ActivityDependencies,
): () => Promise<SharedActivityServices> {
  let servicesPromise: Promise<SharedActivityServices> | null = null;

  return async function services(): Promise<SharedActivityServices> {
    servicesPromise ??= (async () => {
      const settings = dependencies.settings ?? getSettings();
      const observability =
        dependencies.observability ?? createObservability(settings, { component: "worker" });
      const searchPath = dbSearchPath(settings);
      const dbClient = dependencies.db
        ? null
        : createDb(settings.databaseUrl, {
            ...(searchPath ? { searchPath } : {}),
            rlsStrategy: settings.rlsStrategy,
          });
      const controlPlaneAuth = resolveNatsControlPlaneAuth(settings);
      const db = dependencies.db ?? dbClient!.db;
      const resolvedSettings = (await resolveCatalogSettings(db, settings)).settings;
      // Child lifecycle notice producers are process-global in @opengeni/db;
      // install the boot-validated rollout flag once for this worker.
      configureChildLifecycleNotices({ enabled: settings.childLifecycleNoticesEnabled });
      return {
        settings: resolvedSettings,
        db,
        bus:
          dependencies.bus ??
          (await createNatsEventBus(
            settings.natsUrl,
            controlPlaneAuth
              ? { user: controlPlaneAuth.user, pass: controlPlaneAuth.password }
              : undefined,
            { logger: observabilityEventLogger(observability) },
          )),
        objectStorage: dependencies.objectStorage ?? createObjectStorage(settings),
        observability,
        wakeSessionWorkflow: dependencies.wakeSessionWorkflow ?? null,
        signalSessionAttemptQuiesced: dependencies.signalSessionAttemptQuiesced ?? null,
        inspectSessionAttemptActivity: dependencies.inspectSessionAttemptActivity ?? null,
        signalCodexCapacityWorkflow: dependencies.signalCodexCapacityWorkflow ?? null,
        startSandboxReaperWorkflow: dependencies.startSandboxReaperWorkflow ?? null,
        startVideoGenerationWorkflow: dependencies.startVideoGenerationWorkflow ?? null,
        entitlements: dependencies.entitlements ?? null,
        connectionCredentials:
          dependencies.connectionCredentials ??
          createStandaloneConnectionCredentialsPort(settings, db),
        personalGitHubCredentials:
          dependencies.personalGitHubCredentials ?? buildPersonalGitHubGitCredentials(db, settings),
      };
    })();
    return await servicesPromise;
  };
}
