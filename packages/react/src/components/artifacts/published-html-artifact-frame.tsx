import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_VERSION,
  isOpenGeniSiteBridgeCancelMessage,
  isOpenGeniSiteBridgeConnectMessage,
  isOpenGeniSiteBridgeRequestMessage,
  sanitizeOpenGeniSiteToolCallRequest,
  type OpenGeniSiteBridgeResponseMessage,
  type OpenGeniSiteToolCatalog,
} from "@opengeni/sdk/site";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayDeclarationsResponse,
} from "@opengeni/sdk";
import { useEffect, useRef, type CSSProperties } from "react";

export const PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX = [
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-scripts",
].join(" ");

export type PublishedHtmlArtifactFrameProps = {
  html: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  toolBridge?: PublishedHtmlArtifactToolBridge;
};

export type PublishedHtmlArtifactToolBridge = {
  catalog: (options: { signal: AbortSignal }) => Promise<OpenGeniSiteToolCatalog>;
  call: (
    request: ToolGatewayCallRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayCallResponse>;
  declarations?: (options: { signal: AbortSignal }) => Promise<ToolGatewayDeclarationsResponse>;
};

/**
 * Render exact published HTML in an opaque-origin iframe. Artifact scripts,
 * external resources, forms, popups, downloads, and the host-filtered tool
 * bridge work without granting parent-origin authority, shared cookies/storage,
 * or top-level navigation.
 */
export function PublishedHtmlArtifactFrame(props: PublishedHtmlArtifactFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef(props.toolBridge);
  const onFrameLoadRef = useRef<() => void>(() => undefined);
  const frameLoadPendingRef = useRef(false);
  const toolBridgeEnabled = props.toolBridge !== undefined;
  useEffect(() => {
    bridgeRef.current = props.toolBridge;
  }, [props.toolBridge]);
  useEffect(() => {
    if (!toolBridgeEnabled || typeof window === "undefined") return;
    const requests = new SiteBridgeRequestRegistry();
    const attachToolPort = (data: unknown, ports: readonly MessagePort[]) => {
      const port = openGeniSiteBridgePortFromBootstrap(data, ports);
      if (!port) return;
      requests.replacePort(port);
      port.addEventListener("message", (portEvent: MessageEvent<unknown>) => {
        const message = portEvent.data;
        if (isOpenGeniSiteBridgeCancelMessage(message)) {
          requests.cancel(port, message.requestId);
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
        void handleSiteBridgeRequest(bridgeRef.current, message, controller.signal)
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
                error: siteBridgeError(error),
              } satisfies OpenGeniSiteBridgeResponseMessage);
            }
          })
          .finally(() => requests.complete(port, message.requestId, controller));
      });
      port.addEventListener("messageerror", () => requests.closePort(port));
      port.start();
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
    };
    const documentLease = new SiteBridgeDocumentLease(attachToolPort, () => requests.closeAll());
    const onFrameLoad = () => {
      frameLoadPendingRef.current = false;
      const frameWindow = frameRef.current?.contentWindow ?? null;
      if (!frameWindow) return;
      documentLease.load(frameWindow);
    };
    onFrameLoadRef.current = onFrameLoad;
    if (frameLoadPendingRef.current) {
      frameLoadPendingRef.current = false;
      onFrameLoad();
    }
    return () => {
      onFrameLoadRef.current = () => undefined;
      documentLease.close();
    };
  }, [props.html, toolBridgeEnabled]);
  return (
    <iframe
      ref={frameRef}
      title={props.title}
      sandbox={PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={props.html}
      onLoad={() => {
        frameLoadPendingRef.current = true;
        onFrameLoadRef.current();
      }}
      className={props.className}
      style={props.style}
    />
  );
}

export class SiteBridgeRequestRegistry {
  private readonly controllersByPort = new Map<MessagePort, Map<string, AbortController>>();

  replacePort(port: MessagePort): void {
    this.closeAll();
    this.controllersByPort.set(port, new Map());
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

async function handleSiteBridgeRequest(
  bridge: PublishedHtmlArtifactToolBridge | undefined,
  message: Parameters<typeof isOpenGeniSiteBridgeRequestMessage>[0] & {
    method: "catalog" | "call" | "declarations";
    requestId: string;
    payload?: ToolGatewayCallRequest;
  },
  signal: AbortSignal,
): Promise<OpenGeniSiteToolCatalog | ToolGatewayCallResponse | ToolGatewayDeclarationsResponse> {
  if (!bridge) throw new Error("Site tool bridge is unavailable");
  if (message.method === "catalog") return await bridge.catalog({ signal });
  if (message.method === "declarations") {
    if (!bridge.declarations) throw new Error("Site tool declarations are unavailable");
    return await bridge.declarations({ signal });
  }
  return await bridge.call(sanitizeOpenGeniSiteToolCallRequest(message.payload!), { signal });
}

export function siteBridgeError(error: unknown): {
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
  };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "site_tool_call_failed",
    message:
      typeof candidate?.message === "string" ? candidate.message : "Site tool request failed",
    retryable: candidate?.retryable === true,
    outcomeUnknown: candidate?.outcomeUnknown === true,
  };
}
