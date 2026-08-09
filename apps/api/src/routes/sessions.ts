import {
  AcknowledgeStreamRequest,
  ActivateCodexRealtimeConnectionRequest,
  AttachViewerRequest,
  BeginSessionRealtimeRequest,
  ClearSessionContextRequest,
  CodexRealtimeWebrtcRequest,
  GatewayRealtimeConnectRequest,
  ClientSessionEvent,
  CompactSessionContextRequest,
  DeleteSessionQueueItemRequest,
  EditSessionQueueItemRequest,
  EndSessionRealtimeRequest,
  FsDeleteRequest,
  FsListBatchRequest,
  FsListRequest,
  FsMkdirRequest,
  FsMoveRequest,
  FsReadRequest,
  FsWriteRequest,
  HumanInputRequestStatus,
  GitDiffRequest,
  GitReadBatchRequest,
  GitLogRequest,
  GitShowRequest,
  GitStatusRequest,
  MoveSessionQueueItemRequest,
  PtyCloseRequest,
  PtyOpenRequest,
  PtyResizeRequest,
  PtyWriteRequest,
  RenewSessionRealtimeRequest,
  SyncSessionRealtimeLedgerRequest,
  SessionControlRequest,
  SESSION_EVENT_RAW_DELTA_TYPES,
  SessionEventPayloadMode,
  SessionEventReadDirection,
  SessionEventReadMode,
  SessionEventLatestClass,
  SessionEventResultMode,
  SessionEventSemanticClass,
  SessionEventType,
  SessionMcpServerId,
  compactSessionEventResult,
  sessionEventLatestClassToSemanticClass,
  SaveComposerDraftRequest,
  SteerSessionQueueItemRequest,
  SteerSessionMessageRequest,
  TerminalExecRequest,
  UpdateSessionPinRequest,
  UpdateSessionGoalRequest,
  UpdateSessionMcpApprovalPolicyRequest,
  UpdateSessionRequest,
  UpdateSessionToolPolicyRequest,
  ViewerHeartbeatRequest,
  WORKSPACE_CONTROL_ACTOR_MAX_BYTES,
  workspaceControlUtf8Bytes,
  type SandboxBackend,
  type LineageNode,
  type Session,
  type ErrorCode,
  type SessionAuthorizationOperation,
  type SessionQueueSnapshot,
  type TerminalPtyExitedPayload,
  type TerminalPtyOutputDeltaPayload,
  type TerminalPtyStartedPayload,
} from "@opengeni/contracts";
import { streamTokenDegraded } from "@opengeni/config";
import {
  acceptSessionApprovalDecision,
  acceptSessionHumanInputResponse,
  clearSessionGoal,
  clearSessionContext,
  getOpenPtySession,
  getRetainedProcess,
  getSandbox,
  getSession,
  getSessionEvent,
  getSessionForSubject,
  getSessionGoal,
  getSessionHumanInputRequest,
  getSessionGoalWithContinuation,
  getSessionQueueSnapshot,
  getStreamAcknowledgment,
  insertPtySession,
  listSessionEventPage,
  listSessionHumanInputRequests,
  listSessionIdsInGroup,
  listSessionsForSubject,
  getLatestStartedSessionTurn,
  listSessionTurns,
  projectEffectiveControlForRelatedAccess,
  projectSessionForRelatedAccess,
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
  setSessionGoalStatusWithEvent,
  updatePtySessionActivity,
  QueueCommandConflictError,
  beginSessionRealtimeInTransaction,
  activateSessionRealtimeConnectionInTransaction,
  claimSessionRealtimeConnectionInTransaction,
  completeSessionRealtimeConnectionInTransaction,
  endSessionRealtimeInTransaction,
  failSessionRealtimeConnectionInTransaction,
  NewSessionDraftConflictError,
  SessionCommandIdempotencyError,
  SessionControlConflictError,
  SessionRealtimeConflictError,
  SessionToolPolicyVersionConflictError,
  SessionContextBusyError,
  HumanInputResponseValidationError,
  latestWorkspaceCapture,
  sessionLatestWorkspaceCapture,
  renewSessionRealtimeInTransaction,
  syncSessionRealtimeLedgerInTransaction,
  withWorkspaceRls,
  workspaceCaptureAtRevision,
  type AppendEventInput,
  type SandboxOpenPtySessionRow,
  type SandboxPtyProcessIdentity,
  type SandboxRetainedProcess,
  type Database,
} from "@opengeni/db";
import {
  appendAndPublishEvents,
  boundSessionEventHttpPage,
  coalesceSessionEventDeltas,
  publishDurableSessionEvents,
} from "@opengeni/events";
import {
  createGatewayRealtimeConnectionSecret,
  GatewayRealtimeBrokerError,
} from "../gateway-realtime";
import { z, ZodError } from "zod";
import {
  runConcurrentChannelAReads,
  withChannelA,
  withChannelARead,
  type ChannelAContext,
  type ChannelAHandle,
  type ChannelAOperation,
} from "../sandbox/channel-a";
import { negotiateCapabilities } from "@opengeni/runtime/sandbox";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  requireAccessGrant,
  requirePermission,
  requireSessionAuthorization,
  requireSessionAuthorizationListScope,
  SESSION_AUTHORIZATION_DEFAULT_REAUTHORIZE_MS,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ResolvedSessionAuthorization,
} from "@opengeni/core";
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
  type ViewerServices,
} from "../sandbox/viewer";
import { buildSessionCodexRealtimeBroker, CodexRealtimeBrokerError } from "../codex-realtime";
import {
  acceptSessionUserMessage,
  controlHumanSessionWorkstream,
  createSessionForRequest,
  deleteHumanQueuePrompt,
  editHumanQueuePrompt,
  getActorNewSessionDraft,
  getHumanComposerDraft,
  moveHumanQueuePrompt,
  readSessionLineage,
  saveHumanComposerDraft,
  saveActorNewSessionDraft,
  SessionSpawnDeniedError,
  sessionSpawnDenialEnvelope,
  steerHumanQueuePrompt,
  updateSessionMcpApprovalPolicy,
  updateSessionToolPolicy,
  updateSessionTitle,
  workflowIdForSession,
  sessionWithEffectiveToolPolicy,
  workspaceSessionToolPolicyDefaultServerIds,
  workspaceSessionToolPolicyServerIds,
} from "@opengeni/core";
import { assertSessionExists, boundedLimit } from "../http/common";
import { sseSessionStream } from "../http/sse";
import {
  serveWorkspaceCapture,
  serveWorkspaceCaptureFile,
  WorkspaceCaptureManifestCache,
} from "./workspace-capture";

type SessionRouteDeps = ApiRouteDeps & Pick<ViewerServices, "establishSandboxSession">;

