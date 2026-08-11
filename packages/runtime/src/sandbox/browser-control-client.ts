import { randomUUID } from "node:crypto";
import { posix as posixPath } from "node:path";
import {
  BROWSER_CONTROL_MAX_JSON_BYTES,
  BROWSER_CONTROL_PORT,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BROWSER_STATE_ARTIFACT_CONTENT_TYPE,
  BrowserActionCommand,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserDownload,
  BrowserDownloadExportReceipt,
  BrowserDownloadExportRequest,
  BrowserDownloadListResponse,
  BrowserExternalAuthCommand,
  BrowserExternalAuthResult,
  BrowserObservation,
  BrowserProtectedAuthFillCommand,
  BrowserProtectedAuthFillReceipt,
  BrowserRevisionMaterialization,
  BrowserTarget,
  BrowserWorkspaceFileStageRequest,
  BrowserWorkspaceFileStageResponse,
  ComputerActionCommand,
  ComputerActionReceipt,
  ComputerClipboard,
  ComputerObservation,
  ComputerSessionCapabilities,
  ComputerTarget,
  InteractionError,
  NetworkRouteConsistency,
  type BrowserActionCommand as BrowserActionCommandValue,
  type BrowserActionReceipt as BrowserActionReceiptValue,
  type BrowserClipboard as BrowserClipboardValue,
  type BrowserDiagnosticBatch as BrowserDiagnosticBatchValue,
  type BrowserDownload as BrowserDownloadValue,
  type BrowserDownloadExportReceipt as BrowserDownloadExportReceiptValue,
  type BrowserDownloadExportRequest as BrowserDownloadExportRequestValue,
  type BrowserDownloadListResponse as BrowserDownloadListResponseValue,
  type BrowserExternalAuthCommand as BrowserExternalAuthCommandValue,
  type BrowserExternalAuthResult as BrowserExternalAuthResultValue,
  type BrowserDiagnosticKind,
  type BrowserObservation as BrowserObservationValue,
  type BrowserProtectedAuthFillCommand as BrowserProtectedAuthFillCommandValue,
  type BrowserProtectedAuthFillReceipt as BrowserProtectedAuthFillReceiptValue,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
  type BrowserTarget as BrowserTargetValue,
  type BrowserWorkspaceFileStageRequest as BrowserWorkspaceFileStageRequestValue,
  type BrowserWorkspaceFileStageResponse as BrowserWorkspaceFileStageResponseValue,
  type ComputerActionCommand as ComputerActionCommandValue,
  type ComputerActionReceipt as ComputerActionReceiptValue,
  type ComputerClipboard as ComputerClipboardValue,
  type ComputerObservation as ComputerObservationValue,
  type ComputerSessionCapabilities as ComputerSessionCapabilitiesValue,
  type ComputerTarget as ComputerTargetValue,
  type InteractionError as InteractionErrorValue,
  type NetworkRouteConsistency as NetworkRouteConsistencyValue,
} from "@opengeni/contracts";
import type {
  BrowserControlEnsureRequest,
  BrowserControlEnsureResponse,
  BrowserFramesOpenRequest,
  ComputerFramesOpenRequest,
  StreamChannel,
} from "@opengeni/agent-proto";
import {
  ensureBrowserControlServer,
  type EnsureBrowserControlServerResult,
} from "./browser-control-server";
import { parseExecResponseBanner } from "./exec-banner";
import { buildStreamUrl, type ExposedPortEndpoint } from "./stream-port";

const CLIENT_ROOT = "/tmp/opengeni-browser-control-client";
export const BROWSER_CONTROL_ADMIN_TOKEN_FILE = "/tmp/opengeni-browserd/authority/admin-token";
const COMMAND_OK = "OPENGENI_BROWSER_CONTROL_CLIENT_OK";
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,2048}$/u;
const MAX_REQUEST_TIMEOUT_MS = 20 * 60_000;
const BROWSER_STATE_TRANSFER_TIMEOUT_MS = 20 * 60_000;
const PRIVATE_READ_CHUNK_BYTES = 512 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

// Connected-machine browserd binds an OS-assigned loopback port. The agent
// owns that endpoint, so the API must never fall back to the image port merely
// because a fresh request constructed a fresh client. Cache the negotiated
// endpoint by its physical authority fence; a transport failure invalidates it
// and performs one idempotent ensure/retry below.
const nativeControllerPorts = new Map<string, number>();

type ExecResultLike = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  sessionId?: number;
};

