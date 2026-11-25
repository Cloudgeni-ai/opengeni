import {
  ArrowLeftIcon,
  Globe2Icon,
  Maximize2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { SiteViewer } from "@opengeni/sdk";

import { cn } from "../../lib/cn";
import { useWindowLayerOpen } from "../../lib/window-layer";
import { PortalContainerProvider, usePortalContainer } from "../../ui/portal-container";
import { PreviewLoading } from "../preview-loading";
import { ArtifactBadge, ArtifactButton, useArtifactLabels } from "./artifact-chrome";
import {
  PublishedHtmlArtifactFrame,
  type PublishedHtmlArtifactToolBridge,
} from "./published-html-artifact-frame";

/**
 * What the frame's Live label says when the host watches the Site for new
 * versions: showing the current version, loading a newer one, or unable to
 * check for them.
 */
export type SiteLiveState = "live" | "updating" | "reconnecting";

export type ArtifactSandboxProps = {
  html: string;
  height?: number | undefined;
  /**
   * Size the frame to its document's reported height (see
   * `PublishedHtmlArtifactFrame`); `height` is the size until the first report.
   */
  autoHeight?: boolean | undefined;
  /** Upper bound for `autoHeight`, in CSS pixels; taller content scrolls inside. */
  maxAutoHeight?: number | undefined;
  /**
   * Cover the frame with the "Preparing preview…" surface until its document
   * can paint, so slow page loads (render-blocking fonts or scripts, the frame
   * host) never show as an empty box. A frame that cannot be delivered shows
   * an error with Retry.
   */
  loadingUntilPainted?: boolean | undefined;
  theme?: "light" | "dark" | undefined;
  headerControls?: ReactNode | undefined;
  /**
   * The toolbar's first control, for example the host's Back to the page the
   * Site was opened from. Full screen shows its own Back there instead.
   */
  toolbarStart?: ReactNode | undefined;
  title: string;
  /** Hide the visible title/icon while retaining the accessible iframe title. */
  showTitle?: boolean | undefined;
  /**
   * Wraps the visible title, so a host can attach its own menu to it (the
   * Site view's Copy title). Returns the title itself when absent.
   */
  renderTitle?: ((title: ReactElement) => ReactNode) | undefined;
  showLiveStatus?: boolean | undefined;
  /**
   * Replaces the "Live" indicator, for example with the host's link to the
   * published Site. `null` shows nothing there; omit it for the default.
   */
  liveStatus?: ReactNode | undefined;
  /**
   * The real state of the Site on screen, from a host that watches it for new
   * versions. `updating` and `reconnecting` show beside the Live indicator
   * (or the host's replacement); without it the plain "Live" badge shows.
   */
  liveState?: SiteLiveState | undefined;
  versionLabel?: string | undefined;
  className?: string | undefined;
  editDisabled?: boolean | undefined;
  onEdit?: (() => void) | undefined;
  toolBridge?: PublishedHtmlArtifactToolBridge | undefined;
  /** Who is viewing, answered to the Site's `site.viewer` over the bridge. */
  viewer?: SiteViewer | undefined;
  /**
   * The Site's own address (`/admin?tab=2`), answered to `site.location`.
   * Omit it to let the frame keep the address itself (starting at `/`, kept
   * across reloads); pass it with `onSiteLocationChange` to keep it in the
   * host, for example in its URL.
   */
  siteLocation?: string | undefined;
  /** The Site moved itself with `site.navigate`. */
  onSiteLocationChange?: ((href: string, options: { replace: boolean }) => void) | undefined;
  connectedToolCount?: number | undefined;
  sourceFileCount?: number | undefined;
  fill?: boolean | undefined;
  /**
   * Control full screen from the host (for example from its URL). Omit to let
   * the frame's own expand and back buttons manage it.
   */
  fullScreen?: boolean | undefined;
  /** Called when the person expands the frame or leaves full screen. */
  onFullScreenChange?: ((fullScreen: boolean) => void) | undefined;
  /**
   * Hide the frame's toolbar when the host draws its own reload and full
   * screen controls. Full screen always shows it, for its Back button.
   */
  showToolbar?: boolean | undefined;
  /** Reload the Site whenever this changes, from a host-drawn reload control. */
  reloadToken?: number | undefined;
  /**
   * The page the frame shows, for example its version: a new key replaces
   * the frame in the same render as its HTML, so the Site loads once.
   */
  frameKey?: string | undefined;
};

/**
 * The Site/preview frame chrome shared by the console and embedding hosts:
 * title, version and tool badges, live status, reload, and a full-screen mode
 * that escapes the host's scroll containers through the modal top layer.
 */
export function ArtifactSandbox(props: ArtifactSandboxProps) {
  const labels = useArtifactLabels();
  const [reloadKey, setReloadKey] = useState(0);
  const [ownFocused, setOwnFocused] = useState(false);
  const [ownSiteLocation, setOwnSiteLocation] = useState("/");
  const siteLocation = props.siteLocation ?? ownSiteLocation;
  const onSiteLocationChangeRef = useRef(props.onSiteLocationChange);
  onSiteLocationChangeRef.current = props.onSiteLocationChange;
  const ownsSiteLocation = props.siteLocation === undefined;
  const onSiteLocationChange = useCallback(
    (href: string, options: { replace: boolean }) => {
      if (ownsSiteLocation) setOwnSiteLocation(href);
      onSiteLocationChangeRef.current?.(href, options);
    },
    [ownsSiteLocation],
  );
  const focused = props.fullScreen ?? ownFocused;
  // Full screen, the Site fills the window's content.
  useWindowLayerOpen(focused);
  const setFocused = (next: boolean) => {
    if (props.fullScreen === undefined) setOwnFocused(next);
    props.onFullScreenChange?.(next);
  };
  const frameRef = useRef<HTMLDialogElement>(null);
  const modalRef = useRef(false);
  // In full screen everything outside the modal is inert, so menus opened
  // from the header (the version menu) draw inside it.
  const inheritedPortal = usePortalContainer();
  const [frameElement, setFrameElement] = useState<HTMLDialogElement | null>(null);
  const attachFrame = useCallback((element: HTMLDialogElement | null) => {
    frameRef.current = element;
    setFrameElement(element);
  }, []);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    if (focused) {
      // A fixed child of the chat timeline is still clipped and layered by its
      // scroll pane and the sibling workspace dock. The modal top layer escapes
      // both while keeping the live Site iframe mounted in the same DOM node.
      frame.close();
      frame.showModal();
      modalRef.current = true;
    } else if (modalRef.current) {
      frame.close();
      frame.show();
      modalRef.current = false;
    }
  }, [focused]);
  const reload = () => {
    setReloadKey((value) => value + 1);
  };
  const frameKey = `${reloadKey}:${props.reloadToken ?? 0}:${props.frameKey ?? ""}`;
  // New HTML is a new page: count it, rather than keying on the HTML itself.
  const pageRef = useRef({ html: props.html, page: 0 });
  if (pageRef.current.html !== props.html) {
    pageRef.current = { html: props.html, page: pageRef.current.page + 1 };
  }
  const frame = (gate?: FrameGate) => (
    <PublishedHtmlArtifactFrame
      {...(gate ? {} : { key: frameKey })}
      title={props.title}
      html={props.html}
      autoHeight={Boolean(props.autoHeight && !focused)}
      {...(props.maxAutoHeight ? { maxAutoHeight: props.maxAutoHeight } : {})}
      {...(gate ? { onPainted: gate.onPainted, onFailed: gate.onFailed } : {})}
      {...(props.theme ? { theme: props.theme } : {})}
      {...(!focused && props.height ? { style: { height: props.height } } : {})}
      {...(props.toolBridge ? { toolBridge: props.toolBridge } : {})}
      {...(props.viewer ? { viewer: props.viewer } : {})}
      location={siteLocation}
      onLocationChange={onSiteLocationChange}
      className={cn(
        // Until the app paints, the frame is Opengeni's own canvas (no white flash in dark).
        "block h-[clamp(30rem,62vh,48rem)] w-full border-0",
        props.theme === "dark" ? "bg-canvas" : "bg-white",
        props.fill && "h-0 min-h-0 flex-1",
        focused && "min-h-0 flex-1",
      )}
    />
  );
  return (
    <dialog
      ref={attachFrame}
      open
      aria-label={props.title}
      data-artifact-fullscreen={focused || undefined}
      data-window-layer={focused || undefined}
      onCancel={(event) => {
        event.preventDefault();
        setFocused(false);
      }}
      className={cn(
        "og-root static m-0 w-full max-h-none max-w-none overflow-hidden rounded-2xl border border-border/80 bg-white p-0 text-left shadow-sm",
        props.className,
        props.fill && "flex min-h-0 flex-col",
        focused &&
          "fixed inset-0 z-50 flex h-dvh w-dvw flex-col rounded-none border-0 bg-surface shadow-none",
      )}
    >
      <div
        data-artifact-toolbar
        data-window-drag={focused || undefined}
        hidden={props.showToolbar === false && !focused}
        className={cn(
          "flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-surface/95 px-3 sm:px-4",
          props.showToolbar === false && !focused && "hidden",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {!focused && props.toolbarStart ? props.toolbarStart : null}
          {focused ? (
            <ArtifactButton
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2"
              onClick={() => setFocused(false)}
            >
              <ArrowLeftIcon className="mr-2 size-3.5" />
              {labels.back}
            </ArtifactButton>
          ) : null}
          {!focused && props.showTitle !== false ? (
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-surface-2 text-fg-muted">
              <Globe2Icon className="size-3.5" />
            </span>
          ) : null}
          {props.showTitle === false ? null : props.renderTitle ? (
            // Its menu opens in front of full screen, as the controls' do; its
            // words leave a full-screen toolbar's drag region so they can be
            // right-clicked.
            <PortalContainerProvider
              container={focused && frameElement ? frameElement : inheritedPortal}
            >
              {props.renderTitle(
                <span className="truncate text-xs font-semibold text-fg [-webkit-app-region:no-drag] [app-region:no-drag]">
                  {props.title}
                </span>,
              )}
            </PortalContainerProvider>
          ) : (
            <span className="truncate text-xs font-semibold text-fg">{props.title}</span>
          )}
          {props.headerControls ? (
            <PortalContainerProvider
              container={focused && frameElement ? frameElement : inheritedPortal}
            >
              {props.headerControls}
            </PortalContainerProvider>
          ) : null}
          {props.versionLabel ? (
            <ArtifactBadge className="hidden h-5 rounded-md border-border/80 px-1.5 text-2xs font-normal text-fg-muted sm:inline-flex">
              {props.versionLabel}
            </ArtifactBadge>
          ) : null}
          {props.connectedToolCount ? (
            <ArtifactBadge
              className="hidden h-5 max-w-40 gap-1 rounded-md border-border/80 px-1.5 text-2xs font-normal text-fg-muted sm:inline-flex"
              title={labels.toolsAvailable(props.connectedToolCount)}
            >
              <PlugZapIcon className="size-3" />
              {labels.toolCount(props.connectedToolCount)}
            </ArtifactBadge>
          ) : null}
          {props.sourceFileCount ? (
            <span className="hidden text-2xs text-fg-subtle xl:inline">
              {labels.sourceFileCount(props.sourceFileCount)}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {focused && props.onEdit ? (
            <ArtifactButton
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              disabled={props.editDisabled}
              onClick={props.onEdit}
            >
              <SparklesIcon className="mr-2 size-3.5" />
              <span className="hidden sm:inline">{labels.editWithAgent}</span>
              <span className="sm:hidden">{labels.editShort}</span>
            </ArtifactButton>
          ) : null}
          {props.showLiveStatus !== false && props.liveStatus !== undefined ? (
            // The host's replacement (a link to the published Site) draws its
            // tooltips inside the full-screen frame too.
            <PortalContainerProvider
              container={focused && frameElement ? frameElement : inheritedPortal}
            >
              {props.liveState !== undefined ? (
                <LiveStateBeside status={props.liveState} labels={labels} />
              ) : null}
              {props.liveStatus}
            </PortalContainerProvider>
          ) : null}
          {props.showLiveStatus !== false && props.liveStatus === undefined && (
            <LiveLabel status={props.liveState} labels={labels} />
          )}
          <ArtifactButton
            variant="ghost"
            size="icon"
            className="size-8 rounded-md text-fg-muted hover:text-fg"
            aria-label={labels.reloadSite}
            onClick={reload}
          >
            <RefreshCwIcon className="size-3.5" />
          </ArtifactButton>
          {!focused ? (
            <ArtifactButton
              variant="ghost"
              size="icon"
              className="size-8 rounded-md text-fg-muted hover:text-fg"
              aria-label={labels.openFullScreen}
              onClick={() => setFocused(true)}
            >
              <Maximize2Icon className="size-3.5" />
            </ArtifactButton>
          ) : null}
        </div>
      </div>
      {props.loadingUntilPainted ? (
        <LoadingFrameSlot
          // A reload or new HTML is a new page: loading again.
          key={`${frameKey}:${pageRef.current.page}`}
          className={cn((props.fill || focused) && "flex min-h-0 flex-1 flex-col")}
          theme={props.theme}
          onRetry={reload}
        >
          {frame}
        </LoadingFrameSlot>
      ) : (
        frame()
      )}
    </dialog>
  );
}

type FrameGate = { onPainted: () => void; onFailed: () => void };

/**
 * Past this, the frame is shown whatever it has drawn: a resource that never
 * finishes (a hung CDN) must not hold the loading surface forever. A frame
 * that later turns out undeliverable still shows its error.
 */
export const FRAME_PAINT_TIMEOUT_MS = 15_000;

/** One page in the frame: loading until it paints, or an error with Retry. */
function LoadingFrameSlot({
  className,
  theme,
  onRetry,
  children,
}: {
  className?: string | undefined;
  theme?: "light" | "dark" | undefined;
  onRetry: () => void;
  children: (gate: FrameGate) => ReactNode;
}) {
  const labels = useArtifactLabels();
  const [state, setState] = useState<"loading" | "revealed" | "painted" | "failed">("loading");
  const loading = state === "loading";
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setState("revealed"), FRAME_PAINT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading]);
  // The status region mounts empty and then says it is loading, so screen
  // readers announce it (text present at mount is usually not read).
  const [announce, setAnnounce] = useState(false);
  useEffect(() => setAnnounce(true), []);
  const gate = useRef<FrameGate>({
    onPainted: () =>
      setState((current) =>
        current === "loading" || current === "revealed" ? "painted" : current,
      ),
    onFailed: () =>
      setState((current) => (current === "loading" || current === "revealed" ? "failed" : current)),
  }).current;
  return (
    <div data-artifact-frame-slot="" aria-busy={loading} className={cn("relative", className)}>
      {children(gate)}
      <span role="status" className="sr-only">
        {loading && announce ? labels.preparingPreview : ""}
      </span>
      {loading ? (
        <div aria-hidden="true" data-og-theme={theme} className="absolute inset-0">
          <PreviewLoading fill />
        </div>
      ) : null}
      {state === "failed" ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface p-4 text-center text-sm text-fg-muted"
        >
          {labels.previewLoadFailed}
          <ArtifactButton size="sm" onClick={onRetry}>
            {labels.retry}
          </ArtifactButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Beside a host's replacement for Live: only Updating or Reconnecting shows.
 * The status region stays mounted and only its text changes, so screen
 * readers announce each change.
 */
function LiveStateBeside({
  status,
  labels,
}: {
  status: SiteLiveState;
  labels: ReturnType<typeof useArtifactLabels>;
}) {
  const busy = status === "updating" || status === "reconnecting";
  return (
    <span
      role="status"
      aria-live="polite"
      data-live-state-region=""
      data-live-status={busy ? status : undefined}
      className={
        busy
          ? "mr-1 inline-flex items-center gap-1.5 text-2xs font-medium text-fg-muted"
          : "sr-only"
      }
    >
      {busy ? (
        <>
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              status === "updating"
                ? "bg-status-running ring-4 ring-status-running/15 motion-safe:animate-pulse"
                : "bg-status-waiting ring-4 ring-status-waiting/15",
            )}
          />
          <span className="max-sm:sr-only">
            {status === "updating" ? labels.liveUpdating : labels.liveReconnecting}
          </span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Live, or what the host watching the Site knows: a newer version loading,
 * or no way to check for one right now. Announced politely when it changes;
 * on a narrow screen only its dot shows, and it is still announced.
 */
function LiveLabel({
  status,
  labels,
}: {
  status: SiteLiveState | undefined;
  labels: ReturnType<typeof useArtifactLabels>;
}) {
  const text =
    status === "updating"
      ? labels.liveUpdating
      : status === "reconnecting"
        ? labels.liveReconnecting
        : labels.live;
  return (
    <span
      className={cn(
        "mr-1 items-center gap-1.5 text-2xs font-medium text-fg-muted sm:inline-flex",
        status ? "inline-flex" : "hidden",
      )}
      data-live-status={status}
      {...(status ? { role: "status", "aria-live": "polite" as const } : {})}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          status === "updating"
            ? "bg-status-running ring-4 ring-status-running/15 motion-safe:animate-pulse"
            : status === "reconnecting"
              ? "bg-status-waiting ring-4 ring-status-waiting/15"
              : "bg-status-success ring-4 ring-status-success/10",
        )}
      />
      <span className={status ? "max-sm:sr-only" : undefined}>{text}</span>
    </span>
  );
}
