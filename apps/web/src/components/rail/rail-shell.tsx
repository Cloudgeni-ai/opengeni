// The left-rail shell that wraps every workspace-scoped route. It owns the
// fixed full-height rail (expanded 260px / collapsed 56px), the responsive
// overlay drawer (<1024px), and the slim canvas top strip that carries
// session-contextual actions on session routes. The rail itself is composed
// from the brand, switcher, workspace nav, session list, and footer sections.
import { SessionStatus as SessionStatusBadge } from "@opengeni/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { LockIcon, MenuIcon, PanelRightIcon, SparkleIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { ConnectionPill } from "@/components/common";
import { RailFooter } from "@/components/rail/rail-footer";
import { useRail } from "@/components/rail/rail-context";
import { CollapsedSessionsButton, SessionList } from "@/components/rail/session-list";
import { SwitcherBlock } from "@/components/rail/switcher-block";
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
    <div className="flex h-full min-h-0 flex-col bg-[color:var(--color-surface)]/40">
      {/* Brand */}
      <div className={cn("flex h-12 shrink-0 items-center", rail.collapsed ? "justify-center px-2" : "px-3")}>
        <Link
          to="/workspaces/$workspaceId/sessions"
          params={{ workspaceId: rail.workspaceId }}
          className="flex items-center gap-2 rounded-md text-[15px] font-semibold focus-visible:outline-none"
          aria-label="OpenGeni home"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-[color:var(--color-brand-strong)]/20 text-[color:var(--color-brand)]">
            <SparkleIcon className="size-3.5" />
          </span>
          {!rail.collapsed ? <span className="truncate">OpenGeni</span> : null}
        </Link>
      </div>

      <SwitcherBlock />

      <div className="mt-2">
        <WorkspaceNav />
      </div>

      <div className="my-2 border-t border-[color:var(--color-border)]" />

      {rail.collapsed ? <CollapsedSessionsButton /> : <SessionList />}

      <RailFooter />
    </div>
  );
}

export function RailShell({ children }: { children: ReactNode }) {
  const rail = useRail();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

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
        {/* Fixed desktop rail. */}
        {!rail.isMobile ? (
          <nav
            aria-label="Primary"
            data-collapsed={rail.collapsed}
            className={cn(
              "motion-safe:transition-[width] motion-safe:duration-150 shrink-0 border-r border-[color:var(--color-border)]",
              rail.collapsed ? "w-[56px]" : "w-[260px]",
            )}
          >
            <RailBody />
          </nav>
        ) : null}

        {/* Mobile overlay drawer. */}
        {rail.isMobile ? (
          <Sheet open={rail.drawerOpen} onOpenChange={rail.setDrawerOpen}>
            <SheetContent side="left" showCloseButton={false} className="w-[260px] gap-0 p-0">
              <nav aria-label="Primary" className="h-full">
                <RailBody />
              </nav>
            </SheetContent>
          </Sheet>
        ) : null}

        {/* Main canvas. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CanvasTopStrip />
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
function CanvasTopStrip() {
  const rail = useRail();
  const context = useAppContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isSessionRoute = /\/sessions\/[^/]+/.test(pathname);
  const showSessionActions = Boolean(context.session) && isSessionRoute;

  // On desktop, the strip only renders when there is something to show.
  if (!rail.isMobile && !showSessionActions) {
    return null;
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]/75 px-3 backdrop-blur sm:px-4">
      {rail.isMobile ? (
        <Button
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
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{context.session.initialMessage}</div>
            <div className="truncate text-xs text-[color:var(--color-fg-subtle)]">
              {context.session.model} · {String(context.session.metadata.reasoningEffort ?? "low")} · {context.session.sandboxBackend}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {context.keyAuthRequired ? (
              <Button type="button" variant="ghost" size="icon-sm" onClick={context.forgetAccessKey} aria-label="Clear access key">
                <LockIcon className="size-4" />
              </Button>
            ) : null}
            <ConnectionPill state={context.connectionState} />
            <SessionStatusBadge status={context.session.status} />
            <Button
              type="button"
              variant={context.inspectorOpen ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => context.setInspectorOpen((open) => !open)}
              aria-label="Toggle session rail"
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
          <span className="flex size-5 items-center justify-center rounded bg-[color:var(--color-brand-strong)]/20 text-[color:var(--color-brand)]">
            <SparkleIcon className="size-3" />
          </span>
          OpenGeni
        </Link>
      ) : null}
    </header>
  );
}