export type BrowserControlPlacementSession = {
  exec?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<ExecResultLike | string>;
  execCommand?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
  readFile?: (args: { path: string; maxBytes?: number }) => Promise<string | Uint8Array>;
  writeFile?: (args: {
    path: string;
    content: string | Uint8Array;
    createParents?: boolean;
  }) => Promise<unknown>;
  writePlacementPrivate?: (args: {
    path: string;
    content: string | Uint8Array;
    createParents?: boolean;
  }) => Promise<unknown>;
  deletePlacementPrivate?: (path: string) => Promise<void>;
  writeStdin?: (args: {
    sessionId: number;
    chars?: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
  resolveExposedPort?: (port: number) => Promise<ExposedPortEndpoint>;
  ensureBrowserControl?: (
    request: BrowserControlEnsureRequest,
  ) => Promise<BrowserControlEnsureResponse>;
  openBrowserFrames?: (
    request: BrowserFramesOpenRequest,
  ) => Promise<{ channel: StreamChannel; endpoint: ExposedPortEndpoint }>;
  openComputerFrames?: (
    request: ComputerFramesOpenRequest,
  ) => Promise<{ channel: StreamChannel; endpoint: ExposedPortEndpoint }>;
  finalizeOpStreamOps?: () => Promise<void>;
};

export type PlacementBrowserSessionReference = {
  browserSessionId: string;
  controllerGeneration: string;
};

export type PlacementBrowserSession = PlacementBrowserSessionReference & {
  observation: BrowserObservationValue;
};

export type PlacementComputerSessionReference = {
  computerSessionId: string;
  controllerGeneration: string;
};

export type PlacementComputerSession = PlacementComputerSessionReference & {
  platform: "linux" | "macos" | "windows";
  adapter: string;
  seatId: string;
  displayId: string;
  capabilities: ComputerSessionCapabilitiesValue;
  targets: ComputerTargetValue[];
};

export type CreatePlacementComputerSessionInput = PlacementComputerSessionReference & {
  tokenGeneration: number;
  controlToken: string;
  viewToken: string;
};

export type CreatePlacementBrowserSessionInput = PlacementBrowserSessionReference & {
  tokenGeneration: number;
  controlToken: string;
  viewToken: string;
  headed: boolean;
  initialUrl?: string;
  restore?: RestorePlacementBrowserStateInput;
  transport?: PlacementBrowserTransport;
  linkedComputer?: PlacementComputerSessionReference;
  networkRoute?: PlacementBrowserNetworkRoute;
};

export type PlacementBrowserNetworkRoute = {
  routeId: string;
  routeVersion: number;
  authorityDigest: string;
  kind: "direct" | "proxy" | "managed" | "tunnel";
  consistency: NetworkRouteConsistencyValue;
  /** Present for an initial authenticated-proxy launch; omitted only when
   * replaying an already-live controller after the referenced credential was
   * rotated. Never persisted or returned by the controller. */
  proxyUrl?: string;
  /** Provider-native egress selector. Provider API authority remains on the
   * external transport and is never duplicated into this route material. */
  providerRoute?: {
    providerId: "browserbase" | "kernel";
    routeId: string;
    egressClass: "datacenter" | "residential" | "isp";
    region: string | null;
  };
};

export type PlacementBrowserTransport =
  | { kind: "managed"; engine?: "chromium" | "lightpanda" }
  | {
      kind: "external_provider";
      providerId: "browserbase" | "kernel";
      placementId: string;
      /** Private launch authority. Browserd never returns or journals it. */
      authority: {
        apiKey: string;
        endpoint?: string;
      };
      timeoutSeconds?: number;
      stealth?: boolean;
    }
  | {
      kind: "attached_chrome";
      deviceId: string;
      connectionGeneration: string;
      browserName: string;
      browserVersion: string;
    };

export type BrowserViewGrant = {
  grantId: string;
  expiresAt: string;
};

export type BrowserStateUploadGrant = {
  url: string;
  requiredHeaders: Readonly<Record<string, string>>;
  expiresAt: string;
};

export type BrowserStateDownloadGrant = {
  url: string;
  expiresAt: string;
};

export type RestorePlacementBrowserStateInput = {
  objectKey: string;
  format: typeof BROWSER_PROFILE_ARTIFACT_FORMAT;
  artifactDigest: string;
  contentDigest: string;
  manifestDigest: string;
  sizeBytes: number;
  dataKey: Uint8Array;
  aad: Uint8Array;
  materialization: BrowserRevisionMaterializationValue;
  download: BrowserStateDownloadGrant;
};

export type CapturePlacementBrowserStateInput = PlacementBrowserSessionReference & {
  operationId: string;
  objectKey: string;
  afterCapture: "restart" | "stop";
  dataKey: Uint8Array;
  aad: Uint8Array;
  upload: BrowserStateUploadGrant;
};

export type PlacementBrowserStateCaptureReceipt = PlacementBrowserSessionReference & {
  operationId: string;
  objectKey: string;
  format: typeof BROWSER_PROFILE_ARTIFACT_FORMAT;
  artifactDigest: string;
  contentDigest: string;
  sizeBytes: number;
  fileCount: number;
  profileBytes: number;
  manifest: {
    schemaVersion: 1;
    browserSessionId: string;
    controllerGeneration: string;
    capturedAt: string;
    engine: "chromium" | "chrome";
    engineVersion: string | null;
    driverId: string;
    driverSchemaVersion: number;
    profileCrypto: "chromium_basic" | "chromium_mock_keychain" | "platform_bound";
    platform: "linux" | "macos" | "windows";
    architecture: "x64" | "arm64";
    tabs: Array<{ url: string; selected: boolean }>;
  };
};

export type ProvisionBrowserControlClientInput = {
  adminToken: string;
  adminTokenFile?: string;
  allowedOrigins?: readonly string[];
  port?: number;
  timeoutMs?: number;
  /** Native connected-machine sidecar authority. Ignored by image-backed
   * placements, whose browserd is already supervised inside the sandbox image. */
  nativeAuthority?: {
    scopeId: string;
    scopeGeneration: string;
  };
};

export type ProvisionBrowserControlClientResult = {
  client: BrowserControlClient;
  server: EnsureBrowserControlServerResult;
};

export class BrowserControlTransportError extends Error {
  readonly name = "BrowserControlTransportError";
  readonly retryable = true;
}

export class BrowserControlProtocolError extends Error {
  readonly name = "BrowserControlProtocolError";
  readonly retryable = false;
}

export class BrowserControlRequestError extends Error {
  readonly name = "BrowserControlRequestError";
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    readonly error: InteractionErrorValue,
  ) {
    super(error.message);
    this.retryable = error.retryable;
  }
}

export class BrowserControlUnsupportedError extends Error {
  readonly name = "BrowserControlUnsupportedError";
}

/** Install one placement-stable admin credential and start the pinned controller. */
export async function provisionBrowserControlClient(
  session: BrowserControlPlacementSession,
  input: ProvisionBrowserControlClientInput,
): Promise<ProvisionBrowserControlClientResult> {
  requirePlacementRequestSurface(session);
  const adminToken = requireToken(input.adminToken, "browser controller admin token");
  if (session.ensureBrowserControl) {
    if (!input.nativeAuthority) {
      throw new BrowserControlProtocolError(
        "connected browser placement is missing its controller authority scope",
      );
    }
    const ensured = await session.ensureBrowserControl({
      scopeId: input.nativeAuthority.scopeId,
      scopeGeneration: input.nativeAuthority.scopeGeneration,
      adminToken,
      allowedOrigins: [...(input.allowedOrigins ?? [])],
    });
    const port = boundedPort(ensured.port);
    nativeControllerPorts.set(nativeControllerKey(input.nativeAuthority), port);
    return {
      client: new BrowserControlClient(session, {
        adminToken,
        port,
        nativeAuthority: input.nativeAuthority,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      }),
      server: { port, marker: `agent:${ensured.sidecarGeneration}` },
    };
  }
  const adminTokenFile = absolutePrivatePath(
    input.adminTokenFile ?? BROWSER_CONTROL_ADMIN_TOKEN_FILE,
    "browser controller admin token file",
  );
  const temporaryTokenFile = `${adminTokenFile}.new.${randomUUID()}`;
  const parent = adminTokenFile.slice(0, adminTokenFile.lastIndexOf("/")) || "/";
  try {
    await runChecked(
      session,
      `umask 077; install -d -m 0700 -- ${shellQuote(parent)}; printf '%s\\n' ${shellQuote(COMMAND_OK)}`,
      input.timeoutMs,
    );
    await writePrivateFile(
      session,
      {
        path: temporaryTokenFile,
        content: `${adminToken}\n`,
        createParents: false,
      },
      input.timeoutMs,
    );
    await runChecked(
      session,
      `chmod 0600 -- ${shellQuote(temporaryTokenFile)}; mv -f -- ${shellQuote(temporaryTokenFile)} ${shellQuote(adminTokenFile)}; printf '%s\\n' ${shellQuote(COMMAND_OK)}`,
      input.timeoutMs,
    );
    const server = await ensureBrowserControlServer(session, {
      adminTokenFile,
      ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const client = new BrowserControlClient(session, {
      adminToken,
      port: server.port,
      ...(input.nativeAuthority ? { nativeAuthority: input.nativeAuthority } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    if (input.allowedOrigins && input.allowedOrigins.length > 0) {
      await client.addAllowedOrigins(input.allowedOrigins);
    }
    return { client, server };
  } finally {
    await runBestEffort(session, `rm -f -- ${shellQuote(temporaryTokenFile)}`);
    await session.finalizeOpStreamOps?.().catch(() => undefined);
  }
}

export class BrowserControlClient {
  readonly port: number;
  private readonly session: BrowserControlPlacementSession;
  private readonly adminToken: string;
  private readonly timeoutMs: number;
  private readonly nativeAuthority: { scopeId: string; scopeGeneration: string } | undefined;

  constructor(
    session: BrowserControlPlacementSession,
    options: {
      adminToken: string;
      port?: number;
      timeoutMs?: number;
      nativeAuthority?: { scopeId: string; scopeGeneration: string };
    },
  ) {
    requirePlacementRequestSurface(session);
    this.session = session;
    this.adminToken = requireToken(options.adminToken, "browser controller admin token");
    this.port = boundedPort(options.port ?? BROWSER_CONTROL_PORT);
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? 60_000);
    this.nativeAuthority = options.nativeAuthority;
  }

  async addAllowedOrigins(origins: readonly string[]): Promise<readonly string[]> {
    if (origins.length === 0 || origins.length > 64) {
      throw new RangeError("browser controller origin list size is invalid");
    }
    const normalized = origins.map(normalizeOrigin);
    const data = await this.requestJson({
      method: "PUT",
      path: "/v1/origins",
      token: this.adminToken,
      body: { origins: normalized },
    });
    if (!isRecord(data) || !Array.isArray(data.origins)) {
      throw new BrowserControlProtocolError("browser controller returned malformed origins");
    }
    return data.origins.map((origin) => normalizeOrigin(origin));
  }

  async createSession(input: CreatePlacementBrowserSessionInput): Promise<PlacementBrowserSession> {
    const reference = parseReference(input);
    const restore = input.restore ? browserStateRestoreRequest(input.restore) : null;
    let data: unknown;
    try {
      data = await this.requestJson({
        method: "POST",
        path: "/v1/browser-sessions",
        token: this.adminToken,
        body: {
          ...reference,
          tokenGeneration: positiveSafeInteger(input.tokenGeneration, "token generation"),
          controlToken: requireToken(input.controlToken, "browser control token"),
          viewToken: requireToken(input.viewToken, "browser view token"),
          headed: input.headed,
          ...(input.initialUrl === undefined ? {} : { initialUrl: boundedUrl(input.initialUrl) }),
          ...(input.transport ? { transport: placementBrowserTransport(input.transport) } : {}),
          ...(input.linkedComputer
            ? { linkedComputer: parseComputerReference(input.linkedComputer) }
            : {}),
          ...(input.networkRoute
            ? { networkRoute: placementBrowserNetworkRoute(input.networkRoute) }
            : {}),
          ...(restore ? { restore: restore.wire } : {}),
        },
        ...(restore ? { timeoutMs: BROWSER_STATE_TRANSFER_TIMEOUT_MS } : {}),
      });
    } finally {
      restore?.dataKey.fill(0);
      restore?.aad.fill(0);
    }
    if (!isRecord(data)) {
      throw new BrowserControlProtocolError("browser controller returned malformed session data");
    }
    const returnedReference = parseReference(data);
    if (
      returnedReference.browserSessionId !== reference.browserSessionId ||
      returnedReference.controllerGeneration !== reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError("browser controller returned another session binding");
    }
    return {
      ...returnedReference,
      observation: BrowserObservation.parse(data.observation),
    };
  }

  async createComputerSession(
    input: CreatePlacementComputerSessionInput,
  ): Promise<PlacementComputerSession> {
    const reference = parseComputerReference(input);
    const data = await this.requestJson({
      method: "POST",
      path: "/v1/computer-sessions",
      token: this.adminToken,
      body: {
        ...reference,
        tokenGeneration: positiveSafeInteger(input.tokenGeneration, "token generation"),
        controlToken: requireToken(input.controlToken, "computer control token"),
        viewToken: requireToken(input.viewToken, "computer view token"),
      },
    });
    if (!isRecord(data) || !Array.isArray(data.targets)) {
      throw new BrowserControlProtocolError(
        "interaction controller returned malformed computer session data",
      );
    }
    const returned = parseComputerReference(data);
    if (
      returned.computerSessionId !== reference.computerSessionId ||
      returned.controllerGeneration !== reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError(
        "interaction controller returned another computer session binding",
      );
    }
    const platform = data.platform;
    if (platform !== "linux" && platform !== "macos" && platform !== "windows") {
      throw new BrowserControlProtocolError(
        "interaction controller returned an invalid computer platform",
      );
    }
    return {
      ...returned,
      platform,
      adapter: requireOpaqueId(data.adapter, "computer adapter"),
      seatId: requireOpaqueId(data.seatId, "computer seat id"),
      displayId: requireOpaqueId(data.displayId, "computer display id"),
      capabilities: ComputerSessionCapabilities.parse(data.capabilities),
      targets: data.targets.map((target) => ComputerTarget.parse(target)),
    };
  }

  async endSession(
    reference: PlacementBrowserSessionReference,
    options: { removeState: boolean },
  ): Promise<void> {
    const binding = parseReference(reference);
    const data = await this.requestJson({
      method: "POST",
      path: `/v1/browser-sessions/${binding.browserSessionId}/end`,
      token: this.adminToken,
      body: {
        controllerGeneration: binding.controllerGeneration,
        removeState: options.removeState,
      },
    });
    if (!isRecord(data) || data.ended !== true) {
      throw new BrowserControlProtocolError("browser controller returned malformed end receipt");
    }
  }

  async endComputerSession(
    reference: PlacementComputerSessionReference,
    options: { removeState: boolean },
  ): Promise<void> {
    const binding = parseComputerReference(reference);
    const data = await this.requestJson({
      method: "POST",
      path: `/v1/computer-sessions/${binding.computerSessionId}/end`,
      token: this.adminToken,
      body: {
        controllerGeneration: binding.controllerGeneration,
        removeState: options.removeState,
      },
    });
    if (!isRecord(data) || data.ended !== true) {
      throw new BrowserControlProtocolError(
        "interaction controller returned malformed computer end receipt",
      );
    }
  }

  async createViewGrant(
    reference: PlacementBrowserSessionReference,
    input: { grantId: string; token: string; expiresAt: string },
  ): Promise<BrowserViewGrant> {
    const binding = parseReference(reference);
    const grantId = requireUuid(input.grantId, "view grant id");
    const expiresAt = timestamp(input.expiresAt, "view grant expiry");
    const data = await this.requestJson({
      method: "POST",
      path: `/v1/browser-sessions/${binding.browserSessionId}/view-grants`,
      token: this.adminToken,
      body: {
        grantId,
        controllerGeneration: binding.controllerGeneration,
        token: requireToken(input.token, "view grant token"),
        expiresAt,
      },
    });
    if (!isRecord(data) || data.grantId !== grantId || data.expiresAt !== expiresAt) {
      throw new BrowserControlProtocolError("browser controller returned malformed view grant");
    }
    return { grantId, expiresAt };
  }

  async createComputerViewGrant(
    reference: PlacementComputerSessionReference,
    input: { grantId: string; token: string; expiresAt: string },
  ): Promise<BrowserViewGrant> {
    const binding = parseComputerReference(reference);
    const grantId = requireUuid(input.grantId, "computer view grant id");
    const expiresAt = timestamp(input.expiresAt, "computer view grant expiry");
    const data = await this.requestJson({
      method: "POST",
      path: `/v1/computer-sessions/${binding.computerSessionId}/view-grants`,
      token: this.adminToken,
      body: {
        grantId,
        controllerGeneration: binding.controllerGeneration,
        token: requireToken(input.token, "computer view grant token"),
        expiresAt,
      },
    });
    if (!isRecord(data) || data.grantId !== grantId || data.expiresAt !== expiresAt) {
      throw new BrowserControlProtocolError(
        "interaction controller returned malformed computer view grant",
      );
    }
    return { grantId, expiresAt };
  }

  /** Quiesce one exact controller, upload its encrypted working profile, and
   * return only integrity/compatibility metadata. Secret authority is carried
   * in a private placement request file and never returned by browserd. */
  async captureState(
    input: CapturePlacementBrowserStateInput,
  ): Promise<PlacementBrowserStateCaptureReceipt> {
    const reference = parseReference(input);
    const operationId = requireUuid(input.operationId, "browser state operation id");
    const objectKey = browserStateObjectKey(input.objectKey);
    const dataKey = exactBytes(input.dataKey, 32, "browser state data key");
    const aad = boundedBytes(input.aad, 1, 16 * 1024, "browser state associated data");
    const upload = browserStateUploadGrant(input.upload);
    const data = await this.requestJson({
      method: "POST",
      path: `/v1/browser-sessions/${reference.browserSessionId}/state-captures`,
      token: this.adminToken,
      body: {
        operationId,
        controllerGeneration: reference.controllerGeneration,
        objectKey,
        afterCapture: input.afterCapture,
        dataKeyBase64: Buffer.from(dataKey).toString("base64"),
        aadBase64: Buffer.from(aad).toString("base64"),
        upload,
      },
      timeoutMs: BROWSER_STATE_TRANSFER_TIMEOUT_MS,
    });
    const receipt = parseStateCaptureReceipt(data);
    if (
      receipt.operationId !== operationId ||
      receipt.browserSessionId !== reference.browserSessionId ||
      receipt.controllerGeneration !== reference.controllerGeneration ||
      receipt.objectKey !== objectKey
    ) {
      throw new BrowserControlProtocolError(
        "browser controller returned another state-capture binding",
      );
    }
    return receipt;
  }

  sessionClient(input: {
    reference: PlacementBrowserSessionReference;
    controlToken: string;
    viewToken: string;
  }): BrowserControlSessionClient {
    return new BrowserControlSessionClient(this, input);
  }

  computerSessionClient(input: {
    reference: PlacementComputerSessionReference;
    controlToken: string;
    viewToken: string;
  }): ComputerControlSessionClient {
    return new ComputerControlSessionClient(this, input);
  }

  async frameStreamUrl(
    reference: PlacementBrowserSessionReference,
    targetId: string,
  ): Promise<string> {
    const binding = parseReference(reference);
    if (!this.session.resolveExposedPort) {
      throw new BrowserControlUnsupportedError(
        "browser placement cannot expose its live-frame port",
      );
    }
    const endpoint = await this.session.resolveExposedPort(this.port);
    const providerPath = endpoint.path ?? "/";
    if (providerPath !== "/") {
      throw new BrowserControlUnsupportedError(
        "browser placement requires a native HTTP/WebSocket relay",
      );
    }
    const path = `/v1/browser-sessions/${binding.browserSessionId}/targets/${encodeURIComponent(requireOpaqueId(targetId, "target id"))}/frames`;
    return buildStreamUrl({ ...endpoint, path });
  }

  async computerFrameStreamUrl(
    reference: PlacementComputerSessionReference,
    targetId: string,
  ): Promise<string> {
    const binding = parseComputerReference(reference);
    if (!this.session.resolveExposedPort) {
      throw new BrowserControlUnsupportedError(
        "computer placement cannot expose its live-frame port",
      );
    }
    const endpoint = await this.session.resolveExposedPort(this.port);
    if ((endpoint.path ?? "/") !== "/") {
      throw new BrowserControlUnsupportedError(
        "computer placement requires a native HTTP/WebSocket relay",
      );
    }
    const path = `/v1/computer-sessions/${binding.computerSessionId}/targets/${encodeURIComponent(requireOpaqueId(targetId, "computer target id"))}/frames`;
    return buildStreamUrl({ ...endpoint, path });
  }

  async computerRfbStreamUrl(
    reference: PlacementComputerSessionReference,
    targetId: string,
  ): Promise<string> {
    const binding = parseComputerReference(reference);
    if (!this.session.resolveExposedPort) {
      throw new BrowserControlUnsupportedError(
        "computer placement cannot expose its live RFB port",
      );
    }
    const endpoint = await this.session.resolveExposedPort(this.port);
    if ((endpoint.path ?? "/") !== "/") {
      throw new BrowserControlUnsupportedError(
        "computer placement requires a native HTTP/WebSocket relay",
      );
    }
    const path = `/v1/computer-sessions/${binding.computerSessionId}/targets/${encodeURIComponent(requireOpaqueId(targetId, "computer target id"))}/rfb`;
    return buildStreamUrl({ ...endpoint, path });
  }

  /** Open the browser frame source through the connected-machine relay adapter.
   * Returns null on image-backed placements, which expose browserd directly. */
  async openRelayedFrameStream(input: {
    reference: PlacementBrowserSessionReference;
    targetId: string;
    viewToken: string;
    expiresAt: string;
    stream?: {
      format?: "jpeg" | "png" | undefined;
      quality?: number | undefined;
      maxWidth?: number | undefined;
      maxHeight?: number | undefined;
      everyNthFrame?: number | undefined;
    };
  }): Promise<{
    channel: StreamChannel;
    endpoint: ExposedPortEndpoint;
  } | null> {
    if (!this.session.openBrowserFrames) return null;
    if (!this.nativeAuthority) {
      throw new BrowserControlProtocolError(
        "connected browser placement is missing its controller authority scope",
      );
    }
    const reference = parseReference(input.reference);
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new BrowserControlProtocolError("browser view grant expiry is invalid");
    }
    const stream = input.stream ?? {};
    return await this.session.openBrowserFrames({
      scopeId: this.nativeAuthority.scopeId,
      scopeGeneration: this.nativeAuthority.scopeGeneration,
      browserSessionId: reference.browserSessionId,
      controllerGeneration: reference.controllerGeneration,
      targetId: requireOpaqueId(input.targetId, "target id"),
      viewToken: requireToken(input.viewToken, "browser view grant"),
      expiresAtMs: String(expiresAtMs),
      format: stream.format ?? "jpeg",
      quality: boundedInteger(stream.quality ?? 70, 1, 100, "browser frame quality"),
      maxWidth: boundedInteger(stream.maxWidth ?? 1_440, 1, 4_096, "browser frame width"),
      maxHeight: boundedInteger(stream.maxHeight ?? 900, 1, 4_096, "browser frame height"),
      everyNthFrame: boundedInteger(
        stream.everyNthFrame ?? 1,
        1,
        60,
        "browser frame sampling interval",
      ),
    });
  }

  /** Open a ComputerSession frame source through the connected-machine relay.
   * Image-backed placements return null and expose browserd directly. */
  async openRelayedComputerFrameStream(input: {
    reference: PlacementComputerSessionReference;
    targetId: string;
    viewToken: string;
    expiresAt: string;
    stream?: {
      format?: "jpeg" | "png" | undefined;
      quality?: number | undefined;
      maxWidth?: number | undefined;
      maxHeight?: number | undefined;
      everyNthFrame?: number | undefined;
    };
  }): Promise<{
    channel: StreamChannel;
    endpoint: ExposedPortEndpoint;
  } | null> {
    if (!this.session.openComputerFrames) return null;
    if (!this.nativeAuthority) {
      throw new BrowserControlProtocolError(
        "connected computer placement is missing its controller authority scope",
      );
    }
    const reference = parseComputerReference(input.reference);
    const expiresAtMs = Date.parse(input.expiresAt);
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw new BrowserControlProtocolError("computer view grant expiry is invalid");
    }
    const stream = input.stream ?? {};
    return await this.session.openComputerFrames({
      scopeId: this.nativeAuthority.scopeId,
      scopeGeneration: this.nativeAuthority.scopeGeneration,
      computerSessionId: reference.computerSessionId,
      controllerGeneration: reference.controllerGeneration,
      targetId: requireOpaqueId(input.targetId, "computer target id"),
      viewToken: requireToken(input.viewToken, "computer view grant"),
      expiresAtMs: String(expiresAtMs),
      format: stream.format ?? "jpeg",
      quality: boundedInteger(stream.quality ?? 70, 1, 100, "computer frame quality"),
      maxWidth: boundedInteger(stream.maxWidth ?? 4_096, 1, 4_096, "computer frame width"),
      maxHeight: boundedInteger(stream.maxHeight ?? 4_096, 1, 4_096, "computer frame height"),
      everyNthFrame: boundedInteger(
        stream.everyNthFrame ?? 1,
        1,
        60,
        "computer frame sampling interval",
      ),
    });
  }

  async requestForSession(input: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    token: string;
    body?: unknown;
    timeoutMs?: number;
  }): Promise<unknown> {
    return await this.requestJson(input);
  }

  private async requestJson(
    input: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      path: string;
      token: string;
      body?: unknown;
      timeoutMs?: number;
    },
    retryNativeEndpoint = true,
  ): Promise<unknown> {
    // Image-backed placements expose browserd through the provider tunnel. Use
    // that actual data plane for control too: one authenticated HTTP request,
    // instead of materializing files and starting curl through the sandbox exec
    // API for every click or key. Connected machines keep their agent transport.
    if (this.session.resolveExposedPort && !this.session.ensureBrowserControl) {
      try {
        const endpoint = await this.session.resolveExposedPort(this.port);
        if ((endpoint.path ?? "/") === "/") {
          return await requestExposedController(endpoint, input, this.timeoutMs);
        }
      } catch (error) {
        if (
          error instanceof BrowserControlRequestError ||
          error instanceof BrowserControlProtocolError ||
          error instanceof RangeError
        ) {
          throw error;
        }
        // Port discovery or its transport can fail transiently. The existing
        // idempotent operation journal makes the private exec fallback safe even
        // if a mutation reached browserd before its response connection failed.
      }
    }

    const controllerPort = await this.controllerPort();
    const directory = `${CLIENT_ROOT}/${randomUUID()}`;
    const configPath = `${directory}/curl.conf`;
    const requestPath = `${directory}/request.json`;
    const responsePath = `${directory}/response.json`;
    const statusPath = `${directory}/status`;
    const exitPath = `${directory}/curl-exit`;
    const token = requireToken(input.token, "browser controller token");
    const timeoutMs = boundedTimeout(input.timeoutMs ?? this.timeoutMs);
    const url = localControllerUrl(controllerPort, input.path);
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    try {
      await runChecked(
        this.session,
        `umask 077; install -d -m 0700 -- ${shellQuote(directory)}; printf '%s\\n' ${shellQuote(COMMAND_OK)}`,
        timeoutMs,
      );
      if (body !== undefined) {
        if (Buffer.byteLength(body) > BROWSER_CONTROL_MAX_JSON_BYTES) {
          throw new RangeError("browser controller request body is too large");
        }
        await writePrivateFile(
          this.session,
          { path: requestPath, content: body, createParents: false },
          timeoutMs,
        );
      }
      await writePrivateFile(
        this.session,
        {
          path: configPath,
          content: curlConfig({
            method: input.method,
            url,
            token,
            responsePath,
            ...(body === undefined ? {} : { requestPath }),
            timeoutMs,
          }),
          createParents: false,
        },
        timeoutMs,
      );
      await runChecked(
        this.session,
        `chmod 0600 -- ${shellQuote(configPath)}${body === undefined ? "" : ` ${shellQuote(requestPath)}`}; : > ${shellQuote(statusPath)}; curl --disable --config ${shellQuote(configPath)} > ${shellQuote(statusPath)}; curl_exit=$?; printf '%s' "$curl_exit" > ${shellQuote(exitPath)}; printf '%s\\n' ${shellQuote(COMMAND_OK)}`,
        timeoutMs,
      );
      const curlExit = parseUnsignedInteger(
        await readText(this.session, exitPath, 32, timeoutMs),
        "curl exit",
      );
      if (curlExit !== 0) {
        throw new BrowserControlTransportError(
          `browser controller transport failed (curl exit ${curlExit})`,
        );
      }
      const status = parseHttpStatus(await readText(this.session, statusPath, 32, timeoutMs));
      const responseText = await readText(
        this.session,
        responsePath,
        BROWSER_CONTROL_MAX_JSON_BYTES + 1,
        timeoutMs,
      );
      if (Buffer.byteLength(responseText) > BROWSER_CONTROL_MAX_JSON_BYTES) {
        throw new BrowserControlProtocolError("browser controller response is too large");
      }
      return parseEnvelope(responseText, status);
    } catch (error) {
      if (
        error instanceof BrowserControlRequestError ||
        error instanceof BrowserControlProtocolError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      if (error instanceof BrowserControlTransportError) {
        if (retryNativeEndpoint && this.nativeAuthority && this.session.ensureBrowserControl) {
          nativeControllerPorts.delete(nativeControllerKey(this.nativeAuthority));
          await this.controllerPort();
          return await this.requestJson(input, false);
        }
        throw error;
      }
      throw new BrowserControlTransportError("browser controller request transport failed", {
        cause: error,
      });
    } finally {
      await runBestEffort(this.session, `rm -rf -- ${shellQuote(directory)}`);
      await this.session.finalizeOpStreamOps?.().catch(() => undefined);
    }
  }

  private async controllerPort(): Promise<number> {
    if (!this.nativeAuthority || !this.session.ensureBrowserControl) return this.port;
    const key = nativeControllerKey(this.nativeAuthority);
    const cached = nativeControllerPorts.get(key);
    if (cached !== undefined) return cached;
    const ensured = await this.session.ensureBrowserControl({
      scopeId: this.nativeAuthority.scopeId,
      scopeGeneration: this.nativeAuthority.scopeGeneration,
      adminToken: this.adminToken,
      allowedOrigins: [],
    });
    const port = boundedPort(ensured.port);
    nativeControllerPorts.set(key, port);
    return port;
  }
}

function nativeControllerKey(authority: { scopeId: string; scopeGeneration: string }): string {
  return `${authority.scopeId}\u0000${authority.scopeGeneration}`;
}

export class BrowserControlSessionClient {
  readonly reference: PlacementBrowserSessionReference;
  private readonly parent: BrowserControlClient;
  private readonly controlToken: string;
  private readonly viewToken: string;

  constructor(
    parent: BrowserControlClient,
    input: {
      reference: PlacementBrowserSessionReference;
      controlToken: string;
      viewToken: string;
    },
  ) {
    this.parent = parent;
    this.reference = parseReference(input.reference);
    this.controlToken = requireToken(input.controlToken, "browser control token");
    this.viewToken = requireToken(input.viewToken, "browser view token");
  }

  async listTargets(): Promise<BrowserTargetValue[]> {
    const data = await this.parent.requestForSession({
      method: "GET",
      path: this.path("targets"),
      token: this.viewToken,
    });
    if (!Array.isArray(data)) {
      throw new BrowserControlProtocolError("browser controller returned malformed targets");
    }
    return data.map((target) => BrowserTarget.parse(target));
  }

  async listDownloads(): Promise<BrowserDownloadListResponseValue> {
    const data = await this.parent.requestForSession({
      method: "GET",
      path: this.path("downloads"),
      token: this.viewToken,
    });
    const response = BrowserDownloadListResponse.parse(data);
    if (
      response.browserSessionId !== this.reference.browserSessionId ||
      response.controllerGeneration !== this.reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError(
        "browser controller returned downloads for another session binding",
      );
    }
    return response;
  }

  async download(downloadId: string): Promise<BrowserDownloadValue> {
    const id = requireUuid(downloadId, "download id");
    const data = await this.parent.requestForSession({
      method: "GET",
      path: this.path(`downloads/${id}`),
      token: this.viewToken,
    });
    const download = BrowserDownload.parse(data);
    if (
      download.id !== id ||
      download.browserSessionId !== this.reference.browserSessionId ||
      download.controllerGeneration !== this.reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError("browser controller returned another download binding");
    }
    return download;
  }

  async exportDownload(
    downloadId: string,
    requestInput: BrowserDownloadExportRequestValue,
  ): Promise<BrowserDownloadExportReceiptValue> {
    const id = requireUuid(downloadId, "download id");
    const request = BrowserDownloadExportRequest.parse(requestInput);
    if (request.downloadId !== id) {
      throw new BrowserControlProtocolError("download export targets another resource");
    }
    const receipt = BrowserDownloadExportReceipt.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path(`downloads/${id}/exports`),
        token: this.controlToken,
        body: request,
      }),
    );
    if (receipt.operationId !== request.operationId || receipt.downloadId !== id) {
      throw new BrowserControlProtocolError("browser controller returned another export receipt");
    }
    return receipt;
  }

  async openTarget(url?: string): Promise<BrowserObservationValue> {
    return BrowserObservation.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path("targets"),
        token: this.controlToken,
        body: url === undefined ? {} : { url: boundedUrl(url) },
      }),
    );
  }

  async selectTarget(targetId: string): Promise<BrowserObservationValue> {
    return BrowserObservation.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.targetPath(targetId, "select"),
        token: this.controlToken,
        body: {},
      }),
    );
  }

  async closeTarget(targetId: string): Promise<BrowserTargetValue[]> {
    const data = await this.parent.requestForSession({
      method: "DELETE",
      path: this.targetPath(targetId),
      token: this.controlToken,
    });
    if (!Array.isArray(data)) {
      throw new BrowserControlProtocolError("browser controller returned malformed targets");
    }
    return data.map((target) => BrowserTarget.parse(target));
  }

  async observe(targetId: string): Promise<BrowserObservationValue> {
    return BrowserObservation.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.targetPath(targetId, "observation"),
        token: this.viewToken,
      }),
    );
  }

  async readClipboard(): Promise<BrowserClipboardValue> {
    return BrowserClipboard.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.path("clipboard"),
        token: this.viewToken,
      }),
    );
  }

  async action(command: BrowserActionCommandValue): Promise<BrowserActionReceiptValue> {
    const parsed = BrowserActionCommand.parse(command);
    if (
      parsed.browserSessionId !== this.reference.browserSessionId ||
      parsed.controllerGeneration !== this.reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError("browser action targets another controller binding");
    }
    return BrowserActionReceipt.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path("actions"),
        token: this.controlToken,
        body: parsed,
      }),
    );
  }

  /** API-broker-only file authority path. Signed read URLs are materialized by
   * browserd and never become part of the public action or durable receipt. */
  async stageWorkspaceFiles(
    request: BrowserWorkspaceFileStageRequestValue,
  ): Promise<BrowserWorkspaceFileStageResponseValue> {
    const parsed = BrowserWorkspaceFileStageRequest.parse(request);
    return BrowserWorkspaceFileStageResponse.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path(`operations/${parsed.operationId}/workspace-files`),
        token: this.controlToken,
        body: parsed,
        timeoutMs: BROWSER_STATE_TRANSFER_TIMEOUT_MS,
      }),
    );
  }

  async receipt(operationId: string): Promise<BrowserActionReceiptValue> {
    return BrowserActionReceipt.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.path(`operations/${requireUuid(operationId, "operation id")}`),
        token: this.viewToken,
      }),
    );
  }

  /** Broker-only credential path. Callers must never pass this command through
   * model-visible tool arguments, events, logs, or durable session history. */
  async protectedAuthFill(
    command: BrowserProtectedAuthFillCommandValue,
  ): Promise<BrowserProtectedAuthFillReceiptValue> {
    const parsed = BrowserProtectedAuthFillCommand.parse(command);
    if (
      parsed.browserSessionId !== this.reference.browserSessionId ||
      parsed.controllerGeneration !== this.reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError(
        "protected fill targets another browser controller binding",
      );
    }
    return BrowserProtectedAuthFillReceipt.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path("protected-auth-fills"),
        token: this.controlToken,
        body: parsed,
      }),
    );
  }

  async protectedAuthReceipt(operationId: string): Promise<BrowserProtectedAuthFillReceiptValue> {
    return BrowserProtectedAuthFillReceipt.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.path(`protected-auth-operations/${requireUuid(operationId, "operation id")}`),
        token: this.controlToken,
      }),
    );
  }

  /** API-broker-only provider-auth path. The interactive URL response is
   * deliberately not exposed by any model-facing SDK or Codemode facade. */
  async externalAuth(
    commandInput: BrowserExternalAuthCommandValue,
  ): Promise<BrowserExternalAuthResultValue> {
    const command = BrowserExternalAuthCommand.parse(commandInput);
    if (
      command.browserSessionId !== this.reference.browserSessionId ||
      command.controllerGeneration !== this.reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError(
        "external authentication targets another browser controller binding",
      );
    }
    return BrowserExternalAuthResult.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path("external-auth"),
        token: this.controlToken,
        body: command,
      }),
    );
  }

  async diagnostics(
    targetId: string,
    options: {
      kinds?: readonly BrowserDiagnosticKind[];
      afterSequence?: number;
      limit?: number;
    } = {},
  ): Promise<BrowserDiagnosticBatchValue> {
    const query = new URLSearchParams();
    if (options.kinds) query.set("kinds", [...new Set(options.kinds)].join(","));
    if (options.afterSequence !== undefined) {
      query.set(
        "after",
        nonnegativeSafeInteger(options.afterSequence, "diagnostic cursor").toString(),
      );
    }
    if (options.limit !== undefined) {
      const limit = positiveSafeInteger(options.limit, "diagnostic limit");
      if (limit > 1_000) throw new RangeError("diagnostic limit is too large");
      query.set("limit", limit.toString());
    }
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return BrowserDiagnosticBatch.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: `${this.targetPath(targetId, "diagnostics")}${suffix}`,
        token: this.viewToken,
      }),
    );
  }

  private path(suffix: string): string {
    return `/v1/browser-sessions/${this.reference.browserSessionId}/${suffix}`;
  }

  private targetPath(targetId: string, suffix?: string): string {
    const base = this.path(`targets/${encodeURIComponent(requireOpaqueId(targetId, "target id"))}`);
    return suffix ? `${base}/${suffix}` : base;
  }
}

