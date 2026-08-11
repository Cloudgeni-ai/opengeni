import type { OpenGeniRequestOptions } from "./client";
import type { RetainedArtifactReference } from "./types";

/** Public Browser/Computer protocol version. Driver and provider details stay private. */
export const INTERACTION_PROTOCOL_VERSION = 1 as const;
export const BROWSER_CONTROL_WEBSOCKET_PROTOCOL = "opengeni.browser.v1" as const;
export const COMPUTER_CONTROL_WEBSOCKET_PROTOCOL = "opengeni.computer.v1" as const;
export const BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX = "opengeni.auth." as const;
export const BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES = 64 * 1024;
export const BROWSER_FRAME_MAX_BYTES = 24 * 1024 * 1024;
export const BROWSER_FRAME_MAX_DIMENSION = 32_768;
export const BROWSER_FRAME_MAX_PIXELS = 100_000_000;

export type InteractionJsonValue =
  | null
  | string
  | number
  | boolean
  | InteractionJsonValue[]
  | { [key: string]: InteractionJsonValue };

export type InteractionPlacement =
  | { kind: "sandbox_group"; sandboxGroupId: string }
  | { kind: "connected_machine"; sandboxId: string }
  | { kind: "attached_device"; deviceId: string }
  | { kind: "external_provider"; providerId: string; placementId: string };

export type AttachedBrowserDeviceCapabilities = {
  tabInventory: boolean;
  debuggerAttachment: boolean;
  semanticObservation: boolean;
  screenshots: boolean;
  liveFrames: boolean;
  humanInput: boolean;
  diagnostics: boolean;
  rawCdp: boolean;
  linkedComputer: boolean;
};

/** One live browser-profile endpoint on an enrolled machine. Saved, reusable
 *  login state is represented separately by BrowserIdentity. */
export type AttachedBrowserDevice = {
  id: string;
  accountId: string;
  workspaceId: string;
  enrollmentId: string;
  name: string;
  profileLabel: string | null;
  browserName: string;
  browserVersion: string;
  extensionVersion: string;
  platform: "linux" | "macos" | "windows";
  architecture: "x64" | "arm64";
  state: "connected" | "disconnected";
  connectionGeneration: string;
  inventoryRevision: number;
  tabCount: number;
  capabilities: AttachedBrowserDeviceCapabilities;
  lastSeenAt: string;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AttachedBrowserDeviceListResponse = {
  revision: number;
  devices: AttachedBrowserDevice[];
};

export type InteractionControllerBinding = {
  controllerId: string;
  controllerGeneration: string;
  placementInstanceId: string;
};

export type InteractionAssociation = {
  sessionId: string;
  turnId: string | null;
  attemptId: string | null;
  relationship: "created" | "using" | "observing" | "related";
  actorSubjectId: string;
  lastUsedAt: string;
};

export type InteractionLifecycle =
  | "starting"
  | "active"
  | "suspending"
  | "suspended"
  | "restoring"
  | "repair_required"
  | "lost"
  | "ending"
  | "ended"
  | "failed";

export type BrowserSessionCapabilities = {
  semanticObservation: boolean;
  screenshots: boolean;
  liveFrames: boolean;
  humanInput: boolean;
  tabs: boolean;
  downloads: boolean;
  uploads: boolean;
  clipboard: boolean;
  diagnostics: boolean;
  rawCdp: boolean;
  linkedComputer: boolean;
  privateCheckpoint: boolean;
  identityPublication: boolean;
  parallelTargets: boolean;
};

export type BrowserSession = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  lifecycle: InteractionLifecycle;
  placement: InteractionPlacement;
  controller: InteractionControllerBinding | null;
  driverId: string;
  engine: "chromium" | "chrome" | "firefox" | "webkit" | "lightpanda" | "external";
  engineVersion: string | null;
  headless: boolean;
  identityId: string | null;
  baseRevisionId: string | null;
  networkRouteId: string | null;
  linkedComputerSessionId: string | null;
  capabilities: BrowserSessionCapabilities;
  associations: InteractionAssociation[];
  createdBySubjectId: string;
  createdAt: string;
  lastUsedAt: string;
  failureCode: string | null;
};

export type BrowserIdentityStatus = "active" | "archived";
export type BrowserRevisionComponentKind =
  | "chromium_profile"
  | "normalized_web_state"
  | "provider_snapshot";
export type BrowserRevisionPortability = "portable" | "provider_bound" | "placement_bound";

export type BrowserRevisionMaterialization = {
  portability: BrowserRevisionPortability;
  reason: string | null;
  platform: "linux" | "macos" | "windows" | null;
  architecture: "x64" | "arm64" | null;
  engine: "chromium" | "chrome" | "firefox" | "webkit" | "lightpanda" | "external";
  engineVersion: string | null;
  driverId: string;
  driverSchemaVersion: number;
  profileCrypto: "chromium_basic" | "chromium_mock_keychain" | "platform_bound";
  providerId: string | null;
  placement: InteractionPlacement | null;
};

export type BrowserRevisionComponent = {
  id: string;
  kind: BrowserRevisionComponentKind;
  format: string;
  artifactDigest: string;
  sizeBytes: number;
  materialization: BrowserRevisionMaterialization;
};

export type BrowserRevision = {
  id: string;
  accountId: string;
  workspaceId: string;
  identityId: string;
  parentRevisionId: string | null;
  ordinal: number;
  sourceBrowserSessionId: string;
  manifestDigest: string;
  components: BrowserRevisionComponent[];
  createdBySubjectId: string;
  createdAt: string;
};

export type BrowserIdentity = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: BrowserIdentityStatus;
  defaultRevisionId: string | null;
  headGeneration: number;
  revisionCount: number;
  createdBySubjectId: string;
  createdAt: string;
  updatedAt: string;
};

export type BrowserIdentityListResponse = {
  revision: number;
  identities: BrowserIdentity[];
};

export type BrowserRevisionListResponse = {
  identity: BrowserIdentity;
  revisions: BrowserRevision[];
};

export type CreateBrowserIdentityRequest = {
  operationId: string;
  name: string;
};

export type BrowserIdentityMutationResponse = {
  identity: BrowserIdentity;
  operationId: string;
  replayed: boolean;
};

