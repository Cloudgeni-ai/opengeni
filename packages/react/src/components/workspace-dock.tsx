import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ChevronsLeftRightIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  XIcon,
} from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
  type Layout,
  type LayoutChangedMeta,
  type LayoutStorage,
} from "react-resizable-panels";
import { cn } from "../lib/cn";

export type WorkspaceTab = {
  id: string;
  label: ReactNode;
  /** Optional icon used by the compact activity rail. */
  icon?: ReactNode | undefined;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string | undefined;
  /** Rendered as the active surface. */
  content: ReactNode;
  /** A small badge after the label (e.g. dirty count, live pill). */
  badge?: ReactNode | undefined;
};

export type WorkspaceDockProps = {
  /** The chat / primary pane shown beside the dock. */
  primary: ReactNode;
  tabs: WorkspaceTab[];
  /** Controlled active tab. Falls back to the first tab. */
  activeTab?: string | undefined;
  onActiveTabChange?: ((id: string) => void) | undefined;
  /** Controlled collapsed state for hosts that expose their own dock toggle. */
  collapsed?: boolean | undefined;
  onCollapsedChange?: ((collapsed: boolean) => void) | undefined;
  /** Keep the panel-local Hide workspace control when the host controls collapsed state. */
  showCollapseControl?: boolean | undefined;
  /** A status accessory pinned to the right of the workspace header, left of the
   *  maximize/collapse controls (e.g. the machine-state chip). Renders in both
   *  the docked header and the full-screen overlay header. */
  headerAccessory?: ReactNode | undefined;
  /** Optional host navigation shown at the start of the phone overlay header.
   *  It is intentionally absent from desktop dock chrome. */
  mobileLeadingControl?: ReactNode | undefined;
  /** Persisted layout id (localStorage key) for react-resizable-panels. */
  autoSaveId?: string | undefined;
  /** Default dock width as a percent of the session area. */
  defaultSize?: number | undefined;
  minSize?: number | undefined;
  maxSize?: number | undefined;
  className?: string | undefined;
};

const SERVER_LAYOUT_STORAGE: LayoutStorage = {
  getItem: () => null,
  setItem: () => {},
};

/** `useDefaultLayout` defaults to the ambient `localStorage` identifier when
 * storage is undefined, which throws during SSR. Access can also throw in a
 * browser that blocks storage (sandboxed frames/private policy), so both cases
 * use a stable, non-persisting implementation instead. */
function getLayoutStorage(): LayoutStorage {
  if (typeof window === "undefined") return SERVER_LAYOUT_STORAGE;
  try {
    return window.localStorage;
  } catch {
    return SERVER_LAYOUT_STORAGE;
  }
}

/**
 * The resizable / collapsible / maximizable right-hand Workspace dock. Replaces
 * a fixed grid column: drag the separator to set width, collapse to a thin rail
 * that re-opens on click, and maximize to a full-workspace overlay (Esc /
 * restore button returns). Layout persists via `useDefaultLayout` keyed on
 * `autoSaveId`. Maximize is a mode ABOVE the Group (a `fixed inset-0` overlay) —
 * pushing a Panel to ~100% still fights min sizes and leaves a chat sliver.
 *
 * Below {@link DOCK_OVERLAY_BREAKPOINT} the side-by-side split can't work on a
 * phone-width viewport, so the resizable panels are dropped entirely: the
 * primary pane goes full-width and the dock becomes a full-screen overlay driven
 * by the same `collapsed` / `onCollapsedChange` contract (collapsed → hidden).
 * No drag splitter renders below the breakpoint.
 */
const useDockLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The dock stops being a side column at this width and becomes a full-screen
 * overlay — matches the app's rail-drawer breakpoint (the single `isMobile`
 * source). The package can't read app context, so it detects the width itself.
 */
const DOCK_OVERLAY_BREAKPOINT = 1024;

/** SSR-safe `(max-width: …)` match; false until mounted, then live. */
function useIsNarrow(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useDockLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(`(max-width: ${maxWidth - 1}px)`);
    const update = () => setNarrow(mql.matches);
    update();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    // Legacy Safari.
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, [maxWidth]);
  return narrow;
}