export class ComputerControlSessionClient {
  readonly reference: PlacementComputerSessionReference;
  private readonly parent: BrowserControlClient;
  private readonly controlToken: string;
  private readonly viewToken: string;

  constructor(
    parent: BrowserControlClient,
    input: {
      reference: PlacementComputerSessionReference;
      controlToken: string;
      viewToken: string;
    },
  ) {
    this.parent = parent;
    this.reference = parseComputerReference(input.reference);
    this.controlToken = requireToken(input.controlToken, "computer control token");
    this.viewToken = requireToken(input.viewToken, "computer view token");
  }

  async listTargets(): Promise<ComputerTargetValue[]> {
    const data = await this.parent.requestForSession({
      method: "GET",
      path: this.path("targets"),
      token: this.viewToken,
    });
    if (!Array.isArray(data)) {
      throw new BrowserControlProtocolError(
        "interaction controller returned malformed computer targets",
      );
    }
    return data.map((target) => ComputerTarget.parse(target));
  }

  async observe(targetId: string): Promise<ComputerObservationValue> {
    return ComputerObservation.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.targetPath(targetId, "observation"),
        token: this.viewToken,
      }),
    );
  }

  async readClipboard(): Promise<ComputerClipboardValue> {
    return ComputerClipboard.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.path("clipboard"),
        token: this.viewToken,
      }),
    );
  }

  async action(command: ComputerActionCommandValue): Promise<ComputerActionReceiptValue> {
    const parsed = ComputerActionCommand.parse(command);
    if (
      parsed.computerSessionId !== this.reference.computerSessionId ||
      parsed.controllerGeneration !== this.reference.controllerGeneration
    ) {
      throw new BrowserControlProtocolError("computer action targets another controller binding");
    }
    return ComputerActionReceipt.parse(
      await this.parent.requestForSession({
        method: "POST",
        path: this.path("actions"),
        token: this.controlToken,
        body: parsed,
      }),
    );
  }

  async receipt(operationId: string): Promise<ComputerActionReceiptValue> {
    return ComputerActionReceipt.parse(
      await this.parent.requestForSession({
        method: "GET",
        path: this.path(`operations/${requireUuid(operationId, "operation id")}`),
        token: this.viewToken,
      }),
    );
  }

  async heartbeat(): Promise<void> {
    const data = await this.parent.requestForSession({
      method: "POST",
      path: this.path("heartbeat"),
      token: this.controlToken,
      body: {},
    });
    if (!isRecord(data) || data.alive !== true) {
      throw new BrowserControlProtocolError(
        "interaction controller returned malformed computer heartbeat",
      );
    }
  }

  private path(suffix: string): string {
    return `/v1/computer-sessions/${this.reference.computerSessionId}/${suffix}`;
  }

  private targetPath(targetId: string, suffix?: string): string {
    const base = this.path(
      `targets/${encodeURIComponent(requireOpaqueId(targetId, "computer target id"))}`,
    );
    return suffix ? `${base}/${suffix}` : base;
  }
}

