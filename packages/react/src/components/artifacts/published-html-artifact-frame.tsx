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
import { resolveSiteUiStylesheet } from "@opengeni/sdk/site-ui";
import { HTML_FRAME_HOST_SANDBOX } from "@opengeni/contracts/html-frame-host";
import { useContentHosting } from "../../lib/content-hosting";
import { htmlFrameHostSrc, useHtmlFrameHost } from "./html-frame-host";

export {
  SiteBridgeDocumentLease,
  SiteBridgeRequestRegistry,
  handleSiteBridgeRequest,
  openGeniSiteBridgePortFromBootstrap,
  siteBridgeError,
  siteBridgeReadyMessage,
} from "@opengeni/sdk/site-bridge-host";

export const PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX = HTML_FRAME_HOST_SANDBOX;

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
  /**
   * The document can show its content: its first height report (inline
   * previews post one once their stylesheets have loaded) or, failing that,
   * its load. Called at most once per frame.
   */
  onPainted?: () => void;
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
  // The opt-in Opengeni look (`/__opengeni/ui.css`) is inlined, so it is there
  // on the first paint.
  const styled = resolveSiteUiStylesheet(html);
  if (!toolBridgeEnabled) return styled;
  return injectSiteBridgeBootstrap(resolveSiteClientScript(styled));
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
 *
 * When the page configures an HTML frame host (`configureContentHosting`),
 * the HTML is rendered there rather than in a `srcdoc` frame, so the page's
 * own Content-Security-Policy does not apply to it.
 */
export function PublishedHtmlArtifactFrame(props: PublishedHtmlArtifactFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const themeRef = useRef(props.theme);
  themeRef.current = props.theme;
  const [reportedHeight, setHeight] = useState<number>();
  const onPaintedRef = useRef(props.onPainted);
  onPaintedRef.current = props.onPainted;
  const paintedRef = useRef(false);
  const painted = () => {
    if (paintedRef.current) return;
    paintedRef.current = true;
    onPaintedRef.current?.();
  };
  const paintedHandlerRef = useRef(painted);
  paintedHandlerRef.current = painted;
  const listensForHeight = props.autoHeight === true || props.onPainted !== undefined;
  const height =
    reportedHeight === undefined
      ? undefined
      : Math.min(props.maxAutoHeight ?? 1200, Math.max(80, Math.ceil(reportedHeight)));
  useEffect(() => {
    if (!listensForHeight) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frameRef.current?.contentWindow ||
        event.data?.type !== "opengeni.preview.height"
      )
        return;
      const value = event.data.height;
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      setHeight(value);
      paintedHandlerRef.current();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [listensForHeight]);
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
  const frameHostSrc = htmlFrameHostSrc(useContentHosting().htmlFrameHost);
  const documentHtml = publishedHtmlArtifactDocument(props.html, toolBridgeEnabled);
  const documentLoaded = () => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "opengeni.preview.theme", theme: themeRef.current },
      "*",
    );
    painted();
    frameLoadPendingRef.current = true;
    onFrameLoadRef.current();
  };
  const frameHost = useHtmlFrameHost({
    frameRef,
    enabled: frameHostSrc !== null,
    html: documentHtml,
    mode: "interactive",
    onLoaded: documentLoaded,
  });
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
  // The frame's color-scheme is the app's `prefers-color-scheme`, so an app
  // follows Opengeni's light or dark theme, and switches without reloading.
  const style: CSSProperties = {
    ...(props.theme ? { colorScheme: props.theme } : {}),
    ...props.style,
    ...(props.autoHeight && height ? { height } : {}),
  };
  if (frameHostSrc) {
    return (
      <iframe
        // New HTML loads the frame host again.
        key={documentHtml}
        ref={frameRef}
        title={props.title}
        sandbox={PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        src={frameHostSrc}
        onLoad={() => {
          // Loads before the HTML's own document are the frame host's; a
          // later one is the HTML navigating, as with srcdoc.
          if (frameHost.onFrameLoad()) documentLoaded();
        }}
        className={props.className}
        style={style}
      />
    );
  }
  return (
    <iframe
      ref={frameRef}
      title={props.title}
      sandbox={PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={documentHtml}
      onLoad={documentLoaded}
      className={props.className}
      style={style}
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
