import type { WorkspaceTranscriptionPolicy } from "./transcription";

// Hand-written mirrors of the public wire shapes in `@opengeni/contracts`.
// The SDK keeps zero runtime dependencies so it stays framework-agnostic and
// publishable on its own; `test/contract-parity.test.ts` pins these types to
// the contracts package so drift fails the gate instead of shipping.

export type CodexRealtimeWebrtcVersion = "v3";
export type CodexRealtimeVoice =
  | "juniper"
  | "maple"
  | "spruce"
  | "ember"
  | "vale"
  | "breeze"
  | "arbor"
  | "sol"
  | "cove";

export type CodexRealtimeWebrtcRequest = {
  realtimeId: string;
  operationId: string;
  browserInstanceId: string;
  ownerKey: string;
  expectedVersion: number;
  expectedConnectionEpoch: number;
  rotate: boolean;
  browserActivation?: "required" | undefined;
  sdp: string;
  version: CodexRealtimeWebrtcVersion;
  instructions?: string | undefined;
  voice?: CodexRealtimeVoice | undefined;
};

export type CodexRealtimeWebrtcResponse = {
  sdp: string;
  version: CodexRealtimeWebrtcVersion;
  model: "gpt-live-1-boulder-alpha";
  connectionId: string;
  connectionEpoch: number;
  startupFenceSequence: number;
  modeVersion: number;
  replay: boolean;
};

export type GatewayRealtimeConnectRequest = {
  realtimeId: string;
  operationId: string;
  browserInstanceId: string;
  ownerKey: string;
  expectedVersion: number;
  expectedConnectionEpoch: number;
  rotate: boolean;
};

export type GatewayRealtimeInitialItem = {
  role: "user" | "developer" | "assistant";
  text: string;
};

export type GatewayRealtimeConnectResponse = {
  token: string;
  url: string;
  upstreamModelId: string;
  expiresAt: number | null;
  connectionId: string;
  connectionEpoch: number;
  startupFenceSequence: number;
  modeVersion: number;
  initialItems: GatewayRealtimeInitialItem[];
  instructions: string;
  replay: false;
};

export type ActivateCodexRealtimeConnectionRequest = {
  operationId: string;
  browserInstanceId: string;
  ownerKey: string;
  connectionEpoch: number;
  expectedVersion: number;
  expectedConnectionEpoch: number;
};

export type SessionRealtimeLedgerDirection = "provider_in" | "provider_out";
export type SessionRealtimeLedgerKind =
  | "user_transcript"
  | "assistant_transcript"
  | "delegation_call"
  | "delegation_progress"
  | "delegation_result"
  | "interruption"
  | "session_update"
  | "error";

