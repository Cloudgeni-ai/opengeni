import { createSharedActivityServices } from "./activity-services";
import { createCodexCapacityActivities } from "./activities/codex-capacity";
import { createDocumentActivities } from "./activities/documents";
import { createFileUploadReaperActivities } from "./activities/file-upload-reaper";
import { createGoalActivities } from "./activities/goals";
import { createKnowledgeSourceSyncActivities } from "./activities/knowledge-source-sync";
import { createRetainedScreenshotMaintenanceActivities } from "./activities/retained-screenshot-reaper";
import { createRigVerificationActivities } from "./activities/rig-verification";
import { createSandboxLeaseActivities } from "./activities/sandbox-lease";
import { createScheduledTaskActivities } from "./activities/scheduled-tasks";
import { createSessionStateActivities } from "./activities/session-state";
import type { ActivityDependencies, ControlActivityServices } from "./activities/types";
import { createWorkflowWakeActivities } from "./activities/workflow-wake";

function createControlActivityServices(
  dependencies: ActivityDependencies,
): () => Promise<ControlActivityServices> {
  const shared = createSharedActivityServices(dependencies);
  return shared;
}

export function createControlActivitiesFromServices(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<import("@opengeni/documents").DocumentServices>,
) {
  return {
    ...createDocumentActivities(services, resolveDocumentServices),
    ...createKnowledgeSourceSyncActivities(services, resolveDocumentServices),
    ...createSessionStateActivities(services),
    ...createScheduledTaskActivities(services),
    ...createGoalActivities(services),
    ...createCodexCapacityActivities(services),
    ...createRigVerificationActivities(services),
    ...createFileUploadReaperActivities(services),
    ...createRetainedScreenshotMaintenanceActivities(services),
    ...createWorkflowWakeActivities(services),
    ...createSandboxLeaseActivities(services),
  };
}

export function createControlActivities(dependencies: ActivityDependencies = {}) {
  const services = createControlActivityServices(dependencies);
  let documentServicesPromise: Promise<import("@opengeni/documents").DocumentServices> | null =
    null;
  const resolveDocumentServices = async () => {
    documentServicesPromise ??= dependencies.documentServices
      ? Promise.resolve(dependencies.documentServices)
      : import("@opengeni/documents").then(async ({ createDocumentServices }) =>
          createDocumentServices((await services()).settings),
        );
    return await documentServicesPromise;
  };
  return createControlActivitiesFromServices(services, resolveDocumentServices);
}
