import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useAppContext } from "@/context";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useConversationSearch, type ConversationSearchMatch } from "@/lib/use-conversation-search";
import { useSessionSearchResource } from "@/lib/use-session-search-resource";
import { cn } from "@/lib/utils";
import {
  SearchPreviewView,
  SearchResultsView,
  type SearchPreviewMessage,
  type SearchResultSummary,
} from "./search-results-view";

export default function SessionSearchDialog(props: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { onOpenChange } = props;
  const { client, accessContext } = useAppContext();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [archiveStatus, setArchiveStatus] = useState<"active" | "archived" | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [titleCursor, setTitleCursor] = useState<string | undefined>();
  const [previewIndex, setPreviewIndex] = useState(0);
  const resultScroll = useRef(0);
  const previewScroll = useRef(0);
  const identity = JSON.stringify([
    accessContext.subjectId,
    props.workspaceId,
    query,
    archiveStatus,
  ]);
  const search = useConversationSearch({
    client,
    authority: accessContext.subjectId,
    workspaceId: props.workspaceId,
    query,
    enabled: props.open,
    archiveStatus,
  });
  const loadTitles = useCallback(
    () =>
      client.listSessionPage(props.workspaceId, {
        search: query,
        archiveStatus,
        limit: 20,
        ...(titleCursor ? { cursor: titleCursor } : {}),
      }),
    [client, props.workspaceId, query, archiveStatus, titleCursor],
  );
  const titles = useSessionSearchResource(
    `${identity}:${titleCursor ?? ""}`,
    loadTitles,
    props.open && !!query.trim(),
  );
  const results = useMemo(() => {
    const grouped = new Map<string, SearchResultSummary>();
    for (const session of [...(titles.value?.pinned ?? []), ...(titles.value?.sessions ?? [])]) {
      grouped.set(session.id, {
        sessionId: session.id,
        title: session.title || "Untitled session",
        subtitle: new Date(session.updatedAt).toLocaleDateString(),
        snippet: session.initialMessage ?? "",
        matchingMessages: 0,
        titleMatch: true,
      });
    }
    const seen = new Set<string>();
    for (const match of search.page?.matches ?? []) {
      const current = grouped.get(match.sessionId);
      const firstForMessage = !seen.has(match.eventId);
      seen.add(match.eventId);
      grouped.set(match.sessionId, {
        sessionId: match.sessionId,
        title: match.sessionTitle || "Untitled session",
        subtitle: current?.subtitle ?? "Message match",
        snippet: current?.matchingMessages ? current.snippet : match.snippet.text,
        matchingMessages: (current?.matchingMessages ?? 0) + (firstForMessage ? 1 : 0),
        titleMatch: current?.titleMatch ?? false,
      });
    }
    return [...grouped.values()];
  }, [titles.value, search.page]);
  // Keep the selected session while closed/revalidating so its cursor and preview
  // survive the dialog → conversation → dialog round trip.
  const retainedSelection = useRef<{ identity: string; selected: SearchResultSummary } | null>(
    null,
  );
  const selected =
    results.find((result) => result.sessionId === selectedId) ??
    (retainedSelection.current?.identity === identity &&
    retainedSelection.current.selected.sessionId === selectedId
      ? retainedSelection.current.selected
      : null) ??
    results[0] ??
    null;
  if (selected) retainedSelection.current = { identity, selected };
  const previewSelection =
    selected ??
    (retainedSelection.current?.identity === identity ? retainedSelection.current.selected : null);
  const selectedSearch = useConversationSearch({
    client,
    authority: accessContext.subjectId,
    workspaceId: props.workspaceId,
    sessionId: previewSelection?.sessionId,
    query,
    enabled: props.open && !!previewSelection,
  });
  function changeQuery(value: string) {
    setQuery(value);
    setTitleCursor(undefined);
    setSelectedId(null);
    setMobilePreview(false);
    setPreviewIndex(0);
    resultScroll.current = 0;
    previewScroll.current = 0;
  }
  function select(id: string) {
    if (id !== selectedId) {
      setPreviewIndex(0);
      previewScroll.current = 0;
    }
    setSelectedId(id);
    setMobilePreview(true);
  }
  const onOpen = useCallback(
    (match?: ConversationSearchMatch) => {
      if (!previewSelection) return;
      onOpenChange(false);
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId: props.workspaceId, sessionId: previewSelection.sessionId },
        search: match
          ? { find: query, matchSequence: match.sequence, matchOffset: match.messageMatchOffset }
          : { find: query },
      });
    },
    [navigate, props.workspaceId, onOpenChange, previewSelection, query],
  );
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="flex h-[min(760px,85dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl sm:p-0"
        aria-describedby="session-search-description"
      >
        <div className="shrink-0 border-b border-border px-4 pb-3 pt-4 pr-12">
          <DialogTitle className="mb-3 text-base">Search sessions</DialogTitle>
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-fg-subtle"
              aria-hidden="true"
            />
            <Input
              autoFocus
              type="search"
              aria-label="Search session titles and messages"
              placeholder="Search titles and messages…"
              value={query}
              maxLength={200}
              onChange={(event) => changeQuery(event.target.value)}
              className="pl-9"
              suppressAutofill
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <DialogDescription id="session-search-description" className="flex-1 text-xs">
              Literal text in user and completed assistant messages.
            </DialogDescription>
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              Sessions
              <select
                aria-label="Search session status"
                value={archiveStatus}
                onChange={(event) => {
                  setArchiveStatus(event.target.value as typeof archiveStatus);
                  setTitleCursor(undefined);
                  setSelectedId(null);
                }}
                className="rounded-md border border-border bg-bg px-2 py-1 text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </label>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.2fr)]">
          <div
            className={cn(
              "flex min-h-0 flex-col md:border-r md:border-border",
              mobilePreview && selected ? "hidden md:flex" : "flex",
            )}
          >
            <SearchResultsView
              query={query}
              results={results}
              selectedId={selected?.sessionId ?? null}
              onSelect={select}
              loading={search.loading || titles.loading}
              error={search.error ?? titles.error}
              onRetry={() => {
                search.retry();
                titles.retry();
              }}
              hasMore={!!search.page?.hasMore}
              onMore={() => {
                resultScroll.current = 0;
                search.next();
              }}
              scrollPosition={resultScroll}
              active={props.open}
            />
            <div className="mt-auto flex shrink-0 flex-wrap gap-2 border-t border-border px-3 py-2">
              {search.pageIndex > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={search.previous}
                  disabled={search.loading}
                >
                  Previous message results
                </Button>
              ) : null}
              {titles.value?.nextCursor ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTitleCursor(titles.value?.nextCursor ?? undefined)}
                >
                  More title results
                </Button>
              ) : null}
              {search.loading ? (
                <span className="text-xs text-fg-muted" role="status">
                  Searching saved history
                  {search.scanned ? ` · ${search.scanned} messages checked` : "…"}
                </span>
              ) : search.page?.hasMore ? (
                <span className="text-xs text-fg-muted">More history available</span>
              ) : null}
            </div>
          </div>
          <div
            className={cn(
              "min-h-0 md:flex md:flex-col",
              mobilePreview && selected ? "flex flex-col" : "hidden",
            )}
          >
            {previewSelection ? (
              <SessionSearchPreview
                client={client}
                authority={accessContext.subjectId}
                workspaceId={props.workspaceId}
                sessionId={previewSelection.sessionId}
                title={previewSelection.title}
                query={query}
                enabled={props.open}
                onOpen={onOpen}
                onBack={() => setMobilePreview(false)}
                search={selectedSearch}
                index={previewIndex}
                setIndex={setPreviewIndex}
                scrollPosition={previewScroll}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-sm text-fg-subtle">
                Select a result to read it in context.
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SessionSearchPreview(props: {
  client: ReturnType<typeof useAppContext>["client"];
  authority: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  query: string;
  enabled: boolean;
  onOpen: (match?: ConversationSearchMatch) => void;
  onBack: () => void;
  search: ReturnType<typeof useConversationSearch>;
  index: number;
  setIndex: (index: number) => void;
  scrollPosition: RefObject<number>;
}) {
  const { search, setIndex } = props;
  const matches = search.page?.matches ?? [];
  // -1 means land on the last occurrence when a previous batch arrives.
  const index = props.index < 0 ? Math.max(0, matches.length - 1) : props.index;
  const match = matches[Math.min(index, Math.max(0, matches.length - 1))];
  const loadContext = useCallback(async (): Promise<SearchPreviewMessage[]> => {
    if (!match) return [];
    const options = {
      mode: "forensic" as const,
      payloadMode: "full" as const,
      includeTypes: ["user.message", "agent.message.completed"] as Array<
        "user.message" | "agent.message.completed"
      >,
      limit: 2,
    };
    const [before, after] = await Promise.all([
      props.client.listEvents(props.workspaceId, props.sessionId, {
        ...options,
        before: match.sequence,
        direction: "before",
      }),
      props.client.listEvents(props.workspaceId, props.sessionId, {
        ...options,
        after: match.sequence,
        direction: "after",
      }),
    ]);
    const context = (events: typeof before): SearchPreviewMessage[] =>
      events.flatMap((event) => {
        if (event.type !== "user.message" && event.type !== "agent.message.completed") return [];
        const payload = event.payload as Record<string, unknown>;
        if (typeof payload.text !== "string") return [];
        if (
          match.messageId &&
          event.type === "agent.message.completed" &&
          payload.messageId === match.messageId &&
          event.turnId === match.turnId
        )
          return [];
        let text = payload.text;
        if (text.length > 1800) {
          const end = /[\uD800-\uDBFF]/.test(text[1799]!) ? 1799 : 1800;
          text = `${text.slice(0, end)}…`;
        }
        return [
          {
            key: event.id,
            role: event.type === "user.message" ? ("user" as const) : ("assistant" as const),
            text,
            selected: false,
          },
        ];
      });
    return [
      ...context(before),
      { key: match.eventId, role: match.role, text: match.snippet.text, selected: true },
      ...context(after),
    ];
  }, [props.client, props.workspaceId, props.sessionId, match]);
  const preview = useSessionSearchResource(
    `${props.authority}:${props.sessionId}:${match?.eventId}:${match?.messageMatchOffset}`,
    loadContext,
    props.enabled && !!match,
    100,
  );
  const titleOnly = !!search.page && !search.page.hasMore && !matches.length;
  return (
    <SearchPreviewView
      active={props.enabled}
      title={props.title}
      query={props.query}
      messages={preview.value ?? []}
      loading={search.loading || preview.loading}
      error={search.error ?? preview.error}
      onRetry={() => {
        search.retry();
        preview.retry();
      }}
      onOpen={() => props.onOpen(match)}
      onBack={props.onBack}
      titleOnly={titleOnly}
      scrollPosition={props.scrollPosition}
      counter={
        matches.length
          ? `Match ${(search.page?.matchedOccurrenceCount ?? matches.length) - matches.length + index + 1} of ${search.page?.matchedOccurrenceCount ?? matches.length}${search.page?.hasMore ? "+" : ""}`
          : "Searching saved history…"
      }
      previousDisabled={index === 0 && search.pageIndex === 0}
      nextDisabled={!search.page?.hasMore && index >= matches.length - 1}
      onPrevious={() => {
        props.scrollPosition.current = 0;
        if (index > 0) setIndex(index - 1);
        else {
          setIndex(-1);
          search.previous();
        }
      }}
      onNext={() => {
        props.scrollPosition.current = 0;
        if (index < matches.length - 1) setIndex(index + 1);
        else {
          setIndex(0);
          search.next();
        }
      }}
    />
  );
}
