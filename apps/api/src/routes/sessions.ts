import {
  AcknowledgeStreamRequest,
  AttachViewerRequest,
  ClearSessionContextRequest,
  ClientSessionEvent,
  CompactSessionContextRequest,
  DeleteSessionQueueItemRequest,
  EditSessionQueueItemRequest,
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
  MoveSessionQueueItemRequest,
  PtyCloseRequest,
  PtyOpenRequest,
  PtyResizeRequest,
  PtyWriteRequest,
  SessionControlRequest,
  SESSION_EVENT_RAW_DELTA_TYPES,
  SessionEventPayloadMode,
  SessionEventReadDirection,
  SessionEventReadMode,
  SessionEventSemanticClass,
  SessionEventType,
  SaveComposerDraftRequest,
  SteerSessionQueueItemRequest,
  SteerSessionMessageRequest,
  TerminalExecRequest,
  UpdateSessionPinRequest,
  UpdateSessionGoalRequest,
  UpdateSessionRequest,
  ViewerHeartbeatRequest,
  WORKSPACE_CONTROL_ACTOR_MAX_BYTES,
  workspaceControlUtf8Bytes,
  type SandboxBackend,
  type Session,
  type TerminalPtyExitedPayload,
  type TerminalPtyOutputDeltaPayload,
  type TerminalPtyStartedPayload,
} from "@opengeni/contracts";
import { streamTokenDegraded } from "@opengeni/config";
import {
  acceptSessionApprovalDecision,
  clearSessionGoal,
  clearSessionContext,
  closePtySession,
  getOpenPtySession,
  getSandbox,
  getSession,
  getSessionForSubject,
  getSessionGoal,
  getSessionQueueSnapshot,
  getStreamAcknowledgment,
  insertPtySession,
  listSessionEventPage,
  listSessionIdsInGroup,
  listSessionsForSubject,
  listSessionTurns,
  recordStreamAcknowledgment,
  requestSessionCompaction,
  setSessionCodexPin,
  withCodexCapacityMutation,
  setSessionPin,
  SessionPinVersionConflictError,
  SessionPinAccessError,
  SessionListAccessError,
  SessionListCursorError,
  SessionListCursorExpiredError,
  SessionListSnapshotLimitError,
  decodeSessionListCursor,
  revokeViewer,
  setSessionGoalStatus,
  updatePtySessionActivity,
  QueueCommandConflictError,
  SessionCommandIdempotencyError,
  SessionControlConflictError,
  SessionContextBusyError,
  latestWorkspaceCapture,
  workspaceCaptureAtRevision,
  type AppendEventInput,
} from "@opengeni/db";
import {
  appendAndPublishEvents,
  boundSessionEventHttpPage,
  coalesceSessionEventDeltas,
  publishDurableSessionEvents,
} from "@opengeni/events";
import { z } from "zod";
import { withChannelA } from "../sandbox/channel-a";
import { negotiateCapabilities } from "@opengeni/runtime/sandbox";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  attachViewer,
  detachViewer,
  heartbeatViewer,
  mintDesktopStream,
  mintTerminalStream,
  readGroupLease,
  resolveActiveDesktopTransport,
  viewerHeartbeatIntervalMs,
  type DesktopStreamMint,
  type TerminalStreamMint,
} from "../sandbox/viewer";
import {
  acceptSessionUserMessage,
  controlHumanSessionWorkstream,
  createSessionForRequest,
  deleteHumanQueuePrompt,
  editHumanQueuePrompt,
  getHumanComposerDraft,
  moveHumanQueuePrompt,
  readSessionLineage,
  saveHumanComposerDraft,
  steerHumanQueuePrompt,
  updateSessionTitle,
  workflowIdForSession,
} from "@opengeni/core";
import { assertSessionExists, boundedLimit } from "../http/common";
import { sseSessionStream } from "../http/sse";
import { serveWorkspaceCapture, serveWorkspaceCaptureFile } from "./workspace-capture";

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
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const pageView = c.req.query("view") === "page";
    const query = sessionListQuery(c.req.query(), pageView);
    let page: Awaited<ReturnType<typeof listSessionsForSubject>>;
    try {
      page = await listSessionsForSubject(db, workspaceId, {
        subjectId: grant.subjectId,
        limit: boundedLimit(query.limit),
        materializeSnapshot: pageView,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.search ? { search: query.search } : {}),
        ...(query.pinsOnly ? { pinsOnly: true } : {}),
        ...(query.parentSessionId !== undefined ? { parentSessionId: query.parentSessionId } : {}),
      });
    } catch (error) {
      if (error instanceof SessionListAccessError) {
        throw new HTTPException(403, { message: error.message });
      }
      if (error instanceof SessionListCursorExpiredError) {
        // The caller's short-lived snapshot is no longer usable. Keep this
        // distinct from auth, network, and validation failures so clients can
        // rebase a retained continuation exactly once instead of retrying the
        // expired cursor forever.
        throw new HTTPException(410, { message: error.message });
      }
      if (error instanceof SessionListCursorError) {
        throw new HTTPException(400, { message: error.message });
      }
      if (error instanceof SessionListSnapshotLimitError) {
        c.header("Retry-After", "5");
        throw new HTTPException(429, { message: error.message });
      }
      throw error;
    }
    // The page body carries this fact directly. Preserve the historical array
    // body for older clients while still making its older-pin omission visible
    // to raw HTTP consumers without changing that response shape.
    c.header("x-opengeni-pinned-truncated", page.pinnedTruncated === true ? "true" : "false");
    if (pageView) {
      return c.json(page);
    }
    // Same-major compatibility: listSessions() has historically returned an
    // array. Preserve that wire shape while adding personal pin metadata/order;
    // cursor consumers opt into the additive page view. A query flag rather
    // than a /sessions/page path is deliberate: an older API safely ignores it
    // and returns its historical array instead of treating "page" as a UUID.
    return c.json([...page.pinned, ...page.sessions]);
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const session = await getSessionForSubject(db, workspaceId, sessionId, grant.subjectId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return c.json(session);
  });

  // Personal pin only: this is organization state for the authenticated member,
  // not a mutation of the shared session. It deliberately requires read access
  // (not session control) and returns 404 for a foreign/inaccessible session.
  app.put("/v1/workspaces/:workspaceId/sessions/:sessionId/pin", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const parsed = UpdateSessionPinRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid session pin request" });
    }
    try {
      const session = await setSessionPin(db, {
        workspaceId,
        subjectId: grant.subjectId,
        sessionId,
        ...parsed.data,
      });
      if (!session) {
        throw new HTTPException(404, { message: "session not found" });
      }
      return c.json(session);
    } catch (error) {
      if (error instanceof SessionPinAccessError) {
        throw new HTTPException(403, { message: error.message });
      }
      if (error instanceof SessionPinVersionConflictError) {
        return c.json(
          {
            message: "session pin changed in another client",
            current: error.current,
          },
          409,
        );
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/lineage", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(await readSessionLineage(db, workspaceId, c.req.param("sessionId")));
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
      throw new HTTPException(400, {
        message: 'target is required ("auto" or an account id)',
      });
    }
    const pinned = target === "auto" ? null : target;
    const mutation = await withCodexCapacityMutation(
      db,
      { workspaceId, reason: "codex_manual_session_pin_changed" },
      async (tx) => {
        const changed = await setSessionCodexPin(tx, workspaceId, sessionId, pinned);
        return { result: changed, changed };
      },
    );
    const ok = mutation.result;
    if (!ok) {
      throw new HTTPException(404, {
        message: "session or codex account not found",
      });
    }
    await Promise.allSettled(
      mutation.wakeTargets.map((wake) =>
        workflowClient.signalCodexCapacity
          ? workflowClient.signalCodexCapacity({
              accountId: wake.accountId,
              workspaceId: wake.workspaceId,
              sessionId: wake.sessionId,
              workflowId: wake.workflowId,
              wakeRevision: wake.wakeRevision,
              workflowWakeRevision: wake.workflowWakeRevision,
            })
          : workflowClient.wakeSessionWorkflow({
              accountId: wake.accountId,
              workspaceId: wake.workspaceId,
              sessionId: wake.sessionId,
              workflowId: wake.workflowId,
              wakeRevision: wake.workflowWakeRevision,
            }),
      ),
    );
    return c.json({ pinned: target === "auto" ? "auto" : target });
  });

  // Manual rename. A user-set title is permanent: the db write is
  // unconditional (source='user'), so it always pins the session over later
  // agent writes. Returns the refreshed session, mirroring GET detail.
  app.patch("/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = UpdateSessionRequest.parse(await c.req.json());
    await updateSessionTitle({ db, bus }, workspaceId, sessionId, payload.title, "user");
    // A session-returning member route must preserve the caller's private pin
    // projection. Returning the generic mapSession() default here would reset a
    // pinned React consumer to false/version 0 after a harmless rename.
    const session = await getSessionForSubject(db, workspaceId, sessionId, grant.subjectId);
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
      throw new HTTPException(409, {
        message: "session goal is completed; set a new goal instead",
      });
    }
    if (payload.status === "paused") {
      const { goal, changed } = await setSessionGoalStatus(db, workspaceId, sessionId, {
        status: "paused",
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
        pausedReason: "api",
      });
      if (changed) {
        await appendAndPublishEvents(db, bus, workspaceId, sessionId, [
          {
            type: "goal.paused",
            payload: {
              goalId: goal.id,
              actor: "api",
              reason: "api",
              ...(payload.rationale ? { rationale: payload.rationale } : {}),
              autoContinuations: goal.autoContinuations,
              noProgressStreak: goal.noProgressStreak,
            },
          },
        ]);
      }
      return c.json(goal);
    }
    // Resume: only valid from paused; resets counters and re-arms the loop.
    if (existing.status !== "paused") {
      throw new HTTPException(409, {
        message: `session goal is ${existing.status}; only paused goals can be resumed`,
      });
    }
    const { goal, changed, workflowWakeRevision } = await setSessionGoalStatus(
      db,
      workspaceId,
      sessionId,
      {
        status: "active",
      },
    );
    // `changed` guards the racing-PATCH case: both requests can pass the
    // status pre-check, but only the transition winner emits and wakes.
    if (changed) {
      await appendAndPublishEvents(db, bus, workspaceId, sessionId, [
        {
          type: "goal.resumed",
          payload: {
            goalId: goal.id,
            text: goal.text,
            ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
            version: goal.version,
            actor: "api",
          },
        },
      ]);
      // signalWithStart restarts an eligible idle workflow so maybeContinueGoal
      // fires. A closed workspace/session gate keeps the resumed goal durable
      // and inert until that gate's own Resume mutation commits its wake.
      if (workflowWakeRevision !== null) {
        await workflowClient.wakeSessionWorkflow({
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          workflowId: workflowIdForSession(sessionId),
          wakeRevision: workflowWakeRevision,
        });
      }
    }
    return c.json(goal);
  });

  app.delete("/v1/workspaces/:workspaceId/sessions/:sessionId/goal", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const { event } = await clearSessionGoal(db, workspaceId, sessionId);
    if (event) {
      try {
        await bus.publish(workspaceId, sessionId, [event]);
      } catch (error) {
        console.warn(
          `[api] live publish failed for cleared goal ${workspaceId}/${sessionId}; event is durable and reconciles on replay`,
          error,
        );
      }
    }
    return c.body(null, 204);
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
      throw new HTTPException(400, {
        message: "context clear requires an explicit { confirm: true }",
      });
    }
    // The database checks this under workspace/session locks so a turn cannot
    // start between an API precheck and the history rewrite.
    const result = await clearSessionContext(db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId,
    }).catch((error: unknown) => {
      if (error instanceof SessionContextBusyError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    });
    await appendAndPublishEvents(db, bus, workspaceId, sessionId, [
      {
        type: "session.context.cleared",
        payload: {
          clearedBy: "api",
          supersededItems: result.supersededItems,
          markerPosition: result.markerPosition,
        },
      },
    ]);
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/context/compact", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    CompactSessionContextRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
    // /compact sets one durable request. The worker clears it only in the same
    // fenced transaction that installs replacement history, so failed or stale
    // attempts cannot lose the request.
    const requested = await requestSessionCompaction(db, workspaceId, sessionId);
    await workflowClient.wakeSessionWorkflow({
      accountId: grant.accountId,
      workspaceId,
      sessionId,
      workflowId: requested.temporalWorkflowId,
      wakeRevision: requested.wakeRevision,
    });
    return c.json({
      status: "pending",
      message: "Compaction will run at the next safe boundary.",
    });
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/events", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const rawAfter = c.req.query("after");
    const rawBefore = c.req.query("before");
    const after = eventSequence(rawAfter, 0);
    const before = optionalEventSequence(rawBefore);
    const compact = compactEvents(c.req.query("compact"));
    const explicitReplay = rawAfter !== undefined || rawBefore !== undefined || compact;
    const mode = eventEnumValue(
      c.req.query("mode"),
      SessionEventReadMode,
      "mode",
      explicitReplay ? "forensic" : "monitoring",
    );
    const latestClass = eventEnumValue(
      c.req.query("latest"),
      SessionEventSemanticClass,
      "latest",
      undefined,
    );
    if (
      latestClass &&
      ["includeTypes", "excludeTypes", "includeClasses", "excludeClasses"].some(
        (name) => c.req.query(name) !== undefined,
      )
    ) {
      throw new HTTPException(400, {
        message: "latest cannot be combined with event filters",
      });
    }
    const direction = latestClass
      ? "before"
      : eventEnumValue(
          c.req.query("direction"),
          SessionEventReadDirection,
          "direction",
          before !== undefined
            ? "before"
            : rawAfter !== undefined
              ? "after"
              : mode === "monitoring"
                ? "before"
                : "after",
        );
    const payloadMode = eventEnumValue(
      c.req.query("payloadMode"),
      SessionEventPayloadMode,
      "payloadMode",
      mode === "monitoring" ? "summary" : "full",
    );
    const includeTypes = eventEnumList(
      c.req.query("includeTypes"),
      SessionEventType,
      "includeTypes",
    );
    const excludeTypes = eventEnumList(
      c.req.query("excludeTypes"),
      SessionEventType,
      "excludeTypes",
    );
    const includeClasses = eventEnumList(
      c.req.query("includeClasses"),
      SessionEventSemanticClass,
      "includeClasses",
    );
    const excludeClasses = eventEnumList(
      c.req.query("excludeClasses"),
      SessionEventSemanticClass,
      "excludeClasses",
    );
    const limit = latestClass
      ? 1
      : eventListLimit(
          c.req.query("limit"),
          compact ? 5000 : mode === "monitoring" ? 250 : 2000,
          mode === "monitoring" ? 40 : 500,
        );
    const dbPage = await listSessionEventPage(db, workspaceId, sessionId, {
      after,
      ...(before !== undefined ? { before } : {}),
      limit,
      direction,
      payloadMode,
      includeTypes,
      excludeTypes,
      includeClasses: latestClass ? [latestClass] : includeClasses,
      excludeClasses,
      ...(mode === "monitoring" ? { defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES } : {}),
    });
    const events = dbPage.events;
    const projected = compact ? coalesceSessionEventDeltas(events) : events;
    const page = boundSessionEventHttpPage(projected, {
      direction,
    });
    const hasMore = dbPage.hasMore || page.truncated;
    c.header("X-OpenGeni-Page-Bytes", String(page.bytes));
    c.header("X-OpenGeni-Page-Max-Bytes", String(1024 * 1024));
    c.header("X-OpenGeni-Page-Truncated", String(hasMore));
    c.header("X-OpenGeni-Has-More", String(hasMore));
    c.header("X-OpenGeni-Event-Mode", mode);
    c.header("X-OpenGeni-Event-Direction", direction);
    c.header("X-OpenGeni-Payload-Mode", payloadMode);
    c.header("X-OpenGeni-Forensic-Exact", String(mode === "forensic" && payloadMode === "full"));
    const coveredFirst = page.events[0]?.sequence;
    const coveredLast = page.events.at(-1)?.sequence;
    if (coveredFirst !== undefined) c.header("X-OpenGeni-Covered-First", String(coveredFirst));
    if (coveredLast !== undefined) c.header("X-OpenGeni-Covered-Last", String(coveredLast));
    const truncatedBy = page.truncated ? "http_bytes" : dbPage.truncatedBy;
    if (truncatedBy) c.header("X-OpenGeni-Truncated-By", truncatedBy);
    if (page.nextSequence !== null) {
      c.header(
        direction === "before" ? "X-OpenGeni-Next-Before" : "X-OpenGeni-Next-After",
        String(page.nextSequence),
      );
    }
    return c.json(page.events);
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/events/stream", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const after = Number(c.req.query("after") ?? c.req.header("Last-Event-ID") ?? 0);
    return sseSessionStream(
      db,
      bus,
      workspaceId,
      sessionId,
      Number.isFinite(after) ? after : 0,
      c.req.raw.signal,
      { observability: deps.observability },
    );
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/turns", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    return c.json(
      await listSessionTurns(db, workspaceId, sessionId, boundedLimit(c.req.query("limit"))),
    );
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/queue", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    const snapshot = await getSessionQueueSnapshot(db, workspaceId, sessionId);
    if (!snapshot) throw new HTTPException(404, { message: "session not found" });
    return c.json(snapshot);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/queue/:turnId/move", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = MoveSessionQueueItemRequest.parse(await c.req.json());
    try {
      return c.json(
        await moveHumanQueuePrompt(
          { db, bus },
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            subjectId: grant.subjectId,
          },
          c.req.param("turnId"),
          payload,
        ),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/queue/:turnId/edit", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = EditSessionQueueItemRequest.parse(await c.req.json());
    try {
      return c.json(
        await editHumanQueuePrompt(
          { db, bus },
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            subjectId: grant.subjectId,
          },
          c.req.param("turnId"),
          payload,
        ),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/queue/:turnId/steer", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = SteerSessionQueueItemRequest.parse(await c.req.json());
    try {
      return c.json(
        await steerHumanQueuePrompt(
          { db, bus },
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            subjectId: grant.subjectId,
          },
          c.req.param("turnId"),
          payload,
        ),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/queue/:turnId/delete", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = DeleteSessionQueueItemRequest.parse(await c.req.json());
    try {
      return c.json(
        await deleteHumanQueuePrompt(
          { db, bus },
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            subjectId: grant.subjectId,
          },
          c.req.param("turnId"),
          payload,
        ),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/composer-draft", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    return c.json(
      await getHumanComposerDraft(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId,
        subjectId: grant.subjectId,
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/sessions/:sessionId/composer-draft", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const payload = SaveComposerDraftRequest.parse(await c.req.json());
    try {
      return c.json(
        await saveHumanComposerDraft(
          db,
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            subjectId: grant.subjectId,
          },
          payload,
        ),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/control", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    if (workspaceControlUtf8Bytes(grant.subjectId) > WORKSPACE_CONTROL_ACTOR_MAX_BYTES) {
      throw new HTTPException(400, { message: "workspace-control actor is too large" });
    }
    const sessionId = c.req.param("sessionId");
    const parsed = SessionControlRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid session control request" });
    }
    try {
      return c.json(
        await controlHumanSessionWorkstream(
          { db, bus, workflowClient },
          {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            subjectId: grant.subjectId,
          },
          parsed.data,
        ),
      );
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/steer", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const raw = await c.req.json();
    const payload = SteerSessionMessageRequest.parse(raw);
    const result = await acceptSessionUserMessage(deps, grant, workspaceId, sessionId, {
      text: payload.text,
      resources: payload.resources,
      tools: payload.tools,
      toolsProvided: userMessagePayloadHasOwnProperty({ payload: raw }, "tools"),
      model: payload.model ?? null,
      reasoningEffort: payload.reasoningEffort ?? null,
      mcpCredentialUpdates: payload.mcpCredentialUpdates ?? [],
      delivery: "steer",
      origin: "human",
      ...(payload.controlEtag !== undefined ? { controlEtag: payload.controlEtag } : {}),
      ...(payload.expectedDraftRevision !== undefined
        ? { expectedDraftRevision: payload.expectedDraftRevision }
        : {}),
      ...(payload.clientEventId ? { clientEventId: payload.clientEventId } : {}),
    });
    return c.json(result, 202);
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
        ...(event.payload.controlEtag !== undefined
          ? { controlEtag: event.payload.controlEtag }
          : {}),
        ...(event.payload.expectedDraftRevision !== undefined
          ? { expectedDraftRevision: event.payload.expectedDraftRevision }
          : {}),
        ...(event.clientEventId ? { clientEventId: event.clientEventId } : {}),
      });
      return c.json(accepted, 202);
    }

    if (event.type === "user.approvalDecision") {
      const accepted = await acceptSessionApprovalDecision(db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId,
        payload: event.payload,
        clientEventId: event.clientEventId ?? null,
      });
      if (accepted.action === "conflict") {
        throw new HTTPException(409, {
          message: `session is ${accepted.sessionStatus}; no unhandled approval is pending`,
        });
      }
      await publishDurableSessionEvents(bus, workspaceId, sessionId, accepted.events);
      const workflowId = workflowIdForSession(sessionId);
      await workflowClient.signalApprovalDecision({
        accountId: grant.accountId,
        workspaceId,
        sessionId,
        eventId: accepted.event.id,
        workflowId,
        workflowWakeRevision: accepted.workflowWakeRevision,
      });
      return c.json(accepted.event, 202);
    }
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
      throw new HTTPException(404, {
        message: "sandbox ownership is not enabled for this deployment",
      });
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
    const lease = await readGroupLease(
      { db, settings },
      { workspaceId, sandboxGroupId: session.sandboxGroupId },
    );
    const { shared, sharedSessionIds } = await resolveSharedExposure(workspaceId, session);
    // Per-principal acknowledgment: A acknowledging does not consent for B. The
    // un-redacted desktop stream ALWAYS requires the un-redacted ack; a shared box
    // ADDITIONALLY requires the shared-exposure ack. Both must match the POST
    // /viewers gate EXACTLY — otherwise a principal who recorded shared consent
    // WITHOUT un-redacted consent could be handed a live VNC URL + scoped token
    // from this read path while being correctly 409'd on attach (a consent-gate
    // bypass of the un-redacted pixel plane).
    const ack = await getStreamAcknowledgment(db, {
      workspaceId,
      sandboxGroupId: session.sandboxGroupId,
      subjectId: grant.subjectId,
    });
    const acknowledged = ack
      ? ack.acknowledgedUnredacted && (!shared || ack.acknowledgedShared)
      : false;

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
      settings.sandboxDesktopEnabled &&
      !streamTokenDegraded(settings) &&
      acknowledged &&
      (session.activeSandboxId != null ||
        lease?.liveness === "warm" ||
        lease?.liveness === "draining");
    if (desktopUnlocked) {
      desktopStream = await mintDesktopStream(
        { db, settings, bus },
        {
          accountId: grant.accountId,
          workspaceId,
          session,
          // The handshake's token is scoped to the calling principal (it is a read,
          // not a viewer-holder acquire); the per-holder token is re-minted on
          // POST /viewers. A previousEpoch != current would have rotated already
          // via the warming-commit; the read does not itself drive rotation.
          viewerId: grant.subjectId,
          ...(lease ? { lease } : {}),
        },
      );
    }

    // P5.t — the REAL PTY terminal cell, served API-DIRECT. Independent of the
    // desktop: it gates ONLY on sandboxTerminalEnabled + a real-PTY backend + a
    // WARM box (NO un-redacted ack — the terminal cell has no acknowledgment
    // gate). A degraded mint (terminal off / no secret / ttyd or tunnel failure)
    // returns null → the Terminal cell falls back to the sse-events firehose.
    let terminalStream: TerminalStreamMint | null = null;
    const terminalUnlocked =
      settings.sandboxTerminalEnabled &&
      !streamTokenDegraded(settings) &&
      (session.activeSandboxId != null ||
        lease?.liveness === "warm" ||
        lease?.liveness === "draining");
    if (terminalUnlocked) {
      terminalStream = await mintTerminalStream(
        { db, settings, bus },
        {
          accountId: grant.accountId,
          workspaceId,
          session,
          viewerId: grant.subjectId,
          ...(lease ? { lease } : {}),
        },
      );
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
      // Graceful degrade (stream-token availability contract): if desktop is enabled but no stream-token
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
      const activeSandbox = session.activeSandboxId
        ? await getSandbox(db, workspaceId, session.activeSandboxId)
        : null;
      const wire = resolveActiveDesktopTransport(
        activeSandbox?.kind === "selfhosted",
        settings.sandboxDesktopInteractive !== false,
      );
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
  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/stream-capabilities/acknowledge",
    async (c) => {
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
        throw new HTTPException(400, {
          message: "invalid stream acknowledgment request",
        });
      }
      const recorded = await recordStreamAcknowledgment(db, {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
        subjectId: grant.subjectId,
        acknowledgeUnredacted: parsed.data.acknowledgeUnredacted,
        acknowledgeShared: parsed.data.acknowledgeShared,
      });
      return c.json({
        acknowledged: recorded.acknowledgedUnredacted,
        acknowledgedShared: recorded.acknowledgedShared,
      });
    },
  );

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
      throw new HTTPException(400, {
        message: "invalid viewer attach request",
      });
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
      const ack = await getStreamAcknowledgment(db, {
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
        subjectId: grant.subjectId,
      });
      if (!ack?.acknowledgedUnredacted) {
        throw new HTTPException(409, {
          message: "stream_acknowledgment_required",
        });
      }
      if (shared && !ack.acknowledgedShared) {
        throw new HTTPException(409, {
          message: "shared_acknowledgment_required",
        });
      }
    }
    // SELFHOSTED ACTIVE: when the session's active sandbox is selfhosted, skip
    // attachViewer (it warms the Modal group box — the wrong target). Synthesize a
    // result shaped like ViewerAttachResult and mint relay cells directly.
    const activeSandbox = session.activeSandboxId
      ? await getSandbox(db, workspaceId, session.activeSandboxId)
      : null;
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
        (settings.sandboxDesktopEnabled || settings.sandboxTerminalEnabled) &&
        !streamTokenDegraded(settings)
      ) {
        if (wantDesktop && settings.sandboxDesktopEnabled) {
          stream = await mintDesktopStream(
            { db, settings, bus },
            {
              accountId: grant.accountId,
              workspaceId,
              session,
              viewerId,
              // No Modal lease for selfhosted-active; the mint routes to the relay.
            },
          );
        }
        if (settings.sandboxTerminalEnabled) {
          terminal = await mintTerminalStream(
            { db, settings, bus },
            {
              accountId: grant.accountId,
              workspaceId,
              session,
              viewerId,
              // No Modal lease for selfhosted-active; the mint routes to the relay.
            },
          );
        }
      }
    } else {
      result = await attachViewer(
        { db, settings },
        {
          accountId: grant.accountId,
          workspaceId,
          session,
          ...(parsed.data.viewerId ? { viewerId: parsed.data.viewerId } : {}),
        },
      );

      // P4.2 — the viewer now holds a WARM box; mint the real pixel cell IN-PROCESS
      // (resume by id → ensureDisplayStack → exposeStreamPort) scoped to THIS
      // viewer holder, record data_plane_url, and fold the live address into the
      // response. A degraded mint (no secret / headless / display-stack or tunnel
      // failure) leaves dataPlaneUrl null — the client falls back to Channel-A. The
      // box is warm here (attachViewer spun it up or attached), so the handshake's
      // never-spin-up rule does not apply.
      if (
        (settings.sandboxDesktopEnabled || settings.sandboxTerminalEnabled) &&
        !streamTokenDegraded(settings)
      ) {
        const lease = await readGroupLease(
          { db, settings },
          { workspaceId, sandboxGroupId: session.sandboxGroupId },
        );
        if (lease) {
          // The pixel cell is minted only when the caller asked for the desktop plane
          // (and consented above). A terminal-only attach skips it — the box is warm,
          // the terminal mint below still runs.
          if (wantDesktop && settings.sandboxDesktopEnabled) {
            stream = await mintDesktopStream(
              { db, settings, bus },
              {
                accountId: grant.accountId,
                workspaceId,
                session,
                viewerId: result.viewerId,
                lease,
              },
            );
          }
          // P5.t — the same warm-box viewer attach also mints the REAL PTY terminal
          // address (independent of the desktop toggle). A degraded mint leaves the
          // terminal fields null → the client falls back to the sse-events firehose.
          if (settings.sandboxTerminalEnabled) {
            terminal = await mintTerminalStream(
              { db, settings, bus },
              {
                accountId: grant.accountId,
                workspaceId,
                session,
                viewerId: result.viewerId,
                lease,
              },
            );
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
        transport: stream
          ? selfhostedActive
            ? ("relay-frames" as const)
            : ("vnc-ws" as const)
          : null,
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
  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId/heartbeat",
    async (c) => {
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
        throw new HTTPException(400, {
          message: "viewer heartbeat requires { leaseEpoch }",
        });
      }
      const alive = await heartbeatViewer(
        { db, settings },
        {
          accountId: grant.accountId,
          workspaceId,
          sandboxGroupId: session.sandboxGroupId,
          viewerId: c.req.param("viewerId"),
          expectedEpoch: parsed.data.leaseEpoch,
        },
      );
      return c.json({ alive });
    },
  );

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
    await detachViewer(
      { db, settings },
      {
        accountId: grant.accountId,
        workspaceId,
        sandboxGroupId: session.sandboxGroupId,
        viewerId: c.req.param("viewerId"),
      },
    );
    return c.body(null, 204);
  });

  // POST .../viewers/:viewerId/revoke — OD-6 v1 revocation. Drops the named
  // viewer's holder from the GROUP lease so refcount recomputes; the box drains
  // iff nothing else holds it (a turn-held or other-viewer-held box survives —
  // group-refcount liveness). Gated on stream:view (no new permission). The
  // live-RFB force-disconnect of an already-open socket is a P4 follow-up; the
  // holder-drop (so the box can drain) is the v1 deliverable.
  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId/revoke",
    async (c) => {
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
      return c.json({
        liveness: result?.liveness ?? null,
        refcount: result?.refcount ?? null,
      });
    },
  );

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
    return {
      accountId: grant.accountId,
      workspaceId,
      session,
      subjectId: grant.subjectId,
    };
  }

  async function parseChannelABody<T>(
    c: Context,
    schema: {
      safeParse: (v: unknown) => { success: true; data: T } | { success: false };
    },
  ): Promise<T> {
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
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.fsList(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, FsReadRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.fsRead(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/write", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsWriteRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.fsWrite(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/delete", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsDeleteRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.fsDelete(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/move", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsMoveRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.fsMove(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/mkdir", async (c) => {
    const ctx = await channelAPreamble(c, "files:write");
    const req = await parseChannelABody(c, FsMkdirRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.fsMkdir(req),
    );
    return c.json(out);
  });

  // ── Git (read-only) ─────────────────────────────────────────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/status", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitStatusRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.gitStatus(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitDiffRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.gitDiff(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/log", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitLogRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.gitLog(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/show", async (c) => {
    const ctx = await channelAPreamble(c, "files:read");
    const req = await parseChannelABody(c, GitShowRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.gitShow(req),
    );
    return c.json(out);
  });

  // ── Workspace capture (read-only; served from DB + object storage, NO box) ──
  // Grant-first (files:read) then a pure DB/storage read — deliberately NOT the
  // channelAPreamble path: a capture is the durable turn-end snapshot, served
  // without warming a machine (the <200ms cold paint). No ownership-flag gate:
  // absent captures return {available:false} (200) so the client falls back to
  // the live/wake path — the feature degrades to today's behavior, never worse.
  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/workspace/capture", async (c) => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    const sessionId = c.req.param("sessionId") ?? "";
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    if (!objectStorage) {
      // No storage configured → no captures can exist. Cold-fallback, not an error.
      return c.json({ available: false });
    }
    const row = await latestWorkspaceCapture(db, workspaceId, sessionId);
    return c.json(await serveWorkspaceCapture(row, objectStorage));
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/workspace/capture/file", async (c) => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    const sessionId = c.req.param("sessionId") ?? "";
    const path = c.req.query("path");
    if (!path) {
      throw new HTTPException(400, {
        message: "path query parameter is required",
      });
    }
    const session = await getSession(db, workspaceId, sessionId);
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    if (!objectStorage) {
      throw new HTTPException(404, { message: "capture not found" });
    }
    // Explicit ?revision pins a specific capture; omitted → latest.
    const revisionParam = c.req.query("revision");
    let row;
    if (revisionParam !== undefined && revisionParam !== "") {
      const revision = Number(revisionParam);
      if (!Number.isInteger(revision) || revision < 0) {
        throw new HTTPException(400, {
          message: "revision must be a non-negative integer",
        });
      }
      row = await workspaceCaptureAtRevision(db, workspaceId, sessionId, revision);
    } else {
      row = await latestWorkspaceCapture(db, workspaceId, sessionId);
    }
    return c.json(await serveWorkspaceCaptureFile(row, path, objectStorage));
  });

  // ── Terminal: synchronous exec ────────────────────────────────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/exec", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, TerminalExecRequest);
    const out = await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
      service.terminalExec(req),
    );
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
      const started: TerminalPtyStartedPayload = {
        ptyId,
        cols: req.cols,
        rows: req.rows,
        shell: opened.shell,
        cwd: req.cwd,
      };
      const events: AppendEventInput[] = [{ type: "terminal.pty.started", payload: started }];
      if (opened.initialOutput) {
        const delta: TerminalPtyOutputDeltaPayload = {
          ptyId,
          stream: "stdout",
          chunk: opened.initialOutput,
          seq: 0,
        };
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
      throw new HTTPException(409, {
        message: "interactive terminal unsupported on this backend",
      });
    }
    let seq = 1;
    await withChannelA({ db, settings, bus }, ctx, async ({ service }) => {
      const output = await service.ptyWrite(req, pty.execSessionId!, req.data);
      await updatePtySessionActivity(db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        ptyId: req.ptyId,
        execSessionId: pty.execSessionId,
      });
      if (output) {
        const delta: TerminalPtyOutputDeltaPayload = {
          ptyId: req.ptyId,
          stream: "stdout",
          chunk: output,
          seq: seq++,
        };
        await appendAndPublishEvents(db, bus, ctx.workspaceId, ctx.session.id, [
          { type: "terminal.pty.output.delta", payload: delta },
        ]);
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
      await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
        service.ptyResize(req, pty.execSessionId!),
      );
    }
    await updatePtySessionActivity(db, {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      ptyId: req.ptyId,
      cols: req.cols,
      rows: req.rows,
    });
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/close", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach");
    const req = await parseChannelABody(c, PtyCloseRequest);
    const pty = await getOpenPtySession(db, ctx.workspaceId, req.ptyId);
    // Idempotent: closing an already-closed/absent PTY is a 204 no-op.
    if (pty) {
      await withChannelA({ db, settings, bus }, ctx, ({ service }) =>
        service.ptyClose(req, pty.execSessionId),
      );
      await closePtySession(db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        ptyId: req.ptyId,
      });
      const exited: TerminalPtyExitedPayload = {
        ptyId: req.ptyId,
        exitCode: 0,
        reason: "exit",
      };
      await appendAndPublishEvents(db, bus, ctx.workspaceId, ctx.session.id, [
        { type: "terminal.pty.exited", payload: exited },
      ]);
    }
    return c.body(null, 204);
  });
}

