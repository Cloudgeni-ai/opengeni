import {
  OpenGeniToolsClient,
  type OpenGeniToolTransport,
  type OpenGeniWorkspaceTools,
} from "./tools";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayCatalog,
  ToolGatewayDeclarationsResponse,
} from "./types";

export const OPENGENI_SITE_BRIDGE_VERSION = 2 as const;
export const OPENGENI_SITE_BRIDGE_CONNECT = "opengeni.site.connect" as const;
export const OPENGENI_SITE_BRIDGE_READY = "opengeni.site.ready" as const;
export const OPENGENI_SITE_BRIDGE_REQUEST = "opengeni.site.request" as const;
export const OPENGENI_SITE_BRIDGE_RESPONSE = "opengeni.site.response" as const;
export const OPENGENI_SITE_BRIDGE_CANCEL = "opengeni.site.cancel" as const;
export const OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL = "__opengeniSiteBridgeBootstrapV2" as const;
export const OPENGENI_SITE_LOCAL_CODEMODE_PATH = "/__opengeni/site-tools" as const;

export type OpenGeniSiteBridgeConnectMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_CONNECT;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
};

export type OpenGeniSiteBridgeReadyMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_READY;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
};

/** Site-originated calls cannot carry host-only approval tokens or Site-version authority. */
export type OpenGeniSiteToolCallRequest = Omit<
  ToolGatewayCallRequest,
  "approvalToken" | "siteArtifactId" | "siteVersionId"
>;

/** Host-filtered catalog projection. Tenant routing context never enters Site code. */
export type OpenGeniSiteToolCatalog = Omit<ToolGatewayCatalog, "accountId" | "workspaceId">;

export type OpenGeniSiteWorkspaceTools = OpenGeniWorkspaceTools<OpenGeniSiteToolCatalog>;

export type OpenGeniSiteBridgeRequestMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_REQUEST;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  requestId: string;
} & (
  | { method: "catalog" }
  | { method: "call"; payload: OpenGeniSiteToolCallRequest }
  | { method: "declarations" }
);

export type OpenGeniSiteBridgeCancelMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_CANCEL;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  requestId: string;
};

export type OpenGeniSiteBridgeResponseMessage = {
  type: typeof OPENGENI_SITE_BRIDGE_RESPONSE;
  version: typeof OPENGENI_SITE_BRIDGE_VERSION;
  requestId: string;
} & (
  | {
      ok: true;
      value: OpenGeniSiteToolCatalog | ToolGatewayCallResponse | ToolGatewayDeclarationsResponse;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        outcomeUnknown?: boolean;
      };
    }
);

export type OpenGeniSiteClient = {
  /** Workspace-bound typed facade. The parent host owns workspace identity and credentials. */
  readonly tools: OpenGeniSiteWorkspaceTools;
  close(): void;
};

export type OpenGeniSiteClientOptions = {
  /** Advanced embedding seam; ordinary Sites accept bootstrap only from their exact parent. */
  parentWindow?: MessageEventSource;
  /** Advanced embedding seam for listening to the host's document-bound bootstrap message. */
  siteWindow?: Pick<Window, "parent" | "addEventListener" | "removeEventListener">;
  /** Test/embedding seam for an already document-bound host bootstrap port. */
  bootstrapPort?: MessagePort;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  createMessageChannel?: () => MessageChannel;
  /** Local-preview seam. Top-level pages use this same-origin Codemode proxy automatically. */
  localCodemodePath?: string | false;
  /** Test/embedding seam for local-preview requests. */
  fetch?: typeof globalThis.fetch;
};

export class OpenGeniSiteBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = "OpenGeniSiteBridgeError";
  }
}

/**
 * Create the browser client used by a Site. Published iframes use the parent
 * MessagePort; top-level sandbox previews use the same-origin Codemode adapter.
 * Credentials remain in the selected host and never enter Site code.
 */
export function createOpenGeniSiteClient(
  options: OpenGeniSiteClientOptions = {},
): OpenGeniSiteClient {
  const transport = shouldUseLocalCodemode(options)
    ? new OpenGeniSiteLocalCodemodeTransport(options)
    : new OpenGeniSiteBridgeTransport(options);
  return {
    tools: new OpenGeniToolsClient(transport).forWorkspace("site-host"),
    close: () => transport.close(),
  };
}

