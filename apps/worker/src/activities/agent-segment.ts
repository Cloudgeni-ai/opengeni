import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  createTurn,
  applyCreditLedgerEntry,
  finishTurn,
  getBillingBalance,
  requireFile,
  getSessionEvent,
  getSessionTurn,
  requireSession,
  recordUsageEvent,
  saveRunState,
  setSessionStatus,
  sumUsageQuantity,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  modelResponseUsageFromSdkEvent,
  normalizeSdkEvent,
  type SandboxFileDownload,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { calculateModelUsageCostMicros, configuredModelPricing, configuredStaticUsageLimits, type ModelUsageInput, type Settings } from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import {
  mergeResourceRefs,
  mergeToolRefs,
} from "./common";
import { sandboxEnvironmentForRun } from "./environment";
import { enterHostGitHubAppRepositoryAuth } from "./github-host-git";
import { segmentInput } from "./run-input";
import {
  createRuntimeBatcher,
  currentActivityContext,
  nextStreamEvent,
  startActivityHeartbeat,
} from "./streaming";
import type {
  ActivityServices,
  RunAgentSegmentInput,
  RunAgentSegmentResult,
} from "./types";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import type { ResourceRef } from "@opengeni/contracts";

export function createRunAgentSegmentActivity(services: () => Promise<ActivityServices>) {
  return async function runAgentSegment(input: RunAgentSegmentInput): Promise<RunAgentSegmentResult> {
    const { settings, db, bus, runtime, objectStorage, observability } = await services();
    const activityStarted = performance.now();
    const activitySpan = observability.startSpan("worker.run_agent_segment", {
      "opengeni.session_id": input.sessionId,
      "opengeni.workflow_id": input.workflowId,
      "opengeni.trigger_event_id": input.triggerEventId,
    });
    let activityStatus = "unknown";
    let activityError: unknown;
    let turnId: string | undefined;
    let heartbeatTimer: ReturnType<typeof startActivityHeartbeat> | undefined;
    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    let preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null = null;
    let publish: ((events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate?: boolean) => Promise<void>) | null = null;
    let turnStartedPublished = false;
    try {
      runtime.configure(settings);
      const session = await requireSession(db, input.workspaceId, input.sessionId);
      const trigger = await getSessionEvent(db, input.workspaceId, input.triggerEventId);
      if (!trigger) {
        throw new Error(`Trigger event not found: ${input.triggerEventId}`);
      }
      let turn = input.turnId ? await getSessionTurn(db, input.workspaceId, input.turnId) : await claimNextQueuedTurnDb(db, input.workspaceId, input.sessionId, input.workflowId);
      if (!turn && !input.turnId) {
        const createdTurnId = await createTurn(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          temporalWorkflowId: input.workflowId,
          triggerEventId: input.triggerEventId,
        });
        turn = await getSessionTurn(db, input.workspaceId, createdTurnId);
      }
      if (!turn) {
        throw new Error(`Session turn not found for trigger: ${input.triggerEventId}`);
      }
      turnId = turn.id;
      const activityContext = currentActivityContext();
      heartbeatTimer = startActivityHeartbeat(activityContext, {
        phase: "running",
        sessionId: input.sessionId,
        turnId,
      });
      let producerSeq = 0;
      const producerId = `${input.workflowId}:${turnId}`;
      publish = async (events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate = false) => {
        const inputs = events.map((event) => ({
          ...event,
          turnId: turnId!,
          producerId,
          producerSeq: ++producerSeq,
        }));
        await appendAndPublishEvents(db, bus, input.workspaceId, input.sessionId, inputs);
        activityContext?.heartbeat({ phase: "events_published", sessionId: input.sessionId, turnId, producerSeq });
        if (immediate) {
          await Bun.sleep(0);
        }
      };
      activityContext?.heartbeat({ phase: "turn_started", sessionId: input.sessionId, turnId });

      await setSessionStatus(db, input.workspaceId, input.sessionId, "running", turnId);
      await publish([
        { type: "session.status.changed", payload: { status: "running" } },
        { type: "turn.started", payload: { triggerEventId: input.triggerEventId } },
      ], true);
      turnStartedPublished = true;

      const runSettings = {
        ...settings,
        openaiModel: turn.model,
        openaiReasoningEffort: turn.reasoningEffort,
        sandboxBackend: turn.sandboxBackend,
      };
      const turnResources = mergeResourceRefs(session.resources, turn.resources);
      const turnTools = mergeToolRefs(session.tools, turn.tools);
      const sandboxEnvironment = await sandboxEnvironmentForRun(runSettings, turnResources);
      const fileResourceDownloads = await sandboxFileDownloadsForRun(runSettings, db, objectStorage, input.workspaceId, turnResources);
      preparedTools = await runtime.prepareTools(runSettings, turnTools, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: "worker:first-party-mcp",
        subjectLabel: "OpenGeni worker",
      });
      const agent = runtime.buildAgent(runSettings, turnResources, {
        reasoningEffort: turn.reasoningEffort,
        sandboxEnvironment,
        fileResourceDownloads,
        mcpServers: preparedTools.mcpServers,
      });
      const runInput = await segmentInput(db, runtime, agent, trigger);
      await ensureRunAllowed(settings, db, input.accountId, input.workspaceId);
      let stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>>;
      let responseUsageCount = 0;
      const releaseHostGitAuth = await enterHostGitHubAppRepositoryAuth(sandboxEnvironment);
      try {
        stream = await runtime.runStream(agent, runInput, runSettings, {
          sandboxEnvironment,
          onRuntimeEvent: async (event) => {
            await publish!([{ type: event.type, payload: event.payload }], true);
          },
        });
        batcher = createRuntimeBatcher(async (events) => {
          await publish!(events);
        });

        const iterator = stream.toStream()[Symbol.asyncIterator]();
        let streamDone = false;
        try {
          while (true) {
            const next = await nextStreamEvent(iterator, activityContext);
            if (next.done) {
              streamDone = true;
              break;
            }
            const responseUsage = modelResponseUsageFromSdkEvent(next.value);
            if (responseUsage) {
              responseUsageCount += 1;
              await recordModelUsageAndDebitCredits(settings, db, {
                accountId: input.accountId,
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                turnId,
                model: turn.model,
                usage: responseUsage.usage,
                sourceKey: responseUsage.responseId ?? `response-${responseUsageCount}`,
              });
              await ensureRunAllowed(settings, db, input.accountId, input.workspaceId);
            }
            const normalized = normalizeSdkEvent(next.value);
            for (const event of normalized) {
              await batcher.push(event);
            }
          }
        } finally {
          if (!streamDone) {
            await iterator.return?.();
          }
        }
        await batcher.flush();
        await stream.completed.catch(() => undefined);
      } finally {
        releaseHostGitAuth();
      }
      if (responseUsageCount === 0) {
        await recordModelUsageAndDebitCredits(settings, db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          model: turn.model,
          usage: stream.state.usage,
          sourceKey: "aggregate",
        });
      }

      if (stream.interruptions.length > 0) {
        const approvals = runtime.serializeApprovals(stream.interruptions);
        await saveRunState(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          serializedRunState: stream.state.toString(),
          pendingApprovals: approvals,
        });
        await publish([
          { type: "session.requiresAction", payload: { approvals } },
          { type: "session.status.changed", payload: { status: "requires_action" } },
        ], true);
        await finishTurn(db, input.workspaceId, turnId, "requires_action");
        await setSessionStatus(db, input.workspaceId, input.sessionId, "requires_action", turnId);
        activityStatus = "requires_action";
        return { status: "requires_action" };
      }

      const finalOutput = String(stream.finalOutput ?? "");
      await saveRunState(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId,
        serializedRunState: stream.state.toString(),
        pendingApprovals: [],
      });
      await publish([
        { type: "agent.message.completed", payload: { text: finalOutput } },
        { type: "turn.completed", payload: { output: finalOutput } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ], true);
      await finishTurn(db, input.workspaceId, turnId, "idle");
      await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
      await recordUsageEvent(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        eventType: "agent_run.completed",
        quantity: 1,
        unit: "run",
        sourceResourceType: "session_turn",
        sourceResourceId: turnId,
        idempotencyKey: `usage:agent_run.completed:${turnId}`,
      });
      activityStatus = "idle";
      return { status: "idle" };
    } catch (error) {
      if (error instanceof CancelledFailure) {
        activityStatus = "cancelled";
        activityError = error;
        await batcher?.flush().catch(() => undefined);
        if (turnId) {
          await finishTurn(db, input.workspaceId, turnId, "cancelled").catch(() => undefined);
        }
        throw error;
      }
      activityStatus = "failed";
      activityError = error;
      if (!publish || !turnId || !turnStartedPublished) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      await publish([
        { type: "turn.failed", payload: { error: message } },
        { type: "session.status.changed", payload: { status: "failed" } },
      ], true);
      await finishTurn(db, input.workspaceId, turnId, "failed");
      await setSessionStatus(db, input.workspaceId, input.sessionId, "failed", null);
      return { status: "failed" };
    } finally {
      const durationSeconds = (performance.now() - activityStarted) / 1000;
      observability.recordWorkerActivity({
        activity: "runAgentSegment",
        status: activityStatus,
        durationSeconds,
      });
      activitySpan.end({
        attributes: {
          "opengeni.turn_id": turnId ?? "",
          "opengeni.status": activityStatus,
          "opengeni.duration_ms": Math.round(durationSeconds * 1000),
        },
        error: activityError,
      });
      await preparedTools?.close().catch(() => undefined);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  };
}

