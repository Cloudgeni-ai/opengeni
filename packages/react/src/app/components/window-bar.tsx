// The desktop window bar's own contents, shared by every page's shell (the
// session shell and the settings shell): the sidebar toggle beside the
// traffic lights, and the bar's row, the page's title line. The bar itself is
// drawn by the app's stylesheet (`html[data-desktop]::before`), as are the
// rules that lift a row into it (`[data-window-bar-row] > [data-titlebar]`).
import {
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  CopyIcon,
  PanelLeftIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../../ui/context-menu";
import {
  PageHeaderWindowBarContext,
  type WindowBarCrumb,
  type WindowBarPlace,
} from "../../ui/window-bar-title";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { useActionShortcut } from "../lib/actions/actions-provider";
import { copyTitle } from "../lib/copy-link";
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

/** The host the window bar's controls render into, first in the body. */
export function windowBarHost(): HTMLElement {
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
const NO_TRAIL: readonly WindowBarCrumb[] = [];

export function WindowBarTitle({
  copyable = false,
  trail = NO_TRAIL,
  children,
}: {
  /** A title worth copying (a Site's): right-click it for Copy title. */
  copyable?: boolean;
  /**
   * Where the page is, before its title: the rail section and, on a detail
   * page, the list it belongs to. "Knowledge › Library › Meeting preparation".
   */
  trail?: readonly WindowBarCrumb[];
  children: ReactNode;
}) {
  const text = useRef<HTMLSpanElement>(null);
  const className =
    "min-w-0 truncate text-[15px] font-semibold leading-6 tracking-[-0.01em] text-fg";
  return (
    <header
      data-window-drag
      data-titlebar
      data-window-bar-title
      className="flex min-w-0 shrink-0 items-center gap-1 pl-[max(clamp(0.5rem,2.5vw,1.25rem),env(safe-area-inset-left))] pr-[max(clamp(0.5rem,2.5vw,1.25rem),env(safe-area-inset-right))]"
    >
      {trail.length > 0 ? (
        <nav aria-label="Location" className="flex min-w-0 shrink items-center gap-1">
          {trail.map((crumb) => (
            <span key={crumb.label} className="flex min-w-0 shrink items-center gap-1">
              <WindowBarCrumbLink crumb={crumb} />
              <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
            </span>
          ))}
        </nav>
      ) : null}
      {/* The page's own header keeps the page's heading for assistive tech. */}
      {copyable ? (
        // A copyable title's words leave the drag region, so they can be
        // right-clicked; the rest of the bar still drags the window.
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <span
              ref={text}
              aria-hidden="true"
              data-window-bar-title-text=""
              className={cn(className, "[-webkit-app-region:no-drag] [app-region:no-drag]")}
            >
              {children}
            </span>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-40">
            <ContextMenuItem
              onSelect={() => void copyTitle(text.current?.textContent?.trim() ?? "")}
            >
              <CopyIcon className="size-4" />
              Copy title
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <span aria-hidden="true" data-window-bar-title-text="" className={className}>
          {children}
        </span>
      )}
    </header>
  );
}

/** A trail step: muted, the page's title stays the one strong word in the bar. */
function WindowBarCrumbLink({ crumb }: { crumb: WindowBarCrumb }) {
  const className =
    "min-w-0 truncate rounded-[6px] px-1 -mx-1 text-[15px] leading-6 font-medium tracking-[-0.01em] text-fg-muted outline-hidden transition-colors duration-[120ms] hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/55 [-webkit-app-region:no-drag] [app-region:no-drag]";
  if (crumb.href) {
    return (
      <a href={crumb.href} onClick={crumb.onClick} className={className}>
        {crumb.label}
      </a>
    );
  }
  if (crumb.onClick) {
    return (
      <button type="button" onClick={crumb.onClick} className={className}>
        {crumb.label}
      </button>
    );
  }
  return <span className={cn(className, "hover:text-fg-muted")}>{crumb.label}</span>;
}

/** The trail before a title: the section, then the page's list, skipping repeats. */
export function windowBarTrail(
  title: string | null | undefined,
  section: WindowBarCrumb | null | undefined,
  parent: WindowBarCrumb | null | undefined,
): WindowBarCrumb[] {
  const trail: WindowBarCrumb[] = [];
  const same = (a: string, b: string | null | undefined) =>
    a.trim().toLowerCase() === (b ?? "").trim().toLowerCase();
  if (section && !same(section.label, title)) trail.push(section);
  if (
    parent &&
    !same(parent.label, title) &&
    !trail.some((crumb) => same(crumb.label, parent.label))
  ) {
    trail.push(parent);
  }
  return trail;
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
  section,
  children,
}: {
  enabled: boolean;
  fallbackTitle?: ReactNode;
  /** The rail section the page is in ("Agents"), first in the bar's trail. */
  section?: WindowBarCrumb | null | undefined;
  children: ReactNode;
}) {
  // In the order the headers mounted (the page's order); a header keeps its
  // place while its title is briefly empty.
  const [claims, setClaims] = useState<
    readonly {
      id: string;
      title: string | null;
      fallback: boolean;
      copyable: boolean;
      place: WindowBarPlace | null;
    }[]
  >([]);
  const [registry] = useState(() => ({
    set(
      id: string,
      title: string | null,
      fallback = false,
      copyable = false,
      place: WindowBarPlace | null = null,
    ) {
      setClaims((current) => {
        const existing = current.find((claim) => claim.id === id);
        if (
          existing?.title === title &&
          existing.fallback === fallback &&
          existing.copyable === copyable &&
          existing.place === place
        )
          return current;
        const claim = { id, title, fallback, copyable, place };
        return existing
          ? current.map((other) => (other.id === id ? claim : other))
          : [...current, claim];
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
  const parent = owner?.place?.parent ?? null;
  const trail = windowBarTrail(
    typeof title === "string" ? title : null,
    owner?.place?.section ?? section,
    parent,
  );
  // The page's back link may leave the page only when the trail carries it.
  const parentInTrail = parent !== null && trail.includes(parent);
  const value = useMemo(
    () => (enabled ? { ...registry, owner: ownerId, parentInTrail } : null),
    [enabled, ownerId, parentInTrail, registry],
  );
  return (
    <PageHeaderWindowBarContext.Provider value={value}>
      {enabled && title != null && title !== "" ? (
        <WindowBarTitle copyable={owner?.copyable ?? false} trail={trail}>
          {title}
        </WindowBarTitle>
      ) : null}
      {children}
    </PageHeaderWindowBarContext.Provider>
  );
}
