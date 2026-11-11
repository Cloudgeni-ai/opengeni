import {
  SiteBridgeHost,
  injectSiteBridgeBootstrap,
  openGeniSiteLocationHref,
  resolveOpenGeniSiteLocation,
  type OpenGeniSiteLocationValue,
  type SiteBridgeLocationHandlers,
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
  /**
   * Size the frame to the height its document reports (`opengeni.preview.height`),
   * between 80 px and `maxAutoHeight` (default 1200 px). Taller content scrolls
   * inside the frame.
   */
  autoHeight?: boolean;
  /** Upper bound for `autoHeight`, in CSS pixels. */
  maxAutoHeight?: number;
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
  /**
   * The Site's own address in this page (`/admin?tab=2#top`), answered to
   * `site.location`; defaults to `/`. Changing it moves the Site there (the
   * Site hears it through `site.onLocationChange`) without reloading it.
   */
  location?: string;
  /**
   * The Site moved itself with `site.navigate`: a host that keeps the
   * address (for example in its own URL) stores `href` and passes it back as
   * `location`. `replace` asks not to add a history entry.
   */
  onLocationChange?: (href: string, options: { replace: boolean }) => void;
};

/** Host handlers for Site tools and the Site HTTP channel (see `@opengeni/sdk/site-bridge-host`). */
export type PublishedHtmlArtifactToolBridge = SiteBridgeToolHandlers;

export function publishedHtmlArtifactDocument(html: string, toolBridgeEnabled: boolean): string {
  if (!toolBridgeEnabled) return html;
  return injectSiteBridgeBootstrap(resolveSiteClientScript(html));
}

const SITE_ROOT: OpenGeniSiteLocationValue = { path: "/", search: "", hash: "" };

/** A host-kept Site address as a location; anything unusable is the Site's root. */
export function siteFrameLocation(href: string | undefined): OpenGeniSiteLocationValue {
  return (href ? resolveOpenGeniSiteLocation(SITE_ROOT, href) : null) ?? SITE_ROOT;
}

/**
 * Render exact published HTML in an opaque-origin iframe. Artifact scripts,
 * external resources, forms, popups, downloads, and the host-filtered tool
 * bridge work without granting parent-origin authority, shared cookies/storage,
 * or top-level navigation.
 */
export function PublishedHtmlArtifactFrame(props: PublishedHtmlArtifactFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [reportedHeight, setHeight] = useState<number>();
  const height =
    reportedHeight === undefined
      ? undefined
      : Math.min(props.maxAutoHeight ?? 1200, Math.max(80, Math.ceil(reportedHeight)));
  useEffect(() => {
    if (!props.autoHeight) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.type !== "opengeni.preview.height"
      )
        return;
      const value = event.data.height;
      if (typeof value === "number" && Number.isFinite(value)) setHeight(value);
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
  const hostRef = useRef<SiteBridgeHost | null>(null);
  const locationRef = useRef(siteFrameLocation(props.location));
  const onLocationChangeRef = useRef(props.onLocationChange);
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
    onLocationChangeRef.current = props.onLocationChange;
  }, [props.onLocationChange]);
  // The host moved the Site (its Back/Forward, a link): tell the Site.
  useEffect(() => {
    const next = siteFrameLocation(props.location);
    if (openGeniSiteLocationHref(next) === openGeniSiteLocationHref(locationRef.current)) return;
    locationRef.current = next;
    hostRef.current?.notifyLocation(next);
  }, [props.location]);
  const locationHandlers = useRef<SiteBridgeLocationHandlers>({
    get: () => locationRef.current,
    navigate: (to, { replace }) => {
      locationRef.current = to;
      hostRef.current?.notifyLocation(to);
      onLocationChangeRef.current?.(openGeniSiteLocationHref(to), { replace });
      return to;
    },
  }).current;
  useEffect(() => {
    if (!toolBridgeEnabled || typeof window === "undefined") return;
    const host = new SiteBridgeHost({
      tools: () => bridgeRef.current,
      viewer: () => viewerRef.current,
      location: () => locationHandlers,
    });
    hostRef.current = host;
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
      if (hostRef.current === host) hostRef.current = null;
      host.close();
    };
  }, [props.html, toolBridgeEnabled, locationHandlers]);
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
