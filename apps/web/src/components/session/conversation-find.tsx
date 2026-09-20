import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import type { TimelineSearchTarget } from "@opengeni/react/session-ui";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useConversationSearch,
  useCommittedSearchQuery,
  type ConversationSearchMatch,
  type ConversationSearchPage,
} from "@/lib/use-conversation-search";
import { requestSessionSearch, type SessionSearchRoute } from "@/lib/session-search-route";

export default function ConversationFind(props: {
  workspaceId: string;
  sessionId: string;
  open: boolean;
  focusRevision: number;
  initial: SessionSearchRoute;
  onClose: () => void;
  onTarget: (target: TimelineSearchTarget | null) => void;
  onJump: (sequence: number, options?: { signal?: AbortSignal }) => Promise<boolean>;
}) {
  const { onJump, onTarget } = props;
  const { client, accessContext } = useAppContext();
  const [query, setQuery] = useState(props.initial.find ?? "");
  const scope = JSON.stringify([accessContext.subjectId, props.workspaceId, props.sessionId]);
  const committedQuery = useCommittedSearchQuery(query, scope, props.open);
  const [index, setIndex] = useState(0);
  const desired = useRef<{ sequence: number; offset: number; query: string } | null>(null);
  const [seeking, setSeeking] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const navigationLifetime = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });
  const handledPage = useRef<ConversationSearchPage | null>(null);
  const pageLanding = useRef<"first" | "last">("first");
  const search = useConversationSearch({
    client,
    authority: accessContext.subjectId,
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    query: committedQuery,
    debounceMs: 0,
    enabled: props.open,
  });
  const matches = search.page?.matches ?? [];
  const page = search.page;
  const nextPage = search.next;
  const choose = useCallback(
    async (target: TimelineSearchTarget) => {
      const generation = ++navigationLifetime.current.generation;
      navigationLifetime.current.controller?.abort();
      const controller = new AbortController();
      navigationLifetime.current.controller = controller;
      setNavigationError(null);
      setNavigating(true);
      try {
        const retained = await onJump(target.sequence, { signal: controller.signal });
        if (generation !== navigationLifetime.current.generation) return;
        if (retained) onTarget(target);
        else setNavigationError("This passage could not be loaded. Try the match again.");
      } catch {
        if (generation === navigationLifetime.current.generation)
          setNavigationError("This passage could not be loaded. Try the match again.");
      } finally {
        if (generation === navigationLifetime.current.generation) setNavigating(false);
      }
    },
    [onJump, onTarget],
  );
  const selectMatch = useCallback(
    (match: ConversationSearchMatch) => {
      void choose({
        sequence: match.sequence,
        eventId: match.eventId,
        query: committedQuery,
        offset: match.messageMatchOffset,
      });
    },
    [choose, committedQuery],
  );
  useEffect(() => {
    if (!props.open) {
      ++navigationLifetime.current.generation;
      navigationLifetime.current.controller?.abort();
      setNavigating(false);
      onTarget(null);
      return;
    }
    input.current?.focus();
    input.current?.select();
  }, [props.open, props.focusRevision, onTarget]);
  useEffect(() => {
    const lifetime = navigationLifetime.current;
    return () => {
      ++lifetime.generation;
      lifetime.controller?.abort();
    };
  }, []);
  useEffect(() => {
    if (!props.initial.find) return;
    setQuery(props.initial.find);
    if (props.initial.matchSequence) {
      const target = {
        sequence: props.initial.matchSequence,
        offset: props.initial.matchOffset ?? 0,
      };
      desired.current = { ...target, query: props.initial.find };
      handledPage.current = null;
      setSeeking(true);
      void choose({ ...target, query: props.initial.find });
    }
  }, [props.initial.find, props.initial.matchSequence, props.initial.matchOffset, choose]);
  useEffect(() => {
    if (!props.open || search.loading || !page || handledPage.current === page) return;
    const pageMatches = page.matches;
    const requested = desired.current;
    if (requested && requested.query !== committedQuery) return;
    handledPage.current = page;
    if (requested) {
      const found = pageMatches.findIndex(
        (match) =>
          match.sequence === requested.sequence && match.messageMatchOffset === requested.offset,
      );
      if (found >= 0) {
        setIndex(found);
        desired.current = null;
        setSeeking(false);
        selectMatch(pageMatches[found]!);
      } else if (page.hasMore) nextPage();
      else {
        desired.current = null;
        setSeeking(false);
        setNavigationError("The original match is no longer in the search results.");
      }
      return;
    }
    const landing = pageLanding.current === "last" ? Math.max(0, pageMatches.length - 1) : 0;
    pageLanding.current = "first";
    setIndex(landing);
    if (pageMatches[landing]) selectMatch(pageMatches[landing]);
  }, [
    page,
    search.loading,
    props.open,
    committedQuery,
    selectMatch,
    nextPage,
    props.initial.find,
    props.initial.matchSequence,
    props.initial.matchOffset,
  ]);
  const lastIdentity = useRef(JSON.stringify([scope, committedQuery]));
  useEffect(() => {
    const identity = JSON.stringify([scope, committedQuery]);
    if (lastIdentity.current === identity && !search.accessDenied) return;
    lastIdentity.current = identity;
    ++navigationLifetime.current.generation;
    navigationLifetime.current.controller?.abort();
    setNavigating(false);
    desired.current = null;
    setSeeking(false);
    handledPage.current = null;
    setNavigationError(null);
    setIndex(0);
    onTarget(null);
  }, [scope, committedQuery, search.accessDenied, onTarget]);
  function move(direction: -1 | 1) {
    if (!matches.length || search.loading) return;
    const next = index + direction;
    if (next >= 0 && next < matches.length) {
      setIndex(next);
      selectMatch(matches[next]!);
    } else if (direction === 1 && search.page?.hasMore) {
      pageLanding.current = "first";
      search.next();
    } else if (direction === -1 && search.pageIndex > 0) {
      pageLanding.current = "last";
      search.previous();
    }
  }
  if (!props.open) return null;
  const total = search.page?.matchedOccurrenceCount ?? matches.length;
  const ordinal = total - matches.length + index + 1;
  const counter =
    search.loading || seeking
      ? "Searching…"
      : matches.length
        ? `${ordinal} / ${total}${search.page?.countIsExact ? "" : "+"}`
        : search.error
          ? "Unavailable"
          : committedQuery.trim()
            ? "No matches"
            : "";
  return (
    <section
      aria-label="Find in conversation"
      className="shrink-0 border-b border-border bg-bg px-3 py-2"
    >
      <div className="flex items-center gap-1.5">
        <SearchIcon className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <Input
          ref={input}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={200}
          placeholder="Find in conversation…"
          aria-label="Find in conversation"
          suppressAutofill
          className="h-8 min-w-0 flex-1 text-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            }
            if (event.key === "Enter") {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span className="min-w-12 whitespace-nowrap text-right text-xs text-fg-muted" role="status">
          {counter}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={
            !matches.length || search.loading || seeking || (index === 0 && search.pageIndex === 0)
          }
          onClick={() => move(-1)}
          aria-label="Previous match"
        >
          <ChevronUpIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={
            !matches.length ||
            search.loading ||
            seeking ||
            (index === matches.length - 1 && !search.page?.hasMore)
          }
          onClick={() => move(1)}
          aria-label="Next match"
        >
          <ChevronDownIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={props.onClose}
          aria-label="Close conversation search"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-subtle">
        <span>
          {query !== committedQuery
            ? `Showing matches for “${committedQuery}”`
            : navigating
              ? "Loading passage…"
              : "All saved user and completed assistant messages"}
        </span>
        <button
          type="button"
          onClick={() => requestSessionSearch(props.workspaceId)}
          className="rounded-sm text-fg-muted underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to session search
        </button>
      </div>
      {search.error ? (
        <div className="mt-2 flex items-center gap-2 text-sm" role="alert">
          {search.error}
          <Button variant="outline" size="sm" onClick={search.retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {navigationError ? (
        <div className="mt-2 flex items-center gap-2 text-sm" role="alert">
          {navigationError}
          <Button
            variant="outline"
            size="sm"
            disabled={!matches[index]}
            onClick={() => matches[index] && selectMatch(matches[index]!)}
          >
            Retry jump
          </Button>
        </div>
      ) : null}
    </section>
  );
}
