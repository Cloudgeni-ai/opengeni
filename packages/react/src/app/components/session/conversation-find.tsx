import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import type { TimelineSearchTarget } from "../../../session-ui";
import { useAppContext } from "../../app-context";
import { Button } from "../../../ui/button";
import { Input } from "../../../ui/input";
import { useCommittedSearchQuery } from "../../lib/use-conversation-search";
import {
  compareSessionFindMatch,
  resolveSessionFindMove,
  useSessionFind,
  type SessionFindMatch,
} from "../../lib/use-session-find";
import { requestSessionSearch, type SessionSearchRoute } from "../../lib/session-search-route";
import { useUiEventTarget } from "../../lib/ui-events";

type Occurrence = Pick<SessionFindMatch, "sequence" | "offset"> & { eventId?: string };

export default function ConversationFind(props: {
  workspaceId: string;
  sessionId: string;
  open: boolean;
  focusRevision: number;
  initial: SessionSearchRoute;
  showBackToSessionSearch: boolean;
  onClose: () => void;
  onTarget: (target: TimelineSearchTarget | null) => void;
  onJump: (sequence: number, options?: { signal?: AbortSignal }) => Promise<boolean>;
}) {
  const windowEvents = useUiEventTarget("window");
  const { onJump, onTarget } = props;
  const { client, accessContext } = useAppContext();
  const [query, setQuery] = useState(props.initial.find ?? "");
  const scope = JSON.stringify([accessContext.subjectId, props.workspaceId, props.sessionId]);
  const committedQuery = useCommittedSearchQuery(query, scope, props.open);
  // The selected occurrence, by key: older pages arriving never move it.
  const [current, setCurrent] = useState<Occurrence | null>(null);
  const [pending, setPending] = useState<{ from: Occurrence; direction: 1 | -1 } | null>(null);
  const desired = useRef<{ sequence: number; offset: number; query: string } | null>(null);
  const [seeking, setSeeking] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const navigationLifetime = useRef<{ generation: number; controller: AbortController | null }>({
    generation: 0,
    controller: null,
  });
  const search = useSessionFind({
    client,
    authority: accessContext.subjectId,
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    query: committedQuery,
    enabled: props.open,
  });
  const { matches, exhausted, total, first, load } = search;
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
    (match: SessionFindMatch) => {
      setCurrent(match);
      void choose({
        sequence: match.sequence,
        eventId: match.eventId,
        query: committedQuery,
        offset: match.offset,
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
      // Closing clears the highlight, so forget the place too: reopening
      // searches again and lands on the newest match, highlighted.
      desired.current = null;
      setCurrent(null);
      setPending(null);
      setSeeking(false);
      setNavigationError(null);
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
      setCurrent(target);
      setPending(null);
      setSeeking(true);
      void choose({ ...target, query: props.initial.find });
    }
  }, [props.initial.find, props.initial.matchSequence, props.initial.matchOffset, choose]);
  useEffect(() => {
    if (!props.open) return;
    const requested = desired.current;
    if (requested) {
      if (requested.query !== committedQuery || search.error) return;
      // A linked occurrence keeps its place; find it to number it, loading
      // older pages until it is reached.
      const found = matches.find((match) => compareSessionFindMatch(match, requested) === 0);
      if (found) {
        desired.current = null;
        setSeeking(false);
        selectMatch(found);
      } else if (exhausted) {
        desired.current = null;
        setSeeking(false);
        setNavigationError("The original match is no longer in the search results.");
      } else load("more");
      return;
    }
    if (current || pending) return;
    // Like a chat, start at the most recent match.
    const newest = matches.at(-1);
    if (newest && (exhausted || newest.sequence > matches[0]!.sequence)) selectMatch(newest);
  }, [
    props.open,
    search.error,
    matches,
    exhausted,
    committedQuery,
    current,
    pending,
    selectMatch,
    load,
  ]);
  useEffect(() => {
    if (!pending) return;
    // A failed page cannot answer the move; Retry or the arrows start again.
    if (search.error) {
      setPending(null);
      return;
    }
    const target = resolveSessionFindMove(
      { matches, exhausted, total, first },
      pending.from,
      pending.direction,
    );
    if (target === null) setPending(null);
    else if (typeof target === "object") {
      setPending(null);
      selectMatch(target);
    } else load(target);
  }, [pending, search.error, matches, exhausted, total, first, selectMatch, load]);
  const lastIdentity = useRef({ scope, query: committedQuery, client });
  useEffect(() => {
    const sameAuthority =
      lastIdentity.current.scope === scope && lastIdentity.current.client === client;
    if (sameAuthority && lastIdentity.current.query === committedQuery && !search.accessDenied)
      return;
    lastIdentity.current = { scope, query: committedQuery, client };
    ++navigationLifetime.current.generation;
    navigationLifetime.current.controller?.abort();
    setNavigating(false);
    // A replacement route installs its exact occurrence before the query
    // debounce commits. Preserve that pending target for this query, but never
    // carry it across authority changes, denial, or an unrelated draft commit.
    if (!sameAuthority || search.accessDenied || desired.current?.query !== committedQuery) {
      desired.current = null;
    }
    setSeeking(desired.current !== null);
    setCurrent(
      desired.current
        ? { sequence: desired.current.sequence, offset: desired.current.offset }
        : null,
    );
    setPending(null);
    setNavigationError(null);
    onTarget(null);
  }, [scope, committedQuery, client, search.accessDenied, onTarget]);
  function move(direction: -1 | 1) {
    if (!current || seeking || pending) return;
    const target = resolveSessionFindMove({ matches, exhausted, total, first }, current, direction);
    if (target === null) return;
    if (typeof target === "object") selectMatch(target);
    else {
      setPending({ from: current, direction });
      load(target);
    }
  }
  if (!props.open) return null;
  const position = current
    ? matches.findIndex((match) => compareSessionFindMatch(match, current) === 0)
    : -1;
  const atFirst = !!current && !!first && compareSessionFindMatch(current, first) === 0;
  // While older history is still being counted, a place is known only at the
  // oldest match; elsewhere it shows as "?" and is read out in words.
  const counter: { text: string; spoken?: string } =
    seeking || pending || (search.loading && !current)
      ? { text: "Searching…" }
      : navigating
        ? { text: "Loading…" }
        : current && (matches.length || first)
          ? exhausted && position >= 0
            ? { text: `${position + 1} / ${matches.length}` }
            : atFirst
              ? { text: `1 / ${total}+`, spoken: `First of more than ${total} matches` }
              : {
                  text: `? / ${exhausted ? matches.length : `${total}+`}`,
                  spoken: exhausted
                    ? `${matches.length} matches`
                    : `More than ${total} matches, still counting`,
                }
          : search.error
            ? { text: "Unavailable" }
            : committedQuery.trim() && exhausted
              ? { text: "No matches" }
              : { text: "" };
  const canMove = !!current && !seeking && !pending && (!exhausted || matches.length > 0);
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
            // Enter / Shift+Enter, and Cmd/Ctrl+G / Shift+Cmd/Ctrl+G as in browsers.
            if (
              event.key === "Enter" ||
              ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "g")
            ) {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
        <span
          className="min-w-12 whitespace-nowrap text-right text-xs text-fg-muted empty:min-w-0"
          role="status"
        >
          {counter.spoken ? (
            <>
              <span aria-hidden="true">{counter.text}</span>
              <span className="sr-only">{counter.spoken}</span>
            </>
          ) : (
            counter.text
          )}
          {query !== committedQuery && committedQuery ? (
            <span className="sr-only"> Showing matches for “{committedQuery}”</span>
          ) : null}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canMove}
          onClick={() => move(-1)}
          aria-label="Previous match"
        >
          <ChevronUpIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!canMove}
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
      {/* One row while open, so the conversation never shifts under it. The
          back link is the only second line, and it lasts the bar's lifetime. */}
      {props.showBackToSessionSearch ? (
        <div className="mt-1 flex justify-end text-xs">
          <button
            type="button"
            onClick={() => requestSessionSearch(windowEvents, props.workspaceId)}
            className="rounded-sm text-fg-muted underline underline-offset-2 outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            Back to session search
          </button>
        </div>
      ) : null}
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
            disabled={!current}
            onClick={() =>
              current &&
              void choose({
                sequence: current.sequence,
                eventId: current.eventId,
                query: committedQuery,
                offset: current.offset,
              })
            }
          >
            Retry jump
          </Button>
        </div>
      ) : null}
    </section>
  );
}
