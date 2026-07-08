import { dbSearchPath, getSettings, resolveNatsControlPlaneAuth } from "@opengeni/config";
import { createDb } from "@opengeni/db";
import { createDocumentServices } from "@opengeni/documents";
import { createNatsEventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import { createObjectStorage } from "@opengeni/storage";
import { createRunAgentTurnActivity } from "./activities/agent-turn";
import { createDocumentActivities } from "./activities/documents";
import { createGoalActivities } from "./activities/goals";
import { createSandboxLeaseActivities } from "./activities/sandbox-lease";
import { createScheduledTaskActivities } from "./activities/scheduled-tasks";
import { createSessionStateActivities } from "./activities/session-state";
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
  PauseGoalForInterruptInput,
  RequeueTurnAfterWorkerDeathInput,
  RequeueTurnAfterWorkerDeathResult,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "./activities/types";

export function createActivities(dependencies: ActivityDependencies = {}) {
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
    ...createRigVerificationActivities(services),
    // P1.3: the SOLE liveness/GC/cost-stop driver. Only reapSandboxLeases — no
    // *ForViewer activities, no ownerHeartbeat, no resolveOwnerTaskQueue.
    ...createSandboxLeaseActivities(services),
  };
}

const defaultActivities = createActivities();

export const runAgentTurn = defaultActivities.runAgentTurn;
export const runAgentSegment = defaultActivities.runAgentSegment;
export const indexDocument = defaultActivities.indexDocument;
export const failSession = defaultActivities.failSession;
export const interruptActiveTurn = defaultActivities.interruptActiveTurn;
export const requeueTurnAfterWorkerDeath = defaultActivities.requeueTurnAfterWorkerDeath;
export const claimNextQueuedTurn = defaultActivities.claimNextQueuedTurn;
export const markSessionIdle = defaultActivities.markSessionIdle;
export const dispatchScheduledTaskRun = defaultActivities.dispatchScheduledTaskRun;
export const maybeContinueGoal = defaultActivities.maybeContinueGoal;
export const pauseGoalForInterrupt = defaultActivities.pauseGoalForInterrupt;
export const reapSandboxLeases = defaultActivities.reapSandboxLeases;
export const verifyRigChange = defaultActivities.verifyRigChange;
export const verifyRigVersion = defaultActivities.verifyRigVersion;
