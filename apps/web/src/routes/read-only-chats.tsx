// Read-only chats: every chat this deployment moved to long-term storage after
// a long idle period. They stay readable (open one to read the whole
// conversation) but can't continue. Separate from the personal "Archive"
// action, so chats you archived yourself are listed here too when they are
// read-only. Reached from the session list's view menu.
import { useChannels } from "@opengeni/react";
import type { SessionListEntry } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { SelectMenu } from "@/components/ui/select-menu";
import { Toolbar, ToolbarGroup, ToolbarSearch } from "@/components/ui/toolbar";
import { useAppContext } from "@/context";
import { apiErrorFacts } from "@/lib/api-error";

type SortBy = "updatedAt" | "createdAt" | "name";
const SORT_OPTIONS: Array<{ value: SortBy; label: string }> = [
  { value: "updatedAt", label: "Last activity" },
  { value: "createdAt", label: "Created date" },
  { value: "name", label: "Name" },
];
const ALL_PROJECTS = "all";
const NO_PROJECT = "none";
const PAGE_SIZE = 50;

const COLUMNS: RowListColumn[] = [{ id: "activity", label: "Last activity", width: 112 }];

export function readOnlyChatsDescription(idleDays: number | undefined): string {
  const period = idleDays ? `${idleDays} ${idleDays === 1 ? "day" : "days"}` : "a long time";
  return `Chats with no activity for ${period} move to long-term storage. You can read them, but not continue them.`;
}

export function ReadOnlyChatsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const channelsQuery = useChannels({ pollIntervalMs: 60_000 });
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("updatedAt");
  const [project, setProject] = useState<string>(ALL_PROJECTS);
  const [rows, setRows] = useState<SessionListEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const readPage = useCallback(
    async (cursor: string | undefined) =>
      await context.client.listSessionSummaryPage(workspaceId, {
        contentArchivedOnly: true,
        // Chats you hid with Archive are still read-only chats.
        archiveStatus: "all",
        parentSessionId: null,
        includePinned: false,
        limit: PAGE_SIZE,
        sortBy,
        ...(search ? { search } : {}),
        ...(project === ALL_PROJECTS ? {} : { channelId: project === NO_PROJECT ? null : project }),
        ...(cursor ? { cursor } : {}),
      }),
    [context.client, project, search, sortBy, workspaceId],
  );

  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await readPage(undefined);
      if (generation.current !== current) return;
      setRows(page.sessions);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (generation.current !== current) return;
      setRows([]);
      setNextCursor(null);
      setError(apiErrorFacts(caught).serverMessage ?? "Something went wrong.");
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [readPage]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await readPage(nextCursor);
      if (generation.current !== current) return;
      setRows((existing) => {
        const seen = new Set(existing.map((row) => row.id));
        return [...existing, ...page.sessions.filter((row) => !seen.has(row.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (generation.current !== current) return;
      setError(apiErrorFacts(caught).serverMessage ?? "Something went wrong.");
    } finally {
      setLoadingMore(false);
    }
  };

  const channels = channelsQuery.channels;
  const projectNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name])),
    [channels],
  );
  const projectOptions = useMemo(
    () => [
      { value: ALL_PROJECTS, label: "All projects" },
      { value: NO_PROJECT, label: "No project" },
      ...channels.map((channel) => ({ value: channel.id, label: channel.name })),
    ],
    [channels],
  );
  const filtered = search.length > 0 || project !== ALL_PROJECTS;
  const idleDays = context.clientConfig.sessionArchive?.idleDays;
  const openSession = (sessionId: string) =>
    void navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId },
    });

  let body;
  if (loading && rows.length === 0) {
    body = (
      <RowList label="Read-only chats" columns={COLUMNS} flush busy>
        <ListRowSkeleton count={4} />
      </RowList>
    );
  } else if (error && rows.length === 0) {
    body = (
      <Notice
        tone="failed"
        title="Couldn't load read-only chats"
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {error}
      </Notice>
    );
  } else if (rows.length === 0) {
    body = filtered ? (
      <EmptyState
        variant="page"
        icon={<ArchiveIcon />}
        title="No read-only chats match"
        description="Try another search or project."
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSearchDraft("");
              setSearch("");
              setProject(ALL_PROJECTS);
            }}
          >
            Clear search and filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        variant="page"
        icon={<ArchiveIcon />}
        title="No read-only chats"
        description={
          idleDays
            ? `Chats with no activity for ${idleDays} ${idleDays === 1 ? "day" : "days"} will show up here.`
            : "This workspace has no chats in long-term storage."
        }
      />
    );
  } else {
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        <RowList label="Read-only chats" columns={COLUMNS} flush busy={loading}>
          {rows.map((row) => (
            <ReadOnlyChatRow
              key={row.id}
              row={row}
              projectName={row.channelId ? (projectNames.get(row.channelId) ?? null) : null}
              onOpen={() => openSession(row.id)}
            />
          ))}
        </RowList>
        {error ? (
          <Notice tone="failed" live="polite">
            Couldn't load more. {error}
          </Notice>
        ) : null}
        {nextCursor ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="pointer-coarse:h-11"
            >
              {loadingMore ? "Loading…" : "Show more"}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <ContentPage width="standard">
      <div className="min-w-0 pb-7">
        <PageHeader title="Read-only chats" description={readOnlyChatsDescription(idleDays)} />
        <div className="flex min-w-0 flex-col gap-4 pt-6">
          <Toolbar>
            <ToolbarSearch
              value={searchDraft}
              onValueChange={setSearchDraft}
              placeholder="Search read-only chats"
            />
            <ToolbarGroup>
              <SelectMenu
                aria-label="Project"
                size="md"
                value={project}
                onValueChange={setProject}
                options={projectOptions}
              />
              <SelectMenu
                aria-label="Sort by"
                size="md"
                value={sortBy}
                onValueChange={setSortBy}
                options={SORT_OPTIONS}
              />
            </ToolbarGroup>
          </Toolbar>
          {body}
        </div>
      </div>
    </ContentPage>
  );
}

function ReadOnlyChatRow({
  row,
  projectName,
  onOpen,
}: {
  row: SessionListEntry;
  projectName: string | null;
  onOpen: () => void;
}) {
  const archivedAt = row.retention?.archive?.archivedAt ?? null;
  const meta = [
    projectName,
    archivedAt ? (
      <span key="stored">
        Stored <RelativeTime date={archivedAt} inSentence />
      </span>
    ) : null,
  ].filter((part) => part !== null);
  return (
    <ListRow
      title={row.displayTitle}
      meta={meta}
      cells={{ activity: <RelativeTime date={row.updatedAt} /> }}
      indicator="open"
      onOpen={onOpen}
    />
  );
}
