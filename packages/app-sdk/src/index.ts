export const OG_APP_BRIDGE_PROTOCOL = "opengeni.app-bridge.v1" as const;

export type OgJsonPrimitive = string | number | boolean | null;
export type OgJsonValue = OgJsonPrimitive | OgJsonValue[] | { [key: string]: OgJsonValue };

export type OgAppContext = {
  workspaceId: string;
  appId: string;
  launchId: string;
  releaseId: string;
  catalogDigest: string;
  authorityGeneration: string;
  appVersion: string;
  grantedCapabilities: string[];
};

export type OgCapabilityInvocation = {
  capability: string;
  operation: string;
  input?: OgJsonValue;
  operationId?: string;
};

export type OgCapabilityInvocationResult = OgJsonValue;
export type AppToolResult = OgCapabilityInvocationResult;

export type AppCallOptions = {
  operationId?: string;
  signal?: AbortSignal;
};

/** Build-generated declarations augment this interface with the frozen tool tree. */
export interface AppGeneratedTools {}

export type OgAppBridgeErrorCode =
  | "bridge_closed"
  | "bridge_timeout"
  | "capability_not_granted"
  | "host_error"
  | "invalid_message"
  | "too_many_requests";

export class OgAppBridgeError extends Error {
  readonly code: OgAppBridgeErrorCode;

  constructor(code: OgAppBridgeErrorCode, message: string) {
    super(message);
    this.name = "OgAppBridgeError";
    this.code = code;
  }
}

type OgBridgeConnectMessage = {
  protocol: typeof OG_APP_BRIDGE_PROTOCOL;
  kind: "connect";
  token: string;
};

type OgBridgeReadyMessage = {
  protocol: typeof OG_APP_BRIDGE_PROTOCOL;
  kind: "ready";
  token: string;
};

type OgBridgeRequestMessage = {
  protocol: typeof OG_APP_BRIDGE_PROTOCOL;
  kind: "request";
  id: string;
  method: "og.context.get" | "og.capability.invoke";
  params: OgJsonValue;
};

type OgBridgeSuccessMessage = {
  protocol: typeof OG_APP_BRIDGE_PROTOCOL;
  kind: "response";
  id: string;
  ok: true;
  result: OgJsonValue;
};

type OgBridgeFailureMessage = {
  protocol: typeof OG_APP_BRIDGE_PROTOCOL;
  kind: "response";
  id: string;
  ok: false;
  error: {
    code: OgAppBridgeErrorCode;
    message: string;
  };
};

type OgBridgeResponseMessage = OgBridgeSuccessMessage | OgBridgeFailureMessage;

export type OgMessagePort = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
  close?(): void;
};

export type OgMessageChannel = {
  port1: OgMessagePort;
  port2: OgMessagePort;
};

export type OgAppHostWindow = {
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
};

export type OgAppHostBridge = {
  readonly ready: Promise<void>;
  close(): void;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const MAX_JSON_DEPTH = 64;
const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024;
const MAX_CAPABILITY_CHARS = 8 * 128 + 7;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOgJsonValue(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): value is OgJsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isOgJsonValue(item, seen, depth + 1))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isOgJsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

function bridgeMessageWithinLimit(value: OgJsonValue): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BRIDGE_MESSAGE_BYTES;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 96;
}

function capabilityInvocation(value: unknown): OgCapabilityInvocation | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.capability !== "string" ||
    value.capability.length === 0 ||
    value.capability.length > MAX_CAPABILITY_CHARS ||
    typeof value.operation !== "string" ||
    value.operation.length === 0 ||
    value.operation.length > 128 ||
    (value.operationId !== undefined &&
      (typeof value.operationId !== "string" || !UUID_PATTERN.test(value.operationId))) ||
    (value.input !== undefined && !isOgJsonValue(value.input))
  ) {
    return null;
  }
  return {
    capability: value.capability,
    operation: value.operation,
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
  };
}

