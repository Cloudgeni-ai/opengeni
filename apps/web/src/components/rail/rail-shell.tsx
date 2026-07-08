// The left-rail shell that wraps every workspace-scoped route. It owns the
// fixed full-height rail (expanded 260px / collapsed 56px), the responsive
// overlay drawer (<1024px), and the slim canvas top strip that carries
// session-contextual actions on session routes. The rail itself is composed
// from the brand, switcher, workspace nav, session list, and footer sections.
import { useSessionLineage } from "@opengeni/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { MenuIcon } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { RailFooter } from "@/components/rail/rail-footer";
import { SessionHeader } from "@/components/rail/session-header";
import {
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  useRail,
} from "@/components/rail/rail-context";
import { CollapsedSessionsButton, SessionList } from "@/components/rail/session-list";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { SessionSandboxSwitcher } from "@/components/session/sandbox-switcher";
import { CodexAccountIndicator } from "@/components/session/codex-account-indicator";
import { WorkspaceNav } from "@/components/rail/workspace-nav";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";

/** The rail body — shared between the fixed desktop column and the mobile drawer. */
function RailBody() {
  const rail = useRail();
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface/40 pt-[env(safe-area-inset-top)]">
      {/* Brand */}
      <div
        className={cn(
          "flex h-12 shrink-0 items-center",
          rail.collapsed ? "justify-center px-2" : "px-3",
        )}
      >
        <Link
          to="/workspaces/$workspaceId/sessions"
          params={{ workspaceId: rail.workspaceId }}
          className="flex items-center gap-2 rounded-md text-[15px] font-semibold focus-visible:outline-none"
          aria-label="OpenGeni home"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <BrandMark className="size-4" />
          </span>
          {!rail.collapsed ? <span className="truncate">OpenGeni</span> : null}
        </Link>
      </div>

      <SwitcherBlock />

      {/* Sessions — the product's primary object — sit directly under the
          switcher (D4.1); the secondary workspace-config group drops below. */}
      <div className="mt-2 flex min-h-0 flex-1 flex-col">
        {rail.collapsed ? <CollapsedSessionsButton /> : <SessionList />}
      </div>

      <div className="my-2 border-t border-border" />

      <WorkspaceNav />

      <RailFooter />
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

export function RailShell({ children }: { children: ReactNode }) {
  const rail = useRail();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Focus returns here when the mobile drawer closes (D9.1): the drawer is a
  // controlled Sheet with no in-tree trigger, so radix can't restore focus on
  // its own — we point it back at the hamburger that opened it.
  const hamburgerRef = useRef<HTMLButtonElement>(null);

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

  // Global `c` shortcut → new session. Ignored while typing in a field or with
  // a modifier held, so it never steals keystrokes from the composer.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      rail.startNewSession();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [rail]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden">
        {/* Fixed desktop rail — user-resizable when expanded. */}
        {!rail.isMobile ? (
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
        {rail.isMobile ? (
          <Sheet open={rail.drawerOpen} onOpenChange={rail.setDrawerOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[260px] max-w-[85vw] gap-0 p-0"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                hamburgerRef.current?.focus();
              }}
            >
              <nav aria-label="Primary" className="h-full">
                <RailBody />
              </nav>
            </SheetContent>
          </Sheet>
        ) : null}

        {/* Main canvas. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CanvasTopStrip hamburgerRef={hamburgerRef} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
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
  const context = useAppContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSessionRoute = /\/sessions\/[^/]+/.test(pathname);
  const showSessionActions = Boolean(context.session) && isSessionRoute;
  // A lineage read for the header's "spawned by" breadcrumb (disabled when there
  // is no session). The header lives outside the session route's event feed, so
  // spawn events can't trigger a refresh here; a modest poll keeps the ancestor
  // link honest without threading the stream into the rail. (The child-agents
  // count moved to the composer pill, which reads lineage off the live feed.)
  const lineage = useSessionLineage(context.session?.id ?? null, { pollIntervalMs: 30_000 });
  const ancestors = lineage.lineage?.ancestors ?? [];
  const parentSession = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null;

  // On desktop, the strip only renders when there is something to show.
  if (!rail.isMobile && !showSessionActions) {
    return null;
  }

  const hamburger = rail.isMobile ? (
    <Button
      ref={hamburgerRef}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Open navigation"
      onClick={() => rail.setDrawerOpen(true)}
    >
      <MenuIcon className="size-4" />
    </Button>
  ) : null;

  // Session route: the full identity + status header (its own bar). The live
  // sandbox switcher and codex indicator flow in as slots so the header stays a
  // pure, screenshot-testable component.
  if (showSessionActions && context.session) {
    const session = context.session;
    return (
      <SessionHeader
        session={session}
        parent={parentSession}
        connectionState={context.connectionState}
        status={session.status}
        keyAuthRequired={context.keyAuthRequired}
        onForgetAccessKey={context.forgetAccessKey}
        inspectorOpen={context.inspectorOpen}
        onToggleInspector={() => context.setInspectorOpen((open) => !open)}
        onRename={context.updateSessionTitle}
        leading={hamburger}
        sandboxSlot={
          <SessionSandboxSwitcher workspaceId={session.workspaceId} sessionId={session.id} />
        }
        // Codex-prefix-gated inside the component: absent for host-credit sessions.
        codexSlot={
          <CodexAccountIndicator
            workspaceId={session.workspaceId}
            sessionId={session.id}
            model={session.model}
          />
        }
        // The "N agents" indicator now lives above the composer (front and
        // center) as ComposerAgentsPill, not in this header — see session.tsx.
      />
    );
  }

  // Mobile, off a session route: the slim brand strip.
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg/75 px-3 backdrop-blur sm:px-4">
      {hamburger}
      <Link
        to="/workspaces/$workspaceId/sessions"
        params={{ workspaceId: rail.workspaceId }}
        className="flex items-center gap-2 text-sm font-semibold"
      >
        <span className="flex size-5 items-center justify-center rounded bg-brand-strong/20 text-brand">
          <BrandMark className="size-3.5" />
        </span>
        OpenGeni
      </Link>
    </header>
  );
}