function curlConfig(input: {
  method: string;
  url: string;
  token: string;
  responsePath: string;
  requestPath?: string;
  timeoutMs: number;
}): string {
  const seconds = Math.max(1, Math.ceil(input.timeoutMs / 1_000));
  return [
    "silent",
    "show-error",
    `noproxy = ${curlConfigQuote("*")}`,
    `connect-timeout = ${Math.min(seconds, 15)}`,
    `max-time = ${seconds}`,
    `request = ${curlConfigQuote(input.method)}`,
    `url = ${curlConfigQuote(input.url)}`,
    `header = ${curlConfigQuote(`Authorization: Bearer ${input.token}`)}`,
    ...(input.requestPath
      ? [
          `header = ${curlConfigQuote("Content-Type: application/json")}`,
          `data-binary = ${curlConfigQuote(`@${input.requestPath}`)}`,
        ]
      : []),
    `output = ${curlConfigQuote(input.responsePath)}`,
    `write-out = ${curlConfigQuote("%{http_code}")}`,
    "",
  ].join("\n");
}

async function requestExposedController(
  endpoint: ExposedPortEndpoint,
  input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    token: string;
    body?: unknown;
    timeoutMs?: number;
  },
  defaultTimeoutMs: number,
): Promise<unknown> {
  const token = requireToken(input.token, "browser controller token");
  const timeoutMs = boundedTimeout(input.timeoutMs ?? defaultTimeoutMs);
  const streamUrl = new URL(buildStreamUrl({ ...endpoint, path: input.path }));
  streamUrl.protocol = streamUrl.protocol === "wss:" ? "https:" : "http:";
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body !== undefined && Buffer.byteLength(body) > BROWSER_CONTROL_MAX_JSON_BYTES) {
    throw new RangeError("browser controller request body is too large");
  }
  const response = await fetch(streamUrl, {
    method: input.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  if (Buffer.byteLength(responseText) > BROWSER_CONTROL_MAX_JSON_BYTES) {
    throw new BrowserControlProtocolError("browser controller response is too large");
  }
  return parseEnvelope(responseText, response.status);
}

function parseEnvelope(body: string, status: number): unknown {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new BrowserControlProtocolError("browser controller response is invalid JSON");
  }
  if (!isRecord(value) || value.protocolVersion !== BROWSER_CONTROL_PROTOCOL_VERSION) {
    throw new BrowserControlProtocolError("browser controller protocol version is invalid");
  }
  if (value.ok === true && status >= 200 && status < 300 && "data" in value) return value.data;
  if (value.ok === false && status >= 400 && status <= 599) {
    const parsed = InteractionError.safeParse(value.error);
    if (parsed.success) throw new BrowserControlRequestError(status, parsed.data);
  }
  throw new BrowserControlProtocolError("browser controller response envelope is invalid");
}