function appContext(value: unknown): OgAppContext | null {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    typeof value.appId !== "string" ||
    value.appId.length === 0 ||
    typeof value.launchId !== "string" ||
    value.launchId.length === 0 ||
    typeof value.releaseId !== "string" ||
    value.releaseId.length === 0 ||
    typeof value.catalogDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.catalogDigest) ||
    typeof value.authorityGeneration !== "string" ||
    value.authorityGeneration.length === 0 ||
    value.authorityGeneration.length > 256 ||
    typeof value.appVersion !== "string" ||
    value.appVersion.length === 0 ||
    !Array.isArray(value.grantedCapabilities) ||
    value.grantedCapabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        capability.length === 0 ||
        capability.length > MAX_CAPABILITY_CHARS,
    ) ||
    new Set(value.grantedCapabilities).size !== value.grantedCapabilities.length
  ) {
    return null;
  }
  return value as OgAppContext;
}

function responseFailure(
  id: string,
  code: OgAppBridgeErrorCode,
  message: string,
): OgBridgeFailureMessage {
  return {
    protocol: OG_APP_BRIDGE_PROTOCOL,
    kind: "response",
    id,
    ok: false,
    error: { code, message },
  };
}

function responseSuccess(id: string, result: OgJsonValue): OgBridgeSuccessMessage {
  return {
    protocol: OG_APP_BRIDGE_PROTOCOL,
    kind: "response",
    id,
    ok: true,
    result,
  };
}

function createChannel(): OgMessageChannel {
  if (typeof MessageChannel === "undefined") {
    throw new OgAppBridgeError("host_error", "MessageChannel is unavailable in this browser.");
  }
  return new MessageChannel() as unknown as OgMessageChannel;
}

export function createOgAppHostBridge(options: {
  targetWindow: OgAppHostWindow;
  token: string;
  context: OgAppContext;
  grantedCapabilities: Iterable<string>;
  invoke: (request: OgCapabilityInvocation) => Promise<OgCapabilityInvocationResult>;
  targetOrigin: string;
  readyTimeoutMs?: number;
  maxPendingRequests?: number;
  channelFactory?: () => OgMessageChannel;
}): OgAppHostBridge {
  if (!validToken(options.token)) {
    throw new TypeError("The Apps bridge token must be 16-256 URL-safe characters.");
  }
  let targetOrigin: string;
  try {
    const parsedTargetOrigin = new URL(options.targetOrigin);
    if (
      (parsedTargetOrigin.protocol !== "https:" && parsedTargetOrigin.protocol !== "http:") ||
      parsedTargetOrigin.username ||
      parsedTargetOrigin.password ||
      parsedTargetOrigin.pathname !== "/" ||
      parsedTargetOrigin.search ||
      parsedTargetOrigin.hash
    ) {
      throw new Error("invalid target origin");
    }
    targetOrigin = parsedTargetOrigin.origin;
  } catch {
    throw new TypeError("The Apps bridge targetOrigin must be one exact HTTP(S) origin.");
  }
  if (!appContext(options.context) || !isOgJsonValue(options.context)) {
    throw new TypeError("The Apps bridge context must be JSON-safe.");
  }
  const grantedCapabilities = new Set(options.grantedCapabilities);
  if (
    grantedCapabilities.size !== options.context.grantedCapabilities.length ||
    options.context.grantedCapabilities.some((capability) => !grantedCapabilities.has(capability))
  ) {
    throw new TypeError("The Apps bridge context and capability allowlist must match.");
  }

  const channel = (options.channelFactory ?? createChannel)();
  const port = channel.port1;
  const maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
  if (!Number.isInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 256) {
    throw new RangeError("maxPendingRequests must be an integer between 1 and 256.");
  }
  let closed = false;
  let activeRequests = 0;
  let readySettled = false;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new RangeError("readyTimeoutMs must be a finite positive number.");
  }
  const timer = setTimeout(() => {
    if (readySettled || closed) return;
    readySettled = true;
    rejectReady?.(new OgAppBridgeError("bridge_timeout", "The app did not accept its bridge."));
  }, readyTimeoutMs);

  const listener = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isRecord(message) || message.protocol !== OG_APP_BRIDGE_PROTOCOL) return;
    if (message.kind === "ready") {
      if (message.token !== options.token || readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      resolveReady?.();
      return;
    }
    if (
      message.kind !== "request" ||
      !validRequestId(message.id) ||
      (message.method !== "og.context.get" && message.method !== "og.capability.invoke") ||
      !isOgJsonValue(message.params) ||
      !bridgeMessageWithinLimit(message.params)
    ) {
      return;
    }
    const request = message as OgBridgeRequestMessage;
    if (activeRequests >= maxPendingRequests) {
      port.postMessage(
        responseFailure(request.id, "too_many_requests", "Too many app requests are pending."),
      );
      return;
    }
    activeRequests += 1;
    void (async () => {
      try {
        if (request.method === "og.context.get") {
          port.postMessage(responseSuccess(request.id, options.context));
          return;
        }
        const invocation = capabilityInvocation(request.params);
        if (!invocation) {
          port.postMessage(
            responseFailure(request.id, "invalid_message", "The capability request is invalid."),
          );
          return;
        }
        if (!grantedCapabilities.has(invocation.capability)) {
          port.postMessage(
            responseFailure(
              request.id,
              "capability_not_granted",
              `Capability ${invocation.capability} was not confirmed for this run.`,
            ),
          );
          return;
        }
        const result = await options.invoke(invocation);
        if (!isOgJsonValue(result) || !bridgeMessageWithinLimit(result)) {
          port.postMessage(
            responseFailure(request.id, "host_error", "The host returned an invalid response."),
          );
          return;
        }
        port.postMessage(responseSuccess(request.id, result));
      } catch {
        port.postMessage(
          responseFailure(request.id, "host_error", "The capability request failed."),
        );
      } finally {
        activeRequests -= 1;
      }
    })();
  };

  port.addEventListener("message", listener);
  port.start?.();
  const connect: OgBridgeConnectMessage = {
    protocol: OG_APP_BRIDGE_PROTOCOL,
    kind: "connect",
    token: options.token,
  };
  options.targetWindow.postMessage(connect, targetOrigin, [
    channel.port2 as unknown as Transferable,
  ]);

  return {
    ready,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      port.removeEventListener("message", listener);
      port.close?.();
      channel.port2.close?.();
      if (!readySettled) {
        readySettled = true;
        rejectReady?.(new OgAppBridgeError("bridge_closed", "The app bridge was closed."));
      }
    },
  };
}

