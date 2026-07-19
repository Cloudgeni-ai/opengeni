import type { Session } from "@opengeni/sdk";
import { useCallback, useEffect, useRef } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseWorkspaceSessionsOptions = ClientOverride & {
  limit?: number | undefined;
  parentSessionId?: string | null | undefined;
  cursor?: string | undefined;
  search?: string | undefined;
  /** Return only the complete personal pinned projection. */
  pinsOnly?: boolean | undefined;
  /** Refresh interval (ms) for fleet/manager views. Off by default. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
};

export type UseWorkspaceSessionsResult = {
  /**
   * All visible rows, with pins first. This preserves the pre-pinning hook
   * contract for consumers that only read `sessions`.
   */
  sessions: Session[];
  /** The complete personal pinned section, also present in `sessions`. */
  pinned: Session[];
  nextCursor: string | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

/** List the workspace's sessions — the data behind fleet and manager views. */
export function useWorkspaceSessions(
  options: UseWorkspaceSessionsOptions = {},
): UseWorkspaceSessionsResult {
  const { client, workspaceId } = useOpenGeni(options);
  const limit = options.limit;
  const parentSessionId = options.parentSessionId;
  const cursor = options.cursor;
  const search = options.search;
  const pinsOnly = options.pinsOnly;
  const enabled = options.enabled ?? true;
  const queryKey = JSON.stringify({
    workspaceId,
    limit,
    parentSessionId,
    cursor,
    search,
    pinsOnly,
  });
  const previousQueryKey = useRef(queryKey);
  const queryKeyTransition = previousQueryKey.current !== queryKey;
  useEffect(() => {
    previousQueryKey.current = queryKey;
  }, [queryKey]);
  const load = useCallback(
    async () => ({
      queryKey,
      page: await client.listSessionPage(workspaceId, {
        ...(limit !== undefined ? { limit } : {}),
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(search !== undefined ? { search } : {}),
        ...(pinsOnly ? { pinsOnly: true } : {}),
      }),
    }),
    [client, workspaceId, limit, parentSessionId, cursor, search, pinsOnly, queryKey],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled,
  });
  // usePolledValue drops stale async completions, while the explicit query key
  // also prevents the previous query's cached value from painting for the one
  // render before its loader-change effect clears state.
  const page = state.data?.queryKey === queryKey ? state.data.page : null;
  const pinned = page?.pinned ?? [];
  const ordinary = page?.sessions ?? [];
  return {
    // The old hook returned every visible session. Keep that public behavior
    // while exposing `pinned` separately for the compact section. The API page
    // itself continues to paginate only `ordinary` rows via nextCursor.
    sessions: [...pinned, ...ordinary],
    pinned,
    nextCursor: page?.nextCursor ?? null,
    // `usePolledValue` clears the old data and starts the new request in an
    // effect. During that query-key transition render, its old loading flag
    // can still be false; expose loading immediately so consumers do not
    // announce a transient false zero-match result.
    loading:
      enabled &&
      (state.loading ||
        queryKeyTransition ||
        (state.data !== null && state.data.queryKey !== queryKey)),
    error: state.error,
    refresh: state.refresh,
  };
}
