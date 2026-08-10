import { createHash, timingSafeEqual } from "node:crypto";
import {
  BROWSER_CONTROL_PORT,
  BROWSER_PROFILE_ARTIFACT_FORMAT,
  BrowserActionCommand,
  BrowserRevisionMaterialization,
  type BrowserActionCommand as BrowserActionCommandValue,
  BrowserProtectedAuthFillCommand,
  type BrowserProtectedAuthFillCommand as BrowserProtectedAuthFillCommandValue,
  ComputerActionCommand,
  type ComputerActionCommand as ComputerActionCommandValue,
  type InteractionError,
} from "@opengeni/contracts";
import { InteractionControllerError } from "@opengeni/interaction";
import type { ComputerFrameSubscription, ComputerFrameStreamOptions } from "./computer-media";
import {
  COMPUTER_CONTROL_WEBSOCKET_PROTOCOL,
  encodeComputerFrameMetadataHeader,
  encodeComputerFrameMessage,
} from "./computer-protocol";
import {
  ComputerSupervisor,
  type ComputerSessionReference,
  type ComputerSupervisorSessionOptions,
} from "./computer-supervisor";
import type { BrowserFrameSubscription, BrowserFrameStreamOptions } from "./media";
import {
  BROWSER_CONTROL_MAX_JSON_BYTES,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX,
  BROWSER_CONTROL_WEBSOCKET_PROTOCOL,
  encodeBrowserFrameMetadataHeader,
  encodeBrowserFrameMessage,
} from "./protocol";
import {
  BrowserSupervisor,
  type BrowserSessionReference,
  type BrowserStateCaptureInput,
  type BrowserStateRestoreInput,
  type BrowserSupervisorSessionOptions,
} from "./supervisor";

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,2048}$/u;
const MAX_TOKEN_GENERATION = Number.MAX_SAFE_INTEGER;
const MAX_ALLOWED_ORIGINS = 64;
const MAX_VIEW_GRANTS_PER_SESSION = 64;
const MAX_VIEW_GRANT_TTL_MS = 10 * 60_000;

type ViewGrant = {
  id: string;
  digest: Buffer;
  expiresAt: string;
  expiresAtMs: number;
};

type SessionAuthority = BrowserSessionReference & {
  tokenGeneration: number;
  controlDigest: Buffer;
  viewDigest: Buffer;
  viewGrants: Map<string, ViewGrant>;
};

type SessionAuthorization =
  | { authority: SessionAuthority; kind: "session" }
  | { authority: SessionAuthority; kind: "grant"; grant: ViewGrant };