type PendingRequest = {
  resolve(value: OgJsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener(): void;
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The app request was aborted.", "AbortError");
}

function createGeneratedToolProxy(client: OgAppClient, path: string[] = []): unknown {
  const callable = () => undefined;
  return new Proxy(callable, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return undefined;
      return createGeneratedToolProxy(client, [...path, property]);
    },
    apply(_target, _thisArg, argumentsList) {
      const input = argumentsList[0] ?? {};
      const options = argumentsList[1] as AppCallOptions | undefined;
      if (!isRecord(input) || !isOgJsonValue(input)) {
        return Promise.reject(
          new OgAppBridgeError("invalid_message", "App tool input must be a JSON object."),
        );
      }
      return client.invokeTool(path.join("."), input, options);
    },
  });
}

export class OgAppClient {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;
  readonly tools: AppGeneratedTools;

  constructor(
    private readonly port: OgMessagePort,
    private readonly token: string,
    private readonly requestTimeoutMs: number,
  ) {
    this.tools = createGeneratedToolProxy(this) as AppGeneratedTools;
    this.port.addEventListener("message", this.onMessage);
    this.port.start?.();
    const ready: OgBridgeReadyMessage = {
      protocol: OG_APP_BRIDGE_PROTOCOL,
      kind: "ready",
      token,
    };
    this.port.postMessage(ready);
  }

  async getContext(): Promise<OgAppContext> {
    const result = await this.request("og.context.get", {});
    const context = appContext(result);
    if (!context) {
      throw new OgAppBridgeError("invalid_message", "The host returned an invalid app context.");
    }
    return context;
  }

  async invoke(
    capability: string,
    operation: string,
    input?: OgJsonValue,
    options: AppCallOptions = {},
  ): Promise<OgCapabilityInvocationResult> {
    return await this.request(
      "og.capability.invoke",
      {
        capability,
        operation,
        ...(input === undefined ? {} : { input }),
        ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      },
      options,
    );
  }

