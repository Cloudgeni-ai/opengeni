import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronsLeftRightIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
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
 */
export function WorkspaceDock({
  primary,
  tabs,
  activeTab,
  onActiveTabChange,
  autoSaveId = "og.session.dock",
  defaultSize = 34,
  minSize = 22,
  maxSize = 70,
  className,
}: WorkspaceDockProps) {
  const dockPanelRef = usePanelRef();
  const [collapsed, setCollapsed] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [internalTab, setInternalTab] = useState(tabs[0]?.id ?? "");

  // Persisted layout (width split) keyed by autoSaveId.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    panelIds: ["primary", "dock"],
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
    id: autoSaveId,
  } as Parameters<typeof useDefaultLayout>[0]);

  const current = activeTab ?? internalTab;
  const setTab = useCallback(
    (id: string) => {
      setInternalTab(id);
      onActiveTabChange?.(id);
    },
    [onActiveTabChange],
  );

  // Keep the active tab valid if the available tabs change.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((t) => t.id === current)) {
      setTab(tabs[0]!.id);
    }
  }, [tabs, current, setTab]);

  // Esc restores from maximize.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const collapse = useCallback(() => {
    dockPanelRef.current?.collapse();
    setCollapsed(true);
  }, [dockPanelRef]);
  const expand = useCallback(() => {
    dockPanelRef.current?.expand();
    setCollapsed(false);
  }, [dockPanelRef]);

  const dockChrome = (
    <DockChrome
      tabs={tabs}
      current={current}
      onTab={setTab}
      maximized={maximized}
      onToggleMaximize={() => setMaximized((m) => !m)}
      onCollapse={maximized ? () => setMaximized(false) : collapse}
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
        <Panel id="primary" minSize={30} className="min-h-0 min-w-0">
          {primary}
        </Panel>

        {!collapsed && (
          <Separator className="group relative w-1.5 shrink-0 outline-none">
            <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[color:var(--og-color-border,var(--color-border,#2a2a2a))] transition-colors group-hover:bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] group-data-[separator-state=dragging]:bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]" />
          </Separator>
        )}

        <Panel
          id="dock"
          panelRef={dockPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize={defaultSize}
          minSize={minSize}
          maxSize={maxSize}
          onResize={(size) => {
            const isCollapsed = size.asPercentage <= 0.5;
            setCollapsed((prev) => (prev !== isCollapsed ? isCollapsed : prev));
          }}
          className="min-h-0 min-w-0"
        >
          {/* Hidden behind the overlay while maximized (avoids double-mounting
              the surfaces). */}
          {!maximized && (
            <div className="flex h-full min-h-0 min-w-0 flex-col border-l border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-bg,var(--color-bg,#0d0d0d))]">
              {dockChrome}
            </div>
          )}
        </Panel>
      </Group>

      {/* Collapsed rail: a thin tab on the right edge that re-opens the dock. */}
      {collapsed && !maximized && (
        <button
          type="button"
          onClick={expand}
          title="Open workspace"
          className="absolute inset-y-0 right-0 flex w-6 shrink-0 items-center justify-center border-l border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-surface-1,var(--color-surface,#161616))] text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
        >
          <ChevronsLeftRightIcon className="size-3.5" />
        </button>
      )}

      {/* Maximize overlay: full-workspace surface above everything. */}
      {maximized && (
        <div className="fixed inset-0 z-40 flex flex-col bg-[color:var(--og-color-bg,var(--color-bg,#0d0d0d))]">
          {dockChrome}
        </div>
      )}
    </div>
  );
}

function DockChrome({
  tabs,
  current,
  onTab,
  maximized,
  onToggleMaximize,
  onCollapse,
}: {
  tabs: WorkspaceTab[];
  current: string;
  onTab: (id: string) => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  onCollapse: () => void;
}) {
  const active = tabs.find((t) => t.id === current) ?? tabs[0];
  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] px-1.5 py-1">
        <div className="flex min-w-0 items-center gap-0.5" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === current}
              onClick={() => onTab(tab.id)}
              className={cn(
                "flex items-center gap-1 rounded-[var(--og-radius-sm,4px)] px-2 py-1 text-[11px] font-medium transition-colors",
                tab.id === current
                  ? "bg-[color:var(--og-color-accent-soft,var(--color-surface-2,#222))] text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
                  : "text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]",
              )}
            >
              <span className="truncate">{tab.label}</span>
              {tab.badge}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
          <button
            type="button"
            onClick={onToggleMaximize}
            title={maximized ? "Restore (Esc)" : "Maximize"}
            className="rounded-[var(--og-radius-sm,4px)] p-1 hover:bg-[color:var(--og-color-surface-2,var(--color-surface-2,#222))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
          >
            {maximized ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onCollapse}
            title={maximized ? "Restore" : "Collapse"}
            className="rounded-[var(--og-radius-sm,4px)] p-1 hover:bg-[color:var(--og-color-surface-2,var(--color-surface-2,#222))] hover:text-[color:var(--og-color-fg,var(--color-fg,#e6e6e6))]"
          >
            <PanelRightCloseIcon className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden" role="tabpanel">
        {active?.content}
      </div>
    </>
  );
}
