// Hand-written mirrors of the public wire shapes in `@opengeni/contracts`.
// The SDK keeps zero runtime dependencies so it stays framework-agnostic and
// publishable on its own; `test/contract-parity.test.ts` pins these types to
// the contracts package so drift fails the gate instead of shipping.

export type SessionStatus =
  | "queued"
  | "running"
  | "idle"
  | "requires_action"
  | "recovering"
  | "waiting_capacity"
  | "failed"
  | "cancelled";

// Mirror of `@opengeni/contracts` SandboxBackend (11 values; every member is
// additive at the end). 3-way enum parity is pinned by
// `test/contract-parity.test.ts`.
export type SandboxBackend =
  | "docker"
  | "modal"
  | "local"
  | "none"
  | "daytona"
  | "runloop"
  | "e2b"
  | "blaxel"
  | "cloudflare"
  | "vercel"
  | "selfhosted";

// Mirror of `@opengeni/contracts` SandboxOs. Only "linux" is reachable in v1.
export type SandboxOs = "linux" | "macos" | "windows";

// Mirror of `@opengeni/contracts` SandboxCapabilityName.
export type SandboxCapabilityName =
  | "FileSystem"
  | "Terminal"
  | "Git"
  | "DesktopStream"
  | "Recording";

// Mirror of `@opengeni/contracts` CapabilityUnavailableReason.
export type CapabilityUnavailableReason =
  | "backend_unsupported"
  | "os_unsupported"
  | "not_provisioned"
  | "disabled_by_policy"
  | "lease_cold"
  | "tier_headless"
  // selfhosted (bring-your-own-compute) negotiation states:
  | "agent_offline"
  | "agent_reconnecting"
  | "consent_required"
  | "display_unavailable";

// Mirror of `@opengeni/contracts` SessionCapabilities (the negotiated handshake
// document). The descriptor table itself is NOT mirrored — it lives in
// contracts (P0.1) and is consumed by the SDK config in a later PR.
export type SessionCapabilities = {
  sessionId: string;
  backend: SandboxBackend;
  os: SandboxOs;
  liveness: "cold" | "warming" | "warm" | "draining";
  leaseEpoch: number;
  viewerHeartbeatIntervalMs: number;
  FileSystem: {
    available: boolean;
    readOnly: boolean;
    root: string;
    pathSep: "/" | "\\";
    treeMode: "lazy" | "snapshot";
    reason: CapabilityUnavailableReason | null;
  };
  Terminal: {
    transport: "sse-events" | "pty-ws" | null;
    ptyCapable: boolean;
    shell: string;
    url: string | null;
    token: string | null;
    reason: CapabilityUnavailableReason | null;
  };
  Git: {
    available: boolean;
    repos: string[];
    reason: CapabilityUnavailableReason | null;
  };
  DesktopStream: {
    // "relay-frames" + "frames": the selfhosted framebuffer stream — PNG-per-frame
    // protobuf datagrams over the relay, painted by a canvas client (NOT RFB).
    transport: "vnc-ws" | "rdp-ws" | "webrtc" | "relay-frames" | null;
    client: "novnc" | "web-rdp" | "frames" | null;
    mode: "read-only" | "interactive";
    url: string | null;
    token: string | null;
    expiresAt: string | null;
    resolution: [number, number];
    unredacted: boolean;
    requiresAcknowledgment: boolean;
    acknowledged: boolean;
    // Shared-exposure disclosure (addendum E.1): `shared` when the group has >1
    // session; `sharedSessionIds` lists the OTHER sessions' ids ONLY (never their
    // conversation/metadata).
    shared: boolean;
    sharedSessionIds: string[];
    reason: CapabilityUnavailableReason | null;
  };
  Recording: {
    available: boolean;
    modes: ("manual" | "on-turn" | "on-verify")[];
    codecs: ("h264-mp4" | "vp9-webm")[];
    reason: CapabilityUnavailableReason | null;
  };
  ComputerUse: {
    available: boolean;
    readOnly: boolean;
    reason: CapabilityUnavailableReason | null;
  };
  negotiatedAt: string;
};

// Convenience aliases for the per-surface cells of `SessionCapabilities`, so the
// client hooks/components can take a single cell without restating the inline
// shape. These are exact structural views of the cells above.
export type FileSystemCapability = SessionCapabilities["FileSystem"];
export type TerminalCapability = SessionCapabilities["Terminal"];
export type GitCapability = SessionCapabilities["Git"];
export type DesktopStreamCapability = SessionCapabilities["DesktopStream"];
export type RecordingCapability = SessionCapabilities["Recording"];
export type ComputerUseCapability = SessionCapabilities["ComputerUse"];

// ── Stream-surfacing client surface (Phase 5) ───────────────────────────────
// Mirrors of the contracts viewer-attach / acknowledge / heartbeat shapes that
// the capability-gated client (`@opengeni/react`) drives. The desktop pixel
// plane rides Channel B (direct-to-provider noVNC); the structured terminal/
// files/git surfaces ride Channel A (the existing event spine + the synchronous
// fs/git/terminal point queries above). These are TYPES only (the SDK keeps zero
// runtime deps); the contract-parity test pins them.

// Mirror of `@opengeni/contracts` StreamUrlRotatedPayload — the Channel-A event
// the client folds in to hot-swap its noVNC socket on a box rollover, fenced on
// leaseEpoch.
export type StreamUrlRotatedPayload = {
  url: string;
  token: string | null;
  expiresAt: string | null;
  leaseEpoch: number;
  transport: "vnc-ws";
  viewerId: string | null;
};
export type StreamOpenedPayload = {
  viewerId: string;
  shared: boolean;
  viewerCount: number;
};
export type StreamClosedPayload = {
  viewerId: string;
  reason: "client-disconnect" | "reaped" | "revoked" | "box-rollover";
  viewerCount: number;
};
export type StreamRevokedPayload = {
  viewerId: string | null;
  reason: "grant-revoked" | "session-failed" | "admin";
};

// Mirror of `@opengeni/contracts` AttachViewerRequest. Omitting `viewerId` mints
// a fresh holder id (returned on the response, carried through heartbeat/detach).
// `desktop:true` opts into the un-redacted pixel plane (the consent-gated noVNC
// stream); a terminal/files-only warm attach omits it (defaults false) so it
// warms the box + mints the pty-ws terminal cell WITHOUT tripping the consent 409.
export type AttachViewerRequest = {
  viewerId?: string | undefined;
  desktop?: boolean | undefined;
};

// Mirror of `@opengeni/contracts` ViewerHolder + the P4.2 desktop-stream fields
// the POST /viewers handler folds in when the pixel plane is minted in-process.
export type ViewerHolder = {
  viewerId: string;
  sandboxGroupId: string;
  liveness: "cold" | "warming" | "warm" | "draining";
  leaseEpoch: number;
  viewerHeartbeatIntervalMs: number;
  dataPlaneUrl: string | null;
};
export type AttachViewerResponse = ViewerHolder & {
  // The scoped desktop-stream address minted for THIS holder (P4.2). Null when
  // the deployment is headless / desktop is disabled / the mint degraded —
  // the client then falls back to the Channel-A surfaces only.
  streamToken: string | null;
  streamExpiresAt: string | null;
  resolution: [number, number] | null;
  transport: "vnc-ws" | null;
  client: "novnc" | null;
  // The scoped ttyd PTY-over-websocket address minted for THIS holder — the REAL
  // interactive terminal, symmetric with the desktop pixel plane (same Modal
  // tunnel, same scoped stream token). Populated on a warm box; null when the
  // terminal mint degraded (headless / no secret / tunnel failure), in which case
  // the client falls back to the Channel-A read-only command-output firehose.
  // `terminalTransport` is "pty-ws" iff a live `terminalUrl` was minted.
  terminalUrl: string | null;
  terminalToken: string | null;
  terminalTransport: "pty-ws" | null;
};

// Mirror of `@opengeni/contracts` AcknowledgeStreamRequest/Response — the
// un-redacted-pixel + shared-exposure consent gate (P3.2).
export type AcknowledgeStreamRequest = {
  acknowledgeUnredacted?: boolean | undefined;
  acknowledgeShared?: boolean | undefined;
};
export type AcknowledgeStreamResponse = {
  acknowledged: boolean;
  acknowledgedShared: boolean;
};

// Mirror of `@opengeni/contracts` ViewerHeartbeatRequest/Response — the
// Channel-A viewer-liveness ping, epoch-fenced (a stale-epoch beat → alive:false
// → the client re-attaches).
export type ViewerHeartbeatRequest = { leaseEpoch: number };
export type ViewerHeartbeatResponse = { alive: boolean };

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type GitCredentialProvider = "github" | "gitlab" | "azure_devops";
export type GitCredentialBindingId = string;
export type GitRepositoryAccess = "read" | "write";

export type RepositoryResourceRef = {
  kind: "repository";
  uri: string;
  ref: string;
  /**
   * Optional workspace-relative override. When omitted, OpenGeni persists
   * `repos/<encoded-host>/<owner>/<repo>` so equal names on different Git
   * providers do not collide. Explicit paths are portable, traversal-free, and
   * collision-checked case-insensitively before sandbox execution.
   */
  mountPath?: string | undefined;
  subpath?: string | undefined;
  provider?: GitCredentialProvider | undefined;
  credentialBindingId?: GitCredentialBindingId | undefined;
  access?: GitRepositoryAccess | undefined;
  repositoryId?: number | string | undefined;
  installationId?: number | string | undefined;
  projectId?: number | string | undefined;
  connectionId?: string | undefined;
  githubInstallationId?: number | undefined;
  githubRepositoryId?: number | undefined;
};

export type FileResourceRef = {
  kind: "file";
  fileId: string;
  /** Optional workspace-relative override; defaults to `files/<file-id>`. */
  mountPath?: string | undefined;
};

export type ResourceRef = RepositoryResourceRef | FileResourceRef;

export type ToolRef = {
  kind: "mcp";
  id: string;
};

export type GoalSpec = {
  text: string;
  successCriteria?: string | undefined;
  maxAutoContinuations?: number | undefined;
};

export type SessionMcpServerInput = {
  id: string;
  name?: string | undefined;
  url: string;
  allowedTools?: string[] | undefined;
  timeoutMs?: number | undefined;
  cacheToolsList?: boolean | undefined;
  /** Require human approval for every tool, or only the listed unprefixed tool names. */
  requireApproval?: boolean | string[] | undefined;
  headers?: Record<string, string> | undefined;
  connectionRef?: McpServerConnectionRef | undefined;
};

export type SessionMcpCredentialUpdateInput = {
  id: string;
  headers: Record<string, string>;
};

export type SessionMcpServerMetadata = {
  id: string;
  name: string | null;
  url: string;
  headerNames: string[];
  credentialVersion: number;
  connectionRef: McpServerConnectionRef | null;
};

