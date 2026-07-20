import { dbSearchPath, getSettings, resolveNatsControlPlaneAuth } from "@opengeni/config";
import { createDb } from "@opengeni/db";
import { createDocumentServices } from "@opengeni/documents";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { createObjectStorage } from "@opengeni/storage";
import { createRunAgentTurnActivity } from "./activities/agent-turn";
import { createCodexCapacityActivities } from "./activities/codex-capacity";
import { createDocumentActivities } from "./activities/documents";
import { createFileUploadReaperActivities } from "./activities/file-upload-reaper";
import { createGoalActivities } from "./activities/goals";
import { createSandboxLeaseActivities } from "./activities/sandbox-lease";
import { createScheduledTaskActivities } from "./activities/scheduled-tasks";
import { createSessionStateActivities } from "./activities/session-state";
import { createWorkflowWakeActivities } from "./activities/workflow-wake";
import { createRigVerificationActivities } from "./activities/rig-verification";
import type { ActivityDependencies, ActivityServices } from "./activities/types";
import {
  observabilityEventLogger,
  runtimeMetricsHooksForObservability,
} from "./observability-metrics";

export type {
  ActivityDependencies,
  DispatchScheduledTaskRunInput,
  DispatchScheduledTaskRunResult,
  IndexDocumentInput,
  MaybeContinueGoalInput,
  MaybeContinueGoalResult,
  CodexCapacityWaitRef,
  GetCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitInput,
  ReconcileCodexCapacityWaitResult,
  RecoverDispatchInput,
  RecoverDispatchResult,
  PersistSessionAttemptQuiescenceInput,
  RunAgentTurnInput,
  RunAgentTurnResult,
  SessionAttemptQuiescenceProof,
} from "./activities/types";

function createActivityServices(
  dependencies: ActivityDependencies,
): () => Promise<ActivityServices> {
  let servicesPromise: Promise<ActivityServices> | null = null;

  async function services(): Promise<ActivityServices> {
    servicesPromise ??= (async () => {
      const settings = dependencies.settings ?? getSettings();
      const observability =
        dependencies.observability ?? createObservability(settings, { component: "worker" });
      // Step I: when not injected, build the standalone handle — searchPath
      // undefined for standalone (public), scoped to the dedicated schema +
      // host RLS strategy when embedded config is set. An embedded host injects
      // `dependencies.db` directly and this branch is skipped.
      const searchPath = dbSearchPath(settings);
      const dbClient = dependencies.db
        ? null
        : createDb(settings.databaseUrl, {
            ...(searchPath ? { searchPath } : {}),
            rlsStrategy: settings.rlsStrategy,
          });
      // The PRIVILEGED control-plane NATS login (M-AUTH): the worker resolves the
      // SAME static account user the API uses to request `agent.*.rpc`. Null in
      // local dev → anonymous connect (the bus default).
      const controlPlaneAuth = resolveNatsControlPlaneAuth(settings);
      return {
        settings,
        db: dependencies.db ?? dbClient!.db,
        // §7 Step G — EventBus binding contract. `bus` is the INJECTED
        // live-fanout port; the ONE production impl is `createNatsEventBus`,
        // the default on BOTH processes (this worker edge + the API edge in
        // `apps/api/src/index.ts`). A host that embeds OpenGeni injects ONE
        // broker binding (the same `createNatsEventBus(natsUrl)`) here AND on
        // the mounted API, so the two SEPARATE processes share one broker and
        // derive the IDENTICAL `sessionSubject` — the only way live fanout
        // (worker emit → API SSE) works cross-process (SPIKE-1 F5/F6, proven).
        // NEVER default to an in-memory bus: it fans out intra-process only and
        // would silently break live SSE. unset → today's NATS default,
        // byte-for-byte. The bus is live-fanout ONLY — the durable Postgres
        // `session_events` log is source-of-truth (the API backfills missed
        // events by sequence). See `.agents/skills/opengeni/references/eventbus-binding-contract.md`.
        bus:
          dependencies.bus ??
          (await createNatsEventBus(
            settings.natsUrl,
            controlPlaneAuth
              ? { user: controlPlaneAuth.user, pass: controlPlaneAuth.password }
              : undefined,
            { logger: observabilityEventLogger(observability) },
          )),
        runtime:
          dependencies.runtime ??
          createProductionAgentRuntime({
            metrics: runtimeMetricsHooksForObservability(observability),
          }),
        objectStorage: dependencies.objectStorage ?? createObjectStorage(settings),
        documentServices: dependencies.documentServices ?? createDocumentServices(settings),
        observability,
        wakeSessionWorkflow: dependencies.wakeSessionWorkflow ?? null,
        signalSessionAttemptQuiesced: dependencies.signalSessionAttemptQuiesced ?? null,
        signalCodexCapacityWorkflow: dependencies.signalCodexCapacityWorkflow ?? null,
        // §7.5 P3 — host-entitlements port. No constructed default: standalone
        // has no host meter, so unset → null → `ensureRunAllowed` reads the
        // local ledger exactly as today (mirrors `wakeSessionWorkflow`'s
        // null-degrades-gracefully shape, not a `createX(settings)` default).
        entitlements: dependencies.entitlements ?? null,
        // §7.6 P4a — host connection-credential provider. No constructed
        // default: standalone owns its own GitHub App + encryption key, so unset
        // → null → the per-run credential mint self-mints from `settings`
        // (createGitHubAppInstallationToken + environmentsEncryptionKeyBytes)
        // exactly as today. Same null-degrades shape as `entitlements`.
        connectionCredentials: dependencies.connectionCredentials ?? null,
      };
    })();
    return servicesPromise;
  }

  return services;
}

