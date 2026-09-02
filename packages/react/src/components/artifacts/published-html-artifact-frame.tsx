import {
  OPENGENI_SITE_BRIDGE_READY,
  OPENGENI_SITE_BRIDGE_RESPONSE,
  OPENGENI_SITE_BRIDGE_VERSION,
  isOpenGeniSiteBridgeCancelMessage,
  isOpenGeniSiteBridgeConnectMessage,
  isOpenGeniSiteBridgeRequestMessage,
  sanitizeOpenGeniSiteToolCallRequest,
  type OpenGeniSiteBridgeResponseMessage,
} from "@opengeni/sdk/site";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayCatalog,
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
  catalog: (options: { signal: AbortSignal }) => Promise<ToolGatewayCatalog>;
  call: (
    request: ToolGatewayCallRequest,
    options: { signal: AbortSignal },
  ) => Promise<ToolGatewayCallResponse>;
  declarations?: (options: { signal: AbortSignal }) => Promise<ToolGatewayDeclarationsResponse>;
};

/**
 * Render exact published HTML in an opaque-origin iframe. Artifact scripts,
 * external resources, forms, popups, and downloads work without granting
 * parent-origin authority, shared cookies/storage, or top-level navigation.
 */
export function PublishedHtmlArtifactFrame(props: PublishedHtmlArtifactFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef(props.toolBridge);
  const toolBridgeEnabled = props.toolBridge !== undefined;
  useEffect(() => {
    bridgeRef.current = props.toolBridge;
  }, [props.toolBridge]);
  useEffect(() => {
    if (!toolBridgeEnabled || typeof window === "undefined") return;
    const ports = new Set<MessagePort>();
    const controllers = new Map<string, AbortController>();
    const onWindowMessage = (event: MessageEvent<unknown>) => {
      const port = openGeniSiteBridgePortForFrame(
        event.source,
        frameRef.current?.contentWindow ?? null,
        event.data,
        event.ports,
      );
      if (!port) return;
      for (const existing of ports) existing.close();
      ports.clear();
      ports.add(port);
      port.addEventListener("message", (portEvent: MessageEvent<unknown>) => {
        const message = portEvent.data;
        if (isOpenGeniSiteBridgeCancelMessage(message)) {
          controllers.get(message.requestId)?.abort();
          controllers.delete(message.requestId);
          return;
        }
        if (!isOpenGeniSiteBridgeRequestMessage(message)) return;
        const controller = new AbortController();
        controllers.set(message.requestId, controller);
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
          .finally(() => controllers.delete(message.requestId));
      });
      port.start();
      port.postMessage({
        type: OPENGENI_SITE_BRIDGE_READY,
        version: OPENGENI_SITE_BRIDGE_VERSION,
      });
    };
    window.addEventListener("message", onWindowMessage);
    return () => {
      window.removeEventListener("message", onWindowMessage);
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const port of ports) port.close();
      ports.clear();
    };
  }, [toolBridgeEnabled]);
  return (
    <iframe
      ref={frameRef}
      title={props.title}
      sandbox={PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={props.html}
      className={props.className}
      style={props.style}
    />
  );
}

export function openGeniSiteBridgePortForFrame(
  eventSource: MessageEventSource | null,
  frameWindow: Window | null,
  data: unknown,
  ports: readonly MessagePort[],
): MessagePort | null {
  if (!frameWindow || eventSource !== frameWindow || !isOpenGeniSiteBridgeConnectMessage(data)) {
    return null;
  }
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
): Promise<ToolGatewayCatalog | ToolGatewayCallResponse | ToolGatewayDeclarationsResponse> {
  if (!bridge) throw new Error("Site tool bridge is unavailable");
  if (message.method === "catalog") return await bridge.catalog({ signal });
  if (message.method === "declarations") {
    if (!bridge.declarations) throw new Error("Site tool declarations are unavailable");
    return await bridge.declarations({ signal });
  }
  return await bridge.call(sanitizeOpenGeniSiteToolCallRequest(message.payload!), { signal });
}

function siteBridgeError(error: unknown): { code: string; message: string; retryable: boolean } {
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "site_tool_call_failed",
    message:
      typeof candidate?.message === "string" ? candidate.message : "Site tool request failed",
    retryable: candidate?.retryable === true,
  };
}
