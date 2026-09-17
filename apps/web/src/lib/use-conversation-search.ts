import { useCallback, useEffect, useState } from "react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

export type ConversationSearchPage = Awaited<
  ReturnType<OpenGeniBrowserClient["searchSessionMessages"]>
>;
export type ConversationSearchMatch = ConversationSearchPage["matches"][number];
export const SEARCH_BATCH_SIZE = 50;

/** Continue empty scan pages, but never download whole messages or retain an unbounded hit list. */
export async function readConversationSearchBatch(
  read: (cursor: string | undefined, remaining: number) => Promise<ConversationSearchPage>,
  cursor: string | undefined,
  signal: AbortSignal,
  onProgress: (scanned: number, partial: ConversationSearchPage) => void,
  stopAfterFirstMatches = false,
): Promise<ConversationSearchPage> {
  const matches: ConversationSearchMatch[] = [];
  let next = cursor;
  for (;;) {
    signal.throwIfAborted();
    const page = await read(next, SEARCH_BATCH_SIZE - matches.length);
    signal.throwIfAborted();
    matches.push(...page.matches);
    onProgress(page.scannedMessages, { ...page, matches: [...matches] });
    if (
      !page.hasMore ||
      matches.length >= SEARCH_BATCH_SIZE ||
      (stopAfterFirstMatches && matches.length > 0)
    )
      return { ...page, matches };
    if (!page.nextCursor || page.nextCursor === next) throw new Error("Search did not advance");
    next = page.nextCursor;
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
}) {
  const {
    client,
    authority,
    workspaceId,
    sessionId,
    query,
    enabled,
    archiveStatus = "all",
  } = input;
  const identity = JSON.stringify([authority, workspaceId, sessionId, query, archiveStatus]);
  const [navigation, setNavigation] = useState<{
    identity: string;
    cursors: Array<string | undefined>;
    index: number;
  }>({ identity, cursors: [undefined], index: 0 });
  const activeNavigation =
    navigation.identity === identity ? navigation : { identity, cursors: [undefined], index: 0 };
  const cursor = activeNavigation.cursors[activeNavigation.index];
  const [state, setState] = useState<{
    identity: string;
    client: typeof client;
    cursor: string | undefined;
    page: ConversationSearchPage | null;
    loading: boolean;
    error: string | null;
    scanned: number;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!enabled || !query.trim()) return;
    const controller = new AbortController();
    const initial = {
      identity,
      client,
      cursor,
      page: null,
      loading: true,
      error: null,
      scanned: 0,
    };
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
        cursor,
        controller.signal,
        (scanned, partial) => {
          if (active) setState({ ...initial, scanned, page: partial });
        },
        !!sessionId,
      ).then(
        (page) => {
          if (!active) return;
          setState({ ...initial, page, loading: false, scanned: page.scannedMessages });
        },
        () => {
          if (!active || controller.signal.aborted) return;
          setState({
            ...initial,
            loading: false,
            error: "Search could not be completed. Try again.",
          });
        },
      );
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, identity, workspaceId, sessionId, query, archiveStatus, cursor, enabled, revision]);
  const currentState =
    state?.identity === identity && state.client === client && state.cursor === cursor
      ? state
      : null;
  const page = currentState?.page ?? null;
  const next = useCallback(() => {
    if (!page?.hasMore || !page.nextCursor) return;
    setNavigation((previous) => {
      const current =
        previous.identity === identity ? previous : { identity, cursors: [undefined], index: 0 };
      return {
        identity,
        cursors: [...current.cursors.slice(0, current.index + 1), page.nextCursor!],
        index: current.index + 1,
      };
    });
  }, [identity, page]);
  const previous = useCallback(
    () =>
      setNavigation((current) =>
        current.identity === identity
          ? { ...current, index: Math.max(0, current.index - 1) }
          : current,
      ),
    [identity],
  );
  return {
    page,
    loading: enabled && !!query.trim() && (!currentState || currentState.loading),
    error: currentState?.error ?? null,
    scanned: currentState?.scanned ?? 0,
    pageIndex: activeNavigation.index,
    next,
    previous,
    retry: useCallback(() => setRevision((value) => value + 1), []),
  };
}
