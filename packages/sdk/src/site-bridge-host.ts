/**
 * Framework-free host side of the Site MessagePort bridge. The console's
 * `PublishedHtmlArtifactFrame` and the published-Site gateway shell both run
 * this code; each injects its own tool transport, Site HTTP handler, viewer
 * provider and sign-in action.
 *
 * Protocol (v2): the host posts a ready message with a bootstrap port to the
 * frame window once per document load; each SDK client connects through that
 * port with its own MessagePort. Requests are tracked per port so a cancel or
 * a document teardown aborts exactly the requests it owns. A second load of
 * the same frame (a navigation inside the Site) revokes the bridge instead of
 * handing a fresh port to an unknown document.
 */
import type { SiteViewer } from "@opengeni/contracts";
import {
  OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL,
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD,
  OPENGENI_SITE_BRIDGE_VERSION,
  OPENGENI_SITE_BRIDGE_VIEWER_METHOD,
  isOpenGeniSiteBridgeCancelMessage,
  isOpenGeniSiteBridgeConnectMessage,
  isOpenGeniSiteBridgeRequestMessage,
  sanitizeOpenGeniSiteToolCallRequest,
  sanitizeOpenGeniSiteToolInvokeRequest,
  type OpenGeniSiteBridgeReadyMessage,
  type OpenGeniSiteBridgeRequestMessage,
  type OpenGeniSiteBridgeResponseMessage,
  type OpenGeniSiteSignInResult,
  type OpenGeniSiteToolCatalog,
} from "./site";
import { isSiteHttpRequest, serveSiteHttp, type SiteHttpRequest } from "./site-http";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayDeclarationsResponse,
  ToolGatewayInvokeRequest,
  ToolGatewayInvokeResponse,
  ToolGatewayResolveRequest,
  ToolGatewayResolvedTool,
} from "./types";

export type { SiteHttpRequest } from "./site-http";

