import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { discardSearchResultsOnError, searchAccessDenied } from "./use-conversation-search";

/** One occurrence in a session: the durable event plus its UTF-16 offset. */
export type SessionFindMatch = { sequence: number; eventId: string; offset: number };

/** Matches counted in the background before further pages wait for navigation. */
export const SESSION_FIND_BACKGROUND_MATCHES = 2_000;
const PAGE_LIMIT = 50;

export function compareSessionFindMatch(
  a: Pick<SessionFindMatch, "sequence" | "offset">,
  b: Pick<SessionFindMatch, "sequence" | "offset">,
): number {
  return a.sequence - b.sequence || a.offset - b.offset;
}

/**
 * What is known about a newest-first traversal. `matches` are in conversation
 * order (oldest first). Pages visit messages newest first, so every message
 * newer than the oldest one reached is complete; that oldest message may still
 * have later occurrences on the next page, so its matches are not yet settled.
 */
export type SessionFindProgress = {
  matches: SessionFindMatch[];
  exhausted: boolean;
  /** Cumulative occurrences seen, exact once exhausted. */
  total: number;
  /** The oldest match, when asked for before the newest-first pages reach it. */
  first?: SessionFindMatch | null;
};

/** Index of the first settled match: everything from it to the end is complete. */
export function settledFrom(progress: SessionFindProgress): number {
  if (progress.exhausted || !progress.matches.length) return 0;
  const frontier = progress.matches[0]!.sequence;
  const index = progress.matches.findIndex((match) => match.sequence > frontier);
  return index < 0 ? progress.matches.length : index;
}

export function settledCount(progress: SessionFindProgress): number {
  return progress.matches.length - settledFrom(progress);
}

/**
 * The match one step from `from` (Next = newer, Previous = older), wrapping at
 * either end like browser find. Returns what must load first when the answer
 * is not known yet: `more` (one more older page) or `first` (the oldest match).
 */
export function resolveSessionFindMove(
  progress: SessionFindProgress,
  from: Pick<SessionFindMatch, "sequence" | "offset">,
  direction: 1 | -1,
): SessionFindMatch | "more" | "first" | null {
  const { matches } = progress;
  if (progress.exhausted) {
    if (!matches.length) return null;
    if (direction === 1)
      return matches.find((match) => compareSessionFindMatch(match, from) > 0) ?? matches[0]!;
    return lastBefore(matches, from) ?? matches.at(-1)!;
  }
  const settled = matches.slice(settledFrom(progress));
  const first = progress.first ?? null;
  // Previous from the oldest match wraps to the newest one.
  if (direction === -1 && first && compareSessionFindMatch(from, first) === 0)
    return settled.at(-1) ?? "more";
  const frontier = matches[0]?.sequence;
  // Anything at or before the oldest message reached is not complete yet.
  if (frontier === undefined || from.sequence <= frontier) return "more";
  if (direction === 1)
    return settled.find((match) => compareSessionFindMatch(match, from) > 0) ?? first ?? "first";
  return lastBefore(settled, from) ?? "more";
}

function lastBefore(
  matches: SessionFindMatch[],
  from: Pick<SessionFindMatch, "sequence" | "offset">,
): SessionFindMatch | undefined {
  for (let index = matches.length - 1; index >= 0; index--)
    if (compareSessionFindMatch(matches[index]!, from) < 0) return matches[index];
  return undefined;
}

type FindState = SessionFindProgress & {
  identity: string;
  client: OpenGeniBrowserClient;
  loading: boolean;
  error: string | null;
  accessDenied: boolean;
};
type Checkpoint = SessionFindProgress & {
  identity: string;
  client: OpenGeniBrowserClient;
  cursor: string | undefined;
};
type Demand = {
  identity: string;
  more: boolean;
  first: boolean;
  all: boolean;
  wake: () => void;
};
const idleDemand = (identity: string): Demand => ({
  identity,
  more: false,
  first: false,
  all: false,
  wake: () => {},
});

function occurrence(match: {
  sequence: number;
  eventId: string;
  messageMatchOffset: number;
}): SessionFindMatch {
  return { sequence: match.sequence, eventId: match.eventId, offset: match.messageMatchOffset };
}

/**
 * Adds one newest-first page to matches kept in conversation order. A page
 * only reaches messages at or before the oldest one already reached, so only
 * that message's known occurrences need merging; the rest stays as it is.
 */
function mergeOlderPage(matches: SessionFindMatch[], page: SessionFindMatch[]): SessionFindMatch[] {
  if (!page.length) return matches;
  const newestAdded = Math.max(...page.map((match) => match.sequence));
  let overlap = 0;
  while (overlap < matches.length && matches[overlap]!.sequence <= newestAdded) overlap++;
  const seen = new Set(
    matches.slice(0, overlap).map((match) => `${match.eventId}:${match.offset}`),
  );
  const added = page.filter((match) => !seen.has(`${match.eventId}:${match.offset}`));
  if (!added.length) return matches;
  return [...matches.slice(0, overlap), ...added]
    .sort(compareSessionFindMatch)
    .concat(matches.slice(overlap));
}