class OpenGeniSiteLocalCodemodeTransport implements OpenGeniToolTransport {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly basePath: string;

  constructor(options: OpenGeniSiteClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const configured = options.localCodemodePath;
    this.basePath = (
      typeof configured === "string" ? configured : OPENGENI_SITE_LOCAL_CODEMODE_PATH
    ).replace(/\/+$/u, "");
  }

  close(): void {}

  async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    _query?: Record<string, string>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const suffix = localCodemodeSuffix(method, path);
    const response = await this.fetchImpl(`${this.basePath}${suffix}`, {
      method,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const value = (await response.json()) as unknown;
    if (response.ok) return value as T;
    const envelope = isRecord(value) && isRecord(value.error) ? value.error : {};
    throw new OpenGeniSiteBridgeError(
      typeof envelope.code === "string" ? envelope.code : "local_codemode_error",
      typeof envelope.message === "string"
        ? envelope.message
        : `Local Site tool request failed with HTTP ${response.status}`,
      envelope.retryable === true,
      envelope.outcomeUnknown === true,
    );
  }
}

function shouldUseLocalCodemode(options: OpenGeniSiteClientOptions): boolean {
  if (options.localCodemodePath === false || options.bootstrapPort) return false;
  if (typeof options.localCodemodePath === "string") return true;
  const siteWindow = options.siteWindow ?? globalThis.window;
  return Boolean(siteWindow && siteWindow.parent === siteWindow);
}

function localCodemodeSuffix(method: string, path: string): string {
  if (method === "GET" && path.endsWith("/tools/catalog")) return "/catalog";
  if (method === "GET" && path.endsWith("/tools/declarations")) return "/declarations";
  if (method === "POST" && path.endsWith("/tools/calls")) return "/calls";
  throw new OpenGeniSiteBridgeError("unsupported_request", "Unsupported Site tool request");
}

export function isOpenGeniSiteBridgeConnectMessage(
  value: unknown,
): value is OpenGeniSiteBridgeConnectMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_CONNECT &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION
  );
}

export function isOpenGeniSiteBridgeRequestMessage(
  value: unknown,
): value is OpenGeniSiteBridgeRequestMessage {
  if (
    !isRecord(value) ||
    value.type !== OPENGENI_SITE_BRIDGE_REQUEST ||
    value.version !== OPENGENI_SITE_BRIDGE_VERSION ||
    typeof value.requestId !== "string" ||
    !value.requestId
  ) {
    return false;
  }
  if (value.method === "catalog" || value.method === "declarations") return true;
  return value.method === "call" && isRecord(value.payload);
}

export function isOpenGeniSiteBridgeCancelMessage(
  value: unknown,
): value is OpenGeniSiteBridgeCancelMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_CANCEL &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION &&
    typeof value.requestId === "string" &&
    Boolean(value.requestId)
  );
}

/** Strip every host-only field before a call crosses the Site boundary. */
export function sanitizeOpenGeniSiteToolCallRequest(
  value: ToolGatewayCallRequest,
): OpenGeniSiteToolCallRequest {
  return {
    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
    catalogDigest: value.catalogDigest,
    identity: value.identity,
    arguments: value.arguments,
  };
}

class OpenGeniSiteBridgeTransport implements OpenGeniToolTransport {
  private readonly options: OpenGeniSiteClientOptions;
  private readonly bootstrap: SiteBridgeBootstrap;
  private port: MessagePort | null = null;
  private connecting: Promise<MessagePort> | null = null;
  private closed = false;

  constructor(options: OpenGeniSiteClientOptions) {
    this.options = options;
    this.bootstrap = createSiteBridgeBootstrap(options);
  }