/** Tool and Site HTTP handlers a host supplies. Credentials stay inside these functions. */
export type SiteBridgeToolHandlers = {
  resolve?: (
    request: ToolGatewayResolveRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayResolvedTool>;
  invoke?: (
    request: ToolGatewayInvokeRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayInvokeResponse>;
  /** Serves the ordinary SDK's HTTP requests (sessions, Site Data) over the Site HTTP channel. */
  fetch?: (request: SiteHttpRequest, signal: AbortSignal) => Promise<Response>;
  /**
   * Advertise Site Data and Site SQL: `fetch` serves `published-artifacts/current`
   * routes (data, files and `sql/queries/<name>`) for the pinned Site.
   */
  siteData?: boolean;
  catalog: (options: { signal: AbortSignal }) => Promise<OpenGeniSiteToolCatalog>;
  call: (
    request: ToolGatewayCallRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayCallResponse>;
  declarations?: (options: { signal: AbortSignal }) => Promise<ToolGatewayDeclarationsResponse>;
};

/** Viewer identity and sign-in, answered by the host itself (advertised as `viewer: 1`). */
export type SiteBridgeViewerHandlers = {
  viewer: (options: { signal: AbortSignal }) => Promise<SiteViewer> | SiteViewer;
  /** Defaults to `{ started: false }`: the viewer is already signed in or the host has no sign-in. */
  signIn?: (options: {
    signal: AbortSignal;
  }) => Promise<OpenGeniSiteSignInResult> | OpenGeniSiteSignInResult;
};

export type SiteBridgeRequestValue =
  | OpenGeniSiteToolCatalog
  | ToolGatewayCallResponse
  | ToolGatewayDeclarationsResponse
  | ToolGatewayResolvedTool
  | ToolGatewayInvokeResponse
  | SiteViewer
  | OpenGeniSiteSignInResult;

/** Capabilities the host advertises when a Site connects; Sites never ask for more. */
export function siteBridgeReadyMessage(
  bridge: SiteBridgeToolHandlers | undefined,
  viewer?: SiteBridgeViewerHandlers,
): OpenGeniSiteBridgeReadyMessage {
  return {
    type: OPENGENI_SITE_BRIDGE_READY,
    version: OPENGENI_SITE_BRIDGE_VERSION,
    ...(bridge?.resolve && bridge?.invoke ? { targetTools: 1 as const } : {}),
    ...(bridge?.fetch && bridge.siteData ? { siteData: 1 as const } : {}),
    ...(viewer ? { viewer: 1 as const } : {}),
  };
}

/**
 * The inline script a host puts at the top of Site HTML. It accepts exactly
 * one ready message with one port from the parent window and keeps that port
 * on a window global so SDK clients created later can still connect.
 */
export const SITE_BRIDGE_BOOTSTRAP_SCRIPT = `<script>(()=>{const key=${JSON.stringify(
  OPENGENI_SITE_BRIDGE_BOOTSTRAP_GLOBAL,
)};const parentWindow=window.parent;if(parentWindow===window)return;window.addEventListener("message",event=>{const data=event.data;if(event.source!==parentWindow||!data||data.type!==${JSON.stringify(
  OPENGENI_SITE_BRIDGE_READY,
)}||data.version!==${OPENGENI_SITE_BRIDGE_VERSION}||event.ports.length!==1)return;const port=event.ports[0];const previous=window[key]?.port;if(previous&&previous!==port)previous.close();Object.defineProperty(window,key,{configurable:true,value:{port}});port.start();});})();</script>`;

/** Insert the bootstrap script right after a leading doctype (or at the start). */
export function injectSiteBridgeBootstrap(html: string): string {
  const doctypeEnd = leadingDoctypeEnd(html);
  if (doctypeEnd >= 0) {
    return `${html.slice(0, doctypeEnd + 1)}${SITE_BRIDGE_BOOTSTRAP_SCRIPT}${html.slice(doctypeEnd + 1)}`;
  }
  return `${SITE_BRIDGE_BOOTSTRAP_SCRIPT}${html}`;
}

function leadingDoctypeEnd(html: string): number {
  const lower = html.toLowerCase();
  let cursor = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < html.length) {
    while (/\s/.test(html[cursor] ?? "")) cursor += 1;
    if (!html.startsWith("<!--", cursor)) break;
    const commentEnd = html.indexOf("-->", cursor + 4);
    if (commentEnd < 0) return -1;
    cursor = commentEnd + 3;
  }
  if (!lower.startsWith("<!doctype", cursor)) return -1;
  return html.indexOf(">", cursor + 9);
}

export type SiteBridgeHostSource = {
  /** Read on every request, so a host can swap handlers without reconnecting the Site. */
  tools: () => SiteBridgeToolHandlers | undefined;
  viewer?: () => SiteBridgeViewerHandlers | undefined;
};

/**
 * One frame's bridge host. Call `load(frame.contentWindow)` from the frame's
 * load event and `close()` when the frame goes away.
 */
export class SiteBridgeHost {
  private readonly requests = new SiteBridgeRequestRegistry();
  private readonly lease: SiteBridgeDocumentLease;

  constructor(
    private readonly source: SiteBridgeHostSource,
    options: { createMessageChannel?: () => MessageChannel } = {},
  ) {
    this.lease = new SiteBridgeDocumentLease(
      (data, ports) => this.attachToolPort(data, ports),
      () => this.requests.closeAll(),
      options.createMessageChannel,
    );
  }

  /** Offer the bootstrap port to a freshly loaded document. Returns false (and revokes) on reload. */
  load(frameWindow: Pick<Window, "postMessage">): boolean {
    return this.lease.load(frameWindow);
  }

  close(): void {
    this.lease.close();
  }

  private attachToolPort(data: unknown, ports: readonly MessagePort[]): void {
    const port = openGeniSiteBridgePortFromBootstrap(data, ports);
    if (!port) return;
    const requests = this.requests;
    requests.addPort(port);
    port.addEventListener("message", (portEvent: MessageEvent<unknown>) => {
      const message = portEvent.data;
      if (isOpenGeniSiteBridgeCancelMessage(message)) {
        requests.cancel(port, message.requestId);
        return;
      }
      if (isSiteHttpRequest(message) && portEvent.ports.length === 1) {
        const controller = requests.start(port, message.requestId);
        if (!controller) {
          portEvent.ports[0]!.close();
          return;
        }
        void serveSiteHttp(
          message,
          portEvent.ports[0]!,
          async (request, signal) => {
            const fetch = this.source.tools()?.fetch;
            if (!fetch) throw new Error("This Site host does not support the session SDK");
            return fetch(request, signal);
          },
          controller.signal,
        ).finally(() => requests.complete(port, message.requestId, controller));
        return;
      }
      if (!isOpenGeniSiteBridgeRequestMessage(message)) return;
      const controller = requests.start(port, message.requestId);
      if (!controller) {
        port.postMessage({
          type: OPENGENI_SITE_BRIDGE_RESPONSE,
          version: OPENGENI_SITE_BRIDGE_VERSION,
          requestId: message.requestId,
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: "A Site tool request with this id is already running",
            retryable: false,
          },
        } satisfies OpenGeniSiteBridgeResponseMessage);
        return;
      }
      void handleSiteBridgeRequest(
        this.source.tools(),
        message,
        controller.signal,
        this.source.viewer?.(),
      )
        .then((value) => {
          if (!controller.signal.aborted) {
            port.postMessage({
              type: OPENGENI_SITE_BRIDGE_RESPONSE,
              version: OPENGENI_SITE_BRIDGE_VERSION,
              requestId: message.requestId,
              ok: true,
              value,
            } satisfies OpenGeniSiteBridgeResponseMessage);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            port.postMessage({
              type: OPENGENI_SITE_BRIDGE_RESPONSE,
              version: OPENGENI_SITE_BRIDGE_VERSION,
              requestId: message.requestId,
              ok: false,
              error: siteBridgeError(error, message.method === "call"),
            } satisfies OpenGeniSiteBridgeResponseMessage);
          }
        })
        .finally(() => requests.complete(port, message.requestId, controller));
    });
    port.addEventListener("messageerror", () => requests.closePort(port));
    port.start();
    port.postMessage(siteBridgeReadyMessage(this.source.tools(), this.source.viewer?.()));
  }
}

export class SiteBridgeRequestRegistry {
  private readonly controllersByPort = new Map<MessagePort, Map<string, AbortController>>();

  addPort(port: MessagePort): void {
    // Several SDK clients may share one document bootstrap. Document teardown,
    // not another client connecting, revokes all of that document's ports.
    if (!this.controllersByPort.has(port)) this.controllersByPort.set(port, new Map());
  }

  start(port: MessagePort, requestId: string): AbortController | null {
    const controllers = this.controllersByPort.get(port);
    if (!controllers || controllers.has(requestId)) return null;
    const controller = new AbortController();
    controllers.set(requestId, controller);
    return controller;
  }

  cancel(port: MessagePort, requestId: string): void {
    const controllers = this.controllersByPort.get(port);
    const controller = controllers?.get(requestId);
    if (!controller) return;
    controller.abort(new Error("Site tool request cancelled"));
    controllers!.delete(requestId);
  }

  complete(port: MessagePort, requestId: string, controller: AbortController): void {
    const controllers = this.controllersByPort.get(port);
    if (controllers?.get(requestId) === controller) controllers.delete(requestId);
  }

  closePort(port: MessagePort): void {
    const controllers = this.controllersByPort.get(port);
    if (!controllers) return;
    for (const controller of controllers.values()) {
      controller.abort(new Error("Site tool bridge port closed"));
    }
    controllers.clear();
    this.controllersByPort.delete(port);
    port.close();
  }

  closeAll(): void {
    for (const port of [...this.controllersByPort.keys()]) this.closePort(port);
  }
}

export class SiteBridgeDocumentLease {
  private loaded = false;
  private bootstrapPort: MessagePort | null = null;

  constructor(
    private readonly attachToolPort: (data: unknown, ports: readonly MessagePort[]) => void,
    private readonly closeActivePorts: () => void,
    private readonly createMessageChannel: () => MessageChannel = () => new MessageChannel(),
  ) {}

  load(frameWindow: Pick<Window, "postMessage">): boolean {
    if (this.loaded) {
      this.close();
      return false;
    }
    this.loaded = true;
    const channel = this.createMessageChannel();
    this.bootstrapPort = channel.port1;
    channel.port1.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.attachToolPort(event.data, event.ports);
    });
    channel.port1.start();
    frameWindow.postMessage(
      {
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      },
      "*",
      [channel.port2],
    );
    return true;
  }

  close(): void {
    this.bootstrapPort?.close();
    this.bootstrapPort = null;
    this.closeActivePorts();
  }
}

