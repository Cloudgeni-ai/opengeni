import { type ReactNode, useCallback, useEffect, useLayoutEffect, useState } from "react";
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
} from "react-resizable-panels";
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
  autoSaveId = "og.session.dock",
  defaultSize = 34,
  minSize = 22,
  maxSize = 70,
  className,
}: WorkspaceDockProps) {
  const narrow = useIsNarrow(DOCK_OVERLAY_BREAKPOINT);
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

  // Persisted layout (width split) keyed by autoSaveId.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    panelIds: ["primary", "dock"],
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    id: autoSaveId,
  } as Parameters<typeof useDefaultLayout>[0]);

  const current = activeTab ?? internalTab;
  const tabIds = tabs.map((tab) => tab.id).join("\u0000");
  const firstTabId = tabs[0]?.id ?? "";
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

  // Keep the active tab valid if the available tabs change.
  useEffect(() => {
    if (firstTabId && !tabs.some((t) => t.id === current)) {
      setTab(firstTabId);
    }
    // Depend on tab identity, not the tab content objects. Session live events
    // rebuild tab JSX frequently; only id changes can invalidate the active tab.
  }, [tabIds, firstTabId, current, setTab]);

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
      <div className={cn("relative flex h-full min-h-0 w-full min-w-0", className)}>
        <div className="min-h-0 min-w-0 flex-1">{primary}</div>
        {!collapsed && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Workspace"
            className="fixed inset-0 z-40 flex flex-col bg-og-bg"
            style={{
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            <DockChrome
              tabs={tabs}
              current={current}
              onTab={setTab}
              controls={
                <ChromeButton onClick={collapse} title="Close workspace" label="Close workspace">
                  <XIcon className="size-4" />
                </ChromeButton>
              }
            />
          </div>
        )}
      </div>
    );
  }

  const dockChrome = (
    <DockChrome
      tabs={tabs}
      current={current}
      onTab={setTab}
      controls={
        <>
          <ChromeButton
            onClick={() => setMaximized((m) => !m)}
            title={maximized ? "Restore (Esc)" : "Maximize"}
            label={maximized ? "Restore dock" : "Maximize dock"}
          >
            {maximized ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
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
    <div className={cn("relative flex h-full min-h-0 w-full min-w-0", className)}>
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
          {/* Hidden behind the overlay while maximized (avoids double-mounting
              the surfaces). */}
          {!collapsed && !maximized && (
            <div className="flex h-full min-h-0 min-w-0 flex-col border-l border-og-border bg-og-bg">
              {dockChrome}
            </div>
          )}
        </Panel>
      </Group>

      {/* Collapsed rail: the standalone fallback re-open affordance. Hidden
          when the host controls collapse — its own toggle is the one way in. */}
      {collapsed && !maximized && !hostControlled && (
        <button
          type="button"
          onClick={expand}
          title="Open workspace"
          className="absolute inset-y-0 right-0 flex w-6 shrink-0 items-center justify-center border-l border-og-border bg-og-surface-1 text-og-fg-subtle hover:text-og-fg"
        >
          <ChevronsLeftRightIcon className="size-3.5" />
        </button>
      )}

      {/* Maximize overlay: full-workspace surface above everything. */}
      {maximized && (
        <div className="fixed inset-0 z-40 flex flex-col bg-og-bg">
          {dockChrome}
        </div>
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
      className="inline-flex items-center justify-center rounded-og-sm p-1 transition-colors hover:bg-og-surface-2 hover:text-og-fg pointer-coarse:size-10"
    >
      {children}
    </button>
  );
}

function DockChrome({
  tabs,
  current,
  onTab,
  controls,
}: {
  tabs: WorkspaceTab[];
  current: string;
  onTab: (id: string) => void;
  /** Right-aligned chrome controls (maximize / collapse, or the overlay close). */
  controls: ReactNode;
}) {
  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-og-border px-1.5 py-1">
        {/* The tab list scrolls horizontally when it can't fit — it must never
            grow into or overlap the chrome controls (they stay shrink-0). The
            scrollbar is hidden to keep the strip calm. */}
        <div
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === current}
              onClick={() => onTab(tab.id)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-og-sm px-2 py-1 text-og-xs font-medium transition-colors pointer-coarse:min-h-10",
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
        <div className="flex shrink-0 items-center gap-0.5 text-og-fg-subtle">{controls}</div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden" role="tabpanel">
        {active?.content}
      </div>
    </>
  );
}
