import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  Clock3Icon,
  GitForkIcon,
  ListTreeIcon,
  NetworkIcon,
  PauseIcon,
  RefreshCwIcon,
  SearchIcon,
  WorkflowIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ContentPage, ContentSurface } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/common";
import { Input } from "@/components/ui/input";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { useAppContext } from "@/context";
import {
  AGENT_DIAGRAM_NODE_HEIGHT,
  AGENT_DIAGRAM_NODE_WIDTH,
  agentHasMatchingDescendants,
  buildAgentTopology,
  canStartAgentTopologyRootRead,
  countTopologyDescendants,
  filterAgentTopology,
  isActiveAgent,
  isPausedAgent,
  layoutAgentTopologyDiagram,
  limitAgentTopology,
  mergeAgentTopologySessions,
  selectAgentTopologyBranchesToLoad,
  summarizeAgentTopology,
  type AgentTopologyFilter,
  type AgentTopologyNode,
} from "@/lib/agent-topology";
import { relativeTimeLabel } from "@/lib/sessions-group";
import { cn } from "@/lib/utils";
import { OpenGeniApiError, type AgentTopologySession } from "@opengeni/sdk";

const ROOT_PAGE_LIMIT = 25;
const CHILD_PAGE_LIMIT = 100;
const MAX_LOADED_AGENTS = 200;
const MAX_RENDERED_AGENTS = 200;
const AUTO_EXPAND_CONCURRENCY = 4;

type AgentTopologyView = "outline" | "diagram";

