import {
  AcknowledgeStreamRequest,
  AttachViewerRequest,
  ClearSessionContextRequest,
  ClientSessionEvent,
  CompactSessionContextRequest,
  FsDeleteRequest,
  FsListRequest,
  FsMkdirRequest,
  FsMoveRequest,
  FsReadRequest,
  FsWriteRequest,
  GitDiffRequest,
  GitLogRequest,
  GitShowRequest,
  GitStatusRequest,
  PtyCloseRequest,
  PtyOpenRequest,
  PtyResizeRequest,
  PtyWriteRequest,
  ReorderSessionTurnsRequest,
  TerminalExecRequest,
  UpdateSessionGoalRequest,
  UpdateSessionRequest,
  UpdateSessionTurnRequest,
  ViewerHeartbeatRequest,
  type SandboxBackend,
  type Session,
  type TerminalPtyExitedPayload,
  type TerminalPtyOutputDeltaPayload,
  type TerminalPtyStartedPayload,
} from "@opengeni/contracts";
import { resolveContextCompactionMode, streamTokenDegraded } from "@opengeni/config";
import {
  cancelQueuedSessionTurn,
  clearSessionContext,
  closePtySession,
  getOpenPtySession,
  getSandbox,
  getSession,
  getSessionGoal,
  getStreamAcknowledgment,
  insertPtySession,
  listSessionEvents,
  listSessionIdsInGroup,
  listSessions,
  listSessionTurns,
  recordStreamAcknowledgment,
  reorderQueuedSessionTurns,
  requestSessionCompaction,
  requireSession,
  setSessionCodexPin,
  revokeViewer,
  setSessionGoalStatus,
  updatePtySessionActivity,
  updateQueuedSessionTurn,
  type AppendEventInput,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import { withChannelA } from "../sandbox/channel-a";
import { negotiateCapabilities } from "@opengeni/runtime/sandbox";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { attachViewer, detachViewer, heartbeatViewer, mintDesktopStream, mintTerminalStream, readGroupLease, resolveActiveDesktopTransport, viewerHeartbeatIntervalMs, type DesktopStreamMint, type TerminalStreamMint } from "../sandbox/viewer";
import { settingsWithEnabledCapabilityMcpServers, settingsWithSessionMcpServerMetadata } from "@opengeni/core";
import {
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
} from "@opengeni/core";
import {
  acceptSessionUserMessage,
  assertConfiguredModel,
  createSessionForRequest,
  requireQueuedTurnForApi,
  updateSessionTitle,
  workflowIdForSession,
} from "@opengeni/core";
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

  // Pin (or unpin) the session's Codex account. body { target: "auto" | "<id>" }:
  // "auto" clears the pin (the session follows the workspace active pointer); a
  // uuid pins the session to that specific account. The pin applies to the NEXT
  // turn (the worker reads it at turn start). 404 when the session or the target
  // account id isn't in the workspace.
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/codex-account", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json()) as { target?: string };
    const target = typeof body.target === "string" ? body.target : "";
    if (!target) {
      throw new HTTPException(400, { message: "target is required (\"auto\" or an account id)" });
    }
    const pinned = target === "auto" ? null : target;
    const ok = await setSessionCodexPin(db, workspaceId, sessionId, pinned);
    if (!ok) {
      throw new HTTPException(404, { message: "session or codex account not found" });
    }
    return c.json({ pinned: target === "auto" ? "auto" : target });
  });

  // Manual rename. A user-set title is permanent: the db write is
  // unconditional (source='user'), so it always pins the session over later
  // agent writes. Returns the refreshed session, mirroring GET detail.
  app.patch("/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = UpdateSessionRequest.parse(await c.req.json());
    await updateSessionTitle({ db, bus }, workspaceId, sessionId, payload.title, "user");
    const session = await getSession(db, workspaceId, sessionId);
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
    const after = eventSequence(c.req.query("after"), 0);
    const before = optionalEventSequence(c.req.query("before"));
    const limit = eventListLimit(c.req.query("limit"));
    return c.json(await listSessionEvents(db, workspaceId, sessionId, {
      after,
      ...(before !== undefined ? { before } : {}),
      limit,
    }));
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
    // A turn-update may switch the queued turn's model; reject one the host
    // does not expose (omitted leaves the existing model unchanged).
    assertConfiguredModel(settings, payload.model);
    const session = await requireSession(db, workspaceId, sessionId);
    const runtimeSettings = settingsWithSessionMcpServerMetadata(
      await settingsWithEnabledCapabilityMcpServers(db, workspaceId, settings),
      session.mcpServers,
    );
    const resources = payload.resources !== undefined ? normalizeResources(payload.resources) : existing.resources;
    const tools = payload.tools !== undefined ? validateToolRefs(payload.tools, runtimeSettings) : existing.tools;
    if (resources.some((resource) => resource.kind === "file") && !objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await validateFileResources(db, workspaceId, resources);
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
        mcpCredentialUpdates: event.payload.mcpCredentialUpdates ?? [],
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
    // Per-principal acknowledgment: A acknowledging does not consent for B. The
    // un-redacted desktop stream ALWAYS requires the un-redacted ack; a shared box
    // ADDITIONALLY requires the shared-exposure ack. Both must match the POST
    // /viewers gate EXACTLY — otherwise a principal who recorded shared consent
    // WITHOUT un-redacted consent could be handed a live VNC URL + scoped token
    // from this read path while being correctly 409'd on attach (a consent-gate
    // bypass of the un-redacted pixel plane).
    const ack = await getStreamAcknowledgment(db, { workspaceId, sandboxGroupId: session.sandboxGroupId, subjectId: grant.subjectId });
    const acknowledged = ack ? (ack.acknowledgedUnredacted && (!shared || ack.acknowledgedShared)) : false;

    // P4.2 — the pixel DATA PLANE, served API-direct. When the backend is
    // desktop-capable AND sandboxDesktopEnabled AND the (shared, if shared)
    // acknowledgment is present AND the box is WARM, mint the REAL DesktopStream
    // cell IN-PROCESS: resume the box by id, ensureDisplayStack (idempotent),
    // exposeStreamPort (resolve the 6080 tunnel + mint the scoped token), record
    // data_plane_url under the epoch fence, and emit stream.url.rotated to other
    // viewers on a box rollover. The handshake never SPINS UP a cold box (that is
    // the viewer-attach path) — a cold lease stays lease_cold. A degraded mint
    // (no secret / display-stack or tunnel failure) returns null → transport:null.
    let desktopStream: DesktopStreamMint | null = null;
    const desktopUnlocked =
      settings.sandboxDesktopEnabled
      && !streamTokenDegraded(settings)
      && acknowledged
      && (session.activeSandboxId != null || lease?.liveness === "warm" || lease?.liveness === "draining");
    if (desktopUnlocked) {
      desktopStream = await mintDesktopStream({ db, settings, bus }, {
        accountId: grant.accountId,
        workspaceId,
        session,
        // The handshake's token is scoped to the calling principal (it is a read,
        // not a viewer-holder acquire); the per-holder token is re-minted on
        // POST /viewers. A previousEpoch != current would have rotated already
        // via the warming-commit; the read does not itself drive rotation.
        viewerId: grant.subjectId,
        ...(lease ? { lease } : {}),
      });
    }

    // P5.t — the REAL PTY terminal cell, served API-DIRECT. Independent of the
    // desktop: it gates ONLY on sandboxTerminalEnabled + a real-PTY backend + a
    // WARM box (NO un-redacted ack — the terminal cell has no acknowledgment
    // gate). A degraded mint (terminal off / no secret / ttyd or tunnel failure)
    // returns null → the Terminal cell falls back to the sse-events firehose.
    let terminalStream: TerminalStreamMint | null = null;
    const terminalUnlocked =
      settings.sandboxTerminalEnabled
      && !streamTokenDegraded(settings)
      && (session.activeSandboxId != null || lease?.liveness === "warm" || lease?.liveness === "draining");
    if (terminalUnlocked) {
      terminalStream = await mintTerminalStream({ db, settings, bus }, {
        accountId: grant.accountId,
        workspaceId,
        session,
        viewerId: grant.subjectId,
        ...(lease ? { lease } : {}),
      });
    }

    const capabilities = negotiateCapabilities({
      sessionId,
      backend: session.sandboxBackend as SandboxBackend,
      os: session.sandboxOs,
      liveness: lease?.liveness ?? "cold",
      leaseEpoch: lease?.leaseEpoch ?? 0,
      desktopEnabled: settings.sandboxDesktopEnabled,
      // Human take-control: when the desktop is available + this policy is on
      // (default), the cell is mode "interactive" — the noVNC viewer drives :0
      // (x11vnc runs without -viewonly). Off → mode "read-only" (client disables
      // take-control). Independent of the agent's computerUseReadOnly.
      desktopInteractive: settings.sandboxDesktopInteractive,
      // P4.3 computer-use: the agent drives :0 (xdotool/scrot); availability
      // tracks the desktop tier + a desktop-capable backend.
      computerUseEnabled: settings.computerUseEnabled,
      computerUseReadOnly: settings.computerUseReadOnly,
      // Graceful degrade (I8/OD-8): if desktop is enabled but no stream-token
      // secret is resolvable, the desktop cell reports transport:null rather
      // than advertising a plane we can never authorize.
      streamTokenSecretAvailable: !streamTokenDegraded(settings),
      desktopAcknowledged: acknowledged,
      shared,
      sharedSessionIds,
      // The minted live address (null when not unlocked/degraded). The resolver
      // only folds it in when the desktop gates pass + the ack is present.
      ...(desktopStream
        ? {
            desktopStream: {
              url: desktopStream.url,
              token: desktopStream.token,
              expiresAt: desktopStream.expiresAt,
              resolution: desktopStream.resolution,
            },
          }
        : {}),
      // P5.t — the terminal policy toggle + the minted pty-ws address. The
      // resolver advertises sse-events (firehose) on a cold/disabled terminal and
      // folds the live pty-ws url/token in only when the gates passed + minted.
      terminalEnabled: settings.sandboxTerminalEnabled,
      ...(terminalStream
        ? {
            terminalStream: {
              url: terminalStream.url,
              token: terminalStream.token,
              expiresAt: terminalStream.expiresAt,
            },
          }
        : {}),
    });

    // SWAP-CASE desktop transport (BOTH directions): negotiateCapabilities keyed on
    // the HOME backend, but the pixel plane actually runs on the ACTIVE sandbox — and
    // the two backends use DIFFERENT wire transports. The advertised transport MUST
    // match where mintDesktopStream routed the pixels (relay IFF the active sandbox is
    // a selfhosted machine), or the client picks the wrong renderer and the socket
    // closes before it opens:
    //   • modal-HOME swapped ONTO a selfhosted machine: negotiate says vnc-ws, but the
    //     machine's desktop is the RELAY framebuffer (PNG-per-frame) → flip to
    //     relay-frames/frames. (#171)
    //   • selfhosted-HOME swapped AWAY to the cloud group box (activeSandboxId=null OR a
    //     non-selfhosted active sandbox): negotiate says relay-frames (home=selfhosted),
    //     but there is NO relay producer on the Modal box → the client hangs on a dead
    //     relay socket ("desktop stream closed before it opened"). Flip to the Modal
    //     noVNC/RFB tunnel (vnc-ws/novnc). This is the mirror of #171 and the missing
    //     half that this fixes.
    // The single invariant: advertise relay-frames IFF (activeSandboxId set AND the
    // active sandbox kind is "selfhosted") — EXACTLY mintDesktopStream's routing. When
    // the desktop is available we set the transport from the ACTIVE sandbox in one
    // place (resolveActiveDesktopTransport), covering BOTH swap directions.
    let responseCapabilities = capabilities;
    if (capabilities.DesktopStream.transport !== null) {
      const activeSandbox = session.activeSandboxId ? await getSandbox(db, workspaceId, session.activeSandboxId) : null;
      const wire = resolveActiveDesktopTransport(activeSandbox?.kind === "selfhosted", settings.sandboxDesktopInteractive !== false);
      responseCapabilities = {
        ...capabilities,
        DesktopStream: { ...capabilities.DesktopStream, ...wire },
      };
    }
    return c.json(responseCapabilities);
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
    // Consent gate (P3.2 / addendum E.1): ONLY the un-redacted DESKTOP pixel plane
    // requires the calling principal's acknowledgment (recorded per group+subject;
    // a shared box additionally needs the shared-exposure consent). A TERMINAL-ONLY
    // warm attach (`desktop:false`, the default) carries NO consent gate — a shell
    // is interactive by nature and the gate is the scoped tunnel URL + stream token
    // — so it warms the box and mints the pty-ws terminal cell without a 409. Gating
    // the terminal attach behind the desktop ack (the bug this fixes) dead-ended the
    // interactive terminal: the box never warmed → the Terminal cell stayed on the
    // read-only sse-events firehose forever ("read only"), and with the desktop tier
    // off by default there was no consent flow to ever clear the gate.
    const wantDesktop = parsed.data.desktop ?? false;
    const { shared } = await resolveSharedExposure(workspaceId, session);
    if (wantDesktop) {
      const ack = await getStreamAcknowledgment(db, { workspaceId, sandboxGroupId: session.sandboxGroupId, subjectId: grant.subjectId });
      if (!ack?.acknowledgedUnredacted) {
        throw new HTTPException(409, { message: "stream_acknowledgment_required" });
      }
      if (shared && !ack.acknowledgedShared) {
        throw new HTTPException(409, { message: "shared_acknowledgment_required" });
      }
    }
    // SELFHOSTED ACTIVE: when the session's active sandbox is selfhosted, skip
    // attachViewer (it warms the Modal group box — the wrong target). Synthesize a
    // result shaped like ViewerAttachResult and mint relay cells directly.
    const activeSandbox = session.activeSandboxId ? await getSandbox(db, workspaceId, session.activeSandboxId) : null;
    const selfhostedActive = activeSandbox?.kind === "selfhosted";

    let stream: DesktopStreamMint | null = null;
    let terminal: TerminalStreamMint | null = null;

    let result: Awaited<ReturnType<typeof attachViewer>>;
    if (selfhostedActive) {
      const viewerId = parsed.data.viewerId ?? crypto.randomUUID();
      result = {
        viewerId,
        liveness: "warm",
        leaseEpoch: session.activeEpoch,
        sandboxGroupId: session.sandboxGroupId,
        viewerHeartbeatIntervalMs: viewerHeartbeatIntervalMs(settings),
        dataPlaneUrl: null,
      };
      if (
        (settings.sandboxDesktopEnabled || settings.sandboxTerminalEnabled)
        && !streamTokenDegraded(settings)
      ) {
        if (wantDesktop && settings.sandboxDesktopEnabled) {
          stream = await mintDesktopStream({ db, settings, bus }, {
            accountId: grant.accountId,
            workspaceId,
            session,
            viewerId,
            // No Modal lease for selfhosted-active; the mint routes to the relay.
          });
        }
        if (settings.sandboxTerminalEnabled) {
          terminal = await mintTerminalStream({ db, settings, bus }, {
            accountId: grant.accountId,
            workspaceId,
            session,
            viewerId,
            // No Modal lease for selfhosted-active; the mint routes to the relay.
          });
        }
      }
    } else {
      result = await attachViewer({ db, settings }, {
        accountId: grant.accountId,
        workspaceId,
        session,
        ...(parsed.data.viewerId ? { viewerId: parsed.data.viewerId } : {}),
      });

      // P4.2 — the viewer now holds a WARM box; mint the real pixel cell IN-PROCESS
      // (resume by id → ensureDisplayStack → exposeStreamPort) scoped to THIS
      // viewer holder, record data_plane_url, and fold the live address into the
      // response. A degraded mint (no secret / headless / display-stack or tunnel
      // failure) leaves dataPlaneUrl null — the client falls back to Channel-A. The
      // box is warm here (attachViewer spun it up or attached), so the handshake's
      // never-spin-up rule does not apply.
      if (
        (settings.sandboxDesktopEnabled || settings.sandboxTerminalEnabled)
        && !streamTokenDegraded(settings)
      ) {
        const lease = await readGroupLease({ db, settings }, { workspaceId, sandboxGroupId: session.sandboxGroupId });
        if (lease) {
          // The pixel cell is minted only when the caller asked for the desktop plane
          // (and consented above). A terminal-only attach skips it — the box is warm,
          // the terminal mint below still runs.
          if (wantDesktop && settings.sandboxDesktopEnabled) {
            stream = await mintDesktopStream({ db, settings, bus }, {
              accountId: grant.accountId,
              workspaceId,
              session,
              viewerId: result.viewerId,
              lease,
            });
          }
          // P5.t — the same warm-box viewer attach also mints the REAL PTY terminal
          // address (independent of the desktop toggle). A degraded mint leaves the
          // terminal fields null → the client falls back to the sse-events firehose.
          if (settings.sandboxTerminalEnabled) {
            terminal = await mintTerminalStream({ db, settings, bus }, {
              accountId: grant.accountId,
              workspaceId,
              session,
              viewerId: result.viewerId,
              lease,
            });
          }
        }
      }
    }
    return c.json(
      {
        ...result,
        dataPlaneUrl: stream?.url ?? result.dataPlaneUrl,
        streamToken: stream?.token ?? null,
        streamExpiresAt: stream?.expiresAt ?? null,
        resolution: stream?.resolution ?? null,
        // Transport MUST match where the pixels were minted: a selfhosted-active box
        // serves the RELAY framebuffer (relay-frames/frames), a Modal box serves noVNC
        // (vnc-ws/novnc). Hardcoding vnc-ws here handed a machine's relay URL to the
        // noVNC renderer (and vice-versa on the swap-away case) → "closed before it
        // opened". Key off the SAME selfhostedActive the mint routed on.
        transport: stream ? (selfhostedActive ? ("relay-frames" as const) : ("vnc-ws" as const)) : null,
        client: stream ? (selfhostedActive ? ("frames" as const) : ("novnc" as const)) : null,
        // The REAL PTY terminal address (pty-ws), null when degraded.
        terminalUrl: terminal?.url ?? null,
        terminalToken: terminal?.token ?? null,
        terminalExpiresAt: terminal?.expiresAt ?? null,
        terminalTransport: terminal ? ("pty-ws" as const) : null,
      },
      201,
    );
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

  // ══════════════════════ Channel-A structured services (P4.4) ══════════════
  //
  // FileSystem (list/read/write/delete) + Git (status/diff/log/show) + Terminal
  // (exec + interactive PTY), all served API-DIRECT: each route does
  //   requireAccessGrant BEFORE Zod parse  ->  resume the box by id in-process
  //   (cold->warming CAS + viewer holder)  ->  SandboxChannelAService method
  //   ->  inline JSON  ->  release holder + drop handle.
  // NO Temporal, NO worker RPC, NO NATS round-trip — reads never ride the bus
  // (which would corrupt SSE gap-fill). The notifications (fs.changed/git.changed
  // /terminal.pty.*) ride A1 via appendAndPublishEvents. Gated behind
  // sandboxOwnershipEnabled (the lease is dormant otherwise). Explicit
  // HTTPException(400/404/409) — never a raw ZodError -> 500.

  // FS uses files:read for reads, files:write for mutations; Git is read-only
  // (rides files:read); Terminal exec + PTY ride terminal:attach.

  type ChannelARouteCtx = {
    accountId: string;
    workspaceId: string;
    session: Session;
    subjectId: string;
  };

  // Shared preamble: grant BEFORE parse, ownership gate, session lookup. Returns
  // the resolved context the channel-a seam needs (session narrowed non-null).
  async function channelAPreamble(
    c: Context,
    permission: "files:read" | "files:write" | "terminal:attach",
  ): Promise<ChannelARouteCtx> {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const grant = await requireAccessGrant(c, deps, workspaceId, permission);
    assertOwnershipEnabled();
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return { accountId: grant.accountId, workspaceId, session, subjectId: grant.subjectId };
  }

  async function parseChannelABody<T>(c: Context, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): Promise<T> {
    const raw = await c.req.json().catch(() => undefined);
    const result = schema.safeParse(raw ?? {});
    if (!result.success) {
      throw new HTTPException(400, { message: "invalid request body" });
    }
    return result.data;
  }

  // ── FileSystem ──────────────────────────────────────────────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/list", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, FsListRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.fsList(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, FsReadRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.fsRead(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/write", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsWriteRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.fsWrite(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/delete", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsDeleteRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.fsDelete(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/move", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsMoveRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.fsMove(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/mkdir", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsMkdirRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.fsMkdir(req));
    return c.json(out);
  });

  // ── Git (read-only) ─────────────────────────────────────────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/status", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitStatusRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.gitStatus(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitDiffRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.gitDiff(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/log", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitLogRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.gitLog(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/show", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitShowRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.gitShow(req));
    return c.json(out);
  });

  // ── Terminal: synchronous exec ────────────────────────────────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/exec", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, TerminalExecRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.terminalExec(req));
    return c.json(out);
  });

  // ── Terminal: interactive PTY control (output rides A1) ───────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, PtyOpenRequest);
    const ptyId = crypto.randomUUID();
    const out = await withChannelA({ db, settings, bus }, ctx, async ({ service, lease }) => {
      const opened = await service.ptyOpen(req, ptyId);
      // Persist the ptyId<->exec-session map fenced to the box's epoch.
      await insertPtySession(db, {
        id: ptyId,
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        execSessionId: opened.execSessionId,
        leaseEpoch: lease.leaseEpoch,
        cols: req.cols,
        rows: req.rows,
        shell: opened.shell,
        cwd: req.cwd,
        openedBy: ctx.subjectId,
      });
      // Emit terminal.pty.started + any initial banner output on A1.
      const started: TerminalPtyStartedPayload = { ptyId, cols: req.cols, rows: req.rows, shell: opened.shell, cwd: req.cwd };
      const events: AppendEventInput[] = [{ type: "terminal.pty.started", payload: started }];
      if (opened.initialOutput) {
        const delta: TerminalPtyOutputDeltaPayload = { ptyId, stream: "stdout", chunk: opened.initialOutput, seq: 0 };
        events.push({ type: "terminal.pty.output.delta", payload: delta });
      }
      await appendAndPublishEvents(db, bus, ctx.workspaceId, ctx.session.id, events);
      return opened.response;
    });
    return c.json(out, 201);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/write", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, PtyWriteRequest);
    const pty = await getOpenPtySession(db, ctx.workspaceId, req.ptyId);
    if (!pty) {
      throw new HTTPException(404, { message: "pty not found or closed" });
    }
    if (pty.execSessionId === null) {
      throw new HTTPException(409, { message: "interactive terminal unsupported on this backend" });
    }
    let seq = 1;
    await withChannelA({ db, settings, bus }, ctx, async ({ service }) => {
      const output = await service.ptyWrite(req, pty.execSessionId!, req.data);
      await updatePtySessionActivity(db, { accountId: ctx.accountId, workspaceId: ctx.workspaceId, ptyId: req.ptyId, execSessionId: pty.execSessionId });
      if (output) {
        const delta: TerminalPtyOutputDeltaPayload = { ptyId: req.ptyId, stream: "stdout", chunk: output, seq: seq++ };
        await appendAndPublishEvents(db, bus, ctx.workspaceId, ctx.session.id, [{ type: "terminal.pty.output.delta", payload: delta }]);
      }
    });
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/resize", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, PtyResizeRequest);
    const pty = await getOpenPtySession(db, ctx.workspaceId, req.ptyId);
    if (!pty) {
      throw new HTTPException(404, { message: "pty not found or closed" });
    }
    if (pty.execSessionId !== null) {
      await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.ptyResize(req, pty.execSessionId!));
    }
    await updatePtySessionActivity(db, { accountId: ctx.accountId, workspaceId: ctx.workspaceId, ptyId: req.ptyId, cols: req.cols, rows: req.rows });
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/close", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, PtyCloseRequest);
    const pty = await getOpenPtySession(db, ctx.workspaceId, req.ptyId);
    // Idempotent: closing an already-closed/absent PTY is a 204 no-op.
    if (pty) {
      await withChannelA({ db, settings, bus }, ctx, ({ service }) => service.ptyClose(req, pty.execSessionId));
      await closePtySession(db, { accountId: ctx.accountId, workspaceId: ctx.workspaceId, ptyId: req.ptyId });
      const exited: TerminalPtyExitedPayload = { ptyId: req.ptyId, exitCode: 0, reason: "exit" };
      await appendAndPublishEvents(db, bus, ctx.workspaceId, ctx.session.id, [{ type: "terminal.pty.exited", payload: exited }]);
    }
    return c.body(null, 204);
  });
}

function eventListLimit(raw: string | undefined): number {
  const limit = Number(raw ?? 500);
  if (!Number.isFinite(limit)) {
    return 500;
  }
  return Math.min(2000, Math.max(1, Math.floor(limit)));
}

function eventSequence(raw: string | undefined, fallback: number): number {
  const sequence = Number(raw ?? fallback);
  if (!Number.isFinite(sequence)) {
    return fallback;
  }
  return Math.floor(sequence);
}

function optionalEventSequence(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const sequence = Number(raw);
  if (!Number.isFinite(sequence)) {
    return undefined;
  }
  return Math.floor(sequence);
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
