// The session shell every session surface renders: the left rail (fixed and
// resizable on desktop, an overlay drawer on phones), the canvas top strip with
// the session header on session routes, and the canvas itself. Surface-owned
// sections (workspace switcher, navigation extras, footer, banners) come in as
// slots, so the web app and embeds share one shell and differ only in what they
// put in it.
import type { SessionSummary } from "@opengeni/sdk";
import { MenuIcon, MessagesSquareIcon, Settings2Icon } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  lazy,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { toast } from "../../lib/toast";

import { findPickerRow } from "../../../model-policy";
import { useLastStartedTurnPolicy } from "../../../hooks/use-last-started-turn-policy";
import { useSessionLineage } from "../../../hooks/use-session-lineage";
import { BrandMark, Wordmark } from "../brand-mark";
import { SessionHeader } from "./session-header";
import { SessionStartupProvider } from "../../../lib/session-startup";
import {
  requestSessionUsageLimitEditor,
  sessionUsageLimitCapability,
} from "../../lib/session-usage-limit";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, useRail } from "./rail-context";
import { CollapsedSessionsButton, SessionList } from "./session-list";
import {
  PrimaryNav,
  RailHeader,
  SessionShellSlotsContext,
  type SessionShellSlots,
} from "./rail-sections";

export {
  PrimaryNav,
  RailHeader,
  SessionShellSlotsProvider,
  type SessionShellSlots,
} from "./rail-sections";
import {
  SessionComputeIndicator,
  sessionSupportsFleetSwitching,
} from "../session/sandbox-switcher";
import { SubscriptionAccountIndicator } from "../session/subscription-account-indicator";
import { subscriptionAccountProvider } from "../session/subscription-account";
import { PrivateSessionIndicator } from "../session/private-session-indicator";
import { Button } from "../../../ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../../../ui/sheet";
import { TooltipProvider } from "../../../ui/tooltip";
import { Link, useNavigate, useRouterState } from "../../lib/navigation";
import { useWorkspaceModelCatalog } from "../../lib/use-workspace-model-catalog";
import { useAppContext } from "../../app-context";
import { isPersonalWorkspace } from "../../lib/managed-self-context";
import { isIntelligenceEffort } from "../../lib/session-tools";
import { useSessionRepliesMute } from "../../lib/inbox";
import { useSessionAdminAccess } from "../session/session-admin-access";
import { applySessionArchiveProjection } from "../../lib/session-pagination";
import { notifySessionListChanged } from "../../lib/session-list-invalidation";
import type { Session } from "../../types";
import { cn } from "../../lib/utils";
import { windowControlsInPage } from "../../lib/desktop";
import { useSessionUiFeature } from "../../lib/session-ui-features";
import { useUiEventTarget } from "../../lib/ui-events";

const LazySessionTenancyRouteControl = lazy(() =>
  import("../session/session-tenancy-control").then(({ SessionTenancyRouteControl }) => ({
    default: SessionTenancyRouteControl,
  })),
);