type AgentTopologyData = {
  sessions: AgentTopologySession[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  error: Error | null;
};

type AgentTopologyBranchPage = {
  loading: boolean;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  error: Error | null;
};

const EMPTY_DATA: AgentTopologyData = {
  sessions: [],
  loading: true,
  refreshing: false,
  loadingMore: false,
  total: 0,
  hasMore: false,
  nextCursor: null,
  error: null,
};

export function AgentsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const dataGeneration = useRef(0);
  const rootRequest = useRef<symbol | null>(null);
  const branchRequests = useRef(new Map<string, symbol>());
  const [data, setData] = useState<AgentTopologyData>(EMPTY_DATA);
  const [branchPages, setBranchPages] = useState<ReadonlyMap<string, AgentTopologyBranchPage>>(
    () => new Map(),
  );
  const [filter, setFilter] = useState<AgentTopologyFilter>("active");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AgentTopologyView>("outline");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [manuallyCollapsed, setManuallyCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const refresh = useCallback(
    async (cursor?: string) => {
      const generation = dataGeneration.current;
      const loadingMore = !!cursor;
      if (!canStartAgentTopologyRootRead(rootRequest.current !== null)) return;
      const request = Symbol(loadingMore ? "root-page" : "root-refresh");
      rootRequest.current = request;
      setData((current) => ({
        ...current,
        loading: !cursor && current.sessions.length === 0,
        refreshing: !cursor && current.sessions.length > 0,
        loadingMore: loadingMore || current.loadingMore,
        error: null,
      }));
      try {
        const search = query.trim();
        const page = await context.client.listAgentTopology(workspaceId, {
          limit: ROOT_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
          ...(search ? { search } : { parentSessionId: null }),
        });
        if (generation !== dataGeneration.current || rootRequest.current !== request) return;
        setData((current) => {
          // Keep already paged roots during the 15-second first-page refresh.
          // Query/workspace changes reset the collection before starting a new
          // generation, so preserving here cannot mix different result sets.
          return {
            sessions: mergeAgentTopologySessions(
              current.sessions,
              page.sessions,
              MAX_LOADED_AGENTS,
            ),
            loading: false,
            refreshing: false,
            loadingMore: loadingMore ? false : current.loadingMore,
            total: page.total,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            error: null,
          };
        });
        if (search) {
          setExpanded(new Set());
          setBranchPages(new Map());
        }
      } catch (error) {
        if (generation !== dataGeneration.current || rootRequest.current !== request) return;
        setData((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          loadingMore: loadingMore ? false : current.loadingMore,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      } finally {
        if (rootRequest.current === request) rootRequest.current = null;
      }
    },
    [context.client, query, workspaceId],
  );

  useEffect(() => {
    dataGeneration.current += 1;
    rootRequest.current = null;
    branchRequests.current.clear();
    setData(EMPTY_DATA);
    setExpanded(new Set());
    setManuallyCollapsed(new Set());
    setBranchPages(new Map());
    const start = window.setTimeout(() => void refresh(), query.trim() ? 250 : 0);
    const interval = query.trim() ? undefined : window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(start);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [query, refresh]);

  const loadChildren = useCallback(
    async (parentSessionId: string, cursor?: string) => {
      if (branchRequests.current.has(parentSessionId)) return;
      const remaining = MAX_LOADED_AGENTS - data.sessions.length;
      if (remaining <= 0) return;
      const generation = dataGeneration.current;
      const request = Symbol(parentSessionId);
      branchRequests.current.set(parentSessionId, request);
      setBranchPages((current) =>
        new Map(current).set(parentSessionId, {
          ...(current.get(parentSessionId) ?? {
            total: 0,
            hasMore: false,
            nextCursor: null,
            error: null,
          }),
          loading: true,
          error: null,
        }),
      );
      try {
        const read = () =>
          context.client.listAgentTopology(workspaceId, {
            parentSessionId,
            limit: Math.min(remaining, CHILD_PAGE_LIMIT),
            ...(cursor ? { cursor } : {}),
          });
        const page = await readAgentTopologyWithRetry(
          read,
          () =>
            generation === dataGeneration.current &&
            branchRequests.current.get(parentSessionId) === request,
        );
        if (
          generation !== dataGeneration.current ||
          branchRequests.current.get(parentSessionId) !== request
        )
          return;
        setData((current) => {
          return {
            ...current,
            sessions: mergeAgentTopologySessions(
              current.sessions,
              page.sessions,
              MAX_LOADED_AGENTS,
            ),
          };
        });
        setBranchPages((current) =>
          new Map(current).set(parentSessionId, {
            loading: false,
            total: page.total,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            error: null,
          }),
        );
      } catch (error) {
        if (
          generation !== dataGeneration.current ||
          branchRequests.current.get(parentSessionId) !== request
        )
          return;
        setBranchPages((current) =>
          new Map(current).set(parentSessionId, {
            ...(current.get(parentSessionId) ?? {
              total: 0,
              hasMore: false,
              nextCursor: null,
            }),
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        );
      } finally {
        if (branchRequests.current.get(parentSessionId) === request) {
          branchRequests.current.delete(parentSessionId);
        }
      }
    },
    [context.client, data.sessions.length, workspaceId],
  );

  const forest = useMemo(() => buildAgentTopology(data.sessions), [data.sessions]);
  const filteredForest = useMemo(() => filterAgentTopology(forest, filter, ""), [filter, forest]);
  const limitedTopology = useMemo(
    () =>
      limitAgentTopology(filteredForest, {
        maxDepth: null,
        maxChildren: null,
        maxNodes: MAX_RENDERED_AGENTS,
      }),
    [filteredForest],
  );
  const visibleForest = limitedTopology.roots;
  const summary = useMemo(() => summarizeAgentTopology(data.sessions), [data.sessions]);
  const loadedChildrenByParent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of data.sessions) {
      if (!session.parentSessionId) continue;
      counts.set(session.parentSessionId, (counts.get(session.parentSessionId) ?? 0) + 1);
    }
    return counts;
  }, [data.sessions]);
  const collapsed = useMemo(
    () =>
      new Set(
        data.sessions
          .filter((session) => session.children.directChildren > 0 && !expanded.has(session.id))
          .map((session) => session.id),
      ),
    [data.sessions, expanded],
  );
  const toggleCollapsed = (sessionId: string) => {
    const willExpand = !expanded.has(sessionId);
    setManuallyCollapsed((current) => {
      const next = new Set(current);
      if (willExpand) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
    if (willExpand && !branchPages.has(sessionId)) void loadChildren(sessionId);
  };

  // The ordinary view opens the matching workstreams for the user. Fetches
  // remain bounded and branch-local, but descendants no longer appear absent
  // until every root is manually expanded.
  useEffect(() => {
    if (query.trim() || data.loading || data.sessions.length >= MAX_LOADED_AGENTS) return;
    const candidates: string[] = [];
    const visit = (nodes: AgentTopologyNode[]) => {
      for (const node of nodes) {
        if (
          agentHasMatchingDescendants(node.session, filter) &&
          !manuallyCollapsed.has(node.session.id)
        ) {
          candidates.push(node.session.id);
        }
        visit(node.children);
      }
    };
    visit(filteredForest);
    if (candidates.length === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const sessionId of candidates) next.add(sessionId);
      return next;
    });
    for (const sessionId of selectAgentTopologyBranchesToLoad(
      candidates,
      new Set(branchPages.keys()),
      new Set(branchRequests.current.keys()),
      AUTO_EXPAND_CONCURRENCY,
    )) {
      void loadChildren(sessionId);
    }
  }, [
    branchPages,
    data.loading,
    data.sessions.length,
    filter,
    filteredForest,
    loadChildren,
    manuallyCollapsed,
    query,
  ]);

  return (
    <ContentPage width="wide" className="gap-5" data-agent-topology>
      <PageHeader
        icon={<NetworkIcon className="size-4" />}
        title="Agents"
        description="Every visible agent workstream, connected to the agents it spawned. Open a node to inspect its session, goal, turns, and output."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={data.loading || data.refreshing}
          >
            <RefreshCwIcon className={cn("size-3.5", data.refreshing && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <section
        aria-label="Loaded agent status summary"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4"
      >
        <TopologyMetric label="Active" value={summary.active} icon={ActivityIcon} tone="running" />
        <TopologyMetric label="Running" value={summary.running} icon={BotIcon} tone="running" />
        <TopologyMetric label="Starting" value={summary.queued} icon={Clock3Icon} tone="queued" />
        <TopologyMetric
          label="Needs you"
          value={summary.attention}
          icon={CircleAlertIcon}
          tone="waiting"
        />
        <TopologyMetric label="Paused" value={summary.paused} icon={PauseIcon} tone="idle" />
        <TopologyMetric label="Failed" value={summary.failed} icon={XCircleIcon} tone="failed" />
      </section>

      <ContentSurface className="flex min-h-0 flex-1 flex-col gap-4" style={{ padding: 0 }}>
        <div className="flex min-w-0 flex-col gap-3 border-b border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <AgentViewToggle value={view} onChange={setView} />
            <div
              className="flex min-w-0 flex-wrap items-center gap-1"
              role="group"
              aria-label="Filter agents"
            >
              {(
                [
                  ["active", "Active"],
                  ["all", "All"],
                  ["attention", "Needs you"],
                  ["paused", "Paused"],
                  ["failed", "Failed"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "h-7 rounded-md px-2.5 text-xs font-medium transition-colors",
                    filter === value
                      ? "bg-fg text-bg"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="relative w-full min-w-0 max-w-56">
            <span className="sr-only">Search agents</span>
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search agents"
              className="h-8 pl-8 text-xs"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 px-3 text-xs text-fg-subtle sm:px-4">
          <span>
            Showing {limitedTopology.visibleCount.toLocaleString()} loaded agents
            {limitedTopology.hiddenCount > 0
              ? ` · ${limitedTopology.hiddenCount.toLocaleString()} summarized`
              : ""}
            {data.total > 0
              ? ` · ${data.total.toLocaleString()} ${query.trim() ? "matches" : "roots"}`
              : ""}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-status-running" />
            Updates every 15 seconds
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4">
          {data.loading ? (
            <AgentTreeSkeleton />
          ) : data.error && data.sessions.length === 0 ? (
            <EmptyState>
              <div className="flex items-center justify-between gap-3">
                <span>Couldn&apos;t load the agent topology: {data.error.message}</span>
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  Retry
                </Button>
              </div>
            </EmptyState>
          ) : visibleForest.length === 0 ? (
            <EmptyState>
              {data.sessions.length === 0
                ? "No agents have been started in this workspace yet."
                : "No agents match this view."}
            </EmptyState>
          ) : view === "outline" ? (
            <div role="tree" aria-label="Agent spawn topology" className="space-y-3">
              {visibleForest.map((node) => (
                <AgentBranch
                  key={node.session.id}
                  node={node}
                  workspaceId={workspaceId}
                  depth={0}
                  collapsed={collapsed}
                  onToggle={toggleCollapsed}
                  hiddenByParent={limitedTopology.hiddenByParent}
                  branchPages={branchPages}
                  loadedChildrenByParent={loadedChildrenByParent}
                  canLoadMore={data.sessions.length < MAX_LOADED_AGENTS}
                  onLoadMore={(parentSessionId, cursor) =>
                    void loadChildren(parentSessionId, cursor)
                  }
                />
              ))}
              {data.nextCursor && data.sessions.length < MAX_LOADED_AGENTS ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh(data.nextCursor ?? undefined)}
                  disabled={data.loading || data.refreshing || data.loadingMore}
                >
                  {data.loadingMore
                    ? "Loading more agents…"
                    : `Load more ${query.trim() ? "matches" : "agents"}`}
                </Button>
              ) : null}
            </div>
          ) : (
            <AgentDiagram
              roots={visibleForest}
              workspaceId={workspaceId}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
              hiddenByParent={limitedTopology.hiddenByParent}
            />
          )}
        </div>
      </ContentSurface>
    </ContentPage>
  );
}

function AgentViewToggle({
  value,
  onChange,
}: {
  value: AgentTopologyView;
  onChange: (view: AgentTopologyView) => void;
}) {
  return (
    <div
      className="inline-flex h-8 items-center rounded-md border border-border bg-surface-2/60 p-0.5"
      role="group"
      aria-label="Agent topology layout"
    >
      {(
        [
          ["outline", "Outline", ListTreeIcon],
          ["diagram", "Tree", WorkflowIcon],
        ] as const
      ).map(([view, label, Icon]) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          onClick={() => onChange(view)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded px-2 text-2xs font-medium transition-colors",
            value === view ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg-muted",
          )}
        >
          <Icon className="size-3" />
          {label}
        </button>
      ))}
    </div>
  );
}

function AgentDiagram({
  roots,
  workspaceId,
  collapsed,
  onToggle,
  hiddenByParent,
}: {
  roots: AgentTopologyNode[];
  workspaceId: string;
  collapsed: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
  hiddenByParent: ReadonlyMap<string, number>;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutAgentTopologyDiagram(roots, collapsed), [collapsed, roots]);
  const positions = useMemo(
    () => new Map(layout.nodes.map((item) => [item.node.session.id, item])),
    [layout.nodes],
  );
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const preferredRoot =
      layout.nodes.find((item) => item.parentId === null && isActiveAgent(item.node.session)) ??
      layout.nodes.find((item) => item.parentId === null);
    if (!container || !preferredRoot) return;
    const revealPreferredRoot = () => {
      const center = preferredRoot.x + AGENT_DIAGRAM_NODE_WIDTH / 2;
      container.scrollLeft =
        center <= container.clientWidth ? 0 : Math.max(0, center - container.clientWidth / 2);
      container.scrollTop = 0;
    };
    revealPreferredRoot();
    const observer = new ResizeObserver(revealPreferredRoot);
    observer.observe(container);
    return () => observer.disconnect();
  }, [layout]);

  return (
    <div
      ref={scrollContainerRef}
      className="overflow-auto rounded-lg border border-border bg-bg/35"
    >
      <div
        role="tree"
        aria-label="Agent decision tree"
        className="relative"
        style={{ width: layout.width, height: layout.height, minWidth: "100%" }}
      >
        <svg
          className="pointer-events-none absolute inset-0 size-full text-border"
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          {layout.nodes.map((item) => {
            if (!item.parentId) return null;
            const parent = positions.get(item.parentId);
            if (!parent) return null;
            const fromX = parent.x + AGENT_DIAGRAM_NODE_WIDTH / 2;
            const fromY = parent.y + AGENT_DIAGRAM_NODE_HEIGHT;
            const toX = item.x + AGENT_DIAGRAM_NODE_WIDTH / 2;
            const toY = item.y;
            const middleY = fromY + (toY - fromY) / 2;
            return (
              <path
                key={`${item.parentId}:${item.node.session.id}`}
                d={`M ${fromX} ${fromY} V ${middleY} H ${toX} V ${toY}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>

        {layout.nodes.map(({ node, depth, x, y }) => {
          const status = agentStatus(node.session);
          const title = node.session.title?.trim() || "Untitled agent";
          const hasChildren = node.session.children.directChildren > 0 || node.children.length > 0;
          const isCollapsed = collapsed.has(node.session.id);
          const hiddenCount = Math.max(
            hiddenByParent.get(node.session.id) ?? 0,
            node.session.children.totalDescendants - countTopologyDescendants(node),
          );
          return (
            <div
              key={node.session.id}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasChildren ? !isCollapsed : undefined}
              className={cn(
                "absolute rounded-lg border bg-surface shadow-sm transition-colors hover:border-border-strong",
                status.tone === "waiting" && "border-status-waiting/40",
                status.tone === "failed" && "border-status-failed/40",
                status.tone === "running" && "border-status-running/40",
              )}
              style={{
                left: x,
                top: y,
                width: AGENT_DIAGRAM_NODE_WIDTH,
                height: AGENT_DIAGRAM_NODE_HEIGHT,
              }}
            >
              <Link
                to="/workspaces/$workspaceId/sessions/$sessionId"
                params={{ workspaceId, sessionId: node.session.id }}
                className="flex size-full flex-col rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex min-w-0 items-center gap-2 pr-8">
                  <StatusDot tone={status.tone} pulse={status.pulse} className="size-2 shrink-0" />
                  <span className={cn("text-2xs font-medium", status.textClass)}>
                    {status.label}
                  </span>
                  {node.detached ? (
                    <span className="truncate text-2xs text-status-waiting">Detached</span>
                  ) : null}
                </div>
                <div className="mt-1 line-clamp-2 min-w-0 text-xs font-medium leading-4 text-fg">
                  {title}
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 text-2xs text-fg-subtle">
                  <span className="truncate">Depth {node.session.nestedAgentDepth}</span>
                  <span className="shrink-0">
                    {hiddenCount > 0
                      ? `+${hiddenCount.toLocaleString()} hidden`
                      : node.children.length > 0
                        ? `${node.children.length} direct`
                        : "Leaf"}
                  </span>
                </div>
              </Link>
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={isCollapsed ? `Expand ${title}` : `Collapse ${title}`}
                  onClick={() => onToggle(node.session.id)}
                  className="absolute right-2 top-2 grid size-6 place-items-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
                >
                  {isCollapsed ? (
                    <ChevronRightIcon className="size-3.5" />
                  ) : (
                    <ChevronDownIcon className="size-3.5" />
                  )}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TopologyMetric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof ActivityIcon;
  tone: StatusTone;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface/45 px-3 py-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-fg-muted">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <div className="text-lg font-semibold tabular-nums text-fg">{value.toLocaleString()}</div>
        <div className="flex items-center gap-1.5 truncate text-2xs text-fg-subtle">
          <StatusDot tone={tone} className="size-1.5" />
          {label}
        </div>
      </div>
    </div>
  );
}

function AgentBranch({
  node,
  workspaceId,
  depth,
  collapsed,
  onToggle,
  hiddenByParent,
  branchPages,
  loadedChildrenByParent,
  canLoadMore,
  onLoadMore,
}: {
  node: AgentTopologyNode;
  workspaceId: string;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
  hiddenByParent: ReadonlyMap<string, number>;
  branchPages: ReadonlyMap<string, AgentTopologyBranchPage>;
  loadedChildrenByParent: ReadonlyMap<string, number>;
  canLoadMore: boolean;
  onLoadMore: (parentSessionId: string, cursor: string) => void;
}) {
  const hasChildren = node.session.children.directChildren > 0 || node.children.length > 0;
  const isCollapsed = collapsed.has(node.session.id);
  const descendants = countTopologyDescendants(node);
  const hiddenCount = Math.max(
    hiddenByParent.get(node.session.id) ?? 0,
    node.session.children.totalDescendants - descendants,
  );
  const branchPage = branchPages.get(node.session.id);
  const status = agentStatus(node.session);
  const title = node.session.title?.trim() || "Untitled agent";
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !isCollapsed : undefined}
    >
      <div className="group/node relative flex min-w-0 items-stretch">
        {depth > 0 ? (
          <span
            className="absolute top-1/2 h-px bg-border"
            style={{ left: -12, width: 12 }}
            aria-hidden
          />
        ) : null}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-surface px-2.5 py-2 shadow-sm transition-colors",
            "hover:border-border-strong hover:bg-surface-2/40",
            status.tone === "waiting" && "border-status-waiting/40",
            status.tone === "failed" && "border-status-failed/40",
            status.tone === "running" && "border-status-running/40",
          )}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={isCollapsed ? `Expand ${title}` : `Collapse ${title}`}
              onClick={() => onToggle(node.session.id)}
              className="grid size-6 shrink-0 place-items-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              {isCollapsed ? (
                <ChevronRightIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="grid size-6 shrink-0 place-items-center opacity-50" aria-hidden>
              <span className="size-1.5 rounded-full bg-fg-subtle" />
            </span>
          )}

          <StatusDot tone={status.tone} pulse={status.pulse} className="size-2 shrink-0" />
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId, sessionId: node.session.id }}
            className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-sm font-medium text-fg">{title}</span>
              <span className={cn("shrink-0 text-2xs font-medium", status.textClass)}>
                {status.label}
              </span>
              {node.detached ? (
                <span className="shrink-0 rounded bg-status-waiting/10 px-1.5 py-0.5 text-2xs text-status-waiting">
                  {node.cycle
                    ? "Invalid lineage"
                    : node.session.ancestorPath.length > 0
                      ? "Search result"
                      : "Parent unavailable"}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
              <span>Depth {node.session.nestedAgentDepth}</span>
              <span>{relativeTimeLabel(node.session.updatedAt)}</span>
            </div>
            {node.session.ancestorPath.length > 0 ? (
              <div className="mt-1 truncate text-2xs text-fg-subtle">
                {node.session.ancestorPath
                  .map((ancestor) => ancestor.title?.trim() || "Untitled agent")
                  .join(" › ")}
              </div>
            ) : null}
          </Link>

          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            {descendants > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 text-2xs text-fg-muted">
                <GitForkIcon className="size-3" />
                {descendants} spawned
              </span>
            ) : null}
            {hiddenCount > 0 ? (
              <span className="rounded-full bg-surface-2 px-2 py-1 text-2xs text-fg-muted">
                +{hiddenCount.toLocaleString()} hidden
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {hasChildren && !isCollapsed ? (
        <div role="group" className="relative ml-6 space-y-2 border-l border-border pl-4 pt-2">
          {node.children.map((child) => (
            <AgentBranch
              key={child.session.id}
              node={child}
              workspaceId={workspaceId}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              hiddenByParent={hiddenByParent}
              branchPages={branchPages}
              loadedChildrenByParent={loadedChildrenByParent}
              canLoadMore={canLoadMore}
              onLoadMore={onLoadMore}
            />
          ))}
          {!canLoadMore ? null : branchPage?.loading ? (
            <div className="px-2 py-1 text-xs text-fg-subtle">Loading children…</div>
          ) : branchPage?.error ? (
            <button
              type="button"
              className="px-2 py-1 text-left text-xs text-status-failed hover:underline"
              onClick={() => onLoadMore(node.session.id, branchPage.nextCursor ?? "")}
            >
              Couldn&apos;t load this branch. Retry
            </button>
          ) : branchPage?.nextCursor ? (
            <button
              type="button"
              className="px-2 py-1 text-left text-xs text-fg-muted hover:text-fg hover:underline"
              onClick={() => onLoadMore(node.session.id, branchPage.nextCursor!)}
            >
              Load up to{" "}
              {Math.min(
                CHILD_PAGE_LIMIT,
                Math.max(0, branchPage.total - (loadedChildrenByParent.get(node.session.id) ?? 0)),
              ).toLocaleString()}{" "}
              more children
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

async function readAgentTopologyWithRetry<T>(
  read: () => Promise<T>,
  isCurrent: () => boolean,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const retryable =
      (error instanceof OpenGeniApiError && error.retryable) || error instanceof TypeError;
    if (!retryable || !isCurrent()) throw error;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    if (!isCurrent()) throw error;
    return await read();
  }
}

function agentStatus(session: AgentTopologySession): {
  label: string;
  tone: StatusTone;
  pulse: boolean;
  textClass: string;
} {
  if (isPausedAgent(session)) {
    const source = session.pause.source;
    const label =
      source?.kind === "workspace"
        ? "Paused by workspace"
        : source?.sessionId === session.id
          ? "Paused here"
          : "Paused by ancestor";
    return { label, tone: "idle", pulse: false, textClass: "text-fg-subtle" };
  }
  if (session.status === "running") {
    return {
      label: "Running",
      tone: "running",
      pulse: true,
      textClass: "text-status-running",
    };
  }
  if (session.status === "queued") {
    return {
      label: "Starting",
      tone: "queued",
      pulse: false,
      textClass: "text-status-queued",
    };
  }
  if (session.status === "requires_action") {
    return {
      label: "Needs you",
      tone: "waiting",
      pulse: false,
      textClass: "text-status-waiting",
    };
  }
  if (session.status === "failed") {
    return {
      label: "Failed",
      tone: "failed",
      pulse: false,
      textClass: "text-status-failed",
    };
  }
  if (session.status === "cancelled") {
    return {
      label: "Cancelled",
      tone: "cancelled",
      pulse: false,
      textClass: "text-fg-subtle",
    };
  }
  return {
    label: isActiveAgent(session) ? "Active" : "Idle",
    tone: "idle",
    pulse: false,
    textClass: "text-fg-subtle",
  };
}

function AgentTreeSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading agent topology">
      {["w-full", "w-2/3", "w-3/4"].map((width, index) => (
        <div
          key={width}
          className={cn("h-16 animate-pulse rounded-lg bg-surface-2", width, index > 0 && "ml-6")}
        />
      ))}
    </div>
  );
}

/** Public development-only visual harness for reviewing the topology without a live stack. */
export function AgentTopologyPreviewRoute() {
  const sessions = useMemo(() => previewSessions(), []);
  const fullForest = useMemo(() => buildAgentTopology(sessions), [sessions]);
  const summary = useMemo(() => summarizeAgentTopology(sessions), [sessions]);
  const [view, setView] = useState<AgentTopologyView>("outline");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const limitedTopology = useMemo(
    () =>
      limitAgentTopology(fullForest, {
        maxDepth: null,
        maxChildren: null,
        maxNodes: MAX_RENDERED_AGENTS,
      }),
    [fullForest],
  );
  const forest = limitedTopology.roots;
  const toggleCollapsed = (sessionId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };
  return (
    <div className="flex min-h-dvh bg-bg text-fg">
      <ContentPage width="wide" className="gap-5">
        <PageHeader
          icon={<NetworkIcon className="size-4" />}
          title="Agents"
          description="Every visible agent workstream, connected to the agents it spawned. This static development preview uses the same tree renderer as the workspace page."
        />
        <section
          aria-label="Agent status summary"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4"
        >
          <TopologyMetric
            label="Active"
            value={summary.active}
            icon={ActivityIcon}
            tone="running"
          />
          <TopologyMetric label="Running" value={summary.running} icon={BotIcon} tone="running" />
          <TopologyMetric label="Starting" value={summary.queued} icon={Clock3Icon} tone="queued" />
          <TopologyMetric
            label="Needs you"
            value={summary.attention}
            icon={CircleAlertIcon}
            tone="waiting"
          />
          <TopologyMetric label="Paused" value={summary.paused} icon={PauseIcon} tone="idle" />
          <TopologyMetric label="Failed" value={summary.failed} icon={XCircleIcon} tone="failed" />
        </section>
        <ContentSurface className="flex min-h-0 flex-1 flex-col gap-4" style={{ padding: 0 }}>
          <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-fg">Agent topology</h2>
              <p className="mt-0.5 text-xs text-fg-muted">
                Root agents sit at the top. Connector lines preserve every spawned branch.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-fg-subtle">
                {limitedTopology.visibleCount.toLocaleString()} shown ·{" "}
                {limitedTopology.hiddenCount.toLocaleString()} summarized
              </span>
              <AgentViewToggle value={view} onChange={setView} />
            </div>
          </div>
          {view === "outline" ? (
            <div role="tree" aria-label="Agent spawn topology" className="space-y-3 px-4 pb-4">
              {forest.map((node) => (
                <AgentBranch
                  key={node.session.id}
                  node={node}
                  workspaceId="00000000-0000-4000-8000-000000000001"
                  depth={0}
                  collapsed={collapsed}
                  onToggle={toggleCollapsed}
                  hiddenByParent={limitedTopology.hiddenByParent}
                  branchPages={new Map()}
                  loadedChildrenByParent={new Map()}
                  canLoadMore={false}
                  onLoadMore={() => {}}
                />
              ))}
            </div>
          ) : (
            <div className="px-4 pb-4">
              <AgentDiagram
                roots={forest}
                workspaceId="00000000-0000-4000-8000-000000000001"
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                hiddenByParent={limitedTopology.hiddenByParent}
              />
            </div>
          )}
        </ContentSurface>
      </ContentPage>
    </div>
  );
}

function previewSessions(): AgentTopologySession[] {
  const now = Date.now();
  const ids = {
    infrastructure: "00000000-0000-4000-8000-000000000101",
    terraform: "00000000-0000-4000-8000-000000000102",
    security: "00000000-0000-4000-8000-000000000103",
    compliance: "00000000-0000-4000-8000-000000000104",
    product: "00000000-0000-4000-8000-000000000105",
    research: "00000000-0000-4000-8000-000000000106",
    release: "00000000-0000-4000-8000-000000000107",
    launchPlan: "00000000-0000-4000-8000-000000000108",
    launchResearch: "00000000-0000-4000-8000-000000000109",
    launchCopy: "00000000-0000-4000-8000-000000000110",
    launchLegal: "00000000-0000-4000-8000-000000000111",
    launchLocales: "00000000-0000-4000-8000-000000000112",
  } as const;
  const make = (input: {
    id: string;
    parentSessionId?: string;
    title: string;
    status: AgentTopologySession["status"];
    depth: number;
    minutesAgo: number;
    model?: string;
    sandboxBackend?: string;
    paused?: boolean;
    activeTurn?: boolean;
  }): AgentTopologySession => ({
    id: input.id,
    parentSessionId: input.parentSessionId ?? null,
    title: input.title,
    titleTruncated: false,
    status: input.status,
    rootSessionId: input.parentSessionId ?? input.id,
    nestedAgentDepth: input.depth,
    ancestorPath: [],
    pause: {
      state: input.paused ? "paused" : "active",
      additionalBlockerCount: 0,
      source: input.paused
        ? {
            kind: "session",
            sessionId: input.id,
            displayName: input.title,
            displayNameTruncated: false,
          }
        : null,
    },
    children: {
      directChildren: 0,
      totalDescendants: 0,
      runningDescendants: 0,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    },
    createdAt: new Date(now - input.minutesAgo * 60_000).toISOString(),
    updatedAt: new Date(now - input.minutesAgo * 60_000).toISOString(),
  });

  const overflowAgents = Array.from({ length: 1_000 }, (_, index) =>
    make({
      id: `00000000-0000-4000-8000-${String(index + 1_000).padStart(12, "0")}`,
      parentSessionId: ids.infrastructure,
      title: `Parallel rollout check ${String(index + 1).padStart(4, "0")}`,
      status: "idle",
      depth: 1,
      minutesAgo: 40 + index,
    }),
  );

  return [
    make({
      id: ids.infrastructure,
      title: "Ship the production infrastructure rollout",
      status: "running",
      depth: 0,
      minutesAgo: 0,
      activeTurn: true,
    }),
    make({
      id: ids.terraform,
      parentSessionId: ids.infrastructure,
      title: "Apply the Terraform changes",
      status: "running",
      depth: 1,
      minutesAgo: 1,
      activeTurn: true,
    }),
    make({
      id: ids.security,
      parentSessionId: ids.infrastructure,
      title: "Review network and identity boundaries",
      status: "requires_action",
      depth: 1,
      minutesAgo: 4,
    }),
    make({
      id: ids.compliance,
      parentSessionId: ids.security,
      title: "Check policy evidence for the release",
      status: "queued",
      depth: 2,
      minutesAgo: 6,
    }),
    make({
      id: ids.product,
      title: "Prepare the customer launch brief",
      status: "idle",
      depth: 0,
      minutesAgo: 18,
      model: "gpt-5.3-codex",
    }),
    make({
      id: ids.research,
      parentSessionId: ids.product,
      title: "Collect customer proof points",
      status: "running",
      depth: 1,
      minutesAgo: 24,
      paused: true,
      sandboxBackend: "selfhosted",
    }),
    make({
      id: ids.release,
      parentSessionId: ids.product,
      title: "Verify release screenshots",
      status: "failed",
      depth: 1,
      minutesAgo: 31,
      model: "gpt-5.3-codex",
    }),
    make({
      id: ids.launchPlan,
      parentSessionId: ids.product,
      title: "Plan the launch narrative",
      status: "idle",
      depth: 1,
      minutesAgo: 32,
    }),
    make({
      id: ids.launchResearch,
      parentSessionId: ids.launchPlan,
      title: "Research audience segments",
      status: "idle",
      depth: 2,
      minutesAgo: 33,
    }),
    make({
      id: ids.launchCopy,
      parentSessionId: ids.launchResearch,
      title: "Draft segment-specific copy",
      status: "idle",
      depth: 3,
      minutesAgo: 34,
    }),
    make({
      id: ids.launchLegal,
      parentSessionId: ids.launchCopy,
      title: "Review regional claims",
      status: "idle",
      depth: 4,
      minutesAgo: 35,
    }),
    make({
      id: ids.launchLocales,
      parentSessionId: ids.launchLegal,
      title: "Prepare localized variants",
      status: "idle",
      depth: 5,
      minutesAgo: 36,
    }),
    ...overflowAgents,
  ];
}
