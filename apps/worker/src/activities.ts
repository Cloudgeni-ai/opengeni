/**
 * Compatibility/test activity barrel.
 *
 * Production workers do not import this module: the control and turn process
 * loaders resolve their role-specific activity graph independently. Keeping
 * this superset preserves the historical workflow type surface and direct test
 * harness without charging every production process for both dependency trees.
 */
import { createDocumentServices } from "@opengeni/documents";
import { createProductionAgentRuntime, summarizeForCompaction } from "@opengeni/runtime";
import { createControlActivities, createControlActivitiesFromServices } from "./activities-control";
import { createTurnActivities, createTurnActivitiesFromServices } from "./activities-turn";
import { createSharedActivityServices } from "./activity-services";
import type { ActivityDependencies, ActivityServices } from "./activities/types";
import { runtimeMetricsHooksForObservability } from "./observability-metrics";

export type {
  ActivityDependencies,
  ActivityServices,
  ControlActivityDependencies,
  ControlActivityServices,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
  ExpireSessionHumanInputInput,
  ExpireSessionHumanInputResult,
  IndexDocumentInput,
  MaybeContinueGoalInput,
  MaybeContinueGoalResult,
  CodexCapacityWaitRef,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
  RecoverDispatchInput,
  RecoverDispatchResult,
  RecoverEscapedMcpTimeoutInput,
  RecoverEscapedMcpTimeoutResult,
  PersistSessionAttemptQuiescenceInput,
  ReconcileSessionAttemptQuiescenceInput,
  ReconcileSessionAttemptQuiescenceResult,
  RunKnowledgeSourceSyncBatchInput,
  RunKnowledgeSourceSyncBatchResult,
  RunAgentTurnInput,
  RunAgentTurnResult,
  SessionAttemptQuiescenceProof,
  SharedActivityServices,
  TurnActivityDependencies,
  TurnActivityServices,
} from "./activities/types";
export { createControlActivities, createTurnActivities };

/** Direct full-graph harness for tests; production always chooses one role. */
export function createActivityTestHarness(dependencies: ActivityDependencies = {}) {
  const shared = createSharedActivityServices(dependencies);
  let servicesPromise: Promise<ActivityServices> | null = null;
  const services = async (): Promise<ActivityServices> => {
    servicesPromise ??= (async () => {
      const common = await shared();
      return {
        ...common,
        runtime:
          dependencies.runtime ??
          createProductionAgentRuntime({
            metrics: runtimeMetricsHooksForObservability(common.observability),
          }),
        summarizeContextForCompaction:
          dependencies.summarizeContextForCompaction ?? summarizeForCompaction,
        documentServices: dependencies.documentServices ?? createDocumentServices(common.settings),
      };
    })();
    return await servicesPromise;
  };
  return {
    ...createTurnActivitiesFromServices(services),
    ...createControlActivitiesFromServices(
      services,
      async () => (await services()).documentServices,
    ),
  };
}

const defaultControlActivities = createControlActivities();
const defaultTurnActivities = createTurnActivities();

export const runAgentTurn = defaultTurnActivities.runAgentTurn;
export const indexDocument = defaultControlActivities.indexDocument;
export const failSessionAttempt = defaultControlActivities.failSessionAttempt;
export const settleSessionInterruptions = defaultControlActivities.settleSessionInterruptions;
export const persistSessionAttemptQuiescence =
  defaultControlActivities.persistSessionAttemptQuiescence;
export const reconcileSessionAttemptQuiescence =
  defaultControlActivities.reconcileSessionAttemptQuiescence;
export const recoverDispatch = defaultControlActivities.recoverDispatch;
export const recoverEscapedMcpTimeout = defaultControlActivities.recoverEscapedMcpTimeout;
export const peekSessionWork = defaultControlActivities.peekSessionWork;
export const expireSessionHumanInput = defaultControlActivities.expireSessionHumanInput;
export const markSessionIdle = defaultControlActivities.markSessionIdle;
export const dispatchScheduledTaskRun = defaultControlActivities.dispatchScheduledTaskRun;
export const runKnowledgeSourceSyncBatch = defaultControlActivities.runKnowledgeSourceSyncBatch;
export const enqueueGoalRetryWake = defaultControlActivities.enqueueGoalRetryWake;
export const maybeContinueGoal = defaultControlActivities.maybeContinueGoal;
export const getCodexCapacityWait = defaultControlActivities.getCodexCapacityWait;
export const reconcileCodexCapacityWait = defaultControlActivities.reconcileCodexCapacityWait;
export const prepareSandboxLeaseSweep = defaultControlActivities.prepareSandboxLeaseSweep;
export const drainSandboxLease = defaultControlActivities.drainSandboxLease;
export const maintainSandboxLeaseSweep = defaultControlActivities.maintainSandboxLeaseSweep;
export const reapSandboxLeases = defaultControlActivities.reapSandboxLeases;
export const reapExpiredFileUploads = defaultControlActivities.reapExpiredFileUploads;
export const maintainRetainedScreenshots = defaultControlActivities.maintainRetainedScreenshots;
export const dispatchSessionWorkflowWakes = defaultControlActivities.dispatchSessionWorkflowWakes;
export const verifyRigChange = defaultControlActivities.verifyRigChange;
export const verifyRigVersion = defaultControlActivities.verifyRigVersion;