  async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
    _query?: Record<string, string>,
    requestOptions: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (method === "GET" && path.endsWith("/tools/catalog")) {
      return (await this.request({ method: "catalog" }, requestOptions)) as T;
    }
    if (method === "GET" && path.endsWith("/tools/declarations")) {
      return (await this.request({ method: "declarations" }, requestOptions)) as T;
    }
    if (method === "POST" && path.endsWith("/tools/calls")) {
      if (!isRecord(body)) throw new TypeError("Site tool call payload is required");
      return (await this.request(
        {
          method: "call",
          payload: sanitizeOpenGeniSiteToolCallRequest(body as ToolGatewayCallRequest),
        },
        requestOptions,
      )) as T;
    }
    throw new OpenGeniSiteBridgeError("unsupported_request", "Unsupported Site bridge request");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.bootstrap.close();
    this.port?.close();
    this.port = null;
  }

  private async request(
    request:
      | { method: "catalog" }
      | { method: "call"; payload: OpenGeniSiteToolCallRequest }
      | { method: "declarations" },
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    const port = await this.connect();
    const requestId = crypto.randomUUID();
    const timeoutMs = positiveTimeout(
      options.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000,
      "requestTimeoutMs",
    );
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        cancel(port, requestId);
        reject(
          request.method === "call"
            ? new OpenGeniSiteBridgeError(
                "timeout",
                "Site tool request timed out after execution may have started",
                false,
                true,
              )
            : new OpenGeniSiteBridgeError("timeout", "Site tool request timed out", true),
        );
      }, timeoutMs);
      const abort = () => {
        cleanup();
        cancel(port, requestId);
        reject(options.signal?.reason ?? new DOMException("Request aborted", "AbortError"));
      };
      const onMessage = (event: MessageEvent<unknown>) => {
        const response = event.data;
        if (
          !isRecord(response) ||
          response.type !== OPENGENI_SITE_BRIDGE_RESPONSE ||
          response.version !== OPENGENI_SITE_BRIDGE_VERSION ||
          response.requestId !== requestId ||
          typeof response.ok !== "boolean"
        ) {
          return;
        }
        cleanup();
        if (response.ok) {
          resolve(response.value);
          return;
        }
        const error = isRecord(response.error) ? response.error : {};
        reject(
          new OpenGeniSiteBridgeError(
            typeof error.code === "string" ? error.code : "bridge_error",
            typeof error.message === "string" ? error.message : "Site tool request failed",
            error.retryable === true,
            error.outcomeUnknown === true,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        port.removeEventListener("message", onMessage);
      };
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      port.addEventListener("message", onMessage);
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_REQUEST,
        version: OPENGENI_SITE_BRIDGE_VERSION,
        requestId,
        ...request,
      } satisfies OpenGeniSiteBridgeRequestMessage);
    });
  }

  private async connect(): Promise<MessagePort> {
    if (this.closed) throw new OpenGeniSiteBridgeError("closed", "Site bridge is closed");
    if (this.port) return this.port;
    if (this.connecting) return await this.connecting;
    const channel = (this.options.createMessageChannel ?? (() => new MessageChannel()))();
    const timeoutMs = positiveTimeout(this.options.connectTimeoutMs ?? 10_000, "connectTimeoutMs");
    this.connecting = new Promise<MessagePort>((resolve, reject) => {
      let active = true;
      const timeout = setTimeout(() => {
        cleanup();
        channel.port1.close();
        reject(new OpenGeniSiteBridgeError("host_timeout", "OpenGeni Site host did not respond"));
      }, timeoutMs);
      const onMessage = (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (
          !isRecord(message) ||
          message.type !== OPENGENI_SITE_BRIDGE_READY ||
          message.version !== OPENGENI_SITE_BRIDGE_VERSION
        ) {
          return;
        }
        cleanup();
        this.port = channel.port1;
        resolve(channel.port1);
      };
      const cleanup = () => {
        active = false;
        clearTimeout(timeout);
        channel.port1.removeEventListener("message", onMessage);
      };
      channel.port1.addEventListener("message", onMessage);
      channel.port1.start();
      void this.bootstrap
        .port()
        .then((bootstrapPort) => {
          if (!active) return;
          if (this.closed) throw new OpenGeniSiteBridgeError("closed", "Site bridge is closed");
          bootstrapPort.postMessage(
            {
              type: OPENGENI_SITE_BRIDGE_CONNECT,
              version: OPENGENI_SITE_BRIDGE_VERSION,
            } satisfies OpenGeniSiteBridgeConnectMessage,
            [channel.port2],
          );
        })
        .catch((error) => {
          cleanup();
          channel.port1.close();
          reject(error);
        });
    }).finally(() => {
      this.connecting = null;
    });
    return await this.connecting;
  }
}