export function registerSessionRoutes(app: Hono, deps: SessionRouteDeps): void {
  const { settings, db, bus, workflowClient, objectStorage } = deps;
  const channelAServices = { db, settings, bus, observability: deps.observability };
  const workspaceCaptureManifestCache = new WorkspaceCaptureManifestCache();
  const ptyIdentity = (pty: SandboxOpenPtySessionRow): SandboxPtyProcessIdentity => ({
    leaseId: pty.leaseId,
    sandboxGroupId: pty.sandboxGroupId,
    retainedProcessId: pty.retainedProcessId,
    openAdmissionId: pty.openAdmissionId,
    execSessionId: pty.execSessionId,
    leaseEpoch: pty.leaseEpoch,
    providerBackend: pty.providerBackend,
    providerInstanceId: pty.providerInstanceId,
    routeKind: pty.routeKind,
    routeTargetId: pty.routeTargetId,
    routeEpoch: pty.routeEpoch,
  });
  const adoptPtyProcess = async (
    ctx: ChannelAContext,
    handle: ChannelAHandle,
    pty: SandboxOpenPtySessionRow,
  ): Promise<SandboxRetainedProcess> => {
    if (!handle.lease) {
      throw new HTTPException(409, {
        message: "durable interactive terminals require a session-home provider lease",
      });
    }
    const process = await getRetainedProcess(db, {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      processId: pty.retainedProcessId,
    });
    if (
      !process ||
      process.state !== "active" ||
      process.ownerActorKind !== "direct" ||
      process.accountId !== ctx.accountId ||
      process.leaseId !== pty.leaseId ||
      process.sandboxGroupId !== pty.sandboxGroupId ||
      process.parentAdmissionId !== pty.openAdmissionId ||
      process.leaseEpoch !== pty.leaseEpoch ||
      process.providerBackend !== pty.providerBackend ||
      process.providerInstanceId !== pty.providerInstanceId ||
      process.routeKind !== pty.routeKind ||
      process.routeTargetId !== pty.routeTargetId ||
      process.routeEpoch !== pty.routeEpoch ||
      process.providerSessionId !== pty.execSessionId ||
      // Only a persistable home backend can currently be reconstructed by an
      // API request without consulting the mutable active pointer.
      process.routeTargetId !== null ||
      handle.lease.id !== process.leaseId ||
      handle.lease.sandboxGroupId !== process.sandboxGroupId ||
      handle.lease.leaseEpoch !== process.leaseEpoch ||
      handle.lease.backend !== process.providerBackend ||
      handle.lease.instanceId !== process.providerInstanceId
    ) {
      throw new HTTPException(409, {
        message: "pty retained-process identity is stale; reopen the terminal",
      });
    }
    handle.routingSession.adoptRetainedProcess({
      process: { id: process.id, providerSessionId: process.providerSessionId },
      backend: {
        sandboxId: null,
        leaseEpoch: process.leaseEpoch,
        providerInstanceId: process.providerInstanceId,
        activeEpoch: process.routeEpoch,
      },
    });
    return process;
  };
  const emitPtyExited = async (
    ctx: ChannelAContext,
    ptyId: string,
    process: SandboxRetainedProcess,
  ): Promise<void> => {
    const exited: TerminalPtyExitedPayload = {
      ptyId,
      exitCode: process.exitCode,
      reason: process.state === "exited" ? "exit" : "lost",
    };
    await appendAndPublishEvents(db, bus, ctx.workspaceId, ctx.session.id, [
      { type: "terminal.pty.exited", payload: exited },
    ]);
  };
  const drainOpenedPty = async (handle: ChannelAHandle, execSessionId: number): Promise<void> => {
    let chars = "\u0004";
    while (handle.routingSession.hasRetainedProcess(execSessionId)) {
      await handle.routingSession.writeStdinForProcessControl({
        sessionId: execSessionId,
        chars,
        yieldTimeMs: 250,
        maxOutputTokens: 128,
      });
      chars = "";
    }
  };
  const failPtyPersistenceAndDrain = (persistenceError: unknown, drainError: unknown): never => {
    throw new AggregateError(
      [persistenceError, drainError],
      "PTY persistence failed and the exact opened process could not be drained",
      { cause: drainError },
    );
  };
  const requestSessionAuthorization = new WeakMap<Request, ResolvedSessionAuthorization>();
  const relatedSessionAccessFor = (c: Context): "target" | "root" =>
    requestSessionAuthorization.get(c.req.raw)?.relatedSessionAccess ?? "root";
  const projectQueueSnapshot = (
    snapshot: SessionQueueSnapshot,
    sessionId: string,
    access: "target" | "root",
  ): SessionQueueSnapshot => ({
    ...snapshot,
    effectiveControl: projectEffectiveControlForRelatedAccess(
      snapshot.effectiveControl,
      sessionId,
      access,
    ),
  });

  // Every deployment has one fail-closed authorization seam for every HTTP
  // session surface. The core boundary always enforces durable OpenGeni-owned
  // private-session rules; an embedding host port can add narrower policy.
  // Register it before the routes so a newly added path cannot accidentally
  // inherit workspace access without an explicit operation classification. The
  // long-lived event stream performs its own initial check and bounded
  // reauthorization below.
  const authorizeSessionHttp: MiddlewareHandler = async (c, next) => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const sessionId = c.req.param("sessionId") ?? "";
    // Reject malformed route identifiers before the authorization resolver
    // reaches UUID-typed persistence queries. Besides avoiding a needless DB
    // round trip, this preserves the session surface's non-enumerating 404
    // contract instead of leaking a driver-level 500.
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const operation = sessionAuthorizationOperationForHttp(
      c.req.method,
      new URL(c.req.url).pathname,
      sessionId,
    );
    if (operation === "session.stream.read") {
      await next();
      return;
    }
    if (!operation) {
      throw sessionAuthorizationHttpError(new SessionAuthorizationUnavailableError());
    }
    if (operation === "session.codex_account.write" && !deps.sessionAuthorization) {
      await next();
      return;
    }
    const grant = await requireAccessGrant(c, deps, workspaceId);
    try {
      const authorization = await requireSessionAuthorization(deps, grant, {
        sessionId,
        operation,
        surface: "http",
      });
      if (authorization) requestSessionAuthorization.set(c.req.raw, authorization);
    } catch (error) {
      throw sessionAuthorizationHttpError(error);
    }
    await next();
  };
  app.use("/v1/workspaces/:workspaceId/sessions/:sessionId/*", authorizeSessionHttp);

  const viewerServices: ViewerServices = {
    db,
    settings,
    bus,
    ...(deps.establishSandboxSession
      ? { establishSandboxSession: deps.establishSandboxSession }
      : {}),
  };

  app.post("/v1/workspaces/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        {
          code: "INVALID_SESSION_CREATE_REQUEST",
          message: "Invalid session create request: request body must contain valid JSON",
        },
        422,
      );
    }
    let session: Session;
    try {
      session = await createSessionForRequest(deps, grant, workspaceId, payload);
    } catch (error) {
      return sessionCreateErrorResponse(c, error);
    }
    // Creation has committed by this point. Keep response projection outside
    // the create-rejection boundary so a post-commit policy read cannot be
    // misreported as though the session itself was rejected.
    return c.json(await withEffectivePolicy(deps, workspaceId, session), 202);
  });

  app.get("/v1/workspaces/:workspaceId/new-session-draft", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    return c.json(await getActorNewSessionDraft({ settings, db }, grant, workspaceId));
  });

  app.put("/v1/workspaces/:workspaceId/new-session-draft", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:create");
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        {
          code: "INVALID_NEW_SESSION_DRAFT_REQUEST",
          message: "Invalid new-session draft request: request body must contain valid JSON",
        },
        422,
      );
    }
    try {
      return c.json(
        await saveActorNewSessionDraft(
          { settings, db, objectStorage },
          grant,
          workspaceId,
          payload,
        ),
      );
    } catch (error) {
      if (error instanceof NewSessionDraftConflictError) {
        return c.json(
          {
            code: "NEW_SESSION_DRAFT_CONFLICT",
            message: error.message,
            currentRevision: error.currentRevision,
          },
          409,
        );
      }
      if (error instanceof ZodError) {
        return c.json(
          {
            code: "INVALID_NEW_SESSION_DRAFT_REQUEST",
            message: `Invalid new-session draft request: ${zodErrorFields(error)} failed schema validation`,
          },
          422,
        );
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    let authorizationScope;
    try {
      authorizationScope = await requireSessionAuthorizationListScope(deps, grant, "http");
    } catch (error) {
      throw sessionAuthorizationHttpError(error);
    }
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
        ...(authorizationScope ? { authorizationScope } : {}),
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
    const policy = await loadEffectivePolicyContext(deps, workspaceId);
    const decorate = (session: Session): Session =>
      sessionWithEffectiveToolPolicy(
        session,
        policy.workspaceServerIds,
        policy.workspaceDefaultServerIds,
      );
    if (pageView) {
      return c.json({
        ...page,
        pinned: page.pinned.map(decorate),
        sessions: page.sessions.map(decorate),
      });
    }
    // Same-major compatibility: listSessions() has historically returned an
    // array. Preserve that wire shape while adding personal pin metadata/order;
    // cursor consumers opt into the additive page view. A query flag rather
    // than a /sessions/page path is deliberate: an older API safely ignores it
    // and returns its historical array instead of treating "page" as a UUID.
    return c.json([...page.pinned, ...page.sessions].map(decorate));
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const session = await getSessionForSubject(
      db,
      workspaceId,
      sessionId,
      grant.subjectId,
      relatedSessionAccessFor(c),
    );
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return c.json(await withEffectivePolicy(deps, workspaceId, session));
  });

  const publishRealtimeMutation = async (
    accountId: string,
    workspaceId: string,
    sessionId: string,
    result: {
      eventIds: string[];
      workflowWakeRevision: number | null;
    },
  ): Promise<void> => {
    const events = (
      await Promise.all(result.eventIds.map((eventId) => getSessionEvent(db, workspaceId, eventId)))
    ).filter((event) => event !== null);
    await publishDurableSessionEvents(bus, workspaceId, sessionId, events);
    if (result.workflowWakeRevision !== null) {
      await workflowClient.wakeSessionWorkflow({
        accountId,
        workspaceId,
        sessionId,
        workflowId: workflowIdForSession(sessionId),
        wakeRevision: result.workflowWakeRevision,
      });
    }
  };

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/realtime", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(400, { message: "invalid session id" });
    }
    const parsed = BeginSessionRealtimeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid session realtime request" });
    }
    try {
      const result = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
        scopedDb.transaction(async (tx) =>
          beginSessionRealtimeInTransaction(tx as unknown as Database, {
            accountId: grant.accountId,
            workspaceId,
            sessionId,
            ownerSubjectId: grant.subjectId,
            ...parsed.data,
          }),
        ),
      );
      await publishRealtimeMutation(grant.accountId, workspaceId, sessionId, result);
      c.header("cache-control", "private, no-store");
      return c.json({ mode: result.mode, replay: result.replay }, result.replay ? 200 : 201);
    } catch (error) {
      throw sessionRealtimeHttpError(error);
    }
  });

  app.patch(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/:realtimeId/heartbeat",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const sessionId = c.req.param("sessionId");
      const realtimeId = c.req.param("realtimeId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
      if (
        !z.string().uuid().safeParse(sessionId).success ||
        !z.string().uuid().safeParse(realtimeId).success
      ) {
        throw new HTTPException(400, { message: "invalid realtime lifecycle id" });
      }
      const parsed = RenewSessionRealtimeRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        throw new HTTPException(400, { message: "invalid realtime heartbeat request" });
      }
      try {
        const result = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
          scopedDb.transaction(async (tx) =>
            renewSessionRealtimeInTransaction(tx as unknown as Database, {
              workspaceId,
              sessionId,
              realtimeId,
              ownerSubjectId: grant.subjectId,
              ...parsed.data,
            }),
          ),
        );
        await publishRealtimeMutation(grant.accountId, workspaceId, sessionId, result);
        c.header("cache-control", "private, no-store");
        return c.json({ mode: result.mode, replay: result.replay });
      } catch (error) {
        throw sessionRealtimeHttpError(error);
      }
    },
  );

  app.delete("/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/:realtimeId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const realtimeId = c.req.param("realtimeId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    if (
      !z.string().uuid().safeParse(sessionId).success ||
      !z.string().uuid().safeParse(realtimeId).success
    ) {
      throw new HTTPException(400, { message: "invalid realtime lifecycle id" });
    }
    const parsed = EndSessionRealtimeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid realtime end request" });
    }
    try {
      const result = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
        scopedDb.transaction(async (tx) =>
          endSessionRealtimeInTransaction(tx as unknown as Database, {
            workspaceId,
            sessionId,
            realtimeId,
            ownerSubjectId: grant.subjectId,
            ...parsed.data,
          }),
        ),
      );
      await publishRealtimeMutation(grant.accountId, workspaceId, sessionId, result);
      c.header("cache-control", "private, no-store");
      return c.json({ mode: result.mode, replay: result.replay });
    } catch (error) {
      throw sessionRealtimeHttpError(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/webrtc", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const parsed = CodexRealtimeWebrtcRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(422, {
        message: "invalid Codex realtime WebRTC request",
      });
    }

    c.header("cache-control", "private, no-store");
    try {
      const {
        realtimeId,
        operationId,
        browserInstanceId,
        ownerKey,
        expectedVersion,
        expectedConnectionEpoch,
        rotate,
        browserActivation,
        ...providerRequest
      } = parsed.data;
      const claim = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
        scopedDb.transaction(async (tx) =>
          claimSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
            workspaceId,
            sessionId,
            realtimeId,
            operationId,
            ownerSubjectId: grant.subjectId,
            browserInstanceId,
            ownerKey,
            expectedVersion,
            expectedConnectionEpoch,
            rotate,
            promotionMode: browserActivation === "required" ? "staged" : "legacy",
          }),
        ),
      );
      if (claim.replay) {
        if (
          (claim.connection.state !== "ready" && claim.connection.state !== "active") ||
          !claim.connection.sdpAnswer
        ) {
          throw new SessionRealtimeConflictError(
            "REALTIME_CONNECTION_STATE_CHANGED",
            "Realtime connection operation cannot be replayed; rotate with a new operation",
          );
        }
        const legacyActivation =
          browserActivation !== "required" && claim.connection.state === "ready"
            ? await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
                scopedDb.transaction(async (tx) =>
                  activateSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
                    workspaceId,
                    sessionId,
                    realtimeId,
                    connectionId: claim.connection.id,
                    operationId,
                    ownerSubjectId: grant.subjectId,
                    browserInstanceId,
                    ownerKey,
                    expectedVersion,
                    expectedConnectionEpoch,
                    connectionEpoch: claim.connection.connectionEpoch,
                  }),
                ),
              )
            : null;
        return c.json({
          sdp: claim.connection.sdpAnswer,
          version: "v3" as const,
          model: "gpt-live-1-boulder-alpha" as const,
          connectionId: claim.connection.id,
          connectionEpoch: claim.connection.connectionEpoch,
          startupFenceSequence: claim.connection.startupFenceSequence,
          modeVersion: legacyActivation?.mode.version ?? claim.modeVersion,
          replay: true,
        });
      }
      const broker = buildSessionCodexRealtimeBroker(
        db,
        settings,
        workspaceId,
        sessionId,
        deps.codexFetch,
      );
      try {
        const answer = await broker({ request: providerRequest, signal: c.req.raw.signal });
        const completed = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
          scopedDb.transaction(async (tx) =>
            completeSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
              workspaceId,
              sessionId,
              realtimeId,
              connectionId: claim.connection.id,
              operationId,
              connectionEpoch: claim.connection.connectionEpoch,
              sdpAnswer: answer.sdp,
            }),
          ),
        );
        const legacyActivation =
          browserActivation !== "required"
            ? await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
                scopedDb.transaction(async (tx) =>
                  activateSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
                    workspaceId,
                    sessionId,
                    realtimeId,
                    connectionId: completed.connection.id,
                    operationId,
                    ownerSubjectId: grant.subjectId,
                    browserInstanceId,
                    ownerKey,
                    expectedVersion,
                    expectedConnectionEpoch,
                    connectionEpoch: completed.connection.connectionEpoch,
                  }),
                ),
              )
            : null;
        return c.json({
          ...answer,
          connectionId: completed.connection.id,
          connectionEpoch: completed.connection.connectionEpoch,
          startupFenceSequence: completed.connection.startupFenceSequence,
          modeVersion: legacyActivation?.mode.version ?? claim.modeVersion,
          replay: false,
        });
      } catch (error) {
        if (error instanceof CodexRealtimeBrokerError) {
          await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
            scopedDb.transaction(async (tx) =>
              failSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
                workspaceId,
                sessionId,
                realtimeId,
                connectionId: claim.connection.id,
                operationId,
                connectionEpoch: claim.connection.connectionEpoch,
                failureCode: error.reason,
              }),
            ),
          ).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SessionRealtimeConflictError) {
        throw sessionRealtimeHttpError(error);
      }
      if (!(error instanceof CodexRealtimeBrokerError)) throw error;
      const failure = codexRealtimeHttpFailure(error);
      return c.json(
        {
          error: {
            status: failure.status,
            code: failure.code,
            message: error.message,
            retryable: failure.retryable,
            details: {
              reason: error.reason,
              ...(error.providerStatus === null ? {} : { providerStatus: error.providerStatus }),
            },
          },
        },
        failure.status,
      );
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/gateway", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const sessionId = c.req.param("sessionId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    if (!z.string().uuid().safeParse(sessionId).success) {
      throw new HTTPException(404, { message: "session not found" });
    }
    const parsed = GatewayRealtimeConnectRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(422, { message: "invalid Gateway realtime request" });
    }
    c.header("cache-control", "private, no-store");
    const {
      realtimeId,
      operationId,
      browserInstanceId,
      ownerKey,
      expectedVersion,
      expectedConnectionEpoch,
      rotate,
    } = parsed.data;
    let claim: Awaited<ReturnType<typeof claimSessionRealtimeConnectionInTransaction>> | null =
      null;
    let connectionCompleted = false;
    try {
      claim = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
        scopedDb.transaction(async (tx) =>
          claimSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
            workspaceId,
            sessionId,
            realtimeId,
            operationId,
            ownerSubjectId: grant.subjectId,
            browserInstanceId,
            ownerKey,
            expectedVersion,
            expectedConnectionEpoch,
            rotate,
            promotionMode: "staged",
          }),
        ),
      );
      if (claim.replay) {
        throw new SessionRealtimeConflictError(
          "REALTIME_CONNECTION_STATE_CHANGED",
          "Realtime Gateway tokens are single-use; reconnect with a new operation",
        );
      }
      const secret = await createGatewayRealtimeConnectionSecret({
        db,
        settings,
        workspaceId,
        sessionId,
        model: claim.mode.model,
        fetchImpl: deps.codexFetch ?? fetch,
      });
      const claimed = claim;
      const completed = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
        scopedDb.transaction(async (tx) =>
          completeSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
            workspaceId,
            sessionId,
            realtimeId,
            connectionId: claimed.connection.id,
            operationId,
            connectionEpoch: claimed.connection.connectionEpoch,
            sdpAnswer: "gateway-client-secret-minted",
          }),
        ),
      );
      connectionCompleted = true;
      return c.json({
        ...secret,
        connectionId: completed.connection.id,
        connectionEpoch: completed.connection.connectionEpoch,
        startupFenceSequence: completed.connection.startupFenceSequence,
        modeVersion: claimed.modeVersion,
        replay: false as const,
      });
    } catch (error) {
      if (claim !== null && !claim.replay && !connectionCompleted) {
        const claimed = claim;
        await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
          scopedDb.transaction(async (tx) =>
            failSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
              workspaceId,
              sessionId,
              realtimeId,
              connectionId: claimed.connection.id,
              operationId,
              connectionEpoch: claimed.connection.connectionEpoch,
              failureCode:
                error instanceof GatewayRealtimeBrokerError ? error.code : "gateway_error",
            }),
          ),
        ).catch(() => undefined);
      }
      if (error instanceof SessionRealtimeConflictError) throw sessionRealtimeHttpError(error);
      if (!(error instanceof GatewayRealtimeBrokerError)) throw error;
      const status = error.code === "credential_unavailable" ? 409 : 502;
      return c.json(
        {
          error: {
            status,
            code: `GATEWAY_REALTIME_${error.code.toUpperCase()}`,
            message: error.message,
            retryable: error.code === "provider_error",
          },
        },
        status,
      );
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/:realtimeId/connections/:connectionId/activate",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const sessionId = c.req.param("sessionId");
      const realtimeId = c.req.param("realtimeId");
      const connectionId = c.req.param("connectionId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
      if (
        !z.string().uuid().safeParse(sessionId).success ||
        !z.string().uuid().safeParse(realtimeId).success ||
        !z.string().uuid().safeParse(connectionId).success
      ) {
        throw new HTTPException(400, { message: "invalid realtime connection id" });
      }
      const parsed = ActivateCodexRealtimeConnectionRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new HTTPException(422, { message: "invalid realtime connection activation" });
      }
      try {
        const result = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
          scopedDb.transaction(async (tx) =>
            activateSessionRealtimeConnectionInTransaction(tx as unknown as Database, {
              workspaceId,
              sessionId,
              realtimeId,
              connectionId,
              ownerSubjectId: grant.subjectId,
              ...parsed.data,
            }),
          ),
        );
        c.header("cache-control", "private, no-store");
        return c.json({ mode: result.mode, replay: result.replay });
      } catch (error) {
        throw sessionRealtimeHttpError(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/realtime/:realtimeId/sync",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const sessionId = c.req.param("sessionId");
      const realtimeId = c.req.param("realtimeId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
      if (
        !z.string().uuid().safeParse(sessionId).success ||
        !z.string().uuid().safeParse(realtimeId).success
      ) {
        throw new HTTPException(400, { message: "invalid realtime ledger id" });
      }
      const parsed = SyncSessionRealtimeLedgerRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsed.success) {
        throw new HTTPException(422, { message: "invalid realtime ledger sync request" });
      }
      try {
        const result = await withWorkspaceRls(db, workspaceId, async (scopedDb) =>
          scopedDb.transaction(async (tx) =>
            syncSessionRealtimeLedgerInTransaction(tx as unknown as Database, {
              workspaceId,
              sessionId,
              realtimeId,
              ownerSubjectId: grant.subjectId,
              ...parsed.data,
            }),
          ),
        );
        await publishRealtimeMutation(grant.accountId, workspaceId, sessionId, result);
        c.header("cache-control", "private, no-store");
        return c.json({ accepted: result.accepted, outbound: result.outbound });
      } catch (error) {
        throw sessionRealtimeHttpError(error);
      }
    },
  );

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
      return c.json(
        await withEffectivePolicy(
          deps,
          workspaceId,
          projectSessionForRelatedAccess(session, relatedSessionAccessFor(c)),
        ),
      );
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const lineage = await readSessionLineage(deps, grant, c.req.param("sessionId"));
    const policy = await loadEffectivePolicyContext(deps, workspaceId);
    return c.json({
      ...lineage,
      ancestors: lineage.ancestors.map((session) =>
        sessionWithEffectiveToolPolicy(
          session,
          policy.workspaceServerIds,
          policy.workspaceDefaultServerIds,
        ),
      ),
      children: mapLineageNodes(lineage.children, policy),
    });
  });

  // Pin (or unpin) the session's Codex account. body { target: "auto" | "<id>" }:
  // "auto" clears the pin (the session follows the workspace active pointer); a
  // uuid pins the session to that specific account. The pin applies to the NEXT
  // turn (the worker reads it at turn start). 404 when the session or the target
  // account id isn't in the workspace.
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/codex-account", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const body = (await c.req.json()) as { target?: string };
    const target = typeof body.target === "string" ? body.target : "";
    if (!target) {
      throw new HTTPException(400, {
        message: 'target is required ("auto" or an account id)',
      });
    }
    if (!deps.sessionAuthorization) {
      try {
        await requireSessionAuthorization(deps, grant, {
          sessionId,
          operation: "session.codex_account.write",
          surface: "http",
        });
      } catch (error) {
        throw sessionAuthorizationHttpError(error);
      }
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
    const titleUpdate = await updateSessionTitle(deps, grant, sessionId, payload.title, "user");
    // A session-returning member route must preserve the caller's private pin
    // projection. Returning the generic mapSession() default here would reset a
    // pinned React consumer to false/version 0 after a harmless rename.
    const session = await getSessionForSubject(
      db,
      workspaceId,
      sessionId,
      grant.subjectId,
      titleUpdate.relatedSessionAccess,
    );
    if (!session) {
      throw new HTTPException(404, { message: "session not found" });
    }
    return c.json(await withEffectivePolicy(deps, workspaceId, session));
  });

  app.patch(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/mcp-servers/:serverId/approval-policy",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
      const sessionId = c.req.param("sessionId");
      const parsedServerId = SessionMcpServerId.safeParse(c.req.param("serverId"));
      const payload = UpdateSessionMcpApprovalPolicyRequest.safeParse(
        await c.req.json().catch(() => null),
      );
      if (!parsedServerId.success || !payload.success) {
        throw new HTTPException(400, {
          message: "invalid MCP approval-policy request",
        });
      }
      await assertSessionExists(db, workspaceId, sessionId);
      return c.json(
        await updateSessionMcpApprovalPolicy(
          deps,
          grant,
          sessionId,
          parsedServerId.data,
          payload.data.requireApproval,
        ),
      );
    },
  );

  app.put("/v1/workspaces/:workspaceId/sessions/:sessionId/tool-policy", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    const payload = UpdateSessionToolPolicyRequest.parse(await c.req.json().catch(() => null));
    try {
      const session = await updateSessionToolPolicy(deps, grant, sessionId, payload);
      return c.json(await withEffectivePolicy(deps, workspaceId, session));
    } catch (error) {
      if (error instanceof SessionToolPolicyVersionConflictError) {
        return c.json(
          {
            code: error.code,
            message: error.message,
            currentVersion: error.currentVersion,
          },
          409,
        );
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/goal", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const goal = await getSessionGoalWithContinuation(db, workspaceId, sessionId);
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
      const { goal, events } = await setSessionGoalStatusWithEvent(db, workspaceId, sessionId, {
        status: "paused",
        ...(payload.rationale ? { rationale: payload.rationale } : {}),
        pausedReason: "api",
        event: {
          type: "goal.paused",
          actor: "api",
          reason: "api",
          ...(payload.rationale ? { rationale: payload.rationale } : {}),
        },
      });
      if (events.length > 0) {
        await bus.publish(workspaceId, sessionId, events);
      }
      return c.json((await getSessionGoalWithContinuation(db, workspaceId, sessionId)) ?? goal);
    }
    // Resume: only valid from paused; resets counters and re-arms the loop.
    if (existing.status !== "paused") {
      throw new HTTPException(409, {
        message: `session goal is ${existing.status}; only paused goals can be resumed`,
      });
    }
    const { goal, changed, workflowWakeRevision, events } = await setSessionGoalStatusWithEvent(
      db,
      workspaceId,
      sessionId,
      {
        status: "active",
        event: { type: "goal.resumed", actor: "api" },
      },
    );
    // `changed` guards the racing-PATCH case: both requests can pass the
    // status pre-check, but only the transition winner emits and wakes.
    if (changed) {
      if (events.length > 0) {
        await bus.publish(workspaceId, sessionId, events);
      }
      // signalWithStart restarts an eligible idle workflow so the durable goal
      // revision is evaluated. A closed workspace/session gate keeps the
      // revision inert until that gate's own Resume mutation commits its wake.
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
    return c.json((await getSessionGoalWithContinuation(db, workspaceId, sessionId)) ?? goal);
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
      } catch {
        console.warn("[api] cleared-goal live publish failed; durable event reconciles on replay", {
          errorClass: "EventPublishOperationError",
          errorCode: "cleared_goal_live_publish_failed",
          origin: "api",
        });
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
    const latestRequested = eventEnumValue(
      c.req.query("latest"),
      SessionEventLatestClass,
      "latest",
      undefined,
    );
    const latestClass =
      latestRequested === undefined
        ? undefined
        : sessionEventLatestClassToSemanticClass(latestRequested);
    const resultMode = eventEnumValue(
      c.req.query("resultMode") ?? c.req.query("result"),
      SessionEventResultMode,
      "resultMode",
      "events",
    );
    if (resultMode === "compact" && latestClass === undefined) {
      throw new HTTPException(400, {
        message: "resultMode=compact requires latest",
      });
    }
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
    const dbPayloadMode = resultMode === "compact" ? ("full" as const) : payloadMode;
    const dbPage = await listSessionEventPage(db, workspaceId, sessionId, {
      after,
      ...(before !== undefined ? { before } : {}),
      limit,
      direction,
      payloadMode: dbPayloadMode,
      includeTypes,
      excludeTypes,
      includeClasses: latestClass ? [latestClass] : includeClasses,
      excludeClasses,
      ...(mode === "monitoring" ? { defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES } : {}),
      ...(latestClass ? { authoritativeLatest: true } : {}),
    });
    const events = dbPage.events;
    if (resultMode === "compact") {
      const event = events[0];
      c.header("X-OpenGeni-Event-Result-Mode", "compact");
      c.header("X-OpenGeni-Event-Result", event ? "found" : "not_found");
      c.header("X-OpenGeni-Event-Mode", mode);
      c.header("X-OpenGeni-Event-Direction", direction);
      c.header("X-OpenGeni-Payload-Mode", "full");
      c.header("X-OpenGeni-Forensic-Exact", "false");
      if (!event) return c.json(null, 200);
      const result = compactSessionEventResult(
        event,
        latestClass!,
        dbPage.coveredSequence ?? {
          first: event.sequence,
          last: event.sequence,
        },
      );
      c.header("X-OpenGeni-Covered-First", String(result.coveredSequence.first));
      c.header("X-OpenGeni-Covered-Last", String(result.coveredSequence.last));
      return c.json(result);
    }
    const projected = compact ? coalesceSessionEventDeltas(events) : events;
    const page = boundSessionEventHttpPage(projected, {
      direction,
      eventProjection: mode === "forensic" && payloadMode === "full" ? "exact" : "bounded",
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    let authorization;
    try {
      authorization = await requireSessionAuthorization(deps, grant, {
        sessionId,
        operation: "session.stream.read",
        surface: "stream",
      });
    } catch (error) {
      throw sessionAuthorizationHttpError(error);
    }
    await assertSessionExists(db, workspaceId, sessionId);
    const after = Number(c.req.query("after") ?? c.req.header("Last-Event-ID") ?? 0);
    return sseSessionStream(
      db,
      bus,
      workspaceId,
      sessionId,
      Number.isFinite(after) ? after : 0,
      c.req.raw.signal,
      {
        observability: deps.observability,
        ...(authorization
          ? {
              reauthorizeAfterMs:
                authorization.reauthorizeAfterMs ?? SESSION_AUTHORIZATION_DEFAULT_REAUTHORIZE_MS,
              reauthorize: async () => {
                await requireSessionAuthorization(deps, grant, {
                  sessionId,
                  operation: "session.stream.read",
                  surface: "stream",
                });
              },
            }
          : {}),
      },
    );
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/turns", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    // Exact turn that most recently emitted durable `turn.started` — the same
    // boundary goal continuations use for inherited model/effort. Queued-only
    // or preflight-rejected turns are deliberately excluded.
    if (c.req.query("latestStarted") === "1" || c.req.query("latestStarted") === "true") {
      const latest = await getLatestStartedSessionTurn(db, workspaceId, sessionId);
      return c.json(latest ? [latest] : []);
    }
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
    return c.json(projectQueueSnapshot(snapshot, sessionId, relatedSessionAccessFor(c)));
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/queue/:turnId/move", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = MoveSessionQueueItemRequest.parse(await c.req.json());
    try {
      const response = await moveHumanQueuePrompt(
        deps,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          subjectId: grant.subjectId,
        },
        c.req.param("turnId"),
        payload,
      );
      return c.json({
        ...response,
        snapshot: projectQueueSnapshot(response.snapshot, sessionId, relatedSessionAccessFor(c)),
      });
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
      const response = await editHumanQueuePrompt(
        deps,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          subjectId: grant.subjectId,
        },
        c.req.param("turnId"),
        payload,
      );
      return c.json({
        ...response,
        snapshot: projectQueueSnapshot(response.snapshot, sessionId, relatedSessionAccessFor(c)),
      });
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
      const response = await steerHumanQueuePrompt(
        deps,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          subjectId: grant.subjectId,
        },
        c.req.param("turnId"),
        payload,
      );
      return c.json({
        ...response,
        snapshot: projectQueueSnapshot(response.snapshot, sessionId, relatedSessionAccessFor(c)),
      });
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
      const response = await deleteHumanQueuePrompt(
        deps,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          subjectId: grant.subjectId,
        },
        c.req.param("turnId"),
        payload,
      );
      return c.json({
        ...response,
        snapshot: projectQueueSnapshot(response.snapshot, sessionId, relatedSessionAccessFor(c)),
      });
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/composer-draft", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    return c.json(
      await getHumanComposerDraft(deps, {
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
          deps,
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
      throw new HTTPException(400, {
        message: "workspace-control actor is too large",
      });
    }
    const sessionId = c.req.param("sessionId");
    const parsed = SessionControlRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: "invalid session control request",
      });
    }
    try {
      const response = await controlHumanSessionWorkstream(
        deps,
        {
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          subjectId: grant.subjectId,
        },
        parsed.data,
      );
      return c.json({
        ...response,
        effectiveControl: projectEffectiveControlForRelatedAccess(
          response.effectiveControl,
          sessionId,
          relatedSessionAccessFor(c),
        ),
      });
    } catch (error) {
      return commandConflictResponse(c, error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/steer", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const payload = parseSteerSessionAdmission(await c.req.json().catch(() => null));
    const result = await acceptSessionUserMessage(deps, grant, workspaceId, sessionId, {
      text: payload.text,
      annotations: payload.annotations,
      turnInstructions: payload.turnInstructions ?? null,
      resources: payload.resources,
      model: payload.model ?? null,
      reasoningEffort: payload.reasoningEffort ?? null,
      latencyMode: payload.latencyMode ?? null,
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
    const event = parseSessionEventAdmission(await c.req.json().catch(() => null));
    const refinedOperation =
      event.type === "user.approvalDecision"
        ? "session.approval.write"
        : event.type === "user.humanInputResponse"
          ? "session.human_input.write"
          : null;
    if (refinedOperation) {
      try {
        await requireSessionAuthorization(deps, grant, {
          sessionId,
          operation: refinedOperation,
          surface: "http",
        });
      } catch (error) {
        throw sessionAuthorizationHttpError(error);
      }
    }
    if (event.type === "user.message") {
      const { accepted } = await acceptSessionUserMessage(deps, grant, workspaceId, sessionId, {
        text: event.payload.text,
        annotations: event.payload.annotations,
        turnInstructions: event.payload.turnInstructions ?? null,
        resources: event.payload.resources ?? [],
        model: event.payload.model ?? null,
        reasoningEffort: event.payload.reasoningEffort ?? null,
        latencyMode: event.payload.latencyMode ?? null,
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
        subjectId: grant.subjectId,
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

    if (event.type === "user.humanInputResponse") {
      let accepted;
      try {
        accepted = await acceptSessionHumanInputResponse(db, {
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          requestId: event.payload.requestId,
          response: event.payload.response,
          respondedBy: grant.subjectId,
          clientEventId: event.clientEventId ?? null,
        });
      } catch (error) {
        if (error instanceof HumanInputResponseValidationError) {
          throw new HTTPException(error.code === "SKIP_NOT_ALLOWED" ? 409 : 422, {
            message: error.message,
          });
        }
        throw error;
      }
      if (accepted.action === "not_found") {
        throw new HTTPException(404, {
          message: "human-input request not found",
        });
      }
      await publishDurableSessionEvents(bus, workspaceId, sessionId, accepted.events);
      if (accepted.workflowWakeRevision !== null) {
        await workflowClient.signalApprovalDecision({
          accountId: grant.accountId,
          workspaceId,
          sessionId,
          eventId: accepted.events[0]?.id ?? event.payload.requestId,
          workflowId: workflowIdForSession(sessionId),
          workflowWakeRevision: accepted.workflowWakeRevision,
        });
      }
      if (accepted.action === "conflict") {
        throw new HTTPException(409, {
          message: `human-input request is ${accepted.request.status}`,
        });
      }
      return c.json(accepted.event, 202);
    }
  });

  app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/human-input-requests", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "sessions:read");
    const sessionId = c.req.param("sessionId");
    await assertSessionExists(db, workspaceId, sessionId);
    const rawStatus = c.req.query("status");
    const status = rawStatus ? HumanInputRequestStatus.safeParse(rawStatus) : null;
    if (status && !status.success) {
      throw new HTTPException(400, {
        message: "invalid human-input request status",
      });
    }
    const requests = await listSessionHumanInputRequests(db, workspaceId, sessionId, {
      ...(status?.success ? { status: status.data } : {}),
    });
    return c.json({ requests });
  });

  app.get(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/human-input-requests/:requestId",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      await requireAccessGrant(c, deps, workspaceId, "sessions:read");
      const sessionId = c.req.param("sessionId");
      const request = await getSessionHumanInputRequest(
        db,
        workspaceId,
        sessionId,
        c.req.param("requestId"),
      );
      if (!request)
        throw new HTTPException(404, {
          message: "human-input request not found",
        });
      return c.json(request);
    },
  );

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
    const visibleSharedSessionIds = relatedSessionAccessFor(c) === "root" ? sharedSessionIds : [];
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
      (session.activeSandboxId != null || lease?.liveness === "warm");
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
      (session.activeSandboxId != null || lease?.liveness === "warm");
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
      workspaceGeneration: lease?.workspaceGeneration ?? null,
      archiveGeneration: lease?.archiveGeneration ?? null,
      archiveComplete: lease?.archiveComplete ?? false,
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
      sharedSessionIds: visibleSharedSessionIds,
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

    const repositoryRoots = [
      ...new Set(
        session.resources.flatMap((resource) =>
          resource.kind === "repository" && typeof resource.mountPath === "string"
            ? [resource.mountPath.replace(/^\/+|\/+$/g, "")]
            : [],
        ),
      ),
    ].filter(Boolean);

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
    let responseCapabilities = {
      ...capabilities,
      Git: {
        ...capabilities.Git,
        repos: capabilities.Git.available ? repositoryRoots : [],
      },
    };
    if (capabilities.DesktopStream.transport !== null) {
      const activeSandbox = session.activeSandboxId
        ? await getSandbox(db, workspaceId, session.activeSandboxId)
        : null;
      const wire = resolveActiveDesktopTransport(
        activeSandbox?.kind === "selfhosted",
        settings.sandboxDesktopInteractive !== false,
      );
      responseCapabilities = {
        ...responseCapabilities,
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
    // Authenticate and bind the workspace before parsing. The requested plane
    // determines the narrower permission below: terminal-only holders must not
    // require the strictly broader un-redacted Desktop permission.
    const grant = await requireAccessGrant(c, deps, workspaceId);
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
    requirePermission(grant, wantDesktop ? "stream:view" : "terminal:attach");
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
        workspaceGeneration: null,
        archiveGeneration: null,
        archiveComplete: false,
        sandboxGroupId: session.sandboxGroupId,
        viewerHeartbeatIntervalMs: viewerHeartbeatIntervalMs(settings),
        dataPlaneUrl: null,
      };
      if (
        (settings.sandboxDesktopEnabled || settings.sandboxTerminalEnabled) &&
        !streamTokenDegraded(settings)
      ) {
        if (wantDesktop && settings.sandboxDesktopEnabled) {
          stream = await mintDesktopStream(viewerServices, {
            accountId: grant.accountId,
            workspaceId,
            session,
            viewerId,
            // No Modal lease for selfhosted-active; the mint routes to the relay.
          });
        }
        if (settings.sandboxTerminalEnabled) {
          terminal = await mintTerminalStream(viewerServices, {
            accountId: grant.accountId,
            workspaceId,
            session,
            viewerId,
            // No Modal lease for selfhosted-active; the mint routes to the relay.
          });
        }
      }
    } else {
      result = await attachViewer(viewerServices, {
        accountId: grant.accountId,
        workspaceId,
        session,
        waitSignal: c.req.raw.signal,
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
            stream = await mintDesktopStream(viewerServices, {
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
            terminal = await mintTerminalStream(viewerServices, {
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
  // A holder can represent the terminal-only plane, so lifecycle control uses
  // terminal:attach. Desktop callers continue to pass via workspace:admin.
  app.post(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/viewers/:viewerId/heartbeat",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "terminal:attach");
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "terminal:attach");
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

  type ChannelARouteCtx = ChannelAContext & {
    waitSignal: AbortSignal;
    operation: ChannelAOperation;
  };

  // Shared preamble: grant BEFORE parse, ownership gate, session lookup. Returns
  // the resolved context the channel-a seam needs (session narrowed non-null).
  async function channelAPreamble(
    c: Context,
    permission: "files:read" | "files:write" | "terminal:attach",
    operation: ChannelAOperation,
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
      waitSignal: c.req.raw.signal,
      operation,
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
    const ctx = await channelAPreamble(c, "files:read", "fs.list");
    const req = await parseChannelABody(c, FsListRequest);
    const out = await withChannelARead(channelAServices, ctx, ({ service }) => service.fsList(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/list-batch", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "fs.list-batch");
    const req = await parseChannelABody(c, FsListBatchRequest);
    const out = await withChannelARead(channelAServices, ctx, async ({ service }) => ({
      results: await runConcurrentChannelAReads(
        req.requests.map((request) => async () => await service.fsList(request)),
      ),
    }));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/read", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "fs.read");
    const req = await parseChannelABody(c, FsReadRequest);
    const out = await withChannelARead(channelAServices, ctx, ({ service }) => service.fsRead(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/write", async (c) => {
    const ctx = await channelAPreamble(c, "files:write", "fs.write");
    const req = await parseChannelABody(c, FsWriteRequest);
    const out = await withChannelA(channelAServices, ctx, ({ service }) => service.fsWrite(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/delete", async (c) => {
    const ctx = await channelAPreamble(c, "files:write", "fs.delete");
    const req = await parseChannelABody(c, FsDeleteRequest);
    const out = await withChannelA(channelAServices, ctx, ({ service }) => service.fsDelete(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/move", async (c) => {
    const ctx = await channelAPreamble(c, "files:write", "fs.move");
    const req = await parseChannelABody(c, FsMoveRequest);
    const out = await withChannelA(channelAServices, ctx, ({ service }) => service.fsMove(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/fs/mkdir", async (c) => {
    const ctx = await channelAPreamble(c, "files:write", "fs.mkdir");
    const req = await parseChannelABody(c, FsMkdirRequest);
    const out = await withChannelA(channelAServices, ctx, ({ service }) => service.fsMkdir(req));
    return c.json(out);
  });

  // ── Git (read-only) ─────────────────────────────────────────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/status", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "git.status");
    const req = await parseChannelABody(c, GitStatusRequest);
    const out = await withChannelARead(channelAServices, ctx, ({ service }) =>
      service.gitStatus(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/diff", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "git.diff");
    const req = await parseChannelABody(c, GitDiffRequest);
    const out = await withChannelARead(channelAServices, ctx, ({ service }) =>
      service.gitDiff(req),
    );
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/read-batch", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "git.read-batch");
    const req = await parseChannelABody(c, GitReadBatchRequest);
    const out = await withChannelARead(channelAServices, ctx, async ({ service }) => {
      type StatusResult = Awaited<ReturnType<typeof service.gitStatus>>;
      type DiffResult = Awaited<ReturnType<typeof service.gitDiff>>;
      type ReadResult =
        | { requestIndex: number; kind: "status"; value: StatusResult }
        | { requestIndex: number; kind: "diff"; value: DiffResult };
      const operations: Array<() => Promise<ReadResult>> = [];
      req.requests.forEach((request, requestIndex) => {
        operations.push(async () => ({
          requestIndex,
          kind: "status" as const,
          value: await service.gitStatus(request.status),
        }));
        if (request.diff) {
          const diffRequest = request.diff;
          operations.push(async () => ({
            requestIndex,
            kind: "diff" as const,
            value: await service.gitDiff(diffRequest),
          }));
        }
      });

      const reads = await runConcurrentChannelAReads(operations);
      const statuses = new Map<number, StatusResult>();
      const diffs = new Map<number, DiffResult>();
      for (const read of reads) {
        if (read.kind === "status") statuses.set(read.requestIndex, read.value);
        else diffs.set(read.requestIndex, read.value);
      }

      return {
        results: req.requests.map((request, requestIndex) => {
          const status = statuses.get(requestIndex);
          if (!status) {
            throw new Error(`Workspace Git batch omitted status result ${requestIndex}.`);
          }
          const diff = request.diff ? diffs.get(requestIndex) : undefined;
          if (request.diff && !diff) {
            throw new Error(`Workspace Git batch omitted diff result ${requestIndex}.`);
          }
          return { status, ...(diff ? { diff } : {}) };
        }),
      };
    });
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/log", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "git.log");
    const req = await parseChannelABody(c, GitLogRequest);
    const out = await withChannelARead(channelAServices, ctx, ({ service }) => service.gitLog(req));
    return c.json(out);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/git/show", async (c) => {
    const ctx = await channelAPreamble(c, "files:read", "git.show");
    const req = await parseChannelABody(c, GitShowRequest);
    const out = await withChannelARead(channelAServices, ctx, ({ service }) =>
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
    const lookup = await sessionLatestWorkspaceCapture(db, workspaceId, sessionId);
    if (!lookup.sessionExists) {
      throw new HTTPException(404, { message: "session not found" });
    }
    if (!objectStorage) {
      // No storage configured → no captures can exist. Cold-fallback, not an error.
      return c.json({ available: false });
    }
    return c.json(
      await serveWorkspaceCapture(lookup.capture, objectStorage, workspaceCaptureManifestCache),
    );
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
    const ctx = await channelAPreamble(c, "terminal:attach", "terminal.exec");
    const req = await parseChannelABody(c, TerminalExecRequest);
    const out = await withChannelA(channelAServices, ctx, ({ service }) =>
      service.terminalExec(req),
    );
    return c.json(out);
  });

  // ── Terminal: interactive PTY control (output rides A1) ───────────────────
  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach", "terminal.pty.open");
    const req = await parseChannelABody(c, PtyOpenRequest);
    if (ctx.session.sandboxBackend === "selfhosted" || ctx.session.activeSandboxId !== null) {
      throw new HTTPException(409, {
        message:
          "durable interactive terminals require the session-home provider route and are unavailable on active swaps or non-persistable routes; use synchronous exec or attach the session home sandbox",
      });
    }
    const ptyId = crypto.randomUUID();
    const out = await withChannelA(channelAServices, ctx, async (handle) => {
      if (!handle.lease) {
        throw new HTTPException(409, {
          message: "durable interactive terminals require a session-home provider lease",
        });
      }
      const { service } = handle;
      const opened = await service.ptyOpen(req, ptyId);
      const execSessionId = opened.execSessionId;
      const retained =
        execSessionId === null
          ? null
          : handle.routingSession.retainedProcessIdentity(execSessionId);
      const process = retained
        ? await getRetainedProcess(db, {
            workspaceId: ctx.workspaceId,
            sessionId: ctx.session.id,
            processId: retained.id,
          })
        : null;
      if (
        execSessionId === null ||
        !retained ||
        !process ||
        process.state !== "active" ||
        process.ownerActorKind !== "direct" ||
        process.providerSessionId !== execSessionId ||
        process.routeTargetId !== null ||
        process.leaseId !== handle.lease.id ||
        process.sandboxGroupId !== handle.lease.sandboxGroupId ||
        process.leaseEpoch !== handle.lease.leaseEpoch ||
        process.providerBackend !== handle.lease.backend ||
        process.providerInstanceId !== handle.lease.instanceId
      ) {
        if (execSessionId !== null && handle.routingSession.hasRetainedProcess(execSessionId)) {
          await drainOpenedPty(handle, execSessionId);
        }
        throw new HTTPException(409, {
          message: "interactive terminal did not acquire durable process authority",
        });
      }
      const identity: SandboxPtyProcessIdentity = {
        leaseId: process.leaseId,
        sandboxGroupId: process.sandboxGroupId,
        retainedProcessId: process.id,
        openAdmissionId: process.parentAdmissionId,
        execSessionId: process.providerSessionId,
        leaseEpoch: process.leaseEpoch,
        providerBackend: process.providerBackend,
        providerInstanceId: process.providerInstanceId,
        routeKind: process.routeKind,
        routeTargetId: process.routeTargetId,
        routeEpoch: process.routeEpoch,
      };
      try {
        await insertPtySession(db, {
          id: ptyId,
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          sessionId: ctx.session.id,
          identity,
          cols: req.cols,
          rows: req.rows,
          shell: opened.shell,
          cwd: req.cwd,
          openedBy: ctx.subjectId,
        });
      } catch (persistenceError) {
        try {
          await drainOpenedPty(handle, execSessionId);
        } catch (drainError) {
          failPtyPersistenceAndDrain(persistenceError, drainError);
        }
        throw persistenceError;
      }
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
    const ctx = await channelAPreamble(c, "terminal:attach", "terminal.pty.write");
    const req = await parseChannelABody(c, PtyWriteRequest);
    const pty = await getOpenPtySession(db, {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      ptyId: req.ptyId,
    });
    if (!pty) {
      throw new HTTPException(404, { message: "pty not found or closed" });
    }
    let seq = 1;
    await withChannelA(channelAServices, ctx, async (handle) => {
      await adoptPtyProcess(ctx, handle, pty);
      let output: string;
      try {
        output = await handle.service.ptyWrite(req, pty.execSessionId, req.data);
      } catch (error) {
        const terminal = await getRetainedProcess(db, {
          workspaceId: ctx.workspaceId,
          sessionId: ctx.session.id,
          processId: pty.retainedProcessId,
        });
        if (terminal && terminal.state !== "active") {
          await emitPtyExited(ctx, req.ptyId, terminal);
        }
        throw error;
      }
      const updated = await updatePtySessionActivity(db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        ptyId: req.ptyId,
        identity: ptyIdentity(pty),
      });
      if (!updated) {
        const terminal = await getRetainedProcess(db, {
          workspaceId: ctx.workspaceId,
          sessionId: ctx.session.id,
          processId: pty.retainedProcessId,
        });
        if (terminal && terminal.state !== "active") {
          await emitPtyExited(ctx, req.ptyId, terminal);
          return;
        }
        throw new HTTPException(409, {
          message: "pty identity changed while input was in flight; reopen the terminal",
        });
      }
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
    const ctx = await channelAPreamble(c, "terminal:attach", "terminal.pty.resize");
    const req = await parseChannelABody(c, PtyResizeRequest);
    const pty = await getOpenPtySession(db, {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      ptyId: req.ptyId,
    });
    if (!pty) {
      throw new HTTPException(404, { message: "pty not found or closed" });
    }
    await withChannelA(channelAServices, ctx, async (handle) => {
      await adoptPtyProcess(ctx, handle, pty);
      await handle.service.ptyResize(req, pty.execSessionId);
      const updated = await updatePtySessionActivity(db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.session.id,
        ptyId: req.ptyId,
        identity: ptyIdentity(pty),
        cols: req.cols,
        rows: req.rows,
      });
      if (!updated) {
        throw new HTTPException(409, {
          message: "pty identity changed while resize was in flight; reopen the terminal",
        });
      }
    });
    return c.body(null, 204);
  });

  app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/terminal/pty/close", async (c) => {
    const ctx = await channelAPreamble(c, "terminal:attach", "terminal.pty.close");
    const req = await parseChannelABody(c, PtyCloseRequest);
    const pty = await getOpenPtySession(db, {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.session.id,
      ptyId: req.ptyId,
    });
    // Idempotent: closing an already-closed/absent PTY is a 204 no-op.
    if (pty) {
      await withChannelA(channelAServices, ctx, async (handle) => {
        await adoptPtyProcess(ctx, handle, pty);
        await handle.service.ptyClose(req, pty.execSessionId);
        const terminal = await getRetainedProcess(db, {
          workspaceId: ctx.workspaceId,
          sessionId: ctx.session.id,
          processId: pty.retainedProcessId,
        });
        if (!terminal || terminal.state === "active") {
          throw new HTTPException(409, {
            message: "pty close is pending exact provider exit proof; retry",
          });
        }
        await emitPtyExited(ctx, req.ptyId, terminal);
      });
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

function codexRealtimeHttpFailure(error: CodexRealtimeBrokerError): {
  status: ContentfulStatusCode;
  code: ErrorCode;
  retryable: boolean;
} {
  switch (error.reason) {
    case "invalid_request":
    case "incompatible":
      return { status: 422, code: "validation_failed", retryable: false };
    case "entitlement_denied":
      return { status: 403, code: "forbidden", retryable: false };
    case "rate_limited":
      return { status: 429, code: "limit_exceeded", retryable: true };
    case "timeout":
      return { status: 504, code: "upstream_unavailable", retryable: true };
    case "cancelled":
      return { status: 408, code: "upstream_unavailable", retryable: true };
    case "provider_error":
    case "invalid_provider_response":
    case "network_error":
      return { status: 502, code: "upstream_unavailable", retryable: true };
    case "subscription_disabled":
    case "credential_unavailable":
    case "reconnect_required":
      return { status: 409, code: "conflict", retryable: false };
  }
}

function sessionRealtimeHttpError(error: unknown): HTTPException {
  if (error instanceof HTTPException) return error;
  if (error instanceof SessionRealtimeConflictError) {
    return new HTTPException(error.code === "REALTIME_NOT_FOUND" ? 404 : 409, {
      message: error.message,
      cause: error,
    });
  }
  throw error;
}

/**
 * Map every mounted session-addressed HTTP path to the host-neutral operation
 * the embedding port authorizes. Returning null is deliberately fail-closed in
 * host-managed mode; standalone deployments never consult this classifier.
 */
export function sessionAuthorizationOperationForHttp(
  method: string,
  pathname: string,
  sessionId: string,
): SessionAuthorizationOperation | null {
  const marker = `/sessions/${sessionId}`;
  const markerAt = pathname.indexOf(marker);
  if (markerAt < 0) return null;
  const suffix = pathname.slice(markerAt + marker.length);
  const verb = method.toUpperCase();

  if (suffix === "") {
    if (verb === "GET") return "session.read";
    if (verb === "PATCH") return "session.title.write";
    return null;
  }
  if (suffix === "/pin" && verb === "PUT") return "session.pin.write";
  if (suffix === "/tool-policy" && verb === "PUT") return "session.tool_policy.write";
  if (/^\/mcp-servers\/[^/]+\/approval-policy$/.test(suffix) && verb === "PATCH") {
    return "session.mcp.approval_policy.write";
  }
  if (suffix === "/lineage" && verb === "GET") return "session.lineage.read";
  if (suffix === "/codex-account" && verb === "POST") {
    return "session.codex_account.write";
  }
  if (suffix === "/realtime/webrtc" && verb === "POST") {
    return "session.realtime.start";
  }
  if (suffix === "/realtime/gateway" && verb === "POST") {
    return "session.realtime.start";
  }
  if (suffix === "/realtime" && verb === "POST") {
    return "session.realtime.start";
  }
  if (/^\/realtime\/[^/]+\/heartbeat$/.test(suffix) && verb === "PATCH") {
    return "session.realtime.control";
  }
  if (/^\/realtime\/[^/]+\/sync$/.test(suffix) && verb === "POST") {
    return "session.realtime.control";
  }
  if (/^\/realtime\/[^/]+\/connections\/[^/]+\/activate$/.test(suffix) && verb === "POST") {
    return "session.realtime.control";
  }
  if (/^\/realtime\/[^/]+$/.test(suffix) && verb === "DELETE") {
    return "session.realtime.control";
  }
  if (suffix === "/goal") {
    return verb === "GET"
      ? "session.goal.read"
      : ["PATCH", "DELETE"].includes(verb)
        ? "session.goal.write"
        : null;
  }
  if (suffix === "/context/clear" || suffix === "/context/compact") {
    return verb === "POST" ? "session.context.write" : null;
  }
  if (suffix === "/events/stream" && verb === "GET") return "session.stream.read";
  if (suffix === "/events") {
    if (verb === "GET") return "session.events.read";
    if (verb === "POST") return "session.append";
    return null;
  }
  if (suffix === "/turns" && verb === "GET") return "session.turns.read";
  if (suffix === "/queue" && verb === "GET") return "session.queue.read";
  if (suffix.startsWith("/queue/") && verb === "POST") return "session.queue.control";
  if (suffix === "/composer-draft") {
    if (verb === "GET") return "session.composer.read";
    if (verb === "PUT") return "session.composer.write";
    return null;
  }
  if (suffix === "/control" && verb === "POST") return "session.control";
  if (suffix === "/steer" && verb === "POST") return "session.steer";
  if (suffix === "/human-input-requests" && verb === "GET") {
    return "session.human_input.read";
  }
  if (suffix.startsWith("/human-input-requests/") && verb === "GET") {
    return "session.human_input.read";
  }
  if (suffix === "/stream-capabilities" && verb === "GET") return "session.viewer.read";
  if (suffix === "/stream-capabilities/acknowledge" && verb === "POST") {
    return "session.stream.acknowledge";
  }
  if (suffix === "/viewers" && verb === "POST") return "session.viewer.control";
  if (suffix.startsWith("/viewers/") && ["POST", "DELETE"].includes(verb)) {
    return "session.viewer.control";
  }
  if (suffix === "/fs/list" || suffix === "/fs/list-batch" || suffix === "/fs/read") {
    return verb === "POST" ? "session.files.read" : null;
  }
  if (["/fs/write", "/fs/delete", "/fs/move", "/fs/mkdir"].includes(suffix)) {
    return verb === "POST" ? "session.files.write" : null;
  }
  if (suffix.startsWith("/git/") && verb === "POST") return "session.git.read";
  if ((suffix === "/workspace/capture" || suffix === "/workspace/capture/file") && verb === "GET") {
    return "session.capture.read";
  }
  if (suffix === "/terminal/exec" && verb === "POST") return "session.terminal.control";
  if (suffix === "/terminal/pty" && verb === "POST") return "session.terminal.control";
  if (suffix.startsWith("/terminal/pty/") && verb === "POST") {
    return "session.terminal.control";
  }
  return null;
}

function sessionAuthorizationHttpError(error: unknown): HTTPException {
  if (error instanceof SessionAuthorizationDeniedError) {
    return new HTTPException(404, { message: "session not found" });
  }
  if (error instanceof SessionAuthorizationUnavailableError) {
    return new HTTPException(503, {
      message: "session authorization is unavailable",
    });
  }
  if (error instanceof HTTPException) return error;
  throw error;
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
    throw new HTTPException(400, {
      message: `${name} accepts at most 100 values`,
    });
  }
  return values.map((value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `${name} contains an invalid value`,
      });
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
    throw new HTTPException(400, {
      message: 'pinsOnly must be the literal "true"',
    });
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

/** Stable, value-free JSON errors for only the create-session boundary. */
export function sessionCreateErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof SessionSpawnDeniedError) {
    return c.json(
      sessionSpawnDenialEnvelope(error),
      error.denial.code === "nested_agent_depth_override_forbidden" ? 403 : 409,
    );
  }
  if (error instanceof ZodError) {
    return c.json(
      {
        code: "INVALID_SESSION_CREATE_REQUEST",
        message: `Invalid session create request: ${zodErrorFields(error)} failed schema validation`,
      },
      422,
    );
  }
  if (error instanceof HTTPException && error.status === 422) {
    return c.json(
      {
        code: "SESSION_CREATE_REJECTED",
        message: error.message,
      },
      422,
    );
  }
  throw error;
}

export function parseSessionEventAdmission(raw: unknown): ClientSessionEvent {
  const parsed = ClientSessionEvent.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "invalid session event" });
  }
  return parsed.data;
}

export function parseSteerSessionAdmission(raw: unknown): SteerSessionMessageRequest {
  const parsed = SteerSessionMessageRequest.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(422, { message: "invalid steer request" });
  }
  return parsed.data;
}

function zodErrorFields(error: ZodError): string {
  const paths = [
    ...new Set(
      error.issues.map((issue) => {
        const path = issue.path.map(String).join(".");
        return path || "request";
      }),
    ),
  ];
  const shown = paths.slice(0, 5);
  const remainder = paths.length - shown.length;
  return `${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
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

type EffectivePolicyContext = {
  workspaceServerIds: string[];
  workspaceDefaultServerIds: string[];
};

async function loadEffectivePolicyContext(
  deps: ApiRouteDeps,
  workspaceId: string,
): Promise<EffectivePolicyContext> {
  const [workspaceServerIds, workspaceDefaultServerIds] = await Promise.all([
    workspaceSessionToolPolicyServerIds(deps.db, workspaceId, deps.settings),
    workspaceSessionToolPolicyDefaultServerIds(deps.db, workspaceId, deps.settings),
  ]);
  return { workspaceServerIds, workspaceDefaultServerIds };
}

async function withEffectivePolicy(
  deps: ApiRouteDeps,
  workspaceId: string,
  session: Session,
): Promise<Session> {
  const policy = await loadEffectivePolicyContext(deps, workspaceId);
  return sessionWithEffectiveToolPolicy(
    session,
    policy.workspaceServerIds,
    policy.workspaceDefaultServerIds,
  );
}

function mapLineageNodes(nodes: LineageNode[], policy: EffectivePolicyContext): LineageNode[] {
  return nodes.map((node) => ({
    ...node,
    session: sessionWithEffectiveToolPolicy(
      node.session as Session,
      policy.workspaceServerIds,
      policy.workspaceDefaultServerIds,
    ),
    children: mapLineageNodes(node.children, policy),
  }));
}
