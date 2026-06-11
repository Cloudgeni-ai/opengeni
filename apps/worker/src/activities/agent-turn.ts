import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  createTurn,
  applyCreditDebitUpToBalance,
  finishTurn,
  getBillingBalance,
  requireFile,
  getSessionEvent,
  getSessionGoal,
  getSessionTurn,
  requireSession,
  recordUsageEvent,
  appendSessionHistoryItems,
  countSessionHistoryItems,
  saveRunState,
  upsertSandboxSessionEnvelope,
  setSessionStatus,
  sumUsageQuantity,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  sandboxStateEntryFromRunState,
  agentsErrorRunState,
  maxTurnsExceededRunState,
  modelResponseUsageFromSdkEvent,
  normalizeSdkEvent,
  type SandboxFileDownload,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { calculateModelUsageCostMicros, configuredModelPricing, configuredStaticUsageLimits, type ModelUsageInput, type Settings } from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import {
  mergeResourceRefs,
  mergeToolRefs,
} from "./common";
import { loadWorkspaceEnvironmentForRun, sandboxEnvironmentForRun } from "./environment";
import { createSecretRedactor, identityRedactor } from "./redaction";
import { turnInput } from "./run-input";
import {
  createRuntimeBatcher,
  currentActivityContext,
  nextStreamEvent,
  startActivityHeartbeat,
} from "./streaming";
import type {
  ActivityServices,
  RunAgentTurnInput,
  RunAgentTurnResult,
} from "./types";
import { createObjectStorage, type ObjectStorage } from "@opengeni/storage";
import type { ResourceRef } from "@opengeni/contracts";

// How long the session workflow holds the loop after a retryable provider
// failure before the goal continuation re-enters the model. Azure/OpenAI TPM
// throttling is minute-granular; anything shorter mostly burns continuation
// budget against the same window.
export const PROVIDER_BACKPRESSURE_DELAY_MS = 60_000;