type SiteBridgeBootstrap = {
  port: () => Promise<MessagePort>;
  close: () => void;
};

function createSiteBridgeBootstrap(options: OpenGeniSiteClientOptions): SiteBridgeBootstrap {
  if (options.bootstrapPort) {
    return {
      port: async () => options.bootstrapPort!,
      close: () => options.bootstrapPort?.close(),
    };
  }
  const siteWindow = options.siteWindow ?? globalThis.window;
  const parentWindow = options.parentWindow ?? siteWindow?.parent;
  if (!siteWindow || !parentWindow || parentWindow === siteWindow) {
    return {
      port: async () => {
        throw new OpenGeniSiteBridgeError(
          "host_unavailable",
          "OpenGeni Site client must run inside a hosted iframe",
        );
      },
      close: () => undefined,
    };
  }
  const retainedPort = retainedSiteBridgeBootstrapPort(siteWindow);
  if (retainedPort) {
    return {
      port: async () => retainedPort,
      close: () => undefined,
    };
  }
  let settledPort: MessagePort | null = null;
  let rejectBootstrap: ((reason?: unknown) => void) | null = null;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (
      event.source !== parentWindow ||
      !isOpenGeniSiteBridgeReadyMessage(event.data) ||
      event.ports.length !== 1
    ) {
      return;
    }
    cleanup();
    settledPort = event.ports[0]!;
    settledPort.start();
    retainSiteBridgeBootstrapPort(siteWindow, settledPort);
    resolveBootstrap?.(settledPort);
  };
  let resolveBootstrap: ((port: MessagePort) => void) | null = null;
  const cleanup = () => siteWindow.removeEventListener("message", onMessage as EventListener);
  const port = new Promise<MessagePort>((resolve, reject) => {
    resolveBootstrap = resolve;
    rejectBootstrap = reject;
    siteWindow.addEventListener("message", onMessage as EventListener);
  });
  void port.catch(() => undefined);
  return {
    port: async () => await port,
    close: () => {
      cleanup();
      rejectBootstrap?.(new OpenGeniSiteBridgeError("closed", "Site bridge is closed"));
      resolveBootstrap = null;
      rejectBootstrap = null;
    },
  };
}

function retainedSiteBridgeBootstrapPort(
  siteWindow: OpenGeniSiteClientOptions["siteWindow"],
): MessagePort | null {
  const state = (siteWindow as unknown as Record<string, unknown>)[
    OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL
  ];
  if (!isRecord(state)) return null;
  const candidate = state.port as Partial<MessagePort> | undefined;
  return candidate &&
    typeof candidate.postMessage === "function" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.start === "function"
    ? (candidate as MessagePort)
    : null;
}

function retainSiteBridgeBootstrapPort(
  siteWindow: OpenGeniSiteClientOptions["siteWindow"],
  port: MessagePort,
): void {
  try {
    Object.defineProperty(siteWindow, OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL, {
      configurable: true,
      value: { port },
    });
  } catch {
    // The bootstrap event still serves the current client when the embedding
    // window refuses extension; only late construction loses this fallback.
  }
}

function isOpenGeniSiteBridgeReadyMessage(value: unknown): value is OpenGeniSiteBridgeReadyMessage {
  return (
    isRecord(value) &&
    value.type === OPENGENI_SITE_BRIDGE_READY &&
    value.version === OPENGENI_SITE_BRIDGE_VERSION
  );
}

function cancel(port: MessagePort, requestId: string): void {
  port.postMessage({
    type: OPENGENI_SITE_BRIDGE_CANCEL,
    version: OPENGENI_SITE_BRIDGE_VERSION,
    requestId,
  } satisfies OpenGeniSiteBridgeCancelMessage);
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
