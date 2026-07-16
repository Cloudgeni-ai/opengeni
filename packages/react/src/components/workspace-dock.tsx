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
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { cn } from "../lib/cn";

export type WorkspaceTab = {
  id: string;
  label: ReactNode;
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
  /** A status accessory pinned to the right of the tab strip, left of the
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
  const dockPanelRef = usePanelRef();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [internalTab, setInternalTab] = useState(tabs[0]?.id ?? "");
  const collapsed = collapsedProp ?? internalCollapsed;
  // When the host supplies `collapsed` it owns the open/close affordance (e.g.
  // the app header's panel toggle) — the dock must not offer a SECOND
  // open/close control (duplicate buttons with near-identical icons read as a
  // bug). Standalone (uncontrolled) usage keeps the built-in collapse button
  // and the thin re-open rail as its only affordances.
  const hostControlled = collapsedProp !== undefined;
  const previousCollapsedRef = useRef(collapsed);

  // Persisted layout (width split) keyed by autoSaveId.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    panelIds: ["primary", "dock"],
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    id: autoSaveId,
  } as Parameters<typeof useDefaultLayout>[0]);

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
      dockPanelRef.current?.expand();
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
      if (target?.isConnected) target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed, hostControlled, narrow]);

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

  // Esc restores from maximize (desktop) and closes the mobile overlay.
  useEffect(() => {
    const overlayOpen = maximized || (narrow && !collapsed);
    if (!overlayOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (maximized) setMaximized(false);
      else collapse();
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
        <div className="min-h-0 min-w-0 flex-1">{primary}</div>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Workspace"
          className="fixed inset-0 z-40 flex flex-col bg-og-bg"
          hidden={collapsed}
          style={{
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
              <ChromeButton onClick={collapse} title="Close workspace" label="Close workspace">
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
            className="absolute right-3 top-3 z-30 inline-flex size-11 items-center justify-center rounded-og-md border border-og-border bg-og-surface-1 text-og-fg-muted shadow-lg transition-colors hover:border-og-border-strong hover:text-og-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent"
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
          {hostControlled ? null : (
            <ChromeButton onClick={collapse} title="Collapse" label="Collapse dock">
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
        {...(defaultLayout ? { defaultLayout } : {})}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="primary" minSize="30%" className="min-h-0 min-w-0">
          {primary}
        </Panel>

        {!collapsed && (
          <Separator className="group relative w-1.5 shrink-0 outline-none">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-og-border transition-colors group-hover:bg-og-accent group-data-[separator-state=dragging]:bg-og-accent" />
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
          when the host controls collapse — its own toggle is the one way in. */}
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
      className="inline-flex size-7 items-center justify-center rounded-og-sm p-1 transition-colors hover:bg-og-surface-2 hover:text-og-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:size-11 pointer-coarse:size-11"
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
  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  const tabsetId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set());
  const activeId = active?.id ?? "";

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
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    activateTab(nextIndex);
  };

  return (
    <>
      <div className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 border-b border-og-border px-1.5 py-1 max-[1023px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[1023px]:gap-y-0 max-[1023px]:px-2 max-[1023px]:pb-1 max-[1023px]:pt-0">
        <div className="flex min-w-0 shrink-0 items-center max-[1023px]:min-h-11">
          {leading ?? (
            <span className="hidden truncate px-1 text-og-sm font-semibold text-og-fg max-[1023px]:inline">
              Workspace
            </span>
          )}
        </div>
        {/* The tab list scrolls horizontally when it can't fit — it must never
            grow into or overlap the chrome controls (they stay shrink-0). The
            scrollbar is hidden to keep the strip calm. On the narrow overlay it
            owns a full second row, so status/close chrome can never squeeze the
            canonical workspace navigation out of view. */}
        <div
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[1023px]:col-span-3 max-[1023px]:row-start-2 max-[1023px]:w-full"
          role="tablist"
          aria-orientation="horizontal"
        >
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={`${tabsetId}-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={tab.id === current}
              aria-controls={`${tabsetId}-panel-${index}`}
              tabIndex={tab.id === current ? 0 : -1}
              onClick={() => onTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={cn(
                "flex min-h-7 shrink-0 items-center justify-center gap-1 rounded-og-sm px-2 py-1 text-og-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-og-accent max-[1023px]:min-h-11 max-[1023px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
                tab.id === current
                  ? "bg-og-accent-soft text-og-fg"
                  : "text-og-fg-subtle hover:text-og-fg",
              )}
            >
              <span>{tab.label}</span>
              {tab.badge}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 shrink-0 items-center justify-self-end">{accessory}</div>
        <div className="flex shrink-0 items-center gap-0.5 text-og-fg-subtle">{controls}</div>
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
    </>
  );
}
