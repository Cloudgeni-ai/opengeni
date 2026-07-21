import { OpenGeniApiContractMismatchError, OpenGeniApiError } from "./errors";
import {
  streamSessionEvents,
  type SessionEventStreamTransport,
  type StreamSessionEventsOptions,
} from "./stream";
import {
  streamWorkspaceControlEvents,
  type WorkspaceControlStreamTransport,
} from "./workspace-control-stream";
import type {
  AccessContext,
  AddWorkspaceMemberRequest,
  ApiKey,
  BillingEntitlementsResponse,
  CodexAccount,
  CodexAccountsResponse,
  CodexRotationSettings,
  CodexConnectionStatus,
  CodexConnectPoll,
  CodexConnectStart,
  CodexUsage,
  CodexUsageMap,
  BillingSummary,
  BillingUsageResponse,
  CapabilityCatalogItem,
  CapabilityCatalogResponse,
  CapabilityInstallation,
  AddDocumentRequest,
  ClientConfig,
  WorkspaceModelCatalogResponse,
  ClientSessionEventInput,
  CompactSessionContextResult,
  CompleteFileUploadResponse,
  ConnectionMetadata,
  CreateApiKeyRequest,
  CreateApiKeyResponse,
  CreateCapabilityCatalogItemRequest,
  CreateCheckoutRequest,
  CreateCheckoutResponse,
  CreateConnectionRequest,
  CreateDocumentBaseRequest,
  CreateFileUploadRequest,
  CreateFileUploadResponse,
  CreateGitHubAppManifestRequest,
  CreateGitHubAppManifestResponse,
  CreateKnowledgeMemoryRequest,
  CreateScheduledTaskRequest,
  CreateSessionRequest,
  CreateVariableSetRequest,
  CreateRigRequest,
  CreateWorkspaceRequest,
  // Enrollment UX (design 11): the click-Grant approve-page lookup/deny + headless
  // enroll-token mint.
  DeviceEnrollmentApproveResponse,
  DeviceEnrollmentDenyResponse,
  DeviceEnrollmentLookupResponse,
  MintEnrollTokenResponse,
  DiscoverMcpCapabilitiesResponse,
  Document,
  DocumentBase,
  DocumentSearchRequest,
  DocumentSearchResponse,
  EnableCapabilityRequest,
  EnablePackRequest,
  FileAsset,
  FileDownloadUrlResponse,
  GetPackResponse,
  GitHubAppInfo,
  GitHubRepositoriesResponse,
  KnowledgeMemory,
  KnowledgeMemorySearchRequest,
  ListApiKeysResponse,
  ListPacksResponse,
  // Bring-your-own-compute: the Machines dashboard + per-machine metrics (M10).
  MachinesResponse,
  MetricSample,
  MachineMetricsSeriesResponse,
  // Bring-your-own-compute: the user-authenticated active-sandbox swap (M7).
  SwapActiveSandboxRequest,
  SwapActiveSandboxResponse,
  ListWorkspaceMembersResponse,
  PackInstallation,
  ReasoningEffort,
  RegisterCapabilityPackRequest,
  ResourceRef,
  ScheduledTask,
  ScheduledTaskRun,
  Session,
  SessionListResponse,
  UpdateSessionPinRequest,
  SessionEvent,
  SessionGoal,
  SessionLineageResponse,
  SessionMcpCredentialUpdateInput,
  SessionQueueSnapshot,
  SessionQueueMutationResponse,
  ComposerDraft,
  DeleteSessionQueueItemRequest,
  EditSessionQueueItemRequest,
  MoveSessionQueueItemRequest,
  SaveComposerDraftRequest,
  SteerSessionQueueItemRequest,
  SessionControlResponse,
  WorkspaceInferenceControlResponse,
  WorkspaceControlEvent,
  SessionTurn,
  // Stream surfacing (Phase 5): capability negotiation + viewer lifecycle + config.
  SessionCapabilities,
  AttachViewerRequest,
  AttachViewerResponse,
  AcknowledgeStreamRequest,
  AcknowledgeStreamResponse,
  ViewerHeartbeatRequest,
  ViewerHeartbeatResponse,
  // Channel-A structured services (P4.4).
  FsListRequest,
  FsListResponse,
  FsReadRequest,
  FsReadResponse,
  FsWriteRequest,
  FsWriteResponse,
  FsDeleteRequest,
  FsDeleteResponse,
  FsMoveRequest,
  FsMoveResponse,
  FsMkdirRequest,
  FsMkdirResponse,
  GitStatusRequest,
  GitStatusResponse,
  GitDiffRequest,
  GitDiffResponse,
  GitLogRequest,
  GitLogResponse,
  GitShowRequest,
  GitShowResponse,
  // Workbench v2 turn-end capture reads (M2, dossier §10.3).
  GetWorkspaceCaptureResponse,
  GetWorkspaceCaptureFileResponse,
  TerminalExecRequest,
  TerminalExecResponse,
  PtyOpenRequest,
  PtyOpenResponse,
  PtyWriteRequest,
  PtyResizeRequest,
  PtyCloseRequest,
  ToolRef,
  UpdateConnectionRequest,
  UpdateKnowledgeMemoryRequest,
  UpdateScheduledTaskRequest,
  UpdateSessionGoalRequest,
  UpdateSessionRequest,
  UpdateVariableSetRequest,
  UpdateRigRequest,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceRequest,
  UpdateWorkspaceSettingsRequest,
  SetWorkspaceDefaultRigRequest,
  UploadFileInput,
  VariableSet,
  VariableSetVariableMetadata,
  Rig,
  RigVersion,
  RigChange,
  ProposeRigChangeRequest,
  WorkspaceMember,
  WorkspaceMemorySearchRequest,
  WorkspaceMemorySearchResponse,
  WorkspaceRegisteredPack,
  Workspace,
  ListConnectionsResponse,
  ConnectionResponse,
  OAuthStartRequest,
  OAuthStartResponse,
} from "./types";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "./types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OpenGeniClientOptions = {
  /** Base URL of the OpenGeni API, e.g. `https://api.example.com`. */
  baseUrl: string;
  /** OpenGeni API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Extra headers (static or computed per request) merged into every call. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
};

export type SendMessageInput = {
  text: string;
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  reasoningEffort?: ReasoningEffort;
  clientEventId?: string;
  controlEtag?: string;
  expectedDraftRevision?: number;
  mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[];
};

export type SteerMessageResult = {
  /** The accepted `user.message` event. */
  accepted: SessionEvent;
  /** The exact turn created for this message in the same server transaction. */
  turn: SessionTurn;
};

/**
 * Typed client for the OpenGeni public API. Framework-agnostic: only needs
 * WHATWG `fetch` + streams, so it runs in Node 18+, Bun, Deno, browsers, and
 * edge runtimes.
 */
export class OpenGeniClient {
  private readonly baseUrl: string;
  private readonly options: OpenGeniClientOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenGeniClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.options = options;
    // Bind lazily so variable sets that polyfill fetch after module load work.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  // --- Session lifecycle ---------------------------------------------------