type BrowserSocketData = {
  kind: "browser";
  reference: BrowserSessionReference;
  authorization:
    | { kind: "session"; tokenGeneration: number }
    | { kind: "grant"; grantId: string; expiresAtMs: number };
  targetId: string;
  options: BrowserFrameStreamOptions;
  subscription: BrowserFrameSubscription | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

type ComputerSessionAuthority = ComputerSessionReference & {
  tokenGeneration: number;
  controlDigest: Buffer;
  viewDigest: Buffer;
  viewGrants: Map<string, ViewGrant>;
};

type ComputerSessionAuthorization =
  | { authority: ComputerSessionAuthority; kind: "session" }
  | { authority: ComputerSessionAuthority; kind: "grant"; grant: ViewGrant };

type ComputerSocketData = {
  kind: "computer";
  reference: ComputerSessionReference;
  authorization:
    | { kind: "session"; tokenGeneration: number }
    | { kind: "grant"; grantId: string; expiresAtMs: number };
  targetId: string;
  options: ComputerFrameStreamOptions;
  subscription: ComputerFrameSubscription | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
};

type InteractionSocketData = BrowserSocketData | ComputerSocketData;
type BrowserServer = ReturnType<typeof Bun.serve<InteractionSocketData>>;
type BrowserSocket = Bun.ServerWebSocket<InteractionSocketData>;

export type BrowserControlServerOptions = {
  supervisor: BrowserSupervisor;
  computerSupervisor?: ComputerSupervisor;
  adminToken: string;
  hostname?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  browserExecutablePath?: string;
  closeSupervisorOnStop?: boolean;
};

export class BrowserControlServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  private readonly supervisor: BrowserSupervisor;
  private readonly computerSupervisor: ComputerSupervisor | undefined;
  private readonly adminDigest: Buffer;
  private readonly allowedOrigins: Set<string>;
  private readonly browserExecutablePath: string | undefined;
  private readonly closeSupervisorOnStop: boolean;
  private readonly authorities = new Map<string, SessionAuthority>();
  private readonly computerAuthorities = new Map<string, ComputerSessionAuthority>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly sockets = new Set<BrowserSocket>();
  private readonly server: BrowserServer;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  private constructor(options: BrowserControlServerOptions) {
    this.supervisor = options.supervisor;
    this.computerSupervisor = options.computerSupervisor;
    this.adminDigest = tokenDigest(requireToken(options.adminToken, "admin token"));
    this.allowedOrigins = new Set((options.allowedOrigins ?? []).map(normalizeOrigin));
    if (this.allowedOrigins.size > MAX_ALLOWED_ORIGINS) {
      throw new Error("too many allowed browser origins");
    }
    this.browserExecutablePath = options.browserExecutablePath;
    this.closeSupervisorOnStop = options.closeSupervisorOnStop ?? true;
    const requestedHostname = options.hostname ?? "127.0.0.1";
    this.server = Bun.serve<InteractionSocketData>({
      hostname: requestedHostname,
      port: options.port ?? BROWSER_CONTROL_PORT,
      idleTimeout: 120,
      maxRequestBodySize: BROWSER_CONTROL_MAX_JSON_BYTES,
      fetch: async (request, server) => await this.handleFetch(request, server),
      websocket: {
        maxPayloadLength: 1_024,
        backpressureLimit: 32 * 1024 * 1024,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
        open: (socket) => {
          this.onSocketOpen(socket);
        },
        message: (socket) => {
          socket.close(1003, "frame stream is server-only");
        },
        close: (socket) => {
          this.onSocketClose(socket);
        },
      },
    });
    this.hostname = requestedHostname;
    if (this.server.port === undefined)
      throw new Error("browser controller did not bind a TCP port");
    this.port = this.server.port;
    const address = requestedHostname === "0.0.0.0" ? "127.0.0.1" : requestedHostname;
    this.url = `http://${formatHost(address)}:${this.port}`;
  }

  static start(options: BrowserControlServerOptions): BrowserControlServer {
    return new BrowserControlServer(options);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return await this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.performStop();
    return await this.stopPromise;
  }

  private async performStop(): Promise<void> {
    const failures: unknown[] = [];
    const sockets = [...this.sockets];
    for (const socket of sockets) {
      if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
      socket.data.expiryTimer = null;
      socket.terminate();
    }
    const subscriptionResults = await Promise.allSettled(
      sockets.map(async (socket) => await socket.data.subscription?.close()),
    );
    for (const result of subscriptionResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    // Bun's stop promise does not settle after a server has upgraded a websocket,
    // even after that socket is terminated. The synchronous call still closes the
    // listener; unref guarantees a stale internal handle cannot retain the daemon.
    const serverStop = this.server.stop(true);
    this.server.unref();
    void serverStop.catch(() => undefined);
    await Promise.allSettled(this.lifecycleTails.values());
    if (this.closeSupervisorOnStop) {
      const supervisorResults = await Promise.allSettled([
        this.supervisor.close(),
        ...(this.computerSupervisor ? [this.computerSupervisor.close()] : []),
      ]);
      for (const result of supervisorResults) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    }
    this.authorities.clear();
    this.computerAuthorities.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, "interaction controller shutdown failed");
    }
  }

  private async handleFetch(
    request: Request,
    server: BrowserServer,
  ): Promise<Response | undefined> {
    const origin = request.headers.get("origin");
    const normalizedOrigin = origin ? safeNormalizeOrigin(origin) : null;
    if (origin && (!normalizedOrigin || !this.allowedOrigins.has(normalizedOrigin))) {
      return protocolResponse(new ProtocolError("permission_denied", "origin is not allowed", 403));
    }
    try {
      if (request.method === "OPTIONS") {
        return this.withCors(this.preflight(request), normalizedOrigin);
      }
      if (this.stopping) {
        return this.withCors(
          protocolResponse(
            new ProtocolError("resource_unavailable", "browser controller is stopping", 503, true),
          ),
          normalizedOrigin,
        );
      }
      const response = await this.route(request, server);
      return response ? this.withCors(response, normalizedOrigin) : undefined;
    } catch (error) {
      return this.withCors(protocolResponse(error), normalizedOrigin);
    }
  }

  private async route(request: Request, server: BrowserServer): Promise<Response | undefined> {
    const url = new URL(request.url);
    const segments = pathSegments(url.pathname);
    if (segments.length === 1 && segments[0] === "healthz" && request.method === "GET") {
      return success({
        ok: true,
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      });
    }
    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "origins") {
      this.requireAdmin(request);
      if (request.method === "GET") return success({ origins: [...this.allowedOrigins].sort() });
      if (request.method === "PUT") return await this.addAllowedOrigins(request);
      throw new ProtocolError("invalid_action", "method not allowed", 405);
    }
    if (segments[0] === "v1" && segments[1] === "computer-sessions") {
      if (!this.computerSupervisor) {
        throw new ProtocolError("unsupported", "computer controller is unavailable", 422);
      }
      return await this.routeComputer(request, server, segments, url);
    }
    if (segments[0] !== "v1" || segments[1] !== "browser-sessions") {
      throw new ProtocolError("resource_not_found", "route not found", 404);
    }
    if (segments.length === 2) {
      this.requireAdmin(request);
      if (request.method === "GET") return success(this.supervisor.listSessions());
      if (request.method === "POST") return await this.createSession(request);
      throw new ProtocolError("invalid_action", "method not allowed", 405);
    }

    const browserSessionId = requireUuid(segments[2], "browser session id");
    if (segments.length === 4 && segments[3] === "end") {
      this.requireAdmin(request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return await this.endSession(browserSessionId, request);
    }
    if (segments.length === 4 && segments[3] === "view-grants") {
      this.requireAdmin(request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return await this.createViewGrant(browserSessionId, request);
    }
    if (segments.length === 4 && segments[3] === "state-captures") {
      this.requireAdmin(request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return await this.captureState(browserSessionId, request);
    }
    if (segments.length === 6 && segments[3] === "targets" && segments[5] === "frames") {
      if (request.method !== "GET") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return this.upgradeFrames(request, server, browserSessionId, segments[4]!, url);
    }

    const authority = this.requireSession(
      request,
      browserSessionId,
      routeNeedsControl(segments, request),
    );
    const reference = binding(authority);
    if (segments.length === 4 && segments[3] === "targets") {
      if (request.method === "GET") return success(await this.supervisor.listTargets(reference));
      if (request.method === "POST") {
        const body = await readJsonObject(request);
        assertOnlyKeys(body, ["url"]);
        const target = await this.supervisor.openTarget(
          reference,
          body.url === undefined ? undefined : requireString(body.url, "url", 16_384),
        );
        return success(target, 201);
      }
      throw new ProtocolError("invalid_action", "method not allowed", 405);
    }
    if (segments.length === 4 && segments[3] === "actions") {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      const command = parseActionCommand(await readJson(request));
      if (command.browserSessionId !== browserSessionId) {
        throw new ProtocolError(
          "operation_conflict",
          "action targets another browser session",
          409,
        );
      }
      return success(await this.supervisor.action(command));
    }
    if (segments.length === 4 && segments[3] === "protected-auth-fills") {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      const command = parseProtectedAuthFillCommand(await readJson(request));
      if (command.browserSessionId !== browserSessionId) {
        throw new ProtocolError(
          "operation_conflict",
          "protected fill targets another browser session",
          409,
        );
      }
      return success(await this.supervisor.protectedAuthFill(command));
    }
    if (segments.length === 5 && segments[3] === "operations") {
      if (request.method !== "GET") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      const operationId = requireUuid(segments[4], "operation id");
      const receipt = this.supervisor.receipt(reference, operationId);
      if (!receipt) throw new ProtocolError("resource_not_found", "operation not found", 404);
      return success(receipt);
    }
    if (segments.length === 5 && segments[3] === "protected-auth-operations") {
      if (request.method !== "GET") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      const operationId = requireUuid(segments[4], "operation id");
      const receipt = this.supervisor.protectedAuthReceipt(reference, operationId);
      if (!receipt) throw new ProtocolError("resource_not_found", "operation not found", 404);
      return success(receipt);
    }
    if (segments.length < 5 || segments[3] !== "targets") {
      throw new ProtocolError("resource_not_found", "route not found", 404);
    }
    const targetId = requireOpaqueId(segments[4], "target id");
    if (segments.length === 5 && request.method === "DELETE") {
      return success(await this.supervisor.closeTarget(reference, targetId));
    }
    if (segments.length !== 6) {
      throw new ProtocolError("resource_not_found", "route not found", 404);
    }
    const operation = segments[5];
    if (operation === "select" && request.method === "POST") {
      return success(await this.supervisor.selectTarget(reference, targetId));
    }
    if (operation === "observation" && request.method === "GET") {
      return success(await this.supervisor.observe(reference, targetId));
    }
    if (operation === "diagnostics" && request.method === "GET") {
      return success(
        await this.supervisor.debug(reference, targetId, {
          ...(url.searchParams.has("kinds")
            ? { kinds: parseDiagnosticKinds(url.searchParams.get("kinds")!) }
            : {}),
          ...(url.searchParams.has("after")
            ? {
                afterSequence: parseInteger(
                  url.searchParams.get("after"),
                  "after",
                  0,
                  Number.MAX_SAFE_INTEGER,
                ),
              }
            : {}),
          ...(url.searchParams.has("limit")
            ? {
                limit: parseInteger(url.searchParams.get("limit"), "limit", 1, 1_000),
              }
            : {}),
        }),
      );
    }
    if (operation === "screenshot" && request.method === "GET") {
      const frame = await this.supervisor.screenshot(reference, targetId, {
        ...(url.searchParams.has("format")
          ? { format: parseImageFormat(url.searchParams.get("format")) }
          : {}),
        ...(url.searchParams.has("quality")
          ? {
              quality: parseInteger(url.searchParams.get("quality"), "quality", 1, 100),
            }
          : {}),
        ...(url.searchParams.has("fullPage")
          ? {
              fullPage: parseBoolean(url.searchParams.get("fullPage"), "fullPage"),
            }
          : {}),
      });
      return new Response(frame.data.slice().buffer, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": frame.mediaType,
          "x-opengeni-browser-frame": encodeBrowserFrameMetadataHeader(frame),
        },
      });
    }
    throw new ProtocolError("resource_not_found", "route not found", 404);
  }

  private async routeComputer(
    request: Request,
    server: BrowserServer,
    segments: readonly string[],
    url: URL,
  ): Promise<Response | undefined> {
    const supervisor = this.computerSupervisor;
    if (!supervisor)
      throw new ProtocolError("unsupported", "computer controller is unavailable", 422);
    if (segments.length === 2) {
      this.requireAdmin(request);
      if (request.method === "GET") return success(supervisor.listSessions());
      if (request.method === "POST") return await this.createComputerSession(request);
      throw new ProtocolError("invalid_action", "method not allowed", 405);
    }
    const computerSessionId = requireUuid(segments[2], "computer session id");
    if (segments.length === 4 && segments[3] === "end") {
      this.requireAdmin(request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return await this.endComputerSession(computerSessionId, request);
    }
    if (segments.length === 4 && segments[3] === "view-grants") {
      this.requireAdmin(request);
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return await this.createComputerViewGrant(computerSessionId, request);
    }
    if (segments.length === 6 && segments[3] === "targets" && segments[5] === "frames") {
      if (request.method !== "GET") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      return this.upgradeComputerFrames(request, server, computerSessionId, segments[4]!, url);
    }

    const authority = this.requireComputerSession(
      request,
      computerSessionId,
      routeNeedsComputerControl(segments),
    );
    const reference = computerBinding(authority);
    if (segments.length === 4 && segments[3] === "targets") {
      if (request.method === "GET") return success(await supervisor.listTargets(reference));
      throw new ProtocolError("invalid_action", "method not allowed", 405);
    }
    if (segments.length === 4 && segments[3] === "actions") {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      const command = parseComputerActionCommand(await readJson(request));
      if (command.computerSessionId !== computerSessionId) {
        throw new ProtocolError(
          "operation_conflict",
          "action targets another computer session",
          409,
        );
      }
      return success(await supervisor.action(command));
    }
    if (segments.length === 4 && segments[3] === "heartbeat") {
      if (request.method !== "POST") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      await supervisor.heartbeat(reference);
      return success({ alive: true });
    }
    if (segments.length === 5 && segments[3] === "operations") {
      if (request.method !== "GET") {
        throw new ProtocolError("invalid_action", "method not allowed", 405);
      }
      const operationId = requireUuid(segments[4], "operation id");
      const receipt = supervisor.receipt(reference, operationId);
      if (!receipt) throw new ProtocolError("resource_not_found", "operation not found", 404);
      return success(receipt);
    }
    if (segments.length !== 6 || segments[3] !== "targets") {
      throw new ProtocolError("resource_not_found", "route not found", 404);
    }
    const targetId = requireOpaqueId(segments[4], "target id");
    if (segments[5] === "observation" && request.method === "GET") {
      return success(await supervisor.observe(reference, targetId));
    }
    if (segments[5] === "screenshot" && request.method === "GET") {
      const frame = await supervisor.capture(reference, targetId);
      return new Response(frame.data.slice().buffer, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": frame.mediaType,
          "x-opengeni-computer-frame": encodeComputerFrameMetadataHeader(frame),
        },
      });
    }
    throw new ProtocolError("resource_not_found", "route not found", 404);
  }

  private async createSession(request: Request): Promise<Response> {
    const body = parseCreateSession(await readJsonObject(request));
    try {
      return await this.withLifecycleLock(body.browserSessionId, async () => {
        const controlDigest = tokenDigest(body.controlToken);
        const viewDigest = tokenDigest(body.viewToken);
        const current = this.authorities.get(body.browserSessionId);
        if (current) {
          if (current.controllerGeneration !== body.controllerGeneration) {
            throw new ProtocolError(
              "controller_stale",
              "browser session belongs to another controller generation",
              409,
            );
          }
          if (body.tokenGeneration < current.tokenGeneration) {
            throw new ProtocolError("controller_stale", "session token generation is stale", 409);
          }
          if (
            body.tokenGeneration === current.tokenGeneration &&
            (!sameDigest(controlDigest, current.controlDigest) ||
              !sameDigest(viewDigest, current.viewDigest))
          ) {
            throw new ProtocolError(
              "operation_conflict",
              "session token generation is already bound",
              409,
            );
          }
        }
        const sessionOptions: BrowserSupervisorSessionOptions = {
          browserSessionId: body.browserSessionId,
          controllerGeneration: body.controllerGeneration,
          headed: body.headed,
          ...(body.initialUrl ? { initialUrl: body.initialUrl } : {}),
          ...(body.restore ? { restore: body.restore } : {}),
          ...(body.transport ? { transport: body.transport } : {}),
          ...(body.linkedComputer
            ? {
                linkedComputer: body.linkedComputer,
                launchEnvironment: this.requireComputerSupervisor().launchEnvironment(
                  body.linkedComputer,
                ),
              }
            : {}),
          ...(this.browserExecutablePath
            ? { browserExecutablePath: this.browserExecutablePath }
            : {}),
        };
        const created = await this.supervisor.createSession(sessionOptions);
        const rotated = current && body.tokenGeneration > current.tokenGeneration;
        this.authorities.set(body.browserSessionId, {
          browserSessionId: body.browserSessionId,
          controllerGeneration: body.controllerGeneration,
          tokenGeneration: body.tokenGeneration,
          controlDigest,
          viewDigest,
          viewGrants: rotated ? new Map() : (current?.viewGrants ?? new Map()),
        });
        if (rotated) this.closeSessionSockets(body.browserSessionId, 1008, "authorization rotated");
        return success(created, current ? 200 : 201);
      });
    } finally {
      body.restore?.dataKey.fill(0);
      body.restore?.aad.fill(0);
    }
  }

  private async createComputerSession(request: Request): Promise<Response> {
    const supervisor = this.computerSupervisor;
    if (!supervisor)
      throw new ProtocolError("unsupported", "computer controller is unavailable", 422);
    const body = parseCreateComputerSession(await readJsonObject(request));
    return await this.withLifecycleLock(`computer:${body.computerSessionId}`, async () => {
      const controlDigest = tokenDigest(body.controlToken);
      const viewDigest = tokenDigest(body.viewToken);
      const current = this.computerAuthorities.get(body.computerSessionId);
      if (current) {
        if (current.controllerGeneration !== body.controllerGeneration) {
          throw new ProtocolError(
            "controller_stale",
            "computer session belongs to another controller generation",
            409,
          );
        }
        if (body.tokenGeneration < current.tokenGeneration) {
          throw new ProtocolError("controller_stale", "session token generation is stale", 409);
        }
        if (
          body.tokenGeneration === current.tokenGeneration &&
          (!sameDigest(controlDigest, current.controlDigest) ||
            !sameDigest(viewDigest, current.viewDigest))
        ) {
          throw new ProtocolError(
            "operation_conflict",
            "session token generation is already bound",
            409,
          );
        }
      }
      const sessionOptions: ComputerSupervisorSessionOptions = {
        computerSessionId: body.computerSessionId,
        controllerGeneration: body.controllerGeneration,
      };
      const created = await supervisor.createSession(sessionOptions);
      const rotated = current && body.tokenGeneration > current.tokenGeneration;
      this.computerAuthorities.set(body.computerSessionId, {
        computerSessionId: body.computerSessionId,
        controllerGeneration: body.controllerGeneration,
        tokenGeneration: body.tokenGeneration,
        controlDigest,
        viewDigest,
        viewGrants: rotated ? new Map() : (current?.viewGrants ?? new Map()),
      });
      if (rotated) {
        this.closeResourceSockets(
          "computer",
          body.computerSessionId,
          1008,
          "authorization rotated",
        );
      }
      return success(created, current ? 200 : 201);
    });
  }

  private requireComputerSupervisor(): ComputerSupervisor {
    if (!this.computerSupervisor) {
      throw new ProtocolError("unsupported", "computer controller is unavailable", 422);
    }
    return this.computerSupervisor;
  }

  private async addAllowedOrigins(request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    assertOnlyKeys(body, ["origins"]);
    if (
      !Array.isArray(body.origins) ||
      body.origins.length === 0 ||
      body.origins.length > MAX_ALLOWED_ORIGINS
    ) {
      throw new ProtocolError("invalid_action", "origin list size is invalid", 400);
    }
    const origins = body.origins.map((value) => parseOrigin(value));
    const combined = new Set([...this.allowedOrigins, ...origins]);
    if (combined.size > MAX_ALLOWED_ORIGINS) {
      throw new ProtocolError("resource_unavailable", "allowed origin capacity is exhausted", 503);
    }
    for (const origin of origins) this.allowedOrigins.add(origin);
    return success({ origins: [...this.allowedOrigins].sort() });
  }

  private async createViewGrant(browserSessionId: string, request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    assertOnlyKeys(body, ["grantId", "controllerGeneration", "token", "expiresAt"]);
    const grantId = requireUuid(body.grantId, "view grant id");
    const controllerGeneration = requireGeneration(body.controllerGeneration);
    const token = requireToken(body.token, "view grant token");
    const expiresAt = requireFutureTimestamp(body.expiresAt, "view grant expiry");
    return await this.withLifecycleLock(browserSessionId, async () => {
      const authority = this.authorities.get(browserSessionId);
      if (!authority) {
        throw new ProtocolError("resource_not_found", "browser session not found", 404);
      }
      if (authority.controllerGeneration !== controllerGeneration) {
        throw new ProtocolError("controller_stale", "browser controller generation is stale", 409);
      }
      this.pruneViewGrants(authority);
      const digest = tokenDigest(token);
      const current = authority.viewGrants.get(grantId);
      if (current) {
        if (!sameDigest(current.digest, digest) || current.expiresAt !== expiresAt.value) {
          throw new ProtocolError("operation_conflict", "view grant id is already bound", 409);
        }
        return success({ grantId, expiresAt: current.expiresAt });
      }
      if (authority.viewGrants.size >= MAX_VIEW_GRANTS_PER_SESSION) {
        throw new ProtocolError(
          "resource_unavailable",
          "active view grant capacity is exhausted",
          503,
        );
      }
      authority.viewGrants.set(grantId, {
        id: grantId,
        digest,
        expiresAt: expiresAt.value,
        expiresAtMs: expiresAt.milliseconds,
      });
      return success({ grantId, expiresAt: expiresAt.value }, 201);
    });
  }

  private async createComputerViewGrant(
    computerSessionId: string,
    request: Request,
  ): Promise<Response> {
    const body = await readJsonObject(request);
    assertOnlyKeys(body, ["grantId", "controllerGeneration", "token", "expiresAt"]);
    const grantId = requireUuid(body.grantId, "view grant id");
    const controllerGeneration = requireGeneration(body.controllerGeneration);
    const token = requireToken(body.token, "view grant token");
    const expiresAt = requireFutureTimestamp(body.expiresAt, "view grant expiry");
    return await this.withLifecycleLock(`computer:${computerSessionId}`, async () => {
      const authority = this.computerAuthorities.get(computerSessionId);
      if (!authority) {
        throw new ProtocolError("resource_not_found", "computer session not found", 404);
      }
      if (authority.controllerGeneration !== controllerGeneration) {
        throw new ProtocolError("controller_stale", "computer controller generation is stale", 409);
      }
      this.pruneViewGrants(authority);
      const digest = tokenDigest(token);
      const current = authority.viewGrants.get(grantId);
      if (current) {
        if (!sameDigest(current.digest, digest) || current.expiresAt !== expiresAt.value) {
          throw new ProtocolError("operation_conflict", "view grant id is already bound", 409);
        }
        return success({ grantId, expiresAt: current.expiresAt });
      }
      if (authority.viewGrants.size >= MAX_VIEW_GRANTS_PER_SESSION) {
        throw new ProtocolError(
          "resource_unavailable",
          "active view grant capacity is exhausted",
          503,
        );
      }
      authority.viewGrants.set(grantId, {
        id: grantId,
        digest,
        expiresAt: expiresAt.value,
        expiresAtMs: expiresAt.milliseconds,
      });
      return success({ grantId, expiresAt: expiresAt.value }, 201);
    });
  }

  private async captureState(browserSessionId: string, request: Request): Promise<Response> {
    const body = parseStateCapture(await readJsonObject(request), browserSessionId);
    try {
      return await this.withLifecycleLock(browserSessionId, async () =>
        success(await this.supervisor.captureState(body)),
      );
    } finally {
      body.dataKey.fill(0);
      body.aad.fill(0);
    }
  }

  private async endSession(browserSessionId: string, request: Request): Promise<Response> {
    const body = await readJsonObject(request);
    assertOnlyKeys(body, ["controllerGeneration", "removeState"]);
    const controllerGeneration = requireGeneration(body.controllerGeneration);
    const removeState = requireBoolean(body.removeState, "removeState");
    return await this.withLifecycleLock(browserSessionId, async () => {
      await this.supervisor.endSession({ browserSessionId, controllerGeneration }, { removeState });
      // Validate and complete the bound lifecycle transition before disrupting
      // viewers. A stale admin lifecycle request must not close a live session.
      this.closeSessionSockets(browserSessionId, 1001, "browser session ended");
      const authority = this.authorities.get(browserSessionId);
      if (authority?.controllerGeneration === controllerGeneration) {
        this.authorities.delete(browserSessionId);
      }
      return success({ ended: true });
    });
  }

  private async endComputerSession(computerSessionId: string, request: Request): Promise<Response> {
    const supervisor = this.computerSupervisor;
    if (!supervisor)
      throw new ProtocolError("unsupported", "computer controller is unavailable", 422);
    const body = await readJsonObject(request);
    assertOnlyKeys(body, ["controllerGeneration", "removeState"]);
    const controllerGeneration = requireGeneration(body.controllerGeneration);
    const removeState = requireBoolean(body.removeState, "removeState");
    return await this.withLifecycleLock(`computer:${computerSessionId}`, async () => {
      await supervisor.endSession({ computerSessionId, controllerGeneration }, { removeState });
      this.closeResourceSockets("computer", computerSessionId, 1001, "computer session ended");
      const authority = this.computerAuthorities.get(computerSessionId);
      if (authority?.controllerGeneration === controllerGeneration) {
        this.computerAuthorities.delete(computerSessionId);
      }
      return success({ ended: true });
    });
  }

  private upgradeFrames(
    request: Request,
    server: BrowserServer,
    browserSessionId: string,
    targetId: string,
    url: URL,
  ): Response | undefined {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!protocols.includes(BROWSER_CONTROL_WEBSOCKET_PROTOCOL)) {
      throw new ProtocolError("invalid_action", "browser frame protocol is required", 426);
    }
    const bearerProtocols = protocols.filter((value) =>
      value.startsWith(BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX),
    );
    if (bearerProtocols.length !== 1) {
      throw new ProtocolError("permission_denied", "frame stream authorization is required", 401);
    }
    const token = requireToken(
      bearerProtocols[0]!.slice(BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX.length),
      "frame stream token",
    );
    const authorization = this.authorizeToken(browserSessionId, token, false, true);
    const authority = authorization.authority;
    const options: BrowserFrameStreamOptions = {
      ...(url.searchParams.has("format")
        ? { format: parseImageFormat(url.searchParams.get("format")) }
        : {}),
      ...(url.searchParams.has("quality")
        ? {
            quality: parseInteger(url.searchParams.get("quality"), "quality", 1, 100),
          }
        : {}),
      ...(url.searchParams.has("maxWidth")
        ? {
            maxWidth: parseInteger(url.searchParams.get("maxWidth"), "maxWidth", 1, 4_096),
          }
        : {}),
      ...(url.searchParams.has("maxHeight")
        ? {
            maxHeight: parseInteger(url.searchParams.get("maxHeight"), "maxHeight", 1, 4_096),
          }
        : {}),
      ...(url.searchParams.has("everyNthFrame")
        ? {
            everyNthFrame: parseInteger(
              url.searchParams.get("everyNthFrame"),
              "everyNthFrame",
              1,
              60,
            ),
          }
        : {}),
    };
    const upgraded = server.upgrade(request, {
      data: {
        kind: "browser",
        reference: binding(authority),
        authorization:
          authorization.kind === "session"
            ? { kind: "session", tokenGeneration: authority.tokenGeneration }
            : {
                kind: "grant",
                grantId: authorization.grant.id,
                expiresAtMs: authorization.grant.expiresAtMs,
              },
        targetId: requireOpaqueId(targetId, "target id"),
        options,
        subscription: null,
        expiryTimer: null,
        closed: false,
      },
      headers: { "sec-websocket-protocol": BROWSER_CONTROL_WEBSOCKET_PROTOCOL },
    });
    if (!upgraded) {
      throw new ProtocolError("resource_unavailable", "frame stream upgrade failed", 503, true);
    }
    return undefined;
  }

  private upgradeComputerFrames(
    request: Request,
    server: BrowserServer,
    computerSessionId: string,
    targetId: string,
    url: URL,
  ): Response | undefined {
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!protocols.includes(COMPUTER_CONTROL_WEBSOCKET_PROTOCOL)) {
      throw new ProtocolError("invalid_action", "computer frame protocol is required", 426);
    }
    const bearerProtocols = protocols.filter((value) =>
      value.startsWith(BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX),
    );
    if (bearerProtocols.length !== 1) {
      throw new ProtocolError("permission_denied", "frame stream authorization is required", 401);
    }
    const token = requireToken(
      bearerProtocols[0]!.slice(BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX.length),
      "frame stream token",
    );
    const authorization = this.authorizeComputerToken(computerSessionId, token, false, true);
    const authority = authorization.authority;
    const options: ComputerFrameStreamOptions = {
      ...(url.searchParams.has("format")
        ? { format: parseImageFormat(url.searchParams.get("format")) }
        : {}),
      ...(url.searchParams.has("quality")
        ? { quality: parseInteger(url.searchParams.get("quality"), "quality", 1, 100) }
        : {}),
      ...(url.searchParams.has("maxWidth")
        ? { maxWidth: parseInteger(url.searchParams.get("maxWidth"), "maxWidth", 1, 4_096) }
        : {}),
      ...(url.searchParams.has("maxHeight")
        ? { maxHeight: parseInteger(url.searchParams.get("maxHeight"), "maxHeight", 1, 4_096) }
        : {}),
      ...(url.searchParams.has("everyNthFrame")
        ? {
            everyNthFrame: parseInteger(
              url.searchParams.get("everyNthFrame"),
              "everyNthFrame",
              1,
              60,
            ),
          }
        : {}),
    };
    const upgraded = server.upgrade(request, {
      data: {
        kind: "computer",
        reference: computerBinding(authority),
        authorization:
          authorization.kind === "session"
            ? { kind: "session", tokenGeneration: authority.tokenGeneration }
            : {
                kind: "grant",
                grantId: authorization.grant.id,
                expiresAtMs: authorization.grant.expiresAtMs,
              },
        targetId: requireOpaqueId(targetId, "target id"),
        options,
        subscription: null,
        expiryTimer: null,
        closed: false,
      },
      headers: { "sec-websocket-protocol": COMPUTER_CONTROL_WEBSOCKET_PROTOCOL },
    });
    if (!upgraded) {
      throw new ProtocolError("resource_unavailable", "frame stream upgrade failed", 503, true);
    }
    return undefined;
  }

  private onSocketOpen(socket: BrowserSocket): void {
    this.sockets.add(socket);
    const authority =
      socket.data.kind === "browser"
        ? this.authorities.get(socket.data.reference.browserSessionId)
        : this.computerAuthorities.get(socket.data.reference.computerSessionId);
    if (
      !authority ||
      authority.controllerGeneration !== socket.data.reference.controllerGeneration
    ) {
      socket.close(1008, "authorization is stale");
      return;
    }
    if (socket.data.authorization.kind === "session") {
      if (authority.tokenGeneration !== socket.data.authorization.tokenGeneration) {
        socket.close(1008, "authorization is stale");
        return;
      }
    } else {
      this.pruneViewGrants(authority);
      const grant = authority.viewGrants.get(socket.data.authorization.grantId);
      if (!grant || grant.expiresAtMs !== socket.data.authorization.expiresAtMs) {
        socket.close(1008, "authorization is stale");
        return;
      }
      const remainingMs = grant.expiresAtMs - Date.now();
      if (remainingMs <= 0) {
        socket.close(1008, "authorization expired");
        return;
      }
      socket.data.expiryTimer = setTimeout(() => {
        if (!socket.data.closed) socket.close(1008, "authorization expired");
      }, remainingMs);
    }
    void this.pumpFrames(socket);
  }

  private onSocketClose(socket: BrowserSocket): void {
    if (socket.data.closed) return;
    socket.data.closed = true;
    if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
    socket.data.expiryTimer = null;
    this.sockets.delete(socket);
    void socket.data.subscription?.close();
  }

  private async pumpFrames(socket: BrowserSocket): Promise<void> {
    if (socket.data.kind === "browser") {
      await this.pumpBrowserFrames(socket);
    } else {
      await this.pumpComputerFrames(socket);
    }
  }

  private async pumpBrowserFrames(socket: BrowserSocket): Promise<void> {
    const data = socket.data;
    if (data.kind !== "browser") return;
    try {
      const subscription = await this.supervisor.subscribeFrames(
        data.reference,
        data.targetId,
        data.options,
      );
      if (data.closed) {
        await subscription.close();
        return;
      }
      data.subscription = subscription;
      for await (const frame of subscription) {
        if (data.closed) break;
        if (socket.send(encodeBrowserFrameMessage(frame), false) < 0) {
          socket.close(1013, "frame consumer is too slow");
          break;
        }
      }
    } catch {
      if (!data.closed) socket.close(1011, "frame stream unavailable");
    } finally {
      await data.subscription?.close();
      data.subscription = null;
    }
  }

  private async pumpComputerFrames(socket: BrowserSocket): Promise<void> {
    const data = socket.data;
    if (data.kind !== "computer") return;
    const supervisor = this.computerSupervisor;
    if (!supervisor) {
      socket.close(1011, "computer controller unavailable");
      return;
    }
    try {
      const subscription = await supervisor.subscribeFrames(
        data.reference,
        data.targetId,
        data.options,
      );
      if (data.closed) {
        await subscription.close();
        return;
      }
      data.subscription = subscription;
      for await (const frame of subscription) {
        if (data.closed) break;
        if (socket.send(encodeComputerFrameMessage(frame), false) < 0) {
          socket.close(1013, "frame consumer is too slow");
          break;
        }
      }
    } catch {
      if (!data.closed) socket.close(1011, "frame stream unavailable");
    } finally {
      await data.subscription?.close();
      data.subscription = null;
    }
  }

  private requireAdmin(request: Request): void {
    const token = bearerToken(request);
    if (!token || !sameDigest(tokenDigest(token), this.adminDigest)) {
      throw new ProtocolError("permission_denied", "admin authorization is required", 401);
    }
  }

  private requireSession(
    request: Request,
    browserSessionId: string,
    control: boolean,
  ): SessionAuthority {
    const token = bearerToken(request);
    if (!token) {
      throw new ProtocolError("permission_denied", "session authorization is required", 401);
    }
    return this.authorizeToken(browserSessionId, token, control).authority;
  }

  private requireComputerSession(
    request: Request,
    computerSessionId: string,
    control: boolean,
  ): ComputerSessionAuthority {
    const token = bearerToken(request);
    if (!token) {
      throw new ProtocolError("permission_denied", "session authorization is required", 401);
    }
    return this.authorizeComputerToken(computerSessionId, token, control).authority;
  }

  private authorizeToken(
    browserSessionId: string,
    token: string,
    control: boolean,
    allowViewGrant = false,
  ): SessionAuthorization {
    const authority = this.authorities.get(browserSessionId);
    const digest = tokenDigest(token);
    if (!authority) {
      throw new ProtocolError("permission_denied", "session authorization is invalid", 401);
    }
    if (
      sameDigest(digest, authority.controlDigest) ||
      (!control && sameDigest(digest, authority.viewDigest))
    ) {
      return { authority, kind: "session" };
    }
    if (!control && allowViewGrant) {
      this.pruneViewGrants(authority);
      for (const grant of authority.viewGrants.values()) {
        if (sameDigest(digest, grant.digest)) return { authority, kind: "grant", grant };
      }
    }
    throw new ProtocolError("permission_denied", "session authorization is invalid", 401);
  }

  private authorizeComputerToken(
    computerSessionId: string,
    token: string,
    control: boolean,
    allowViewGrant = false,
  ): ComputerSessionAuthorization {
    const authority = this.computerAuthorities.get(computerSessionId);
    const digest = tokenDigest(token);
    if (!authority) {
      throw new ProtocolError("permission_denied", "session authorization is invalid", 401);
    }
    if (
      sameDigest(digest, authority.controlDigest) ||
      (!control && sameDigest(digest, authority.viewDigest))
    ) {
      return { authority, kind: "session" };
    }
    if (!control && allowViewGrant) {
      this.pruneViewGrants(authority);
      for (const grant of authority.viewGrants.values()) {
        if (sameDigest(digest, grant.digest)) return { authority, kind: "grant", grant };
      }
    }
    throw new ProtocolError("permission_denied", "session authorization is invalid", 401);
  }

  private pruneViewGrants(authority: { viewGrants: Map<string, ViewGrant> }): void {
    const now = Date.now();
    for (const [grantId, grant] of authority.viewGrants) {
      if (grant.expiresAtMs <= now) authority.viewGrants.delete(grantId);
    }
  }

  private closeSessionSockets(browserSessionId: string, code: number, reason: string): void {
    this.closeResourceSockets("browser", browserSessionId, code, reason);
  }

  private closeResourceSockets(
    kind: "browser" | "computer",
    resourceId: string,
    code: number,
    reason: string,
  ): void {
    for (const socket of [...this.sockets]) {
      const matches =
        socket.data.kind === kind &&
        (socket.data.kind === "browser"
          ? socket.data.reference.browserSessionId === resourceId
          : socket.data.reference.computerSessionId === resourceId);
      if (matches) {
        socket.close(code, reason);
      }
    }
  }

  private async withLifecycleLock<T>(
    browserSessionId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(browserSessionId) ?? Promise.resolve();
    const result = previous.then(callback, callback);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(browserSessionId, tail);
    try {
      return await result;
    } finally {
      if (this.lifecycleTails.get(browserSessionId) === tail) {
        this.lifecycleTails.delete(browserSessionId);
      }
    }
  }

  private preflight(request: Request): Response {
    if (!request.headers.get("access-control-request-method")) {
      throw new ProtocolError("invalid_action", "invalid preflight request", 400);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-max-age": "600",
      },
    });
  }

  private withCors(response: Response, origin: string | null): Response {
    response.headers.set("cache-control", response.headers.get("cache-control") ?? "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    if (origin) {
      response.headers.set("access-control-allow-origin", origin);
      response.headers.append("vary", "Origin");
    }
    return response;
  }
}