function localControllerUrl(port: number, path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("#")) {
    throw new BrowserControlProtocolError("browser controller request path is invalid");
  }
  return `http://127.0.0.1:${port}${path}`;
}

function parseReference(value: unknown): PlacementBrowserSessionReference {
  if (!isRecord(value)) throw new BrowserControlProtocolError("browser session binding is invalid");
  return {
    browserSessionId: requireUuid(value.browserSessionId, "browser session id"),
    controllerGeneration: requireGeneration(value.controllerGeneration),
  };
}

function parseComputerReference(value: unknown): PlacementComputerSessionReference {
  if (!isRecord(value)) {
    throw new BrowserControlProtocolError("computer session binding is invalid");
  }
  return {
    computerSessionId: requireUuid(value.computerSessionId, "computer session id"),
    controllerGeneration: requireGeneration(value.controllerGeneration),
  };
}

function placementBrowserTransport(input: PlacementBrowserTransport): PlacementBrowserTransport {
  if (input.kind === "managed") {
    if (
      input.engine !== undefined &&
      input.engine !== "chromium" &&
      input.engine !== "lightpanda"
    ) {
      throw new BrowserControlProtocolError("managed browser engine is invalid");
    }
    return { kind: "managed", engine: input.engine ?? "chromium" };
  }
  if (input.kind === "external_provider") {
    if (input.providerId !== "browserbase" && input.providerId !== "kernel") {
      throw new BrowserControlProtocolError("external browser provider is unsupported");
    }
    const endpoint = input.authority.endpoint
      ? boundedHttpUrl(input.authority.endpoint, "external browser provider endpoint")
      : undefined;
    return {
      kind: "external_provider",
      providerId: input.providerId,
      placementId: requireOpaqueId(input.placementId, "external browser placement id"),
      authority: {
        apiKey: requireBoundedText(
          input.authority.apiKey,
          1,
          8_192,
          "external browser provider credential",
        ),
        ...(endpoint ? { endpoint } : {}),
      },
      ...(input.timeoutSeconds === undefined
        ? {}
        : {
            timeoutSeconds: boundedExternalBrowserTimeout(input.timeoutSeconds),
          }),
      ...(input.stealth === undefined ? {} : { stealth: input.stealth }),
    };
  }
  return {
    kind: "attached_chrome",
    deviceId: requireUuid(input.deviceId, "attached browser id"),
    connectionGeneration: requireBridgeGeneration(input.connectionGeneration),
    browserName: requireBoundedText(input.browserName, 1, 100, "attached browser name"),
    browserVersion: requireBoundedText(input.browserVersion, 1, 256, "attached browser version"),
  };
}

