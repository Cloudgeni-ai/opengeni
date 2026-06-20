import {
  AcknowledgeStreamRequest,
  AttachViewerRequest,
  ClearSessionContextRequest,
  ClientSessionEvent,
  CompactSessionContextRequest,
  ReorderSessionTurnsRequest,
  UpdateSessionGoalRequest,
  UpdateSessionTurnRequest,
  ViewerHeartbeatRequest,
  type SandboxBackend,
} from "@opengeni/contracts";
import { resolveContextCompactionMode, streamTokenDegraded } from "@opengeni/config";
import {
  cancelQueuedSessionTurn,
  clearSessionContext,
  getSession,
  getSessionGoal,
  getStreamAcknowledgment,
  listSessionEvents,
  listSessionIdsInGroup,
  listSessions,
  listSessionTurns,
  recordStreamAcknowledgment,
  reorderQueuedSessionTurns,
  requestSessionCompaction,
  requireSession,
  revokeViewer,
  setSessionGoalStatus,
  updateQueuedSessionTurn,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { negotiateCapabilities } from "@opengeni/runtime/sandbox";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "../access";
import type { ApiRouteDeps } from "../dependencies";
import { attachViewer, detachViewer, heartbeatViewer, readGroupLease } from "../sandbox/viewer";
import { settingsWithEnabledCapabilityMcpServers } from "../domain/capabilities";
import {
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
} from "../domain/resources";
import {
  acceptSessionUserMessage,
  createSessionForRequest,
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
    const session = await createSessionForRequest(deps, grant, workspaceId, await c.req.json());
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

  // Operator context controls (slash-command palette: /clear, /compact). These
  // are session/operator actions — NOT a structured channel to the agent. Both
  // require sessions:control.

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/context/clear", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    // Explicit confirm on the wire (literal true) — an empty/accidental POST
    // cannot wipe context. Mirrors the client-side confirm affordance. A
    // missing/false confirm is a client error (400), not a server fault.
    const clearBody = ClearSessionContextRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!clearBody.success) {
      throw new HTTPException(400, { message: "context clear requires an explicit { confirm: true }" });
    }
    const session = await requireSession(db, workspaceId, sessionId);
    // Clearing mid-turn would strand the in-flight RunState (and, in
    // requires_action, an awaiting approval whose resume needs that blob).
    // Refuse, mirroring the goal 409 guards.
    if (session.status === "queued" || session.status === "running" || session.status === "requires_action") {
      throw new HTTPException(409, { message: `session is ${session.status}; cannot clear context mid-turn — stop the turn first` });
    }
    const result = await clearSessionContext(db, { accountId: grant.accountId, workspaceId, sessionId });
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [{
      type: "session.context.cleared",
      payload: {
        clearedBy: "api",
        supersededItems: result.supersededItems,
        markerPosition: result.markerPosition,
      },
    }]);
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/context/compact", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    CompactSessionContextRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
    // /compact is only a TRIGGER — it never duplicates the compaction engine.
    // Client-managed (Azure) path: set a durable request flag the worker honors
    // before the next turn (forced compaction). Server-managed provider / off:
    // compaction is automatic or disabled, so this is an honest no-op.
    //
    // Integration seam with provider-aware-compaction: when that work exposes a
    // synchronous "compact now" entry callable from the API process, this route
    // should call it directly and return its result; until then the flag +
    // worker maybeCompactContext(force) is the minimal honored interface.
    const mode = resolveContextCompactionMode(settings);
    if (mode === "client") {
      await requestSessionCompaction(db, workspaceId, sessionId);
      return c.json({ status: "queued", message: "Compaction will run before the next turn." });
    }
    if (mode === "server") {
      return c.json({ status: "noop", message: "This session's provider compacts context automatically; no manual compaction is needed." });
    }
    return c.json({ status: "noop", message: "Context compaction is disabled for this session." });
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
      const { accepted } = await acceptSessionUserMessage(deps, grant, workspaceId, sessionId, {
        text: event.payload.text,
        resources: event.payload.resources ?? [],
        tools: event.payload.tools ?? [],
        toolsProvided: userMessagePayloadHasOwnProperty(rawEvent, "tools"),
        model: event.payload.model ?? null,
        reasoningEffort: event.payload.reasoningEffort ?? null,
        ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
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
      await workflowClient.signalInterrupt({
        accountId: grant.accountId,
        workspaceId,
        sessionId,
        eventId: accepted.id,
        workflowId,
      });
    }
    return c.json(accepted, 202);
  });

  // ── API-direct stream capabilities + viewer attach (P1.4) ─────────────────
  //
  // All IN-PROCESS: capability negotiation reads the descriptor + the group
  // lease (liveness/epoch); viewer attach acquires a holder on the group lease
  // and (when cold) spins the box up via resume-by-id — NO worker, NO Temporal.
  // Gated behind sandboxOwnershipEnabled (the lease is inert with the flag off).
  //
  // ROUTE DISCIPLINE: requireAccessGrant BEFORE any Zod parse; explicit
  // HTTPException(400) on a parse failure (never a raw ZodError → 500);
  // HTTPException(409) on an epoch fence.

  function assertOwnershipEnabled(): void {
    if (!settings.sandboxOwnershipEnabled) {
      // The viewer-holder lifecycle rides the sandbox lease, which is dormant
      // until the flag flips per-environment. A 404 (not 403) keeps the route
      // invisible while disabled — it does not exist for this deployment yet.
      throw new HTTPException(404, { message: "sandbox ownership is not enabled for this deployment" });
    }
  }

  // Resolve the shared-exposure disclosure for a session's group: `shared` when
  // the group has >1 session (addendum E.1), and the OTHER sessions' ids ONLY
  // (never their conversation/metadata; the query selects only id — stress g).
  async function resolveSharedExposure(
    workspaceId: string,
    session: { id: string; sandboxGroupId: string },
  ): Promise<{ shared: boolean; sharedSessionIds: string[] }> {
    const ids = await listSessionIdsInGroup(db, workspaceId, session.sandboxGroupId);
    const others = ids.filter((id) => id !== session.id);
    return { shared: others.length > 0, sharedSessionIds: others };
  }

  // GET .../stream-capabilities — the capability-negotiation read. Returns the
  // SessionCapabilities doc (descriptor + lease liveness/epoch + os + the
  // shared-exposure disclosure + the calling principal's acknowledgment state),
  // API-direct. The desktop URL/token stay null until P4 mints them (gated by
  // liveness=cold until a box is warm); the read is non-mutating.
  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/stream-capabilities", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId");
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const lease = await readGroupLease({ db, settings }, { workspaceId, sandboxGroupId: session.sandboxGroupId });
    const { shared, sharedSessionIds } = await resolveSharedExposure(workspaceId, session);
    // Per-principal acknowledgment: A acknowledging does not consent for B. A
    // shared box requires the SHARED acknowledgment, so `acknowledged` for a
    // shared box is the shared-consent bit, not the bare un-redacted one.
    const ack = await getStreamAcknowledgment(db, { workspaceId, sandboxGroupId: session.sandboxGroupId, subjectId: grant.subjectId });
    const acknowledged = ack ? (shared ? ack.acknowledgedShared : ack.acknowledgedUnredacted) : false;
    const capabilities = negotiateCapabilities({
      sessionId,
      backend: session.sandboxBackend as SandboxBackend,
      os: session.sandboxOs,
      liveness: lease?.liveness ?? "cold",
      leaseEpoch: lease?.leaseEpoch ?? 0,
      desktopEnabled: settings.sandboxDesktopEnabled,
      // Graceful degrade (I8/OD-8): if desktop is enabled but no stream-token
      // secret is resolvable, the desktop cell reports transport:null rather
      // than advertising a plane we can never authorize.
      streamTokenSecretAvailable: !streamTokenDegraded(settings),
      desktopAcknowledged: acknowledged,
      shared,
      sharedSessionIds,
    });
    return c.json(capabilities);
  });

  // POST .../stream-capabilities/acknowledge — record the calling principal's
  // acknowledgment of the un-redacted pixel plane (and, when shared, the
  // shared-exposure disclosure). Reuses the acknowledgment machinery — gated on
  // stream:acknowledge, no new permission. Until this is recorded the
  // desktop-stream (viewer attach) path returns 409 (P3.2 consent gate).
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/stream-capabilities/acknowledge", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "stream:acknowledge");
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId");
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const parsed = AcknowledgeStreamRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid stream acknowledgment request" });
    }
    const recorded = await recordStreamAcknowledgment(db, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      subjectId: grant.subjectId,
      acknowledgeUnredacted: parsed.data.acknowledgeUnredacted,
      acknowledgeShared: parsed.data.acknowledgeShared,
    });
    return c.json({ acknowledged: recorded.acknowledgedUnredacted, acknowledgedShared: recorded.acknowledgedShared });
  });

  // POST .../viewers — acquire a viewer holder on the desktop-stream (un-redacted
  // pixel) path. Gated on stream:view (strictly broader than sessions:read: the
  // pixel plane is un-redacted). THE CONSENT GATE: until the calling principal
  // has acknowledged the un-redacted plane this returns 409
  // stream_acknowledgment_required; when the box is shared and the shared-exposure
  // disclosure is not acknowledged it returns 409 shared_acknowledgment_required.
  // Only after consent does it acquire the holder (spinning the box up in-process
  // when cold).
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/viewers", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "stream:view");
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId");
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const parsed = AttachViewerRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid viewer attach request" });
    }
    // Consent gate (P3.2 / addendum E.1): the un-redacted desktop path requires
    // the calling principal's acknowledgment, recorded per (group, subject). A
    // shared box additionally requires the shared-exposure consent.
    const { shared } = await resolveSharedExposure(workspaceId, session);
    const ack = await getStreamAcknowledgment(db, { workspaceId, sandboxGroupId: session.sandboxGroupId, subjectId: grant.subjectId });
    if (!ack?.acknowledgedUnredacted) {
      throw new HTTPException(409, { message: "stream_acknowledgment_required" });
    }
    if (shared && !ack.acknowledgedShared) {
      throw new HTTPException(409, { message: "shared_acknowledgment_required" });
    }
    const result = await attachViewer({ db, settings }, {
      accountId: grant.accountId,
      workspaceId,
      session,
      ...(parsed.data.viewerId ? { viewerId: parsed.data.viewerId } : {}),
    });
    return c.json(result, 201);
  });

  // POST .../viewers/:viewerId/heartbeat — refresh the holder TTL (epoch-fenced).
  // The desktop-stream lifecycle is gated on stream:view (the un-redacted plane).
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId/heartbeat", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "stream:view");
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId");
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const parsed = ViewerHeartbeatRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "viewer heartbeat requires { leaseEpoch }" });
    }
    const alive = await heartbeatViewer({ db, settings }, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      viewerId: c.req.param("viewerId"),
      expectedEpoch: parsed.data.leaseEpoch,
    });
    return c.json({ alive });
  });

  // DELETE .../viewers/:viewerId — release the holder (idempotent).
  app.delete("/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "stream:view");
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId");
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    await detachViewer({ db, settings }, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      viewerId: c.req.param("viewerId"),
    });
    return c.body(null, 204);
  });

  // POST .../viewers/:viewerId/revoke — OD-6 v1 revocation. Drops the named
  // viewer's holder from the GROUP lease so refcount recomputes; the box drains
  // iff nothing else holds it (a turn-held or other-viewer-held box survives —
  // group-refcount liveness). Gated on stream:view (no new permission). The
  // live-RFB force-disconnect of an already-open socket is a P4 follow-up; the
  // holder-drop (so the box can drain) is the v1 deliverable.
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId/revoke", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "stream:view");
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId");
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const result = await revokeViewer(db, {
      accountId: grant.accountId,
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      viewerId: c.req.param("viewerId"),
      idleGraceMs: settings.sandboxIdleGraceMs,
    });
    // null ⇒ the lease was already cold-and-reaped (revoke is an idempotent no-op).
    return c.json({ liveness: result?.liveness ?? null, refcount: result?.refcount ?? null });
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