/**
 * Find in one session: newest matches first, all of the history reachable.
 * Retains only compact occurrence keys, never message text. Pages continue in
 * the background until the count is exact (or many matches are known), and
 * on demand when navigation needs older matches or the oldest one.
 */
export function useSessionFind(input: {
  client: OpenGeniBrowserClient;
  authority: string;
  workspaceId: string;
  sessionId: string;
  query: string;
  enabled: boolean;
  backgroundMatches?: number | undefined;
}) {
  const {
    client,
    authority,
    workspaceId,
    sessionId,
    query,
    enabled,
    backgroundMatches = SESSION_FIND_BACKGROUND_MATCHES,
  } = input;
  const identity = JSON.stringify([authority, workspaceId, sessionId, query]);
  const [state, setState] = useState<FindState | null>(null);
  const [revision, setRevision] = useState(0);
  const demand = useRef<Demand>(idleDemand(identity));
  const checkpoint = useRef<Checkpoint | null>(null);
  const active = enabled && !!query.trim();
  useEffect(() => {
    if (!active) {
      checkpoint.current = null;
      // A closed bar forgets navigation demand; reopening counts afresh.
      demand.current = idleDemand("");
      setState(null);
      return;
    }
    const controller = new AbortController();
    const retained = checkpoint.current;
    checkpoint.current = null;
    const resume = retained?.identity === identity && retained.client === client ? retained : null;
    let progress: SessionFindProgress = resume
      ? {
          matches: resume.matches,
          exhausted: false,
          total: resume.total,
          first: resume.first ?? null,
        }
      : { matches: [], exhausted: false, total: 0, first: null };
    let cursor = resume?.cursor;
    let wake: (() => void) | null = null;
    if (demand.current.identity !== identity) demand.current = idleDemand(identity);
    demand.current.wake = () => {
      wake?.();
      wake = null;
    };
    const publish = (loading: boolean) =>
      setState({ ...progress, identity, client, loading, error: null, accessDenied: false });
    void (async () => {
      try {
        for (;;) {
          if (demand.current.first && !progress.first) {
            // Wrapping past the newest match needs only the oldest one: ask
            // for it directly rather than paging through the whole history.
            publish(true);
            let oldestCursor: string | undefined;
            for (;;) {
              const page = await client.searchSessionMessages(
                workspaceId,
                {
                  query,
                  sessionId,
                  order: "oldest",
                  limit: 1,
                  ...(oldestCursor ? { cursor: oldestCursor } : {}),
                },
                { signal: controller.signal },
              );
              controller.signal.throwIfAborted();
              const found = page.matches[0];
              if (found) {
                progress = { ...progress, first: occurrence(found) };
                break;
              }
              if (!page.hasMore || !page.nextCursor || page.nextCursor === oldestCursor) {
                // Nothing older was found after all: page through instead.
                demand.current.all = true;
                break;
              }
              oldestCursor = page.nextCursor;
            }
            demand.current.first = false;
            continue;
          }
          const wanted = () =>
            demand.current.more || demand.current.all || settledCount(progress) < backgroundMatches;
          if (!wanted()) {
            publish(false);
            // Cleanup aborts and calls wake, so this wait always ends.
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            controller.signal.throwIfAborted();
            continue;
          }
          publish(true);
          demand.current.more = false;
          const page = await client.searchSessionMessages(
            workspaceId,
            {
              query,
              sessionId,
              order: "newest",
              limit: PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            },
            { signal: controller.signal },
          );
          controller.signal.throwIfAborted();
          // Never checkpoint a continuation that does not advance.
          if (page.hasMore && (!page.nextCursor || page.nextCursor === cursor))
            throw new Error("Search did not advance");
          progress = {
            matches: mergeOlderPage(progress.matches, page.matches.map(occurrence)),
            exhausted: !page.hasMore,
            total: page.matchedOccurrenceCount,
            first: progress.first ?? null,
          };
          cursor = page.nextCursor ?? undefined;
          if (progress.exhausted) {
            publish(false);
            return;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const discard = discardSearchResultsOnError(error);
        // A transient failure keeps what was found and resumes at the last
        // valid boundary; a definitive one restarts from the newest message.
        if (!discard) checkpoint.current = { ...progress, identity, client, cursor };
        setState({
          ...(discard ? { matches: [], exhausted: false, total: 0, first: null } : progress),
          identity,
          client,
          loading: false,
          error: "Search could not be completed. Try again.",
          accessDenied: searchAccessDenied(error),
        });
      }
    })();
    return () => {
      controller.abort();
      wake?.();
    };
  }, [active, identity, client, workspaceId, sessionId, query, backgroundMatches, revision]);
  const current = active && state?.identity === identity && state.client === client ? state : null;
  const load = useCallback(
    (kind: "more" | "first") => {
      if (demand.current.identity !== identity) return;
      demand.current[kind] = true;
      demand.current.wake();
    },
    [identity],
  );
  return {
    matches: current?.matches ?? [],
    exhausted: current?.exhausted ?? false,
    total: current?.total ?? 0,
    first: current?.first ?? null,
    loading: active && (!current || current.loading),
    error: current?.error ?? null,
    accessDenied: current?.accessDenied ?? false,
    /** Request one more older page, or the oldest match. */
    load,
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
