import {
  SiteBridgeHost,
  injectSiteBridgeBootstrap,
  type SiteBridgeToolHandlers,
  type SiteBridgeViewerHandlers,
} from "@opengeni/sdk/site-bridge-host";
import type { OpenGeniSiteSignInResult, OpenGeniSiteViewer } from "@opengeni/sdk/site";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { resolveSiteClientScript } from "@opengeni/sdk/site-document";

export {
  SiteBridgeDocumentLease,
  SiteBridgeRequestRegistry,
  handleSiteBridgeRequest,
  openGeniSiteBridgePortFromBootstrap,
  siteBridgeError,
  siteBridgeReadyMessage,
} from "@opengeni/sdk/site-bridge-host";

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
  autoHeight?: boolean;
  theme?: "light" | "dark";
  title: string;
  className?: string;
  style?: CSSProperties;
  toolBridge?: PublishedHtmlArtifactToolBridge;
  /**
   * The signed-in member viewing the Site, answered to `site.viewer`. When
   * omitted the frame does not advertise viewers and the SDK resolves `null`.
   */
  viewer?: OpenGeniSiteViewer;
  /**
   * Answer `site.auth.signIn()`. The console viewer is already signed in, so
   * the default resolves `{ started: false }`.
   */
  onSignIn?: () => Promise<OpenGeniSiteSignInResult> | OpenGeniSiteSignInResult;
};

/** Host handlers for Site tools and the Site HTTP channel (see `@opengeni/sdk/site-bridge-host`). */
export type PublishedHtmlArtifactToolBridge = SiteBridgeToolHandlers;

export function publishedHtmlArtifactDocument(html: string, toolBridgeEnabled: boolean): string {
  if (!toolBridgeEnabled) return html;
  return injectSiteBridgeBootstrap(resolveSiteClientScript(html));
}

/**
 * Render exact published HTML in an opaque-origin iframe. Artifact scripts,
 * external resources, forms, popups, downloads, and the host-filtered tool
 * bridge work without granting parent-origin authority, shared cookies/storage,
 * or top-level navigation.
 */
export function PublishedHtmlArtifactFrame(props: PublishedHtmlArtifactFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    if (!props.autoHeight) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.type !== "opengeni.preview.height"
      )
        return;
      const value = event.data.height;
      if (typeof value === "number" && Number.isFinite(value))
        setHeight(Math.min(1200, Math.max(80, value)));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [props.autoHeight]);
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "opengeni.preview.theme", theme: props.theme },
      "*",
    );
  }, [props.theme]);
  const bridgeRef = useRef(props.toolBridge);
  const viewerRef = useRef(siteViewerHandlers(props.viewer, props.onSignIn));
  const onFrameLoadRef = useRef<() => void>(() => undefined);
  const frameLoadPendingRef = useRef(false);
  // The bridge (and its bootstrap script) exists only when the host offers
  // something over it: tools/Site HTTP, or the viewer.
  const toolBridgeEnabled = props.toolBridge !== undefined || props.viewer !== undefined;
  useEffect(() => {
    bridgeRef.current = props.toolBridge;
  }, [props.toolBridge]);
  useEffect(() => {
    viewerRef.current = siteViewerHandlers(props.viewer, props.onSignIn);
  }, [props.viewer, props.onSignIn]);
  useEffect(() => {
    if (!toolBridgeEnabled || typeof window === "undefined") return;
    const host = new SiteBridgeHost({
      tools: () => bridgeRef.current,
      viewer: () => viewerRef.current,
    });
    const onFrameLoad = () => {
      frameLoadPendingRef.current = false;
      const frameWindow = frameRef.current?.contentWindow ?? null;
      if (!frameWindow) return;
      host.load(frameWindow);
    };
    onFrameLoadRef.current = onFrameLoad;
    if (frameLoadPendingRef.current) {
      frameLoadPendingRef.current = false;
      onFrameLoad();
    }
    return () => {
      onFrameLoadRef.current = () => undefined;
      host.close();
    };
  }, [props.html, toolBridgeEnabled]);
  return (
    <iframe
      ref={frameRef}
      title={props.title}
      sandbox={PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={publishedHtmlArtifactDocument(props.html, toolBridgeEnabled)}
      onLoad={() => {
        frameRef.current?.contentWindow?.postMessage(
          { type: "opengeni.preview.theme", theme: props.theme },
          "*",
        );
        frameLoadPendingRef.current = true;
        onFrameLoadRef.current();
      }}
      className={props.className}
      style={{ ...props.style, ...(props.autoHeight && height ? { height } : {}) }}
    />
  );
}

function siteViewerHandlers(
  viewer: OpenGeniSiteViewer | undefined,
  onSignIn: PublishedHtmlArtifactFrameProps["onSignIn"],
): SiteBridgeViewerHandlers | undefined {
  if (!viewer) return undefined;
  return {
    viewer: () => viewer,
    signIn: async () => (onSignIn ? await onSignIn() : { started: false }),
  };
}