export type PublishBrowserRevisionRequest = {
  operationId: string;
  identityId: string;
  expectedHeadGeneration: number;
  advanceDefault?: boolean | undefined;
};

export type PublishBrowserRevisionResponse = {
  identity: BrowserIdentity;
  revision: BrowserRevision;
  outcome: "saved_as_default" | "saved_not_default";
  replayed: boolean;
};

export type BrowserTarget = {
  id: string;
  browserSessionId: string;
  controllerGeneration: string;
  targetGeneration: string;
  documentGeneration: string | null;
  kind: "page" | "popup" | "background_page" | "worker";
  title: string;
  url: string;
  selected: boolean;
  attached: boolean;
  createdAt: string;
};

export type InteractionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type InteractionRedactedValue = {
  redacted: true;
  reason: "password" | "payment" | "private" | "policy";
};

export type InteractionSemanticNode = {
  ref: string;
  role: string;
  identifier?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  value?: string | InteractionRedactedValue | undefined;
  states: string[];
  bounds?: InteractionRect | undefined;
  actions: string[];
  children?: InteractionSemanticNode[] | undefined;
  native?: { platform: "dom" | "mac_ax" | "at_spi" | "uia"; data: unknown } | undefined;
};

export type InteractionSemanticSnapshot = {
  kind: "snapshot";
  roots: InteractionSemanticNode[];
  nodeCount: number;
};

export type InteractionSemanticDiff = {
  kind: "diff";
  baseObservationId: string;
  removedRefs: string[];
  changed: InteractionSemanticNode[];
};

export type InteractionDiagnosticSummary = {
  consoleErrorCount: number;
  failedRequestCount: number;
  downloadCount: number;
  pageErrorCount: number;
};

export type BrowserDialog = {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt: string;
  openedAt: string;
};

export type BrowserObservation = {
  protocolVersion: typeof INTERACTION_PROTOCOL_VERSION;
  observationId: string;
  browserSessionId: string;
  target: BrowserTarget;
  frameId: string | null;
  semantic: InteractionSemanticSnapshot | InteractionSemanticDiff | null;
  screenshot: RetainedArtifactReference | null;
  focusedRef: string | null;
  changedRegions: InteractionRect[];
  diagnostics: InteractionDiagnosticSummary;
  dialog: BrowserDialog | null;
  observedAt: string;
};

export type BrowserDiagnosticKind = "console" | "page_error" | "failed_request" | "download";

export type BrowserDiagnosticEntry = {
  sequence: number;
  kind: BrowserDiagnosticKind;
  level: "debug" | "info" | "warning" | "error" | null;
  message: string;
  url: string | null;
  method: string | null;
  status: number | null;
  filename: string | null;
  occurredAt: string;
};

export type BrowserDiagnosticBatch = {
  browserSessionId: string;
  controllerGeneration: string;
  targetId: string;
  targetGeneration: string;
  entries: BrowserDiagnosticEntry[];
  cursor: number;
  truncated: boolean;
};

export type BrowserLocator =
  | { kind: "ref"; ref: string }
  | {
      kind: "role";
      role: string;
      name?: string | undefined;
      exact?: boolean | undefined;
    }
  | { kind: "label"; text: string }
  | { kind: "text"; text: string }
  | { kind: "placeholder"; text: string }
  | { kind: "test_id"; value: string }
  | { kind: "css"; selector: string };

export type BrowserAction =
  | { type: "navigate"; url: string }
  | {
      type: "click";
      locator: BrowserLocator;
      button?: "left" | "right" | "middle" | undefined;
    }
  | { type: "double_click"; locator: BrowserLocator }
  | { type: "hover"; locator: BrowserLocator }
  | { type: "fill"; locator: BrowserLocator; value: string }
  | { type: "type"; locator?: BrowserLocator | undefined; text: string }
  | { type: "press"; locator?: BrowserLocator | undefined; key: string }
  | { type: "select"; locator: BrowserLocator; values: string[] }
  | { type: "check"; locator: BrowserLocator; checked: boolean }
  | {
      type: "scroll";
      locator?: BrowserLocator | undefined;
      deltaX: number;
      deltaY: number;
    }
  | { type: "drag"; from: BrowserLocator; to: BrowserLocator }
  | {
      type: "pointer";
      action: "click" | "double_click" | "move" | "scroll" | "drag";
      x: number;
      y: number;
      endX?: number | undefined;
      endY?: number | undefined;
      deltaX?: number | undefined;
      deltaY?: number | undefined;
      button?: "left" | "right" | "middle" | undefined;
    }
  | {
      type: "handle_dialog";
      response: "accept" | "dismiss";
      promptText?: string | undefined;
    }
  | { type: "upload"; locator: BrowserLocator; workspaceFileIds: string[] }
  | {
      type: "wait";
      condition: "load" | "network_idle" | "visible" | "hidden";
      locator?: BrowserLocator | undefined;
      timeoutMs?: number | undefined;
    };

export type BrowserActionBatch = { type: "batch"; actions: BrowserAction[] };

export type InteractionError = {
  code:
    | "resource_not_found"
    | "resource_unavailable"
    | "controller_stale"
    | "target_not_found"
    | "target_stale"
    | "observation_stale"
    | "document_stale"
    | "frame_stale"
    | "locator_not_found"
    | "locator_ambiguous"
    | "unsupported"
    | "permission_denied"
    | "machine_locked"
    | "attempt_stale"
    | "operation_conflict"
    | "outcome_unknown"
    | "invalid_action"
    | "timeout"
    | "controller_lost"
    | "driver_failed";
  message: string;
  retryable: boolean;
  details?: Record<string, InteractionJsonValue> | undefined;
};

export type InteractionOperationState =
  | "prepared"
  | "dispatched"
  | "completed"
  | "failed"
  | "outcome_unknown";

export type InteractionLifecycleOperationReceipt = {
  operationId: string;
  resourceKind: "browser_session" | "computer_session";
  resourceId: string;
  kind: "create" | "resume" | "suspend" | "end" | "publish";
  state: InteractionOperationState;
  replayed: boolean;
  error: InteractionError | null;
  createdAt: string;
  dispatchedAt: string | null;
  settledAt: string | null;
};