function boundedExternalBrowserTimeout(value: number): number {
  const timeout = positiveSafeInteger(value, "external browser timeout");
  if (timeout > 86_400) {
    throw new BrowserControlProtocolError("external browser timeout is invalid");
  }
  return timeout;
}

function boundedHttpUrl(value: string, label: string): string {
  if (Buffer.byteLength(value) > 16_384) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return parsed.toString().replace(/\/$/u, "");
}

function placementBrowserNetworkRoute(
  input: PlacementBrowserNetworkRoute,
): PlacementBrowserNetworkRoute {
  const kind = input.kind;
  if (kind !== "direct" && kind !== "proxy" && kind !== "managed" && kind !== "tunnel") {
    throw new BrowserControlProtocolError("browser network route kind is invalid");
  }
  if (!/^[A-Za-z0-9._~-]{16,256}$/u.test(input.authorityDigest)) {
    throw new BrowserControlProtocolError("browser network route authority is invalid");
  }
  const proxyUrl = input.proxyUrl === undefined ? undefined : boundedProxyUrl(input.proxyUrl);
  if (kind !== "proxy" && proxyUrl !== undefined) {
    throw new BrowserControlProtocolError("non-proxy browser route contains proxy authority");
  }
  const providerRoute =
    input.providerRoute === undefined ? undefined : placementProviderRoute(input.providerRoute);
  if (kind !== "managed" && providerRoute !== undefined) {
    throw new BrowserControlProtocolError(
      "non-managed browser route contains provider route material",
    );
  }
  if (kind === "managed" && providerRoute === undefined) {
    throw new BrowserControlProtocolError("managed browser route omits provider route material");
  }
  return {
    routeId: requireUuid(input.routeId, "network route id"),
    routeVersion: positiveSafeInteger(input.routeVersion, "network route version"),
    authorityDigest: input.authorityDigest,
    kind,
    consistency: NetworkRouteConsistency.parse(input.consistency),
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(providerRoute === undefined ? {} : { providerRoute }),
  };
}

function placementProviderRoute(
  input: NonNullable<PlacementBrowserNetworkRoute["providerRoute"]>,
): NonNullable<PlacementBrowserNetworkRoute["providerRoute"]> {
  if (input.providerId !== "browserbase" && input.providerId !== "kernel") {
    throw new BrowserControlProtocolError("managed browser route provider is unsupported");
  }
  if (
    input.egressClass !== "datacenter" &&
    input.egressClass !== "residential" &&
    input.egressClass !== "isp"
  ) {
    throw new BrowserControlProtocolError("managed browser route egress class is invalid");
  }
  return {
    providerId: input.providerId,
    routeId: requireOpaqueId(input.routeId, "managed browser provider route id"),
    egressClass: input.egressClass,
    region:
      input.region === null
        ? null
        : requireBoundedText(input.region, 1, 128, "managed browser route region"),
  };
}

function boundedProxyUrl(value: string): string {
  if (Buffer.byteLength(value) > 16_384) {
    throw new BrowserControlProtocolError("browser proxy authority is too large");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserControlProtocolError("browser proxy authority is invalid");
  }
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    !url.hostname ||
    (!url.port && url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new BrowserControlProtocolError("browser proxy authority is invalid");
  }
  return url.toString();
}