class ProtocolError extends Error {
  constructor(
    readonly code: InteractionError["code"],
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function protocolResponse(error: unknown): Response {
  if (error instanceof ProtocolError)
    return failure(error.code, error.message, error.retryable, error.status);
  if (error instanceof InteractionControllerError) {
    return failure(
      error.code === "journal_full" ? "resource_unavailable" : error.code,
      error.message,
      error.retryable,
      interactionStatus(error.code),
    );
  }
  return failure("driver_failed", "interaction controller request failed", false, 500);
}

function success(data: unknown, status = 200): Response {
  const body = JSON.stringify({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    ok: true,
    data,
  });
  if (Buffer.byteLength(body) > BROWSER_CONTROL_MAX_JSON_BYTES) {
    throw new ProtocolError(
      "resource_unavailable",
      "browser controller response exceeds its wire envelope",
      503,
    );
  }
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function failure(
  code: InteractionError["code"],
  message: string,
  retryable: boolean,
  status: number,
): Response {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (status === 401) headers["www-authenticate"] = "Bearer";
  headers["content-type"] = "application/json; charset=utf-8";
  return new Response(
    JSON.stringify({
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      ok: false,
      error: { code, message, retryable },
    }),
    { status, headers },
  );
}

function interactionStatus(code: string): number {
  if (code === "resource_not_found" || code === "target_not_found") return 404;
  if (code === "permission_denied") return 403;
  if (code === "machine_locked") return 423;
  if (code.endsWith("_stale") || code === "operation_conflict" || code === "outcome_unknown")
    return 409;
  if (code === "resource_unavailable" || code === "controller_lost" || code === "journal_full")
    return 503;
  if (code === "timeout") return 504;
  if (code === "invalid_action" || code === "locator_not_found" || code === "locator_ambiguous")
    return 400;
  if (code === "unsupported") return 422;
  return 500;
}

function routeNeedsControl(segments: readonly string[], request: Request): boolean {
  if (
    segments[3] === "actions" ||
    segments[3] === "protected-auth-fills" ||
    segments[3] === "protected-auth-operations"
  ) {
    return true;
  }
  if (segments[3] !== "targets") return false;
  if (segments.length === 4) return request.method === "POST";
  if (segments.length === 5) return request.method === "DELETE";
  return segments[5] === "select";
}

function routeNeedsComputerControl(segments: readonly string[]): boolean {
  return segments[3] === "actions" || segments[3] === "heartbeat";
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProtocolError("invalid_action", "application/json body is required", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared) {
    if (!/^(0|[1-9][0-9]*)$/u.test(declared) || !Number.isSafeInteger(Number(declared))) {
      throw new ProtocolError("invalid_action", "content-length is invalid", 400);
    }
    if (Number(declared) > BROWSER_CONTROL_MAX_JSON_BYTES) {
      throw new ProtocolError("invalid_action", "request body is too large", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > BROWSER_CONTROL_MAX_JSON_BYTES) {
    throw new ProtocolError("invalid_action", "request body is empty or too large", 413);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProtocolError("invalid_action", "request body is invalid JSON", 400);
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const value = await readJson(request);
  if (!isRecord(value)) throw new ProtocolError("invalid_action", "JSON object is required", 400);
  return value;
}

function parseActionCommand(value: unknown): BrowserActionCommandValue {
  const result = BrowserActionCommand.safeParse(value);
  if (!result.success) throw new ProtocolError("invalid_action", "browser action is invalid", 400);
  return result.data;
}

function parseProtectedAuthFillCommand(value: unknown): BrowserProtectedAuthFillCommandValue {
  const result = BrowserProtectedAuthFillCommand.safeParse(value);
  if (!result.success) {
    throw new ProtocolError("invalid_action", "protected-fill command is invalid", 400);
  }
  return result.data;
}

function parseComputerActionCommand(value: unknown): ComputerActionCommandValue {
  const result = ComputerActionCommand.safeParse(value);
  if (!result.success) throw new ProtocolError("invalid_action", "computer action is invalid", 400);
  return result.data;
}

function parseCreateSession(value: Record<string, unknown>): {
  browserSessionId: string;
  controllerGeneration: string;
  tokenGeneration: number;
  controlToken: string;
  viewToken: string;
  headed: boolean;
  initialUrl?: string;
  transport?: NonNullable<BrowserSupervisorSessionOptions["transport"]>;
  linkedComputer?: { computerSessionId: string; controllerGeneration: string };
  restore?: BrowserStateRestoreInput & { dataKey: Buffer; aad: Buffer };
} {
  assertOnlyKeys(value, [
    "browserSessionId",
    "controllerGeneration",
    "tokenGeneration",
    "controlToken",
    "viewToken",
    "headed",
    "initialUrl",
    "transport",
    "linkedComputer",
    "restore",
  ]);
  return {
    browserSessionId: requireUuid(value.browserSessionId, "browserSessionId"),
    controllerGeneration: requireGeneration(value.controllerGeneration),
    tokenGeneration: requireInteger(
      value.tokenGeneration,
      "tokenGeneration",
      1,
      MAX_TOKEN_GENERATION,
    ),
    controlToken: requireToken(value.controlToken, "controlToken"),
    viewToken: requireToken(value.viewToken, "viewToken"),
    headed: requireBoolean(value.headed, "headed"),
    ...(value.initialUrl === undefined
      ? {}
      : { initialUrl: requireString(value.initialUrl, "initialUrl", 16_384) }),
    ...(value.transport === undefined ? {} : { transport: parseBrowserTransport(value.transport) }),
    ...(value.linkedComputer === undefined
      ? {}
      : { linkedComputer: parseLinkedComputer(value.linkedComputer) }),
    ...(value.restore === undefined ? {} : { restore: parseStateRestore(value.restore) }),
  };
}

function parseLinkedComputer(value: unknown): {
  computerSessionId: string;
  controllerGeneration: string;
} {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_action", "linkedComputer is invalid", 400);
  }
  assertOnlyKeys(value, ["computerSessionId", "controllerGeneration"]);
  return {
    computerSessionId: requireUuid(value.computerSessionId, "linkedComputer.computerSessionId"),
    controllerGeneration: requireGeneration(value.controllerGeneration),
  };
}

function parseCreateComputerSession(value: Record<string, unknown>): {
  computerSessionId: string;
  controllerGeneration: string;
  tokenGeneration: number;
  controlToken: string;
  viewToken: string;
} {
  assertOnlyKeys(value, [
    "computerSessionId",
    "controllerGeneration",
    "tokenGeneration",
    "controlToken",
    "viewToken",
  ]);
  return {
    computerSessionId: requireUuid(value.computerSessionId, "computerSessionId"),
    controllerGeneration: requireGeneration(value.controllerGeneration),
    tokenGeneration: requireInteger(
      value.tokenGeneration,
      "tokenGeneration",
      1,
      MAX_TOKEN_GENERATION,
    ),
    controlToken: requireToken(value.controlToken, "controlToken"),
    viewToken: requireToken(value.viewToken, "viewToken"),
  };
}

function parseBrowserTransport(
  value: unknown,
): NonNullable<BrowserSupervisorSessionOptions["transport"]> {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_action", "browser transport is invalid", 400);
  }
  if (value.kind === "managed") {
    assertOnlyKeys(value, ["kind"]);
    return { kind: "managed" };
  }
  if (value.kind !== "attached_chrome") {
    throw new ProtocolError("invalid_action", "browser transport is unsupported", 400);
  }
  assertOnlyKeys(value, [
    "kind",
    "deviceId",
    "connectionGeneration",
    "browserName",
    "browserVersion",
  ]);
  return {
    kind: "attached_chrome",
    deviceId: requireUuid(value.deviceId, "attached browser id"),
    connectionGeneration: requireString(
      value.connectionGeneration,
      "attached browser connection generation",
      512,
    ),
    browserName: requireString(value.browserName, "attached browser name", 100),
    browserVersion: requireString(value.browserVersion, "attached browser version", 256),
  };
}

function parseStateRestore(
  value: unknown,
): BrowserStateRestoreInput & { dataKey: Buffer; aad: Buffer } {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_action", "browser state restore is invalid", 400);
  }
  assertOnlyKeys(value, [
    "objectKey",
    "format",
    "artifactDigest",
    "contentDigest",
    "manifestDigest",
    "sizeBytes",
    "dataKeyBase64",
    "aadBase64",
    "materialization",
    "download",
  ]);
  if (!isRecord(value.download)) {
    throw new ProtocolError("invalid_action", "browser state restore download is invalid", 400);
  }
  assertOnlyKeys(value.download, ["url", "expiresAt"]);
  const materialization = BrowserRevisionMaterialization.safeParse(value.materialization);
  if (!materialization.success) {
    throw new ProtocolError(
      "invalid_action",
      "browser state restore materialization is invalid",
      400,
    );
  }
  if (value.format !== BROWSER_PROFILE_ARTIFACT_FORMAT) {
    throw new ProtocolError("invalid_action", "browser state restore format is unsupported", 400);
  }
  const dataKey = requireCanonicalBase64(value.dataKeyBase64, 32, 32, "browser state data key");
  let aad: Buffer | null = null;
  try {
    aad = requireCanonicalBase64(value.aadBase64, 1, 16 * 1024, "browser state associated data");
    return {
      objectKey: requireBrowserStateObjectKey(value.objectKey),
      format: BROWSER_PROFILE_ARTIFACT_FORMAT,
      artifactDigest: requireSha256(value.artifactDigest, "artifact digest"),
      contentDigest: requireSha256(value.contentDigest, "content digest"),
      manifestDigest: requireSha256(value.manifestDigest, "manifest digest"),
      sizeBytes: requireInteger(
        value.sizeBytes,
        "browser state artifact size",
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      dataKey,
      aad,
      materialization: materialization.data,
      download: {
        url: requireString(value.download.url, "browser state download URL", 16 * 1024),
        expiresAt: requireString(value.download.expiresAt, "browser state download expiry", 128),
      },
    };
  } catch (error) {
    dataKey.fill(0);
    aad?.fill(0);
    throw error;
  }
}

function parseStateCapture(
  value: Record<string, unknown>,
  browserSessionId: string,
): BrowserStateCaptureInput & { dataKey: Buffer; aad: Buffer } {
  assertOnlyKeys(value, [
    "operationId",
    "controllerGeneration",
    "objectKey",
    "afterCapture",
    "dataKeyBase64",
    "aadBase64",
    "upload",
  ]);
  if (!isRecord(value.upload)) {
    throw new ProtocolError("invalid_action", "browser state upload is invalid", 400);
  }
  assertOnlyKeys(value.upload, ["url", "requiredHeaders", "expiresAt"]);
  if (!isRecord(value.upload.requiredHeaders)) {
    throw new ProtocolError("invalid_action", "browser state upload headers are invalid", 400);
  }
  const requiredHeaders: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.upload.requiredHeaders)) {
    requiredHeaders[name] = requireString(headerValue, "browser state upload header", 8_192);
  }
  const dataKey = requireCanonicalBase64(value.dataKeyBase64, 32, 32, "browser state data key");
  let aad: Buffer | null = null;
  try {
    aad = requireCanonicalBase64(value.aadBase64, 1, 16 * 1024, "browser state associated data");
    return {
      browserSessionId,
      operationId: requireUuid(value.operationId, "browser state operation id"),
      controllerGeneration: requireGeneration(value.controllerGeneration),
      objectKey: requireBrowserStateObjectKey(value.objectKey),
      afterCapture: requireStateCaptureDisposition(value.afterCapture),
      dataKey,
      aad,
      upload: {
        url: requireString(value.upload.url, "browser state upload URL", 16 * 1024),
        requiredHeaders,
        expiresAt: requireString(value.upload.expiresAt, "browser state upload expiry", 128),
      },
    };
  } catch (error) {
    dataKey.fill(0);
    aad?.fill(0);
    throw error;
  }
}

function requireStateCaptureDisposition(value: unknown): "restart" | "stop" {
  if (value !== "restart" && value !== "stop") {
    throw new ProtocolError(
      "invalid_action",
      "browser state post-capture behavior is invalid",
      400,
    );
  }
  return value;
}

function requireBrowserStateObjectKey(value: unknown): string {
  const key = requireString(value, "browser state object key", 2_048);
  if (
    !/^workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/browser-state\/[A-Za-z0-9._=-]+(?:\/[A-Za-z0-9._=-]+)*$/iu.test(
      key,
    )
  ) {
    throw new ProtocolError("invalid_action", "browser state object key is invalid", 400);
  }
  return key;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label, 64);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  return digest;
}

function requireCanonicalBase64(
  value: unknown,
  minimumBytes: number,
  maximumBytes: number,
  label: string,
): Buffer {
  const encoded = requireString(value, label, Math.ceil((maximumBytes * 4) / 3) + 4);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.byteLength < minimumBytes ||
    decoded.byteLength > maximumBytes ||
    decoded.toString("base64") !== encoded
  ) {
    decoded.fill(0);
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  return decoded;
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  try {
    return requireToken(value.slice(7), "bearer token");
  } catch {
    return null;
  }
}

function requireToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new ProtocolError("permission_denied", `${label} is invalid`, 401);
  }
  return value;
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function binding(authority: SessionAuthority | BrowserSessionReference): BrowserSessionReference {
  return {
    browserSessionId: authority.browserSessionId,
    controllerGeneration: authority.controllerGeneration,
  };
}