export type CreateBrowserSessionRequest = {
  operationId: string;
  sessionId: string;
  name?: string | undefined;
  initialUrl?: string | undefined;
  headless?: boolean | undefined;
  placement?: InteractionPlacement | undefined;
  identityId?: string | undefined;
  baseRevisionId?: string | undefined;
  linkedComputerSessionId?: string | undefined;
};

export type BrowserSessionListResponse = {
  revision: number;
  sessions: BrowserSession[];
};

export type BrowserSessionMutationResponse = {
  session: BrowserSession;
  operation: InteractionLifecycleOperationReceipt;
};

export type BrowserSessionLifecycleRequest = { operationId: string };
export type BrowserOpenTargetRequest = { url?: string | undefined };

export type BrowserTargetListResponse = {
  browserSessionId: string;
  controllerGeneration: string;
  targets: BrowserTarget[];
};

export type InteractionFrameStreamAttachment<RelayKind extends 3 | 4 = 3 | 4> =
  | { kind: "direct_websocket"; url: string; protocols: string[] }
  | {
      kind: "relay";
      url: string;
      token: string;
      channel: {
        channelId: string;
        workspaceId: string;
        agentId: string;
        kind: RelayKind;
        port: number;
      };
    };

export type BrowserSessionAttachment = {
  browserSessionId: string;
  controllerGeneration: string;
  targetId: string;
  stream: InteractionFrameStreamAttachment<3>;
  expiresAt: string;
};

export type BrowserSessionAttachmentRequest = {
  targetId: string;
  expiresInSeconds?: number | undefined;
  stream?: BrowserFrameStreamOptions | undefined;
};

export type BrowserActionRequest = {
  operationId: string;
  targetId: string;
  expectedTargetGeneration: string;
  expectedDocumentGeneration: string | null;
  expectedFrameId: string | null;
  action: BrowserAction | BrowserActionBatch;
};

export type BrowserActionReceipt = {
  protocolVersion: typeof INTERACTION_PROTOCOL_VERSION;
  operationId: string;
  browserSessionId: string;
  controllerGeneration: string;
  targetId: string;
  state: InteractionOperationState;
  dispatchedAt: string | null;
  settledAt: string | null;
  observation: BrowserObservation | null;
  error: InteractionError | null;
};

export type BrowserSessionHeartbeatResponse = {
  browserSessionId: string;
  controllerGeneration: string;
  alive: true;
};

export type ComputerSessionCapabilities = {
  semanticObservation: boolean;
  appDiscovery: boolean;
  appLaunch: boolean;
  windowCapture: boolean;
  screenCapture: boolean;
  semanticActions: boolean;
  pointerInput: boolean;
  keyboardInput: boolean;
  backgroundActions: boolean;
  parallelApps: boolean;
};

export type ComputerSession = {
  id: string;
  accountId: string;
  workspaceId: string;
  name: string;
  lifecycle: InteractionLifecycle;
  placement: InteractionPlacement;
  controller: InteractionControllerBinding | null;
  platform: "linux" | "macos" | "windows" | null;
  adapter: string | null;
  seatId: string | null;
  displayId: string | null;
  capabilities: ComputerSessionCapabilities | null;
  associations: InteractionAssociation[];
  createdBySubjectId: string;
  createdAt: string;
  lastUsedAt: string;
  failureCode: string | null;
};

export type ComputerTarget = {
  id: string;
  computerSessionId: string;
  controllerGeneration: string;
  targetGeneration: string;
  kind: "app" | "window" | "screen";
  applicationId: string | null;
  processId: number | null;
  title: string;
  bounds: InteractionRect | null;
  focused: boolean;
};

export type ComputerObservation = {
  protocolVersion: typeof INTERACTION_PROTOCOL_VERSION;
  observationId: string;
  computerSessionId: string;
  target: ComputerTarget;
  frameId: string | null;
  semantic: InteractionSemanticSnapshot | InteractionSemanticDiff | null;
  screenshot: RetainedArtifactReference | null;
  focusedRef: string | null;
  changedRegions: InteractionRect[];
  observedAt: string;
};

export type ComputerLocator =
  | { kind: "ref"; ref: string }
  | {
      kind: "role";
      role: string;
      name?: string | undefined;
      exact?: boolean | undefined;
    }
  | { kind: "label"; text: string; exact?: boolean | undefined }
  | { kind: "text"; text: string; exact?: boolean | undefined }
  | { kind: "identifier"; value: string };

export type ComputerAction =
  | {
      type: "semantic";
      locator: ComputerLocator;
      action:
        | "invoke"
        | "focus"
        | "set_value"
        | "increment"
        | "decrement"
        | "select"
        | "deselect"
        | "expand"
        | "collapse"
        | "show_menu"
        | "scroll_into_view";
      value?: string | number | boolean | undefined;
    }
  | {
      type: "pointer";
      frameId: string;
      action: "click" | "double_click" | "move" | "scroll" | "drag";
      x: number;
      y: number;
      endX?: number | undefined;
      endY?: number | undefined;
      deltaX?: number | undefined;
      deltaY?: number | undefined;
      button?: "left" | "right" | "middle" | undefined;
    }
  | { type: "keyboard"; action: "type" | "press"; value: string }
  | { type: "focus"; targetId: string }
  | { type: "launch"; applicationId: string };

export type CreateComputerSessionRequest = {
  operationId: string;
  sessionId: string;
  name?: string | undefined;
  placement?: InteractionPlacement | undefined;
};

export type ComputerSessionListResponse = {
  revision: number;
  sessions: ComputerSession[];
};

export type ComputerSessionMutationResponse = {
  session: ComputerSession;
  operation: InteractionLifecycleOperationReceipt;
};

export type ComputerSessionLifecycleRequest = { operationId: string };

export type ComputerTargetListResponse = {
  computerSessionId: string;
  controllerGeneration: string;
  targets: ComputerTarget[];
};

export type InteractionFrameStreamOptions = {
  format?: "jpeg" | "png" | undefined;
  quality?: number | undefined;
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
  everyNthFrame?: number | undefined;
};

export type ComputerFrameStreamOptions = InteractionFrameStreamOptions;

export type ComputerSessionAttachment = {
  computerSessionId: string;
  controllerGeneration: string;
  targetId: string;
  stream: InteractionFrameStreamAttachment<4>;
  expiresAt: string;
};

export type ComputerSessionAttachmentRequest = {
  targetId: string;
  expiresInSeconds?: number | undefined;
  stream?: ComputerFrameStreamOptions | undefined;
};