export function WorkspaceDock({
  primary,
  tabs,
  activeTab,
  onActiveTabChange,
  collapsed: collapsedProp,
  onCollapsedChange,
  showCollapseControl = true,
  headerAccessory,
  mobileLeadingControl,
  autoSaveId = "og.session.dock",
  defaultSize = 34,
  minSize = 22,
  maxSize = 70,
  className,
}: WorkspaceDockProps) {
  const narrow = useIsNarrow(DOCK_OVERLAY_BREAKPOINT);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reopenRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const initialNarrowFocusRef = useRef(false);
  const dockPanelRef = usePanelRef();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [internalTab, setInternalTab] = useState(tabs[0]?.id ?? "");
  const collapsed = collapsedProp ?? internalCollapsed;
  // The host header remains the stable reopen action. The open panel also owns
  // a local Hide workspace action so a user never has to hunt elsewhere to
  // dismiss it; standalone usage keeps the thin reopen rail as well.
  const hostControlled = collapsedProp !== undefined;
  const previousCollapsedRef = useRef(collapsed);

  // Persisted layout (width split) keyed by autoSaveId.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    panelIds: ["primary", "dock"],
    storage: getLayoutStorage(),
    id: autoSaveId,
  });
  const expandedDefaultLayout =
    defaultLayout && (defaultLayout.dock ?? 0) > 1 ? defaultLayout : undefined;
  const lastExpandedSizeRef = useRef(expandedDefaultLayout?.dock ?? defaultSize);
  const layoutIdentityRef = useRef(autoSaveId);
  if (layoutIdentityRef.current !== autoSaveId) {
    layoutIdentityRef.current = autoSaveId;
    lastExpandedSizeRef.current = expandedDefaultLayout?.dock ?? defaultSize;
  }
  const persistExpandedLayout = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      // Both supported panel-library versions report 100/0 when the host
      // collapses the dock. Do not replace the last user-selected width with it.
      const dockSize = layout.dock ?? 0;
      if (dockSize <= 1) return;
      lastExpandedSizeRef.current = dockSize;
      onLayoutChanged(layout, meta);
    },
    [onLayoutChanged],
  );

  const requestedTab = activeTab ?? internalTab;
  const tabIds = tabs.map((tab) => tab.id);
  const firstTabId = tabs[0]?.id ?? "";
  const requestedTabIsValid = tabIds.includes(requestedTab);
  const current = requestedTabIsValid ? requestedTab : firstTabId;
  const setTab = useCallback(
    (id: string) => {
      setInternalTab(id);
      onActiveTabChange?.(id);
    },
    [onActiveTabChange],
  );
  const setCollapsed = useCallback(
    (next: boolean) => {
      setInternalCollapsed((previous) => (previous === next ? previous : next));
      onCollapsedChange?.(next);
    },
    [onCollapsedChange],
  );

  useDockLayoutEffect(() => {
    if (collapsedProp === undefined) {
      return;
    }
    if (collapsedProp) {
      dockPanelRef.current?.collapse();
      setMaximized(false);
    } else {
      dockPanelRef.current?.resize(`${lastExpandedSizeRef.current}%`);
    }
  }, [collapsedProp, dockPanelRef]);

  // Treat the narrow overlay like a real modal: remember the external opener,
  // move focus into the selected tab, and restore it on close. The standalone
  // desktop dock instead focuses its newly-visible reopen rail after collapse.
  useEffect(() => {
    const previous = previousCollapsedRef.current;
    previousCollapsedRef.current = collapsed;
    if (previous === collapsed) return;

    if (!collapsed) {
      const active = document.activeElement;
      const workspaceSurface = rootRef.current?.querySelector<HTMLElement>(
        narrow ? '[role="dialog"]' : "[data-workspace-surface]",
      );
      if (active instanceof HTMLElement && !workspaceSurface?.contains(active)) {
        returnFocusRef.current = active;
      }
      if (narrow) {
        const frame = requestAnimationFrame(() => {
          rootRef.current
            ?.querySelector<HTMLElement>('[role="dialog"] [role="tab"][aria-selected="true"]')
            ?.focus();
        });
        return () => cancelAnimationFrame(frame);
      }
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (!hostControlled) {
        reopenRef.current?.focus();
        return;
      }
      const target = returnFocusRef.current;
      if (target?.isConnected) {
        target.focus();
        return;
      }
      // A controlled desktop dock can be restored open on the initial render,
      // so there may be no opener to remember. Never leave focus parked on the
      // now-hidden workspace chrome; fall back to the host's primary surface.
      rootRef.current
        ?.querySelector<HTMLElement>(
          '[data-workspace-primary] button:not([disabled]), [data-workspace-primary] a[href], [data-workspace-primary] input:not([disabled]), [data-workspace-primary] textarea:not([disabled]), [data-workspace-primary] select:not([disabled]), [data-workspace-primary] [tabindex]:not([tabindex="-1"])',
        )
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed, hostControlled, narrow]);

  // On the first narrow render there is no collapsed-state transition to drive
  // focus into the modal: the overlay can already be open at mount. Place focus
  // on its selected tab once, just as we do when an existing overlay is opened.
  useEffect(() => {
    if (!narrow || collapsed || initialNarrowFocusRef.current) return;
    initialNarrowFocusRef.current = true;
    const active = document.activeElement;
    const workspaceSurface = rootRef.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (active instanceof HTMLElement && !workspaceSurface?.contains(active)) {
      returnFocusRef.current = active;
    }
    const frame = requestAnimationFrame(() => {
      workspaceSurface?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed, narrow]);

  // Keep the active tab valid if the available tabs change.
  useEffect(() => {
    if (firstTabId && !requestedTabIsValid) {
      setTab(firstTabId);
    }
    // Depend on tab identity, not the tab content objects. Session live events
    // rebuild tab JSX frequently; only id changes can invalidate the active tab.
  }, [firstTabId, requestedTabIsValid, setTab]);

  const collapse = useCallback(() => {
    dockPanelRef.current?.collapse();
    setCollapsed(true);
  }, [dockPanelRef, setCollapsed]);
  const expand = useCallback(() => {
    dockPanelRef.current?.expand();
    setCollapsed(false);
  }, [dockPanelRef, setCollapsed]);

  // Esc restores from maximize (desktop) and closes the mobile overlay. Tab is
  // fenced inside either full-screen surface: both visually cover the host, so
  // keyboard focus must never move into invisible content behind them.
  useEffect(() => {
    const overlayOpen = maximized || (narrow && !collapsed);
    if (!overlayOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (maximized) setMaximized(false);
        else collapse();
        return;
      }
      if (event.key !== "Tab") return;
      const surface = rootRef.current?.querySelector<HTMLElement>(
        narrow ? '[role="dialog"]' : "[data-workspace-surface]",
      );
      if (!surface) return;
      const focusable = Array.from(surface.querySelectorAll<HTMLElement>("*")).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.hasAttribute("disabled") &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        surface.focus();
        return;
      }
      if (!surface.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if ((event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      // Focus can emerge from a shadow-DOM editor/highlighter host at a point
      // the light-DOM order cannot predict. Repair any escape after the browser
      // performs its default Tab move.
      requestAnimationFrame(() => {
        const next = document.activeElement;
        if (!surface.contains(next)) (event.shiftKey ? last : first).focus();
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized, narrow, collapsed, collapse]);

  // Below the breakpoint the dock is a full-screen overlay, not a resizable
  // column: primary goes full-width and no splitter ever mounts. The overlay is
  // driven by the same `collapsed` contract (collapsed → hidden).
  if (narrow) {
    return (
      <div ref={rootRef} className={cn("relative flex h-full min-h-0 w-full min-w-0", className)}>
        <div
          data-workspace-primary
          aria-hidden={!collapsed ? true : undefined}
          className="min-h-0 min-w-0 flex-1"
          inert={!collapsed ? true : undefined}
        >
          {primary}
        </div>
        <div
          data-workspace-surface
          role="dialog"
          aria-modal="true"
          aria-label="Workspace"
          className="fixed inset-0 z-40 flex flex-col bg-og-bg"
          hidden={collapsed}
          style={{
            // Author utility classes can override the user-agent `[hidden]`
            // rule (for example this surface's `flex` class). Keep an inline
            // display guard so a collapsed mobile workspace is actually gone
            // visually as well as from the accessibility tree.
            display: collapsed ? "none" : undefined,
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          <DockChrome
            tabs={tabs}
            current={current}
            onTab={setTab}
            leading={mobileLeadingControl}
            accessory={headerAccessory}
            controls={
              <ChromeButton onClick={collapse} title="Hide workspace" label="Hide workspace">
                <XIcon className="size-4" />
              </ChromeButton>
            }
          />
        </div>
        {collapsed && !hostControlled ? (
          <button
            ref={reopenRef}
            type="button"
            onClick={expand}
            title="Open workspace"
            aria-label="Open workspace"
            className="absolute right-3 top-3 z-30 inline-flex size-11 items-center justify-center rounded-og-md border border-og-border bg-og-surface-1 text-og-fg-muted shadow-lg transition-colors hover:border-og-border-strong hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent"
            style={{ marginTop: "env(safe-area-inset-top)" }}
          >
            <ChevronsLeftRightIcon className="size-4" aria-hidden />
          </button>
        ) : null}
      </div>
    );
  }

  const dockChrome = (
    <DockChrome
      tabs={tabs}
      current={current}
      onTab={setTab}
      accessory={headerAccessory}
      controls={
        <>
          <ChromeButton
            onClick={() => setMaximized((m) => !m)}
            title={maximized ? "Restore (Esc)" : "Maximize"}
            label={maximized ? "Restore dock" : "Maximize dock"}
          >
            {maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </ChromeButton>
          {hostControlled && !showCollapseControl ? null : (
            <ChromeButton onClick={collapse} title="Hide workspace" label="Hide workspace">
              <PanelRightCloseIcon className="size-3.5" />
            </ChromeButton>
          )}
        </>
      }
    />
  );

  return (
    <div ref={rootRef} className={cn("relative flex h-full min-h-0 w-full min-w-0", className)}>
      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        {...(expandedDefaultLayout ? { defaultLayout: expandedDefaultLayout } : {})}
        onLayoutChanged={persistExpandedLayout}
      >
        <Panel id="primary" minSize="30%" className="min-h-0 min-w-0">
          <div
            data-workspace-primary
            aria-hidden={maximized ? true : undefined}
            className="h-full min-h-0 min-w-0"
            inert={maximized ? true : undefined}
          >
            {primary}
          </div>
        </Panel>

        {!collapsed && (
          <Separator className="group relative z-10 w-1.5 shrink-0 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-og-accent max-[1023px]:-mx-[19px] max-[1023px]:w-11 pointer-coarse:-mx-[19px] pointer-coarse:w-11">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-og-border transition-colors group-hover:bg-og-accent group-focus-visible:bg-og-accent group-data-[separator-state=dragging]:bg-og-accent" />
          </Separator>
        )}

        <Panel
          id="dock"
          panelRef={dockPanelRef}
          collapsible
          collapsedSize="0%"
          defaultSize={`${defaultSize}%`}
          minSize={`${minSize}%`}
          maxSize={`${maxSize}%`}
          onResize={(size, _id, previousSize) => {
            // `asPercentage` is 0..100; treat a near-zero panel as collapsed.
            const isCollapsed = size.asPercentage <= 1;
            const canInferCollapse = collapsedProp === undefined || previousSize !== undefined;
            if (canInferCollapse && isCollapsed !== collapsed) {
              setCollapsed(isCollapsed);
            }
          }}
          className="min-h-0 min-w-0"
        >
          {/* One persistent mount across normal, collapsed, and maximized modes:
              layout changes must never destroy an editor buffer or terminal view. */}
          <div
            data-workspace-surface
            role={maximized ? "dialog" : undefined}
            aria-modal={maximized ? true : undefined}
            aria-label={maximized ? "Workspace" : undefined}
            aria-hidden={collapsed ? true : undefined}
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col bg-og-bg",
              maximized ? "fixed inset-0 z-40" : "border-l border-og-border",
              collapsed && "invisible pointer-events-none",
            )}
          >
            {dockChrome}
          </div>
        </Panel>
      </Group>

      {/* Collapsed rail: the standalone fallback re-open affordance. Hidden
          when the host controls collapse — its header remains the stable way in. */}
      {collapsed && !maximized && !hostControlled && (
        <button
          ref={reopenRef}
          type="button"
          onClick={expand}
          title="Open workspace"
          className="absolute inset-y-0 right-0 flex w-6 shrink-0 items-center justify-center border-l border-og-border bg-og-surface-1 text-og-fg-subtle hover:text-og-fg"
        >
          <ChevronsLeftRightIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** A dock-chrome control button — compact on fine pointers, ≥40px on coarse. */
function ChromeButton({
  onClick,
  title,
  label,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded-og-sm p-1 transition-colors hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:size-11 pointer-coarse:size-11"
    >
      {children}
    </button>
  );
}

function DockChrome({
  tabs,
  current,
  onTab,
  leading,
  accessory,
  controls,
}: {
  tabs: WorkspaceTab[];
  current: string;
  onTab: (id: string) => void;
  /** Host navigation at the start of mobile overlay chrome. */
  leading?: ReactNode | undefined;
  /** A status accessory (machine chip) between the tab strip and the controls. */
  accessory?: ReactNode | undefined;
  /** Right-aligned chrome controls (maximize / collapse, or the overlay close). */
  controls: ReactNode;
}) {
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  const tabsetId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set());
  const activeId = active?.id ?? "";

  // Dock width, not viewport width, chooses rail density. A narrow split keeps
  // the icon-first activity rail usable without stealing the panel's content
  // width; overlays and maximized views retain readable labels.
  useDockLayoutEffect(() => {
    const node = chromeRef.current;
    if (!node) return;
    const update = () => {
      const desktop =
        typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 1024px)").matches;
      const next = desktop && node.getBoundingClientRect().width < 440;
      setCompact((previous) => (previous === next ? previous : next));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setVisitedTabs((previous) => {
      if (previous.has(activeId)) return previous;
      const next = new Set(previous);
      next.add(activeId);
      return next;
    });
  }, [activeId]);

  const activateTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) {
      return;
    }
    onTab(tab.id);
    tabRefs.current[index]?.focus();
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (tabs.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(nextIndex);
  };

  return (
    <div
      ref={chromeRef}
      data-dock-chrome
      data-compact={compact ? "true" : undefined}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-og-border px-2 max-[1023px]:min-h-12">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {leading ?? (
            <span className="hidden truncate text-og-sm font-semibold text-og-fg max-[1023px]:inline">
              Workspace
            </span>
          )}
        </div>
        <div className="min-w-0 shrink text-og-fg-muted">{accessory}</div>
        <div className="flex shrink-0 items-center gap-0.5 text-og-fg-subtle">{controls}</div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={cn(
            "flex shrink-0 flex-col gap-1 overflow-x-hidden overflow-y-auto border-r border-og-border bg-og-surface-1/45 p-1.5",
            compact ? "w-12" : "w-32 max-[1023px]:w-36",
          )}
          role="tablist"
          aria-label="Workspace panels"
          aria-orientation="vertical"
        >
          {tabs.map((tab, index) => {
            const tabName = tab.ariaLabel ?? (typeof tab.label === "string" ? tab.label : tab.id);
            return (
              <button
                key={tab.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                id={`${tabsetId}-tab-${index}`}
                type="button"
                role="tab"
                aria-label={compact && tab.icon ? tabName : undefined}
                title={compact && tab.icon ? tabName : undefined}
                aria-selected={tab.id === current}
                aria-controls={`${tabsetId}-panel-${index}`}
                tabIndex={tab.id === current ? 0 : -1}
                onClick={() => onTab(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                className={cn(
                  "group relative flex min-h-9 w-full items-center gap-2 rounded-og-md px-2 text-left text-og-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 pointer-coarse:min-h-11",
                  compact && "justify-center px-1",
                  tab.id === current
                    ? "bg-og-accent-soft text-og-fg shadow-[inset_2px_0_0_var(--og-color-accent)]"
                    : "text-og-fg-subtle hover:bg-og-surface-2 hover:text-og-fg",
                )}
              >
                {tab.icon ? (
                  <span
                    className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4"
                    aria-hidden
                  >
                    {tab.icon}
                  </span>
                ) : null}
                {!compact || !tab.icon ? (
                  <span data-contrast-audited className="min-w-0 flex-1 truncate">
                    {tab.label}
                  </span>
                ) : null}
                {tab.badge ? (
                  <span
                    className={cn("shrink-0", compact && "absolute -right-0.5 -top-0.5 scale-90")}
                  >
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {tabs.length > 0 ? (
            tabs.map((tab, index) => {
              const selected = tab.id === activeId;
              const shouldMount = selected || visitedTabs.has(tab.id);
              return (
                <div
                  key={tab.id}
                  id={`${tabsetId}-panel-${index}`}
                  aria-labelledby={`${tabsetId}-tab-${index}`}
                  className="h-full min-h-0 min-w-0 overflow-hidden"
                  hidden={!selected}
                  role="tabpanel"
                >
                  {shouldMount ? tab.content : null}
                </div>
              );
            })
          ) : (
            <div className="h-full min-h-0 min-w-0" aria-label="Workspace" role="tabpanel" />
          )}
        </div>
      </div>
    </div>
  );
}