export type SessionRealtimeLedgerEntry = {
  id: string;
  realtimeId: string;
  operationId: string;
  connectionEpoch: number;
  sequence: number;
  direction: SessionRealtimeLedgerDirection;
  kind: SessionRealtimeLedgerKind;
  role: "user" | "assistant" | null;
  providerEventId: string | null;
  delegationItemId: string | null;
  sourceUpdateId: string | null;
  historyItemId: string | null;
  turnId: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  clientAckedAt: string | null;
  providerAckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionRealtimeInboundEntry = {
  operationId: string;
  kind: Exclude<
    SessionRealtimeLedgerKind,
    "delegation_progress" | "delegation_result" | "session_update"
  >;
  role?: "user" | "assistant" | null | undefined;
  providerEventId?: string | null | undefined;
  delegationItemId?: string | null | undefined;
  text?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
};

export type SyncSessionRealtimeLedgerRequest = {
  browserInstanceId: string;
  ownerKey: string;
  expectedVersion: number;
  connectionId: string;
  connectionEpoch: number;
  entries?: SessionRealtimeInboundEntry[] | undefined;
  clientAckThroughSequence?: number | null | undefined;
  providerAckSequences?: number[] | undefined;
  providerStarted?:
    | { providerSessionId: string; providerEventId?: string | null | undefined }
    | undefined;
};

export type SyncSessionRealtimeLedgerResponse = {
  accepted: Array<{ entry: SessionRealtimeLedgerEntry; replay: boolean }>;
  outbound: SessionRealtimeLedgerEntry[];
};

export type SessionRealtimeModel =
  | "gpt-live-1-boulder-alpha"
  | "opengeni-gateway/openai/gpt-realtime-2.1"
  | "opengeni-gateway/openai/gpt-realtime-mini"
  | "opengeni-gateway/xai/grok-voice-think-fast-2.0"
  | "workspace-gateway/openai/gpt-realtime-2.1"
  | "workspace-gateway/openai/gpt-realtime-mini"
  | "workspace-gateway/xai/grok-voice-think-fast-2.0";

export type WorkspaceRealtimeModelCatalogItem = {
  id: SessionRealtimeModel;
  label: string;
  provider: "OpenGeni" | "Connected Codex" | "Your Gateway";
  description: string;
  available: boolean;
  unavailableReason: string | null;
  recommended: boolean;
};

export type WorkspaceRealtimeModelCatalogResponse = {
  models: WorkspaceRealtimeModelCatalogItem[];
};
export type SessionRealtimeState = "active" | "ended";
export type SessionRealtimeEndReason = "user_stop" | "browser_unload" | "lease_expired";

export type SessionRealtimeMode = {
  id: string;
  sessionId: string;
  operationId: string;
  browserInstanceId: string;
  model: SessionRealtimeModel;
  state: SessionRealtimeState;
  version: number;
  connectionEpoch: number;
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
  startedAt: string;
  endedAt: string | null;
  endReason: SessionRealtimeEndReason | null;
};

export type BeginSessionRealtimeRequest = {
  operationId: string;
  browserInstanceId: string;
  ownerKey: string;
  model: SessionRealtimeModel;
};

export type RenewSessionRealtimeRequest = {
  browserInstanceId: string;
  ownerKey: string;
  expectedVersion: number;
};

export type EndSessionRealtimeRequest = RenewSessionRealtimeRequest & {
  reason: Extract<SessionRealtimeEndReason, "user_stop" | "browser_unload">;
};

export type SessionRealtimeMutationResponse = {
  mode: SessionRealtimeMode;
  replay: boolean;
};

export type SessionStatus =
  | "queued"
  | "running"
  | "idle"
  | "requires_action"
  | "recovering"
  | "waiting_capacity"
  | "failed"
  | "cancelled";

export type SessionArchiveAction = "archive" | "unarchive";
export type SessionArchiveView = "live" | "archived" | "all";
/** Runtime contracts require `sha256:` followed by exactly 64 lower-case hex characters. */
export type SessionArchiveChecksum = string;
export type SessionArchiveOperationCategory =
  | "create_child"
  | "queue_mutation"
  | "send_message"
  | "steer"
  | "control"
  | "turn_claim"
  | "attempt_update"
  | "event_append"
  | "goal_mutation"
  | "workflow_wake"
  | "child_callback"
  | "schedule_fire"
  | "job_mutation"
  | "sandbox_route"
  | "sandbox_lease"
  | "sandbox_pty"
  | "sandbox_viewer"
  | "file_mutation"
  | "metadata_mutation";
export type SessionArchiveDenial = {
  code: "session_archived" | "archived_ancestry";
  targetSessionId: string;
  archivedAncestorSessionId: string;
  archiveRootSessionId: string;
  archiveSealId: string;
  archiveRevision: string;
  operation: SessionArchiveOperationCategory;
  retryable: false;
};
export type SessionArchiveBlockerCode =
  | "session_lifecycle_live"
  | "turn_unsettled"
  | "attempt_unsettled"
  | "queue_pending"
  | "composer_draft_pending"
  | "system_update_pending"
  | "child_callback_pending"
  | "workflow_wake_pending"
  | "goal_active"
  | "goal_wake_pending"
  | "durable_wait_active"
  | "background_job_active"
  | "schedule_reuse_active"
  | "schedule_fire_pending"
  | "sandbox_operation_active"
  | "sandbox_viewer_active"
  | "sandbox_pty_active"
  | "sandbox_lease_exclusive"
  | "sandbox_recovery_active"
  | "sandbox_route_switch_active"
  | "invariant_unproven";
export type SessionArchiveBlocker = {
  code: SessionArchiveBlockerCode;
  sessionId: string;
  resourceId: string | null;
  state: string | null;
  details: Record<string, unknown>;
};
export type SessionArchiveProjection = {
  archived: boolean;
  archiveRevision: string;
  activeSealCount: number;
  archivedAt: string | null;
  nearestFence: {
    sessionId: string;
    rootSessionId: string;
    sealId: string;
    archiveRevision: string;
  } | null;
};
export type SessionArchiveManifestMember = {
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  expectedArchiveRevision: string;
  expectedArchived: boolean;
};
export type SessionArchiveManifestRoot = {
  rootSessionId: string;
  targetSealId: string | null;
  memberCount: number;
  members: SessionArchiveManifestMember[];
};
export type SessionArchiveManifest = {
  format: "opengeni.session-archive-manifest";
  version: 1;
  workspaceId: string;
  action: SessionArchiveAction;
  totalMemberCount: number;
  roots: SessionArchiveManifestRoot[];
};
export type SessionArchivePlanRequest = {
  action: SessionArchiveAction;
  roots: Array<{ rootSessionId: string; targetSealId?: string | null }>;
};
export type SessionArchivePlanRoot = {
  rootSessionId: string;
  targetSealId: string | null;
  rootChecksum: SessionArchiveChecksum;
  memberCount: number;
  canApply: boolean;
  blockers: SessionArchiveBlocker[];
};
export type SessionArchivePlanResponse = {
  manifest: SessionArchiveManifest;
  manifestChecksum: SessionArchiveChecksum;
  canApply: boolean;
  roots: SessionArchivePlanRoot[];
};
export type SessionArchiveApplyRequest = {
  /** Full bulk manifest until the server registers manifestChecksum; null on replay/resume. */
  manifest: SessionArchiveManifest | null;
  manifestChecksum: SessionArchiveChecksum;
  rootSessionId: string;
  rootChecksum: SessionArchiveChecksum;
  idempotencyKey: string;
};
export type SessionArchiveReceipt = {
  id: string;
  workspaceId: string;
  action: SessionArchiveAction;
  operationKey: string;
  manifestChecksum: SessionArchiveChecksum;
  rootChecksum: SessionArchiveChecksum;
  rootSessionId: string;
  sealId: string;
  memberCount: number;
  coverageChecksum: SessionArchiveChecksum;
  committedAt: string;
};
export type SessionArchiveReceiptMember = {
  sessionId: string;
  parentSessionId: string | null;
  depth: number;
  beforeArchiveRevision: string;
  afterArchiveRevision: string;
  beforeArchived: boolean;
  afterArchived: boolean;
};
export type SessionArchiveApplyResponse = {
  receipt: SessionArchiveReceipt;
  replay: boolean;
  rootArchive: SessionArchiveProjection;
};
export type SessionArchiveReceiptEvidence = {
  receipt: SessionArchiveReceipt;
  members: SessionArchiveReceiptMember[];
};

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
  workspaceGeneration: number | null;
  archiveGeneration: number | null;
  archiveComplete: boolean;
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
  workspaceGeneration: number | null;
  archiveGeneration: number | null;
  archiveComplete: boolean;
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

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LatencyMode = "standard" | "priority" | "fast";
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

/** Value mirror of `@opengeni/contracts`; parity-tested without adding an SDK runtime dependency. */
export const DEFAULT_FILE_RESOURCE_MOUNT_ROOT = ".opengeni/files" as const;

export type FileResourceRef = {
  kind: "file";
  fileId: string;
  /** Optional workspace-relative override; defaults to `.opengeni/files/<file-id>`. */
  mountPath?: string | undefined;
};

export type ResourceRef = RepositoryResourceRef | FileResourceRef;

export type ToolRef = {
  kind: "mcp";
  id: string;
  optional?: boolean | undefined;
};

export type SessionToolPolicy = {
  mode: "workspace_default" | "explicit" | "inherited";
  inheritedFromSessionId: string | null;
};

export type UpdateSessionToolPolicyRequest =
  | {
      mode: "workspace_default";
      expectedVersion: number;
    }
  | {
      mode: "explicit";
      tools: ToolRef[];
      firstPartyMcpTools: FirstPartyMcpToolName[];
      expectedVersion: number;
    };

export type SessionEffectiveToolPolicy = {
  mode: SessionToolPolicy["mode"];
  inheritedFromSessionId: string | null;
  selectedIds: string[];
  effectiveIds: string[];
  mandatoryIds: string[];
  lazyRouter: {
    state: "required" | "disabled";
    deferredIds: string[];
  };
  configuredIds: string[];
  droppedIds: string[];
  counts: {
    selected: number;
    effective: number;
    mandatory: number;
    deferred: number;
    configured: number;
    dropped: number;
  };
  idsTruncated: boolean;
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

export type SessionMcpApprovalPolicy = boolean | string[];

export type SessionMcpServerMetadata = {
  id: string;
  name: string | null;
  url: string;
  headerNames: string[];
  credentialVersion: number;
  requireApproval: SessionMcpApprovalPolicy;
  connectionRef: McpServerConnectionRef | null;
};

export type UpdateSessionMcpApprovalPolicyRequest = {
  requireApproval: SessionMcpApprovalPolicy;
};

export type UpdateSessionMcpApprovalPolicyResponse = {
  server: SessionMcpServerMetadata;
  effectiveFrom: "next_attempt";
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

export type McpPersonalConnectionDelegation = {
  serverId: string;
  connectionId: string;
  ownerSubjectId: string;
  providerDomain: string;
  kind?: ConnectionKind | undefined;
};

export type McpPersonalConnectionSummary = Pick<
  McpPersonalConnectionDelegation,
  "serverId" | "providerDomain"
>;

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
  verifiedInstallAt?: string | null;
  verifiedInstallVersion?: number | null;
  metadata: Record<string, unknown>;
  createdBySubjectId: string | null;
  updatedBySubjectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateConnectionRequest = {
  providerDomain: string;
  kind: ConnectionKind;
  ownership?: ConnectionOwnership | undefined;
  /** @deprecated use ownership */
  subjectId?: string | null | undefined;
  credential: Record<string, unknown>;
  grantedScopes?: string[] | undefined;
  expiresAt?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type OpenGeniSlackBotInstallRequest = {
  /** Existing OpenGeni Slack bot connection to reinstall in place. */
  connectionId?: string | undefined;
};

export type OpenGeniSlackBotInstallStart = {
  authorizationUrl: string;
  expiresAt: string;
};

export type GoogleDriveTargetScope = "user" | "workspace" | "organization";
export type GoogleDriveSyncCadence = "manual" | "hourly" | "daily";
export type GoogleDriveReadPolicy = "allow" | "ask" | "block";

export type GoogleDriveSelectedSource = {
  id: string;
  name: string;
  mimeType: string;
  driveId: string | null;
  targetScope: GoogleDriveTargetScope;
  syncCadence: GoogleDriveSyncCadence;
  readPolicy: GoogleDriveReadPolicy;
  selectedAt: string;
};

export type GoogleDriveConnectionMetadata = {
  credentialRole: "google_drive_metadata";
  credentialLabel: "Google Drive metadata browser";
  googlePermissionId: string;
  googleEmail: string;
  googleDisplayName: string | null;
  verifiedAt: string;
  accessMode: "metadata_readonly" | "readonly";
  selectedSources?: GoogleDriveSelectedSource[] | undefined;
  /** @deprecated Read selectedSources; retained while existing connections migrate. */
  selectedSource?: GoogleDriveSelectedSource | null | undefined;
  [key: string]: unknown;
};

export type GoogleDriveOAuthStartRequest = {
  connectionId?: string | undefined;
};

export type GoogleDriveOAuthStartResponse = {
  authorizationUrl: string;
  expiresAt: string;
};

export type GoogleDriveBrowseItem = {
  id: string;
  name: string;
  mimeType: string;
  kind: "folder" | "file";
  driveId: string | null;
  modifiedTime: string | null;
  size: string | null;
  webViewLink: string | null;
};

export type GoogleDriveBrowseResponse = {
  connection: ConnectionMetadata;
  parentId: string;
  current: GoogleDriveBrowseItem | null;
  items: GoogleDriveBrowseItem[];
  nextPageToken: string | null;
  incompleteSearch: boolean;
};

export type SaveGoogleDriveSourceRequest = {
  sources: Array<Pick<GoogleDriveBrowseItem, "id" | "name" | "mimeType" | "driveId">>;
  targetScope: GoogleDriveTargetScope;
  syncCadence: GoogleDriveSyncCadence;
  readPolicy: GoogleDriveReadPolicy;
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

export type ConnectionOwnership = "workspace" | "personal";

export type OAuthStartRequest = {
  providerDomain?: string | undefined;
  mcpUrl?: string | undefined;
  resource?: string | undefined;
  requestedScopes?: string[] | undefined;
  returnPath?: string | undefined;
  connectionId?: string | undefined;
  ownership?: ConnectionOwnership | undefined;
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

export type SocialProvider =
  | "x"
  | "reddit"
  | "linkedin"
  | "instagram"
  | "facebook"
  | "tiktok"
  | "youtube"
  | "custom";

export type SocialConnectionStatus = "connected" | "needs_reauth" | "disabled";

export type SocialConnection = {
  id: string;
  accountId: string;
  workspaceId: string;
  provider: SocialProvider;
  accountHandle: string;
  accountName: string | null;
  externalAccountId: string | null;
  status: SocialConnectionStatus;
  scopes: string[];
  credentialRef: string | null;
  tokenMetadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SocialOAuthStartRequest = {
  provider: "x" | "reddit";
  scopes?: string[] | undefined;
  returnPath?: string | undefined;
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

export type TurnInitiatorContext = Record<string, unknown>;

/** Bounded host provenance; OpenGeni-owned lineage keys are reserved. */
export type ServiceTurnInitiatorContext = TurnInitiatorContext;

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
  /** Absent only when reading from a pre-OPE-61 server during rolling upgrade. */
  archive?: SessionArchiveProjection | undefined;
  initialMessage: string;
  title: string | null;
  titleSource: "user" | "agent" | null;
  // Per-session agent persona/system instructions supplied at create; null when
  // the session carried none. Org-visible metadata, never a timeline event.
  instructions: string | null;
  /** Immutable normalized prompt-policy role; distinct from membership roles. */
  policyRole: string | null;
  resources: ResourceRef[];
  skills: SessionSkill[];
  tools: ToolRef[];
  toolPolicy: SessionToolPolicy;
  toolPolicyVersion: number;
  effectiveToolPolicy?: SessionEffectiveToolPolicy | undefined;
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
  firstPartyMcpTools: FirstPartyMcpToolName[];
  mcpServers: SessionMcpServerMetadata[];
  parentSessionId: string | null;
  /** Immutable server-authored nested-agent lineage and policy snapshot. */
  rootSessionId: string;
  nestedAgentDepth: number;
  maxNestedAgentDepthOverride: number | null;
  effectiveMaxNestedAgentDepth: number;
  nestedAgentDepthPolicySource: "session" | "workspace" | "deployment" | "default";
  nestedAgentDepthPolicySessionId: string | null;
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
  /**
   * Frozen at create. `remote_v2` ⇒ Codex remote compaction + Codex-only model
   * admission; `portable` ⇒ plaintext compaction and free provider switching.
   */
  codexCompactionMode: "remote_v2" | "portable";
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
  toolsProvided?: boolean | undefined;
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode: LatencyMode;
  sandboxBackend: SandboxBackend;
  sandboxOs: SandboxOs | null;
  metadata: Record<string, unknown>;
  version: number;
  executionGeneration: number;
  activeAttemptId: string | null;
  lineage: Record<string, unknown>;
  initiator: TurnInitiator;
  initiatorContext: Record<string, unknown>;
  personalConnections?: McpPersonalConnectionSummary[] | undefined;
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
  "session.realtime.started",
  "session.realtime.ended",
  "session.requiresAction",
  "session.humanInput.requested",
  "session.context.compaction.requested",
  "session.context.compaction.started",
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
  "agent.model.request",
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
  "system.update.superseded",
  "system.update.cancelled",
  "system.update.settled",
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
  "session.mcp.approval_policy.updated",
  "session.tool_policy.updated",
  // Multi-account Codex (P1): the session's inference account changed.
  "codex.account.switched",
  // credential allocator metadata-only per-turn credential selection audit.
  "codex.credential.selected",
  // Bounded, identity-free deterministic shadow/replay decision.
  "codex.fleet.decision",
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
export type SessionEventLatestClass = SessionEventSemanticClass | "receipt";
export type SessionEventPayloadMode = "none" | "summary" | "full";
export type SessionEventReadMode = "monitoring" | "forensic";
export type SessionEventReadDirection = "after" | "before";
export type SessionEventResultMode = "events" | "compact";

type SessionEventListCommonOptions = {
  after?: number;
  before?: number;
  limit?: number;
  compact?: boolean;
  mode?: SessionEventReadMode;
  direction?: SessionEventReadDirection;
  payloadMode?: SessionEventPayloadMode;
  resultMode?: "events";
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
        latest: SessionEventLatestClass;
        includeTypes?: never;
        excludeTypes?: never;
        includeClasses?: never;
        excludeClasses?: never;
      }
  );

export type SessionEventCompactResult = {
  version: 1;
  semanticClass: SessionEventSemanticClass;
  source: {
    id: string;
    type: SessionEventType;
    sequence: number;
    occurredAt: string;
    turnId: string | null;
    turnGeneration: number | null;
    turnAttemptId: string | null;
    turnAssociation: SessionEvent["turnAssociation"];
  };
  id: string;
  type: SessionEventType;
  sequence: number;
  occurredAt: string;
  turnId: string | null;
  turnGeneration: number | null;
  turnAttemptId: string | null;
  turnAssociation: SessionEvent["turnAssociation"];
  coveredSequence: { first: number; last: number };
  status:
    | "completed"
    | "failed"
    | "cancelled"
    | "superseded"
    | "checkpoint"
    | "receipt"
    | "unknown";
  text: string | null;
  output: unknown;
  result: unknown;
  failure: {
    error: string | null;
    code: string | null;
    retryable: boolean | null;
    recovery: string | null;
  } | null;
  checkpoint: unknown;
  receipt: unknown;
  truncation: {
    truncated: boolean;
    fields: string[];
    originalBytes: number | null;
    deliveredBytes: number;
  };
};

export type SessionEventCompactResultOptions = {
  latest: SessionEventLatestClass;
  resultMode: "compact";
  mode?: SessionEventReadMode;
  payloadMode?: SessionEventPayloadMode;
};

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
    | "personal_authority_unavailable"
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

// Adaptive-fleet shadow event. This is the typed, identity-free view
// consumed by UI/manager tooling; the durable replay record also contains the
// complete normalized policy/input needed for offline deterministic replay.
export type CodexFleetConfidence = "unknown" | "low" | "medium" | "high";
export type CodexFleetCacheState = "unknown" | "healthy" | "collapsed";
export type CodexFleetShadowComparison =
  | "match"
  | "different_candidate"
  | "different_outcome"
  | "not_comparable_truncated";
export type CodexFleetDecisionScore = {
  candidateKey: string;
  eligible: boolean;
  rejectionReason:
    | "allocator_disabled"
    | "unavailable"
    | "cooling"
    | "quota_ceiling"
    | "overlay_isolation"
    | null;
  quotaPressure: number;
  leasePressure: number;
  observedBurnPressure: number;
  inferredBurnPressure: number;
  runwayPressure: number;
  uncertaintyPressure: number;
  cacheAffinityBenefit: number;
  cacheState: CodexFleetCacheState;
  overlayPreferenceBenefit: number;
  total: number;
  confidence: CodexFleetConfidence;
};
export type CodexFleetDecisionEventPayload = {
  schemaVersion: 1;
  mode: "shadow";
  actual: {
    outcome: "selected" | "waiting" | "none";
    candidateKey: string | null;
    reason: "lease_reused" | "pin" | "rotation" | "active" | "all_capped" | "none";
  };
  comparison: CodexFleetShadowComparison;
  replay: {
    schemaVersion: 1;
    policyVersion: "adaptive-shadow-v1";
    mode: "shadow";
    input: { candidates: Array<{ key: string }> } & Record<string, unknown>;
    truncatedCandidateCount: number;
    inputFingerprint: string;
    decisionFingerprint: string;
    decision: {
      outcome: "selected" | "paced" | "none";
      selectedCandidateKey: string | null;
      reason:
        | "fenced_in_flight"
        | "fenced_candidate_missing"
        | "admission_paced"
        | "no_eligible_candidate"
        | "overlay_isolated_empty"
        | "best_score"
        | "affinity_best"
        | "hysteresis_hold";
      admission: {
        outcome: "admit" | "pace";
        reason:
          | "fenced_in_flight"
          | "pacing_disabled"
          | "capacity_unknown"
          | "capacity_available"
          | "work_conserving_borrow"
          | "manager_priority"
          | "standard_starvation_bound"
          | "capacity_saturated"
          | "emergency_fuse";
        borrowedIdleCapacity: boolean;
      };
      borrowedOverlayCapacity: boolean;
      strandedEligibleCount: number;
      confidence: CodexFleetConfidence;
      scores: CodexFleetDecisionScore[];
    };
  } & Record<string, unknown>;
};

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
  reason: "exit" | "killed" | "owner_gone" | "timeout" | "lost";
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
  | "repository_discovery_result_limit_exceeded"
  | "repository_read_unavailable";
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
  exitCode: number;
  running: false;
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
  slackBotConnectionId?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
  maxNestedAgentDepth?: number | undefined;
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
  createdBy?: TurnInitiator | undefined;
  createdByContext?: TurnInitiatorContext | undefined;
  personalConnections?: McpPersonalConnectionSummary[] | undefined;
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
  initialMessage?: string | undefined;
  /** Create an idle session shell so realtime voice can be the first interaction. */
  startMode?: "realtime" | undefined;
  /** System instructions scoped to the initial turn; never visible timeline text. */
  turnInstructions?: string | undefined;
  // Per-session agent persona/system instructions (org-visible metadata, not a
  // secret). Delivered system-level, composed AFTER the per-workspace persona —
  // how a host supplies per-agent-type prompts without leaking them into the
  // user-visible timeline. Trimmed, non-empty, max 32768 chars.
  instructions?: string | undefined;
  /** Immutable normalized prompt-policy role; distinct from membership roles. */
  policyRole?: string | undefined;
  resources?: ResourceRef[] | undefined;
  /** Inline skills fixed onto this session; omitted children inherit them. */
  skills?: SessionSkill[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  latencyMode?: LatencyMode | undefined;
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
  // Exact actor-private pre-session draft revision represented by this create.
  // The server consumes only this revision after durable initialization.
  expectedNewSessionDraftRevision?: number | undefined;
  maxNestedAgentDepth?: number | undefined;
  firstPartyMcpPermissions?: string[] | undefined;
  firstPartyMcpTools?: FirstPartyMcpToolName[] | undefined;
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
  "artifacts:read",
  "artifacts:publish",
] as const;

export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number];

/**
 * Permissions the SDK knows about today, kept open so a newer OpenGeni server
 * can introduce permissions without breaking older SDK consumers.
 */
export type Permission = KnownPermission | (string & {});

export type FirstPartyMcpToolName =
  | "set_session_title"
  | "goal_set"
  | "goal_update"
  | "goal_complete"
  | "goal_pause"
  | "memory_search"
  | "memory_save"
  | "memory_correct"
  | "preference_registry_summary"
  | "preference_registry_get"
  | "sandboxes_list"
  | "sandbox_attach"
  | "sandbox_swap"
  | "run_on"
  | "sandbox_provision"
  | "rig_list"
  | "rig_get"
  | "rig_propose_change"
  | "rig_verify"
  | "rig_promote"
  | "sessions_list"
  | "session_get"
  | "session_events"
  | "session_create"
  | "session_send_message"
  | "session_pause"
  | "session_resume"
  | "session_steer"
  | "set_other_session_title"
  | "variable_set_list"
  | "environment_list"
  | "variable_set_set_variable"
  | "environment_set_variable"
  | "github_connect_link"
  | "github_token"
  | "github_repositories_list"
  | "social_connections_list"
  | "social_posts_recent"
  | "social_daily_analysis_context"
  | "social_search_live"
  | "social_mentions_live"
  | "social_thread_fetch"
  | "social_posts_sync"
  | "social_post_reply"
  | "scheduled_tasks_list"
  | "scheduled_tasks_get"
  | "scheduled_tasks_create"
  | "scheduled_tasks_update"
  | "scheduled_tasks_pause"
  | "scheduled_tasks_resume"
  | "scheduled_tasks_trigger"
  | "scheduled_tasks_delete"
  | "scheduled_task_runs_list"
  | "slack_bot_list_channels"
  | "slack_bot_channel_history"
  | "slack_bot_thread_replies"
  | "slack_bot_list_users"
  | "slack_bot_list_files"
  | "slack_bot_file_info"
  | "slack_bot_file_content"
  | "slack_bot_post_message"
  | "slack_bot_delete_message"
  | "artifacts_list"
  | "artifacts_get_source"
  | "artifacts_create"
  | "artifacts_publish"
  | "artifacts_rollback";

export type ProductAccessMode = "local" | "configured" | "managed";

export type ModelCapabilitySupportV1 = "supported" | "unsupported" | "unknown";

export type ModelCapabilityStateV1 = {
  upstream: ModelCapabilitySupportV1;
  runnable: boolean;
};

export type ModelCapabilitiesV1 = {
  reasoning: ModelCapabilityStateV1 & {
    efforts: ReasoningEffort[];
    defaultEffort: ReasoningEffort | null;
    required: boolean;
  };
  functionCalling: ModelCapabilityStateV1;
  structuredOutput: ModelCapabilityStateV1;
  hostedTools: {
    webSearch: ModelCapabilityStateV1;
    xSearch: ModelCapabilityStateV1;
    codeExecution: ModelCapabilityStateV1;
  };
  inputModalities: Array<"text" | "image" | "audio">;
  inputFileMediaTypes?: string[] | undefined;
  outputModalities: Array<"text" | "image" | "audio">;
  transports: {
    sse: ModelCapabilityStateV1;
    responsesWebSocket: ModelCapabilityStateV1;
    realtimeAudio: ModelCapabilityStateV1;
  };
  promptCaching?:
    | (ModelCapabilityStateV1 & {
        mode: "implicit" | "automatic" | "none";
      })
    | undefined;
  latencyModes: Array<{
    id: "standard" | "priority" | "fast";
    upstream: ModelCapabilitySupportV1;
    runnable: boolean;
    billingMultiplierBps?: number | undefined;
  }>;
};

export type ModelCredentialSourceV1 =
  | { kind: "deployment"; mechanism: "api_key" | "azure_ad_bearer" }
  | { kind: "connected_subscription"; provider: "codex" }
  | { kind: "workspace_connection"; mechanism: "api_key" };

export type ModelBillingAttributionV1 = {
  upstreamPayer: "deployment" | "workspace" | "connected_subscription";
  metering: "opengeni_credits" | "external";
};

export type ModelPricingV1 = {
  inputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number | undefined;
  outputMicrosPerMillionTokens: number;
  marginBps?: number | undefined;
};

export type ModelPricingScheduleV1 = {
  default: ModelPricingV1;
  inputTokenTiers?:
    | Array<{
        minimumInputTokens: number;
        pricing: ModelPricingV1;
      }>
    | undefined;
};

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
  source?: "opengeni" | "codex" | "workspace_gateway" | undefined;
  contextWindowTokens?: number | undefined;
  schemaVersion?: 1 | undefined;
  aliases?: string[] | undefined;
  deployment?:
    | {
        upstreamModelId: string;
        wireApi: "responses" | "chat";
      }
    | undefined;
  executionLimits?:
    | {
        contextWindowTokens: number | null;
        effectiveContextWindowTokens: number | null;
        autoCompactTokenLimit: number | null;
        toolOutputTruncationTokens: number | null;
      }
    | undefined;
  credentialSource?: ModelCredentialSourceV1 | undefined;
  billing?: ModelBillingAttributionV1 | undefined;
  capabilities?: ModelCapabilitiesV1 | undefined;
  pricing?: ModelPricingScheduleV1 | undefined;
  definitionVersion?: string | undefined;
};

export type ModelAvailabilityV1 = {
  status: "available" | "unavailable" | "degraded" | "unknown";
  selectable: boolean;
  reason:
    | "missing_credential"
    | "needs_reauth"
    | "credential_not_ready"
    | "not_entitled"
    | "provider_unhealthy"
    | "policy_blocked"
    | "unsupported"
    | null;
  checkedAt: string | null;
};

export type ModelCredentialReadinessV1 = {
  status: "ready" | "not_ready" | "error";
  reason:
    | "missing_credential"
    | "needs_reauth"
    | "prerequisites_missing"
    | "resolver_error"
    | "observation_stale"
    | null;
  basis: "configuration" | "connection" | "resolver";
  checkedAt: string | null;
};

export type WorkspaceModelCatalogModel = ClientModel & {
  credentialReadiness: ModelCredentialReadinessV1;
  availability: ModelAvailabilityV1;
};

export type WorkspaceModelCatalogResponse = {
  models: WorkspaceModelCatalogModel[];
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
  /** Authoritative count-only summary from /wham/usage; never synthesized rows. */
  rateLimitResetCredits?: { availableCount: number; credits: null } | null;
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
  /** Controls only NEW automatic allocations. */
  allocatorEnabled: boolean;
  /** Independent OCC sequence; credential/token `version` is never exposed. */
  allocatorVersion: number;
  allocatorUpdatedAt?: string | null;
  /** Cached authoritative summary count, never detailed redemption authority. */
  resetCreditAvailableCount?: number | null;
  resetCreditsCheckedAt?: string | null;
};

export type CodexResetCredit = {
  id: string;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  /** Unix seconds from the provider contract. */
  grantedAt: number;
  /** Unix seconds, or null when the provider reports no expiry. */
  expiresAt: number | null;
  title: string | null;
  description: string | null;
  /** True only for fresh, complete, owning-human provider detail. */
  actionable: boolean;
};

/** Owning-human recovery metadata. It contains no token, browser-session hash, or provider key. */
export type CodexResetRedemptionRecovery = {
  attemptId: string;
  creditId: string;
  status: "provider_started" | "completed";
  outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | null;
  providerStartedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CodexAccountOverview = {
  accountId: string;
  usage: {
    source: "provider" | "cache" | "none";
    fetchedAt: string | null;
    stale: boolean;
    error: string | null;
    value: CodexUsagePayload | null;
  };
  resetCredits: {
    source: "provider" | "cache" | "none";
    fetchedAt: string | null;
    stale: boolean;
    error: string | null;
    detailState: "detailed" | "count_only" | "capped" | "unsupported" | "unknown" | "error";
    detailsComplete: boolean;
    availableCount: number | null;
    credits: CodexResetCredit[];
  };
  canRedeem: boolean;
  /** Owning managed-cookie human may replay durable completion without a healthy provider token. */
  canResumeRedemption: boolean;
  /** Durable owner-scoped ambiguity/completion discovery; never redemption authority for agents. */
  redemptions: CodexResetRedemptionRecovery[];
};

/** Independently settled live overview keyed by workspace credential id. */
export type CodexOverviewResponse = {
  accounts: Record<string, CodexAccountOverview>;
};

export type CodexAllocatorUpdate = {
  allocatorEnabled: boolean;
  allocatorVersion: number;
  allocatorUpdatedAt: string | null;
  changed: boolean;
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
export const OPENGENI_API_CONTRACT_REVISION = "2026-07-workspace-artifacts-v1" as const;
export const OPENGENI_API_CONTRACT_HEADER = "x-opengeni-api-contract" as const;
/** Bounded request/response identifier shared by browser, ingress, and API diagnostics. */
export const OPENGENI_CORRELATION_HEADER = "x-opengeni-correlation-id" as const;

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
  /** Native browser microphone capture + server-side transcription capability. */
  voiceInput?: ClientVoiceInputConfig | undefined;
  productAccessMode: ProductAccessMode;
  auth: ClientAuthConfig;
  analytics: {
    consentRequired: boolean;
    providers: {
      reo?: { clientId: string } | undefined;
      posthog?: { projectKey: string; host: string } | undefined;
      ga4?: { measurementId: string } | undefined;
    };
  };
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

/** Client-safe voice-input capability projection. */
export type ClientVoiceInputConfig = {
  available: boolean;
  maxDurationSeconds: number;
  maxSizeBytes: number;
  acceptedMimeTypes: string[];
};

/** Response from POST /v1/workspaces/:workspaceId/transcriptions. */
export type TranscribeAudioResponse = {
  text: string;
  languages: string[];
};

export type AccountRole = "owner" | "admin" | "member";

export type AccessPrincipalKind =
  | "human_session"
  | "agent_attempt"
  | "service"
  | "api_key"
  | "configured_key";

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
  principalKind?: AccessPrincipalKind | undefined;
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
  voiceInput?: WorkspaceVoiceInputSettings | undefined;
  transcription?: WorkspaceTranscriptionPolicy | undefined;
  maxNestedAgentDepth?: number | null | undefined;
  /** Default for new Codex sessions; absent ⇒ remote_v2. */
  codexCompactionDefault?: "remote_v2" | "portable" | undefined;
  slackReactionSummon?: WorkspaceSlackReactionSummonSettings | undefined;
  [key: string]: unknown;
};

export type WorkspaceSlackReactionSummonSettings = {
  enabled: boolean;
  emoji: string;
  channelPolicy: { mode: "bot_member" } | { mode: "allowlist"; channelIds: string[] };
};

export type SlackReactionChannel = {
  id: string;
  name: string | null;
  isPrivate: boolean;
};

export type SlackReactionChannelListResponse = {
  channels: SlackReactionChannel[];
  nextCursor: string | null;
};

export type WorkspaceVoiceInputSettings = {
  enabled: boolean;
};

export type UpdateWorkspaceSettingsRequest = {
  memoryEnabled?: boolean | undefined;
  voiceInput?: WorkspaceVoiceInputSettings | undefined;
  transcription?: WorkspaceTranscriptionPolicy | undefined;
  maxNestedAgentDepth?: number | null | undefined;
  codexCompactionDefault?: "remote_v2" | "portable" | undefined;
  slackReactionSummon?: WorkspaceSlackReactionSummonSettings | undefined;
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

export type SessionGoalContinuationState =
  | "inactive"
  | "scheduled"
  | "running"
  | "blocked"
  | "invariant_broken";

export type SessionGoalContinuationReason =
  | "goal_inactive"
  | "wake_pending"
  | "continuation_pending"
  | "human_work_pending"
  | "goal_turn_running"
  | "human_turn_running"
  | "workstream_paused"
  | "approval_required"
  | "provider_backpressure"
  | "session_cancelled"
  | "system_work_pending"
  | "missing_obligation";

export type SessionGoalContinuation = {
  state: SessionGoalContinuationState;
  reason: SessionGoalContinuationReason;
  wakeRevision: number;
  observedRevision: number;
  nextAttemptAt: string | null;
  lastError: string | null;
};

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
  /** Optional for source compatibility; the API always supplies this projection. */
  continuation?: SessionGoalContinuation | undefined;
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
  settlement: {
    state: "stopping";
    attemptCount: number;
    interruptionPendingCount: number;
    quiescencePendingCount: number;
  } | null;
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
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode?: LatencyMode | undefined;
  sourceTurnId: string | null;
  sourceTurnVersion: number | null;
  updatedAt: string | null;
};

export type NewSessionDraftOptions = {
  sandboxBackend?: SandboxBackend | undefined;
  targetSandboxId?: string | undefined;
  workingDir?: string | undefined;
  variableSetId?: string | undefined;
  rigId?: string | undefined;
  goal?: GoalSpec | undefined;
  firstPartyMcpPermissions?: Permission[] | undefined;
  firstPartyMcpTools?: FirstPartyMcpToolName[] | undefined;
};

export type NewSessionDraft = {
  revision: number;
  text: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  /** False inherits the workspace-default MCP policy; true preserves an explicit array. */
  toolsProvided: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  latencyMode?: LatencyMode | undefined;
  options: NewSessionDraftOptions;
  updatedAt: string | null;
};

export type SessionQueueSnapshot = {
  version: number;
  effectiveControl: EffectiveSessionControl;
  /** Secret-safe personal MCP summaries frozen on the exact active turn. */
  activePersonalConnections: McpPersonalConnectionSummary[];
  /** The latest interrupted attempt has not yet durably proved physical quiescence. */
  stoppingPreviousAttempt: boolean;
  items: SessionTurn[];
  /** Canonical pending machine inputs. Events only invalidate this snapshot. */
  pendingInputs: SessionPendingInputPreview[];
  /** Exact next bounded input batch that will join an already-waiting prompt. */
  pendingInputAttachment: {
    turnId: string;
    inputIds: string[];
  } | null;
};

export type SessionPendingInputPreview = Pick<
  SessionSystemUpdate,
  "id" | "sessionId" | "kind" | "classification" | "sourceId" | "summary" | "createdAt"
>;

export type SystemUpdateClassification = "success" | "failure" | "action_required" | "info";

export type SessionSystemUpdateKind =
  | "scheduled_occurrence"
  | "goal_continuation"
  | "agent_message"
  | "agent_steer_instruction"
  | "child_terminal_result";

export type SessionSystemUpdateState =
  | "pending"
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
  deliveredHistoryItemId: string | null;
  deliveredAt: string | null;
  createdAt: string;
};

export type SessionControlResponse = {
  receipt: SessionCommandReceipt;
  effectiveControl: EffectiveSessionControl;
  interruptionCount: number;
  wakeCount: number;
  cancelledSessionCount: number;
  cancelledTurnCount: number;
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

export type SaveNewSessionDraftRequest = Omit<NewSessionDraft, "revision" | "updatedAt"> & {
  expectedRevision: number;
};

// --- Scheduled tasks: requests + runs ----------------------------------------

/** Input shape for agent config on create/update (server applies defaults). */
export type ScheduledTaskAgentConfigInput = {
  prompt: string;
  resources?: ResourceRef[] | undefined;
  tools?: ToolRef[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  slackBotConnectionId?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  sandboxBackend?: SandboxBackend | undefined;
  goal?: GoalSpec | undefined;
  maxNestedAgentDepth?: number | undefined;
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

/** Mirrors the closed, provider-neutral retained-output contract. */
export const RETAINED_OUTPUT_DEFAULT_PAGE_BYTES = 256 * 1024;
export const RETAINED_OUTPUT_MAX_PAGE_BYTES = 1024 * 1024;

export type RetainedOutputKind =
  | "tool_result"
  | "assistant_completion"
  | "internal_update"
  | "event_media"
  | "file";

export type RetainedOutputUnavailableReason =
  | "not_retained"
  | "pending"
  | "failed"
  | "expired"
  | "deleted"
  | "missing_storage"
  | "storage_write_failed"
  | "unsupported";

export type RetainedArtifactReference = {
  available: true;
  artifactId: string;
  kind: RetainedOutputKind;
  contentType: string;
  originalBytes: number;
  sha256: string;
  retainedAt: string;
  retention: { policy: "workspace_file"; expiresAt: null };
  retrieval: {
    method: "GET";
    path: string;
    acceptRanges: "bytes";
    maxRangeBytes: number;
  };
};

export type RetainedArtifactUnavailable = {
  available: false;
  artifactId: string;
  reason: RetainedOutputUnavailableReason;
};

export type RetainedArtifactMetadata = RetainedArtifactReference | RetainedArtifactUnavailable;

export type RetainedArtifactContentOptions = {
  /** One RFC-style bytes range, for example `bytes=1048576-2097151`. */
  range?: string | undefined;
  signal?: AbortSignal | undefined;
};

export type RetainedArtifactContent = {
  bytes: Uint8Array;
  status: 200 | 206;
  contentType: string;
  contentLength: number;
  contentRange: string | null;
  acceptRanges: "bytes";
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

export type DocumentAuthorityKind = "organization" | "workspace" | "personal";

export type DocumentVisibility = "workspace" | "private";

export type DocumentCurationStatus = "none" | "pending" | "suggested" | "auto_filed" | "failed";

export type DocumentCuration = {
  suggestedBaseId: string | null;
  suggestedBaseName: string | null;
  confidence: number;
  reason: string | null;
  originalTitle: string | null;
  model: string | null;
};

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
  authorityKind: DocumentAuthorityKind;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
  visibility: DocumentVisibility;
  createdBy: string | null;
  agentAccess: boolean;
  summary: string | null;
  topics: string[];
  curationStatus: DocumentCurationStatus;
  curation: DocumentCuration | null;
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
  authorityKind: DocumentAuthorityKind;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
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
  authorityKind?: DocumentAuthorityKind | undefined;
  visibility?: DocumentVisibility | undefined;
  agentAccess?: boolean | undefined;
};

export type CreateKnowledgeDropRequest = {
  text?: string | undefined;
  fileId?: string | undefined;
  filename?: string | undefined;
  title?: string | undefined;
  authorityKind?: DocumentAuthorityKind | undefined;
  visibility?: DocumentVisibility | undefined;
  agentAccess?: boolean | undefined;
};

export type MoveDocumentRequest = {
  targetBaseId?: string | undefined;
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

export type SessionSkill = CapabilityPackSkill;

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
  sandboxProviderImages?:
    | {
        modal?: { imageId: string } | undefined;
      }
    | undefined;
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
  sandboxProviderImages?:
    | {
        modal?: { imageId: string } | undefined;
      }
    | undefined;
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
  | "library"
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
  /** Secret-safe server-derived registry exposure state. */
  catalogTrust?:
    | {
        state: "trusted" | "legacy_active" | "unverified";
        reason:
          | "trusted_source"
          | "verified_probe"
          | "active_installation_compatibility"
          | "missing_verification";
      }
    | undefined;
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
    connectionId?: string | undefined;
    providerDomain: string;
    kind: string;
    subjectScope?: "subject" | "workspace" | undefined;
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

export type GitHubBindingStatus = "disabled" | "unbound" | "bound";

export type GitHubAppSetupMode = "platform" | "operator";

export type GitHubInstallationLifecycle = "active" | "suspended" | "deleted" | "unverified";

export type GitHubInstallationBinding = {
  installationId: number;
  githubAccountId: number | null;
  accountLogin: string | null;
  accountType: string | null;
  lifecycle: GitHubInstallationLifecycle;
  repositoryScope: GitHubRepositoryScope;
  repositoryCount: number;
  /** OpenGeni-owned entry point for changing the installation's repository allowlist. */
  configureUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubAppInfo = {
  configured: boolean;
  /** Truthful workspace binding state; server App credentials alone are not a binding. */
  status: GitHubBindingStatus;
  /** Platform deployments expose installation only; operator deployments may create an App. */
  setupMode: GitHubAppSetupMode;
  appId: string | null;
  clientId: string | null;
  appSlug: string | null;
  /** Fresh OAuth-first existing-installation discovery and install entry point. */
  installUrl: string | null;
  /** Compatibility alias for installUrl. */
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

export type InsightsRange = "today" | "week" | "month" | "ytd";

export type InsightsBillingPath = "opengeni_credits" | "external";

export type InsightsModelUsageRow = {
  id: string;
  model: string;
  provider: string;
  billing: InsightsBillingPath;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  creditUsd: number;
};

export type InsightsSeriesPoint = {
  label: string;
  modelCostUsd: number;
  warmSeconds: number;
  inputTokens: number;
  cachedTokens: number;
  cacheHitPct: number;
  calls: number;
};

export type InsightsDepthBucket = {
  depth: number;
  sessions: number;
};

export type InsightsModelFacet = {
  provider: string;
  model: string;
};

export type InsightsSpendDriver = {
  id: string;
  groupBy: "root_session" | "schedule";
  label: string;
  creditUsd: number;
  tokens: number;
  cacheHitPct: number;
  pctOfCreditUsd: number;
  deltaUsdVsPrior: number;
};

export type InsightsWarmGroupRow = {
  id: string;
  groupId: string;
  label: string;
  backend: string | null;
  warmSeconds: number;
  sessionsAttached: number;
};

export type InsightsLiveWarmLease = {
  id: string;
  groupId: string;
  backend: string;
  turnHolders: number;
  viewerHolders: number;
  warmForLabel: string;
  warmSeconds: number;
};

export type InsightsFloorSession = {
  id: string;
  title: string;
  state: "running" | "paused" | "failed" | "idle" | "compacting" | "waiting";
  depth: number;
  model: string | null;
  provider: string | null;
  ageLabel: string;
  cacheHitPct: number | null;
  route: string | null;
};

export type InsightsScheduleRow = {
  id: string;
  name: string;
  fires: number;
  creditUsd: number | null;
  tokens: number | null;
  cacheHitPct: number | null;
  billing: InsightsBillingPath | null;
};

export type WorkspaceInsightsSnapshot = {
  range: InsightsRange;
  rangeLabel: string;
  priorLabel: string;
  seriesLabel: string;
  cacheSeriesLabel: string;
  timezone: "UTC";
  models: InsightsModelUsageRow[];
  facets: InsightsModelFacet[];
  series: InsightsSeriesPoint[];
  depth: InsightsDepthBucket[];
  drivers: InsightsSpendDriver[];
  schedules: InsightsScheduleRow[];
  warmSeconds: number;
  priorWarmSeconds: number;
  warmGroups: InsightsWarmGroupRow[];
  liveWarm: InsightsLiveWarmLease[];
  floor: InsightsFloorSession[];
  selfhostedEnabled: boolean;
  machinesOnline: number;
  workspaceCreditUsd: number;
  priorWorkspaceCreditUsd: number;
  creditUsd: number;
  priorCreditUsd: number;
  priorInputTokens: number;
  priorCacheHitPct: number;
  priorCalls: number;
  goalsActive: number;
  goalsCompleted: number;
  sessionsTouched: number;
  rootSessions: number;
  deepestDepth: number;
  deepestSessionTitle: string;
  avgDepth: number;
  warmIdleNow: number;
  billableTokensUsed: number;
  billableTokenCap: number | null;
  agentRunsUsed: number;
  agentRunCap: number | null;
  modelFilterActive: boolean;
};

export type WorkspaceInsightsResponse = {
  snapshot: WorkspaceInsightsSnapshot;
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
    turnInstructions?: string | undefined;
    resources?: ResourceRef[] | undefined;
    model?: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    latencyMode?: LatencyMode | undefined;
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
  workspaceGeneration: number | null;
  archiveGeneration: number | null;
  archiveComplete: boolean;
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
    | "concurrent_swap"
    | "recovery_in_progress"
    | "recovery_degraded"
    | "recovery_unrecoverable";
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