export function openGeniSiteBridgePortFromBootstrap(
  data: unknown,
  ports: readonly MessagePort[],
): MessagePort | null {
  if (!isOpenGeniSiteBridgeConnectMessage(data)) return null;
  return ports.length === 1 ? ports[0]! : null;
}

export async function handleSiteBridgeRequest(
  bridge: SiteBridgeToolHandlers | undefined,
  message: OpenGeniSiteBridgeRequestMessage,
  signal: AbortSignal,
  viewer?: SiteBridgeViewerHandlers,
): Promise<SiteBridgeRequestValue> {
  if (message.method === OPENGENI_SITE_BRIDGE_VIEWER_METHOD) {
    if (!viewer) throw siteBridgeHostError("viewer_unavailable", "This Site host has no viewer");
    return await viewer.viewer({ signal });
  }
  if (message.method === OPENGENI_SITE_BRIDGE_SIGN_IN_METHOD) {
    if (!viewer?.signIn) return { started: false };
    const result = await viewer.signIn({ signal });
    return { started: result?.started === true };
  }
  if (!bridge) throw new Error("Site tool bridge is unavailable");
  if (message.method === "resolve") {
    if (!bridge.resolve) throw new Error("Targeted Site tools are unavailable");
    return await bridge.resolve({ target: message.payload.target }, { signal });
  }
  if (message.method === "invoke") {
    if (!bridge.invoke) throw new Error("Targeted Site tools are unavailable");
    return await bridge.invoke(sanitizeOpenGeniSiteToolInvokeRequest(message.payload), { signal });
  }
  if (message.method === "catalog") return await bridge.catalog({ signal });
  if (message.method === "declarations") {
    if (!bridge.declarations) throw new Error("Site tool declarations are unavailable");
    return await bridge.declarations({ signal });
  }
  return await bridge.call(sanitizeOpenGeniSiteToolCallRequest(message.payload!), { signal });
}