function eventListLimit(raw: string | undefined, max = 2000, fallback = 500): number {
  const limit = Number(raw ?? fallback);
  if (!Number.isFinite(limit)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

function eventEnumValue<T extends string>(
  raw: string | undefined,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  name: string,
  fallback: T,
): T;
function eventEnumValue<T extends string>(
  raw: string | undefined,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  name: string,
  fallback: undefined,
): T | undefined;
function eventEnumValue<T extends string>(
  raw: string | undefined,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  name: string,
  fallback: T | undefined,
): T | undefined {
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, { message: `${name} is invalid` });
  }
  return parsed.data as T;
}

function eventEnumList<T extends string>(
  raw: string | undefined,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  name: string,
): T[] {
  if (raw === undefined || raw.trim() === "") return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > 100) {
    throw new HTTPException(400, { message: `${name} accepts at most 100 values` });
  }
  return values.map((value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, { message: `${name} contains an invalid value` });
    }
    return parsed.data as T;
  });
}

function sessionListQuery(
  query: Record<string, string>,
  allowCursor = true,
): {
  limit: string | undefined;
  parentSessionId: string | null | undefined;
  cursor: ReturnType<typeof decodeSessionListCursor> | undefined;
  search: string | undefined;
  pinsOnly: boolean;
} {
  const parentSessionId = query.parentSessionId;
  // "null" = roots only; a uuid = children of that session; anything else is
  // a client error (an unvalidated value would surface as a Postgres uuid cast
  // failure -> 500 rather than an honest 400).
  if (
    parentSessionId !== undefined &&
    parentSessionId !== "null" &&
    !z.string().uuid().safeParse(parentSessionId).success
  ) {
    throw new HTTPException(400, {
      message: 'parentSessionId must be a session id or the literal "null"',
    });
  }
  const rawCursor = allowCursor ? query.cursor : undefined;
  const cursor = rawCursor ? decodeSessionListCursor(rawCursor) : undefined;
  if (rawCursor && !cursor) {
    throw new HTTPException(400, { message: "cursor is invalid" });
  }
  const search = query.search?.trim();
  if (search && search.length > 200) {
    throw new HTTPException(400, {
      message: "search must be at most 200 characters",
    });
  }
  if (query.pinsOnly !== undefined && query.pinsOnly !== "true") {
    throw new HTTPException(400, { message: 'pinsOnly must be the literal "true"' });
  }
  const pinsOnly = query.pinsOnly === "true";
  if (pinsOnly && !allowCursor) {
    throw new HTTPException(400, { message: 'pinsOnly requires view="page"' });
  }
  if (pinsOnly && (rawCursor || parentSessionId !== undefined || search)) {
    throw new HTTPException(400, {
      message: "pinsOnly cannot be combined with cursor, parentSessionId, or search",
    });
  }
  return {
    limit: query.limit,
    parentSessionId:
      parentSessionId === undefined
        ? undefined
        : parentSessionId === "null"
          ? null
          : parentSessionId,
    cursor,
    search: search || undefined,
    pinsOnly,
  };
}

function compactEvents(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
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
  return Boolean(
    value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key),
  );
}

function userMessagePayloadHasOwnProperty(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = (value as { payload?: unknown }).payload;
  return hasOwnProperty(payload, key);
}

function commandConflictResponse(c: Context, error: unknown): Response {
  if (error instanceof QueueCommandConflictError) {
    return c.json({ code: error.code, message: error.message, current: error.current }, 409);
  }
  if (error instanceof SessionControlConflictError) {
    return c.json({ code: error.code, message: error.message }, 409);
  }
  if (error instanceof SessionCommandIdempotencyError) {
    return c.json({ code: error.code, message: error.message }, 409);
  }
  throw error;
}
