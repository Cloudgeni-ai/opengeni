import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ListTreeIcon,
  NetworkIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { RelatedWorkAdvisory } from "@/components/related-work-advisory";
import { errorParts } from "@/components/variable-sets/variable-set-model";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime, RelativeTimeDefaultsContext } from "@/components/ui/relative-time";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type ProductStatus } from "@/components/ui/status-badge";
import type { SemanticTone } from "@/components/ui/status-dot";
import { Toolbar, ToolbarGroup, ToolbarSearch } from "@/components/ui/toolbar";
import { useAppContext } from "@/context";
import {
  AGENT_DIAGRAM_NODE_HEIGHT,
  LIVE_AGENT_STATUSES,
  RECENT_FAILURE_HOURS,
  agentHasMatchingDescendants,
  buildAgentTopology,
  canStartAgentTopologyRootRead,
  filterAgentTopology,
  isActiveAgent,
  isPausedAgent,
  layoutAgentTopologyDiagram,
  limitAgentTopology,
  mergeAgentTopologySessions,
  normalizeAgentTopologySessions,
  selectAgentTopologyBranchesToLoad,
  staleLiveRootIds,
  summarizeAgentTopology,
  withoutAgentTopologyRoots,
  type AgentTopologyFilter,
  type AgentTopologyNode,
  type AgentTopologySummary,
} from "@/lib/agent-topology";
import { sessionStatusLabel } from "@/lib/session-rail";
import { cn } from "@/lib/utils";
import { OpenGeniApiError, type AgentTopologySession } from "@opengeni/sdk";

const ROOT_PAGE_LIMIT = 25;
/** Live and recently failed workstreams are read on their own, so an older one is never missed. */
const LIVE_ROOT_LIMIT = 100;
const CHILD_PAGE_LIMIT = 100;
const MAX_LOADED_AGENTS = 200;
const MAX_RENDERED_AGENTS = 200;
const AUTO_EXPAND_CONCURRENCY = 4;
const REFRESH_MS = 15_000;
/** Visible branches re-read per refresh, so spawned agents' states stay current too. */
const BRANCH_REFRESH_PER_TICK = 6;
/** Indentation per level of spawned agents in the outline. */
const OUTLINE_INDENT = 24;
/** Row padding; the list bleeds out by the same amount so titles align with the header. */
const ROW_INSET = 12;

type AgentTopologyView = "outline" | "diagram";