function siteBridgeHostError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function siteBridgeError(
  error: unknown,
  legacyCall = false,
): {
  code: string;
  message: string;
  retryable: boolean;
  outcomeUnknown: boolean;
} {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
    outcomeUnknown?: unknown;
    details?: { code?: unknown };
  };
  const nestedCode = candidate?.details?.code;
  const knownPreexecution = candidate?.retryable === true && candidate?.outcomeUnknown === false;
  const stale =
    knownPreexecution && (nestedCode === "tool_definition_stale" || nestedCode === "catalog_stale");
  // Historical saved bundles inspect code alone. A stale-named transport error
  // without known pre-execution proof must remain an error, not invite replay.
  const unsafeControl =
    legacyCall &&
    !knownPreexecution &&
    (candidate?.code === "catalog_stale" || candidate?.code === "tool_definition_stale");
  const message =
    typeof candidate?.message === "string" ? candidate.message : "Site tool request failed";
  return {
    code: stale
      ? (nestedCode as string)
      : unsafeControl
        ? "site_tool_call_failed"
        : typeof candidate?.code === "string"
          ? candidate.code
          : "site_tool_call_failed",
    message: unsafeControl ? `[${candidate.code}] ${message}` : message,
    retryable: candidate?.retryable === true,
    outcomeUnknown: candidate?.outcomeUnknown === true,
  };
}
