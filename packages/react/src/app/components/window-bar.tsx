// The desktop window bar's own contents, shared by every page's shell (the
// session shell and the settings shell): the sidebar toggle beside the
// traffic lights, and the bar's row, the page's title line. The bar itself is
// drawn by the app's stylesheet (`html[data-desktop]::before`), as are the
// rules that lift a row into it (`[data-window-bar-row] > [data-titlebar]`).
import { ChevronsLeftIcon, ChevronsRightIcon, PanelLeftIcon } from "lucide-react";
import { useMemo, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Button } from "../../ui/button";
import { PageHeaderWindowBarContext } from "../../ui/window-bar-title";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useActionShortcut } from "../lib/actions/actions-provider";
import { desktopPlatform } from "../lib/desktop";
import { useWindowBarRowLeft } from "../lib/window-bar-row";
import { TooltipWithKeys } from "./command-menu/keycaps";

/**
 * In the macOS app the sidebar toggle sits in the window bar, just right of
 * the traffic lights, as in native Mac apps, and each page's title line is the
 * bar's row beside it. The toggle starts clear of the wider badge macOS swaps
 * in for the traffic lights while the window is shared or recorded (about 80px
 * across), so it stays put in full screen too.
 */
export const SIDEBAR_TOGGLE_IN_WINDOW_BAR = desktopPlatform === "macos";

/**
 * Whether a page's title line is the window bar's row: only in the macOS app,
 * in the docked (not mobile) layout. Everywhere else, the web app included,
 * pages keep their header in the canvas.
 */
export function windowBarRowActive(options: {
  platform: string | null | undefined;
  mobile: boolean;
}): boolean {
  return options.platform === "macos" && !options.mobile;
}

/**
 * Controls drawn in the desktop window bar, above the page and its drag
 * region (`z-[46]`, one above the bar's 45), centred on the traffic lights'
 * line (`--og-window-controls-center`; from the top if they don't fit above
 * it), from `--og-window-bar-controls-left`. Rendered into a host at the start
 * of the body, so no rail or canvas stacking context can put them under the
 * bar, and they come first in the tab order, as the bar comes first on screen.
 */
export function WindowBarControls({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      data-window-bar-controls
      className="fixed left-[var(--og-window-bar-controls-left,84px)] top-0 z-[46] flex h-[calc(2*var(--og-window-controls-center,22px))] min-h-min items-center gap-1 [-webkit-app-region:no-drag] [app-region:no-drag]"
    >
      {children}
    </div>,
    windowBarHost(),
  );
}

function windowBarHost(): HTMLElement {
  let host = document.querySelector<HTMLElement>("body > [data-window-bar-host]");
  if (!host) {
    host = document.createElement("div");
    host.setAttribute("data-window-bar-host", "");
    document.body.prepend(host);
  }
  return host;
}

/**
 * The sidebar's collapse toggle: a panel icon in the window bar, chevrons in
 * a rail's own header.
 */
export function SidebarToggleButton({
  collapsed,
  onToggle,
  inWindowBar,
  shortcut = true,
}: {
  collapsed: boolean;
  onToggle: () => void;
  inWindowBar: boolean;
  /** Whether the app's sidebar shortcut toggles this sidebar (it doesn't outside a workspace). */
  shortcut?: boolean;
}) {
  const appSidebarKeys = useActionShortcut("view.sidebar");
  const sidebarKeys = shortcut ? appSidebarKeys : null;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-keyshortcuts={sidebarKeys?.ariaKeys}
          onClick={onToggle}
          className="shrink-0 text-fg-label hover:text-fg pointer-coarse:size-10"
        >
          {inWindowBar ? (
            <PanelLeftIcon className="size-4" />
          ) : collapsed ? (
            <ChevronsRightIcon className="size-4" />
          ) : (
            <ChevronsLeftIcon className="size-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={inWindowBar ? "bottom" : "right"}>
        <TooltipWithKeys label={label} shortcut={sidebarKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A page's title line in the window bar's row, as a chat's header is: the
 * same height, type and padding, from the canvas's left edge. Its text is the
 * page's title, which the page's own header (`PageHeader`) then doesn't
 * repeat. Render it as the canvas's first child, with `data-window-bar-row`
 * on the canvas (`useWindowBarRow`).
 */
export function WindowBarTitle({ children }: { children: ReactNode }) {
  return (
    <header
      data-window-drag
      data-titlebar
      data-window-bar-title
      className="flex min-w-0 shrink-0 items-center gap-1 pl-[max(clamp(0.5rem,2.5vw,1.25rem),env(safe-area-inset-left))] pr-[max(clamp(0.5rem,2.5vw,1.25rem),env(safe-area-inset-right))]"
    >
      {/* The page's own header keeps the page's heading for assistive tech. */}
      <span
        aria-hidden="true"
        className="min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[-0.01em] text-fg"
      >
        {children}
      </span>
    </header>
  );
}

/**
 * The window bar's row for a page's canvas: while `active`, the canvas is the
 * bar's row (`data-window-bar-row` on it, from `rowProps`, with its left edge
 * kept for the row). Wrap the canvas's content in `WindowBarPageTitle` to draw
 * the page's title there.
 */
export function useWindowBarRow(
  canvasRef: RefObject<HTMLElement | null>,
  active: boolean,
): { "data-window-bar-row"?: "" } {
  useWindowBarRowLeft(canvasRef, active);
  return active ? { "data-window-bar-row": "" } : {};
}

/**
 * While `enabled`, draws the page's title line in the window bar's row (as
 * the canvas's first child) and lets the first page header below with a
 * title claim it (headers in a `WindowBarTitleBoundary fallback` only when no
 * other has one); `fallbackTitle` stands in until one does. Always rendered,
 * so turning it on or off never remounts the page.
 */
export function WindowBarPageTitle({
  enabled,
  fallbackTitle,
  children,
}: {
  enabled: boolean;
  fallbackTitle?: ReactNode;
  children: ReactNode;
}) {
  // In the order the headers mounted (the page's order); a header keeps its
  // place while its title is briefly empty.
  const [claims, setClaims] = useState<
    readonly { id: string; title: string | null; fallback: boolean }[]
  >([]);
  const [registry] = useState(() => ({
    set(id: string, title: string | null, fallback = false) {
      setClaims((current) => {
        const existing = current.find((claim) => claim.id === id);
        if (existing?.title === title && existing.fallback === fallback) return current;
        return existing
          ? current.map((claim) => (claim.id === id ? { id, title, fallback } : claim))
          : [...current, { id, title, fallback }];
      });
    },
    release(id: string) {
      setClaims((current) => current.filter((claim) => claim.id !== id));
    },
  }));
  // A fallback claim (a hidden page under the open one) yields to any other.
  const owner =
    claims.find((claim) => claim.title && !claim.fallback) ?? claims.find((claim) => claim.title);
  const title = owner ? owner.title : fallbackTitle;
  const ownerId = owner?.id ?? null;
  const value = useMemo(
    () => (enabled ? { ...registry, owner: ownerId } : null),
    [enabled, ownerId, registry],
  );
  return (
    <PageHeaderWindowBarContext.Provider value={value}>
      {enabled && title != null && title !== "" ? <WindowBarTitle>{title}</WindowBarTitle> : null}
      {children}
    </PageHeaderWindowBarContext.Provider>
  );
}
