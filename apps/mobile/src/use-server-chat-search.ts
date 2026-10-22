import type { OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useState } from "react";

import type { ChatSearchHit } from "./chat-search";

const SEARCH_DEBOUNCE_MS = 150;

/**
 * The server's title search in each workspace, side by side; each workspace's
 * matches join as they arrive. A failed workspace just adds nothing.
 */
export function useServerChatSearch(
  client: OpenGeniClient,
  workspaceIds: readonly string[],
  query: string,
): { query: string; hits: ChatSearchHit[]; loading: boolean } {
  const [state, setState] = useState<{ query: string; hits: ChatSearchHit[]; loading: boolean }>({
    query: "",
    hits: [],
    loading: false,
  });
  const searchKey = workspaceIds.join(",");
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || !searchKey) {
      setState({ query: "", hits: [], loading: false });
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const targets = searchKey.split(",");
      let pending = targets.length;
      let first = true;
      const settle = (hits: ChatSearchHit[]) => {
        if (controller.signal.aborted) return;
        pending -= 1;
        const replace = first;
        first = false;
        setState((current) => ({
          query: trimmed,
          hits: replace || current.query !== trimmed ? hits : [...current.hits, ...hits],
          loading: pending > 0,
        }));
      };
      targets.forEach((workspaceId, index) => {
        client
          .listSessionPage(workspaceId, {
            search: trimmed,
            parentSessionId: null,
            // This workspace first and fullest; a few from each of the others.
            limit: index === 0 ? 20 : 6,
            signal: controller.signal,
          })
          .then((page) =>
            settle([
              // Pins come with every page; only the matched list counts as the server's match.
              ...page.pinned.map((session) => ({ session, workspaceId, fromServer: false })),
              ...page.sessions.map((session) => ({ session, workspaceId, fromServer: true })),
            ]),
          )
          .catch(() => settle([]));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, searchKey, query]);
  return state;
}
