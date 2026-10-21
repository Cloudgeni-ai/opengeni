// The rail's sections that surfaces fill in: the brand row with the workspace
// switcher slot, and the primary navigation with "New session" plus the
// surface's own entries. `SessionShell` composes them.
import { ChevronsLeftIcon, ChevronsRightIcon, SquarePenIcon, XIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { BrandMark, Wordmark } from "../brand-mark";
import { useRail } from "./rail-context";
import { NewSessionLink } from "./session-list";
import { Button } from "../../../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/tooltip";
import { useActionShortcut } from "../../lib/actions/actions-provider";
import { Link, useRouterState } from "../../lib/navigation";
import { cn } from "../../lib/utils";
import { windowControlsInPage } from "../../lib/desktop";
import { useSessionUiFeature } from "../../lib/session-ui-features";

/**
 * The surface-owned sections of the session shell. Every slot is optional: a
 * surface without a workspace switcher, workspace navigation or footer simply
 * leaves them out and the shell keeps its layout.
 */
export type SessionShellSlots = Readonly<{
  /** The workspace switcher under the brand row (or under the window controls). */
  switcher?: ReactNode;
  /** Primary navigation after "New session" (inbox, workspace shortcuts). */
  primaryNav?: ReactNode;
  /**
   * The phone drawer's "Workspace" tab. Without it, phones show the sessions
   * list alone, with no tabs.
   */
  mobileWorkspacePanel?: ReactNode;
  /** Pinned under the rail's scroll viewport: account menu, offers. */
  railFooter?: ReactNode;
  /** Notices across the top of the canvas, under the top strip. */
  canvasBanners?: ReactNode;
}>;

export const SessionShellSlotsContext = createContext<SessionShellSlots>({});

/** Supplies the slots to a rail rendered outside `SessionShell` (previews, fixtures). */
export function SessionShellSlotsProvider({
  slots,
  children,
}: {
  slots: SessionShellSlots;
  children: ReactNode;
}) {
  return (
    <SessionShellSlotsContext.Provider value={slots}>{children}</SessionShellSlotsContext.Provider>
  );
}

/**
 * The top of the main rail: a brand row (the mark and the "Opengeni" wordmark)
 * and, under it, the workspace picker at full rail width. Its spacing matches
 * the settings rail's top (12px, 32px brand row, 12px gap) so switching
 * between the two rails doesn't jump. The collapse toggle sits at the right end
 * of the brand row; collapsed, only the mark stays, with the expand toggle
 * under it. In the macOS app the row holds just the toggle beside the window
 * controls.
 */
export function RailHeader({ showSwitcher = true }: { showSwitcher?: boolean }) {
  const rail = useRail();
  const { switcher } = useContext(SessionShellSlotsContext);
  // Without the brand (an embed, or the macOS app whose window controls sit
  // in the row), the row holds just the collapse toggle, at its end.
  const brand = useSessionUiFeature("brand");
  const brandless = windowControlsInPage || !brand;
  const collapseToggle = !rail.isMobile ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={rail.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={rail.toggleCollapsed}
          className="shrink-0 text-fg-label hover:text-fg pointer-coarse:size-10"
        >
          {rail.collapsed ? (
            <ChevronsRightIcon className="size-4" />
          ) : (
            <ChevronsLeftIcon className="size-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {rail.collapsed ? "Expand sidebar" : "Collapse sidebar"}
      </TooltipContent>
    </Tooltip>
  ) : null;
  return (
    <div data-rail-header className="flex shrink-0 flex-col gap-3 pt-3">
      <div
        data-rail-brand
        data-window-drag
        className={cn(
          "flex h-8 min-w-0 items-center gap-2 px-2",
          rail.collapsed ? "justify-center" : brandless ? "justify-end" : "justify-between",
        )}
      >
        {brandless ? null : (
          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId: rail.workspaceId }}
            className="flex h-8 shrink-0 items-center gap-2 rounded-md px-1.5 text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Opengeni home"
          >
            <BrandMark className="w-5" />
            {!rail.collapsed ? <Wordmark className="text-[18px]" /> : null}
          </Link>
        )}
        {!rail.collapsed || brandless ? collapseToggle : null}
        {rail.isMobile ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close navigation"
            onClick={() => rail.setDrawerOpen(false)}
            className="pointer-coarse:size-11"
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </div>
      {rail.collapsed && collapseToggle && !brandless ? (
        <div className="-mt-1 grid justify-items-center">{collapseToggle}</div>
      ) : null}
      {showSwitcher && !rail.collapsed ? switcher : null}
    </div>
  );
}

/** "New session" followed by the surface's own primary navigation. */
export function PrimaryNav() {
  const rail = useRail();
  const { primaryNav } = useContext(SessionShellSlotsContext);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const newSessionActive = pathname === `/workspaces/${rail.workspaceId}/sessions`;
  const newChatShortcut = useActionShortcut("chat.new");
  return (
    <div className={cn("mt-2 grid gap-0.5 px-2", rail.collapsed && "justify-center")}>
      <NewSessionLink
        aria-label={newChatShortcut ? `New session · ${newChatShortcut.label}` : "New session"}
        className={cn(
          "group relative flex h-8 items-center rounded-md text-sm font-normal text-fg-label outline-hidden transition-colors pointer-coarse:h-10",
          "hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50",
          newSessionActive && "bg-selection text-fg hover:bg-selection",
          rail.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity",
            newSessionActive ? "opacity-100" : "opacity-0",
          )}
        />
        <SquarePenIcon className="size-4 shrink-0" />
        {rail.collapsed ? null : <span className="min-w-0 truncate">New session</span>}
      </NewSessionLink>
      {primaryNav}
    </div>
  );
}
