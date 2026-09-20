import { useCallback, useEffect, useRef, useState } from "react";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";

export type ConversationSearchPage = Awaited<
  ReturnType<OpenGeniBrowserClient["searchSessionMessages"]>
>;
export type ConversationSearchMatch = ConversationSearchPage["matches"][number];
export const SEARCH_BATCH_SIZE = 50;

/** Debounce the query identity, not disposal of an already useful search.
 * This is deliberately not a result cache: a committed query/scope change or
 * reopen still goes through live authorization. Preserve literal whitespace.
 */
export function useCommittedSearchQuery(
  query: string,
  identity: string,
  enabled: boolean,
  delayMs = 250,
): string {
  const [committed, setCommitted] = useState({ identity, query });
  const current = committed.identity === identity && query.trim() ? committed.query : query;
  useEffect(() => {
    if (!enabled || !query.trim() || committed.identity !== identity) {
      setCommitted({ identity, query });
      return;
    }
    if (current === query) return;
    const timer = window.setTimeout(() => setCommitted({ identity, query }), delayMs);
    return () => window.clearTimeout(timer);
  }, [query, identity, enabled, delayMs, current, committed.identity]);
  return current;
}

/** Only transient failures may retain previously returned content/cursors. */
export function discardSearchResultsOnError(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export function searchAccessDenied(error: unknown): boolean {
  return error instanceof OpenGeniApiError && [401, 403, 404].includes(error.status);
}

/** Continue empty scan pages, but never download whole messages or retain an unbounded hit list. */
export async function readConversationSearchBatch(
  read: (cursor: string | undefined, remaining: number) => Promise<ConversationSearchPage>,
  cursor: string | undefined,
  signal: AbortSignal,
  onProgress: (scanned: number, partial: ConversationSearchPage) => void,
  stopAfterFirstMatches = false,
  retainedPage?: ConversationSearchPage,
): Promise<ConversationSearchPage> {
  const matches: ConversationSearchMatch[] = [...(retainedPage?.matches ?? [])];
  let next = cursor;
  for (;;) {
    signal.throwIfAborted();
    const page = await read(next, SEARCH_BATCH_SIZE - matches.length);
    signal.throwIfAborted();
    // Do not checkpoint a broken continuation: retry must use the last valid
    // boundary, not loop forever or append a duplicate page.
    if (page.hasMore && (!page.nextCursor || page.nextCursor === next))
      throw new Error("Search did not advance");
    matches.push(...page.matches);
    onProgress(page.scannedMessages, { ...page, matches: [...matches] });
    if (
      !page.hasMore ||
      matches.length >= SEARCH_BATCH_SIZE ||
      (stopAfterFirstMatches && matches.length > 0)
    )
      return { ...page, matches };
    next = page.nextCursor!;
  }
}

export function useConversationSearch(input: {
  client: OpenGeniBrowserClient;
  authority: string;
  workspaceId: string;
  sessionId?: string;
  query: string;
  enabled: boolean;
  archiveStatus?: "active" | "archived" | "all";
  debounceMs?: number;
}) {
  const {
    client,
    authority,
    workspaceId,
    sessionId,
    query,
    enabled,
    archiveStatus = "all",
    debounceMs = 180,
  } = input;
  const identity = JSON.stringify([authority, workspaceId, sessionId, query, archiveStatus]);
  const [navigation, setNavigation] = useState<{
    identity: string;
    client: typeof client;
    cursors: Array<string | undefined>;
    index: number;
  }>({ identity, client, cursors: [undefined], index: 0 });
  const activeNavigation =
    navigation.identity === identity && navigation.client === client
      ? navigation
      : { identity, client, cursors: [undefined], index: 0 };
  useEffect(() => {
    // Commit the new owner even before paging, so switching back cannot revive
    // another client's (or scope's) old navigation stack.
    setNavigation((current) =>
      current.identity === identity && current.client === client
        ? current
        : { identity, client, cursors: [undefined], index: 0 },
    );
  }, [identity, client]);
  const cursor = activeNavigation.cursors[activeNavigation.index];
  const [state, setState] = useState<{
    identity: string;
    client: typeof client;
    cursor: string | undefined;
    page: ConversationSearchPage | null;
    loading: boolean;
    error: string | null;
    scanned: number;
    accessDenied: boolean;
    restartOnRetry: boolean;
  } | null>(null);
  const retryFrom = useRef<typeof state>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!enabled || !query.trim()) {
      retryFrom.current = null;
      setState(null);
      return;
    }
    const controller = new AbortController();
    const retained = retryFrom.current;
    retryFrom.current = null;
    const checkpoint =
      retained?.identity === identity && retained.client === client && retained.cursor === cursor
        ? retained.page
        : null;
    const initial = {
      identity,
      client,
      cursor,
      page: checkpoint,
      loading: true,
      error: null,
      scanned: checkpoint?.scannedMessages ?? 0,
      accessDenied: false,
      restartOnRetry: false,
    };
    let progress = initial;
    setState(initial);
    const timer = window.setTimeout(() => {
      void readConversationSearchBatch(
        (nextCursor, remaining) =>
          client.searchSessionMessages(
            workspaceId,
            {
              query,
              ...(sessionId ? { sessionId } : { groupBy: "session" as const }),
              archiveStatus,
              limit: remaining,
              ...(nextCursor ? { cursor: nextCursor } : {}),
            },
            { signal: controller.signal },
          ),
        checkpoint?.nextCursor ?? cursor,
        controller.signal,
        (scanned, partial) => {
          progress = { ...initial, scanned, page: partial };
          if (active) setState(progress);
        },
        !!sessionId,
        checkpoint ?? undefined,
      ).then(
        (page) => {
          if (!active) return;
          setState({ ...initial, page, loading: false, scanned: page.scannedMessages });
        },
        (error: unknown) => {
          if (!active || controller.signal.aborted) return;
          setState({
            ...(discardSearchResultsOnError(error)
              ? { ...initial, page: null, scanned: 0 }
              : progress),
            loading: false,
            error: "Search could not be completed. Try again.",
            accessDenied: searchAccessDenied(error),
            restartOnRetry: discardSearchResultsOnError(error),
          });
        },
      );
    }, debounceMs);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    client,
    identity,
    workspaceId,
    sessionId,
    query,
    archiveStatus,
    cursor,
    enabled,
    revision,
    debounceMs,
  ]);
  const currentState =
    enabled &&
    !!query.trim() &&
    state?.identity === identity &&
    state.client === client &&
    state.cursor === cursor
      ? state
      : null;
  const page = currentState?.page ?? null;
  const next = useCallback(() => {
    if (!page?.hasMore || !page.nextCursor) return;
    setNavigation((previous) => {
      const current =
        previous.identity === identity && previous.client === client
          ? previous
          : { identity, client, cursors: [undefined], index: 0 };
      return {
        identity,
        client,
        cursors: [...current.cursors.slice(0, current.index + 1), page.nextCursor!],
        index: current.index + 1,
      };
    });
  }, [identity, client, page]);
  const previous = useCallback(
    () =>
      setNavigation((current) =>
        current.identity === identity && current.client === client
          ? { ...current, index: Math.max(0, current.index - 1) }
          : current,
      ),
    [identity, client],
  );
  return {
    page,
    loading: enabled && !!query.trim() && (!currentState || currentState.loading),
    error: currentState?.error ?? null,
    accessDenied: currentState?.accessDenied ?? false,
    scanned: currentState?.scanned ?? 0,
    pageIndex: activeNavigation.index,
    next,
    previous,
    retry: useCallback(() => {
      // A retry alone can resume partial progress. Closing/reopening or changing
      // identity must reauthorize from scratch rather than revive cached hits.
      retryFrom.current = currentState?.error && currentState.page?.hasMore ? currentState : null;
      if (currentState?.restartOnRetry) {
        setNavigation({ identity, client, cursors: [undefined], index: 0 });
      }
      setRevision((value) => value + 1);
    }, [currentState, identity, client]),
  };
}