export type ConnectionKind = "oauth2" | "api_key" | "app_install" | "delegated";
export type ConnectionStatus = "active" | "needs_reauth" | "revoked" | "error";

export type McpServerConnectionRef = {
  connectionId?: string | undefined;
  provider?: string | undefined;
  providerDomain: string;
  kind?: ConnectionKind | undefined;
  scopes?: string[] | undefined;
  resource?: string | undefined;
  selectedResources?:
    | Array<{
        id: string;
        kind: "repository";
      }>
    | undefined;
  subjectScope?: "workspace" | "subject" | undefined;
};

export type ConnectionMetadata = {
  id: string;
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  providerDomain: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  grantedScopes: string[];
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastUsedAt: string | null;
  lastError: string | null;
  version: number;
  metadata: Record<string, unknown>;
  createdBySubjectId: string | null;
  updatedBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateConnectionRequest = {
  providerDomain: string;
  kind: ConnectionKind;
  subjectId?: string | null | undefined;
  credential: Record<string, unknown>;
  grantedScopes?: string[] | undefined;
  expiresAt?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type UpdateConnectionRequest = {
  providerDomain?: string | undefined;
  subjectId?: string | null | undefined;
  kind?: ConnectionKind | undefined;
  status?: ConnectionStatus | undefined;
  credential?: Record<string, unknown> | undefined;
  grantedScopes?: string[] | undefined;
  expiresAt?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ConnectionResponse = {
  connection: ConnectionMetadata;
};

export type ListConnectionsResponse = {
  connections: ConnectionMetadata[];
};

export type OAuthStartRequest = {
  providerDomain?: string | undefined;
  mcpUrl?: string | undefined;
  resource?: string | undefined;
  requestedScopes?: string[] | undefined;
  returnPath?: string | undefined;
  connectionId?: string | undefined;
  oauthClient?:
    | {
        clientId: string;
        clientSecret?: string | undefined;
        tokenEndpointAuthMethod?: "none" | "client_secret_post" | "client_secret_basic" | undefined;
      }
    | undefined;
};

export type OAuthStartResponse = {
  state: string;
  authorizationUrl: string | null;
  expiresAt: string;
};

/** The immutable principal whose authority accepted a session or turn. */
export type TurnInitiator = {
  kind: "subject" | "service";
  subjectId: string;
  /** Display-only snapshot; never an authorization input. */
  label?: string | undefined;
};

/** A trusted embedding host's causal machine/service principal. */
export type ServiceTurnInitiator = TurnInitiator & { kind: "service" };

/** Bounded host provenance; OpenGeni-owned lineage keys are reserved. */
export type ServiceTurnInitiatorContext = Record<string, unknown>;

export type IntegrationClientMetadata = {
  client_id: string;
  client_name: "OpenGeni";
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
  grant_types: Array<"authorization_code" | "refresh_token">;
  response_types: ["code"];
};

export type Session = {
  id: string;
  workspaceId: string;
  accountId: string;
  status: SessionStatus;
  initialMessage: string;
  title: string | null;
  titleSource: "user" | "agent" | null;
  // Per-session agent persona/system instructions supplied at create; null when
  // the session carried none. Org-visible metadata, never a timeline event.
  instructions: string | null;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  /** Frozen creator fact; later turns carry their own independent initiator. */
  createdBy: TurnInitiator;
  createdByContext: Record<string, unknown>;
  model: string;
  sandboxBackend: SandboxBackend;
  sandboxOs: SandboxOs;
  sandboxGroupId: string;
  activeSandboxId: string | null;
  activeEpoch: number;
  variableSetId: string | null;
  /** @deprecated use variableSetId */
  environmentId: string | null;
  // The rig + frozen rig version this session rides (M3). Both null for a
  // rig-less session. Frozen at create; a later rig promote never moves them.
  rigId: string | null;
  rigVersionId: string | null;
  firstPartyMcpPermissions: string[] | null;
  mcpServers: SessionMcpServerMetadata[];
  parentSessionId: string | null;
  createIdempotencyKey: string | null;
  temporalWorkflowId: string | null;
  activeTurnId: string | null;
  queueVersion: number;
  queueHeadPosition: number;
  queueTailPosition: number;
  effectiveControl: EffectiveSessionControl;
  lastSequence: number;
  /** Multi-account Codex (P1): the account this session is pinned to (null ⇒ follow workspace active). */
  codexPinnedCredentialId?: string | null;
  /** Multi-account Codex (P1): the account the most recent turn ran on (the "Running on:" indicator). */
  codexLastCredentialId?: string | null;
  /** Personal (authenticated subject) workspace pin state, never workspace-global. */
  pinned?: boolean;
  /** Stable pin ordering key; null when this subject has not pinned the session. */
  pinnedAt?: string | null;
  /** Optimistic pin-state revision; zero represents an absent pin relation. */
  pinVersion?: number;
  /** Server-authoritative descendant counts populated by session-list reads. */
  treeStats?:
    | {
        directChildren: number;
        totalDescendants: number;
        runningDescendants: number;
        queuedDescendants: number;
        attentionDescendants: number;
        pausedDescendants: number;
        failedDescendants: number;
        /** Counts are lower bounds rather than exact totals when true. */
        truncated: boolean;
      }
    | undefined;
  createdAt: string;
  updatedAt: string;
};

/** Additive receipt returned by POST /sessions. */
export type CreateSessionResponse = Session & {
  initialTurnId: string | null;
};

export type SessionSummary = Session;

/** Canonical session-list page; pinned rows are excluded from ordinary pages. */
export type SessionListResponse = {
  pinned: Session[];
  /** True when the server omitted older pins from its bounded pinned section. */
  pinnedTruncated?: boolean;
  sessions: Session[];
  nextCursor: string | null;
};

export type UpdateSessionPinRequest = {
  pinned: boolean;
  expectedVersion?: number;
};

export type LineageNode = {
  session: SessionSummary;
  children: LineageNode[];
};

export type SessionLineageResponse = {
  ancestors: SessionSummary[];
  children: LineageNode[];
  truncated: boolean;
};

export type SessionTurnStatus =
  | "queued"
  | "running"
  | "requires_action"
  | "recovering"
  | "waiting_capacity"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "withdrawn_for_edit";

export type SessionTurnSource =
  | "user"
  | "scheduled_task"
  | "api"
  | "goal"
  | "system"
  | "compaction";

export type SessionTurn = {
  id: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  status: SessionTurnStatus;
  source: SessionTurnSource;
  position: number;
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  sandboxOs: SandboxOs | null;
  metadata: Record<string, unknown>;
  version: number;
  executionGeneration: number;
  activeAttemptId: string | null;
  lineage: Record<string, unknown>;
  initiator: TurnInitiator;
  initiatorContext: Record<string, unknown>;
  cancelledBy?: string | null;
  cancelReason?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type HumanInputQuestionKind = "text" | "single_select" | "multi_select";

export type HumanInputOption = {
  id: string;
  label: string;
  description?: string | null | undefined;
};

export type HumanInputQuestion = {
  id: string;
  kind: HumanInputQuestionKind;
  prompt: string;
  label?: string | null | undefined;
  helpText?: string | null | undefined;
  options: HumanInputOption[];
  required: boolean;
  allowOther: boolean;
  validation?:
    | {
        minLength?: number | null | undefined;
        maxLength?: number | null | undefined;
        minSelections?: number | null | undefined;
        maxSelections?: number | null | undefined;
      }
    | null
    | undefined;
};

export type HumanInputAnswer = {
  questionId: string;
  values: string[];
  other?: string | null | undefined;
};

export type HumanInputResponse =
  | { outcome: "answered"; answers: HumanInputAnswer[] }
  | { outcome: "skipped" | "expired" | "cancelled" };

export type SubmitHumanInputResponseRequest =
  | { outcome: "answered"; answers: HumanInputAnswer[] }
  | { outcome: "skipped" };

export type SessionHumanInputRequest = {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnGeneration: number;
  creationAttemptId: string;
  toolCallId: string;
  status: "pending" | "answered" | "skipped" | "expired" | "cancelled";
  questions: HumanInputQuestion[];
  allowSkip: boolean;
  response: HumanInputResponse | null;
  respondedBy: string | null;
  respondedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export const SESSION_EVENT_TYPES = [
  "session.created",
  // Defensive bounded projection for malformed/legacy oversized envelopes.
  "session.event.envelope_omitted",
  "session.status.changed",
  "session.requiresAction",
  "session.humanInput.requested",
  "session.context.compaction.requested",
  "session.context.compacted",
  "session.context.compaction.skipped",
  "session.context.cleared",
  "user.message",
  "user.pause",
  "user.approvalDecision",
  "user.humanInputResponse",
  "turn.queued",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
  "turn.recovery.requested",
  "turn.capacity_waiting",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.model.usage",
  "tool.auth_needed",
  "credential.auth_needed",
  "agent.updated",
  "rig.setup.started",
  "rig.setup.completed",
  "rig.setup.skipped",
  "rig.setup.failed",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "sandbox.command.output.delta",
  "artifact.created",
  "goal.set",
  "goal.updated",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.cleared",
  "goal.continuation",
  "system.update.pending",
  "system.update.delivered",
  "session.control.paused",
  "session.control.resumed",
  "session.control.steer_requested",
  "workspace.inference.paused",
  "workspace.inference.resumed",
  "session.queue.changed",
  "session.queue.prompt.cancelled",
  "session.queue.history",
  "turn.event.rejected_late",
  "memory.saved",
  "memory.corrected",
  // Channel-B desktop pixel-plane signals (mirror of contracts SessionEventType;
  // the contract-parity test asserts sorted equality).
  "stream.url.rotated",
  "stream.opened",
  "stream.closed",
  "stream.revoked",
  // Channel-B recording signals (P4.3 — "agent films itself proving the fix").
  "recording.started",
  "recording.available",
  "recording.failed",
  // Channel-A structured-service notifications (P4.4; mirror of contracts
  // SessionEventType — the contract-parity test asserts sorted equality).
  "fs.changed",
  "git.changed",
  "terminal.pty.started",
  "terminal.pty.output.delta",
  "terminal.pty.exited",
  "session.title_set",
  // Multi-account Codex (P1): the session's inference account changed.
  "codex.account.switched",
  // credential allocator metadata-only per-turn credential selection audit.
  "codex.credential.selected",
  // credential allocator durable zero-capacity wait lifecycle. These are system/runtime
  // events, never synthetic user messages.
  "codex.capacity.waiting",
  "codex.capacity.resumed",
  "codex.capacity.superseded",
  // Sandbox durability observability (mirror of contracts SessionEventType):
  // box lifecycle + manifest-env drift, attributable from the DB alone.
  "sandbox.box.created",
  "sandbox.box.lost",
  "sandbox.box.terminated",
  "sandbox.box.snapshot",
  "sandbox.env.drift",
  // Active-sandbox pointer reconcile (issue #341; announce-only; mirror of contracts
  // SessionEventType — the contract-parity test asserts sorted equality).
  "session.route.reconciled",
  // Workbench v2 turn-end workspace capture (announce-only; mirror of contracts
  // SessionEventType — the contract-parity test asserts sorted equality).
  "workspace.revision.captured",
  "workspace.revision.degraded",
  // Connected Machine op-outcome observability (announce-only, quiet; mirror of
  // contracts SessionEventType — the contract-parity test asserts sorted equality).
  "machine.op.failed",
  "machine.op.recovered",
  // Connected Machine link-plane observability (announce-only, quiet; mirror of
  // contracts SessionEventType — the contract-parity test asserts sorted equality).
  "machine.link.lost",
  "machine.link.restored",
  "machine.runner.restarted",
] as const;

export type KnownSessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * Event types the SDK knows about today, kept open so a newer OpenGeni server
 * can introduce event types without breaking older SDK consumers.
 */
export type SessionEventType = KnownSessionEventType | (string & {});

export type SessionEvent = {
  id: string;
  workspaceId: string;
  sessionId: string;
  /** Per-session sequence number: positive, contiguous, strictly increasing. */
  sequence: number;
  type: SessionEventType;
  payload: unknown;
  occurredAt: string;
  clientEventId?: string | null | undefined;
  turnId?: string | null | undefined;
  turnGeneration?: number | null | undefined;
  turnAttemptId?: string | null | undefined;
  turnAssociation?: "current" | "late_rejected" | "duplicate" | null | undefined;
  duplicateOfEventId?: string | null | undefined;
  duplicateReason?: string | null | undefined;
};

export type SessionEventSemanticClass =
  | "control"
  | "terminal"
  | "failure"
  | "checkpoint"
  | "tool_receipt"
  | "provider_account";
export type SessionEventPayloadMode = "none" | "summary" | "full";
export type SessionEventReadMode = "monitoring" | "forensic";
export type SessionEventReadDirection = "after" | "before";

type SessionEventListCommonOptions = {
  after?: number;
  before?: number;
  limit?: number;
  compact?: boolean;
  mode?: SessionEventReadMode;
  direction?: SessionEventReadDirection;
  payloadMode?: SessionEventPayloadMode;
};

export type SessionEventListOptions = SessionEventListCommonOptions &
  (
    | {
        latest?: never;
        includeTypes?: SessionEventType[];
        excludeTypes?: SessionEventType[];
        includeClasses?: SessionEventSemanticClass[];
        excludeClasses?: SessionEventSemanticClass[];
      }
    | {
        /** Exclusive lookup for the newest event in exactly this semantic class. */
        latest: SessionEventSemanticClass;
        includeTypes?: never;
        excludeTypes?: never;
        includeClasses?: never;
        excludeClasses?: never;
      }
  );

export type SessionEventPage = {
  events: SessionEvent[];
  mode: SessionEventReadMode;
  payloadMode: SessionEventPayloadMode;
  direction: SessionEventReadDirection;
  bytes: number;
  maxBytes: number;
  truncated: boolean;
  hasMore: boolean;
  truncatedBy: "count" | "bytes" | "http_bytes" | null;
  coveredSequence: { first: number; last: number } | null;
  nextAfter: number | null;
  nextBefore: number | null;
  forensicExact: boolean;
};

export type ToolAuthNeededPayload = {
  serverId: string;
  toolName?: string | null | undefined;
  providerDomain: string;
  provider?: string | undefined;
  connectionId?: string | null | undefined;
  reason:
    | "missing_connection"
    | "expired"
    | "insufficient_scope"
    | "refresh_failed"
    | "unsupported_auth"
    | "resource_scope_unavailable";
  scopes?: string[] | undefined;
  resource?: string | undefined;
  selectedResources?: Array<{ id: string; kind: "repository" }> | undefined;
  authorizationUrl?: string | undefined;
  subjectId?: string | null | undefined;
};

// Payload shapes for the high-traffic event types. `SessionEvent.payload` is
// `unknown` on the wire; these are the documented shapes producers emit today.
export type AgentTextDeltaPayload = { text: string };
export type AgentMessageCompletedPayload = { text: string };
export type AgentToolCallCreatedPayload = {
  id: string | null;
  name: string;
  arguments: unknown;
  raw?: unknown | undefined;
};
export type AgentToolCallOutputPayload = { id: string | null; output: unknown };
export type SessionStatusChangedPayload = { status: SessionStatus };

// Recording payloads (P4.3 — plain TS mirror of the contracts Zod schemas; the
// SDK is zero-runtime-dep so these are TYPES, not Zod, F15). The contract-parity
// test asserts the event-type literals; these shapes document the wire payloads.
export type RecordingMode = "manual" | "on-turn" | "on-verify";
export type RecordingCodec = "h264-mp4" | "vp9-webm";
export type RecordingContentType = "video/mp4" | "video/webm";
export type RecordingFailedReason =
  | "ffmpeg-error"
  | "box-death"
  | "box-rollover"
  | "upload-failed"
  | "max-bytes-exceeded"
  | "display-unavailable";

export type RecordingStartedPayload = {
  recordingId: string;
  turnId: string | null;
  mode: RecordingMode;
  codec: RecordingCodec;
  dimensions: [number, number];
  framerate: number;
  startedAt: string;
  reason?: string | null | undefined;
};
export type RecordingAvailablePayload = {
  recordingId: string;
  turnId: string | null;
  codec: RecordingCodec;
  contentType: RecordingContentType;
  storageKey: string;
  durationSeconds: number | null;
  sizeBytes: number;
  dimensions: [number, number];
};
export type RecordingFailedPayload = {
  recordingId: string;
  turnId: string | null;
  reason: RecordingFailedReason;
  detail?: string | null | undefined;
};

// ── Channel-A structured services (P4.4) — hand-written wire mirrors ─────────

// A1 notification payloads.
export type SandboxCommandOutputDeltaPayload = {
  stream: "stdout" | "stderr";
  chunk: string;
  commandId?: string | undefined;
  seq?: number | undefined;
};
export type FsChangeKind = "created" | "modified" | "deleted" | "renamed";
export type FsChangedPayload = {
  changes: {
    path: string;
    kind: FsChangeKind;
    isDir: boolean;
    sizeBytes: number | null;
    oldPath?: string | undefined;
  }[];
  source: "write" | "watch" | "agent";
  revision: number;
  leaseEpoch: number;
};
export type GitChangedPayload = {
  head: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  changedFileCount: number;
  reason: "commit" | "checkout" | "stage" | "worktree" | "fetch" | "unknown";
  revision: number;
  leaseEpoch: number;
};
export type TerminalPtyStartedPayload = {
  ptyId: string;
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
};
export type TerminalPtyOutputDeltaPayload = {
  ptyId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  seq: number;
};
export type TerminalPtyExitedPayload = {
  ptyId: string;
  exitCode: number | null;
  reason: "exit" | "killed" | "owner_gone" | "timeout";
};

// A2 FileSystem request/response.
export type FsNodeType = "file" | "dir" | "symlink" | "other";
export type FsTreeNode = {
  name: string;
  path: string;
  type: FsNodeType;
  sizeBytes: number | null;
  mtimeMs: number | null;
  mode: number | null;
  children?: FsTreeNode[] | undefined;
  truncated: boolean;
};
export type FsEncoding = "utf8" | "base64";
export type FsListRequest = {
  path?: string;
  depth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
};
export type FsListResponse = {
  root: FsTreeNode;
  revision: number;
  truncated: boolean;
};
export type FsReadRequest = {
  path: string;
  encoding?: FsEncoding;
  maxBytes?: number;
};
export type FsReadResponse = {
  path: string;
  encoding: FsEncoding;
  content: string;
  sizeBytes: number;
  truncated: boolean;
  isBinary: boolean;
  revision: number;
};
export type FsWriteRequest = {
  path: string;
  encoding?: FsEncoding;
  content: string;
  overwrite?: boolean;
  createParents?: boolean;
};
export type FsWriteResponse = {
  path: string;
  sizeBytes: number;
  revision: number;
};
export type FsDeleteRequest = { path: string; recursive?: boolean };
export type FsDeleteResponse = { revision: number };
export type FsMoveRequest = {
  path: string;
  newPath: string;
  overwrite?: boolean;
  createParents?: boolean;
};
export type FsMoveResponse = {
  path: string;
  newPath: string;
  revision: number;
};
export type FsMkdirRequest = { path: string; recursive?: boolean };
export type FsMkdirResponse = { path: string; revision: number };

// A2 Git request/response (the Pierre-diff feed).
export type GitFileStatusCode =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "typechange";
export type GitFileStatus = {
  path: string;
  oldPath: string | null;
  index: GitFileStatusCode | null;
  worktree: GitFileStatusCode | null;
  isConflicted: boolean;
};
export type GitStatusRequest = { path?: string };
export type GitStatusResponse = {
  isRepo: boolean;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  revision: number;
};
export type GitDiffLineType = "context" | "add" | "del" | "meta";
export type GitDiffLine = {
  type: GitDiffLineType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
};
export type GitDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: GitDiffLine[];
};
export type GitFileDiff = {
  path: string;
  oldPath: string | null;
  status: GitFileStatusCode;
  isBinary: boolean;
  isImage: boolean;
  additions: number;
  deletions: number;
  hunks: GitDiffHunk[];
  truncated: boolean;
};
export type GitDiffRequest = {
  path?: string;
  staged?: boolean;
  includeUntracked?: boolean;
  fromRef?: string;
  toRef?: string;
  pathspec?: string[];
  contextLines?: number;
  maxBytesPerFile?: number;
};
export type GitDiffResponse = { files: GitFileDiff[]; revision: number };
export type GitLogRequest = {
  path?: string;
  ref?: string;
  maxCount?: number;
  skip?: number;
  pathspec?: string[];
};
export type GitCommit = {
  sha: string;
  shortSha: string;
  parents: string[];
  author: { name: string; email: string; timestamp: number };
  committer: { name: string; email: string; timestamp: number };
  subject: string;
  body: string;
  refs: string[];
};
export type GitLogResponse = { commits: GitCommit[]; hasMore: boolean };
export type GitShowRequest = {
  path?: string;
  ref: string;
  filePath?: string;
  encoding?: FsEncoding;
  maxBytesPerFile?: number;
};
export type GitShowResponse = {
  commit: GitCommit | null;
  files: GitFileDiff[];
  blob: {
    content: string;
    encoding: FsEncoding;
    sizeBytes: number;
    truncated: boolean;
  } | null;
  revision: number;
};

// Workbench v2 turn-end capture (mirror of `@opengeni/contracts` WorkspaceCapture*
// + the M2 read-API response shapes). Reuses FsTreeNode /
// GitFileStatus / GitFileDiff / GitFileStatusCode / FsEncoding above.
export type WorkspaceCaptureFile = {
  path: string;
  status: GitFileStatusCode;
  hash: string | null;
  baseHash: string | null;
  contentRef: string | null;
  sizeBytes: number;
  isBinary: boolean;
  tooLarge: boolean;
  deleted: boolean;
};
export type WorkspaceCaptureRepo = {
  root: string;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  status: GitFileStatus[];
  diff: GitFileDiff[];
};
export type WorkspaceCaptureDegradedReason =
  | "repository_discovery_command_failed"
  | "repository_discovery_timed_out"
  | "repository_discovery_result_limit_exceeded";
export type WorkspaceCaptureStats = {
  repoCount: number;
  fileCount: number;
  additions: number;
  deletions: number;
  totalBytes: number;
  tooLargeCount: number;
  binaryCount: number;
  treeEntryCount: number;
  treeTruncated: boolean;
  durationMs: number;
  fingerprint?: string;
};
export type WorkspaceCaptureManifest = {
  version: 1;
  revision: number;
  capturedAt: string;
  turnId: string | null;
  leaseEpoch: number;
  treeIndex: FsTreeNode;
  treeTruncated: boolean;
  repos: WorkspaceCaptureRepo[];
  files: WorkspaceCaptureFile[];
  stats: WorkspaceCaptureStats;
};
export type WorkspaceRevisionCapturedPayload = {
  revision: number;
  turnId: string | null;
  capturedAt: string;
  leaseEpoch: number;
  stats: WorkspaceCaptureStats;
};
export type WorkspaceRevisionDegradedPayload = {
  revision: number;
  turnId: string | null;
  capturedAt: string;
  leaseEpoch: number;
  reason: WorkspaceCaptureDegradedReason;
};
export type WorkspaceCaptureSignedUrl = { url: string; expiresAt: string };
// GET …/workspace/capture. Exactly one of manifest/manifestUrl is non-null.
export type GetWorkspaceCaptureResponse =
  | {
      available: false;
      degradedReason?: WorkspaceCaptureDegradedReason | null;
      revision?: number | null;
      capturedAt?: string | null;
      turnId?: string | null;
      leaseEpoch?: number | null;
    }
  | {
      available: true;
      revision: number;
      capturedAt: string;
      turnId: string | null;
      leaseEpoch: number;
      sizeBytes: number;
      stats: WorkspaceCaptureStats;
      manifest: WorkspaceCaptureManifest | null;
      manifestUrl: WorkspaceCaptureSignedUrl | null;
    };
// GET …/workspace/capture/file. content inline (≤256KB) OR contentUrl OR marker
// only (tooLarge / missing blob).
export type GetWorkspaceCaptureFileResponse = {
  path: string;
  revision: number;
  status: GitFileStatusCode;
  hash: string | null;
  baseHash: string | null;
  sizeBytes: number;
  isBinary: boolean;
  tooLarge: boolean;
  encoding: FsEncoding | null;
  content: string | null;
  contentUrl: WorkspaceCaptureSignedUrl | null;
};

// A2 Terminal exec + PTY.
export type TerminalExecRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  emitStream?: boolean;
};
export type TerminalExecResponse = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  running: boolean;
  wallTimeSeconds: number;
};
export type PtyOpenRequest = {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
};
export type PtyOpenResponse = {
  ptyId: string;
  streamVia: "sse-events";
  supportsInput: boolean;
};
export type PtyWriteRequest = { ptyId: string; data: string };
export type PtyResizeRequest = { ptyId: string; cols: number; rows: number };
export type PtyCloseRequest = { ptyId: string };

export type SessionStructuredCapabilities = {
  FileSystem: { available: boolean; readOnly: boolean; root: string };
  Terminal: { events: boolean; exec: boolean; pty: { available: boolean } };
  Git: { available: boolean; repos: string[] };
};

export type ScheduledTaskStatus = "active" | "paused";

export type ScheduledTaskRunMode = "new_session_per_run" | "reusable_session";

export type ScheduledTaskOverlapPolicy = "allow_concurrent" | "skip" | "buffer_one";

export type ScheduledTaskDayOfWeek =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export type ScheduledTaskScheduleSpec =
  | { type: "once"; runAt: string; timeZone: string }
  | {
      type: "interval";
      everySeconds: number;
      startAt?: string | undefined;
      endAt?: string | undefined;
    }
  | {
      type: "calendar";
      timeZone: string;
      hour: number;
      minute: number;
      daysOfWeek?: ScheduledTaskDayOfWeek[] | undefined;
    };

export type ScheduledTaskAgentConfig = {
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  metadata: Record<string, unknown>;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
};

export type ScheduledTask = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  variableSetId: string | null;
  /** @deprecated use variableSetId */
  environmentId: string | null;
  // The rig each run binds to (M3); active version resolved per fire. Null ⇒ rig-less.
  rigId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateSessionRequest = {
  // Optional UUID preallocated by an embedding host so it can durably link its
  // projection before OpenGeni admits the initial turn. Replays must retain the
  // same UUID and idempotency key.
  requestedSessionId?: string | undefined;
  initialMessage: string;
  // Per-session agent persona/system instructions (org-visible metadata, not a
  // secret). Delivered system-level, composed AFTER the per-workspace persona —
  // how a host supplies per-agent-type prompts without leaking them into the
  // user-visible timeline. Trimmed, non-empty, max 32768 chars.
  instructions?: string | undefined;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  // The enrolled machine (a sandbox id) to run this session on; seeds the
  // active-sandbox pointer at creation so the first turn lands on it.
  targetSandboxId?: string | undefined;
  // Host working directory for a connected-machine target (the agent runs here;
  // default = the machine's launch dir). Ignored for managed sandboxes.
  workingDir?: string | undefined;
  variableSetId?: string | undefined;
  /** @deprecated use variableSetId */
  environmentId?: string | undefined;
  // The rig to bind this session to (M3). Its active version is frozen onto the
  // session at create. Omitted ⇒ the workspace default rig when set, else rig-less.
  rigId?: string | undefined;
  goal?: GoalSpec | undefined;
  clientEventId?: string | undefined;
  // Workspace-scoped CREATE idempotency key: forward a STABLE value to make a
  // double-submit/retry of the same logical create collapse to one session.
  // Distinct from the per-call clientEventId.
  idempotencyKey?: string | undefined;
  firstPartyMcpPermissions?: string[] | undefined;
  mcpServers?: SessionMcpServerInput[] | undefined;
  // Shared-sandbox placement (mirror of `@opengeni/contracts` CreateSessionRequest.sandbox,
  // addendum 05 §D.1). Three-way union; OMITTED ⇒ the context-dependent server default
  // (from inside a session → "shared" with the creator's box, top-level → "new").
  //   - "shared":  join the CREATOR's box (requires a parent session; top-level → 422).
  //   - "new":     mint a fresh singleton box (group ≡ the new session's id).
  //   - {groupId}: join a SPECIFIC sibling group in THIS workspace (manager fan-out).
  sandbox?: "shared" | "new" | { groupId: string } | undefined;
};

// --- Access, workspaces, API keys -------------------------------------------

export const KNOWN_PERMISSIONS = [
  "account:read",
  "account:admin",
  "members:manage",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "workspace:read",
  "workspace:admin",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  // sandbox workspace (mirror of @opengeni/contracts Permission). stream:view is
  // strictly broader than sessions:read (un-redacted pixels); stream:control is
  // the never-granted-v1 raw-input plane; stream:acknowledge is the secret-leak
  // consent gate.
  "stream:view",
  "stream:control",
  "stream:acknowledge",
  "files:upload",
  "files:read",
  "files:write",
  "terminal:attach",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "connections:read",
  "connections:write",
  "environments:manage",
  "environments:use",
  "variable-sets:manage",
  "variable-sets:use",
  "mcp_servers:attach",
  "toolspace:call",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
  "rigs:use",
  "rigs:manage",
] as const;

export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

/**
 * Permissions the SDK knows about today, kept open so a newer OpenGeni server
 * can introduce permissions without breaking older SDK consumers.
 */
export type Permission = KnownPermission | (string & {});

export type ProductAccessMode = "local" | "configured" | "managed";

/**
 * One model a client may select at send time, plus the provider that serves it.
 * The wire API (`responses` | `chat`) lets a client reason about provider
 * capabilities; the provider id/label drive a picker's grouping. Mirrors the
 * `ClientModel` shape projected into `ClientConfig` by the server.
 */
export type ClientModel = {
  id: string;
  label: string;
  /** Provider id (e.g. `openai`, `azure`, or a registry provider id). */
  provider: string;
  providerLabel: string;
  api: "responses" | "chat";
  contextWindowTokens?: number | undefined;
};

/**
 * Connection state of a workspace's Codex (ChatGPT) subscription, returned by
 * `GET /v1/workspaces/:id/codex/status`. `models` are the codex models the
 * workspace can select (projected as ClientModel under their own "no credits"
 * provider group), present only while connected.
 */
export type CodexConnectionStatus = {
  connected: boolean;
  plan?: string | null;
  valid?: boolean;
  expiresAt?: string | null;
  lastError?: string | null;
  models?: ClientModel[];
  /** The account a session runs on when unpinned (label for the in-session indicator). */
  activeAccount?: {
    id: string;
    label?: string | null;
    chatgptAccountId?: string | null;
  } | null;
  /** How many Codex accounts the workspace has connected. */
  accountCount?: number;
};

/**
 * One normalized Codex usage window (5h or weekly), camelCase end-to-end (the
 * route normalizes server-side; the web layer never re-hand-types snake_case).
 * `percent` is authoritative; used/limit/remaining are a synthesized 0–100 scale
 * (limit = 100) because the provider gives only a percentage. `remaining =
 * 100 - percent` is the P3 rotation key. Identify the window by `limitWindowSeconds`
 * (18000 ⇒ 5h, 604800 ⇒ weekly), never by position.
 */
export type CodexUsageWindow = {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  resetAt: string | null;
  resetAfterSeconds: number | null;
  limitWindowSeconds: number;
};

/** The normalized usage payload for one account — the P2/P3 contract. */
export type CodexUsagePayload = {
  status: "ok" | "limit_reached" | "error" | "no-data";
  planType: string | null;
  fiveHour: CodexUsageWindow | null;
  weekly: CodexUsageWindow | null;
  limitReached: boolean;
  fetchedAt: string;
  /** Present only on an auth/refresh failure path. */
  reason?: "needs_relogin";
  additionalLimits?: Array<{
    limitName: string;
    meteredFeature: string;
    fiveHour: CodexUsageWindow | null;
    weekly: CodexUsageWindow | null;
  }>;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    overageLimitReached: boolean;
    balance: string;
  };
};

/** One connected Codex (ChatGPT) account in a workspace (multi-account P1). Metadata only. */
export type CodexAccount = {
  id: string;
  chatgptAccountId?: string | null;
  label?: string | null;
  email?: string | null;
  plan?: string | null;
  status: "active" | "needs_relogin" | "error";
  active: boolean;
  expiresAt?: string | null;
  lastRefreshAt?: string | null;
  lastError?: string | null;
  // P2 CACHED usage (built from the persisted columns; renders bars off
  // listCodexAccounts with no second call). null until the first live refresh.
  fiveHour?: CodexUsageWindow | null;
  weekly?: CodexUsageWindow | null;
  usageCheckedAt?: string | null;
  // P3 rotation cooldown: ISO timestamp until which this account is cooling-down
  // (rotated-off after a usage cap). null/absent ⇒ not cooling.
  exhaustedUntil?: string | null;
};

/** Per-workspace Codex rotation/active settings. P1: rotation inert, only activeCredentialId loads. */
export type CodexRotationSettings = {
  rotationEnabled: boolean;
  rotationStrategy: "most_remaining" | "round_robin" | "drain_then_next";
  activeCredentialId: string | null;
};

/** GET /codex/accounts — the accounts list + the workspace active pointer + settings. */
export type CodexAccountsResponse = {
  accounts: CodexAccount[];
  activeAccountId: string | null;
  settings: CodexRotationSettings;
};

/** Payload of a `codex.account.switched` session event. */
export type CodexAccountSwitchedPayload = {
  fromAccountId: string | null;
  toAccountId: string;
  reason: "manual" | "exhausted" | "rotation";
  // P4 connector-aware rotation: the session's used connectors that the new account
  // does NOT cover (a prefer-not-require failover that dropped a connector). Present
  // only on such a switch; the UI renders a "dropped <connector>" badge on the pill.
  droppedConnectors?: string[];
};

/** Device-code start: show `userCode` at `verificationUri`, then poll with `state`. */
export type CodexConnectStart = {
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  state: string;
};

/** Poll result: keep polling on `pending`, restart on `expired`, done on `connected`. */
export type CodexConnectPoll =
  | { status: "pending" }
  | { status: "expired" }
  | {
      status: "connected";
      plan?: string | null;
      accountId?: string;
      isActive?: boolean;
    };

/** Remaining usage/limits for one account. `usage` is the normalized P2 payload. */
export type CodexUsage = {
  status: "ok" | "limit_reached" | "error" | "no-data";
  usage: CodexUsagePayload | null;
};

/** Batched live-refresh response, keyed by credential id; each entry independently statused. */
export type CodexUsageMap = Record<string, CodexUsage>;

/**
 * How a deployment expects clients to authenticate to it, surfaced so a UI can
 * wire up the right header/cookie without prior knowledge of the host setup.
 * Discriminated on `mode`; `none` is the back-compat default.
 */
export type ClientAuthConfig =
  | { mode: "none" }
  | { mode: "deploymentKey"; headerName: "x-opengeni-access-key" }
  | { mode: "configuredToken"; headerName: "authorization"; scheme: "bearer" }
  | { mode: "managedSession"; session: "cookie" };

// Kept value-identical to @opengeni/contracts and pinned by the SDK contract
// parity suite. The SDK has no runtime dependency on the Zod contracts package.
export const OPENGENI_API_CONTRACT_REVISION = "2026-07-human-input-v1" as const;
export const OPENGENI_API_CONTRACT_HEADER = "x-opengeni-api-contract" as const;

/**
 * Public, unauthenticated-by-default client bootstrap config returned by
 * `GET /v1/config/client`: which models + reasoning efforts are exposed, the
 * MCP servers and file-upload limits a composer should offer, and how the
 * deployment expects the client to authenticate. `allowedModels` is kept for
 * back-compat; `models` carries the richer provider-grouped list for a picker.
 */
export type ClientConfig = {
  deploymentRevision: string;
  apiContractRevision: typeof OPENGENI_API_CONTRACT_REVISION;
  serverVersion?: string | undefined;
  defaultModel: string;
  allowedModels: string[];
  models: ClientModel[];
  defaultReasoningEffort: ReasoningEffort;
  allowedReasoningEfforts: ReasoningEffort[];
  mcpServers: { id: string; name: string }[];
  fileUploads: { enabled: boolean; maxSizeBytes: number };
  productAccessMode: ProductAccessMode;
  auth: ClientAuthConfig;
  // Server-wide hint: does this deployment support Channel-A structured services
  // at all (P4.4). Per-session availability is negotiated on /stream-capabilities;
  // this is the coarse on/off the client uses to decide whether to even attempt
  // the fs/git/terminal panels.
  structuredServices: {
    fileSystem: boolean;
    git: boolean;
    terminalEvents: boolean;
  };
};

export type AccountRole = "owner" | "admin" | "member";

export type AccountGrant = {
  accountId: string;
  subjectId: string;
  subjectLabel?: string | undefined;
  role?: AccountRole | undefined;
  permissions: Permission[];
  metadata?: Record<string, unknown> | undefined;
};

export type AccessGrant = {
  workspaceId: string;
  accountId: string;
  subjectId: string;
  subjectLabel?: string | undefined;
  permissions: Permission[];
  metadata?: Record<string, unknown> | undefined;
  serviceInitiator?: ServiceTurnInitiator | undefined;
  serviceInitiatorContext?: ServiceTurnInitiatorContext | undefined;
};

export type AccessContext = {
  mode: ProductAccessMode;
  subjectId: string;
  subjectLabel?: string | undefined;
  accountGrants: AccountGrant[];
  workspaceGrants: AccessGrant[];
  defaultAccountId: string | null;
  defaultWorkspaceId: string | null;
};

export type Workspace = {
  id: string;
  accountId: string;
  name: string;
  slug: string | null;
  externalSource: string | null;
  externalId: string | null;
  agentInstructions: string | null;
  settings: Record<string, unknown>;
  inferenceControl: {
    state: "active" | "paused";
    revision: number;
    reason: string | null;
    changedBy: string | null;
    changedAt: string | null;
  };
  defaultRigId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSettings = {
  memoryEnabled?: boolean | undefined;
  [key: string]: unknown;
};

export type UpdateWorkspaceSettingsRequest = {
  memoryEnabled?: boolean | undefined;
  [key: string]: unknown;
};

export type SetWorkspaceDefaultRigRequest = {
  rigId: string | null;
};

export type CreateWorkspaceRequest = {
  accountId?: string | undefined;
  name: string;
  slug?: string | undefined;
  externalSource?: string | undefined;
  externalId?: string | undefined;
  agentInstructions?: string | null | undefined;
};

export type UpdateWorkspaceRequest = {
  name?: string | undefined;
  slug?: string | null | undefined;
  agentInstructions?: string | null | undefined;
};

export type ApiKey = {
  id: string;
  accountId: string;
  workspaceId: string | null;
  name: string;
  prefix: string;
  permissions: Permission[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateApiKeyRequest = {
  name: string;
  permissions: Permission[];
  expiresAt?: string | undefined;
};

export type CreateApiKeyResponse = {
  apiKey: ApiKey;
  /** The full secret token — shown once at creation, never returned again. */
  token: string;
};

export type ListApiKeysResponse = {
  apiKeys: ApiKey[];
};

// A person (or API key) with access to a workspace. `subjectId` is
// `user:<betterAuthUserId>` or `api_key:<id>`; the People surface lists the
// `user:` subjects (api_key subjects belong to the API keys section).
export type WorkspaceMember = {
  subjectId: string;
  subjectLabel: string | null;
  role: string;
  permissions: Permission[];
  createdAt: string;
};

export type ListWorkspaceMembersResponse = {
  members: WorkspaceMember[];
};

export type AddWorkspaceMemberRequest = {
  email: string;
  role?: string | undefined;
  permissions: Permission[];
};

export type UpdateWorkspaceMemberRequest = {
  role?: string | undefined;
  permissions: Permission[];
};

// --- Goals -------------------------------------------------------------------

export type SessionGoalStatus = "active" | "paused" | "completed";

export type SessionGoalCreatedBy = "api" | "agent" | "scheduled_task";

export type SessionGoal = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  status: SessionGoalStatus;
  text: string;
  successCriteria: string | null;
  evidence: string | null;
  rationale: string | null;
  pausedReason: string | null;
  createdBy: SessionGoalCreatedBy;
  version: number;
  autoContinuations: number;
  noProgressStreak: number;
  maxAutoContinuations: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type UpdateSessionGoalRequest = {
  status: "paused" | "active";
  rationale?: string | undefined;
};

export type UpdateSessionRequest = {
  title: string;
};

// --- Operator context controls (/clear, /compact) ----------------------------

/** Outcome of a manual /compact trigger. */
export type CompactSessionContextResult = {
  /** pending waits for the current safe boundary; completed ran while idle. */
  status: "pending" | "completed" | "noop";
  message: string;
};

// --- Turn queue --------------------------------------------------------------

export type EffectiveControlBlocker = {
  kind: "session" | "workspace";
  sessionId?: string | undefined;
  displayName: string;
  actor: string | null;
  reason: string | null;
  changedAt: string | null;
  revision: number;
};

export type EffectiveControlResumeOption = {
  scope: "selected" | "session" | "workspace";
  targetId?: string | undefined;
  selectedStateAfter: "active" | "paused";
  remainingPrimaryBlocker?: EffectiveControlBlocker | undefined;
  impactCopy: string;
};

export type EffectiveSessionControl = {
  state: "active" | "paused";
  controlVersion: number;
  controlEtag: string;
  directState: "active" | "paused";
  primaryBlocker: EffectiveControlBlocker | null;
  additionalBlockerCount: number;
  blockers: EffectiveControlBlocker[];
  resumeOptions: EffectiveControlResumeOption[];
  override: { rootSessionId: string; revision: number } | null;
  settlement: { state: "stopping"; attemptCount: number } | null;
};

export type SessionCommandReceipt = {
  id: string;
  action: string;
  operationKey: string;
  targetSessionId: string | null;
  targetTurnId: string | null;
  appliedControlRevision: number | null;
  appliedQueueVersion: number | null;
  appliedTurnVersion: number | null;
  appliedDraftRevision: number | null;
  createdAt: string;
};

export type ComposerDraft = {
  revision: number;
  text: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sourceTurnId: string | null;
  sourceTurnVersion: number | null;
  updatedAt: string | null;
};

export type SessionQueueSnapshot = {
  version: number;
  effectiveControl: EffectiveSessionControl;
  /** The latest interrupted attempt has not yet durably proved physical quiescence. */
  stoppingPreviousAttempt: boolean;
  items: SessionTurn[];
};

export type SystemUpdateClassification = "success" | "failure" | "action_required" | "info";

export type SessionSystemUpdateKind =
  | "scheduled_occurrence"
  | "goal_continuation"
  | "agent_message"
  | "agent_steer_instruction"
  | "child_terminal_result";

export type SessionSystemUpdateState =
  | "pending"
  | "deferred"
  | "delivered"
  | "cancelled"
  | "superseded"
  | "failed";

export type SessionSystemUpdate = {
  id: string;
  sessionId: string;
  kind: SessionSystemUpdateKind;
  classification: SystemUpdateClassification;
  sourceId: string;
  dedupeKey: string;
  summary: string;
  payload: Record<string, unknown>;
  lineage: Record<string, unknown>;
  state: SessionSystemUpdateState;
  deliveredTurnId: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export type SessionControlResponse = {
  receipt: SessionCommandReceipt;
  effectiveControl: EffectiveSessionControl;
  interruptionCount: number;
  wakeCount: number;
};

export type WorkspaceInferenceControlResponse = {
  receipt: SessionCommandReceipt;
  state: "active" | "paused";
  revision: number;
  interruptionCount: number;
  wakeCount: number;
};

export type WorkspaceControlEvent = {
  id: string;
  workspaceId: string;
  /** Same monotonic value as revision; named sequence for SSE resume cursors. */
  sequence: number;
  revision: number;
  type: "workspace.control.changed";
  scope: "workspace" | "session";
  rootSessionId: string | null;
  action: "pause" | "resume";
  automatic: boolean;
  reason: string | null;
  actor: string;
  occurredAt: string;
  truncation?: {
    truncated: true;
    surface:
      | "durable_control"
      | "database_guard"
      | "http_projection"
      | "nats_legacy_guard"
      | "sse_legacy_guard";
    deliveredBytes: number;
    fields: Array<{
      field: "reason" | "actor";
      originalBytes: number;
      deliveredBytes: number;
      omittedBytes: number;
    }>;
    fullEvidence: {
      available: false;
      reason: "not_retained";
    };
  } | null;
};

export type SessionQueueMutationResponse = {
  receipt: SessionCommandReceipt;
  snapshot: SessionQueueSnapshot;
  draft?: ComposerDraft;
};

export type MoveSessionQueueItemRequest = {
  clientEventId: string;
  expectedQueueVersion: number;
  beforeTurnId: string | null;
};

export type EditSessionQueueItemRequest = {
  clientEventId: string;
  expectedTurnVersion: number;
  expectedDraftRevision: number;
  replaceDraft: boolean;
};

export type SteerSessionQueueItemRequest = {
  clientEventId: string;
  expectedTurnVersion: number;
  controlEtag?: string;
};

export type DeleteSessionQueueItemRequest = {
  clientEventId: string;
  expectedTurnVersion: number;
  reason?: string;
};

export type SaveComposerDraftRequest = Omit<
  ComposerDraft,
  "revision" | "sourceTurnId" | "sourceTurnVersion" | "updatedAt"
> & { expectedRevision: number };

// --- Scheduled tasks: requests + runs ----------------------------------------

/** Input shape for agent config on create/update (server applies defaults). */
export type ScheduledTaskAgentConfigInput = {
  prompt: string;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
};

export type CreateScheduledTaskRequest = {
  name: string;
  schedule: ScheduledTaskScheduleSpec;
  runMode?: ScheduledTaskRunMode | undefined;
  overlapPolicy?: ScheduledTaskOverlapPolicy | undefined;
  agentConfig: ScheduledTaskAgentConfigInput;
  status?: ScheduledTaskStatus | undefined;
  variableSetId?: string | null | undefined;
  /** @deprecated use variableSetId */
  environmentId?: string | null | undefined;
  // The rig each run binds to (M3); active version resolved per fire.
  rigId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type UpdateScheduledTaskRequest = {
  name?: string | undefined;
  schedule?: ScheduledTaskScheduleSpec | undefined;
  runMode?: ScheduledTaskRunMode | undefined;
  overlapPolicy?: ScheduledTaskOverlapPolicy | undefined;
  agentConfig?: ScheduledTaskAgentConfigInput | undefined;
  status?: ScheduledTaskStatus | undefined;
  variableSetId?: string | null | undefined;
  /** @deprecated use variableSetId */
  environmentId?: string | null | undefined;
  // The rig each run binds to (M3); active version resolved per fire.
  rigId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ScheduledTaskRunStatus = "queued" | "dispatched" | "failed";

export type ScheduledTaskTriggerType = "scheduled" | "manual";

export type ScheduledTaskRun = {
  id: string;
  accountId: string;
  workspaceId: string;
  taskId: string;
  status: ScheduledTaskRunStatus;
  triggerType: ScheduledTaskTriggerType;
  scheduledAt: string | null;
  firedAt: string;
  sessionId: string | null;
  triggerEventId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

// --- VariableSets -------------------------------------------------------------

/**
 * Variable values are write-only by design: the API never returns a value, so
 * reads expose name + version metadata only. Values are decrypted exclusively
 * inside the worker at sandbox materialization time.
 */
export type VariableSetVariableMetadata = {
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type VariableSet = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  variables: VariableSetVariableMetadata[];
  createdAt: string;
  updatedAt: string;
};

/** @deprecated use VariableSetVariableMetadata */
export type WorkspaceEnvironmentVariableMetadata = VariableSetVariableMetadata;

/** @deprecated use VariableSet */
export type WorkspaceEnvironment = VariableSet;

export type CreateVariableSetRequest = {
  name: string;
  description?: string | undefined;
  /** Initial variables. Values are write-only: they never come back on reads. */
  variables?: { name: string; value: string }[] | undefined;
};

/** @deprecated use CreateVariableSetRequest */
export type CreateWorkspaceEnvironmentRequest = CreateVariableSetRequest;

export type UpdateVariableSetRequest = {
  name?: string | undefined;
  description?: string | null | undefined;
};

/** @deprecated use UpdateVariableSetRequest */
export type UpdateWorkspaceEnvironmentRequest = UpdateVariableSetRequest;

export type SetVariableSetVariableRequest = {
  value: string;
};

/** @deprecated use SetVariableSetVariableRequest */
export type SetWorkspaceEnvironmentVariableRequest = SetVariableSetVariableRequest;

// --- Rigs ---------------------------------------------------------------------
// Workspace-scoped, versioned sandbox machine definitions. Versions are
// append-only and content-immutable; exactly one is active per rig.

export type RigCheck = {
  name: string;
  command: string;
};

export type RigVersion = {
  id: string;
  rigId: string;
  version: number;
  image: string | null;
  setupScript: string | null;
  checks: RigCheck[];
  credentialHooks: string[];
  defaultVariableSetIds: string[];
  changelog: string | null;
  createdBy: string | null;
  active: boolean;
  createdAt: string;
};

export type RigVerificationHealth = {
  checkHealth: "passing" | "failing" | "unknown";
  lastVerifiedAt: string | null;
};

export type Rig = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdBy: string | null;
  activeVersion: RigVersion | null;
  activeVersionHealth?: RigVerificationHealth | null;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RigChangeKind = "setup_append" | "definition_edit";

export type RigChangeStatus = "proposed" | "verifying" | "merged" | "rejected" | "failed";

export type RigCheckResult = {
  name: string;
  command: string;
  exitCode: number | null;
  output?: string | undefined;
};

export type RigChangeVerification = {
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  log?: string | undefined;
  checkResults?: RigCheckResult[] | undefined;
  [key: string]: unknown;
};

export type RigChange = {
  id: string;
  rigId: string;
  baseVersionId: string | null;
  kind: RigChangeKind;
  payload: Record<string, unknown>;
  status: RigChangeStatus;
  proposedBy: string | null;
  verification: RigChangeVerification | null;
  resultVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRigRequest = {
  name: string;
  description?: string | undefined;
  image?: string | undefined;
  setupScript?: string | undefined;
  checks?: RigCheck[] | undefined;
  credentialHooks?: string[] | undefined;
  defaultVariableSetIds?: string[] | undefined;
};

export type UpdateRigRequest = {
  name?: string | undefined;
  description?: string | null | undefined;
};

export type RigSetupAppendPayload = {
  command: string;
  note?: string | undefined;
};

export type RigDefinitionEditPayload = {
  image?: string | null | undefined;
  setupScript?: string | null | undefined;
  checks?: RigCheck[] | undefined;
  credentialHooks?: string[] | undefined;
  defaultVariableSetIds?: string[] | undefined;
  changelog?: string | null | undefined;
};

export type ProposeRigChangeRequest =
  | { kind: "setup_append"; payload: RigSetupAppendPayload }
  | { kind: "definition_edit"; payload: RigDefinitionEditPayload };

// --- Files ---------------------------------------------------------------------

export type FileStatus = "pending_upload" | "ready" | "failed" | "expired" | "deleted";

export type FileAsset = {
  id: string;
  workspaceId: string;
  status: FileStatus;
  filename: string;
  safeFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  bucket: string;
  objectKey: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateFileUploadRequest = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256?: string | undefined;
};

export type CreateFileUploadResponse = {
  fileId: string;
  uploadId: string;
  /** Pre-signed PUT URL for the file bytes (direct to object storage). */
  putUrl: string;
  /** Headers that MUST be sent with the PUT for the signature to validate. */
  requiredHeaders: Record<string, string>;
  expiresAt: string;
  maxSizeBytes: number;
};

export type CompleteFileUploadResponse = {
  file: FileAsset;
};

export type FileDownloadUrlResponse = {
  url: string;
  expiresAt: string;
};

/** Bytes accepted by the `uploadFile` helper. */
export type FileUploadData = Blob | ArrayBuffer | Uint8Array | string;

export type UploadFileInput = {
  filename: string;
  contentType: string;
  data: FileUploadData;
  sha256?: string | undefined;
};

// --- Documents -------------------------------------------------------------------

export type DocumentStatus = "queued" | "indexing" | "ready" | "failed";
export type KnowledgeSourceKind =
  | "manual_upload"
  | "meeting_transcript"
  | "repository"
  | "email"
  | "chat"
  | "document"
  | "web"
  | "other";
export type DocumentSearchMode = "hybrid" | "vector" | "keyword";

export type DocumentBase = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Document = {
  id: string;
  workspaceId: string;
  baseId: string;
  fileId: string;
  status: DocumentStatus;
  title: string;
  parser: string;
  chunkCount: number;
  error: string | null;
  sourceKind: KnowledgeSourceKind;
  sourceUri: string | null;
  sourceExternalId: string | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceVersion: string | null;
  aclTags: string[];
  createdAt: string;
  updatedAt: string;
};

export type DocumentSearchResult = {
  chunkId: string;
  workspaceId: string;
  documentId: string;
  baseId: string;
  fileId: string;
  title: string;
  text: string;
  score: number;
  matchType: DocumentSearchMode;
  vectorScore: number | null;
  keywordScore: number | null;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  sourceKind: KnowledgeSourceKind;
  sourceUri: string | null;
  sourceExternalId: string | null;
  sourceTitle: string | null;
  sourceAuthor: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceVersion: string | null;
  aclTags: string[];
};

export type CreateDocumentBaseRequest = {
  name: string;
  description?: string | undefined;
};

export type AddDocumentRequest = {
  fileId: string;
  title?: string | undefined;
  sourceKind?: KnowledgeSourceKind | undefined;
  sourceUri?: string | undefined;
  sourceExternalId?: string | undefined;
  sourceTitle?: string | undefined;
  sourceAuthor?: string | undefined;
  sourceCreatedAt?: string | undefined;
  sourceUpdatedAt?: string | undefined;
  sourceVersion?: string | undefined;
  aclTags?: string[] | undefined;
};

export type DocumentSearchRequest = {
  query: string;
  baseIds?: string[] | undefined;
  mode?: DocumentSearchMode | undefined;
  sourceKinds?: KnowledgeSourceKind[] | undefined;
  aclTags?: string[] | undefined;
  limit?: number | undefined;
};

export type DocumentSearchResponse = {
  results: DocumentSearchResult[];
};

export type KnowledgeMemoryStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "active"
  | "superseded"
  | "archived";
export type KnowledgeMemoryKind =
  | "semantic"
  | "episodic"
  | "procedural"
  | "decision"
  | "preference";

export type KnowledgeSourceRef = {
  kind: "document_chunk" | "document" | "session_event" | "memory" | "external";
  id: string;
  uri?: string | undefined;
  title?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type KnowledgeMemory = {
  id: string;
  workspaceId: string;
  status: KnowledgeMemoryStatus;
  kind: KnowledgeMemoryKind;
  scope: string;
  text: string;
  sourceRefs: KnowledgeSourceRef[];
  confidence: number;
  metadata: Record<string, unknown>;
  createdBySessionId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  pinned: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  validFrom: string;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeMemoryRequest = {
  status?: KnowledgeMemoryStatus | undefined;
  kind?: KnowledgeMemoryKind | undefined;
  scope?: string | undefined;
  text: string;
  sourceRefs?: KnowledgeSourceRef[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdBySessionId?: string | undefined;
  pinned?: boolean | undefined;
  replacesId?: string | undefined;
};

export type UpdateKnowledgeMemoryRequest = {
  status?: KnowledgeMemoryStatus | undefined;
  kind?: KnowledgeMemoryKind | undefined;
  scope?: string | undefined;
  text?: string | undefined;
  sourceRefs?: KnowledgeSourceRef[] | undefined;
  confidence?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  reviewedBy?: string | undefined;
  pinned?: boolean | undefined;
};

export type KnowledgeMemorySearchRequest = {
  query?: string | undefined;
  status?: KnowledgeMemoryStatus | undefined;
  kind?: KnowledgeMemoryKind | undefined;
  scope?: string | undefined;
  limit?: number | undefined;
};

export type WorkspaceMemorySearchMode = "hybrid" | "vector" | "keyword";

export type WorkspaceMemorySearchRequest = {
  query: string;
  kind?: KnowledgeMemoryKind | undefined;
  limit?: number | undefined;
  mode?: WorkspaceMemorySearchMode | undefined;
};

export type WorkspaceMemorySearchResult = {
  memory: KnowledgeMemory;
  score: number;
  matchType: WorkspaceMemorySearchMode;
  vectorScore: number | null;
  keywordScore: number | null;
};

export type WorkspaceMemorySearchResponse = {
  results: WorkspaceMemorySearchResult[];
};

// --- Capability packs ---------------------------------------------------------

export type CapabilityPackConnectorAuthModel =
  | "oauth2_authorization_code_pkce"
  | "oauth2_authorization_code"
  | "api_key"
  | "credential_ref";

export type CapabilityPackConnector = {
  id: string;
  name: string;
  category: string;
  authModel: CapabilityPackConnectorAuthModel;
  providers: string[];
  scopes: string[];
  required: boolean;
  metadata: Record<string, unknown>;
};

export type CapabilityPackKnowledge = {
  type: "document_base";
  id: string;
  name: string;
  description: string | null;
  required: boolean;
};

export type CapabilityPackScheduledTaskTemplate = {
  id: string;
  name: string;
  description: string;
  defaultSchedule: ScheduledTaskScheduleSpec;
  defaultRunMode: ScheduledTaskRunMode;
  defaultOverlapPolicy: ScheduledTaskOverlapPolicy;
  prompt?: string | undefined;
};

export type CapabilityPackSkillFile = {
  path: string;
  content: string;
};

export type CapabilityPackSkill = {
  name: string;
  description?: string | undefined;
  files: CapabilityPackSkillFile[];
};

export type CapabilityPackVariableSetSpec = {
  description: string;
  requiredVariables: string[];
  required: boolean;
};

export type CapabilityPack = {
  id: string;
  name: string;
  description: string;
  role: string;
  category: string;
  version: string;
  sandboxImage?: string | undefined;
  skills: CapabilityPackSkill[];
  tools: ToolRef[];
  connectors: CapabilityPackConnector[];
  knowledge: CapabilityPackKnowledge[];
  scheduledTaskTemplates: CapabilityPackScheduledTaskTemplate[];
  variableSet?: CapabilityPackVariableSetSpec | undefined;
  metadata: Record<string, unknown>;
};

/** Input shape for registering a pack manifest (server applies defaults). */
export type RegisterCapabilityPackRequest = {
  id: string;
  name: string;
  description: string;
  role: string;
  category: string;
  version: string;
  sandboxImage?: string | undefined;
  skills?:
    | {
        name: string;
        description?: string | undefined;
        files: CapabilityPackSkillFile[];
      }[]
    | undefined;
  tools?: ToolRef[] | undefined;
  connectors?:
    | {
        id: string;
        name: string;
        category: string;
        authModel: CapabilityPackConnectorAuthModel;
        providers?: string[] | undefined;
        scopes?: string[] | undefined;
        required?: boolean | undefined;
        metadata?: Record<string, unknown> | undefined;
      }[]
    | undefined;
  knowledge?:
    | {
        type: "document_base";
        id: string;
        name: string;
        description?: string | null | undefined;
        required?: boolean | undefined;
      }[]
    | undefined;
  scheduledTaskTemplates?:
    | {
        id: string;
        name: string;
        description: string;
        defaultSchedule: ScheduledTaskScheduleSpec;
        defaultRunMode?: ScheduledTaskRunMode | undefined;
        defaultOverlapPolicy?: ScheduledTaskOverlapPolicy | undefined;
        prompt?: string | undefined;
      }[]
    | undefined;
  variableSet?:
    | {
        description: string;
        requiredVariables?: string[] | undefined;
        required?: boolean | undefined;
      }
    | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type WorkspaceRegisteredPack = {
  accountId: string;
  workspaceId: string;
  pack: CapabilityPack;
  createdAt: string;
  updatedAt: string;
};

export type PackInstallationStatus = "active" | "disabled";

export type PackInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  packId: string;
  status: PackInstallationStatus;
  metadata: Record<string, unknown>;
  enabledAt: string;
  updatedAt: string;
};

export type EnablePackRequest = {
  variableSetId?: string | undefined;
  /** @deprecated use variableSetId */
  environmentId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ListPacksResponse = {
  packs: CapabilityPack[];
  installations: PackInstallation[];
};

export type GetPackResponse = {
  pack: CapabilityPack;
  installation: PackInstallation | null;
};

// --- Capabilities ---------------------------------------------------------------

export type CapabilityKind = "pack" | "mcp" | "api" | "skill" | "plugin";

export type CapabilitySource =
  | "built_in"
  | "configured"
  | "public_registry"
  | "registry"
  | "manual";

export type CapabilityInstallationStatus = "active" | "disabled";

export type CapabilityCatalogAuthKind = "oauth2" | "api_key" | "none" | "unknown";

export type CapabilityCatalogTier = "verified" | "community";

export type CapabilityRuntime = {
  available: boolean;
  mcpServerId?: string | undefined;
  transport?: string | undefined;
  notes: string | null;
};

export type CapabilityCatalogItem = {
  id: string;
  accountId?: string | undefined;
  workspaceId?: string | undefined;
  kind: CapabilityKind;
  source: CapabilitySource;
  name: string;
  description: string | null;
  category: string;
  tags: string[];
  homepageUrl: string | null;
  endpointUrl: string | null;
  installUrl: string | null;
  authModel: string | null;
  providerDomain: string | null;
  surfaceType: string | null;
  transport: string | null;
  mcpUrl: string | null;
  authKind: CapabilityCatalogAuthKind | null;
  credentialFacts: Record<string, unknown>[];
  tier: CapabilityCatalogTier | null;
  provenance: string | null;
  logoAssetPath: string | null;
  importBatchId: string | null;
  stale: boolean;
  staleAt: string | null;
  tools: ToolRef[];
  runtime: CapabilityRuntime;
  enabled: boolean;
  enabledReason: string | null;
  /** The connection backing this enabled installation, or null when none is involved. */
  connectionRef: {
    connectionId: string;
    providerDomain: string;
    kind: string;
  } | null;
  metadata: Record<string, unknown>;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type CapabilityInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  kind: CapabilityKind;
  status: CapabilityInstallationStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  enabledAt: string;
  updatedAt: string;
};

export type CapabilityCatalogResponse = {
  items: CapabilityCatalogItem[];
  installations: CapabilityInstallation[];
};

export type CreateCapabilityCatalogItemRequest = {
  id?: string | undefined;
  kind: Exclude<CapabilityKind, "pack">;
  source?: CapabilitySource | undefined;
  name: string;
  description?: string | undefined;
  category?: string | undefined;
  tags?: string[] | undefined;
  homepageUrl?: string | undefined;
  endpointUrl?: string | undefined;
  installUrl?: string | undefined;
  authModel?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type EnableCapabilityRequest = {
  config?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  connectionRef?: McpServerConnectionRef | undefined;
  /**
   * Credential headers for remote MCP capabilities. Write-only: encrypted at
   * rest, injected only into the runtime MCP client, never returned by the
   * API (responses expose header names only).
   */
  headers?: Record<string, string> | undefined;
  /**
   * Initial variableSet attachment for kind=pack capabilities — mirrors the
   * dedicated POST /packs/:id/enable body. Required to enable an
   * variableSet.required pack through this unified path; ignored otherwise.
   */
  variableSetId?: string | undefined;
  /** @deprecated use variableSetId */
  environmentId?: string | undefined;
};

export type DiscoverMcpCapabilitiesResponse = {
  items: CapabilityCatalogItem[];
  source: "official_mcp_registry";
  sourceUrl: string;
};

// --- GitHub ---------------------------------------------------------------------

export type GitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  accountLogin: string;
  accountType: string | null;
};

export type GitHubRepositoryScope = "all" | "selected";

export type GitHubInstallationBinding = {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  repositoryScope: GitHubRepositoryScope;
  repositoryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type GitHubAppInfo = {
  configured: boolean;
  appId: string | null;
  clientId: string | null;
  appSlug: string | null;
  /** Reserved compatibility field; null while new installation binding is disabled. */
  installUrl: string | null;
  /** Reserved compatibility field; null while new installation binding is disabled. */
  linkUrl: string | null;
  /** Installation bindings owned independently by this workspace. */
  installations: GitHubInstallationBinding[];
  /** Setting names still missing when `configured` is false. */
  missing: string[];
};

export type GitHubRepositoriesResponse = {
  repositories: GitHubRepository[];
};

export type CreateGitHubAppManifestRequest = {
  appName?: string | undefined;
  organization?: string | undefined;
  public?: boolean | undefined;
  includeCiPermissions?: boolean | undefined;
};

export type CreateGitHubAppManifestResponse = {
  /** GitHub URL to POST the manifest to (personal or organization flow). */
  actionUrl: string;
  state: string;
  manifest: Record<string, unknown>;
};

// --- Billing --------------------------------------------------------------------

export type BillingMode = "disabled" | "stripe";

export type EntitlementsMode = "none" | "static" | "managed";

export type BillingBalance = {
  accountId: string;
  balanceMicros: number;
  currency: "usd";
  updatedAt: string;
};

export const KNOWN_USAGE_EVENT_TYPES = [
  "agent_run.created",
  "agent_run.completed",
  "model.tokens",
  "model.cost",
  "file.uploaded",
  "file.deleted",
  "document.indexed",
  "scheduled_task.fired",
  "api_key.request",
  // sandbox warm-time metering (P2.1) — mirrors contracts UsageEventType.
  "sandbox.warm_seconds",
  "sandbox.warm_cost",
] as const;

export type KnownUsageEventType = (typeof KNOWN_USAGE_EVENT_TYPES)[number];

export type UsageEventType = KnownUsageEventType | (string & {});

export type UsageEvent = {
  id: string;
  workspaceId: string;
  accountId: string;
  subjectId: string | null;
  eventType: UsageEventType;
  quantity: number;
  unit: string;
  sourceResourceType: string | null;
  sourceResourceId: string | null;
  idempotencyKey: string;
  occurredAt: string;
  recordedAt: string;
  exportedToBillingAt: string | null;
  billingProviderEventId: string | null;
};

export type EntitlementValue = boolean | string | number | string[];

export type Entitlements = Record<string, EntitlementValue>;

export type BillingSummary = {
  mode: BillingMode;
  balance: BillingBalance;
};

export type BillingUsageResponse = {
  balance: BillingBalance;
  usage: UsageEvent[];
};

export type BillingEntitlementsResponse = {
  accountId: string;
  mode: EntitlementsMode;
  entitlements: Entitlements;
};

export type CreateCheckoutRequest = {
  accountId?: string | undefined;
  /** USD amount with cent precision (server enforces min/max). */
  amountUsd: number;
  successUrl?: string | undefined;
  cancelUrl?: string | undefined;
};

export type CreateCheckoutResponse = {
  checkoutSessionId: string;
  url: string;
};

export type UserMessageEventInput = {
  type: "user.message";
  clientEventId?: string | undefined;
  payload: {
    text: string;
    resources?: ResourceRef[] | undefined;
    tools?: ToolRef[] | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    mcpCredentialUpdates?: SessionMcpCredentialUpdateInput[] | undefined;
  };
};

export type UserApprovalDecisionEventInput = {
  type: "user.approvalDecision";
  clientEventId?: string | undefined;
  payload: {
    approvalId: string;
    decision: "approve" | "reject";
    message?: string | undefined;
  };
};

export type UserHumanInputResponseEventInput = {
  type: "user.humanInputResponse";
  clientEventId?: string | undefined;
  payload: {
    requestId: string;
    response: SubmitHumanInputResponseRequest;
  };
};

/** Control/user events a client may POST to a session's event log. */
export type ClientSessionEventInput =
  | UserMessageEventInput
  | UserApprovalDecisionEventInput
  | UserHumanInputResponseEventInput;

// ── Bring-your-own-compute: Machines dashboard + per-machine metrics (M10) ────
// Hand-written mirrors of the `@opengeni/contracts` MetricSample / MachineView /
// MachinesResponse / MachineMetricsSeriesResponse (pinned by contract-parity).
// M9 imports THESE so the dashboard UI never drifts from the API.

/** A point-in-time machine metrics sample. `gpuUtilPct`/`gpuMemBytes` are null
 *  when no GPU was present (not-reported, never a real zero); the bytes/load are
 *  numbers; `sampledAt` is an ISO-8601 instant. */
export type MetricSample = {
  cpuPct: number;
  load1: number;
  load5: number;
  load15: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  gpuUtilPct: number | null;
  gpuMemBytes: number | null;
  runQueue: number;
  sampledAt: string;
};

/** The derived dashboard state of a machine (M3 liveness + consent/display
 *  reasons + the in-flight device-flow). */
export type MachineState =
  | "online"
  | "reconnecting"
  | "offline"
  | "consent_required"
  | "display_unavailable"
  | "enrolling";

export type MachineKind = "modal" | "selfhosted";

/** A machine as the Machines dashboard renders it (an enrolled selfhosted machine
 *  or the session's synthetic Modal group box, `isSessionGroup: true`). */
export type MachineView = {
  sandboxId: string;
  enrollmentId: string | null;
  name: string;
  kind: MachineKind;
  state: MachineState;
  active: boolean;
  isSessionGroup: boolean;
  os: string;
  arch: string;
  hasDisplay: boolean;
  /** Non-null only when a display exists but capture is blocked (macOS Screen
   *  Recording / TCC not granted) — the UI can surface "display: capture not
   *  granted". null == capture permitted OR headless. */
  desktopUnavailableReason?: string | null | undefined;
  allowScreenControl: boolean;
  sharedSessionCount: number;
  lastSeenAt: string | null;
  metrics: MetricSample | null;
};

/** GET /v1/workspaces/:ws/machines — the dashboard list + the active-sandbox
 *  pointer (null activeSandboxId == the session's own group box is active). */
export type MachinesResponse = {
  activeSandboxId: string | null;
  activeEpoch: number;
  machines: MachineView[];
};

/** GET /v1/workspaces/:ws/machines/:enrollmentId/metrics/series — the downsampled
 *  (~1/min) history the dashboard time-range reads. */
export type MachineMetricsSeriesResponse = {
  samples: MetricSample[];
};

/** POST /v1/workspaces/:ws/sessions/:sessionId/active-sandbox — swap a session's
 *  active sandbox. `target` is a `MachineView.sandboxId`, or "session"/"default"
 *  to swap back to the session's own group box. */
export type SwapActiveSandboxRequest = {
  target: string;
};

/** The swap outcome (mirrors the server `FleetSwapResult`). `swapped` is true on a
 *  successful repoint OR a no-op (already there); `reason` carries the failure
 *  detail (unowned/offline target, or a lost epoch fence) when false. */
export type SwapActiveSandboxResponse = {
  swapped: boolean;
  activeSandboxId: string | null;
  activeEpoch: number;
  reason?: string;
  // Typed rejection discriminant (issue #341); present only when swapped is false.
  // Mirror of the `@opengeni/contracts` SwapActiveSandboxResponse.code enum.
  code?:
    | "stale_pointer"
    | "offline_enrollment"
    | "unsupported_backend_context"
    | "transient_establishment"
    | "concurrent_swap";
};

// ── Self-hosted enrollment UX (design 11) ────────────────────────────────────
// Hand-written mirrors of the `@opengeni/contracts` enrollment-UX request/response
// shapes (the SDK keeps zero runtime deps). The click-Grant approve-page
// lookup/deny + the headless enroll-token mint/exchange.

/** Mirror of `@opengeni/contracts` EnrollmentOs. */
export type EnrollmentOs = "linux" | "macos" | "windows";

/** POST /v1/enrollments/device/lookup body. */
export type DeviceEnrollmentLookupRequest = {
  userCode: string;
};

/** The presentational machine details the consent screen renders. */
export type DeviceEnrollmentLookupMachine = {
  machineName: string | null;
  os: EnrollmentOs;
  arch: string;
  canOfferDisplay: boolean;
  requestsScreenControl: boolean;
};

/** POST /v1/enrollments/device/lookup response (no secrets, no device_code). */
export type DeviceEnrollmentLookupResponse = {
  workspaceId: string;
  userCode: string;
  machine: DeviceEnrollmentLookupMachine;
  expiresAt: string;
};

/** POST /v1/workspaces/:ws/enrollments/device/approve body. */
export type DeviceEnrollmentApproveRequest = {
  userCode: string;
  allowScreenControl?: boolean;
};

/** POST /v1/workspaces/:ws/enrollments/device/approve response. */
export type DeviceEnrollmentApproveResponse = {
  approved: boolean;
  enrollmentId: string;
  sandboxId: string;
  allowScreenControl: boolean;
};

/** POST /v1/workspaces/:ws/enrollments/device/deny body. */
export type DeviceEnrollmentDenyRequest = {
  userCode: string;
};

/** POST /v1/workspaces/:ws/enrollments/device/deny response. */
export type DeviceEnrollmentDenyResponse = {
  denied: boolean;
};

/** POST /v1/workspaces/:ws/enrollments/token body. */
export type MintEnrollTokenRequest = {
  allowScreenControl?: boolean;
};

/** POST /v1/workspaces/:ws/enrollments/token response. The `token` is SECRET. */
export type MintEnrollTokenResponse = {
  token: string;
  expiresAt: string;
  expiresInSeconds: number;
};

/** The credential payload the headless exchange returns (a subset of the agent's
 *  EnrollmentCredentials — IDENTICAL to the device-flow poll authorized branch). */
export type EnrollmentCredentials = {
  agentId: string;
  workspaceId: string;
  bearer: string;
  subjectPrefix: string;
  natsUrls: string[];
  relayUrl: string;
  relayToken: string;
  natsAccountCreds: string;
  updatePublicKey: string;
  consentedWholeMachine: boolean;
  consentedScreenControl: boolean;
};

/** POST /v1/enrollments/token/exchange body (the headless / fleet enroll path). */
export type EnrollTokenExchangeRequest = {
  token: string;
  publicKey: string;
  os?: EnrollmentOs;
  arch?: string;
  machineName?: string;
  exposure?: "whole-machine";
  canOfferDisplay?: boolean;
  requestsScreenControl?: boolean;
};

/** POST /v1/enrollments/token/exchange response (wraps the credential shape). */
export type EnrollTokenExchangeResponse = {
  credentials: EnrollmentCredentials;
};
