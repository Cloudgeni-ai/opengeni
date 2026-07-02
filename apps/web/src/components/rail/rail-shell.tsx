// The left-rail shell that wraps every workspace-scoped route. It owns the
// fixed full-height rail (expanded 260px / collapsed 56px), the responsive
// overlay drawer (<1024px), and the slim canvas top strip that carries
// session-contextual actions on session routes. The rail itself is composed
// from the brand, switcher, workspace nav, session list, and footer sections.
import { SessionStatus as SessionStatusBadge } from "@opengeni/react";
import { Link, useRouterState } from "@tanstack/react-router";
import { LockIcon, MenuIcon, PanelRightIcon, PencilIcon, SparkleIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { ConnectionPill } from "@/components/common";
import { RailFooter } from "@/components/rail/rail-footer";
import { useRail } from "@/components/rail/rail-context";
import { CollapsedSessionsButton, SessionList } from "@/components/rail/session-list";
import { SwitcherBlock } from "@/components/rail/switcher-block";
import { SessionSandboxSwitcher } from "@/components/session/sandbox-switcher";
import { CodexAccountIndicator } from "@/components/session/codex-account-indicator";
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
    <div className="flex h-full min-h-0 flex-col bg-surface/40">
      {/* Brand */}
      <div className={cn("flex h-12 shrink-0 items-center", rail.collapsed ? "justify-center px-2" : "px-3")}>
        <Link
          to="/workspaces/$workspaceId/sessions"
          params={{ workspaceId: rail.workspaceId }}
          className="flex items-center gap-2 rounded-md text-[15px] font-semibold focus-visible:outline-none"
          aria-label="OpenGeni home"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <SparkleIcon className="size-3.5" />
          </span>
          {!rail.collapsed ? <span className="truncate">OpenGeni</span> : null}
        </Link>
      </div>

      <SwitcherBlock />

      <div className="mt-2">
        <WorkspaceNav />
      </div>

      <div className="my-2 border-t border-border" />

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
              "motion-safe:transition-[width] motion-safe:duration-150 shrink-0 border-r border-border",
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
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg/75 px-3 backdrop-blur sm:px-4">
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
            <SessionTitleEditor session={context.session} onRename={context.updateSessionTitle} />
            <div className="flex min-w-0 items-center gap-1 truncate text-xs text-fg-subtle">
              <span className="truncate">
                {context.session.model} · {String(context.session.metadata.reasoningEffort ?? "low")}
              </span>
              <span aria-hidden>·</span>
              <SessionSandboxSwitcher workspaceId={context.session.workspaceId} sessionId={context.session.id} />
              {/* Codex-prefix-gated inside the component: absent for host-credit sessions. */}
              <CodexAccountIndicator
                workspaceId={context.session.workspaceId}
                sessionId={context.session.id}
                model={context.session.model}
              />
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
          <span className="flex size-5 items-center justify-center rounded bg-brand-strong/20 text-brand">
            <SparkleIcon className="size-3" />
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
        className="w-full truncate rounded-sm bg-transparent text-sm font-medium outline-none ring-1 ring-ring/40 focus-visible:ring-ring"
      />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={rename.startEditing}
        title={`${display} · click to rename`}
        className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      >
        {display}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={rename.startEditing}
        aria-label="Rename session"
        className="shrink-0 text-fg-subtle hover:text-fg"
      >
        <PencilIcon className="size-3.5" />
      </Button>
    </div>
  );
}