/** The rail body — shared between the fixed desktop column and the mobile drawer. */
export function RailBody() {
  const rail = useRail();
  const { switcher, mobileWorkspacePanel, railFooter } = useContext(SessionShellSlotsContext);
  const [mobileSection, setMobileSection] = useState<"sessions" | "workspace">("sessions");
  const sessionsTabRef = useRef<HTMLButtonElement>(null);
  const workspaceTabRef = useRef<HTMLButtonElement>(null);
  // Unique per app, so two apps on one page never share these ids.
  const mobileNavId = `mobile-nav-${useId().replaceAll(":", "")}`;
  useEffect(() => {
    if (rail.drawerOpen) setMobileSection("sessions");
  }, [rail.drawerOpen]);
  const moveMobileTab = (section: "sessions" | "workspace") => {
    setMobileSection(section);
    window.requestAnimationFrame(() =>
      (section === "sessions" ? sessionsTabRef : workspaceTabRef).current?.focus(),
    );
  };
  return (
    <div
      data-rail
      className="og-rail-glow isolate flex h-full min-h-0 flex-col overflow-hidden pt-[env(safe-area-inset-top)]"
    >
      {/* Native macOS controls sit over this row. Keep it outside the clipped
          viewport so navigation cannot scroll underneath them. */}
      {windowControlsInPage ? (
        <div data-rail-window-controls className="relative z-10 shrink-0 pb-3">
          <RailHeader showSwitcher={false} />
        </div>
      ) : null}
      <div
        data-rail-scroll-viewport
        className="relative z-0 min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain"
      >
        <div className="flex min-h-full flex-col">
          {!windowControlsInPage ? <RailHeader /> : null}

          {rail.collapsed || windowControlsInPage ? switcher : null}

          {rail.isMobile && mobileWorkspacePanel ? (
            <>
              <div
                role="tablist"
                aria-label="Navigation section"
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "Home") {
                    event.preventDefault();
                    moveMobileTab("sessions");
                  } else if (event.key === "ArrowRight" || event.key === "End") {
                    event.preventDefault();
                    moveMobileTab("workspace");
                  }
                }}
                className="mx-3 mt-3 grid shrink-0 grid-cols-2 rounded-lg bg-surface-2/70 p-1"
              >
                <button
                  ref={sessionsTabRef}
                  id={`${mobileNavId}-tab-sessions`}
                  type="button"
                  role="tab"
                  aria-selected={mobileSection === "sessions"}
                  aria-controls={`${mobileNavId}-panel-sessions`}
                  tabIndex={mobileSection === "sessions" ? 0 : -1}
                  onClick={() => setMobileSection("sessions")}
                  className={cn(
                    "flex h-10 items-center justify-center gap-2 rounded-md text-sm font-normal transition-colors",
                    mobileSection === "sessions"
                      ? "bg-surface-3 text-fg shadow-sm"
                      : "text-fg-label hover:text-fg",
                  )}
                >
                  <MessagesSquareIcon className="size-4" />
                  Sessions
                </button>
                <button
                  ref={workspaceTabRef}
                  id={`${mobileNavId}-tab-workspace`}
                  type="button"
                  role="tab"
                  aria-selected={mobileSection === "workspace"}
                  aria-controls={`${mobileNavId}-panel-workspace`}
                  tabIndex={mobileSection === "workspace" ? 0 : -1}
                  onClick={() => setMobileSection("workspace")}
                  className={cn(
                    "flex h-10 items-center justify-center gap-2 rounded-md text-sm font-normal transition-colors",
                    mobileSection === "workspace"
                      ? "bg-surface-3 text-fg shadow-sm"
                      : "text-fg-label hover:text-fg",
                  )}
                >
                  <Settings2Icon className="size-4" />
                  Workspace
                </button>
              </div>
              {mobileSection === "sessions" ? (
                <div
                  id={`${mobileNavId}-panel-sessions`}
                  role="tabpanel"
                  aria-labelledby={`${mobileNavId}-tab-sessions`}
                  className="mt-2 flex shrink-0 flex-col"
                >
                  <PrimaryNav />
                  <SessionList />
                </div>
              ) : (
                <div
                  id={`${mobileNavId}-panel-workspace`}
                  role="tabpanel"
                  aria-labelledby={`${mobileNavId}-tab-workspace`}
                  className="mt-2 flex shrink-0 flex-col border-t border-border pt-2"
                >
                  {mobileWorkspacePanel}
                </div>
              )}
            </>
          ) : (
            <>
              {/* Sessions are the primary object. Workspace administration remains
              secondary on desktop and becomes its own screen on phones. */}
              <PrimaryNav />
              <div className="mt-2 flex shrink-0 flex-col">
                {rail.collapsed ? <CollapsedSessionsButton /> : <SessionList />}
              </div>
            </>
          )}
        </div>
      </div>
      {/* Keep the persistent controls above the scroll viewport, including
          session-row actions with their own stacking levels. The footer is a
          sibling of the clipped viewport, so it can stay transparent and let
          the rail glow run to the bottom edge. */}
      {railFooter ? (
        <div data-rail-footer className="relative z-10 shrink-0 border-t border-border">
          {railFooter}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The drag handle on the expanded rail's right edge. A quiet, wide-ish hit area
 * straddling the border: at rest it's invisible (the border is the only line);
 * on hover it thickens into a stronger line, and while dragging it wears the
 * brand tint. Double-click snaps back to the default width. Keyboard users get
 * the collapse toggle elsewhere; this is a pointer affordance (hidden from the
 * a11y tree beyond its separator role + label).
 */
function RailResizeHandle({
  onStart,
  active,
}: {
  onStart: (event: ReactPointerEvent) => void;
  active: boolean;
}) {
  const rail = useRail();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onStart}
      onDoubleClick={() => rail.setWidth(RAIL_DEFAULT_WIDTH)}
      className="group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none select-none"
    >
      <span
        className={cn(
          "absolute inset-y-0 right-1 w-px transition-[width,background-color] duration-150",
          active
            ? "w-0.5 bg-brand/70"
            : "bg-transparent group-hover:w-0.5 group-hover:bg-border-strong",
        )}
      />
    </div>
  );
}