function parseStateCaptureReceipt(value: unknown): PlacementBrowserStateCaptureReceipt {
  if (!isRecord(value) || !isRecord(value.manifest)) {
    throw new BrowserControlProtocolError(
      "browser controller returned malformed state-capture data",
    );
  }
  const manifest = value.manifest;
  if (!Array.isArray(manifest.tabs)) {
    throw new BrowserControlProtocolError(
      "browser controller returned malformed state-capture manifest",
    );
  }
  const browserSessionId = requireUuid(value.browserSessionId, "browser session id");
  const controllerGeneration = requireGeneration(value.controllerGeneration);
  const manifestSessionId = requireUuid(
    manifest.browserSessionId,
    "browser state manifest session id",
  );
  const manifestControllerGeneration = requireGeneration(manifest.controllerGeneration);
  if (
    manifestSessionId !== browserSessionId ||
    manifestControllerGeneration !== controllerGeneration
  ) {
    throw new BrowserControlProtocolError(
      "browser controller returned inconsistent state-capture metadata",
    );
  }
  if (
    value.format !== BROWSER_PROFILE_ARTIFACT_FORMAT ||
    manifest.schemaVersion !== 1 ||
    (manifest.engine !== "chromium" && manifest.engine !== "chrome") ||
    (manifest.platform !== "linux" &&
      manifest.platform !== "macos" &&
      manifest.platform !== "windows") ||
    (manifest.architecture !== "x64" && manifest.architecture !== "arm64")
  ) {
    throw new BrowserControlProtocolError(
      "browser controller returned unsupported state-capture metadata",
    );
  }
  if (
    manifest.profileCrypto !== "chromium_basic" &&
    manifest.profileCrypto !== "chromium_mock_keychain" &&
    manifest.profileCrypto !== "platform_bound"
  ) {
    throw new BrowserControlProtocolError(
      "browser controller returned unsupported profile crypto policy",
    );
  }
  const tabs = manifest.tabs.map((tab) => {
    if (!isRecord(tab) || typeof tab.selected !== "boolean") {
      throw new BrowserControlProtocolError(
        "browser controller returned malformed state-capture tab",
      );
    }
    return { url: boundedUrl(tab.url), selected: tab.selected };
  });
  if (tabs.length > 1_000 || tabs.filter((tab) => tab.selected).length > 1) {
    throw new BrowserControlProtocolError("browser controller returned invalid state-capture tabs");
  }
  return {
    operationId: requireUuid(value.operationId, "browser state operation id"),
    browserSessionId,
    controllerGeneration,
    objectKey: browserStateObjectKey(value.objectKey),
    format: BROWSER_PROFILE_ARTIFACT_FORMAT,
    artifactDigest: sha256(value.artifactDigest, "browser state artifact digest"),
    contentDigest: sha256(value.contentDigest, "browser state content digest"),
    sizeBytes: positiveSafeInteger(value.sizeBytes, "browser state artifact size"),
    fileCount: nonnegativeSafeInteger(value.fileCount, "browser state file count"),
    profileBytes: nonnegativeSafeInteger(value.profileBytes, "browser state profile size"),
    manifest: {
      schemaVersion: 1,
      browserSessionId: manifestSessionId,
      controllerGeneration: manifestControllerGeneration,
      capturedAt: timestamp(manifest.capturedAt, "browser state capture time"),
      engine: manifest.engine,
      engineVersion:
        manifest.engineVersion === null
          ? null
          : requireOpaqueId(manifest.engineVersion, "browser engine version"),
      driverId: requireOpaqueId(manifest.driverId, "browser driver id"),
      driverSchemaVersion: positiveSafeInteger(
        manifest.driverSchemaVersion,
        "browser driver schema version",
      ),
      profileCrypto: manifest.profileCrypto,
      platform: manifest.platform,
      architecture: manifest.architecture,
      tabs,
    },
  };
}

function browserStateObjectKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 2_048 ||
    !/^workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/browser-state\/[A-Za-z0-9._=-]+(?:\/[A-Za-z0-9._=-]+)*$/iu.test(
      value,
    )
  ) {
    throw new RangeError("browser state object key is invalid");
  }
  return value;
}

function browserStateUploadGrant(value: unknown): BrowserStateUploadGrant {
  if (!isRecord(value) || !isRecord(value.requiredHeaders)) {
    throw new RangeError("browser state upload grant is invalid");
  }
  const url = boundedUrl(value.url);
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new RangeError("browser state upload URL is invalid");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.requiredHeaders)) {
    if (
      (name !== "content-type" && name !== "x-ms-blob-type") ||
      typeof headerValue !== "string" ||
      /[\r\n]/u.test(headerValue)
    ) {
      throw new RangeError("browser state upload header is invalid");
    }
    headers[name] = headerValue;
  }
  if (Object.keys(headers).length < 1 || Object.keys(headers).length > 2) {
    throw new RangeError("browser state upload header count is invalid");
  }
  if (headers["content-type"] !== BROWSER_STATE_ARTIFACT_CONTENT_TYPE) {
    throw new RangeError("browser state upload content type is invalid");
  }
  return {
    url: parsed.toString(),
    requiredHeaders: headers,
    expiresAt: timestamp(value.expiresAt, "browser state upload expiry"),
  };
}

function browserStateDownloadGrant(value: unknown): BrowserStateDownloadGrant {
  if (!isRecord(value)) {
    throw new RangeError("browser state download grant is invalid");
  }
  const url = boundedUrl(value.url);
  const parsed = new URL(url);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new RangeError("browser state download URL is invalid");
  }
  return {
    url: parsed.toString(),
    expiresAt: timestamp(value.expiresAt, "browser state download expiry"),
  };
}

function browserStateRestoreRequest(input: RestorePlacementBrowserStateInput): {
  wire: Record<string, unknown>;
  dataKey: Buffer;
  aad: Buffer;
} {
  if (input.format !== BROWSER_PROFILE_ARTIFACT_FORMAT) {
    throw new RangeError("browser state restore format is unsupported");
  }
  const dataKey = Buffer.from(exactBytes(input.dataKey, 32, "browser state data key"));
  const aad = Buffer.from(boundedBytes(input.aad, 1, 16 * 1024, "browser state associated data"));
  try {
    return {
      wire: {
        objectKey: browserStateObjectKey(input.objectKey),
        format: BROWSER_PROFILE_ARTIFACT_FORMAT,
        artifactDigest: sha256(input.artifactDigest, "browser state artifact digest"),
        contentDigest: sha256(input.contentDigest, "browser state content digest"),
        manifestDigest: sha256(input.manifestDigest, "browser state manifest digest"),
        sizeBytes: positiveSafeInteger(input.sizeBytes, "browser state artifact size"),
        dataKeyBase64: dataKey.toString("base64"),
        aadBase64: aad.toString("base64"),
        materialization: BrowserRevisionMaterialization.parse(input.materialization),
        download: browserStateDownloadGrant(input.download),
      },
      dataKey,
      aad,
    };
  } catch (error) {
    dataKey.fill(0);
    aad.fill(0);
    throw error;
  }
}

function exactBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  return boundedBytes(value, length, length, label);
}

