import type { ConsoleReviewLevel, ConsoleSessionSummary, ConsoleWorkspace } from "@opengeni/sdk";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { LockIcon, MessagesSquareIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { StatusBadge } from "@opengeni/react/ui/status-badge";
import { Toolbar, ToolbarSearch } from "@opengeni/react/ui/toolbar";

import type { ConsoleSessionsSearch } from "@/lib/console-route";
import {
  ConsoleLoadError,
  ConsolePage,
  endUserLabel,
  formatCount,
  formatMicros,
  isReviewOff,
  useConsole,
  useConsoleQuery,
} from "./console-shared";

const PAGE_SIZE = 50;
const ALL = "all";

type SessionsState = {
  key: string;
  reviewLevel: ConsoleReviewLevel | null;
  sessions: ConsoleSessionSummary[];
  nextCursor: string | null;
  loading: boolean;
  error: unknown;
};

/** Words for a session's state, only when it needs a look ("Idle" and "Completed" say nothing). */
export function sessionStatus(status: string) {
  switch (status) {
    case "running":
    case "queued":
    case "recovering":
    case "waiting_capacity":
      return <StatusBadge variant="dot" status="running" />;
    case "failed":
      return <StatusBadge variant="dot" status="failed" />;
    case "requires_action":
      return (
        <StatusBadge variant="dot" tone="attention">
          Waiting for answer
        </StatusBadge>
      );
    default:
      return null;
  }
}

export function FeedbackCounts({ positive, negative }: { positive: number; negative: number }) {
  if (!positive && !negative) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-2.5 tabular-nums">
      {positive ? (
        <span className="inline-flex items-center gap-1" title={`${positive} positive`}>
          <ThumbsUpIcon aria-hidden="true" className="size-3.5 text-status-idle" />
          {positive}
          <span className="sr-only"> positive</span>
        </span>
      ) : null}
      {negative ? (
        <span className="inline-flex items-center gap-1" title={`${negative} negative`}>
          <ThumbsDownIcon aria-hidden="true" className="size-3.5 text-danger" />
          {negative}
          <span className="sr-only"> negative</span>
        </span>
      ) : null}
    </span>
  );
}

export function sessionTitle(
  session: Pick<ConsoleSessionSummary, "title" | "firstMessage">,
): string {
  return session.title?.trim() || session.firstMessage?.trim() || "Content hidden";
}