type AgentTopologyData = {
  sessions: AgentTopologySession[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  humanAdvisoriesEnabled: boolean;
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
  humanAdvisoriesEnabled: true,
  error: null,
};

const FILTER_OPTIONS: { value: AgentTopologyFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "attention", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
];

const VIEW_OPTIONS: {
  value: AgentTopologyView;
  label: string;
  icon: ReactNode;
  iconOnly: true;
}[] = [
  {
    value: "outline",
    label: "Outline",
    icon: <ListTreeIcon />,
    iconOnly: true,
  },
  { value: "diagram", label: "Tree", icon: <NetworkIcon />, iconOnly: true },
];

export function AgentsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const dataGeneration = useRef(0);
  const rootRequest = useRef<symbol | null>(null);
  const branchRequests = useRef(new Map<string, symbol>());
  /** Roots loaded only because they are live or recently failed. */
  const liveOnlyRoots = useRef(new Set<string>());
  /** Roots loaded through "Load more", which stay until the page is left. */
  const pagedRoots = useRef(new Set<string>());
  const branchCursor = useRef(0);
  const [data, setData] = useState<AgentTopologyData>(EMPTY_DATA);
  const [branchPages, setBranchPages] = useState<ReadonlyMap<string, AgentTopologyBranchPage>>(
    () => new Map(),
  );
  const [filter, setFilter] = useState<AgentTopologyFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<AgentTopologyView>("outline");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [manuallyCollapsed, setManuallyCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // The numbers describe the workspace, not a search, so they keep the last
  // browse reading while a search is on.
  const [summary, setSummary] = useState<AgentTopologySummary | null>(null);
  const searching = query.trim().length > 0;

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
        const readLive = !search && !cursor;
        const [page, live, failed] = await Promise.all([
          context.client.listAgentTopology(workspaceId, {
            limit: ROOT_PAGE_LIMIT,
            ...(cursor ? { cursor } : {}),
            ...(search ? { search } : { parentSessionId: null }),
          }),
          readLive
            ? context.client.listAgentTopology(workspaceId, {
                parentSessionId: null,
                statuses: [...LIVE_AGENT_STATUSES, "requires_action"],
                limit: LIVE_ROOT_LIMIT,
              })
            : null,
          readLive
            ? context.client.listAgentTopology(workspaceId, {
                parentSessionId: null,
                statuses: ["failed"],
                recentHours: RECENT_FAILURE_HOURS,
                limit: LIVE_ROOT_LIMIT,
              })
            : null,
        ]);
        if (generation !== dataGeneration.current || rootRequest.current !== request) return;
        const pageIds = page.sessions.map((session) => session.id);
        if (cursor) for (const id of pageIds) pagedRoots.current.add(id);
        let stale = new Set<string>();
        const liveSessions = live && failed ? [...live.sessions, ...failed.sessions] : [];
        if (live && failed) {
          const nextLiveOnly = new Set(
            liveSessions.map((session) => session.id).filter((id) => !pageIds.includes(id)),
          );
          stale = staleLiveRootIds(
            liveOnlyRoots.current,
            new Set([...pageIds, ...nextLiveOnly]),
            pagedRoots.current,
          );
          liveOnlyRoots.current = nextLiveOnly;
        }
        setData((current) => {
          // Keep already paged roots during the first-page refresh. Query and
          // workspace changes reset the collection before starting a new
          // generation, so preserving here cannot mix different result sets.
          // A root that was here only because it was live, and no longer is,
          // leaves with its loaded branch: its last state would be stale.
          return {
            sessions: mergeAgentTopologySessions(
              withoutAgentTopologyRoots(current.sessions, stale),
              normalizeAgentTopologySessions([...page.sessions, ...liveSessions]),
              MAX_LOADED_AGENTS,
            ),
            loading: false,
            refreshing: false,
            loadingMore: loadingMore ? false : current.loadingMore,
            total: page.total,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            humanAdvisoriesEnabled: page.humanAdvisoriesEnabled !== false,
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
    setSummary(null);
    setFilter("all");
  }, [workspaceId]);

  const loadChildren = useCallback(
    async (parentSessionId: string, cursor?: string, quiet = false) => {
      if (branchRequests.current.has(parentSessionId)) return;
      const remaining = MAX_LOADED_AGENTS - data.sessions.length;
      if (!quiet && remaining <= 0) return;
      const generation = dataGeneration.current;
      const request = Symbol(parentSessionId);
      branchRequests.current.set(parentSessionId, request);
      if (!quiet) {
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
      }
      try {
        const read = () =>
          context.client.listAgentTopology(workspaceId, {
            parentSessionId,
            limit: quiet ? CHILD_PAGE_LIMIT : Math.min(remaining, CHILD_PAGE_LIMIT),
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
        setData((current) => ({
          ...current,
          sessions: mergeAgentTopologySessions(
            current.sessions,
            normalizeAgentTopologySessions(page.sessions),
            MAX_LOADED_AGENTS,
          ),
        }));
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
          quiet ||
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

  // One timer re-reads the first page, the live workstreams and a few open
  // branches. The latest state is read through a ref so the timer is not
  // restarted on every render.
  const tick = useRef<() => void>(() => {});
  useEffect(() => {
    tick.current = () => {
      void refresh();
      const open = [...branchPages.entries()]
        .filter(([id, page]) => !page.loading && !page.error && expanded.has(id))
        .map(([id]) => id);
      if (open.length === 0) return;
      const start = branchCursor.current % open.length;
      const batch = [...open.slice(start), ...open.slice(0, start)].slice(
        0,
        BRANCH_REFRESH_PER_TICK,
      );
      branchCursor.current = start + batch.length;
      for (const id of batch) void loadChildren(id, undefined, true);
    };
  });

  useEffect(() => {
    dataGeneration.current += 1;
    rootRequest.current = null;
    branchRequests.current.clear();
    liveOnlyRoots.current = new Set();
    pagedRoots.current = new Set();
    setData(EMPTY_DATA);
    setExpanded(new Set());
    setManuallyCollapsed(new Set());
    setBranchPages(new Map());
    const search = query.trim();
    const start = window.setTimeout(() => void refresh(), search ? 250 : 0);
    const interval = search ? undefined : window.setInterval(() => tick.current(), REFRESH_MS);
    return () => {
      window.clearTimeout(start);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [query, refresh]);

  // A branch whose parent left the collection must load again if it returns.
  useEffect(() => {
    setBranchPages((current) => {
      const ids = new Set(data.sessions.map((session) => session.id));
      let changed = false;
      const next = new Map<string, AgentTopologyBranchPage>();
      for (const [id, page] of current) {
        if (ids.has(id)) next.set(id, page);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [data.sessions]);

  useEffect(() => {
    if (searching || data.loading || (data.error && data.sessions.length === 0)) return;
    setSummary(summarizeAgentTopology(data.sessions));
  }, [data.error, data.loading, data.sessions, searching]);

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

  // Branches with work the current view is about open by themselves. Fetches
  // stay bounded and branch-local; quiet trees stay folded until opened.
  useEffect(() => {
    if (searching || data.loading || data.sessions.length >= MAX_LOADED_AGENTS) return;
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
      if (candidates.every((id) => current.has(id))) return current;
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
    searching,
  ]);

  const nothingAtAll = !searching && !data.loading && !data.error && data.sessions.length === 0;
  // Nothing to count or filter until the first read succeeds.
  const loadFailed = !data.loading && data.error !== null && data.sessions.length === 0;
  const bare = nothingAtAll || (loadFailed && !searching);
  const branchFooter = (node: AgentTopologyNode): BranchFooter | null => {
    if (data.sessions.length >= MAX_LOADED_AGENTS) return null;
    const page = branchPages.get(node.session.id);
    if (page?.loading) return { kind: "loading" };
    if (page?.error) {
      return {
        kind: "error",
        onRetry: () => void loadChildren(node.session.id),
      };
    }
    if (page?.nextCursor) {
      const cursor = page.nextCursor;
      const more = Math.min(
        CHILD_PAGE_LIMIT,
        Math.max(0, page.total - (loadedChildrenByParent.get(node.session.id) ?? 0)),
      );
      return {
        kind: "more",
        count: more,
        onLoad: () => void loadChildren(node.session.id, cursor),
      };
    }
    return null;
  };

  let body: ReactNode;
  if (data.loading) {
    body = <AgentOutlineSkeleton />;
  } else if (data.error && data.sessions.length === 0) {
    const parts = errorParts(data.error);
    body = (
      <ErrorMessage
        variant="block"
        align="center"
        title="Couldn't load agents"
        reference={parts.reference}
        details={[
          ...(parts.status ? [{ label: "Status", value: String(parts.status) }] : []),
          { label: "Message", value: parts.message },
        ]}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            Try again
          </Button>
        }
      >
        Check your connection, then try again.
      </ErrorMessage>
    );
  } else if (nothingAtAll) {
    body = (
      <EmptyState
        variant="page"
        icon={<BotIcon />}
        title="No agents yet"
        description="Every session you start is an agent. The agents it spawns show up underneath it."
        action={
          <Button asChild>
            <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId }}>
              Start a session
            </Link>
          </Button>
        }
      />
    );
  } else if (visibleForest.length === 0) {
    body = (
      <FilteredEmpty
        filter={filter}
        query={query.trim()}
        onShowAll={() => setFilter("all")}
        onClearSearch={() => setQuery("")}
      />
    );
  } else {
    body = (
      <>
        {view === "outline" ? (
          <AgentOutline
            roots={visibleForest}
            workspaceId={workspaceId}
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            hiddenByParent={limitedTopology.hiddenByParent}
            branchFooter={branchFooter}
            advisoriesEnabled={data.humanAdvisoriesEnabled}
          />
        ) : (
          <AgentDiagram
            roots={visibleForest}
            workspaceId={workspaceId}
            collapsed={collapsed}
            onToggle={toggleCollapsed}
          />
        )}
        {limitedTopology.hiddenCount > 0 ? (
          <p className="mt-3 text-xs leading-4.5 text-fg-subtle">
            Showing the first {limitedTopology.visibleCount.toLocaleString()} agents. Search or pick
            a view to see the rest.
          </p>
        ) : null}
        {data.nextCursor && data.sessions.length < MAX_LOADED_AGENTS ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4 self-start pointer-coarse:h-11"
            onClick={() => void refresh(data.nextCursor ?? undefined)}
            disabled={data.loading || data.refreshing || data.loadingMore}
          >
            {data.loadingMore ? "Loading…" : searching ? "More matches" : "More agents"}
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <ContentPage width="standard" data-agent-topology>
      <PageHeader
        title="Agents"
        description={
          bare ? undefined : (
            <AgentSummaryLine summary={summary} filter={filter} onFilterChange={setFilter} />
          )
        }
      />
      {bare ? null : (
        <Toolbar>
          <ToolbarSearch value={query} onValueChange={setQuery} placeholder="Search agents" />
          <ToolbarGroup align="end">
            <SegmentedControl<AgentTopologyFilter>
              aria-label="Show"
              options={FILTER_OPTIONS}
              value={filter}
              onValueChange={setFilter}
            />
            <SegmentedControl<AgentTopologyView>
              aria-label="Layout"
              options={VIEW_OPTIONS}
              value={view}
              onValueChange={setView}
            />
          </ToolbarGroup>
        </Toolbar>
      )}
      {data.error && data.sessions.length > 0 ? (
        <ErrorMessage
          variant="inline"
          className="mt-4"
          title="Couldn't refresh agents."
          action={
            <EmptyStateLink onClick={() => void refresh()} className="text-sm">
              Try again
            </EmptyStateLink>
          }
        >
          What you see may be out of date.
        </ErrorMessage>
      ) : null}
      <div className={cn("flex min-w-0 flex-col", bare ? "" : "mt-4")}>{body}</div>
    </ContentPage>
  );
}

/* ----------------------------------------------------------------------------
   Header summary: at most three numbers, each one a way into its view.
   -------------------------------------------------------------------------- */

function AgentSummaryLine({
  summary,
  filter,
  onFilterChange,
}: {
  summary: AgentTopologySummary | null;
  filter: AgentTopologyFilter;
  onFilterChange: (filter: AgentTopologyFilter) => void;
}) {
  if (!summary) {
    return (
      <span aria-hidden="true" className="inline-flex h-5 items-center">
        <span className="inline-block h-3 w-56 rounded-full bg-surface-2 motion-safe:animate-pulse" />
      </span>
    );
  }
  const count = (value: number) => `${value.toLocaleString()}${summary.capped ? "+" : ""}`;
  const parts: { key: string; node: ReactNode }[] = [];
  const part = (value: AgentTopologyFilter, text: ReactNode) => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() => onFilterChange(filter === value ? "all" : value)}
      className={cn(
        "relative -mx-1 rounded-[6px] px-1 text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg",
        "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2",
        filter === value && "bg-selection text-fg hover:bg-selection",
      )}
    >
      {text}
    </button>
  );
  const number = (value: number) => (
    <span className="font-medium text-fg tabular-nums">{count(value)}</span>
  );
  if (summary.attention > 0) {
    parts.push({
      key: "attention",
      node: part(
        "attention",
        <>
          {number(summary.attention)} {summary.attention === 1 ? "needs" : "need"} you
        </>,
      ),
    });
  } else {
    parts.push({ key: "attention", node: <span>Nothing needs you</span> });
  }
  if (summary.running > 0) {
    parts.push({
      key: "running",
      node: part("running", <>{number(summary.running)} running</>),
    });
  }
  if (summary.failed > 0) {
    parts.push({
      key: "failed",
      node: part("failed", <>{number(summary.failed)} failed in the last day</>),
    });
  }
  return (
    <span data-agent-summary className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {parts.map((item, index) => (
        <span key={item.key} className="inline-flex items-center gap-x-2">
          {index > 0 ? (
            <span aria-hidden="true" className="text-fg-subtle">
              ·
            </span>
          ) : null}
          {item.node}
        </span>
      ))}
    </span>
  );
}

function FilteredEmpty({
  filter,
  query,
  onShowAll,
  onClearSearch,
}: {
  filter: AgentTopologyFilter;
  query: string;
  onShowAll: () => void;
  onClearSearch: () => void;
}) {
  if (query && filter === "all") {
    return (
      <EmptyState
        variant="inline"
        title={`No agents match "${query}".`}
        action={<EmptyStateLink onClick={onClearSearch}>Clear search</EmptyStateLink>}
      />
    );
  }
  const title = query
    ? `No agents match "${query}" in this view.`
    : filter === "attention"
      ? "Nothing needs you right now."
      : filter === "running"
        ? "No agents are running."
        : filter === "failed"
          ? "No workstreams failed in the last day."
          : "No agents to show.";
  return (
    <EmptyState
      variant="inline"
      title={title}
      action={
        filter === "all" ? undefined : <EmptyStateLink onClick={onShowAll}>Show all</EmptyStateLink>
      }
    />
  );
}

/* ----------------------------------------------------------------------------
   Row facts shared by the outline and the tree.
   -------------------------------------------------------------------------- */

type AgentRowStatus = {
  status?: ProductStatus;
  tone?: SemanticTone;
  label: string;
  pulse?: boolean;
};

/** The one status a row shows. Idle and cancelled agents show none. */
export function agentRowStatus(session: AgentTopologySession): AgentRowStatus | null {
  if (isPausedAgent(session)) return { status: "paused", label: "Paused" };
  switch (session.status) {
    case "requires_action":
      return { status: "needs_you", label: "Needs you" };
    case "failed":
      return { status: "failed", label: "Failed" };
    case "queued":
      return { status: "queued", label: sessionStatusLabel("queued") };
    case "running":
    case "recovering":
      return {
        tone: "progress",
        label: sessionStatusLabel(session.status),
        pulse: true,
      };
    case "waiting_capacity":
      return {
        tone: "progress",
        label: sessionStatusLabel("waiting_capacity"),
      };
    default:
      return null;
  }
}

function RowStatus({ value, className }: { value: AgentRowStatus; className?: string }) {
  return (
    <StatusBadge
      variant="dot"
      status={value.status}
      tone={value.tone}
      pulse={value.pulse}
      className={className}
    >
      {value.label}
    </StatusBadge>
  );
}

function agentTitle(session: Pick<AgentTopologySession, "title">): string {
  return session.title?.trim() || "Untitled agent";
}

function spawnedLabel(node: AgentTopologyNode): string | null {
  const count = Math.max(node.session.children.directChildren, node.children.length);
  if (count === 0) return null;
  return `${count.toLocaleString()} spawned ${count === 1 ? "agent" : "agents"}`;
}

/** Quiet facts for the meta line, most useful first. */
function agentMeta(node: AgentTopologyNode, hiddenCount: number): string[] {
  const session = node.session;
  const meta: string[] = [];
  if (isPausedAgent(session) && session.pause.source) {
    const source = session.pause.source;
    if (source.kind === "workspace") meta.push("Workspace paused");
    else if (source.sessionId !== session.id) meta.push(`Paused by ${source.displayName}`);
  }
  if (session.status === "cancelled" && !isPausedAgent(session)) meta.push("Cancelled");
  if (node.detached) {
    if (node.cycle) meta.push("Invalid lineage");
    else if (session.ancestorPath.length > 0) {
      meta.push(`In ${session.ancestorPath.map((ancestor) => agentTitle(ancestor)).join(" › ")}`);
    } else meta.push("Parent unavailable");
  }
  if (hiddenCount > 0) meta.push(`${hiddenCount.toLocaleString()} more not shown`);
  return meta;
}

/** Spawned agents left out by the render cap (not the ones a filter hides). */
function hiddenBelow(node: AgentTopologyNode, hiddenByParent: ReadonlyMap<string, number>) {
  return hiddenByParent.get(node.session.id) ?? 0;
}

/**
 * A quiet disclosure in a meta line: "3 spawned agents" folds the branch,
 * "Possible related work" shows the evidence under the row.
 */
function MetaToggle({
  label,
  title,
  open,
  onToggle,
  controls,
  className,
}: {
  label: string;
  /** The row's title, for screen readers: "3 spawned agents from <title>". */
  title: string;
  open: boolean;
  onToggle: () => void;
  controls?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className={cn(
        "relative z-10 -mx-1 inline-flex h-5 shrink-0 items-center gap-0.5 rounded-[6px] px-1 text-xs leading-4.5 text-fg-muted transition-colors duration-[120ms] hover:bg-surface-3 hover:text-fg",
        "pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:top-1/2 pointer-coarse:after:h-11 pointer-coarse:after:-translate-y-1/2",
        className,
      )}
    >
      {label}
      <span className="sr-only"> from {title}</span>
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          "size-3.5 transition-transform duration-[120ms] motion-reduce:transition-none",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

/* ----------------------------------------------------------------------------
   Outline: one flat divided list. Spawned agents sit indented under the agent
   that spawned them, joined by thin guides.
   -------------------------------------------------------------------------- */

type BranchFooter =
  | { kind: "loading" }
  | { kind: "error"; onRetry: () => void }
  | { kind: "more"; count: number; onLoad: () => void };

type OutlineRow =
  | {
      kind: "agent";
      node: AgentTopologyNode;
      parentTitle: string | null;
      depth: number;
      guides: boolean[];
      last: boolean;
      open: boolean;
      hasChildren: boolean;
    }
  | {
      kind: "footer";
      key: string;
      footer: BranchFooter;
      depth: number;
      guides: boolean[];
      last: true;
    };

function flattenOutline(
  roots: AgentTopologyNode[],
  collapsed: ReadonlySet<string>,
  branchFooter: (node: AgentTopologyNode) => BranchFooter | null,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visit = (
    node: AgentTopologyNode,
    parentTitle: string | null,
    depth: number,
    guides: boolean[],
    last: boolean,
  ) => {
    const hasChildren = node.session.children.directChildren > 0 || node.children.length > 0;
    const open = hasChildren && !collapsed.has(node.session.id);
    rows.push({
      kind: "agent",
      node,
      parentTitle,
      depth,
      guides,
      last,
      open,
      hasChildren,
    });
    if (!open) return;
    const footer = branchFooter(node);
    // A child's guide columns: every ancestor level below the root that still
    // has siblings further down keeps its line running.
    const childGuides = depth === 0 ? [] : [...guides, !last];
    const title = agentTitle(node.session);
    node.children.forEach((child, index) =>
      visit(child, title, depth + 1, childGuides, index === node.children.length - 1 && !footer),
    );
    if (footer) {
      rows.push({
        kind: "footer",
        key: `${node.session.id}:footer`,
        footer,
        depth: depth + 1,
        guides: childGuides,
        last: true,
      });
    }
  };
  roots.forEach((root) => visit(root, null, 0, [], true));
  return rows;
}

/** Guide lines for one row: continuing ancestor lines, then this row's elbow. */
function OutlineGuides({
  depth,
  guides,
  last,
  middle,
}: {
  depth: number;
  guides: boolean[];
  last: boolean;
  /** Where the elbow meets the row: half the row height. */
  middle: number;
}) {
  if (depth === 0) return null;
  const x = (column: number) => ROW_INSET + column * OUTLINE_INDENT + 6;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0">
      {guides.map((continues, column) =>
        continues ? (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- columns are positional
            key={column}
            className="absolute inset-y-0 w-px bg-border"
            style={{ left: x(column) }}
          />
        ) : null,
      )}
      <span
        className={cn("absolute top-0 w-px bg-border", !last && "h-full")}
        style={{ left: x(depth - 1), ...(last ? { height: middle } : {}) }}
      />
      <span
        className="absolute h-px bg-border"
        style={{ left: x(depth - 1), top: middle, width: OUTLINE_INDENT - 10 }}
      />
    </span>
  );
}

function AgentOutline({
  roots,
  workspaceId,
  collapsed,
  onToggle,
  hiddenByParent,
  branchFooter,
  advisoriesEnabled,
}: {
  roots: AgentTopologyNode[];
  workspaceId: string;
  collapsed: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
  hiddenByParent: ReadonlyMap<string, number>;
  branchFooter: (node: AgentTopologyNode) => BranchFooter | null;
  advisoriesEnabled: boolean;
}) {
  const rows = flattenOutline(roots, collapsed, branchFooter);
  return (
    <RelativeTimeDefaultsContext.Provider value={ROW_TIME_DEFAULTS}>
      <div className="@container/agents -mx-3 min-w-0">
        <ul aria-label="Agents" className="m-0 min-w-0 list-none p-0">
          {rows.map((row, index) => {
            const indent = ROW_INSET + row.depth * OUTLINE_INDENT;
            const hairline =
              index > 0 ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 right-3 h-px bg-border"
                  style={{ left: indent }}
                />
              ) : null;
            if (row.kind === "footer") {
              return (
                <li key={row.key} aria-level={row.depth + 1} className="relative">
                  <div
                    className="flex h-10 items-center text-xs leading-4.5"
                    style={{ paddingLeft: indent }}
                  >
                    <OutlineFooter footer={row.footer} />
                  </div>
                  {hairline}
                  <OutlineGuides depth={row.depth} guides={row.guides} last middle={20} />
                </li>
              );
            }
            return (
              <AgentOutlineRow
                key={row.node.session.id}
                row={row}
                indent={indent}
                hairline={hairline}
                workspaceId={workspaceId}
                hiddenCount={hiddenBelow(row.node, hiddenByParent)}
                advisoriesEnabled={advisoriesEnabled}
                onToggle={onToggle}
              />
            );
          })}
        </ul>
      </div>
    </RelativeTimeDefaultsContext.Provider>
  );
}

const ROW_TIME_DEFAULTS = { focusable: false };

function OutlineFooter({ footer }: { footer: BranchFooter }) {
  if (footer.kind === "loading") return <span className="text-fg-subtle">Loading…</span>;
  if (footer.kind === "error") {
    return (
      <span className="text-fg-muted">
        Couldn&apos;t load these agents.{" "}
        <button
          type="button"
          onClick={footer.onRetry}
          className="rounded-[6px] font-medium text-brand underline-offset-4 hover:underline pointer-coarse:min-h-11"
        >
          Try again
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={footer.onLoad}
      className="rounded-[6px] font-medium text-brand underline-offset-4 hover:underline pointer-coarse:min-h-11"
    >
      Show {footer.count > 0 ? `${footer.count.toLocaleString()} more` : "more"}
    </button>
  );
}

function AgentOutlineRow({
  row,
  indent,
  hairline,
  workspaceId,
  hiddenCount,
  advisoriesEnabled,
  onToggle,
}: {
  row: Extract<OutlineRow, { kind: "agent" }>;
  indent: number;
  hairline: ReactNode;
  workspaceId: string;
  hiddenCount: number;
  advisoriesEnabled: boolean;
  onToggle: (sessionId: string) => void;
}) {
  const { node } = row;
  const session = node.session;
  const title = agentTitle(session);
  const status = agentRowStatus(session);
  const spawned = row.hasChildren ? spawnedLabel(node) : null;
  const meta = agentMeta(node, row.open ? hiddenCount : 0);
  const evidenceId = useId();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const related = session.relatedWork;
  const evidence =
    advisoriesEnabled && (related.match !== null || related.claims.length > 0)
      ? related.possibleOverlap
        ? "Possible related work"
        : "Current work evidence"
      : null;
  return (
    <li aria-level={row.depth + 1} className="relative" data-agent-row={session.id}>
      <div
        className={cn(
          "group/row relative isolate flex h-14 min-w-0 items-center gap-3 rounded-[10px] pr-3 transition-colors duration-[120ms] hover:bg-surface-2",
          "has-[[data-row-action]:focus-visible]:outline-2 has-[[data-row-action]:focus-visible]:-outline-offset-2 has-[[data-row-action]:focus-visible]:outline-brand/55",
        )}
        style={{ paddingLeft: indent } as CSSProperties}
      >
        <div className="min-w-0 flex-1">
          <Link
            to="/workspaces/$workspaceId/sessions/$sessionId"
            params={{ workspaceId, sessionId: session.id }}
            data-row-action=""
            style={{ outline: "none" }}
            className="block min-w-0 truncate text-sm leading-5 font-medium text-fg after:absolute after:inset-0 after:content-['']"
          >
            {title}
            {row.parentTitle ? (
              <span className="sr-only">, spawned by {row.parentTitle}</span>
            ) : null}
          </Link>
          {spawned || evidence || meta.length > 0 || status ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs leading-4.5 text-fg-subtle">
              {status ? <RowStatus value={status} className="@[480px]/agents:hidden" /> : null}
              {spawned ? (
                <MetaToggle
                  label={spawned}
                  title={title}
                  open={row.open}
                  onToggle={() => onToggle(session.id)}
                />
              ) : null}
              {evidence ? (
                <MetaToggle
                  label={evidence}
                  title={title}
                  open={evidenceOpen}
                  onToggle={() => setEvidenceOpen((open) => !open)}
                  controls={evidenceId}
                />
              ) : null}
              {meta.length > 0 ? (
                <span className="min-w-0 truncate">
                  {spawned || evidence ? (
                    <span aria-hidden="true" className="mr-2">
                      ·
                    </span>
                  ) : null}
                  {meta.join(" · ")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {status ? (
          <RowStatus value={status} className="relative z-10 hidden @[480px]/agents:inline-flex" />
        ) : null}
        <RelativeTime
          date={session.updatedAt}
          className="relative z-10 shrink-0 text-xs leading-4.5 text-fg-subtle"
        />
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
      </div>
      {hairline}
      {evidenceOpen ? (
        <div id={evidenceId} className="pr-3 pb-3" style={{ paddingLeft: indent }}>
          <RelatedWorkAdvisory projection={session.relatedWork} className="mt-0" />
        </div>
      ) : null}
      <OutlineGuides depth={row.depth} guides={row.guides} last={row.last} middle={28} />
    </li>
  );
}

function AgentOutlineSkeleton() {
  return (
    <div className="-mx-3 min-w-0">
      <span role="status" className="sr-only">
        Loading agents
      </span>
      <ul aria-hidden="true" className="m-0 list-none p-0">
        {["w-2/5", "w-1/3", "w-1/2", "w-1/4", "w-3/5"].map((width, index) => (
          <li key={width} className="relative flex h-14 items-center gap-3 px-3">
            {index > 0 ? <span className="absolute inset-x-3 top-0 h-px bg-border" /> : null}
            <div className="min-w-0 flex-1">
              <Skeleton className={cn("h-3.5 rounded-full bg-surface-2", width)} />
              <Skeleton className="mt-2 h-3 w-24 rounded-full bg-surface-2" />
            </div>
            <Skeleton className="h-3 w-14 rounded-full bg-surface-2" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Tree: the same agents as a top-down diagram. One flat card per agent, thin
   connectors, no frame around the canvas.
   -------------------------------------------------------------------------- */

function AgentDiagram({
  roots,
  workspaceId,
  collapsed,
  onToggle,
}: {
  roots: AgentTopologyNode[];
  workspaceId: string;
  collapsed: ReadonlySet<string>;
  onToggle: (sessionId: string) => void;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const measure = () => {
      const style = window.getComputedStyle(container);
      const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      setAvailableWidth(Math.max(0, container.clientWidth - (padding || 0)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () => layoutAgentTopologyDiagram(roots, collapsed, availableWidth ?? undefined),
    [availableWidth, collapsed, roots],
  );
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
      const center = preferredRoot.x + layout.nodeWidth / 2;
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
    <RelativeTimeDefaultsContext.Provider value={ROW_TIME_DEFAULTS}>
      <div ref={scrollContainerRef} className="-m-1 min-w-0 overflow-auto p-1">
        <div
          className="relative"
          style={{
            width: layout.width,
            height: layout.height,
            minWidth: "100%",
          }}
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
              const fromX = parent.x + layout.nodeWidth / 2;
              const fromY = parent.y + AGENT_DIAGRAM_NODE_HEIGHT;
              const toX = item.x + layout.nodeWidth / 2;
              const toY = item.y;
              const middleY = fromY + (toY - fromY) / 2;
              return (
                <path
                  key={`${item.parentId}:${item.node.session.id}`}
                  d={`M ${fromX} ${fromY} V ${middleY} H ${toX} V ${toY}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                />
              );
            })}
          </svg>

          <ul aria-label="Agents" className="m-0 list-none p-0">
            {layout.nodes.map(({ node, depth, x, y }) => {
              const session = node.session;
              const status = agentRowStatus(session);
              const title = agentTitle(session);
              const spawned = spawnedLabel(node);
              const hasChildren = session.children.directChildren > 0 || node.children.length > 0;
              const open = hasChildren && !collapsed.has(session.id);
              return (
                <li
                  key={session.id}
                  aria-level={depth + 1}
                  data-agent-node={session.id}
                  className="group/node absolute isolate flex flex-col rounded-[10px] border border-border bg-surface px-3 py-2.5 transition-colors duration-[120ms] hover:border-border-strong hover:bg-surface-2 has-[[data-row-action]:focus-visible]:outline-2 has-[[data-row-action]:focus-visible]:outline-offset-2 has-[[data-row-action]:focus-visible]:outline-brand/55"
                  style={{
                    left: x,
                    top: y,
                    width: layout.nodeWidth,
                    height: AGENT_DIAGRAM_NODE_HEIGHT,
                  }}
                >
                  <Link
                    to="/workspaces/$workspaceId/sessions/$sessionId"
                    params={{ workspaceId, sessionId: session.id }}
                    data-row-action=""
                    style={{ outline: "none" }}
                    className="line-clamp-2 min-w-0 text-sm leading-5 font-medium text-fg after:absolute after:inset-0 after:rounded-[10px] after:content-['']"
                  >
                    {title}
                  </Link>
                  <div className="mt-auto flex min-w-0 items-center gap-2 text-xs leading-4.5 text-fg-subtle">
                    {status ? <RowStatus value={status} className="relative z-10 min-w-0" /> : null}
                    {!status ? (
                      <RelativeTime
                        date={session.updatedAt}
                        className="relative z-10 min-w-0 truncate"
                      />
                    ) : null}
                    {spawned ? (
                      <MetaToggle
                        label={spawned.replace(/ agents?$/u, "")}
                        title={title}
                        open={open}
                        onToggle={() => onToggle(session.id)}
                        className="ml-auto"
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </RelativeTimeDefaultsContext.Provider>
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

/* ----------------------------------------------------------------------------
   DEV-only visual harness: the same renderers over fixed data, no live stack.
   -------------------------------------------------------------------------- */

export function AgentTopologyPreviewRoute() {
  const sessions = useMemo(() => withPreviewTreeCounts(previewSessions()), []);
  const fullForest = useMemo(() => buildAgentTopology(sessions), [sessions]);
  const summary = useMemo(() => summarizeAgentTopology(sessions), [sessions]);
  const [view, setView] = useState<AgentTopologyView>("outline");
  const [filter, setFilter] = useState<AgentTopologyFilter>("all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const filtered = useMemo(() => filterAgentTopology(fullForest, filter, ""), [filter, fullForest]);
  const limitedTopology = useMemo(
    () =>
      limitAgentTopology(filtered, {
        maxDepth: null,
        maxChildren: null,
        maxNodes: MAX_RENDERED_AGENTS,
      }),
    [filtered],
  );
  const toggleCollapsed = (sessionId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  return (
    <div className="flex min-h-dvh bg-canvas text-fg">
      <ContentPage width="standard">
        <PageHeader
          title="Agents"
          description={
            <AgentSummaryLine summary={summary} filter={filter} onFilterChange={setFilter} />
          }
        />
        <Toolbar>
          <ToolbarGroup align="end">
            <SegmentedControl<AgentTopologyFilter>
              aria-label="Show"
              options={FILTER_OPTIONS}
              value={filter}
              onValueChange={setFilter}
            />
            <SegmentedControl<AgentTopologyView>
              aria-label="Layout"
              options={VIEW_OPTIONS}
              value={view}
              onValueChange={setView}
            />
          </ToolbarGroup>
        </Toolbar>
        <div className="mt-4 flex min-w-0 flex-col">
          {view === "outline" ? (
            <AgentOutline
              roots={limitedTopology.roots}
              workspaceId={workspaceId}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
              hiddenByParent={limitedTopology.hiddenByParent}
              branchFooter={() => null}
              advisoriesEnabled
            />
          ) : (
            <AgentDiagram
              roots={limitedTopology.roots}
              workspaceId={workspaceId}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
            />
          )}
        </div>
      </ContentPage>
    </div>
  );
}

/** What the server reports for each subtree, computed from the fixed preview data. */
function withPreviewTreeCounts(sessions: AgentTopologySession[]): AgentTopologySession[] {
  const byParent = new Map<string, AgentTopologySession[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    byParent.set(session.parentSessionId, [
      ...(byParent.get(session.parentSessionId) ?? []),
      session,
    ]);
  }
  const counts = (id: string): AgentTopologySession["children"] => {
    const total = {
      directChildren: byParent.get(id)?.length ?? 0,
      totalDescendants: 0,
      runningDescendants: 0,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    };
    for (const child of byParent.get(id) ?? []) {
      const below = counts(child.id);
      const paused = isPausedAgent(child);
      total.totalDescendants += 1 + below.totalDescendants;
      total.runningDescendants +=
        below.runningDescendants +
        (!paused && (child.status === "running" || child.status === "recovering") ? 1 : 0);
      total.queuedDescendants +=
        below.queuedDescendants +
        (!paused && (child.status === "queued" || child.status === "waiting_capacity") ? 1 : 0);
      total.attentionDescendants +=
        below.attentionDescendants + (child.status === "requires_action" ? 1 : 0);
      total.pausedDescendants += below.pausedDescendants + (paused ? 1 : 0);
      total.failedDescendants += below.failedDescendants + (child.status === "failed" ? 1 : 0);
    }
    return total;
  };
  return sessions.map((session) => ({ ...session, children: counts(session.id) }));
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
    relatedWork?: AgentTopologySession["relatedWork"];
  }): AgentTopologySession => ({
    id: input.id,
    parentSessionId: input.parentSessionId ?? null,
    title: input.title,
    titleTruncated: false,
    status: input.status,
    rootSessionId: input.parentSessionId ?? input.id,
    nestedAgentDepth: input.depth,
    ancestorPath: [],
    goal: null,
    relatedWork: input.relatedWork ?? {
      claims: [],
      claimsTruncated: false,
      match: null,
      possibleOverlap: false,
      advisoryOnly: true,
      noAdditionalAccess: true,
    },
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
      relatedWork: {
        claims: [
          {
            id: "00000000-0000-4000-8000-000000000201",
            sessionId: ids.security,
            subject: {
              namespace: "github",
              type: "pull_request",
              canonicalKey: "Cloudgeni-ai/opengeni#1842",
              displayLabel: "Network boundary review",
            },
            role: "reviewing",
            state: "active",
            revision: 2,
            provenance: "explicit_agent",
            version: { kind: "pull_request_head", value: "8f09c3d" },
            observedAt: new Date(now - 5 * 60_000).toISOString(),
            updatedAt: new Date(now - 4 * 60_000).toISOString(),
            settledAt: null,
          },
        ],
        claimsTruncated: false,
        match: {
          class: "exact_subject",
          field: "subject",
          scoreBand: "exact",
          claimId: "00000000-0000-4000-8000-000000000201",
        },
        possibleOverlap: true,
        advisoryOnly: true,
        noAdditionalAccess: true,
      },
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
