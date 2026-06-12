import {
  ClientSessionEvent,
  CreateSessionRequest,
  ReorderSessionTurnsRequest,
  UpdateSessionGoalRequest,
  UpdateSessionTurnRequest,
  type ToolRef,
} from "@opengeni/contracts";
import {
  appendSessionEventsWithLockedSessionUpdate,
  cancelQueuedSessionTurn,
  enqueueSessionTurn,
  getSession,
  getSessionGoal,
  listSessionEvents,
  listSessions,
  listSessionTurns,
  reorderQueuedSessionTurns,
  requireSession,
  setSessionGoalStatus,
  updateQueuedSessionTurn,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type { ApiRouteDeps } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "../domain/capabilities";
import { validateEnvironmentAttachment } from "../domain/environments";
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

  app.post("/v1/workspaces/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    const rawPayload = await c.req.json();
    const payload = CreateSessionRequest.parse(rawPayload);
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
    const resources = normalizeResources(payload.resources);
    const requestedTools = validateToolRefs(payload.tools, runtimeSettings);
    const defaultedTools = hasOwnProperty(rawPayload, "tools")
      ? requestedTools
      : withDefaultEnabledCapabilityMcpTools(requestedTools, settings, runtimeSettings);
    // Goal-bearing sessions force the first-party MCP server so the goal
    // tools the continuation prompt references are reachable.
    const tools = payload.goal ? withFirstPartyGoalTools(defaultedTools, runtimeSettings) : defaultedTools;
    await validateGitHubRepositorySelection(db, workspaceId, resources);
    if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await validateFileResources(db, workspaceId, resources);
    const environment = payload.environmentId
      ? await validateEnvironmentAttachment({ settings, db }, grant, workspaceId, payload.environmentId)
      : null;
    const model = payload.model ?? settings.openaiModel;
    const reasoningEffort = payload.reasoningEffort ?? settings.openaiReasoningEffort;
    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "agent_run:create", quantity: 1 });
    const session = await createAndStartSession({
      db,
      bus,
      workflowClient,
      accountId: grant.accountId,
      workspaceId,
      initialMessage: payload.initialMessage,
      resources,
      tools,
      ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
      model,
      reasoningEffort,
      sandboxBackend: payload.sandboxBackend ?? settings.sandboxBackend,
      metadata: payload.metadata,
      environment: environment ? { id: environment.id, name: environment.name } : null,
      goal: payload.goal ?? null,
    });
    await recordWorkspaceUsage(deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session",
      sourceResourceId: session.id,
      idempotencyKey: `agent_run.created:${workspaceId}:${session.id}`,
    });
    return c.json(session, 202);
  });

  app.get("/v1/workspaces/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(await listSessions(db, workspaceId, boundedLimit(c.req.query("limit"))));
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const session = await getSession(db, workspaceId, c.req.param("sessionId"));
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return c.json(session);
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/goal", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const goal = await getSessionGoal(db, workspaceId, sessionId);
    if (!goal) {
      throw new HTTPException(404, { message: "session goal not found" });
    }
    return c.json(goal);
  });

  app.patch("/v1/workspaces/:workspaceId/sessions/:sessionId/goal", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = UpdateSessionGoalRequest.parse(await c.req.json());
    const existing = await getSessionGoal(db, workspaceId, sessionId);
    if (!existing) {
      throw new HTTPException(404, { message: "session goal not found" });
    }
    if (existing.status === "completed") {
      throw new HTTPException(409, { message: "session goal is completed; set a new goal instead" });
    }
    if (payload.status === "paused") {
      const { goal, changed } = await setSessionGoalStatus(db, workspaceId, sessionId, {
        status: "paused",
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
        pausedReason: "api",
      });
      if (changed) {
        await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
          type: "goal.paused",
          payload: {
            goalId: goal.id,
            actor: "api",
            reason: "api",
            ...(payload.rationale ? { rationale: payload.rationale } : {}),
            autoContinuations: goal.autoContinuations,
            noProgressStreak: goal.noProgressStreak,
          },
        }]);
      }
      return c.json(goal);
    }
    // Resume: only valid from paused; resets counters and re-arms the loop.
    if (existing.status !== "paused") {
      throw new HTTPException(409, { message: `session goal is ${existing.status}; only paused goals can be resumed` });
    }
    const { goal, changed } = await setSessionGoalStatus(db, workspaceId, sessionId, { status: "active" });
    // `changed` guards the racing-PATCH case: both requests can pass the
    // status pre-check, but only the transition winner emits and wakes.
    if (changed) {
      await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
        type: "goal.resumed",
        payload: {
          goalId: goal.id,
          text: goal.text,
          ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
          version: goal.version,
          actor: "api",
        },
      }]);
      // signalWithStart restarts a completed workflow whose first claim finds no
      // queued turn, so maybeContinueGoal fires — resume works on an idle session.
      await workflowClient.wakeSessionWorkflow({ accountId: grant.accountId, workspaceId, sessionId, workflowId: workflowIdForSession(sessionId) });
    }
    return c.json(goal);
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/events", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const after = Number(c.req.query("after") ?? 0);
    const limit = Number(c.req.query("limit") ?? 500);
    return c.json(await listSessionEvents(db, workspaceId, sessionId, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500));
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/events/stream", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const after = Number(c.req.query("after") ?? c.req.header("Last-Event-ID") ?? 0);
    return sseSessionStream(db, bus, workspaceId, sessionId, Number.isFinite(after) ? after : 0, c.req.raw.signal);
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/turns", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    return c.json(await listSessionTurns(db, workspaceId, sessionId, boundedLimit(c.req.query("limit"))));
  });

  app.patch("/v1/workspaces/:workspaceId/sessions/:sessionId/turns/:turnId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const turnId = c.req.param("turnId");
    await assertSessionExists(db, workspaceId, sessionId);
    const existing = await requireQueuedTurnForApi(db, workspaceId, sessionId, turnId);
    const payload = UpdateSessionTurnRequest.parse(await c.req.json());
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
    const resources = payload.resources !== undefined ? normalizeResources(payload.resources) : existing.resources;
    const tools = payload.tools !== undefined ? validateToolRefs(payload.tools, runtimeSettings) : existing.tools;
    if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await validateFileResources(db, workspaceId, resources);
    const session = await requireSession(db, workspaceId, sessionId);
    await validateGitHubRepositorySelection(db, workspaceId, [...session.resources, ...resources]);
    const turn = await updateQueuedSessionTurn(db, workspaceId, turnId, {
      ...(payload.prompt !== undefined ? { prompt: payload.prompt.trim() } : {}),
      ...(payload.model !== undefined ? { model: payload.model } : {}),
      ...(payload.reasoningEffort !== undefined ? { reasoningEffort: payload.reasoningEffort } : {}),
      ...(payload.sandboxBackend !== undefined ? { sandboxBackend: payload.sandboxBackend } : {}),
      ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
      resources,
      tools,
    });
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
      type: "turn.updated",
      turnId: turn.id,
      payload: { turnId: turn.id },
    }]);
    return c.json(turn);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/turns/reorder", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = ReorderSessionTurnsRequest.parse(await c.req.json());
    const turns = await reorderQueuedSessionTurns(db, workspaceId, sessionId, payload.turnIds);
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
      type: "turn.updated",
      payload: { reorderedTurnIds: payload.turnIds },
    }]);
    await workflowClient.wakeSessionWorkflow({ accountId: grant.accountId, workspaceId, sessionId, workflowId: workflowIdForSession(sessionId) });
    return c.json(turns);
  });

  app.delete("/v1/workspaces/:workspaceId/sessions/:sessionId/turns/:turnId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const turnId = c.req.param("turnId");
    await assertSessionExists(db, workspaceId, sessionId);
    await requireQueuedTurnForApi(db, workspaceId, sessionId, turnId);
    const turn = await cancelQueuedSessionTurn(db, workspaceId, turnId);
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
      type: "turn.cancelled",
      turnId: turn.id,
      payload: { turnId: turn.id, triggerEventId: turn.triggerEventId },
    }]);
    return c.json(turn);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/events", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const rawEvent = await c.req.json();
    const event = ClientSessionEvent.parse(rawEvent);
    if (event.type === "user.message") {
      const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings);
      const requestedResources = normalizeResources(event.payload.resources ?? []);
      const validatedTools = validateToolRefs(event.payload.tools ?? [], runtimeSettings);
      const requestedTools = userMessagePayloadHasOwnProperty(rawEvent, "tools")
        ? validatedTools
        : withDefaultEnabledCapabilityMcpTools(validatedTools, settings, runtimeSettings);
      const requestedModel = event.payload.model ?? null;
      const requestedReasoningEffort = event.payload.reasoningEffort ?? null;
      await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "agent_run:create", quantity: 1 });
      if (requestedResources.some((resource) => resource.kind === "file") && !objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      await validateFileResources(db, workspaceId, requestedResources);
      const existingSession = await requireSession(db, workspaceId, sessionId);
      await validateGitHubRepositorySelection(db, workspaceId, [...existingSession.resources, ...requestedResources]);
      const appended = await appendSessionEventsWithLockedSessionUpdate(db, workspaceId, sessionId, (lockedSession) => {
        if (lockedSession.status === "failed" || lockedSession.status === "cancelled") {
          throw new HTTPException(409, { message: `session is ${lockedSession.status}; cannot accept a new user message` });
        }
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
        await bus.publish(workspaceId, sessionId, events);
        return events;
      });
      const accepted = appended[0];
      if (!accepted) {
        throw new HTTPException(500, { message: "failed to append client event" });
      }
      const workflowId = workflowIdForSession(sessionId);
      const session = await requireSession(db, workspaceId, sessionId);
      const turn = await enqueueSessionTurn(db, {
        accountId: grant.accountId,
        workspaceId,
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
      await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
        type: "turn.queued",
        turnId: turn.id,
        payload: { turnId: turn.id, triggerEventId: accepted.id, source: turn.source },
      }]);
	      await workflowClient.wakeSessionWorkflow({ accountId: grant.accountId, workspaceId, sessionId, workflowId });
	      await recordWorkspaceUsage(deps, {
	        accountId: grant.accountId,
	        workspaceId,
	        subjectId: grant.subjectId,
	        eventType: "agent_run.created",
	        quantity: 1,
	        unit: "run",
	        sourceResourceType: "session_turn",
	        sourceResourceId: turn.id,
	        idempotencyKey: `agent_run.created:${workspaceId}:${turn.id}`,
	      });
	      return c.json(accepted, 202);
	    }

    const session = await requireSession(db, workspaceId, sessionId);
    if (event.type === "user.approvalDecision" && session.status !== "requires_action") {
      throw new HTTPException(409, { message: `session is ${session.status}; no approval is pending` });
    }
    const eventsToAppend: AppendEventInput[] = [{
      type: event.type,
      payload: event.payload,
      ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
    }];
    const appended = await appendAndPublishEvents(db, bus, workspaceId, sessionId, eventsToAppend);
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

function withFirstPartyGoalTools(tools: ToolRef[], runtimeSettings: { mcpServers: Array<{ id: string }> }): ToolRef[] {
  if (!runtimeSettings.mcpServers.some((server) => server.id === "opengeni")) {
    return tools;
  }
  return mergeToolRefs(tools, [{ kind: "mcp", id: "opengeni" }]);
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