export type ComputerActionRequest = {
  operationId: string;
  targetId: string;
  expectedTargetGeneration: string;
  expectedObservationId: string | null;
  expectedFrameId: string | null;
  action: ComputerAction;
};

export type ComputerActionReceipt = {
  protocolVersion: typeof INTERACTION_PROTOCOL_VERSION;
  operationId: string;
  computerSessionId: string;
  controllerGeneration: string;
  targetId: string;
  state: InteractionOperationState;
  dispatchedAt: string | null;
  settledAt: string | null;
  observation: ComputerObservation | null;
  error: InteractionError | null;
};

export type ComputerSessionHeartbeatResponse = {
  computerSessionId: string;
  controllerGeneration: string;
  alive: true;
};

export type BrowserDiagnosticsOptions = {
  kinds?: BrowserDiagnosticKind[] | undefined;
  after?: number | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
};

/** The exact HTTP surface needed by the framework-free interaction client. */
export interface InteractionTransport {
  listAttachedBrowsers(
    workspaceId: string,
    options?: AttachedBrowserDeviceListOptions,
  ): Promise<AttachedBrowserDeviceListResponse>;
  getAttachedBrowser(
    workspaceId: string,
    deviceId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<AttachedBrowserDevice>;
  listBrowserIdentities(
    workspaceId: string,
    options?: BrowserIdentityListOptions,
  ): Promise<BrowserIdentityListResponse>;
  getBrowserIdentity(
    workspaceId: string,
    identityId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserIdentity>;
  createBrowserIdentity(
    workspaceId: string,
    request: CreateBrowserIdentityRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserIdentityMutationResponse>;
  listBrowserRevisions(
    workspaceId: string,
    identityId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserRevisionListResponse>;
  listBrowserSessions(
    workspaceId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionListResponse>;
  getBrowserSession(
    workspaceId: string,
    browserSessionId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSession>;
  createBrowserSession(
    workspaceId: string,
    request: CreateBrowserSessionRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionMutationResponse>;
  listBrowserTargets(
    workspaceId: string,
    browserSessionId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserTargetListResponse>;
  openBrowserTarget(
    workspaceId: string,
    browserSessionId: string,
    request?: BrowserOpenTargetRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserTarget>;
  selectBrowserTarget(
    workspaceId: string,
    browserSessionId: string,
    targetId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserTarget>;
  closeBrowserTarget(
    workspaceId: string,
    browserSessionId: string,
    targetId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserTargetListResponse>;
  observeBrowserTarget(
    workspaceId: string,
    browserSessionId: string,
    targetId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserObservation>;
  actInBrowser(
    workspaceId: string,
    browserSessionId: string,
    request: BrowserActionRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserActionReceipt>;
  getBrowserActionReceipt(
    workspaceId: string,
    browserSessionId: string,
    operationId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserActionReceipt>;
  listBrowserDiagnostics(
    workspaceId: string,
    browserSessionId: string,
    targetId: string,
    options?: BrowserDiagnosticsOptions,
  ): Promise<BrowserDiagnosticBatch>;
  attachBrowserSession(
    workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionAttachmentRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionAttachment>;
  heartbeatBrowserSession(
    workspaceId: string,
    browserSessionId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionHeartbeatResponse>;
  publishBrowserRevision(
    workspaceId: string,
    browserSessionId: string,
    request: PublishBrowserRevisionRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<PublishBrowserRevisionResponse>;
  suspendBrowserSession(
    workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionLifecycleRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionMutationResponse>;
  resumeBrowserSession(
    workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionLifecycleRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionMutationResponse>;
  endBrowserSession(
    workspaceId: string,
    browserSessionId: string,
    request: BrowserSessionLifecycleRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<BrowserSessionMutationResponse>;
  listComputerSessions(
    workspaceId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerSessionListResponse>;
  getComputerSession(
    workspaceId: string,
    computerSessionId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerSession>;
  createComputerSession(
    workspaceId: string,
    request: CreateComputerSessionRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerSessionMutationResponse>;
  listComputerTargets(
    workspaceId: string,
    computerSessionId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerTargetListResponse>;
  observeComputerTarget(
    workspaceId: string,
    computerSessionId: string,
    targetId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerObservation>;
  actInComputer(
    workspaceId: string,
    computerSessionId: string,
    request: ComputerActionRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerActionReceipt>;
  getComputerActionReceipt(
    workspaceId: string,
    computerSessionId: string,
    operationId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerActionReceipt>;
  attachComputerSession(
    workspaceId: string,
    computerSessionId: string,
    request: ComputerSessionAttachmentRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerSessionAttachment>;
  heartbeatComputerSession(
    workspaceId: string,
    computerSessionId: string,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerSessionHeartbeatResponse>;
  endComputerSession(
    workspaceId: string,
    computerSessionId: string,
    request: ComputerSessionLifecycleRequest,
    options?: OpenGeniRequestOptions,
  ): Promise<ComputerSessionMutationResponse>;
}

/** @deprecated Use InteractionTransport. */
export type BrowserInteractionTransport = InteractionTransport;

export type BrowserIdentityListOptions = OpenGeniRequestOptions & {
  includeArchived?: boolean | undefined;
};

export type AttachedBrowserDeviceListOptions = OpenGeniRequestOptions & {
  includeDisconnected?: boolean | undefined;
};

export type CurrentOrOpenBrowserOptions = {
  workspaceId: string;
  associationSessionId: string;
  operationId?: string | undefined;
  name?: string | undefined;
  initialUrl?: string | undefined;
  headless?: boolean | undefined;
  placement?: InteractionPlacement | undefined;
  identityId?: string | undefined;
  baseRevisionId?: string | undefined;
  linkedComputerSessionId?: string | undefined;
  signal?: AbortSignal | undefined;
};

export type CurrentOrOpenComputerOptions = {
  workspaceId: string;
  associationSessionId: string;
  operationId?: string | undefined;
  name?: string | undefined;
  placement?: InteractionPlacement | undefined;
  signal?: AbortSignal | undefined;
};

/** Framework-free resource facade over the public interaction HTTP API. */
export class OpenGeniInteractionClient {
  readonly attachedBrowsers: AttachedBrowserDeviceCollection;
  readonly browsers: BrowserSessionCollection;
  readonly computers: ComputerSessionCollection;
  readonly identities: BrowserIdentityCollection;

  constructor(transport: BrowserInteractionTransport) {
    this.attachedBrowsers = new AttachedBrowserDeviceCollection(transport);
    this.browsers = new BrowserSessionCollection(transport);
    this.computers = new ComputerSessionCollection(transport);
    this.identities = new BrowserIdentityCollection(transport);
  }
}

export class AttachedBrowserDeviceCollection {
  constructor(private readonly transport: BrowserInteractionTransport) {}

  async list(
    workspaceId: string,
    options: AttachedBrowserDeviceListOptions = {},
  ): Promise<AttachedBrowserDeviceListResponse> {
    return await this.transport.listAttachedBrowsers(workspaceId, options);
  }

  device(workspaceId: string, deviceId: string): AttachedBrowserDeviceResource {
    return new AttachedBrowserDeviceResource(this.transport, workspaceId, deviceId);
  }
}

export class AttachedBrowserDeviceResource {
  constructor(
    private readonly transport: BrowserInteractionTransport,
    readonly workspaceId: string,
    readonly id: string,
  ) {}

  async get(options: OpenGeniRequestOptions = {}): Promise<AttachedBrowserDevice> {
    return await this.transport.getAttachedBrowser(this.workspaceId, this.id, options);
  }
}

export class BrowserIdentityCollection {
  constructor(private readonly transport: BrowserInteractionTransport) {}

  async list(
    workspaceId: string,
    options: BrowserIdentityListOptions = {},
  ): Promise<BrowserIdentityListResponse> {
    return await this.transport.listBrowserIdentities(workspaceId, options);
  }

  identity(workspaceId: string, identityId: string): BrowserIdentityResource {
    return new BrowserIdentityResource(this.transport, workspaceId, identityId);
  }

  async create(
    workspaceId: string,
    request: CreateBrowserIdentityRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserIdentityResource> {
    const response = await this.transport.createBrowserIdentity(workspaceId, request, options);
    return this.identity(workspaceId, response.identity.id);
  }
}

export class BrowserIdentityResource {
  constructor(
    private readonly transport: BrowserInteractionTransport,
    readonly workspaceId: string,
    readonly id: string,
  ) {}

  async get(options: OpenGeniRequestOptions = {}): Promise<BrowserIdentity> {
    return await this.transport.getBrowserIdentity(this.workspaceId, this.id, options);
  }

  async revisions(options: OpenGeniRequestOptions = {}): Promise<BrowserRevisionListResponse> {
    return await this.transport.listBrowserRevisions(this.workspaceId, this.id, options);
  }
}

export class BrowserSessionCollection {
  constructor(private readonly transport: BrowserInteractionTransport) {}

  async list(
    workspaceId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserSessionListResponse> {
    return await this.transport.listBrowserSessions(workspaceId, options);
  }

  session(workspaceId: string, browserSessionId: string): BrowserSessionResource {
    return new BrowserSessionResource(this.transport, workspaceId, browserSessionId);
  }

  async open(
    workspaceId: string,
    request: CreateBrowserSessionRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserSessionResource> {
    const response = await this.transport.createBrowserSession(workspaceId, request, options);
    return this.session(workspaceId, response.session.id);
  }

  async currentOrOpen(options: CurrentOrOpenBrowserOptions): Promise<BrowserSessionResource> {
    const requestOptions = options.signal ? { signal: options.signal } : {};
    const listed = await this.list(options.workspaceId, requestOptions);
    const current = newestRelevantBrowser(listed.sessions, options.associationSessionId);
    if (current) {
      const resource = this.session(options.workspaceId, current.id);
      if (current.lifecycle === "suspended") {
        await resource.resume(
          { operationId: options.operationId ?? crypto.randomUUID() },
          requestOptions,
        );
      }
      return resource;
    }
    return await this.open(
      options.workspaceId,
      {
        operationId: options.operationId ?? crypto.randomUUID(),
        sessionId: options.associationSessionId,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.initialUrl !== undefined ? { initialUrl: options.initialUrl } : {}),
        ...(options.headless !== undefined ? { headless: options.headless } : {}),
        ...(options.placement !== undefined ? { placement: options.placement } : {}),
        ...(options.identityId !== undefined ? { identityId: options.identityId } : {}),
        ...(options.baseRevisionId !== undefined ? { baseRevisionId: options.baseRevisionId } : {}),
        ...(options.linkedComputerSessionId !== undefined
          ? { linkedComputerSessionId: options.linkedComputerSessionId }
          : {}),
      },
      requestOptions,
    );
  }
}

export class BrowserSessionResource {
  readonly tabs: BrowserTargetCollection;
  /** Alias for hosts that prefer the protocol term. */
  readonly targets: BrowserTargetCollection;

  constructor(
    private readonly transport: BrowserInteractionTransport,
    readonly workspaceId: string,
    readonly id: string,
  ) {
    this.tabs = new BrowserTargetCollection(transport, workspaceId, id);
    this.targets = this.tabs;
  }

  async get(options: OpenGeniRequestOptions = {}): Promise<BrowserSession> {
    return await this.transport.getBrowserSession(this.workspaceId, this.id, options);
  }

  async observe(
    targetId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserObservation> {
    return await this.transport.observeBrowserTarget(this.workspaceId, this.id, targetId, options);
  }

  async act(
    request: BrowserActionRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserActionReceipt> {
    return await this.transport.actInBrowser(this.workspaceId, this.id, request, options);
  }

  async receipt(
    operationId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserActionReceipt> {
    return await this.transport.getBrowserActionReceipt(
      this.workspaceId,
      this.id,
      operationId,
      options,
    );
  }

  async diagnostics(
    targetId: string,
    options: BrowserDiagnosticsOptions = {},
  ): Promise<BrowserDiagnosticBatch> {
    return await this.transport.listBrowserDiagnostics(
      this.workspaceId,
      this.id,
      targetId,
      options,
    );
  }

  async attach(
    request: BrowserSessionAttachmentRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserSessionAttachment> {
    return await this.transport.attachBrowserSession(this.workspaceId, this.id, request, options);
  }

  async heartbeat(options: OpenGeniRequestOptions = {}): Promise<BrowserSessionHeartbeatResponse> {
    return await this.transport.heartbeatBrowserSession(this.workspaceId, this.id, options);
  }

  async publishRevision(
    request: PublishBrowserRevisionRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<PublishBrowserRevisionResponse> {
    return await this.transport.publishBrowserRevision(this.workspaceId, this.id, request, options);
  }

  async suspend(
    request: BrowserSessionLifecycleRequest = {
      operationId: crypto.randomUUID(),
    },
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserSessionMutationResponse> {
    return await this.transport.suspendBrowserSession(this.workspaceId, this.id, request, options);
  }

  async resume(
    request: BrowserSessionLifecycleRequest = {
      operationId: crypto.randomUUID(),
    },
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserSessionMutationResponse> {
    return await this.transport.resumeBrowserSession(this.workspaceId, this.id, request, options);
  }

  async end(
    request: BrowserSessionLifecycleRequest = {
      operationId: crypto.randomUUID(),
    },
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserSessionMutationResponse> {
    return await this.transport.endBrowserSession(this.workspaceId, this.id, request, options);
  }
}

export class BrowserTargetCollection {
  constructor(
    private readonly transport: BrowserInteractionTransport,
    private readonly workspaceId: string,
    private readonly browserSessionId: string,
  ) {}

  async list(options: OpenGeniRequestOptions = {}): Promise<BrowserTargetListResponse> {
    return await this.transport.listBrowserTargets(
      this.workspaceId,
      this.browserSessionId,
      options,
    );
  }

  async open(url?: string, options: OpenGeniRequestOptions = {}): Promise<BrowserTarget> {
    return await this.transport.openBrowserTarget(
      this.workspaceId,
      this.browserSessionId,
      url === undefined ? {} : { url },
      options,
    );
  }

  async select(targetId: string, options: OpenGeniRequestOptions = {}): Promise<BrowserTarget> {
    return await this.transport.selectBrowserTarget(
      this.workspaceId,
      this.browserSessionId,
      targetId,
      options,
    );
  }

  async close(
    targetId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<BrowserTargetListResponse> {
    return await this.transport.closeBrowserTarget(
      this.workspaceId,
      this.browserSessionId,
      targetId,
      options,
    );
  }
}

export class ComputerSessionCollection {
  constructor(private readonly transport: BrowserInteractionTransport) {}

  async list(
    workspaceId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerSessionListResponse> {
    return await this.transport.listComputerSessions(workspaceId, options);
  }

  session(workspaceId: string, computerSessionId: string): ComputerSessionResource {
    return new ComputerSessionResource(this.transport, workspaceId, computerSessionId);
  }

  async open(
    workspaceId: string,
    request: CreateComputerSessionRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerSessionResource> {
    const response = await this.transport.createComputerSession(workspaceId, request, options);
    return this.session(workspaceId, response.session.id);
  }

  async currentOrOpen(options: CurrentOrOpenComputerOptions): Promise<ComputerSessionResource> {
    const requestOptions = options.signal ? { signal: options.signal } : {};
    const listed = await this.list(options.workspaceId, requestOptions);
    const current = newestRelevantComputer(listed.sessions, options.associationSessionId);
    if (current) {
      return this.session(options.workspaceId, current.id);
    }
    return await this.open(
      options.workspaceId,
      {
        operationId: options.operationId ?? crypto.randomUUID(),
        sessionId: options.associationSessionId,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.placement !== undefined ? { placement: options.placement } : {}),
      },
      requestOptions,
    );
  }
}

export class ComputerSessionResource {
  readonly targets: ComputerTargetCollection;
  /** Native application/window targets are also the public app collection. */
  readonly apps: ComputerTargetCollection;

  constructor(
    private readonly transport: BrowserInteractionTransport,
    readonly workspaceId: string,
    readonly id: string,
  ) {
    this.targets = new ComputerTargetCollection(transport, workspaceId, id);
    this.apps = this.targets;
  }

  async get(options: OpenGeniRequestOptions = {}): Promise<ComputerSession> {
    return await this.transport.getComputerSession(this.workspaceId, this.id, options);
  }

  async observe(
    targetId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerObservation> {
    return await this.transport.observeComputerTarget(this.workspaceId, this.id, targetId, options);
  }

  async act(
    request: ComputerActionRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerActionReceipt> {
    return await this.transport.actInComputer(this.workspaceId, this.id, request, options);
  }

  async receipt(
    operationId: string,
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerActionReceipt> {
    return await this.transport.getComputerActionReceipt(
      this.workspaceId,
      this.id,
      operationId,
      options,
    );
  }

  async attach(
    request: ComputerSessionAttachmentRequest,
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerSessionAttachment> {
    return await this.transport.attachComputerSession(this.workspaceId, this.id, request, options);
  }

  async heartbeat(options: OpenGeniRequestOptions = {}): Promise<ComputerSessionHeartbeatResponse> {
    return await this.transport.heartbeatComputerSession(this.workspaceId, this.id, options);
  }

  async end(
    request: ComputerSessionLifecycleRequest = { operationId: crypto.randomUUID() },
    options: OpenGeniRequestOptions = {},
  ): Promise<ComputerSessionMutationResponse> {
    return await this.transport.endComputerSession(this.workspaceId, this.id, request, options);
  }
}

export class ComputerTargetCollection {
  constructor(
    private readonly transport: BrowserInteractionTransport,
    private readonly workspaceId: string,
    private readonly computerSessionId: string,
  ) {}

  async list(options: OpenGeniRequestOptions = {}): Promise<ComputerTargetListResponse> {
    return await this.transport.listComputerTargets(
      this.workspaceId,
      this.computerSessionId,
      options,
    );
  }
}

export type BrowserFrameMetadata = {
  frameId: string;
  browserSessionId: string;
  controllerGeneration: string;
  targetId: string;
  targetGeneration: string;
  documentGeneration: string;
  sequence: number;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  deviceScaleFactor: number;
  scrollX: number;
  scrollY: number;
  capturedAt: string;
};

export type BrowserFrame = BrowserFrameMetadata & { data: Uint8Array };

export type ComputerFrameMetadata = {
  frameId: string;
  computerSessionId: string;
  controllerGeneration: string;
  targetId: string;
  targetGeneration: string;
  sequence: number;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  capturedAt: string;
  sha256: string;
};

export type ComputerFrame = ComputerFrameMetadata & { data: Uint8Array };

export type BrowserFrameStreamOptions = InteractionFrameStreamOptions;

/** Convert a short-lived HTTP attachment URL into its browser WebSocket URL. */
export function browserFrameSocketUrl(
  attachment: BrowserSessionAttachment,
  options: BrowserFrameStreamOptions = {},
): string {
  if (attachment.stream.kind !== "direct_websocket") {
    throw new Error("relay browser attachments are opened through the relay protocol");
  }
  const url = new URL(attachment.stream.url);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("browser frame attachment did not contain an HTTP or WebSocket URL");
  }
  if (options.format !== undefined) url.searchParams.set("format", options.format);
  setBoundedIntegerQuery(url, "quality", options.quality, 1, 100);
  setBoundedIntegerQuery(url, "maxWidth", options.maxWidth, 1, 4_096);
  setBoundedIntegerQuery(url, "maxHeight", options.maxHeight, 1, 4_096);
  setBoundedIntegerQuery(url, "everyNthFrame", options.everyNthFrame, 1, 60);
  return url.toString();
}

/** Convert a direct ComputerSession attachment into its WebSocket URL. */
export function computerFrameSocketUrl(
  attachment: ComputerSessionAttachment,
  options: ComputerFrameStreamOptions = {},
): string {
  if (attachment.stream.kind !== "direct_websocket") {
    throw new Error("relay computer attachments are opened through the relay protocol");
  }
  const url = new URL(attachment.stream.url);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("computer frame attachment did not contain an HTTP or WebSocket URL");
  }
  if (options.format !== undefined) url.searchParams.set("format", options.format);
  setBoundedIntegerQuery(url, "quality", options.quality, 1, 100);
  setBoundedIntegerQuery(url, "maxWidth", options.maxWidth, 1, 4_096);
  setBoundedIntegerQuery(url, "maxHeight", options.maxHeight, 1, 4_096);
  setBoundedIntegerQuery(url, "everyNthFrame", options.everyNthFrame, 1, 60);
  return url.toString();
}

/** Decode one bounded binary frame message from the placement controller. */
export function decodeBrowserFrameMessage(message: ArrayBuffer | Uint8Array): BrowserFrame {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (
    bytes.byteLength < 5 ||
    bytes.byteLength > 4 + BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES + BROWSER_FRAME_MAX_BYTES
  ) {
    throw new Error("browser frame message is truncated or too large");
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    false,
  );
  if (
    metadataLength < 1 ||
    metadataLength > BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES ||
    metadataLength + 4 >= bytes.byteLength
  ) {
    throw new Error("browser frame metadata length is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + metadataLength)),
    );
  } catch {
    throw new Error("browser frame metadata is invalid JSON");
  }
  const metadata = parseBrowserFrameMetadata(value);
  const data = bytes.slice(4 + metadataLength);
  if (data.byteLength < 1 || data.byteLength > BROWSER_FRAME_MAX_BYTES) {
    throw new Error("browser frame image is empty or too large");
  }
  const dimensions = imageDimensions(data, metadata.mediaType);
  if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) {
    throw new Error("browser frame image dimensions do not match metadata");
  }
  return { ...metadata, data };
}

/** Decode and authenticate one bounded ComputerSession frame. Computer frames
 * carry a content digest because native capture adapters may cross process and
 * relay boundaries before reaching the SDK. */
export async function decodeComputerFrameMessage(
  message: ArrayBuffer | Uint8Array,
): Promise<ComputerFrame> {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
  if (
    bytes.byteLength < 5 ||
    bytes.byteLength > 4 + BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES + BROWSER_FRAME_MAX_BYTES
  ) {
    throw new Error("computer frame message is truncated or too large");
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    false,
  );
  if (
    metadataLength < 1 ||
    metadataLength > BROWSER_CONTROL_MAX_FRAME_HEADER_BYTES ||
    metadataLength + 4 >= bytes.byteLength
  ) {
    throw new Error("computer frame metadata length is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + metadataLength)),
    );
  } catch {
    throw new Error("computer frame metadata is invalid JSON");
  }
  const metadata = parseComputerFrameMetadata(value);
  const data = bytes.slice(4 + metadataLength);
  if (data.byteLength < 1 || data.byteLength > BROWSER_FRAME_MAX_BYTES) {
    throw new Error("computer frame image is empty or too large");
  }
  const dimensions = imageDimensions(data, metadata.mediaType);
  if (dimensions.width !== metadata.width || dimensions.height !== metadata.height) {
    throw new Error("computer frame image dimensions do not match metadata");
  }
  if ((await sha256Hex(data)) !== metadata.sha256) {
    throw new Error("computer frame digest does not match image");
  }
  return { ...metadata, data };
}

export function parseBrowserFrameMetadata(value: unknown): BrowserFrameMetadata {
  if (!isRecord(value)) throw new Error("browser frame metadata is invalid");
  const allowed = new Set([
    "frameId",
    "browserSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "documentGeneration",
    "sequence",
    "mediaType",
    "width",
    "height",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
    "capturedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("browser frame metadata contains unknown fields");
  }
  const strings = [
    "frameId",
    "browserSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "documentGeneration",
    "mediaType",
    "capturedAt",
  ] as const;
  for (const key of strings) {
    const item = value[key];
    const max = key === "targetId" ? 512 : key === "capturedAt" ? 128 : 256;
    if (typeof item !== "string" || item.length < 1 || utf8Bytes(item) > max) {
      throw new Error("browser frame metadata is invalid");
    }
  }
  const numbers = [
    "sequence",
    "width",
    "height",
    "deviceScaleFactor",
    "scrollX",
    "scrollY",
  ] as const;
  for (const key of numbers) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error("browser frame metadata is invalid");
    }
  }
  const metadata = value as unknown as BrowserFrameMetadata;
  if (
    !Number.isSafeInteger(metadata.sequence) ||
    metadata.sequence < 0 ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height)
  ) {
    throw new Error("browser frame metadata integers are invalid");
  }
  assertImageDimensions(metadata.width, metadata.height);
  if (
    metadata.deviceScaleFactor <= 0 ||
    metadata.deviceScaleFactor > 16 ||
    Math.abs(metadata.scrollX) > 1_000_000_000 ||
    Math.abs(metadata.scrollY) > 1_000_000_000
  ) {
    throw new Error("browser frame geometry metadata is invalid");
  }
  if (metadata.mediaType !== "image/jpeg" && metadata.mediaType !== "image/png") {
    throw new Error("browser frame media type is invalid");
  }
  if (!isUuid(metadata.browserSessionId)) throw new Error("browser frame session id is invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(metadata.controllerGeneration)) {
    throw new Error("browser frame controller generation is invalid");
  }
  if (!Number.isFinite(new Date(metadata.capturedAt).valueOf())) {
    throw new Error("browser frame timestamp is invalid");
  }
  return metadata;
}

export function parseComputerFrameMetadata(value: unknown): ComputerFrameMetadata {
  if (!isRecord(value)) throw new Error("computer frame metadata is invalid");
  const allowed = new Set([
    "frameId",
    "computerSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "sequence",
    "mediaType",
    "width",
    "height",
    "capturedAt",
    "sha256",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("computer frame metadata contains unknown fields");
  }
  const strings = [
    "frameId",
    "computerSessionId",
    "controllerGeneration",
    "targetId",
    "targetGeneration",
    "mediaType",
    "capturedAt",
    "sha256",
  ] as const;
  for (const key of strings) {
    const item = value[key];
    const max = key === "targetId" ? 512 : key === "capturedAt" ? 128 : 256;
    if (typeof item !== "string" || item.length < 1 || utf8Bytes(item) > max) {
      throw new Error("computer frame metadata is invalid");
    }
  }
  const metadata = value as unknown as ComputerFrameMetadata;
  if (
    !Number.isSafeInteger(metadata.sequence) ||
    metadata.sequence < 0 ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height)
  ) {
    throw new Error("computer frame metadata integers are invalid");
  }
  assertImageDimensions(metadata.width, metadata.height);
  if (metadata.mediaType !== "image/jpeg" && metadata.mediaType !== "image/png") {
    throw new Error("computer frame media type is invalid");
  }
  if (!isUuid(metadata.computerSessionId)) {
    throw new Error("computer frame session id is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(metadata.controllerGeneration)) {
    throw new Error("computer frame controller generation is invalid");
  }
  if (!Number.isFinite(new Date(metadata.capturedAt).valueOf())) {
    throw new Error("computer frame timestamp is invalid");
  }
  if (!/^[0-9a-f]{64}$/u.test(metadata.sha256)) {
    throw new Error("computer frame digest is invalid");
  }
  return metadata;
}

function newestRelevantBrowser(
  sessions: readonly BrowserSession[],
  associationSessionId: string,
): BrowserSession | null {
  const live = sessions.filter(
    (session) =>
      !["ending", "ended", "failed", "lost"].includes(session.lifecycle) &&
      session.associations.some((association) => association.sessionId === associationSessionId),
  );
  live.sort(
    (left, right) =>
      browserRelevance(right, associationSessionId) - browserRelevance(left, associationSessionId),
  );
  return live[0] ?? null;
}

function newestRelevantComputer(
  sessions: readonly ComputerSession[],
  associationSessionId: string,
): ComputerSession | null {
  const live = sessions.filter(
    (session) =>
      ["starting", "active", "restoring"].includes(session.lifecycle) &&
      session.associations.some((association) => association.sessionId === associationSessionId),
  );
  live.sort(
    (left, right) =>
      computerRelevance(right, associationSessionId) -
      computerRelevance(left, associationSessionId),
  );
  return live[0] ?? null;
}

function browserRelevance(session: BrowserSession, associationSessionId: string): number {
  const association = session.associations
    .filter((item) => item.sessionId === associationSessionId)
    .map((item) => Date.parse(item.lastUsedAt))
    .filter(Number.isFinite)
    .reduce((best, timestamp) => Math.max(best, timestamp), 0);
  const used = Date.parse(session.lastUsedAt);
  return Math.max(association, Number.isFinite(used) ? used : 0);
}

function computerRelevance(session: ComputerSession, associationSessionId: string): number {
  const association = session.associations
    .filter((item) => item.sessionId === associationSessionId)
    .map((item) => Date.parse(item.lastUsedAt))
    .filter(Number.isFinite)
    .reduce((best, timestamp) => Math.max(best, timestamp), 0);
  const used = Date.parse(session.lastUsedAt);
  return Math.max(association, Number.isFinite(used) ? used : 0);
}

function setBoundedIntegerQuery(
  url: URL,
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`browser frame ${name} must be an integer between ${min} and ${max}`);
  }
  url.searchParams.set(name, String(value));
}

function imageDimensions(
  data: Uint8Array,
  mediaType: BrowserFrameMetadata["mediaType"],
): { width: number; height: number } {
  const dimensions = mediaType === "image/png" ? pngDimensions(data) : jpegDimensions(data);
  assertImageDimensions(dimensions.width, dimensions.height);
  return dimensions;
}

function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > BROWSER_FRAME_MAX_DIMENSION ||
    height > BROWSER_FRAME_MAX_DIMENSION ||
    width * height > BROWSER_FRAME_MAX_PIXELS
  ) {
    throw new Error("browser image dimensions exceed their bounded envelope");
  }
}

function pngDimensions(data: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    data.byteLength < 24 ||
    !signature.every((byte, index) => data[index] === byte) ||
    String.fromCharCode(...data.slice(12, 16)) !== "IHDR"
  ) {
    throw new Error("browser returned an invalid PNG image");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error("browser returned an invalid JPEG image");
  }
  let offset = 2;
  while (offset + 3 < data.byteLength) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = data[offset + 1]!;
    while (marker === 0xff) {
      offset += 1;
      marker = data[offset + 1]!;
    }
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= data.byteLength) break;
    const length = (data[offset + 2]! << 8) | data[offset + 3]!;
    if (length < 2 || offset + 2 + length > data.byteLength) break;
    if (isJpegStartOfFrame(marker)) {
      if (length < 7 || offset + 8 >= data.byteLength) break;
      return {
        height: (data[offset + 5]! << 8) | data[offset + 6]!,
        width: (data[offset + 7]! << 8) | data[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  throw new Error("browser returned a JPEG without dimensions");
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("computer frame digest verification is unavailable");
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const digest = new Uint8Array(await subtle.digest("SHA-256", copy));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
