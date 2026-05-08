import { getSettings } from "@infra-agents/config";
import { createDb } from "@infra-agents/db";
import { createDocumentServices } from "@infra-agents/documents";
import { createNatsEventBus } from "@infra-agents/events";
import { createProductionAgentRuntime } from "@infra-agents/runtime";
import { createObjectStorage } from "@infra-agents/storage";
import { createRunAgentSegmentActivity } from "./activities/agent-segment";
import { createDocumentActivities } from "./activities/documents";
import { createScheduledTaskActivities } from "./activities/scheduled-tasks";
import { createSessionStateActivities } from "./activities/session-state";
import type { ActivityDependencies, ActivityServices } from "./activities/types";

export type {
  ActivityDependencies,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
  IndexDocumentInput,
  RunAgentSegmentInput,
  RunAgentSegmentResult,
} from "./activities/types";

export function createActivities(dependencies: ActivityDependencies = {}) {
  let servicesPromise: Promise<ActivityServices> | null = null;

  async function services(): Promise<ActivityServices> {
    servicesPromise ??= (async () => {
      const settings = dependencies.settings ?? getSettings();
      const dbClient = dependencies.db ? null : createDb(settings.databaseUrl);
      return {
        settings,
        db: dependencies.db ?? dbClient!.db,
        bus: dependencies.bus ?? await createNatsEventBus(settings.natsUrl),
        runtime: dependencies.runtime ?? createProductionAgentRuntime(),
        objectStorage: dependencies.objectStorage ?? createObjectStorage(settings),
        documentServices: dependencies.documentServices ?? createDocumentServices(settings),
      };
    })();
    return servicesPromise;
  }

  return {
    runAgentSegment: createRunAgentSegmentActivity(services),
    ...createDocumentActivities(services),
    ...createSessionStateActivities(services),
    ...createScheduledTaskActivities(services),
  };
}

const defaultActivities = createActivities();

export const runAgentSegment = defaultActivities.runAgentSegment;
export const indexDocument = defaultActivities.indexDocument;
export const failSession = defaultActivities.failSession;
export const interruptActiveTurn = defaultActivities.interruptActiveTurn;
export const claimNextQueuedTurn = defaultActivities.claimNextQueuedTurn;
export const markSessionIdle = defaultActivities.markSessionIdle;
export const dispatchScheduledTaskRun = defaultActivities.dispatchScheduledTaskRun;