function computerBinding(
  authority: ComputerSessionAuthority | ComputerSessionReference,
): ComputerSessionReference {
  return {
    computerSessionId: authority.computerSessionId,
    controllerGeneration: authority.controllerGeneration,
  };
}

function pathSegments(pathname: string): string[] {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new ProtocolError("invalid_action", "path encoding is invalid", 400);
  }
}

function requireUuid(value: unknown, label: string): string {
  const string = requireString(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(string)) {
    throw new ProtocolError("invalid_action", `${label} must be a UUID`, 400);
  }
  return string;
}

function requireGeneration(value: unknown): string {
  const generation = requireString(value, "controllerGeneration", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(generation)) {
    throw new ProtocolError("invalid_action", "controllerGeneration is invalid", 400);
  }
  return generation;
}

function requireOpaqueId(value: unknown, label: string): string {
  const id = requireString(value, label, 512);
  if (/[\x00-\x1f\x7f]/u.test(id)) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  return id;
}

function requireString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maxBytes) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolError("invalid_action", `${label} must be boolean`, 400);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  return value;
}

function parseInteger(
  value: string | null,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  return requireInteger(Number(value), label, minimum, maximum);
}

function parseBoolean(value: string | null, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
}

function parseImageFormat(value: string | null): "jpeg" | "png" {
  if (value === "jpeg" || value === "png") return value;
  throw new ProtocolError("invalid_action", "image format is invalid", 400);
}