function boundedBytes(
  value: Uint8Array,
  minimum: number,
  maximum: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function requirePlacementRequestSurface(session: BrowserControlPlacementSession): void {
  const hasPrivateWrite =
    typeof session.writePlacementPrivate === "function" ||
    typeof session.writeFile === "function" ||
    ((typeof session.exec === "function" || typeof session.execCommand === "function") &&
      typeof session.writeStdin === "function");
  if (
    (typeof session.exec !== "function" && typeof session.execCommand !== "function") ||
    !hasPrivateWrite
  ) {
    throw new BrowserControlUnsupportedError(
      "browser placement requires exec and a private file transport",
    );
  }
}

async function writePrivateFile(
  session: BrowserControlPlacementSession,
  input: {
    path: string;
    content: string | Uint8Array;
    createParents?: boolean;
  },
  timeoutMs = 60_000,
): Promise<void> {
  if (session.writePlacementPrivate) {
    await session.writePlacementPrivate(input);
    return;
  }
  if (session.writeFile) {
    await session.writeFile(input);
    return;
  }
  if ((!session.exec && !session.execCommand) || !session.writeStdin) {
    throw new BrowserControlUnsupportedError("browser placement has no private file transport");
  }
  const path = absolutePrivatePath(input.path, "browser private file path");
  const bytes = typeof input.content === "string" ? Buffer.from(input.content) : input.content;
  if (bytes.byteLength > BROWSER_CONTROL_MAX_JSON_BYTES) {
    throw new RangeError("browser private file is too large");
  }
  const parent = posixPath.dirname(path);
  if (input.createParents) {
    await runChecked(
      session,
      `umask 077; install -d -m 0700 -- ${shellQuote(parent)}; printf '%s\n' ${shellQuote(COMMAND_OK)}`,
      timeoutMs,
    );
  }
  if (bytes.byteLength === 0) {
    await runChecked(
      session,
      `umask 077; : > ${shellQuote(path)}; chmod 0600 -- ${shellQuote(path)}; printf '%s\n' ${shellQuote(COMMAND_OK)}`,
      timeoutMs,
    );
    return;
  }

  // SandboxSession deliberately has no generic writeFile capability. Stream a
  // bounded base64 payload over the provider's stdin channel into an exact-byte
  // decoder. Secret material never appears in a shell command, argv, env, URL,
  // workspace, or provider process listing.
  const payload = Buffer.from(bytes).toString("base64");
  const command = [
    "umask 077;",
    "if base64 --help 2>&1 | grep -q -- '--decode'; then decode_flag=--decode;",
    "elif printf '' | base64 -d >/dev/null 2>&1; then decode_flag=-d;",
    "elif printf '' | base64 -D >/dev/null 2>&1; then decode_flag=-D;",
    "else exit 69; fi;",
    `dd bs=1 count=${payload.length} 2>/dev/null | base64 "$decode_flag" > ${shellQuote(path)};`,
    `chmod 0600 -- ${shellQuote(path)};`,
    `printf '%s\n' ${shellQuote(COMMAND_OK)}`,
  ].join(" ");
  const started = session.exec
    ? await session.exec({
        cmd: command,
        yieldTimeMs: 250,
        maxOutputTokens: 2_000,
      })
    : await session.execCommand!({
        cmd: command,
        yieldTimeMs: 250,
        maxOutputTokens: 2_000,
      });
  const startedSessionId =
    typeof started === "string"
      ? (() => {
          const banner = parseExecResponseBanner(started);
          return banner.kind === "running" ? banner.sessionId : null;
        })()
      : Number.isSafeInteger(started.sessionId) && (started.sessionId ?? -1) >= 0
        ? started.sessionId!
        : null;
  if (startedSessionId === null) {
    throw new BrowserControlTransportError(
      "browser private file transport did not yield an input session",
    );
  }
  const output = await session.writeStdin({
    sessionId: startedSessionId,
    chars: payload,
    yieldTimeMs: boundedTimeout(timeoutMs),
    maxOutputTokens: 2_000,
  });
  const terminal = parseExecResponseBanner(output);
  if (
    terminal.kind === "invalid" ||
    terminal.kind === "running" ||
    (terminal.kind === "exited" && terminal.exitCode !== 0) ||
    !output.includes(COMMAND_OK)
  ) {
    throw new BrowserControlTransportError("browser private file transport failed");
  }
}

async function runChecked(
  session: BrowserControlPlacementSession,
  command: string,
  timeoutMs = 60_000,
): Promise<void> {
  const bounded = boundedTimeout(timeoutMs);
  const result = session.exec
    ? await session.exec({
        cmd: command,
        yieldTimeMs: bounded,
        maxOutputTokens: 2_000,
      })
    : await session.execCommand!({
        cmd: command,
        yieldTimeMs: bounded,
        maxOutputTokens: 2_000,
      });
  const output = commandOutput(result);
  const exitCode = typeof result === "object" && result ? result.exitCode : undefined;
  if ((typeof exitCode === "number" && exitCode !== 0) || !output.includes(COMMAND_OK)) {
    throw new BrowserControlTransportError("browser placement command failed");
  }
}

async function runBestEffort(
  session: BrowserControlPlacementSession,
  command: string,
): Promise<void> {
  try {
    if (session.exec) {
      await session.exec({
        cmd: command,
        yieldTimeMs: 15_000,
        maxOutputTokens: 100,
      });
    } else if (session.execCommand) {
      await session.execCommand({
        cmd: command,
        yieldTimeMs: 15_000,
        maxOutputTokens: 100,
      });
    }
  } catch {
    // UUID-scoped request directories contain no durable state.
  }
}

async function readText(
  session: BrowserControlPlacementSession,
  path: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const privatePath = absolutePrivatePath(path, "browser private response path");
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > BROWSER_CONTROL_MAX_JSON_BYTES + 1
  ) {
    throw new RangeError("browser private response limit is invalid");
  }
  if (session.readFile) {
    try {
      const value = await session.readFile({ path: privatePath, maxBytes });
      return typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      // The standard Docker SandboxSession intentionally confines readFile to
      // its workspace mount. Keep controller traffic out of that capturable
      // mount and fall back to the same placement's bounded command channel.
    }
  }

  const sizeMarker = `OPENGENI_BROWSER_PRIVATE_SIZE_${randomUUID()}`;
  const sizeOutput = await runPrivateReadCommand(
    session,
    [
      "LC_ALL=C;",
      `size=$(wc -c < ${shellQuote(privatePath)}) || exit 66;`,
      `printf '%s%s%s' ${shellQuote(sizeMarker)} "$size" ${shellQuote(sizeMarker)}`,
    ].join(" "),
    1_024,
    timeoutMs,
  );
  const sizeText = extractMarkedValue(sizeOutput, sizeMarker);
  const size = parseUnsignedInteger(sizeText, "browser private response size");
  const requestedBytes = Math.min(size, maxBytes);
  if (requestedBytes === 0) return "";

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < requestedBytes; offset += PRIVATE_READ_CHUNK_BYTES) {
    const chunkIndex = Math.floor(offset / PRIVATE_READ_CHUNK_BYTES);
    const expectedBytes = Math.min(PRIVATE_READ_CHUNK_BYTES, requestedBytes - offset);
    const marker = `OPENGENI_BROWSER_PRIVATE_CHUNK_${randomUUID()}`;
    const output = await runPrivateReadCommand(
      session,
      [
        "LC_ALL=C;",
        `printf '%s' ${shellQuote(marker)};`,
        `dd if=${shellQuote(privatePath)} bs=${PRIVATE_READ_CHUNK_BYTES} skip=${chunkIndex} count=1 2>/dev/null | base64 | tr -d '\\r\\n';`,
        `printf '%s' ${shellQuote(marker)}`,
      ].join(" "),
      Math.ceil((expectedBytes * 4) / 3) + 4_096,
      timeoutMs,
    );
    const encoded = extractMarkedValue(output, marker);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new BrowserControlTransportError("browser private response encoding is invalid");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength < expectedBytes) {
      throw new BrowserControlTransportError("browser private response changed during read");
    }
    chunks.push(decoded.subarray(0, expectedBytes));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function runPrivateReadCommand(
  session: BrowserControlPlacementSession,
  command: string,
  maxOutputTokens: number,
  timeoutMs: number,
): Promise<string> {
  const bounded = boundedTimeout(timeoutMs);
  const result = session.exec
    ? await session.exec({
        cmd: command,
        yieldTimeMs: bounded,
        maxOutputTokens,
      })
    : await session.execCommand!({
        cmd: command,
        yieldTimeMs: bounded,
        maxOutputTokens,
      });
  const exitCode = typeof result === "object" && result ? result.exitCode : undefined;
  if (typeof result === "object" && result?.sessionId !== undefined) {
    throw new BrowserControlTransportError("browser private response read failed");
  }
  if (typeof result === "string") {
    const terminal = parseExecResponseBanner(result);
    if (
      terminal.kind === "invalid" ||
      terminal.kind === "running" ||
      (terminal.kind === "exited" && terminal.exitCode !== 0)
    ) {
      throw new BrowserControlTransportError("browser private response read failed");
    }
    return result;
  }
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new BrowserControlTransportError("browser private response read failed");
  }
  return result.stdout ?? result.output ?? "";
}

function extractMarkedValue(output: string, marker: string): string {
  const start = output.indexOf(marker);
  if (start < 0) {
    throw new BrowserControlTransportError("browser private response marker is absent");
  }
  const valueStart = start + marker.length;
  const end = output.indexOf(marker, valueStart);
  if (end < 0) {
    throw new BrowserControlTransportError("browser private response marker is incomplete");
  }
  return output.slice(valueStart, end);
}

function commandOutput(result: ExecResultLike | string): string {
  if (typeof result === "string") return result;
  return [result.output, result.stdout, result.stderr]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function curlConfigQuote(value: string): string {
  if (/[\r\n\0]/u.test(value)) throw new BrowserControlProtocolError("curl value is invalid");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function requireGeneration(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new BrowserControlProtocolError("controller generation is invalid");
  }
  return value;
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function requireBridgeGeneration(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new BrowserControlProtocolError("attached browser connection generation is invalid");
  }
  return value;
}

function requireBoundedText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) < minimum ||
    Buffer.byteLength(value) > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function boundedUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 16_384) {
    throw new BrowserControlProtocolError("browser URL is invalid");
  }
  return value;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string") throw new BrowserControlProtocolError("browser origin is invalid");
  try {
    const url = new URL(value);
    if (url.origin === "null" || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new BrowserControlProtocolError("browser origin must be an absolute origin");
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 128 || !Number.isFinite(Date.parse(value))) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function absolutePrivatePath(value: string, label: string): string {
  if (
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.endsWith("/") ||
    posixPath.normalize(value) !== value
  ) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return value;
}

function boundedPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError("browser controller port is invalid");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new RangeError("browser controller timeout is invalid");
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function parseUnsignedInteger(value: string, label: string): number {
  const trimmed = value.trim();
  if (!/^(0|[1-9][0-9]*)$/u.test(trimmed)) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    throw new BrowserControlProtocolError(`${label} is invalid`);
  }
  return parsed;
}

function parseHttpStatus(value: string): number {
  const status = parseUnsignedInteger(value, "HTTP status");
  if (status < 100 || status > 599) {
    throw new BrowserControlProtocolError("HTTP status is invalid");
  }
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
