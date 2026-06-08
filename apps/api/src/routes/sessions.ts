import {
  ClientSessionEvent,
  CreateSessionRequest,
  ReorderSessionTurnsRequest,
  UpdateSessionTurnRequest,
} from "@opengeni/contracts";
import {
  appendSessionEventsWithLockedSessionUpdate,
  cancelQueuedSessionTurn,
  enqueueSessionTurn,
  getSession,
  listSessionEvents,
  listSessionTurns,
  reorderQueuedSessionTurns,
  requireSession,
  updateQueuedSessionTurn,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "../domain/capabilities";
import {
  mergeResourceRefs,
  mergeToolRefs,
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "../domain/resources";
import {
  createAndStartSession,
  reasoningEffortForSession,
  requireQueuedTurnForApi,
  workflowIdForSession,
} from "../domain/sessions";
import { assertSessionExists, boundedLimit } from "../http/common";
import { sseSessionStream } from "../http/sse";

export function registerSessionRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db, bus, workflowClient, objectStorage } = deps;

  app.post("/v1/sessions", async (c) => {
    const rawPayload = await c.req.json();
    const payload = CreateSessionRequest.parse(rawPayload);
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, settings);
    const resources = normalizeResources(payload.resources);
    const requestedTools = validateToolRefs(payload.tools, runtimeSettings);
    const tools = hasOwnProperty(rawPayload, "tools")
      ? requestedTools
      : withDefaultEnabledCapabilityMcpTools(requestedTools, settings, runtimeSettings);
    validateGitHubRepositorySelection(resources);
    if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await validateFileResources(db, resources);
    const model = payload.model ?? settings.openaiModel;
    const reasoningEffort = payload.reasoningEffort ?? settings.openaiReasoningEffort;
    const session = await createAndStartSession({
      db,
      bus,
      workflowClient,
      initialMessage: payload.initialMessage,
      resources,
      tools,
      ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
      model,
      reasoningEffort,
      sandboxBackend: payload.sandboxBackend ?? settings.sandboxBackend,
      metadata: payload.metadata,
    });
    return c.json(session, 202);
  });

  app.get("/v1/sessions/:sessionId", async (c) => {
    const session = await getSession(db, c.req.param("sessionId"));
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return c.json(session);
  });

  app.get("/v1/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, sessionId);
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 500);
    return c.json(await listSessionEvents(db, sessionId, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500));
  });

  app.get("/v1/sessions/:sessionId/events/stream", async (c) => {
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, sessionId);
    const after = Number(c.req.query("after") ?? c.req.header("Last-Event-ID") ?? 0);
    return sseSessionStream(db, bus, sessionId, Number.isFinite(after) ? after : 0, c.req.raw.signal);
  });

  app.get("/v1/sessions/:sessionId/turns", async (c) => {
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, sessionId);
    return c.json(await listSessionTurns(db, sessionId, boundedLimit(c.req.query("limit"))));
  });

  app.patch("/v1/sessions/:sessionId/turns/:turnId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const turnId = c.req.param("turnId");
    await assertSessionExists(db, sessionId);
    const existing = await requireQueuedTurnForApi(db, sessionId, turnId);
    const payload = UpdateSessionTurnRequest.parse(await c.req.json());
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, settings);
    const resources = payload.resources !== undefined ? normalizeResources(payload.resources) : existing.resources;
    const tools = payload.tools !== undefined ? validateToolRefs(payload.tools, runtimeSettings) : existing.tools;
    if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await validateFileResources(db, resources);
    const session = await requireSession(db, sessionId);
    validateGitHubRepositorySelection([...session.resources, ...resources]);
    const turn = await updateQueuedSessionTurn(db, turnId, {
      ...(payload.prompt !== undefined ? { prompt: payload.prompt.trim() } : {}),
      ...(payload.model !== undefined ? { model: payload.model } : {}),
      ...(payload.reasoningEffort !== undefined ? { reasoningEffort: payload.reasoningEffort } : {}),
      ...(payload.sandboxBackend !== undefined ? { sandboxBackend: payload.sandboxBackend } : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      resources,
      tools,
    });
    await appendAndPublishEvents(db, bus, sessionId, [{
      type: "turn.updated",
      turnId: turn.id,
      payload: { turnId: turn.id },
    }]);
    return c.json(turn);
  });

  app.post("/v1/sessions/:sessionId/turns/reorder", async (c) => {
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, sessionId);
    const payload = ReorderSessionTurnsRequest.parse(await c.req.json());
    const turns = await reorderQueuedSessionTurns(db, sessionId, payload.turnIds);
    await appendAndPublishEvents(db, bus, sessionId, [{
      type: "turn.updated",
      payload: { reorderedTurnIds: payload.turnIds },
    }]);
    await workflowClient.wakeSessionWorkflow({ sessionId, workflowId: workflowIdForSession(sessionId) });
    return c.json(turns);
  });

  app.delete("/v1/sessions/:sessionId/turns/:turnId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const turnId = c.req.param("turnId");
    await assertSessionExists(db, sessionId);
    await requireQueuedTurnForApi(db, sessionId, turnId);
    const turn = await cancelQueuedSessionTurn(db, turnId);
    await appendAndPublishEvents(db, bus, sessionId, [{
      type: "turn.cancelled",
      turnId: turn.id,
      payload: { turnId: turn.id, triggerEventId: turn.triggerEventId },
    }]);
    return c.json(turn);
  });

  app.post("/v1/sessions/:sessionId/events", async (c) => {
    const sessionId = c.req.param("sessionId");
    const rawEvent = await c.req.json();
    const event = ClientSessionEvent.parse(rawEvent);
    if (event.type === "user.message") {
      const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, settings);
      const requestedResources = normalizeResources(event.payload.resources ?? []);
      const validatedTools = validateToolRefs(event.payload.tools ?? [], runtimeSettings);
      const requestedTools = userMessagePayloadHasOwnProperty(rawEvent, "tools")
        ? validatedTools
        : withDefaultEnabledCapabilityMcpTools(validatedTools, settings, runtimeSettings);
      const requestedModel = event.payload.model ?? null;
      const requestedReasoningEffort = event.payload.reasoningEffort ?? null;
      if (requestedResources.some((resource) => resource.kind === "file") && !objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      await validateFileResources(db, requestedResources);
      const appended = await appendSessionEventsWithLockedSessionUpdate(db, sessionId, (lockedSession) => {
        if (lockedSession.status === "failed" || lockedSession.status === "cancelled") {
          throw new HTTPException(409, { message: `session is ${lockedSession.status}; cannot accept a new user message` });
        }
        validateGitHubRepositorySelection([...lockedSession.resources, ...requestedResources]);
        const nextResources = mergeResourceRefs(lockedSession.resources, requestedResources);
        const nextTools = mergeToolRefs(lockedSession.tools, requestedTools);
        const shouldQueueSession = lockedSession.status === "idle";
        return {
          events: [
            {
              type: event.type,
              payload: {
                text: event.payload.text,
                ...(requestedResources.length ? { resources: requestedResources } : {}),
                ...(requestedTools.length ? { tools: requestedTools } : {}),
                ...(requestedModel ? { model: requestedModel } : {}),
                ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
              },
              ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
            },
            ...(shouldQueueSession ? [{ type: "session.status.changed" as const, payload: { status: "queued" } }] : []),
          ],
          update: {
            resources: nextResources,
            tools: nextTools,
            ...(shouldQueueSession ? { status: "queued" as const, activeTurnId: null } : {}),
          },
        };
      }).then(async (events) => {
        await bus.publish(sessionId, events);
        return events;
      });
      const accepted = appended[0];
      if (!accepted) {
        throw new HTTPException(500, { message: "failed to append client event" });
      }
      const workflowId = workflowIdForSession(sessionId);
      const session = await requireSession(db, sessionId);
      const turn = await enqueueSessionTurn(db, {
        sessionId,
        triggerEventId: accepted.id,
        temporalWorkflowId: workflowId,
        source: "user",
        prompt: event.payload.text,
        resources: requestedResources,
        tools: requestedTools,
        model: requestedModel ?? session.model,
        reasoningEffort: requestedReasoningEffort ?? reasoningEffortForSession(session.metadata, settings.openaiReasoningEffort),
        sandboxBackend: session.sandboxBackend,
        metadata: {},
      });
      await appendAndPublishEvents(db, bus, sessionId, [{
        type: "turn.queued",
        turnId: turn.id,
        payload: { turnId: turn.id, triggerEventId: accepted.id, source: turn.source },
      }]);
      await workflowClient.wakeSessionWorkflow({ sessionId, workflowId });
      return c.json(accepted, 202);
    }

    const session = await requireSession(db, sessionId);
    if (event.type === "user.approvalDecision" && session.status !== "requires_action") {
      throw new HTTPException(409, { message: `session is ${session.status}; no approval is pending` });
    }
    const eventsToAppend: AppendEventInput[] = [{
      type: event.type,
      payload: event.payload,
      ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
    }];
    const appended = await appendAndPublishEvents(db, bus, sessionId, eventsToAppend);
    const accepted = appended[0];
    if (!accepted) {
      throw new HTTPException(500, { message: "failed to append client event" });
    }
    const workflowId = workflowIdForSession(sessionId);
    if (event.type === "user.approvalDecision") {
      await workflowClient.signalApprovalDecision({ sessionId, eventId: accepted.id, workflowId });
    } else {
      await workflowClient.signalInterrupt({ sessionId, eventId: accepted.id, workflowId });
    }
    return c.json(accepted, 202);
  });
}

function hasOwnProperty(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function userMessagePayloadHasOwnProperty(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = (value as { payload?: unknown }).payload;
  return hasOwnProperty(payload, key);
}