  async createSession(workspaceId: string, request: CreateSessionRequest): Promise<Session> {
    return await this.requestJson<Session>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions`,
      request,
    );
  }

  async getSession(workspaceId: string, sessionId: string): Promise<Session> {
    return await this.requestJson<Session>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}`,
    );
  }

  async updateSession(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionRequest,
  ): Promise<Session> {
    return await this.requestJson<Session>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}`,
      request,
    );
  }

  async listSessions(
    workspaceId: string,
    options: {
      limit?: number;
      parentSessionId?: string | null;
      search?: string;
    } = {},
  ): Promise<Session[]> {
    return await this.requestJson<Session[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions`,
      undefined,
      {
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
        ...(options.search?.trim() ? { search: options.search.trim() } : {}),
        ...(Object.prototype.hasOwnProperty.call(options, "parentSessionId") &&
        options.parentSessionId !== undefined
          ? {
              parentSessionId:
                options.parentSessionId === null ? "null" : String(options.parentSessionId),
            }
          : {}),
      },
    );
  }

  /** Pin-aware ordinary-session page with a stable keyset cursor. */
  async listSessionPage(
    workspaceId: string,
    options: {
      limit?: number;
      parentSessionId?: string | null;
      cursor?: string;
      search?: string;
    } = {},
  ): Promise<SessionListResponse> {
    return await this.requestJson<SessionListResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions`,
      undefined,
      {
        view: "page",
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.search?.trim() ? { search: options.search.trim() } : {}),
        ...(Object.prototype.hasOwnProperty.call(options, "parentSessionId") &&
        options.parentSessionId !== undefined
          ? {
              parentSessionId:
                options.parentSessionId === null ? "null" : String(options.parentSessionId),
            }
          : {}),
      },
    );
  }

  /** Set this authenticated member's personal workspace pin for a session. */
  async updateSessionPin(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionPinRequest,
  ): Promise<Session> {
    return await this.requestJson<Session>(
      "PUT",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/pin`,
      request,
    );
  }

  async getSessionLineage(workspaceId: string, sessionId: string): Promise<SessionLineageResponse> {
    return await this.requestJson<SessionLineageResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/lineage`,
    );
  }

  async listTurns(
    workspaceId: string,
    sessionId: string,
    options: { limit?: number } = {},
  ): Promise<SessionTurn[]> {
    return await this.requestJson<SessionTurn[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/turns`,
      undefined,
      {
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
    );
  }

  // --- Bring-your-own-compute: Machines dashboard + metrics (M10) ------------

  /**
   * List the workspace's machines (the Machines dashboard). Each enrolled
   * selfhosted machine carries its derived state + latest metrics +
   * sharedSessionCount. Pass `sessionId` for an in-session view, which adds the
   * session's synthetic Modal group box + the active-sandbox pointer.
   */
  async listMachines(
    workspaceId: string,
    options: { sessionId?: string } = {},
  ): Promise<MachinesResponse> {
    return await this.requestJson<MachinesResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/machines`,
      undefined,
      {
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      },
    );
  }

  /**
   * Read the downsampled (~1/min) metrics series for ONE machine over a time
   * window (default 1h). The samples are oldest-first (a left-to-right chart).
   */
  async machineMetricsSeries(
    workspaceId: string,
    enrollmentId: string,
    options: { window?: "15m" | "1h" | "6h" | "24h" } = {},
  ): Promise<MetricSample[]> {
    const response = await this.requestJson<MachineMetricsSeriesResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/machines/${enrollmentId}/metrics/series`,
      undefined,
      { ...(options.window !== undefined ? { window: options.window } : {}) },
    );
    return response.samples;
  }

  // --- Self-hosted enrollment UX (design 11) --------------------------------

  /**
   * Resolve a pending device-enrollment flow by its user_code for the click-Grant
   * approve page (EnrollmentConsent). NO workspace in the path — the server
   * resolves the workspace from the (globally-unique-among-pending) code, then
   * authorizes the caller against it (enrollments:read). Rejects (404) when the
   * code is unknown/expired OR the caller lacks the grant — the two are
   * indistinguishable by design (no cross-workspace disclosure). Does not consume
   * the request.
   */
  async lookupDeviceEnrollment(userCode: string): Promise<DeviceEnrollmentLookupResponse> {
    return await this.requestJson<DeviceEnrollmentLookupResponse>(
      "POST",
      "/v1/enrollments/device/lookup",
      { userCode },
    );
  }

  /**
   * Approve a pending device-enrollment flow (the LOUD consent step). `allowScreenControl`
   * is the authoritative screen-control consent (whole-machine is mandatory/implicit).
   * Lands an enrollment + a selfhosted sandbox and unblocks the agent's poll.
   */
  async approveDeviceEnrollment(
    workspaceId: string,
    request: { userCode: string; allowScreenControl?: boolean },
  ): Promise<DeviceEnrollmentApproveResponse> {
    return await this.requestJson<DeviceEnrollmentApproveResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/enrollments/device/approve`,
      { userCode: request.userCode, allowScreenControl: request.allowScreenControl ?? false },
    );
  }

  /** Deny a pending device-enrollment flow (the explicit "no" at the approve page). */
  async denyDeviceEnrollment(
    workspaceId: string,
    request: { userCode: string },
  ): Promise<DeviceEnrollmentDenyResponse> {
    return await this.requestJson<DeviceEnrollmentDenyResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/enrollments/device/deny`,
      { userCode: request.userCode },
    );
  }

  /**
   * Mint a short-TTL headless enroll token (the `oget_` token) for the fleet /
   * non-interactive enroll path. The returned `token` is SECRET — surface it once
   * with a copy-now warning; it cannot be re-read. `allowScreenControl` bakes the
   * screen-control consent into the token.
   */
  async mintEnrollToken(
    workspaceId: string,
    request: { allowScreenControl?: boolean } = {},
  ): Promise<MintEnrollTokenResponse> {
    return await this.requestJson<MintEnrollTokenResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/enrollments/token`,
      { allowScreenControl: request.allowScreenControl ?? false },
    );
  }

  /**
   * Swap a session's active sandbox (the user-authenticated equivalent of the
   * M7 `sandbox_swap` MCP tool). `target` is a `MachineView.sandboxId` from
   * `listMachines`, or "session"/"default" to swap back to the session's own
   * group box. Validation (ownership/liveness/epoch fence) is server-side; the
   * result echoes the resulting pointer (`swapped: false` + `reason` on a
   * rejected target or a lost epoch fence).
   */
  async swapActiveSandbox(
    workspaceId: string,
    sessionId: string,
    request: SwapActiveSandboxRequest,
  ): Promise<SwapActiveSandboxResponse> {
    return await this.requestJson<SwapActiveSandboxResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/active-sandbox`,
      request,
    );
  }

  // --- Scheduled tasks -------------------------------------------------------

  async listScheduledTasks(
    workspaceId: string,
    options: { limit?: number } = {},
  ): Promise<ScheduledTask[]> {
    return await this.requestJson<ScheduledTask[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/scheduled-tasks`,
      undefined,
      {
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
    );
  }

  async getScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>(
      "GET",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}`,
    );
  }

  // --- Events: replay, send, stream ----------------------------------------

  /**
   * Replay durable events by sequence, ascending. `before` is exclusive and
   * returns the newest matching window. With `compact`, consecutive delta runs
   * may be coalesced; `payload.coalescedUntil` carries the run's last sequence
   * for resume cursors.
   */
  async listEvents(
    workspaceId: string,
    sessionId: string,
    options: { after?: number; before?: number; limit?: number; compact?: boolean } = {},
  ): Promise<SessionEvent[]> {
    return await this.requestJson<SessionEvent[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`,
      undefined,
      {
        ...(options.after !== undefined ? { after: String(options.after) } : {}),
        ...(options.before !== undefined ? { before: String(options.before) } : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
        ...(options.compact ? { compact: "1" } : {}),
      },
    );
  }

  /** POST a user/control event to the session. Returns the accepted event. */
  async sendEvent(
    workspaceId: string,
    sessionId: string,
    event: ClientSessionEventInput,
  ): Promise<SessionEvent> {
    return await this.requestJson<SessionEvent>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/events`,
      event,
    );
  }

  async sendMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ): Promise<SessionEvent> {
    const input = typeof message === "string" ? { text: message } : message;
    const { clientEventId, ...payload } = input;
    return await this.sendEvent(workspaceId, sessionId, {
      type: "user.message",
      ...(clientEventId !== undefined ? { clientEventId } : {}),
      payload,
    });
  }

  async pauseSession(
    workspaceId: string,
    sessionId: string,
    options: { reason?: string; clientEventId?: string; expectedControlEtag?: string } = {},
  ): Promise<SessionControlResponse> {
    return await this.controlSession(workspaceId, sessionId, {
      action: "pause",
      clientEventId: options.clientEventId ?? crypto.randomUUID(),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.expectedControlEtag ? { expectedControlEtag: options.expectedControlEtag } : {}),
    });
  }

  async sendApprovalDecision(
    workspaceId: string,
    sessionId: string,
    decision: {
      approvalId: string;
      decision: "approve" | "reject";
      message?: string;
      clientEventId?: string;
    },
  ): Promise<SessionEvent> {
    const { clientEventId, ...payload } = decision;
    return await this.sendEvent(workspaceId, sessionId, {
      type: "user.approvalDecision",
      ...(clientEventId !== undefined ? { clientEventId } : {}),
      payload,
    });
  }

  /**
   * Live-stream a session's events with automatic reconnect, resume from the
   * last seen sequence, gap backfill, and duplicate suppression. See
   * {@link streamSessionEvents} for the delivery guarantees.
   */
  streamEvents(
    workspaceId: string,
    sessionId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<SessionEvent, void, void> {
    return streamSessionEvents(this.eventStreamTransport(workspaceId, sessionId), options);
  }

  /** The transport `streamEvents` runs on; useful for custom streaming layers. */
  eventStreamTransport(workspaceId: string, sessionId: string): SessionEventStreamTransport {
    return {
      openStream: async (after, signal) =>
        await this.openEventStream(workspaceId, sessionId, {
          after,
          ...(signal ? { signal } : {}),
        }),
      listEvents: async (after, limit) =>
        await this.listEvents(workspaceId, sessionId, { after, limit }),
    };
  }

  /** Open one raw SSE connection (no reconnect). Most callers want `streamEvents`. */
  async openEventStream(
    workspaceId: string,
    sessionId: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const url = this.url(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/events/stream`, {
      after: String(options.after ?? 0),
    });
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.headers(), Accept: "text/event-stream" },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertApiContractResponse(response);
    if (!response.ok) {
      throw new OpenGeniApiError(response.status, await safeText(response));
    }
    if (!response.body) {
      throw new OpenGeniApiError(response.status, "SSE response did not include a readable body");
    }
    return response.body;
  }

  // --- Turn queue ------------------------------------------------------------

  async getQueue(workspaceId: string, sessionId: string): Promise<SessionQueueSnapshot> {
    return await this.requestJson<SessionQueueSnapshot>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue`,
    );
  }

  async moveQueueItem(
    workspaceId: string,
    sessionId: string,
    turnId: string,
    request: MoveSessionQueueItemRequest,
  ): Promise<SessionQueueMutationResponse> {
    return await this.requestJson<SessionQueueMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue/${turnId}/move`,
      request,
    );
  }

  async editQueueItem(
    workspaceId: string,
    sessionId: string,
    turnId: string,
    request: EditSessionQueueItemRequest,
  ): Promise<SessionQueueMutationResponse> {
    return await this.requestJson<SessionQueueMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue/${turnId}/edit`,
      request,
    );
  }

  async steerQueueItem(
    workspaceId: string,
    sessionId: string,
    turnId: string,
    request: SteerSessionQueueItemRequest,
  ): Promise<SessionQueueMutationResponse> {
    return await this.requestJson<SessionQueueMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue/${turnId}/steer`,
      request,
    );
  }

  async deleteQueueItem(
    workspaceId: string,
    sessionId: string,
    turnId: string,
    request: DeleteSessionQueueItemRequest,
  ): Promise<SessionQueueMutationResponse> {
    return await this.requestJson<SessionQueueMutationResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/queue/${turnId}/delete`,
      request,
    );
  }

  async getComposerDraft(workspaceId: string, sessionId: string): Promise<ComposerDraft> {
    return await this.requestJson<ComposerDraft>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/composer-draft`,
    );
  }

  async saveComposerDraft(
    workspaceId: string,
    sessionId: string,
    request: SaveComposerDraftRequest,
  ): Promise<ComposerDraft> {
    return await this.requestJson<ComposerDraft>(
      "PUT",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/composer-draft`,
      request,
    );
  }

  async controlSession(
    workspaceId: string,
    sessionId: string,
    request: {
      action: "pause" | "resume";
      reason?: string;
      clientEventId: string;
      expectedControlEtag?: string;
    },
  ): Promise<SessionControlResponse> {
    return await this.requestJson<SessionControlResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/control`,
      request,
    );
  }

  async resumeSession(
    workspaceId: string,
    sessionId: string,
    options: { reason?: string; clientEventId?: string; expectedControlEtag?: string } = {},
  ): Promise<SessionControlResponse> {
    return await this.controlSession(workspaceId, sessionId, {
      action: "resume",
      clientEventId: options.clientEventId ?? crypto.randomUUID(),
      ...(options.reason ? { reason: options.reason } : {}),
      ...(options.expectedControlEtag ? { expectedControlEtag: options.expectedControlEtag } : {}),
    });
  }

  async setWorkspaceInferenceState(
    workspaceId: string,
    request: {
      action: "pause" | "resume";
      reason?: string;
      clientEventId: string;
      expectedRevision?: number;
    },
  ): Promise<WorkspaceInferenceControlResponse> {
    return await this.requestJson<WorkspaceInferenceControlResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/inference-control`,
      request,
    );
  }

  async listWorkspaceControlEvents(
    workspaceId: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<WorkspaceControlEvent[]> {
    return await this.requestJson<WorkspaceControlEvent[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/control-events`,
      undefined,
      {
        ...(options.after !== undefined ? { after: String(options.after) } : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
    );
  }

  streamWorkspaceControlEvents(
    workspaceId: string,
    options: StreamSessionEventsOptions = {},
  ): AsyncGenerator<WorkspaceControlEvent, void, void> {
    return streamWorkspaceControlEvents(this.workspaceControlStreamTransport(workspaceId), options);
  }

  workspaceControlStreamTransport(workspaceId: string): WorkspaceControlStreamTransport {
    return {
      openStream: async (after, signal) =>
        await this.openWorkspaceControlEventStream(workspaceId, {
          after,
          ...(signal ? { signal } : {}),
        }),
    };
  }

  async openWorkspaceControlEventStream(
    workspaceId: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.fetchImpl(
      this.url(`/v1/workspaces/${workspaceId}/control-events/stream`, {
        after: String(options.after ?? 0),
      }),
      {
        method: "GET",
        headers: { ...this.headers(), Accept: "text/event-stream" },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    assertApiContractResponse(response);
    if (!response.ok) throw new OpenGeniApiError(response.status, await safeText(response));
    if (!response.body) {
      throw new OpenGeniApiError(response.status, "SSE response did not include a readable body");
    }
    return response.body;
  }

  /**
   * Steer: atomically put this prompt at the head and supersede the current
   * inference. The client performs one request and renders server order.
   */
  async steerMessage(
    workspaceId: string,
    sessionId: string,
    message: string | SendMessageInput,
  ): Promise<SteerMessageResult> {
    const input = typeof message === "string" ? { text: message } : message;
    return await this.requestJson<SteerMessageResult>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/steer`,
      input,
    );
  }

  // --- Goals -------------------------------------------------------------------

  /** The session's goal. 404s when the session never had one. */
  async getGoal(workspaceId: string, sessionId: string): Promise<SessionGoal> {
    return await this.requestJson<SessionGoal>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/goal`,
    );
  }

  async updateGoal(
    workspaceId: string,
    sessionId: string,
    request: UpdateSessionGoalRequest,
  ): Promise<SessionGoal> {
    return await this.requestJson<SessionGoal>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/goal`,
      request,
    );
  }

  async deleteGoal(workspaceId: string, sessionId: string): Promise<void> {
    await this.requestVoid("DELETE", `/v1/workspaces/${workspaceId}/sessions/${sessionId}/goal`);
  }

  /** Pause the goal loop: the session stops self-continuing until resumed. */
  async pauseGoal(
    workspaceId: string,
    sessionId: string,
    options: { rationale?: string } = {},
  ): Promise<SessionGoal> {
    return await this.updateGoal(workspaceId, sessionId, {
      status: "paused",
      ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
    });
  }

  /** Resume a paused goal: resets counters and re-arms the continuation loop. */
  async resumeGoal(workspaceId: string, sessionId: string): Promise<SessionGoal> {
    return await this.updateGoal(workspaceId, sessionId, { status: "active" });
  }

  // --- Operator context controls (/clear, /compact) ---------------------------

  /**
   * Clear the session's conversation context. Destructive and audit-preserving:
   * the server supersedes (never deletes) the live history and emits a
   * `session.context.cleared` event. Refused (409) while a turn is in flight or
   * awaiting action. `confirm:true` is sent so an accidental call cannot wipe
   * context — the destructive intent is explicit on the wire.
   */
  async clearSessionContext(workspaceId: string, sessionId: string): Promise<void> {
    await this.requestVoid(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/context/clear`,
      { confirm: true },
    );
  }

  /** Request one durable portable compaction at the next safe model boundary. */
  async compactSessionContext(
    workspaceId: string,
    sessionId: string,
  ): Promise<CompactSessionContextResult> {
    return await this.requestJson<CompactSessionContextResult>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/context/compact`,
      {},
    );
  }

  // --- Channel-A structured services (P4.4) ------------------------------------
  // FileSystem (Pierre tree), Git (Pierre diff), Terminal (exec + PTY). Each is a
  // synchronous API-direct point query; the fs.changed/git.changed/terminal.pty.*
  // notifications + the PTY output stream arrive on the existing event SSE.

  /** FileSystem: list a directory tree (feeds the Pierre file tree). */
  async fsList(
    workspaceId: string,
    sessionId: string,
    request: FsListRequest = {},
  ): Promise<FsListResponse> {
    return await this.requestJson<FsListResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/fs/list`,
      request,
    );
  }

  /** FileSystem: read a file (text or base64; binary-safe, size-capped). */
  async fsRead(
    workspaceId: string,
    sessionId: string,
    request: FsReadRequest,
  ): Promise<FsReadResponse> {
    return await this.requestJson<FsReadResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/fs/read`,
      request,
    );
  }

  /** FileSystem: write a file (last-writer-wins; emits fs.changed). */
  async fsWrite(
    workspaceId: string,
    sessionId: string,
    request: FsWriteRequest,
  ): Promise<FsWriteResponse> {
    return await this.requestJson<FsWriteResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/fs/write`,
      request,
    );
  }

  /** FileSystem: delete a path (emits fs.changed). */
  async fsDelete(
    workspaceId: string,
    sessionId: string,
    request: FsDeleteRequest,
  ): Promise<FsDeleteResponse> {
    return await this.requestJson<FsDeleteResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/fs/delete`,
      request,
    );
  }

  /** FileSystem: move/rename a path (emits fs.changed; 409 if destination exists and overwrite is false). */
  async fsMove(
    workspaceId: string,
    sessionId: string,
    request: FsMoveRequest,
  ): Promise<FsMoveResponse> {
    return await this.requestJson<FsMoveResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/fs/move`,
      request,
    );
  }

  /** FileSystem: create a directory (emits fs.changed; recursive defaults to true). */
  async fsMkdir(
    workspaceId: string,
    sessionId: string,
    request: FsMkdirRequest,
  ): Promise<FsMkdirResponse> {
    return await this.requestJson<FsMkdirResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/fs/mkdir`,
      request,
    );
  }

  /** Git: working-tree/index status (the Pierre file-status feed). */
  async gitStatus(
    workspaceId: string,
    sessionId: string,
    request: GitStatusRequest = {},
  ): Promise<GitStatusResponse> {
    return await this.requestJson<GitStatusResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/git/status`,
      request,
    );
  }

  /** Git: structured diff hunks (the Pierre diff feed). */
  async gitDiff(
    workspaceId: string,
    sessionId: string,
    request: GitDiffRequest = {},
  ): Promise<GitDiffResponse> {
    return await this.requestJson<GitDiffResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/git/diff`,
      request,
    );
  }

  /** Git: commit log. */
  async gitLog(
    workspaceId: string,
    sessionId: string,
    request: GitLogRequest = {},
  ): Promise<GitLogResponse> {
    return await this.requestJson<GitLogResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/git/log`,
      request,
    );
  }

  /** Git: show a commit (diff vs first parent) or fetch a raw blob at a ref. */
  async gitShow(
    workspaceId: string,
    sessionId: string,
    request: GitShowRequest,
  ): Promise<GitShowResponse> {
    return await this.requestJson<GitShowResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/git/show`,
      request,
    );
  }

  /** Workspace capture: the latest turn-end snapshot of the session's workspace
   *  (tree + per-repo diff + file after-image refs), served from durable storage
   *  WITHOUT warming a machine — the workbench cold-paint source. Returns
   *  `{available:false}` when no capture exists yet (fall back to the live path). */
  async getWorkspaceCapture(
    workspaceId: string,
    sessionId: string,
  ): Promise<GetWorkspaceCaptureResponse> {
    return await this.requestJson<GetWorkspaceCaptureResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/workspace/capture`,
    );
  }

  /** Workspace capture: a single file's after-image from the capture (revision
   *  pins a specific one; omitted → latest). Content is inline for small files,
   *  else a short-TTL signed URL; a tooLarge file returns metadata only. */
  async getWorkspaceCaptureFile(
    workspaceId: string,
    sessionId: string,
    path: string,
    revision?: number,
  ): Promise<GetWorkspaceCaptureFileResponse> {
    const query: Record<string, string> = { path };
    if (revision !== undefined) query.revision = String(revision);
    return await this.requestJson<GetWorkspaceCaptureFileResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/workspace/capture/file`,
      undefined,
      query,
    );
  }

  /** Terminal: run a bounded command, returning buffered stdout/stderr inline. */
  async terminalExec(
    workspaceId: string,
    sessionId: string,
    request: TerminalExecRequest,
  ): Promise<TerminalExecResponse> {
    return await this.requestJson<TerminalExecResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/terminal/exec`,
      request,
    );
  }

  /** Terminal: open an interactive PTY. Output streams on the event SSE as
   *  terminal.pty.output.delta; drive it with terminalPtyWrite. */
  async terminalPtyOpen(
    workspaceId: string,
    sessionId: string,
    request: PtyOpenRequest = {},
  ): Promise<PtyOpenResponse> {
    return await this.requestJson<PtyOpenResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/terminal/pty`,
      request,
    );
  }

  /** Terminal: send stdin to an open PTY (output rides A1). */
  async terminalPtyWrite(
    workspaceId: string,
    sessionId: string,
    request: PtyWriteRequest,
  ): Promise<void> {
    await this.requestVoid(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/terminal/pty/write`,
      request,
    );
  }

  /** Terminal: resize an open PTY. */
  async terminalPtyResize(
    workspaceId: string,
    sessionId: string,
    request: PtyResizeRequest,
  ): Promise<void> {
    await this.requestVoid(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/terminal/pty/resize`,
      request,
    );
  }

  /** Terminal: close an open PTY (idempotent). */
  async terminalPtyClose(
    workspaceId: string,
    sessionId: string,
    request: PtyCloseRequest,
  ): Promise<void> {
    await this.requestVoid(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/terminal/pty/close`,
      request,
    );
  }

  // --- Stream surfacing: capability negotiation + viewer lifecycle (Phase 5) ---
  // The capability doc is the single source of UI truth (degradation is always a
  // value, never a crash). The desktop pixel plane (Channel B) is gated behind an
  // un-redacted-acknowledgment + a viewer holder; the structured terminal/files/
  // git surfaces (Channel A) ride the methods above and the event SSE.

  /** Read the negotiated capability doc for a session WITHOUT acquiring a viewer
   *  holder (no warm, no spawn). Drives capability-gated rendering: which
   *  surfaces mount, the per-surface unavailability reasons, and the lease
   *  liveness the client polls on while `cold`/`warming`. The desktop URL/token
   *  are minted in-process only when the box is warm AND the principal has
   *  acknowledged the un-redacted plane. */
  async getStreamCapabilities(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionCapabilities> {
    return await this.requestJson<SessionCapabilities>(
      "GET",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities`,
    );
  }

  /** Record the calling principal's acknowledgment of the un-redacted desktop
   *  pixel plane (and, when the box is shared, the shared-exposure disclosure).
   *  The desktop viewer-attach path returns 409 until this is recorded. */
  async acknowledgeStream(
    workspaceId: string,
    sessionId: string,
    request: AcknowledgeStreamRequest = {},
  ): Promise<AcknowledgeStreamResponse> {
    return await this.requestJson<AcknowledgeStreamResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities/acknowledge`,
      request,
    );
  }

  /** Attach a viewer holder (refcounted liveness — keeps the box warm while
   *  watched/used), spinning the box up in-process when cold, and mint the scoped
   *  direct-to-provider URLs for the requested plane(s). `request.desktop:true`
   *  opts into the un-redacted pixel plane and mints the noVNC URL — that plane
   *  alone throws `OpenGeniApiError(409)` when the un-redacted/shared
   *  acknowledgment is missing (the consent gate). A terminal-only attach
   *  (`desktop` omitted/false) warms the box + mints the pty-ws terminal cell with
   *  NO consent gate. An omitted `viewerId` mints a fresh one. */
  async attachViewer(
    workspaceId: string,
    sessionId: string,
    request: AttachViewerRequest = {},
  ): Promise<AttachViewerResponse> {
    return await this.requestJson<AttachViewerResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/viewers`,
      request,
    );
  }

  /** Heartbeat a viewer holder (Channel-A app-level liveness). A closed laptop
   *  stops sending these → the reaper drops the holder within ~90s. Echoes
   *  `leaseEpoch` so a superseded epoch is rejected (`alive:false` → re-attach). */
  async heartbeatViewer(
    workspaceId: string,
    sessionId: string,
    viewerId: string,
    request: ViewerHeartbeatRequest,
  ): Promise<ViewerHeartbeatResponse> {
    return await this.requestJson<ViewerHeartbeatResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/viewers/${viewerId}/heartbeat`,
      request,
    );
  }

  /** Detach a viewer (delete this holder; idempotent delete-my-row). */
  async detachViewer(workspaceId: string, sessionId: string, viewerId: string): Promise<void> {
    await this.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/viewers/${viewerId}`,
    );
  }

  // --- Access + workspaces -----------------------------------------------------

  /**
   * The deployment's public client bootstrap config: the host-exposed models
   * (provider-grouped in `models`, flat in `allowedModels` for back-compat),
   * reasoning efforts, MCP servers, file-upload limits, and how the client is
   * expected to authenticate. Drives a composer's model picker without prior
   * knowledge of the host setup; safe to call before any auth is established.
   */
  async getClientConfig(): Promise<ClientConfig> {
    const config = await this.requestJson<ClientConfig>("GET", "/v1/config/client");
    if (config.apiContractRevision !== OPENGENI_API_CONTRACT_REVISION) {
      throw new OpenGeniApiContractMismatchError(
        OPENGENI_API_CONTRACT_REVISION,
        String(config.apiContractRevision || "(missing)"),
      );
    }
    return config;
  }

  /** Authenticated model definitions plus workspace-specific selectability. */
  async getWorkspaceModelCatalog(workspaceId: string): Promise<WorkspaceModelCatalogResponse> {
    return await this.requestJson<WorkspaceModelCatalogResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/model-catalog`,
    );
  }

  /** The caller's access context: subject, account + workspace grants, defaults. */
  async getAccessContext(): Promise<AccessContext> {
    return await this.requestJson<AccessContext>("GET", "/v1/access/me");
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return await this.requestJson<Workspace[]>("GET", "/v1/workspaces");
  }

  async createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace> {
    return await this.requestJson<Workspace>("POST", "/v1/workspaces", request);
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return await this.requestJson<Workspace>("GET", `/v1/workspaces/${workspaceId}`);
  }

  async updateWorkspace(workspaceId: string, request: UpdateWorkspaceRequest): Promise<Workspace> {
    return await this.requestJson<Workspace>("PATCH", `/v1/workspaces/${workspaceId}`, request);
  }

  /**
   * Delete a workspace and everything in it. Refused (409) for the account's
   * only workspace and while it still has a running session. Irreversible.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.requestVoid("DELETE", `/v1/workspaces/${workspaceId}`);
  }

  // --- Members ("People with access") -------------------------------------------

  /** The workspace's members (user + api_key subjects). */
  async listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const response = await this.requestJson<ListWorkspaceMembersResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/members`,
    );
    return response.members;
  }

  /**
   * Add an already-registered user by email. 404s when no user with that email
   * exists (email invites for unknown users are deferred).
   */
  async addWorkspaceMember(
    workspaceId: string,
    request: AddWorkspaceMemberRequest,
  ): Promise<WorkspaceMember> {
    return await this.requestJson<WorkspaceMember>(
      "POST",
      `/v1/workspaces/${workspaceId}/members`,
      request,
    );
  }

  async updateWorkspaceMember(
    workspaceId: string,
    subjectId: string,
    request: UpdateWorkspaceMemberRequest,
  ): Promise<WorkspaceMember> {
    return await this.requestJson<WorkspaceMember>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/members/${encodeURIComponent(subjectId)}`,
      request,
    );
  }

  /**
   * Remove a member. Refused (409) for your own membership and for the last
   * member who can still manage the workspace.
   */
  async removeWorkspaceMember(workspaceId: string, subjectId: string): Promise<void> {
    await this.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/members/${encodeURIComponent(subjectId)}`,
    );
  }

  // --- Scheduled tasks (write + runs) -------------------------------------------

  async createScheduledTask(
    workspaceId: string,
    request: CreateScheduledTaskRequest,
  ): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>(
      "POST",
      `/v1/workspaces/${workspaceId}/scheduled-tasks`,
      request,
    );
  }

  async updateScheduledTask(
    workspaceId: string,
    taskId: string,
    request: UpdateScheduledTaskRequest,
  ): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}`,
      request,
    );
  }

  async pauseScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>(
      "POST",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}/pause`,
    );
  }

  async resumeScheduledTask(workspaceId: string, taskId: string): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>(
      "POST",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}/resume`,
    );
  }

  /**
   * Fire the task immediately (manual trigger), independent of its schedule.
   * Pass a stable `triggerId` to make a retried trigger idempotent — the same
   * token charges once and starts one run. Omit it and each call is distinct.
   */
  async triggerScheduledTask(
    workspaceId: string,
    taskId: string,
    options: { triggerId?: string } = {},
  ): Promise<ScheduledTask> {
    return await this.requestJson<ScheduledTask>(
      "POST",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}/trigger`,
      options.triggerId ? { triggerId: options.triggerId } : undefined,
    );
  }

  async deleteScheduledTask(workspaceId: string, taskId: string): Promise<void> {
    await this.requestJson<unknown>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}`,
    );
  }

  async listScheduledTaskRuns(
    workspaceId: string,
    taskId: string,
    options: { limit?: number } = {},
  ): Promise<ScheduledTaskRun[]> {
    return await this.requestJson<ScheduledTaskRun[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/scheduled-tasks/${taskId}/runs`,
      undefined,
      { ...(options.limit !== undefined ? { limit: String(options.limit) } : {}) },
    );
  }

  // --- VariableSets --------------------------------------------------------------
  // Variable values are write-only: reads return name/version metadata only.

  async listVariableSets(workspaceId: string): Promise<VariableSet[]> {
    return await this.requestJson<VariableSet[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/variable-sets`,
    );
  }

  async createVariableSet(
    workspaceId: string,
    request: CreateVariableSetRequest,
  ): Promise<VariableSet> {
    return await this.requestJson<VariableSet>(
      "POST",
      `/v1/workspaces/${workspaceId}/variable-sets`,
      request,
    );
  }

  async getVariableSet(workspaceId: string, variableSetId: string): Promise<VariableSet> {
    return await this.requestJson<VariableSet>(
      "GET",
      `/v1/workspaces/${workspaceId}/variable-sets/${variableSetId}`,
    );
  }

  async updateVariableSet(
    workspaceId: string,
    variableSetId: string,
    request: UpdateVariableSetRequest,
  ): Promise<VariableSet> {
    return await this.requestJson<VariableSet>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/variable-sets/${variableSetId}`,
      request,
    );
  }

  async deleteVariableSet(workspaceId: string, variableSetId: string): Promise<void> {
    await this.requestJson<unknown>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/variable-sets/${variableSetId}`,
    );
  }

  /** Create or rotate a variable. The value never comes back on any read. */
  async setVariableSetVariable(
    workspaceId: string,
    variableSetId: string,
    name: string,
    value: string,
  ): Promise<VariableSetVariableMetadata> {
    return await this.requestJson<VariableSetVariableMetadata>(
      "PUT",
      `/v1/workspaces/${workspaceId}/variable-sets/${variableSetId}/variables/${encodeURIComponent(name)}`,
      { value },
    );
  }

  async deleteVariableSetVariable(
    workspaceId: string,
    variableSetId: string,
    name: string,
  ): Promise<void> {
    await this.requestJson<unknown>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/variable-sets/${variableSetId}/variables/${encodeURIComponent(name)}`,
    );
  }

  // --- Rigs ------------------------------------------------------------------
  // Workspace-scoped, versioned sandbox machine definitions. rigs:use gates read
  // + proposeRigChange; rigs:manage gates create / update / delete / activate.

  async listRigs(workspaceId: string): Promise<Rig[]> {
    return await this.requestJson<Rig[]>("GET", `/v1/workspaces/${workspaceId}/rigs`);
  }

  async createRig(workspaceId: string, request: CreateRigRequest): Promise<Rig> {
    return await this.requestJson<Rig>("POST", `/v1/workspaces/${workspaceId}/rigs`, request);
  }

  async getRig(workspaceId: string, rigId: string): Promise<Rig> {
    return await this.requestJson<Rig>("GET", `/v1/workspaces/${workspaceId}/rigs/${rigId}`);
  }

  async updateRig(workspaceId: string, rigId: string, request: UpdateRigRequest): Promise<Rig> {
    return await this.requestJson<Rig>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}`,
      request,
    );
  }

  async deleteRig(workspaceId: string, rigId: string): Promise<void> {
    await this.requestJson<unknown>("DELETE", `/v1/workspaces/${workspaceId}/rigs/${rigId}`);
  }

  async listRigVersions(workspaceId: string, rigId: string): Promise<RigVersion[]> {
    return await this.requestJson<RigVersion[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/versions`,
    );
  }

  /** Roll the active version to an existing one (rollback / promote-activate). */
  async activateRigVersion(
    workspaceId: string,
    rigId: string,
    versionId: string,
  ): Promise<RigVersion> {
    return await this.requestJson<RigVersion>(
      "POST",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/versions/${versionId}/activate`,
    );
  }

  async listRigChanges(workspaceId: string, rigId: string): Promise<RigChange[]> {
    return await this.requestJson<RigChange[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/changes`,
    );
  }

  /** Propose a change against the rig's active version (rigs:use). */
  async proposeRigChange(
    workspaceId: string,
    rigId: string,
    request: ProposeRigChangeRequest,
  ): Promise<RigChange> {
    return await this.requestJson<RigChange>(
      "POST",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/changes`,
      request,
    );
  }

  async getRigChange(workspaceId: string, rigId: string, changeId: string): Promise<RigChange> {
    return await this.requestJson<RigChange>(
      "GET",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/changes/${changeId}`,
    );
  }

  /**
   * Re-run verification for a change (rigs:use). Verification is asynchronous:
   * this returns the change immediately with status `verifying`; poll
   * `getRigChange`/`listRigChanges` for the terminal outcome + logs.
   */
  async verifyRigChange(workspaceId: string, rigId: string, changeId: string): Promise<RigChange> {
    return await this.requestJson<RigChange>(
      "POST",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/changes/${changeId}/verify`,
    );
  }

  /**
   * Promote a verified `definition_edit` change into a new active rig version
   * (rigs:manage). Only valid once the change's verification passed; returns the
   * newly minted version.
   */
  async promoteRigChange(
    workspaceId: string,
    rigId: string,
    changeId: string,
  ): Promise<RigVersion> {
    return await this.requestJson<RigVersion>(
      "POST",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/changes/${changeId}/promote`,
    );
  }

  /**
   * Re-run the active version's checks in a clean throwaway sandbox (rigs:use).
   * Asynchronous — returns the version id being verified; the outcome lands on
   * the version's audit trail.
   */
  async verifyRig(workspaceId: string, rigId: string): Promise<{ ok: boolean; versionId: string }> {
    return await this.requestJson<{ ok: boolean; versionId: string }>(
      "POST",
      `/v1/workspaces/${workspaceId}/rigs/${rigId}/verify`,
    );
  }

  /** @deprecated use listVariableSets */
  async listEnvironments(workspaceId: string): Promise<VariableSet[]> {
    return await this.listVariableSets(workspaceId);
  }

  /** @deprecated use createVariableSet */
  async createEnvironment(
    workspaceId: string,
    request: CreateVariableSetRequest,
  ): Promise<VariableSet> {
    return await this.createVariableSet(workspaceId, request);
  }

  /** @deprecated use getVariableSet */
  async getEnvironment(workspaceId: string, environmentId: string): Promise<VariableSet> {
    return await this.getVariableSet(workspaceId, environmentId);
  }

  /** @deprecated use updateVariableSet */
  async updateEnvironment(
    workspaceId: string,
    environmentId: string,
    request: UpdateVariableSetRequest,
  ): Promise<VariableSet> {
    return await this.updateVariableSet(workspaceId, environmentId, request);
  }

  /** @deprecated use deleteVariableSet */
  async deleteEnvironment(workspaceId: string, environmentId: string): Promise<void> {
    await this.deleteVariableSet(workspaceId, environmentId);
  }

  /** @deprecated use setVariableSetVariable */
  async setEnvironmentVariable(
    workspaceId: string,
    environmentId: string,
    name: string,
    value: string,
  ): Promise<VariableSetVariableMetadata> {
    return await this.setVariableSetVariable(workspaceId, environmentId, name, value);
  }

  /** @deprecated use deleteVariableSetVariable */
  async deleteEnvironmentVariable(
    workspaceId: string,
    environmentId: string,
    name: string,
  ): Promise<void> {
    await this.deleteVariableSetVariable(workspaceId, environmentId, name);
  }

  // --- Files -----------------------------------------------------------------------

  /** Step 1 of the upload flow: returns the pre-signed PUT target. */
  async beginFileUpload(
    workspaceId: string,
    request: CreateFileUploadRequest,
  ): Promise<CreateFileUploadResponse> {
    return await this.requestJson<CreateFileUploadResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/files/uploads`,
      request,
    );
  }

  /** Step 3 of the upload flow: server verifies the object and marks it ready. */
  async completeFileUpload(workspaceId: string, uploadId: string): Promise<FileAsset> {
    const response = await this.requestJson<CompleteFileUploadResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/files/uploads/${uploadId}/complete`,
    );
    return response.file;
  }

  /**
   * The whole upload flow as one call: begin -> PUT the bytes to the signed
   * URL (with its required headers; no API auth is sent to object storage)
   * -> complete. Returns the ready `FileAsset`.
   */
  async uploadFile(workspaceId: string, input: UploadFileInput): Promise<FileAsset> {
    // Copy Uint8Array views into a Blob so byte offsets/shared buffers can't
    // leak surrounding bytes into the PUT body.
    const body: Blob | ArrayBuffer | string =
      input.data instanceof Uint8Array ? new Blob([input.data.slice()]) : input.data;
    const sizeBytes =
      typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : body instanceof Blob
          ? body.size
          : body.byteLength;
    const upload = await this.beginFileUpload(workspaceId, {
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes,
      ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
    });
    const putResponse = await this.fetchImpl(upload.putUrl, {
      method: "PUT",
      // The backend's requiredHeaders already carry the canonical lowercase
      // `content-type` for every storage backend (Azure/S3/GCS). Do NOT also set
      // a `Content-Type` key here: WHATWG Headers treats the two casings as the
      // same header and comma-joins their values (e.g. "text/plain, text/plain"),
      // which the object store persists verbatim and COMPLETE then rejects (422),
      // and which breaks S3's presigned-URL signature.
      headers: { ...upload.requiredHeaders },
      body,
    });
    if (!putResponse.ok) {
      throw new OpenGeniApiError(putResponse.status, await safeText(putResponse));
    }
    return await this.completeFileUpload(workspaceId, upload.uploadId);
  }

  async getFile(workspaceId: string, fileId: string): Promise<FileAsset> {
    return await this.requestJson<FileAsset>(
      "GET",
      `/v1/workspaces/${workspaceId}/files/${fileId}`,
    );
  }

  /** Mint a short-lived signed download URL for a ready file. */
  async createFileDownloadUrl(
    workspaceId: string,
    fileId: string,
  ): Promise<FileDownloadUrlResponse> {
    return await this.requestJson<FileDownloadUrlResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/files/${fileId}/download-url`,
    );
  }

  // --- Documents ----------------------------------------------------------------------

  async createDocumentBase(
    workspaceId: string,
    request: CreateDocumentBaseRequest,
  ): Promise<DocumentBase> {
    return await this.requestJson<DocumentBase>(
      "POST",
      `/v1/workspaces/${workspaceId}/document-bases`,
      request,
    );
  }

  async listDocumentBases(workspaceId: string): Promise<DocumentBase[]> {
    return await this.requestJson<DocumentBase[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-bases`,
    );
  }

  async getDocumentBase(workspaceId: string, baseId: string): Promise<DocumentBase> {
    return await this.requestJson<DocumentBase>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}`,
    );
  }

  /** Index an uploaded file into the base. The file must be `ready`. */
  async addDocument(
    workspaceId: string,
    baseId: string,
    request: AddDocumentRequest,
  ): Promise<Document> {
    return await this.requestJson<Document>(
      "POST",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}/documents`,
      request,
    );
  }

  async listDocuments(workspaceId: string, baseId: string): Promise<Document[]> {
    return await this.requestJson<Document[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}/documents`,
    );
  }

  /** Retry indexing for a failed document. */
  async reindexDocument(
    workspaceId: string,
    baseId: string,
    documentId: string,
  ): Promise<Document> {
    return await this.requestJson<Document>(
      "POST",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}/documents/${documentId}/reindex`,
    );
  }

  /**
   * Delete a document from a base. Removes the document row and its indexed
   * chunks while leaving the uploaded file asset available for other uses.
   */
  async deleteDocument(workspaceId: string, baseId: string, documentId: string): Promise<void> {
    await this.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}/documents/${documentId}`,
    );
  }

  async searchDocuments(
    workspaceId: string,
    baseId: string,
    request: Omit<DocumentSearchRequest, "baseIds">,
  ): Promise<DocumentSearchResponse> {
    return await this.requestJson<DocumentSearchResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/document-bases/${baseId}/search`,
      request,
    );
  }

  async searchKnowledge(
    workspaceId: string,
    request: DocumentSearchRequest,
  ): Promise<DocumentSearchResponse> {
    return await this.requestJson<DocumentSearchResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/knowledge/search`,
      request,
    );
  }

  async listKnowledgeMemories(
    workspaceId: string,
    request: KnowledgeMemorySearchRequest = {},
  ): Promise<KnowledgeMemory[]> {
    const params = new URLSearchParams();
    if (request.query) params.set("query", request.query);
    if (request.status) params.set("status", request.status);
    if (request.kind) params.set("kind", request.kind);
    if (request.scope) params.set("scope", request.scope);
    if (request.limit) params.set("limit", String(request.limit));
    const query = params.toString();
    return await this.requestJson<KnowledgeMemory[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/knowledge/memories${query ? `?${query}` : ""}`,
    );
  }

  async getKnowledgeMemory(workspaceId: string, memoryId: string): Promise<KnowledgeMemory> {
    return await this.requestJson<KnowledgeMemory>(
      "GET",
      `/v1/workspaces/${workspaceId}/knowledge/memories/${memoryId}`,
    );
  }

  async createKnowledgeMemory(
    workspaceId: string,
    request: CreateKnowledgeMemoryRequest,
  ): Promise<KnowledgeMemory> {
    return await this.requestJson<KnowledgeMemory>(
      "POST",
      `/v1/workspaces/${workspaceId}/knowledge/memories`,
      request,
    );
  }

  async updateKnowledgeMemory(
    workspaceId: string,
    memoryId: string,
    request: UpdateKnowledgeMemoryRequest,
  ): Promise<KnowledgeMemory> {
    return await this.requestJson<KnowledgeMemory>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/knowledge/memories/${memoryId}`,
      request,
    );
  }

  /** Hybrid (semantic + keyword) search over the workspace's agent-visible memory. */
  async searchWorkspaceMemories(
    workspaceId: string,
    request: WorkspaceMemorySearchRequest,
  ): Promise<WorkspaceMemorySearchResponse> {
    return await this.requestJson<WorkspaceMemorySearchResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/knowledge/memories/search`,
      request,
    );
  }

  /** Deep-merge a settings patch into the workspace (preserves unknown keys). */
  async updateWorkspaceSettings(
    workspaceId: string,
    request: UpdateWorkspaceSettingsRequest,
  ): Promise<Workspace> {
    return await this.requestJson<Workspace>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/settings`,
      request,
    );
  }

  async setWorkspaceDefaultRig(
    workspaceId: string,
    request: SetWorkspaceDefaultRigRequest,
  ): Promise<Workspace> {
    return await this.requestJson<Workspace>(
      "PUT",
      `/v1/workspaces/${workspaceId}/default-rig`,
      request,
    );
  }

  // --- Capability packs ------------------------------------------------------------------

  /** Built-in + registered packs, with the workspace's installations. */
  async listPacks(workspaceId: string): Promise<ListPacksResponse> {
    return await this.requestJson<ListPacksResponse>("GET", `/v1/workspaces/${workspaceId}/packs`);
  }

  /** Register (or replace) a workspace-scoped pack from a manifest. */
  async registerPack(
    workspaceId: string,
    manifest: RegisterCapabilityPackRequest,
  ): Promise<WorkspaceRegisteredPack> {
    return await this.requestJson<WorkspaceRegisteredPack>(
      "POST",
      `/v1/workspaces/${workspaceId}/packs`,
      manifest,
    );
  }

  async getPack(workspaceId: string, packId: string): Promise<GetPackResponse> {
    return await this.requestJson<GetPackResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/packs/${encodeURIComponent(packId)}`,
    );
  }

  async enablePack(
    workspaceId: string,
    packId: string,
    request: EnablePackRequest = {},
  ): Promise<PackInstallation> {
    return await this.requestJson<PackInstallation>(
      "POST",
      `/v1/workspaces/${workspaceId}/packs/${encodeURIComponent(packId)}/enable`,
      request,
    );
  }

  /** Unregister a workspace-scoped pack (built-in packs cannot be deleted). */
  async deletePack(workspaceId: string, packId: string): Promise<void> {
    await this.requestVoid(
      "DELETE",
      `/v1/workspaces/${workspaceId}/packs/${encodeURIComponent(packId)}`,
    );
  }

  async listPackInstallations(workspaceId: string): Promise<PackInstallation[]> {
    return await this.requestJson<PackInstallation[]>(
      "GET",
      `/v1/workspaces/${workspaceId}/packs/installations`,
    );
  }

  // --- Capabilities -------------------------------------------------------------------------

  async listCapabilities(workspaceId: string): Promise<CapabilityCatalogResponse> {
    return await this.requestJson<CapabilityCatalogResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/capabilities`,
    );
  }

  /** Add a manual capability catalog item (e.g. a remote MCP server). */
  async createCapability(
    workspaceId: string,
    request: CreateCapabilityCatalogItemRequest,
  ): Promise<CapabilityCatalogItem> {
    return await this.requestJson<CapabilityCatalogItem>(
      "POST",
      `/v1/workspaces/${workspaceId}/capabilities`,
      request,
    );
  }

  async enableCapability(
    workspaceId: string,
    capabilityId: string,
    request: EnableCapabilityRequest = {},
  ): Promise<CapabilityInstallation> {
    return await this.requestJson<CapabilityInstallation>(
      "POST",
      `/v1/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/enable`,
      request,
    );
  }

  async disableCapability(
    workspaceId: string,
    capabilityId: string,
  ): Promise<CapabilityInstallation> {
    return await this.requestJson<CapabilityInstallation>(
      "POST",
      `/v1/workspaces/${workspaceId}/capabilities/${encodeURIComponent(capabilityId)}/disable`,
    );
  }

  /** Search the official MCP registry for installable capabilities. */
  async discoverMcpCapabilities(
    workspaceId: string,
    options: { query?: string; limit?: number } = {},
  ): Promise<DiscoverMcpCapabilitiesResponse> {
    return await this.requestJson<DiscoverMcpCapabilitiesResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/capabilities/discovery/mcp-registry`,
      undefined,
      {
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      },
    );
  }

  // --- Connections -------------------------------------------------------------------------------

  async listConnections(workspaceId: string): Promise<ConnectionMetadata[]> {
    const response = await this.requestJson<ListConnectionsResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/connections`,
    );
    return response.connections;
  }

  async createConnection(
    workspaceId: string,
    request: CreateConnectionRequest,
  ): Promise<ConnectionMetadata> {
    const response = await this.requestJson<ConnectionResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      request,
    );
    return response.connection;
  }

  async updateConnection(
    workspaceId: string,
    connectionId: string,
    request: UpdateConnectionRequest,
  ): Promise<ConnectionMetadata> {
    const response = await this.requestJson<ConnectionResponse>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      request,
    );
    return response.connection;
  }

  async deleteConnection(workspaceId: string, connectionId: string): Promise<ConnectionMetadata> {
    const response = await this.requestJson<ConnectionResponse>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    );
    return response.connection;
  }

  /** Start an OAuth connection flow; redirect the user to the returned `authorizationUrl`. */
  async startConnectionOAuth(
    workspaceId: string,
    request: OAuthStartRequest,
  ): Promise<OAuthStartResponse> {
    return await this.requestJson<OAuthStartResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/oauth/start`,
      request,
    );
  }

  /** Public, immutably-cached URL for a catalog item's logo, or null when the item has none. */
  catalogAssetUrl(logoAssetPath: string | null): string | null {
    return logoAssetPath ? `${this.baseUrl}/v1/${logoAssetPath}` : null;
  }

  // --- GitHub ----------------------------------------------------------------------------------

  /** GitHub App configuration status + a signed install URL when configured. */
  async getGitHubApp(workspaceId: string): Promise<GitHubAppInfo> {
    return await this.requestJson<GitHubAppInfo>("GET", `/v1/workspaces/${workspaceId}/github/app`);
  }

  /**
   * Browser entry point that plants the CSRF cookie and forwards to GitHub's
   * install page. Open this in a browser (it redirects); `state` comes from
   * `getGitHubApp().installUrl` or a github_connect_link tool.
   */
  githubConnectUrl(workspaceId: string, state: string): string {
    return this.url(`/v1/workspaces/${workspaceId}/github/connect`, { state });
  }

  async listGitHubRepositories(workspaceId: string): Promise<GitHubRepositoriesResponse> {
    return await this.requestJson<GitHubRepositoriesResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/github/repositories`,
    );
  }

  /** Re-sync the installation's repository list from GitHub. */
  async syncGitHubRepositories(workspaceId: string): Promise<GitHubRepositoriesResponse> {
    return await this.requestJson<GitHubRepositoriesResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/github/repositories/sync`,
    );
  }

  /** Build a GitHub App manifest + the GitHub URL to submit it to. */
  async createGitHubAppManifest(
    workspaceId: string,
    request: CreateGitHubAppManifestRequest = {},
  ): Promise<CreateGitHubAppManifestResponse> {
    return await this.requestJson<CreateGitHubAppManifestResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/github/app-manifest`,
      request,
    );
  }

  // --- API keys ----------------------------------------------------------------------------------

  async listApiKeys(workspaceId: string): Promise<ApiKey[]> {
    const response = await this.requestJson<ListApiKeysResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/api-keys`,
    );
    return response.apiKeys;
  }

  /** The returned `token` is shown once; only its prefix is stored. */
  async createApiKey(
    workspaceId: string,
    request: CreateApiKeyRequest,
  ): Promise<CreateApiKeyResponse> {
    return await this.requestJson<CreateApiKeyResponse>(
      "POST",
      `/v1/workspaces/${workspaceId}/api-keys`,
      request,
    );
  }

  /** Revoke an API key. Returns the revoked key. */
  async deleteApiKey(workspaceId: string, apiKeyId: string): Promise<ApiKey> {
    return await this.requestJson<ApiKey>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/api-keys/${apiKeyId}`,
    );
  }

  // --- Billing (account-scoped) --------------------------------------------------------------------

  async getBilling(options: { accountId?: string } = {}): Promise<BillingSummary> {
    return await this.requestJson<BillingSummary>("GET", "/v1/billing", undefined, {
      ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
    });
  }

  async getBillingUsage(
    options: { accountId?: string; workspaceId?: string } = {},
  ): Promise<BillingUsageResponse> {
    return await this.requestJson<BillingUsageResponse>("GET", "/v1/billing/usage", undefined, {
      ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
      ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
    });
  }

  async getBillingEntitlements(
    options: { accountId?: string } = {},
  ): Promise<BillingEntitlementsResponse> {
    return await this.requestJson<BillingEntitlementsResponse>(
      "GET",
      "/v1/billing/entitlements",
      undefined,
      {
        ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
      },
    );
  }

  /** Start a Stripe checkout for prepaid credits. */
  async createBillingCheckout(request: CreateCheckoutRequest): Promise<CreateCheckoutResponse> {
    return await this.requestJson<CreateCheckoutResponse>("POST", "/v1/billing/checkout", request);
  }

  // --- Internals -------------------------------------------------------------

  private headers(): Record<string, string> {
    const extra =
      typeof this.options.headers === "function" ? this.options.headers() : this.options.headers;
    return {
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...extra,
      [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
    };
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query).toString();
    return `${this.baseUrl}${path}${params ? `?${params}` : ""}`;
  }

  // --- Codex (ChatGPT) subscription (workspace-scoped) --------------------------------------------

  /** Connection state + the codex models the workspace may select (empty until connected). */
  async codexStatus(workspaceId: string): Promise<CodexConnectionStatus> {
    return await this.requestJson<CodexConnectionStatus>(
      "GET",
      `/v1/workspaces/${workspaceId}/codex/status`,
    );
  }

  /** Begin device-code login: show `userCode` at `verificationUri`, then poll with `state`. */
  async codexConnectStart(workspaceId: string): Promise<CodexConnectStart> {
    return await this.requestJson<CodexConnectStart>(
      "POST",
      `/v1/workspaces/${workspaceId}/codex/connect/start`,
    );
  }

  /** Poll device-code authorization with the `state` from {@link codexConnectStart}. */
  async codexConnectPoll(workspaceId: string, state: string): Promise<CodexConnectPoll> {
    return await this.requestJson<CodexConnectPoll>(
      "POST",
      `/v1/workspaces/${workspaceId}/codex/connect/poll`,
      { state },
    );
  }

  /** Remaining usage / limits for the connected (ACTIVE) subscription. Back-compat. */
  async codexUsage(workspaceId: string): Promise<CodexUsage> {
    return await this.requestJson<CodexUsage>("GET", `/v1/workspaces/${workspaceId}/codex/usage`);
  }

  /** Live per-account usage read (refreshes THIS account's bearer; writes the cache). */
  async codexAccountUsage(workspaceId: string, accountId: string): Promise<CodexUsage> {
    return await this.requestJson<CodexUsage>(
      "GET",
      `/v1/workspaces/${workspaceId}/codex/accounts/${accountId}/usage`,
    );
  }

  /** Batched live refresh across every connected account, keyed by credential id. */
  async refreshCodexUsage(workspaceId: string): Promise<{ usage: CodexUsageMap }> {
    return await this.requestJson<{ usage: CodexUsageMap }>(
      "POST",
      `/v1/workspaces/${workspaceId}/codex/usage/refresh`,
    );
  }

  /** Disconnect ALL accounts (legacy workspace-wide). Prefer `disconnectCodexAccount`. */
  async codexDisconnect(workspaceId: string): Promise<{ disconnected: boolean }> {
    return await this.requestJson<{ disconnected: boolean }>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/codex`,
    );
  }

  /** List every connected Codex account + the workspace active pointer + settings. */
  async listCodexAccounts(workspaceId: string): Promise<CodexAccountsResponse> {
    return await this.requestJson<CodexAccountsResponse>(
      "GET",
      `/v1/workspaces/${workspaceId}/codex/accounts`,
    );
  }

  /** Switch the workspace ACTIVE Codex account (the one unpinned sessions use). */
  async activateCodexAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ activated: boolean; accountId: string }> {
    return await this.requestJson<{ activated: boolean; accountId: string }>(
      "POST",
      `/v1/workspaces/${workspaceId}/codex/accounts/${accountId}/activate`,
    );
  }

  /** P3: enable/disable Codex auto-rotation and/or pick the strategy. Returns the effective settings. */
  async setCodexRotationSettings(
    workspaceId: string,
    patch: {
      rotationEnabled?: boolean;
      rotationStrategy?: CodexRotationSettings["rotationStrategy"];
    },
  ): Promise<CodexRotationSettings> {
    return await this.requestJson<CodexRotationSettings>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/codex/settings`,
      patch,
    );
  }

  /** Disconnect ONE Codex account by id (re-picks active when the removed one was active). */
  async disconnectCodexAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<{ disconnected: boolean; newActiveId: string | null }> {
    return await this.requestJson<{ disconnected: boolean; newActiveId: string | null }>(
      "DELETE",
      `/v1/workspaces/${workspaceId}/codex/accounts/${accountId}`,
    );
  }

  /** Rename a Codex account (label only in P1). */
  async renameCodexAccount(
    workspaceId: string,
    accountId: string,
    label: string | null,
  ): Promise<CodexAccount> {
    return await this.requestJson<CodexAccount>(
      "PATCH",
      `/v1/workspaces/${workspaceId}/codex/accounts/${accountId}`,
      { label },
    );
  }

  /** Pin (or unpin via "auto") a session's Codex account. Applies on the next turn. */
  async pinSessionCodexAccount(
    workspaceId: string,
    sessionId: string,
    target: string,
  ): Promise<{ pinned: string }> {
    return await this.requestJson<{ pinned: string }>(
      "POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/codex-account`,
      { target },
    );
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.fetchImpl(this.url(path, query), {
      method,
      headers: {
        ...this.headers(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assertApiContractResponse(response);
    if (!response.ok) {
      throw new OpenGeniApiError(response.status, await safeText(response));
    }
    return (await response.json()) as T;
  }

  /** Like `requestJson` for endpoints that respond with no body (204). */
  private async requestVoid(method: string, path: string, body?: unknown): Promise<void> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        ...this.headers(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    assertApiContractResponse(response);
    if (!response.ok) {
      throw new OpenGeniApiError(response.status, await safeText(response));
    }
  }
}

function assertApiContractResponse(response: Response): void {
  const actual = response.headers.get(OPENGENI_API_CONTRACT_HEADER);
  if (actual && actual !== OPENGENI_API_CONTRACT_REVISION) {
    throw new OpenGeniApiContractMismatchError(OPENGENI_API_CONTRACT_REVISION, actual);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