function controlActivities(services: () => Promise<ActivityServices>) {
  return {
    ...createDocumentActivities(services),
    ...createSessionStateActivities(services),
    ...createScheduledTaskActivities(services),
    ...createGoalActivities(services),
    ...createCodexCapacityActivities(services),
    ...createRigVerificationActivities(services),
    ...createFileUploadReaperActivities(services),
    ...createWorkflowWakeActivities(services),
    // P1.3: the SOLE liveness/GC/cost-stop driver. Only reapSandboxLeases — no
    // *ForViewer activities, no ownerHeartbeat, no resolveOwnerTaskQueue.
    ...createSandboxLeaseActivities(services),
  };
}

export function createControlActivities(dependencies: ActivityDependencies = {}) {
  return controlActivities(createActivityServices(dependencies));
}

export function createTurnActivities(dependencies: ActivityDependencies = {}) {
  return { runAgentTurn: createRunAgentTurnActivity(createActivityServices(dependencies)) };
}

/** Direct activity harness for tests; production workers always choose one role. */
export function createActivityTestHarness(dependencies: ActivityDependencies = {}) {
  const services = createActivityServices(dependencies);
  return { runAgentTurn: createRunAgentTurnActivity(services), ...controlActivities(services) };
}

const defaultControlActivities = createControlActivities();
const defaultTurnActivities = createTurnActivities();

export const runAgentTurn = defaultTurnActivities.runAgentTurn;
export const indexDocument = defaultControlActivities.indexDocument;
export const failSessionAttempt = defaultControlActivities.failSessionAttempt;
export const settleSessionInterruptions = defaultControlActivities.settleSessionInterruptions;
export const persistSessionAttemptQuiescence =
  defaultControlActivities.persistSessionAttemptQuiescence;
export const recoverDispatch = defaultControlActivities.recoverDispatch;
export const peekSessionWork = defaultControlActivities.peekSessionWork;
export const markSessionIdle = defaultControlActivities.markSessionIdle;
export const dispatchScheduledTaskRun = defaultControlActivities.dispatchScheduledTaskRun;
export const enqueueGoalRetryWake = defaultControlActivities.enqueueGoalRetryWake;
export const maybeContinueGoal = defaultControlActivities.maybeContinueGoal;
export const getCodexCapacityWait = defaultControlActivities.getCodexCapacityWait;
export const reconcileCodexCapacityWait = defaultControlActivities.reconcileCodexCapacityWait;
export const reapSandboxLeases = defaultControlActivities.reapSandboxLeases;
export const reapExpiredFileUploads = defaultControlActivities.reapExpiredFileUploads;
export const dispatchSessionWorkflowWakes = defaultControlActivities.dispatchSessionWorkflowWakes;
export const verifyRigChange = defaultControlActivities.verifyRigChange;
export const verifyRigVersion = defaultControlActivities.verifyRigVersion;