async function ensureRunAllowed(settings: Settings, db: ActivityServices["db"], accountId: string, workspaceId: string): Promise<void> {
  if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
    const balance = await getBillingBalance(db, accountId);
    if (balance.balanceMicros <= 0) {
      throw new Error("insufficient OpenGeni credits");
    }
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    if (limits.maxMonthlyAgentRunsPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      if (used > limits.maxMonthlyAgentRunsPerWorkspace) {
        throw new Error(`monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`);
      }
    }
    if (limits.maxMonthlyTokensPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId,
        eventType: "model.tokens",
        since: startOfUtcMonth(),
      });
      if (used >= limits.maxMonthlyTokensPerWorkspace) {
        throw new Error(`monthly token limit reached (${limits.maxMonthlyTokensPerWorkspace})`);
      }
    }
  }
}

async function recordModelUsageAndDebitCredits(settings: Settings, db: ActivityServices["db"], input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  model: string;
  usage?: ModelUsageInput | null;
  sourceKey: string;
}): Promise<void> {
  if (!input.usage) {
    return;
  }
  const inputTokens = positiveInt(input.usage.inputTokens);
  const outputTokens = positiveInt(input.usage.outputTokens);
  const totalTokens = positiveInt(input.usage.totalTokens) || inputTokens + outputTokens;
  if (totalTokens > 0) {
    await recordUsageEvent(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      eventType: "model.tokens",
      quantity: totalTokens,
      unit: "tokens",
      sourceResourceType: "model_response",
      sourceResourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `usage:model.tokens:${input.turnId}:${input.sourceKey}`,
    });
  }
  const shouldDebit = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  if (!shouldDebit || totalTokens === 0) {
    return;
  }
  if (!configuredModelPricing(settings)[input.model]) {
    throw new Error(`Missing model pricing for ${input.model}`);
  }
  const costMicros = calculateModelUsageCostMicros(settings, input.model, input.usage);
  await recordUsageEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    eventType: "model.cost",
    quantity: costMicros,
    unit: "usd_micros",
    sourceResourceType: "model_response",
    sourceResourceId: `${input.turnId}:${input.sourceKey}`,
    idempotencyKey: `usage:model.cost:${input.turnId}:${input.sourceKey}`,
  });
  if (costMicros > 0) {
    await applyCreditLedgerEntry(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      amountMicros: -costMicros,
      sourceType: "model_response",
      sourceId: `${input.turnId}:${input.sourceKey}`,
      idempotencyKey: `credit:model_usage_debit:${input.turnId}:${input.sourceKey}`,
      metadata: {
        model: input.model,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKey: input.sourceKey,
        inputTokens,
        outputTokens,
        totalTokens,
      },
    });
  }
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function sandboxFileDownloadsForRun(
  settings: Settings,
  db: ActivityServices["db"],
  objectStorage: ObjectStorage | null,
  workspaceId: string,
  resources: ResourceRef[],
): Promise<SandboxFileDownload[]> {
  if (settings.sandboxBackend === "none" || !requiresSignedFileResourceDownloads(settings)) {
    return [];
  }
  const fileResources = resources.filter((resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file");
  if (fileResources.length === 0) {
    return [];
  }
  if (!objectStorage) {
    throw new Error(`${settings.objectStorageBackend} file resources require configured object storage`);
  }
  const downloadStorage = objectStorageForSandboxDownloads(settings, objectStorage);
  const downloads: SandboxFileDownload[] = [];
  for (const resource of fileResources) {
    const file = await requireFile(db, workspaceId, resource.fileId);
    const url = await downloadStorage.createGetUrl({ key: file.objectKey });
    downloads.push({
      fileId: file.id,
      mountPath: resource.mountPath ?? `files/${file.id}`,
      filename: file.safeFilename,
      url: url.url,
      expiresAt: url.expiresAt,
      sizeBytes: file.sizeBytes,
    });
  }
  return downloads;
}

function requiresSignedFileResourceDownloads(settings: Settings): boolean {
  return (settings.sandboxBackend === "docker" && settings.objectStorageBackend === "s3-compatible")
    || settings.objectStorageBackend === "aws-s3"
    || settings.objectStorageBackend === "gcs"
    || (settings.sandboxBackend === "modal" && settings.objectStorageBackend === "azure-blob");
}

function objectStorageForSandboxDownloads(settings: Settings, objectStorage: ObjectStorage): ObjectStorage {
  if (settings.objectStorageBackend !== "s3-compatible" || !settings.objectStorageSandboxEndpoint) {
    return objectStorage;
  }
  return createObjectStorage({
    ...settings,
    objectStorageEndpoint: settings.objectStorageSandboxEndpoint,
  }) ?? objectStorage;
}