  async invokeTool(
    toolName: string,
    input: { [key: string]: OgJsonValue } = {},
    options: AppCallOptions = {},
  ): Promise<OgCapabilityInvocationResult> {
    return await this.invoke(toolName, "call", input, options);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.removeEventListener("message", this.onMessage);
    this.port.close?.();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(new OgAppBridgeError("bridge_closed", "The app bridge was closed."));
    }
    this.pending.clear();
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      !isRecord(message) ||
      message.protocol !== OG_APP_BRIDGE_PROTOCOL ||
      message.kind !== "response" ||
      !validRequestId(message.id) ||
      typeof message.ok !== "boolean"
    ) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    const response = message as OgBridgeResponseMessage;
    if (response.ok) {
      if (!isOgJsonValue(response.result) || !bridgeMessageWithinLimit(response.result)) {
        pending.reject(
          new OgAppBridgeError("invalid_message", "The host returned an invalid response."),
        );
        return;
      }
      pending.resolve(response.result);
      return;
    }
    pending.reject(new OgAppBridgeError(response.error.code, response.error.message));
  };

  private request(
    method: OgBridgeRequestMessage["method"],
    params: OgJsonValue,
    options: AppCallOptions = {},
  ): Promise<OgJsonValue> {
    if (this.closed) {
      return Promise.reject(new OgAppBridgeError("bridge_closed", "The app bridge is closed."));
    }
    if (this.pending.size >= DEFAULT_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new OgAppBridgeError("too_many_requests", "Too many app requests are pending."),
      );
    }
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    if (!isOgJsonValue(params) || !bridgeMessageWithinLimit(params)) {
      return Promise.reject(
        new OgAppBridgeError("invalid_message", "The app request exceeds bridge JSON limits."),
      );
    }
    const id = String(this.nextRequestId++);
    return new Promise<OgJsonValue>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbortListener();
        reject(abortError(options.signal!));
      };
      const removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        removeAbortListener();
        reject(new OgAppBridgeError("bridge_timeout", "The app request timed out."));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, removeAbortListener });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      const request: OgBridgeRequestMessage = {
        protocol: OG_APP_BRIDGE_PROTOCOL,
        kind: "request",
        id,
        method,
        params,
      };
      this.port.postMessage(request);
    });
  }
}

export async function connectOgApp(
  options: {
    window?: Pick<Window, "parent" | "addEventListener" | "removeEventListener">;
    timeoutMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Promise<OgAppClient> {
  const appWindow = options.window ?? window;
  if (appWindow.parent === appWindow) {
    throw new OgAppBridgeError("host_error", "OpenGeni Apps must run inside a host frame.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a finite positive number.");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError("requestTimeoutMs must be a finite positive number.");
  }

  return await new Promise<OgAppClient>((resolve, reject) => {
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== appWindow.parent || event.ports.length !== 1) return;
      const message = event.data;
      if (
        !isRecord(message) ||
        message.protocol !== OG_APP_BRIDGE_PROTOCOL ||
        message.kind !== "connect" ||
        !validToken(message.token)
      ) {
        return;
      }
      const transferredPort = event.ports[0];
      if (!transferredPort) return;
      clearTimeout(timer);
      appWindow.removeEventListener("message", listener as EventListener);
      resolve(
        new OgAppClient(
          transferredPort as unknown as OgMessagePort,
          message.token,
          requestTimeoutMs,
        ),
      );
    };
    const timer = setTimeout(() => {
      appWindow.removeEventListener("message", listener as EventListener);
      reject(new OgAppBridgeError("bridge_timeout", "The OpenGeni host did not connect."));
    }, timeoutMs);
    appWindow.addEventListener("message", listener as EventListener);
  });
}

export async function installOgGlobal(
  options: Parameters<typeof connectOgApp>[0] = {},
): Promise<OgAppClient> {
  const client = await connectOgApp(options);
  Object.defineProperty(globalThis, "og", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: client,
  });
  return client;
}

declare global {
  // `var` is intentional: it describes the browser global installed by
  // `installOgGlobal` without claiming every app has connected already.
  // eslint-disable-next-line no-var
  var og: OgAppClient | undefined;
}