export function ConsoleSessionsRoute() {
  const { client, organizationId, search } = useConsole();
  const navigate = useNavigate();
  const { workspace: workspaceFilter } = useSearch({ strict: false }) as ConsoleSessionsSearch;
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const workspaces = useConsoleQuery(
    (signal) => client.listConsoleWorkspaces(organizationId, { kind: "managed", signal }),
    [client, organizationId],
  );
  const managed: ConsoleWorkspace[] = workspaces.data?.workspaces ?? [];

  const key = `${organizationId}|${workspaceFilter ?? ""}|${debounced}`;
  const [state, setState] = useState<SessionsState>({
    key: "",
    reviewLevel: null,
    sessions: [],
    nextCursor: null,
    loading: true,
    error: null,
  });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({
      ...current,
      key,
      sessions: [],
      nextCursor: null,
      loading: true,
      error: null,
    }));
    client
      .listConsoleSessions(organizationId, {
        limit: PAGE_SIZE,
        ...(workspaceFilter ? { workspaceId: workspaceFilter } : {}),
        ...(debounced ? { q: debounced } : {}),
        signal: controller.signal,
      })
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setState({
            key,
            reviewLevel: page.reviewLevel,
            sessions: page.sessions,
            nextCursor: page.nextCursor,
            loading: false,
            error: null,
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setState((current) => ({ ...current, key, loading: false, error }));
        },
      );
    return () => controller.abort();
    // `key` names every input of the first page.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, revision]);

  async function loadMore() {
    if (!state.nextCursor) return;
    const cursor = state.nextCursor;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const page = await client.listConsoleSessions(organizationId, {
        limit: PAGE_SIZE,
        cursor,
        ...(workspaceFilter ? { workspaceId: workspaceFilter } : {}),
        ...(debounced ? { q: debounced } : {}),
      });
      setState((current) =>
        current.key === key
          ? {
              ...current,
              sessions: [...current.sessions, ...page.sessions],
              nextCursor: page.nextCursor,
              loading: false,
            }
          : current,
      );
    } catch (error) {
      setState((current) =>
        current.key === key ? { ...current, loading: false, error } : current,
      );
    }
  }

  const header = (
    <PageHeader
      title="Sessions"
      icon={<MessagesSquareIcon />}
      description="What your end users asked and got back"
    />
  );

  if (state.error && isReviewOff(state.error)) {
    return (
      <ConsolePage>
        {header}
        <EmptyState
          variant="page"
          icon={<LockIcon />}
          title="Session review is off"
          description="Turn it on to read your end users' sessions."
          action={
            <Button variant="outline" asChild>
              <Link to="/console/settings" search={search}>
                Data and privacy
              </Link>
            </Button>
          }
        />
      </ConsolePage>
    );
  }

  const searchable = state.reviewLevel === "full";
  const filtered = Boolean(workspaceFilter || debounced);
  const workspaceOptions = [
    { value: ALL, label: "All workspaces" },
    ...managed.map((workspace) => ({ value: workspace.id, label: workspace.name })),
  ];

  return (
    <ConsolePage>
      {header}
      {searchable || managed.length > 1 || workspaceFilter ? (
        <Toolbar>
          {searchable ? (
            <ToolbarSearch
              value={query}
              onValueChange={setQuery}
              placeholder="Search questions and titles"
              aria-label="Search sessions"
              wrapperClassName="min-w-56 flex-1"
            />
          ) : null}
          {managed.length > 1 || workspaceFilter ? (
            <SelectMenu
              aria-label="Workspace"
              options={workspaceOptions}
              value={workspaceFilter ?? ALL}
              onValueChange={(next) =>
                void navigate({
                  to: "/console/sessions",
                  search: { ...search, ...(next === ALL ? {} : { workspace: next }) },
                })
              }
              className="w-56"
              align="end"
            />
          ) : null}
        </Toolbar>
      ) : null}
      {state.error && state.sessions.length === 0 ? (
        <ConsoleLoadError error={state.error} onRetry={() => setRevision((value) => value + 1)} />
      ) : state.loading && state.sessions.length === 0 ? (
        <ListRowSkeleton count={6} />
      ) : state.sessions.length === 0 ? (
        <EmptyState
          variant="page"
          icon={<MessagesSquareIcon />}
          title={filtered ? "No sessions match" : "No sessions yet"}
          description={
            filtered
              ? "Try another search or workspace."
              : "Sessions appear here once your end users chat in a managed workspace."
          }
        />
      ) : (
        <>
          <RowList
            variant="table"
            label="Sessions"
            nameLabel="Session"
            columns={[
              { id: "workspace", label: "Workspace", width: 132 },
              { id: "user", label: "End user", width: 120 },
              { id: "feedback", label: "Feedback", width: 88 },
              { id: "turns", label: "Turns", width: 56, align: "end" },
              { id: "cost", label: "Cost", width: 72, align: "end", leadsWhenFolded: true },
              { id: "updated", label: "Updated", width: 104, align: "end" },
            ]}
          >
            {state.sessions.map((session) => (
              <ListRow
                key={session.id}
                title={sessionTitle(session)}
                status={sessionStatus(session.status)}
                cells={{
                  workspace: session.workspaceName,
                  user: endUserLabel(session.endUser),
                  feedback: (
                    <FeedbackCounts
                      positive={session.feedback.positive}
                      negative={session.feedback.negative}
                    />
                  ),
                  turns: formatCount(session.turns),
                  cost: formatMicros(session.costMicros),
                  updated: <RelativeTime date={session.updatedAt} />,
                }}
                onOpen={() =>
                  void navigate({
                    to: "/console/sessions/$workspaceId/$sessionId",
                    params: { workspaceId: session.workspaceId, sessionId: session.id },
                    search,
                  })
                }
              />
            ))}
          </RowList>
          {state.error ? (
            <ConsoleLoadError error={state.error} onRetry={() => void loadMore()} />
          ) : state.nextCursor ? (
            <div className="flex justify-center">
              <Button variant="outline" disabled={state.loading} onClick={() => void loadMore()}>
                {state.loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ConsolePage>
  );
}
