import {
  claimNextQueuedTurn as claimNextQueuedTurnDb,
  createTurn,
  finishTurn,
  requireFile,
  getSessionEvent,
  getSessionTurn,
  requireSession,
  saveRunState,
  setSessionStatus,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  normalizeSdkEvent,
  type SandboxFileDownload,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import type { Settings } from "@opengeni/config";
import { CancelledFailure } from "@temporalio/activity";
import {
  mergeResourceRefs,
  mergeToolRefs,
} from "./common";
import { sandboxEnvironmentForRun } from "./environment";
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
import type { ObjectStorage } from "@opengeni/storage";
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
    runtime.configure(settings);
    const session = await requireSession(db, input.sessionId);
    const trigger = await getSessionEvent(db, input.triggerEventId);
    if (!trigger) {
      throw new Error(`Trigger event not found: ${input.triggerEventId}`);
    }
    let turn = input.turnId ? await getSessionTurn(db, input.turnId) : await claimNextQueuedTurnDb(db, input.sessionId, input.workflowId);
    if (!turn && !input.turnId) {
      const turnId = await createTurn(db, {
        sessionId: input.sessionId,
        temporalWorkflowId: input.workflowId,
        triggerEventId: input.triggerEventId,
      });
      turn = await getSessionTurn(db, turnId);
    }
    if (!turn) {
      throw new Error(`Session turn not found for trigger: ${input.triggerEventId}`);
    }
    const turnId = turn.id;
    const activityContext = currentActivityContext();
    const heartbeatTimer = startActivityHeartbeat(activityContext, {
      phase: "running",
      sessionId: input.sessionId,
      turnId,
    });
    let producerSeq = 0;
    const producerId = `${input.workflowId}:${turnId}`;
    const publish = async (events: Array<Omit<AppendEventInput, "producerId" | "producerSeq" | "turnId">>, immediate = false) => {
      const inputs = events.map((event) => ({
        ...event,
        turnId,
        producerId,
        producerSeq: ++producerSeq,
      }));
      await appendAndPublishEvents(db, bus, input.sessionId, inputs);
      activityContext?.heartbeat({ phase: "events_published", sessionId: input.sessionId, turnId, producerSeq });
      if (immediate) {
        await Bun.sleep(0);
      }
    };
    activityContext?.heartbeat({ phase: "turn_started", sessionId: input.sessionId, turnId });

    let batcher: ReturnType<typeof createRuntimeBatcher> | null = null;
    let preparedTools: Awaited<ReturnType<OpenGeniRuntime["prepareTools"]>> | null = null;
    await setSessionStatus(db, input.sessionId, "running", turnId);
    await publish([
      { type: "session.status.changed", payload: { status: "running" } },
      { type: "turn.started", payload: { triggerEventId: input.triggerEventId } },
    ], true);

    try {
      const runSettings = {
        ...settings,
        openaiModel: turn.model,
        openaiReasoningEffort: turn.reasoningEffort,
        sandboxBackend: turn.sandboxBackend,
      };
      const turnResources = mergeResourceRefs(session.resources, turn.resources);
      const turnTools = mergeToolRefs(session.tools, turn.tools);
      const sandboxEnvironment = await sandboxEnvironmentForRun(runSettings, turnResources);
      const fileResourceDownloads = await sandboxFileDownloadsForRun(runSettings, db, objectStorage, turnResources);
      preparedTools = await runtime.prepareTools(runSettings, turnTools);
      const agent = runtime.buildAgent(runSettings, turnResources, {
        reasoningEffort: turn.reasoningEffort,
        sandboxEnvironment,
        fileResourceDownloads,
        mcpServers: preparedTools.mcpServers,
      });
      const runInput = await segmentInput(db, runtime, agent, trigger);
      const stream = await runtime.runStream(agent, runInput, runSettings, {
        sandboxEnvironment,
        onRuntimeEvent: async (event) => {
          await publish([{ type: event.type, payload: event.payload }], true);
        },
      });
      batcher = createRuntimeBatcher(async (events) => {
        await publish(events);
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

      if (stream.interruptions.length > 0) {
        const approvals = runtime.serializeApprovals(stream.interruptions);
        await saveRunState(db, {
          sessionId: input.sessionId,
          turnId,
          serializedRunState: stream.state.toString(),
          pendingApprovals: approvals,
        });
        await publish([
          { type: "session.requiresAction", payload: { approvals } },
          { type: "session.status.changed", payload: { status: "requires_action" } },
        ], true);
        await finishTurn(db, turnId, "requires_action");
        await setSessionStatus(db, input.sessionId, "requires_action", turnId);
        activityStatus = "requires_action";
        return { status: "requires_action" };
      }

      const finalOutput = String(stream.finalOutput ?? "");
      await saveRunState(db, {
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
      await finishTurn(db, turnId, "idle");
      await setSessionStatus(db, input.sessionId, "idle", null);
      activityStatus = "idle";
      return { status: "idle" };
    } catch (error) {
      if (error instanceof CancelledFailure) {
        activityStatus = "cancelled";
        activityError = error;
        await batcher?.flush().catch(() => undefined);
        await finishTurn(db, turnId, "cancelled").catch(() => undefined);
        throw error;
      }
      activityStatus = "failed";
      activityError = error;
      const message = error instanceof Error ? error.message : String(error);
      await publish([
        { type: "turn.failed", payload: { error: message } },
        { type: "session.status.changed", payload: { status: "failed" } },
      ], true);
      await finishTurn(db, turnId, "failed");
      await setSessionStatus(db, input.sessionId, "failed", null);
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
          "opengeni.turn_id": typeof turnId === "string" ? turnId : "",
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

async function sandboxFileDownloadsForRun(
  settings: Settings,
  db: ActivityServices["db"],
  objectStorage: ObjectStorage | null,
  resources: ResourceRef[],
): Promise<SandboxFileDownload[]> {
  if (settings.sandboxBackend !== "modal" || settings.objectStorageBackend !== "azure-blob") {
    return [];
  }
  const fileResources = resources.filter((resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file");
  if (fileResources.length === 0) {
    return [];
  }
  if (!objectStorage) {
    throw new Error("Modal Azure Blob file resources require configured object storage");
  }
  const downloads: SandboxFileDownload[] = [];
  for (const resource of fileResources) {
    const file = await requireFile(db, resource.fileId);
    const content = await objectStorage.getFileBytes(file);
    downloads.push({
      fileId: file.id,
      mountPath: resource.mountPath ?? `files/${file.id}`,
      filename: file.safeFilename,
      content,
      sizeBytes: file.sizeBytes,
    });
  }
  return downloads;
}
