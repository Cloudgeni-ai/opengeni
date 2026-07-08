// The left-rail shell that wraps every workspace-scoped route. It owns the
// fixed full-height rail (expanded 260px / collapsed 56px), the responsive
// overlay drawer (<1024px), and the slim canvas top strip that carries
// session-contextual actions on session routes. The rail itself is composed
// from the brand, switcher, workspace nav, session list, and footer sections.
import { SessionStatus as SessionStatusBadge, useSessionLineage } from "@opengeni/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { LockIcon, MenuIcon, PanelRightIcon, PencilIcon } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";

import { ConnectionPill } from "@/components/common";
import { RailFooter } from "@/components/rail/rail-footer";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, useRail } from "@/components/rail/rail-context";
import { CollapsedSessionsButton, SessionList } from "@/components/rail/session-list";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { SessionSandboxSwitcher } from "@/components/session/sandbox-switcher";
import { CodexAccountIndicator } from "@/components/session/codex-account-indicator";
import { SessionAgentsChip, SpawnedByBreadcrumb } from "@/components/session/subagents";
import { WorkspaceNav } from "@/components/rail/workspace-nav";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppContext } from "@/context";
import { SESSION_TITLE_MAX_LENGTH, sessionDisplayTitle, useInlineRename } from "@/lib/session-rename";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

/** The rail body — shared between the fixed desktop column and the mobile drawer. */
function RailBody() {
  const rail = useRail();
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface/40 pt-[env(safe-area-inset-top)]">
      {/* Brand */}
      <div className={cn("flex h-12 shrink-0 items-center", rail.collapsed ? "justify-center px-2" : "px-3")}>
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
function RailResizeHandle({ onStart, active }: { onStart: (event: ReactPointerEvent) => void; active: boolean }) {
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
          active ? "w-0.5 bg-brand/70" : "bg-transparent group-hover:w-0.5 group-hover:bg-border-strong",
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
  const startResize = useCallback((event: ReactPointerEvent) => {
    // Ignore anything but a primary-button / touch drag.
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rail.width;
    const clamp = (w: number) => Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(w)));
    setLiveWidth(startWidth);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (moveEvent: PointerEvent) => setLiveWidth(clamp(startWidth + (moveEvent.clientX - startX)));
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
  }, [rail]);
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
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
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
  // One lineage read for the whole header — shared by the "N agents" chip and
  // the "spawned by" breadcrumb (disabled when there is no session). The header
  // lives outside the session route's event feed, so spawn events can't trigger
  // a refresh here (the goal pill's panel gets that via `events`); a modest poll
  // keeps the agent count honest without threading the stream into the rail.
  const lineage = useSessionLineage(context.session?.id ?? null, { pollIntervalMs: 30_000 });
  const childNodes = lineage.lineage?.children ?? [];
  const ancestors = lineage.lineage?.ancestors ?? [];
  const parentSession = ancestors.length > 0 ? ancestors[ancestors.length - 1]! : null;

  // On desktop, the strip only renders when there is something to show.
  if (!rail.isMobile && !showSessionActions) {
    return null;
  }

  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-3 border-b border-border bg-bg/75 px-3 backdrop-blur sm:px-4",
        // The session strip carries a two-line block (title + meta) — it gets
        // breathing room; the plain mobile brand strip stays slim.
        showSessionActions ? "h-14" : "h-12",
      )}
    >
      {rail.isMobile ? (
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
      ) : null}

      {showSessionActions && context.session ? (
        <>
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-px">
            {/* Child sessions link back to the manager that spawned them. */}
            <SpawnedByBreadcrumb workspaceId={context.session.workspaceId} parent={parentSession} />
            <SessionTitleEditor session={context.session} onRename={context.updateSessionTitle} />
            {/* One quiet metadata voice: no label-colon grammar, no separator
                soup — the model·effort token, then the sandbox pill (its own
                shape, no interposed dot), then the codex indicator. */}
            <div className="flex min-w-0 items-center gap-1.5 text-2xs leading-4 text-fg-subtle">
              <span className="shrink-0">
                {context.session.model} · {String(context.session.metadata.reasoningEffort ?? "low")}
              </span>
              <SessionSandboxSwitcher workspaceId={context.session.workspaceId} sessionId={context.session.id} />
              {/* Codex-prefix-gated inside the component: absent for host-credit sessions. */}
              <CodexAccountIndicator
                workspaceId={context.session.workspaceId}
                sessionId={context.session.id}
                model={context.session.model}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Sessions that spawned workers surface an "N agents" chip opening
                the shared subagent lineage panel. */}
            <SessionAgentsChip workspaceId={context.session.workspaceId} nodes={childNodes} loading={lineage.loading} />
            <ConnectionPill state={context.connectionState} />
            <SessionStatusBadge status={context.session.status} />
            {context.keyAuthRequired ? (
              <Button type="button" variant="ghost" size="icon-sm" onClick={context.forgetAccessKey} aria-label="Clear access key">
                <LockIcon className="size-4" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant={context.inspectorOpen ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => context.setInspectorOpen((open) => !open)}
              aria-label={context.inspectorOpen ? "Hide session panel" : "Show session panel"}
            >
              <PanelRightIcon className="size-4" />
            </Button>
          </div>
        </>
      ) : rail.isMobile ? (
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
      ) : null}
    </header>
  );
}

/**
 * The session header title — display by default, click the title (or the
 * always-visible pencil) to rename inline. Prefers the durable session.title
 * (agent- or user-set), falling back to the initial message / "Untitled
 * session" exactly like the rail list. Enter saves, Esc cancels, blur saves; an
 * empty/unchanged value is a no-op cancel. The live title (context.session)
 * flows in through the session.title_set SSE event the react useSession hook
 * applies, so cross-client renames and agent titling reflect here without a
 * reload. The shared `useInlineRename` hook keeps this behaviour identical to
 * the rail row's rename.
 */
function SessionTitleEditor(props: {
  session: Session;
  onRename: (workspaceId: string, sessionId: string, title: string) => Promise<Session | null>;
}) {
  const display = sessionDisplayTitle(props.session);
  const rename = useInlineRename(props.session, props.onRename);

  if (rename.editing) {
    return (
      // A calm in-place edit: same size and position as the display title, a
      // soft surface tint + hairline instead of a loud focus ring. The global
      // focus-ring rule is what painted the old blue box; opting out here keeps
      // the rename feeling like editing the text, not filling in a form field.
      <input
        ref={rename.inputRef}
        value={rename.draft}
        onChange={(event) => rename.setDraft(event.target.value)}
        onBlur={() => void rename.commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void rename.commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            rename.cancel();
          }
        }}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        aria-label="Session title"
        className="-mx-1.5 w-full truncate rounded-md bg-surface-2/70 px-1.5 text-sm font-medium leading-5 outline-none ring-1 ring-border-strong focus:outline-none focus-visible:outline-none"
        style={{ outline: "none" }}
      />
    );
  }

  return (
    <div className="group/title flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        onClick={rename.startEditing}
        title={`${display} · click to rename`}
        className="min-w-0 shrink truncate rounded-sm text-left text-sm font-medium leading-5 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {display}
      </button>
      {/* The pencil earns its pixels only when relevant: hidden at rest,
          revealed on hover/focus, always present on coarse pointers where
          hover doesn't exist. */}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={rename.startEditing}
        aria-label="Rename session"
        className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover/title:opacity-100 pointer-coarse:opacity-100"
      >
        <PencilIcon className="size-3" />
      </Button>
    </div>
  );
}