export function createRunAgentTurnActivity(services: () => Promise<ActivityServices>) {
  return async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
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
    let stream: Awaited<ReturnType<OpenGeniRuntime["runStream"]>> | undefined;
    // Dual-write of conversation truth (issue #35): completed items are
    // reconciled into session_history_items after every model response and at
    // every turn-end path (idempotent on position, watermark-sliced), and the
    // sandbox recovery envelope is upserted alongside. Best-effort by design:
    // persistence problems must never fail the run.
    let persistedHistoryCount = 0;
    const reconcileConversationTruth = async () => {
      if (!stream || !turnId) {
        return;
      }
      try {
        const history = (stream.state as { history?: unknown[] }).history;
        if (Array.isArray(history) && history.length > persistedHistoryCount) {
          const rows = history.slice(persistedHistoryCount).map((item, offset) => ({
            position: persistedHistoryCount + offset,
            item: item as Record<string, unknown>,
          }));
          await appendSessionHistoryItems(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            items: rows,
          });
          persistedHistoryCount = history.length;
        }
        const envelope = sandboxStateEntryFromRunState(stream.state);
        if (envelope) {
          await upsertSandboxSessionEnvelope(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            envelope,
          });
        }
      } catch (persistError) {
        console.error("session history dual-write failed (run unaffected)", persistError);
      }
    };
    // Reassigned after the workspace environment loads; the publish closure is
    // created (and used for turn.started) before the environment is available.
    let redact: (payload: unknown) => unknown = identityRedactor;
    let environmentId = "";
    try {
      const capabilitySettings = await settingsWithEnabledCapabilityMcpServers(db, input.workspaceId, settings);
      runtime.configure(capabilitySettings);
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
      await ensureRunAllowed(settings, db, input.accountId, input.workspaceId);
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
          payload: redact(event.payload),
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
        ...capabilitySettings,
        openaiModel: turn.model,
        openaiReasoningEffort: turn.reasoningEffort,
        sandboxBackend: turn.sandboxBackend,
      };
      const turnResources = mergeResourceRefs(session.resources, turn.resources);
      const turnTools = mergeToolRefs(session.tools, turn.tools);
      const workspaceEnvironment = await loadWorkspaceEnvironmentForRun(db, runSettings, input.workspaceId, session.environmentId);
      environmentId = workspaceEnvironment?.id ?? "";
      redact = createSecretRedactor(
        Object.entries(workspaceEnvironment?.values ?? {}).map(([name, value]) => ({ name, value })),
      );
      const sandboxEnvironment = await sandboxEnvironmentForRun(runSettings, turnResources, workspaceEnvironment?.values ?? {});
      const fileResourceDownloads = await sandboxFileDownloadsForRun(runSettings, db, objectStorage, input.workspaceId, turnResources);
      preparedTools = await runtime.prepareTools(runSettings, turnTools, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        subjectId: "worker:first-party-mcp",
        subjectLabel: "OpenGeni worker",
      });
      const agent = runtime.buildAgent(runSettings, turnResources, {
        reasoningEffort: turn.reasoningEffort,
        sandboxEnvironment,
        fileResourceDownloads,
        mcpServers: preparedTools.mcpServers,
        ...(workspaceEnvironment
          ? {
            workspaceEnvironment: {
              name: workspaceEnvironment.name,
              description: workspaceEnvironment.description,
              variableNames: Object.keys(workspaceEnvironment.values),
            },
          }
          : {}),
      });
      const runInput = await turnInput(db, runtime, agent, trigger, runSettings);
      persistedHistoryCount = await countSessionHistoryItems(db, input.workspaceId, input.sessionId);
      let responseUsageCount = 0;
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
            await reconcileConversationTruth();
            try {
              await ensureRunAllowed(settings, db, input.accountId, input.workspaceId);
            } catch (limitError) {
              // Capture the run state at the boundary so the budget valve in
              // the outer catch can end this segment gracefully with full
              // conversation context preserved for the post-top-up resume.
              let serializedRunState: string | null = null;
              try {
                serializedRunState = stream.state.toString();
              } catch {
                serializedRunState = null;
              }
              throw new BudgetExhaustedError(
                limitError instanceof Error ? limitError.message : String(limitError),
                serializedRunState,
              );
            }
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
        await reconcileConversationTruth();
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
      await reconcileConversationTruth();
      if (settings.sessionHistorySource !== "items") {
        // Legacy conversation memory; in items mode the blob is only written
        // for requires_action pauses (the one RunState-only resume path).
        await saveRunState(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          turnId,
          serializedRunState: stream.state.toString(),
          pendingApprovals: [],
        });
      }
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
      // The SDK's per-segment turn cap is a pacing valve, not a failure: end
      // the turn gracefully and idle the session so an active goal continues
      // via a synthesized continuation turn (or a user message resumes work).
      // The run state captured at the cap keeps full conversation context for
      // that resumption.
      const maxTurns = maxTurnsExceededRunState(error);
      if (maxTurns && publish && turnId && turnStartedPublished) {
        await batcher?.flush().catch(() => undefined);
        // The SDK attaches the run state at the throw site; persisting it lets
        // the continuation resume with this segment's full context. If capture
        // ever fails, the continuation falls back to the previous snapshot --
        // degraded context, flagged on the event, but still strictly better
        // than a terminal failed session: the sandbox filesystem state
        // persists independently and the agent re-derives from it.
        await reconcileConversationTruth();
        const runStateSaved = Boolean(maxTurns.serializedRunState) && settings.sessionHistorySource !== "items";
        if (maxTurns.serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState: maxTurns.serializedRunState,
            pendingApprovals: [],
          });
        }
        await publish([
          { type: "turn.completed", payload: { output: "", segmentLimit: "max_turns", runStateSaved } },
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
      }
      // Budget/limit exhaustion between model calls is account state, not an
      // agent failure: idle the session for goal-bearing and goal-less runs
      // alike (a failed session would reject the user's next message after a
      // top-up). An active goal pauses visibly with reason "limits" at the
      // next continuation evaluation, without consuming continuation budget.
      if (error instanceof BudgetExhaustedError && publish && turnId && turnStartedPublished) {
        await batcher?.flush().catch(() => undefined);
        await reconcileConversationTruth();
        const runStateSaved = Boolean(error.serializedRunState) && settings.sessionHistorySource !== "items";
        if (error.serializedRunState && settings.sessionHistorySource !== "items") {
          await saveRunState(db, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            turnId,
            serializedRunState: error.serializedRunState,
            pendingApprovals: [],
          });
        }
        await publish([
          { type: "turn.completed", payload: { output: "", segmentLimit: "budget_exhausted", detail: error.message, runStateSaved } },
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
      }
      // A retryable provider failure (rate limit) on a goal-bearing session is
      // transient backpressure, not a session failure: the in-client retry
      // budget is already exhausted by the time the error reaches here, so
      // fail the turn truthfully but idle the session and let the goal
      // continuation loop resume after a pacing delay. Sessions without an
      // active goal keep the terminal behavior -- there is no continuation
      // machinery to resume them, and a failed session is the honest signal
      // for the user to retry.
      const failure = agentRunFailurePayload(error);
      if (failure.retryable && publish && turnId && turnStartedPublished) {
        const goal = await getSessionGoal(db, input.workspaceId, input.sessionId).catch(() => null);
        if (goal && goal.status === "active") {
          await batcher?.flush().catch(() => undefined);
          // Provider errors rarely carry SDK run state; a null falls back to
          // the previous snapshot, same degraded-context contract as the
          // max-turns path above.
          await reconcileConversationTruth();
          const serializedRunState = agentsErrorRunState(error);
          const runStateSaved = Boolean(serializedRunState) && settings.sessionHistorySource !== "items";
          if (serializedRunState && settings.sessionHistorySource !== "items") {
            await saveRunState(db, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              turnId,
              serializedRunState,
              pendingApprovals: [],
            });
          }
          await publish([
            { type: "turn.failed", payload: { ...failure, recovery: "goal_continuation", runStateSaved } },
            { type: "session.status.changed", payload: { status: "idle" } },
          ], true);
          await finishTurn(db, input.workspaceId, turnId, "failed");
          await setSessionStatus(db, input.workspaceId, input.sessionId, "idle", null);
          activityStatus = "idle";
          activityError = error;
          return { status: "idle", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS };
        }
      }
      activityStatus = "failed";
      activityError = error;
      if (!publish || !turnId || !turnStartedPublished) {
        throw error;
      }
      await publish([
        { type: "turn.failed", payload: failure },
        { type: "session.status.changed", payload: { status: "failed" } },
      ], true);
      await finishTurn(db, input.workspaceId, turnId, "failed");
      await setSessionStatus(db, input.workspaceId, input.sessionId, "failed", null);
      return { status: "failed" };
    } finally {
      const durationSeconds = (performance.now() - activityStarted) / 1000;
      observability.recordWorkerActivity({
        activity: "runAgentTurn",
        status: activityStatus,
        durationSeconds,
      });
      activitySpan.end({
        attributes: {
          "opengeni.turn_id": turnId ?? "",
          "opengeni.status": activityStatus,
          "opengeni.environment_id": environmentId,
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

export function agentRunFailurePayload(error: unknown): { error: string; code?: string; retryable?: boolean; detail?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: unknown }).status)
    : undefined;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
  if (status === 429 || code === "rate_limit_exceeded" || /(?:too many requests|rate.?limit|\b429\b)/i.test(message)) {
    return {
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      ...(message && message !== "Too Many Requests" ? { detail: message } : {}),
    };
  }
  return { error: message };
}

/**
 * Budget/limit exhaustion detected between model calls. This is account
 * state, not an agent failure: the segment ends gracefully (session idles,
 * run state preserved) so a top-up or limit reset lets the same session
 * continue — a failed session would reject the user's next message. An
 * active goal pauses visibly (reason "limits") at the next continuation
 * evaluation without consuming continuation budget.
 */
class BudgetExhaustedError extends Error {
  constructor(message: string, readonly serializedRunState: string | null) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
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
        // Agent turns are admitted and recorded before this worker activity starts.
        // Equality means this accepted turn is exactly at the cap; greater-than is
        // the race/backstop case where another admission already exceeded the cap.
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
    await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "model_usage_debit",
      requestedAmountMicros: costMicros,
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