const NO_SLOTS: SessionShellSlots = {};

export function SessionShell({
  children,
  slots = NO_SLOTS,
}: {
  children: ReactNode;
  slots?: SessionShellSlots | undefined;
}) {
  return (
    <SessionShellSlotsContext.Provider value={slots}>
      <SessionShellFrame>{children}</SessionShellFrame>
    </SessionShellSlotsContext.Provider>
  );
}

function SessionShellFrame({ children }: { children: ReactNode }) {
  const rail = useRail();
  const chatList = useSessionUiFeature("chatList");
  const context = useAppContext();
  const { canvasBanners } = useContext(SessionShellSlotsContext);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // Focus returns here when the mobile drawer closes (D9.1): the drawer is a
  // controlled Sheet with no in-tree trigger, so radix can't restore focus on
  // its own — we point it back at the hamburger that opened it.
  const hamburgerRef = rail.drawerTriggerRef;

  // Live width while the reader drags the resize handle. Held locally (not in
  // context) so we don't write localStorage on every pointer move — the chosen
  // width is committed once on pointer-up. `null` means "not resizing".
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const resizing = liveWidth !== null;
  // Teardown for an in-progress drag (remove window listeners + reset body
  // styles). Held in a ref so an unmount / route change MID-DRAG can run it —
  // otherwise the listeners and the col-resize cursor / no-select body styles
  // linger until an unrelated pointer release elsewhere.
  const endResizeRef = useRef<(() => void) | null>(null);
  const startResize = useCallback(
    (event: ReactPointerEvent) => {
      // Ignore anything but a primary-button / touch drag.
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = rail.width;
      const clamp = (w: number) =>
        Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(w)));
      setLiveWidth(startWidth);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      const onMove = (moveEvent: PointerEvent) =>
        setLiveWidth(clamp(startWidth + (moveEvent.clientX - startX)));
      const teardown = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        endResizeRef.current = null;
      };
      const onUp = (upEvent: PointerEvent) => {
        rail.setWidth(clamp(startWidth + (upEvent.clientX - startX)));
        setLiveWidth(null);
        teardown();
      };
      endResizeRef.current = teardown;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [rail],
  );
  // Unmount / route-change mid-drag: run the drag teardown so listeners and
  // body styles never leak.
  useEffect(() => () => endResizeRef.current?.(), []);

  // Close the mobile drawer on route change.
  useEffect(() => {
    if (rail.drawerOpen) {
      rail.setDrawerOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex h-full min-h-0 w-full flex-1 overflow-hidden"
        // Lets page chrome (the desktop title bar) follow the rail without a
        // document-wide `:has()` selector.
        data-rail-collapsed={chatList && !rail.isMobile && rail.collapsed ? "true" : undefined}
      >
        {/* Fixed desktop rail — user-resizable when expanded. */}
        {chatList && !rail.isMobile ? (
          <nav
            aria-label="Primary"
            data-collapsed={rail.collapsed}
            style={rail.collapsed ? undefined : { width: resizing ? liveWidth! : rail.width }}
            className={cn(
              "relative shrink-0 border-r border-border",
              // Animate the collapse/expand toggle, but never while dragging — a
              // transition there would lag the handle behind the pointer.
              !resizing && "motion-safe:transition-[width] motion-safe:duration-150",
              rail.collapsed && "w-[56px]",
            )}
          >
            <RailBody />
            {/* The drag handle only exists on the expanded desktop rail; the
                collapsed strip and the mobile drawer are fixed-width. */}
            {!rail.collapsed ? <RailResizeHandle onStart={startResize} active={resizing} /> : null}
          </nav>
        ) : null}

        {/* Mobile overlay drawer. */}
        {chatList && rail.isMobile ? (
          <Sheet open={rail.drawerOpen} onOpenChange={rail.setDrawerOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              aria-label="Session navigation"
              className="w-screen max-w-none gap-0 p-0 sm:w-[380px] sm:max-w-[90vw]"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                rail.restoreDrawerFocus();
              }}
            >
              <SheetTitle className="sr-only">Session navigation</SheetTitle>
              <SheetDescription className="sr-only">
                Browse workspace sessions or open Workspace.
              </SheetDescription>
              <nav aria-label="Primary" className="h-full">
                <RailBody />
              </nav>
            </SheetContent>
          </Sheet>
        ) : null}

        {/* Main canvas. */}
        <div data-canvas className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <SessionStartupProvider session={context.session}>
            <CanvasTopStrip hamburgerRef={hamburgerRef} />
            {canvasBanners}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
          </SessionStartupProvider>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * The slim canvas top strip. On mobile it always shows (hamburger + brand). On
 * session routes it also carries the session title/status, the connection and
 * lock pills, and the inspector toggle — moved here from the old top header.
 */
function CanvasTopStrip({ hamburgerRef }: { hamburgerRef: RefObject<HTMLButtonElement | null> }) {
  const rail = useRail();
  const chatList = useSessionUiFeature("chatList");
  const brand = useSessionUiFeature("brand");
  const context = useAppContext();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const isSessionRoute = /\/sessions\/[^/]+/.test(pathname);
  const showSessionActions = Boolean(context.session) && isSessionRoute;
  const sharedFeed = useSyncExternalStore(
    context.sessionEventFeedStore.subscribe,
    context.sessionEventFeedStore.getSnapshot,
    context.sessionEventFeedStore.getSnapshot,
  );
  const sessionEvents =
    sharedFeed && sharedFeed.sessionId === context.session?.id ? sharedFeed.events : [];
  // The route owns the only session stream. An empty shared feed is still an
  // authoritative shared feed, so this header can never fall back to self-streaming.
  const lineage = useSessionLineage(context.session?.id ?? null, {
    events: sessionEvents,
    pollIntervalMs: 30_000,
  });
  const ancestors = lineage.lineage?.ancestors ?? [];

  // On desktop, the strip only renders when there is something to show.
  if (!rail.isMobile && !showSessionActions) {
    return null;
  }

  const hamburger =
    chatList && rail.isMobile ? (
      <Button
        ref={hamburgerRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Open navigation"
        onClick={() => {
          // On phones the workspace inspector is also a full-screen surface.
          // Make the two overlays mutually exclusive instead of stacking one
          // modal beneath another and trapping the navigation out of sight.
          context.setInspectorOpen(false);
          rail.setDrawerOpen(true);
        }}
        className="size-11"
      >
        <MenuIcon className="size-4" />
      </Button>
    ) : null;

  // Session route: the full identity + status header (its own bar). The live
  // sandbox switcher and codex indicator flow in as slots so the header stays a
  // pure, screenshot-testable component.
  if (showSessionActions && context.session) {
    // Both schedule facts come from one read, so a newer lineage never pairs
    // with an older session read (an older server sends no upcoming flag).
    const lineageSchedules = lineage.lineage?.sessionHasSchedules;
    return (
      <SessionRouteHeader
        session={{
          ...context.session,
          ...(lineageSchedules === undefined
            ? {}
            : {
                hasSchedules: lineageSchedules,
                hasUpcomingSchedules:
                  lineage.lineage?.sessionHasUpcomingSchedules ?? lineageSchedules,
              }),
        }}
        ancestors={ancestors}
        lineageLoading={lineage.loading}
        lineageError={lineage.error}
        events={sessionEvents}
        hamburger={hamburger}
      />
    );
  }

  // Mobile, off a session route: the slim brand strip. A host without
  // Opengeni's brand keeps only the menu button, or no strip at all.
  if (!brand && !hamburger) return null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-canvas/75 px-3 backdrop-blur sm:px-4">
      {hamburger}
      {brand ? (
        <Link
          to="/workspaces/$workspaceId/sessions"
          params={{ workspaceId: rail.workspaceId }}
          className="flex items-center gap-2 text-fg"
        >
          <BrandMark className="w-5" />
          <Wordmark className="text-[17px]" />
        </Link>
      ) : null}
    </header>
  );
}

/** Session-route header: last-admitted model·effort, not the composer next pick. */
function SessionRouteHeader({
  session,
  ancestors,
  lineageLoading,
  lineageError,
  events,
  hamburger,
}: {
  session: Session;
  ancestors: SessionSummary[];
  lineageLoading: boolean;
  lineageError: Error | null;
  events: import("@opengeni/sdk").SessionEvent[];
  hamburger: ReactNode;
}) {
  const uiEvents = useUiEventTarget("document");
  const rail = useRail();
  const context = useAppContext();
  const lastStarted = useLastStartedTurnPolicy(session.id, {
    events,
    pollIntervalMs: 15_000,
    includeServingModel: true,
  });
  const lastStartedModel = lastStarted.policy?.model;
  const lastStartedReasoningEffort = isIntelligenceEffort(lastStarted.policy?.reasoningEffort)
    ? lastStarted.policy.reasoningEffort
    : undefined;
  const lastStartedLatencyMode = lastStarted.policy?.latencyMode;
  // Wait for last-started fetch before trusting session.model — creation default
  // can be a different rail than the newest admitted turn.
  const policyReady = !lastStarted.loading;
  const displayModelId = policyReady ? lastStartedModel || session.model : session.model;
  const navigate = useNavigate();
  const catalog = useWorkspaceModelCatalog(session.workspaceId);
  const selectedRow = findPickerRow(catalog.rows, displayModelId);
  const policyLoading = lastStarted.loading || catalog.loading;
  const accountProvider = subscriptionAccountProvider(
    displayModelId,
    selectedRow?.catalog.credentialSource,
  );
  const repliesMute = useSessionRepliesMute(session);
  const sessionAdminAccess = useSessionAdminAccess(session);
  const adminAccess = useSessionUiFeature("adminAccess") ? sessionAdminAccess : null;
  const dock = useSessionUiFeature("dock");
  const archiveInFlight = useRef(false);
  const onArchive = useCallback(
    async (target: Session, archived: boolean) => {
      if (archiveInFlight.current) return;
      const accepted = context.captureWorkspaceInvocation(target.workspaceId);
      if (!accepted) return;
      archiveInFlight.current = true;
      try {
        const updated = await context.client.updateSessionArchive(target.workspaceId, target.id, {
          archived,
          expectedVersion: target.archiveVersion ?? 0,
        });
        if (!context.ownsWorkspaceInvocation(target.workspaceId, accepted)) return;
        context.setSession((current) =>
          current?.id === updated.id && current.workspaceId === updated.workspaceId
            ? applySessionArchiveProjection(current, updated)
            : current,
        );
        notifySessionListChanged({
          workspaceId: target.workspaceId,
          sessionId: target.id,
          archived: updated.archived,
        });
        toast.success(updated.archived ? "Chat archived." : "Chat restored.");
      } catch (error) {
        if (!context.ownsWorkspaceInvocation(target.workspaceId, accepted)) return;
        toast.error(archived ? "Couldn't archive the chat." : "Couldn't restore the chat.", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        archiveInFlight.current = false;
      }
    },
    [context],
  );

  return (
    <SessionHeader
      session={session}
      ancestors={ancestors}
      onOpenSchedule={
        session.hasSchedules
          ? () =>
              void navigate({
                to: "/workspaces/$workspaceId/schedules",
                params: { workspaceId: session.workspaceId },
                search: { targetSessionId: session.id },
              })
          : null
      }
      lineageLoading={lineageLoading}
      lineageError={lineageError}
      connectionState={context.connectionState}
      status={session.status}
      keyAuthRequired={context.keyAuthRequired}
      onForgetAccessKey={context.forgetAccessKey}
      inspectorOpen={context.inspectorOpen}
      onToggleInspector={
        dock
          ? () => {
              if (!context.inspectorOpen && rail.isMobile) rail.setDrawerOpen(false);
              context.setInspectorOpen((open) => !open);
            }
          : undefined
      }
      onRename={context.updateSessionTitle}
      onPin={(target, pinned) =>
        context.updateSessionPin(target.workspaceId, target.id, pinned, target.pinVersion ?? 0)
      }
      onArchive={onArchive}
      repliesMute={repliesMute}
      adminAccess={adminAccess}
      onOpenUsageLimit={
        // The editor lives in the session panel's Agent tab.
        sessionUsageLimitCapability(context.clientConfig) === "absent" || !dock
          ? null
          : () => requestSessionUsageLimitEditor(uiEvents)
      }
      leading={hamburger}
      lastStartedModel={lastStartedModel}
      lastStartedReasoningEffort={lastStartedReasoningEffort}
      lastStartedLatencyMode={lastStartedLatencyMode}
      billingClass={selectedRow?.billingClass}
      modelLabel={selectedRow?.label}
      modelLogoUrl={selectedRow?.catalog.logoUrl}
      policyLoading={policyLoading}
      accessSlot={
        session.tenancy ? (
          <Suspense fallback={null}>
            <LazySessionTenancyRouteControl session={session} events={events} />
          </Suspense>
        ) : isPersonalWorkspace(
            context.workspaces.find((candidate) => candidate.id === session.workspaceId) ?? null,
            context.managedSelfContext,
          ) ? (
          // Without a tenancy record there is no access control to show, but a
          // Personal workspace chat is still private: say so, read-only.
          <PrivateSessionIndicator />
        ) : null
      }
      sandboxSlot={
        sessionSupportsFleetSwitching(session.sandboxBackend) ? (
          <SessionComputeIndicator sessionId={session.id} sandboxBackend={session.sandboxBackend} />
        ) : null
      }
      accountSlot={
        policyReady && accountProvider ? (
          <SubscriptionAccountIndicator
            workspaceId={session.workspaceId}
            sessionId={session.id}
            organizationId={
              context.workspaces.find((candidate) => candidate.id === session.workspaceId)
                ?.accountId ?? null
            }
            provider={accountProvider}
            servingTurnId={lastStarted.policy?.turnId}
            events={events}
          />
        ) : null
      }
    />
  );
}