function parseDiagnosticKinds(
  value: string,
): Array<"console" | "page_error" | "failed_request" | "download"> {
  const kinds = value.split(",").filter(Boolean);
  const allowed = new Set(["console", "page_error", "failed_request", "download"]);
  if (kinds.length === 0 || kinds.length > 4 || kinds.some((kind) => !allowed.has(kind))) {
    throw new ProtocolError("invalid_action", "diagnostic kinds are invalid", 400);
  }
  return [...new Set(kinds)] as Array<"console" | "page_error" | "failed_request" | "download">;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ProtocolError("invalid_action", "request contains unknown fields", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin === "null" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("allowed browser origin must be an absolute origin");
  }
  return url.origin;
}

function parseOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new ProtocolError("invalid_action", "origin is invalid", 400);
  }
  try {
    return normalizeOrigin(value);
  } catch {
    throw new ProtocolError("invalid_action", "origin must be an absolute origin", 400);
  }
}

function requireFutureTimestamp(
  value: unknown,
  label: string,
): { value: string; milliseconds: number } {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    throw new ProtocolError("invalid_action", `${label} is invalid`, 400);
  }
  const milliseconds = Date.parse(value);
  const remaining = milliseconds - Date.now();
  if (!Number.isFinite(milliseconds) || remaining <= 0 || remaining > MAX_VIEW_GRANT_TTL_MS) {
    throw new ProtocolError("invalid_action", `${label} is outside its supported window`, 400);
  }
  return { value, milliseconds };
}

function safeNormalizeOrigin(value: string): string | null {
  try {
    return normalizeOrigin(value);
  } catch {
    return null;
  }
}

function formatHost(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}
