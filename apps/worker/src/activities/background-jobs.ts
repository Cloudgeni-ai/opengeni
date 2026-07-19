import { Context } from "@temporalio/activity";
import {
  appendBackgroundJobLog,
  attachBackgroundJobProvider,
  claimBackgroundJobStart,
  claimPendingBackgroundJobDispatches,
  createBackgroundJobAttempt,
  getBackgroundJobCancelRequested,
  insertBackgroundJobArtifact,
  markBackgroundJobDispatchFailed,
  markBackgroundJobDispatchStarted,
  settleBackgroundJob,
} from "@opengeni/db";
import { publishDurableSessionEvents } from "@opengeni/events";
import {
  BackgroundJobProviderLostError,
  type BackgroundJobExecutionProvider,
  type BackgroundJobProviderTerminal,
} from "@opengeni/runtime";
import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import type {
  ActivityServices,
  BackgroundJobControllerInput,
  BackgroundJobControllerResult,
} from "./types";

type ActivityHooks = {
  heartbeat: () => void;
  sleep: (ms: number) => Promise<void>;
};

export type BackgroundJobActivityOverrides = Partial<{
  provider: BackgroundJobExecutionProvider;
  hooks: ActivityHooks;
  claimBackgroundJobStart: typeof claimBackgroundJobStart;
  createBackgroundJobAttempt: typeof createBackgroundJobAttempt;
  attachBackgroundJobProvider: typeof attachBackgroundJobProvider;
  getBackgroundJobCancelRequested: typeof getBackgroundJobCancelRequested;
  appendBackgroundJobLog: typeof appendBackgroundJobLog;
  insertBackgroundJobArtifact: typeof insertBackgroundJobArtifact;
  settleBackgroundJob: typeof settleBackgroundJob;
  claimPendingBackgroundJobDispatches: typeof claimPendingBackgroundJobDispatches;
  markBackgroundJobDispatchStarted: typeof markBackgroundJobDispatchStarted;
  markBackgroundJobDispatchFailed: typeof markBackgroundJobDispatchFailed;
  publishDurableSessionEvents: typeof publishDurableSessionEvents;
}>;

function defaultActivityHooks(): ActivityHooks {
  const context = Context.current();
  return {
    heartbeat: () => context.heartbeat(),
    sleep: async (ms) => await context.sleep(ms),
  };
}

function artifactContentType(filename: string): string {
  const extension = filename.toLowerCase().split(".").pop();
  if (extension === "json") return "application/json";
  if (extension === "txt" || extension === "log" || extension === "md") {
    return "text/plain; charset=utf-8";
  }
  if (extension === "html") return "text/html; charset=utf-8";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "pdf") return "application/pdf";
  if (extension === "zip") return "application/zip";
  return "application/octet-stream";
}

function artifactStorageKey(workspaceId: string, jobId: string, path: string): string {
  return `background-jobs/${workspaceId}/${jobId}/${encodeURIComponent(path)}`;
}

