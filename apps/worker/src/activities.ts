import { getSettings } from "@opengeni/config";
import { createDb } from "@opengeni/db";
import { createDocumentServices } from "@opengeni/documents";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { createObjectStorage } from "@opengeni/storage";
import { createRunAgentTurnActivity } from "./activities/agent-turn";
import { createDocumentActivities } from "./activities/documents";
import { createGoalActivities } from "./activities/goals";
import { createScheduledTaskActivities } from "./activities/scheduled-tasks";
import { createSessionStateActivities } from "./activities/session-state";
import type { ActivityDependencies, ActivityServices } from "./activities/types";

export type {
  ActivityDependencies,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
  IndexDocumentInput,
  MaybeContinueGoalInput,
  MaybeContinueGoalResult,
  PauseGoalForInterruptInput,
  RunAgentTurnInput,
  RunAgentTurnResult,
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
        observability: dependencies.observability ?? createObservability(settings, { component: "worker" }),
      };
    })();
    return servicesPromise;
  }

  const runAgentTurn = createRunAgentTurnActivity(services);
  return {
    runAgentTurn,
    // Legacy Temporal activity name. In-flight session workflows (which can
    // legitimately live for days) recorded ScheduleActivityTask events as
    // "runAgentSegment"; the name must keep resolving until those histories
    // drain. New workflow code must use runAgentTurn; migrate the session
    // workflow call site via patched() before removing this alias.
    runAgentSegment: runAgentTurn,
    ...createDocumentActivities(services),
    ...createSessionStateActivities(services),
    ...createScheduledTaskActivities(services),
    ...createGoalActivities(services),
  };
}

const defaultActivities = createActivities();

export const runAgentTurn = defaultActivities.runAgentTurn;
export const runAgentSegment = defaultActivities.runAgentSegment;
export const indexDocument = defaultActivities.indexDocument;
export const failSession = defaultActivities.failSession;
export const interruptActiveTurn = defaultActivities.interruptActiveTurn;
export const claimNextQueuedTurn = defaultActivities.claimNextQueuedTurn;
export const markSessionIdle = defaultActivities.markSessionIdle;
export const dispatchScheduledTaskRun = defaultActivities.dispatchScheduledTaskRun;
export const maybeContinueGoal = defaultActivities.maybeContinueGoal;
export const pauseGoalForInterrupt = defaultActivities.pauseGoalForInterrupt;