function terminalStatus(status: string): status is BackgroundJobControllerResult["status"] {
  return (
    status === "completed" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

export function createBackgroundJobActivities(
  services: () => Promise<ActivityServices>,
  overrides: BackgroundJobActivityOverrides = {},
) {
  const claimStart = overrides.claimBackgroundJobStart ?? claimBackgroundJobStart;
  const createAttempt = overrides.createBackgroundJobAttempt ?? createBackgroundJobAttempt;
  const attachProvider = overrides.attachBackgroundJobProvider ?? attachBackgroundJobProvider;
  const cancelRequested =
    overrides.getBackgroundJobCancelRequested ?? getBackgroundJobCancelRequested;
  const appendLog = overrides.appendBackgroundJobLog ?? appendBackgroundJobLog;
  const insertArtifact = overrides.insertBackgroundJobArtifact ?? insertBackgroundJobArtifact;
  const settle = overrides.settleBackgroundJob ?? settleBackgroundJob;
  const claimDispatches =
    overrides.claimPendingBackgroundJobDispatches ?? claimPendingBackgroundJobDispatches;
  const markDispatchStarted =
    overrides.markBackgroundJobDispatchStarted ?? markBackgroundJobDispatchStarted;
  const markDispatchFailed =
    overrides.markBackgroundJobDispatchFailed ?? markBackgroundJobDispatchFailed;
  const publishEvents = overrides.publishDurableSessionEvents ?? publishDurableSessionEvents;

  async function publishTerminal(
    activityServices: ActivityServices,
    input: BackgroundJobControllerInput,
    attemptId: string,
    terminal: {
      status: BackgroundJobControllerResult["status"];
      exitCode?: number | null;
      error?: string | null;
    },
  ): Promise<BackgroundJobControllerResult> {
    const result = await settle(activityServices.db, {
      ...input,
      attemptId,
      status: terminal.status,
      ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      ...(terminal.error !== undefined ? { error: terminal.error } : {}),
    });
    if (result.delivery.reason !== "session_cancelled") {
      // PostgreSQL is authoritative and API SSE backfills from it. NATS is
      // best-effort live fanout, so a broker outage must not retry a committed
      // terminal settlement or keep provider resources alive.
      await publishEvents(
        activityServices.bus,
        input.workspaceId,
        result.job.originSessionId,
        result.delivery.events,
      ).catch(() => undefined);
      if (
        activityServices.wakeSessionWorkflow &&
        result.delivery.temporalWorkflowId &&
        result.delivery.workflowWakeRevision !== null
      ) {
        await activityServices
          .wakeSessionWorkflow({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: result.job.originSessionId,
            workflowId: result.delivery.temporalWorkflowId,
            wakeRevision: result.delivery.workflowWakeRevision,
          })
          .catch(() => undefined);
      }
    }
    return { status: terminal.status };
  }

  async function runBackgroundJobController(
    input: BackgroundJobControllerInput,
  ): Promise<BackgroundJobControllerResult> {
    const activityServices = await services();
    const provider = overrides.provider ?? activityServices.backgroundJobProvider;
    const hooks = overrides.hooks ?? defaultActivityHooks();
    const attempt = await createAttempt(activityServices.db, {
      ...input,
      controllerId: `background-job-${input.jobId}`,
    });
    const claim = await claimStart(activityServices.db, input.workspaceId, input.jobId);
    if (claim.action === "terminal") {
      if (!terminalStatus(claim.job.status)) {
        throw new Error(`Background job controller found unsupported state: ${claim.job.status}`);
      }
      return await publishTerminal(activityServices, input, attempt.id, {
        status: claim.job.status,
        ...(claim.job.exitCode !== null ? { exitCode: claim.job.exitCode } : {}),
        ...(claim.job.error !== null ? { error: claim.job.error } : {}),
      });
    }

    let providerInstanceId = claim.job.providerInstanceId;
    if (claim.action === "start") {
      const started = await provider.start({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        spec: claim.job.spec,
      });
      const attached = await attachProvider(activityServices.db, {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        attemptId: attempt.id,
        providerRef: started.providerRef,
        providerInstanceId: started.providerInstanceId,
        startedAt: new Date(),
      });
      if (!attached) {
        await provider.terminate(started.providerInstanceId).catch(() => undefined);
        throw new Error(`Background job provider attach fence lost: ${input.jobId}`);
      }
      providerInstanceId = started.providerInstanceId;
    }
    if (!providerInstanceId) {
      throw new Error(`Background job has no durable provider instance: ${input.jobId}`);
    }

    const startedAt = claim.job.startedAt ? Date.parse(claim.job.startedAt) : Date.now();
    const deadlineAt = claim.job.spec.timeoutSeconds
      ? new Date(startedAt + claim.job.spec.timeoutSeconds * 1_000)
      : null;
    let terminal: BackgroundJobProviderTerminal;
    try {
      terminal = await provider.observe({
        providerInstanceId,
        spec: claim.job.spec,
        deadlineAt,
        hooks: {
          heartbeat: hooks.heartbeat,
          sleep: hooks.sleep,
          shouldCancel: async () =>
            await cancelRequested(activityServices.db, input.workspaceId, input.jobId),
          onLog: async (log) => {
            await appendLog(activityServices.db, {
              ...input,
              attemptId: attempt.id,
              ...log,
            });
          },
        },
      });
    } catch (error) {
      if (error instanceof BackgroundJobProviderLostError) {
        terminal = {
          status: "lost" as const,
          error: error.message,
          artifacts: [],
        };
      } else {
        throw error;
      }
    }

    if (terminal.artifacts.length > 0) {
      if (!activityServices.objectStorage) {
        terminal = {
          status: "failed",
          exitCode: terminal.exitCode ?? null,
          error: "background job produced artifacts but object storage is not configured",
          artifacts: [],
        };
      } else {
        for (const artifact of terminal.artifacts) {
          if (artifact.bytes.byteLength > activityServices.objectStorage.maxSinglePutSizeBytes) {
            terminal = {
              status: "failed",
              exitCode: terminal.exitCode ?? null,
              error: `background job artifact exceeds storage limit: ${artifact.path}`,
              artifacts: [],
            };
            break;
          }
          const filename = posixPath.basename(artifact.path) || "artifact";
          const contentType = artifactContentType(filename);
          const storageKey = artifactStorageKey(input.workspaceId, input.jobId, artifact.path);
          const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
          await insertArtifact(activityServices.db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            jobId: input.jobId,
            path: artifact.path,
            filename,
            contentType,
            sizeBytes: artifact.bytes.byteLength,
            sha256,
            storageKey,
          });
          await activityServices.objectStorage.putObject({
            key: storageKey,
            contentType,
            body: artifact.bytes,
            sha256,
          });
        }
      }
    }
    const result = await publishTerminal(activityServices, input, attempt.id, terminal);
    // Cleanup is deliberately after durable terminal settlement. A transient
    // artifact/DB failure leaves the provider reattachable for the activity
    // retry instead of converting recoverable output into `lost`.
    await provider.terminate(providerInstanceId).catch(() => undefined);
    return result;
  }

  async function dispatchBackgroundJobControllers(limit = 100): Promise<number> {
    const activityServices = await services();
    if (!activityServices.startBackgroundJobWorkflow) return 0;
    const dispatches = await claimDispatches(activityServices.db, limit);
    let started = 0;
    for (const dispatch of dispatches) {
      try {
        await activityServices.startBackgroundJobWorkflow({
          accountId: dispatch.accountId,
          workspaceId: dispatch.workspaceId,
          jobId: dispatch.jobId,
          workflowId: dispatch.workflowId,
        });
        await markDispatchStarted(activityServices.db, dispatch);
        started += 1;
      } catch (error) {
        await markDispatchFailed(
          activityServices.db,
          dispatch,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return started;
  }

  return { runBackgroundJobController, dispatchBackgroundJobControllers };
}
