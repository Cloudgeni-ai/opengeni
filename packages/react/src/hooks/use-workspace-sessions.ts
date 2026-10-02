import type { Session, SessionListEntry } from "@opengeni/sdk";
import { useCallback, useEffect, useRef } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { usePolledValue } from "./internal";

export type UseWorkspaceSessionsOptions = ClientOverride & {
  /** Compact list records; detail reads remain full sessions. */
  projection?: "summary" | undefined;
  limit?: number | undefined;
  parentSessionId?: string | null | undefined;
  cursor?: string | undefined;
  search?: string | undefined;
  /** Return only the complete personal pinned projection. */
  pinsOnly?: boolean | undefined;
  /** Skip pinned details when the pinned section is loaded separately. */
  includePinned?: boolean | undefined;
  archivedOnly?: boolean | undefined;
  sortBy?: "updatedAt" | "createdAt" | "name" | undefined;
  archiveStatus?: "active" | "archived" | "all" | undefined;
  /** Refresh interval (ms) for fleet/manager views. Off by default. */
  pollIntervalMs?: number | undefined;
  enabled?: boolean | undefined;
  /** Optional shared causal clock invoked when each network read starts. */
  beginRead?: (() => number) | undefined;
};

export type UseWorkspaceSessionsResult<T extends Session | SessionListEntry = Session> = {
  /**
   * All visible rows, with pins first. This preserves the pre-pinning hook
   * contract for consumers that only read `sessions`.
   */
  sessions: T[];
  /** The complete personal pinned section, also present in `sessions`. */
  pinned: T[];
  /** True when the server omitted older pins from its bounded pinned section. */
  pinnedTruncated: boolean;
  nextCursor: string | null;
  loading: boolean;
  error: Error | null;
  /** Monotonic revision of accepted authoritative list-page reads. */
  readRevision: number;
  /** Causal generation captured when the accepted network read started. */
  readGeneration: number;
  refresh: () => Promise<void>;
};

/** List the workspace's sessions — the data behind fleet and manager views. */
export function useWorkspaceSessions(
  options: UseWorkspaceSessionsOptions & { projection: "summary" },
): UseWorkspaceSessionsResult<SessionListEntry>;
export function useWorkspaceSessions(
  options?: UseWorkspaceSessionsOptions & { projection?: undefined },
): UseWorkspaceSessionsResult;
export function useWorkspaceSessions(
  options: UseWorkspaceSessionsOptions,
): UseWorkspaceSessionsResult<Session | SessionListEntry>;
export function useWorkspaceSessions(
  options: UseWorkspaceSessionsOptions = {},
): UseWorkspaceSessionsResult<Session | SessionListEntry> {
  const { client, workspaceId } = useOpenGeni(options);
  const projection = options.projection;
  const limit = options.limit;
  const parentSessionId = options.parentSessionId;
  const cursor = options.cursor;
  const search = options.search;
  const pinsOnly = options.pinsOnly;
  const includePinned = options.includePinned;
  const archivedOnly = options.archivedOnly;
  const sortBy = options.sortBy;
  const archiveStatus = options.archiveStatus;
  const enabled = options.enabled ?? true;
  const nextReadRevision = useRef(0);
  const nextReadGeneration = useRef(0);
  const beginRead = options.beginRead;
  const queryKey = [
    workspaceId,
    projection ?? "full",
    limit ?? "",
    parentSessionId === null ? "null" : (parentSessionId ?? ""),
    cursor ?? "",
    search ?? "",
    pinsOnly ? "1" : "",
    includePinned === false ? "no-pins" : "",
    archivedOnly ? "archived" : "active",
    sortBy ?? "",
    archiveStatus ?? "",
  ].join("\u0000");
  const previousQueryKey = useRef(queryKey);
  const queryKeyTransition = previousQueryKey.current !== queryKey;
  useEffect(() => {
    previousQueryKey.current = queryKey;
  }, [queryKey]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const readGeneration = beginRead?.() ?? ++nextReadGeneration.current;
      const query = {
        ...(limit !== undefined ? { limit } : {}),
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(search !== undefined ? { search } : {}),
        ...(pinsOnly ? { pinsOnly: true } : {}),
        ...(includePinned === false ? { includePinned: false } : {}),
        ...(archivedOnly ? { archivedOnly: true } : {}),
        ...(sortBy ? { sortBy } : {}),
        ...(archiveStatus ? { archiveStatus } : {}),
        signal,
      };
      const page =
        projection === "summary"
          ? client.listSessionSummaryPage
            ? await client.listSessionSummaryPage(workspaceId, query)
            : await client.listSessionPage(workspaceId, query).then(async (full) => {
                const { sessionListEntry } = await import("@opengeni/sdk/session-list-entries");
                return {
                  ...full,
                  pinned: full.pinned.map(sessionListEntry),
                  sessions: full.sessions.map(sessionListEntry),
                };
              })
          : await client.listSessionPage(workspaceId, query);
      return {
        queryKey,
        page,
        revision: ++nextReadRevision.current,
        readGeneration,
      };
    },
    [
      beginRead,
      client,
      workspaceId,
      projection,
      limit,
      parentSessionId,
      cursor,
      search,
      pinsOnly,
      includePinned,
      archivedOnly,
      sortBy,
      archiveStatus,
      queryKey,
    ],
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
    pinnedTruncated: page?.pinnedTruncated ?? false,
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
    readRevision: page ? (state.data?.revision ?? 0) : 0,
    readGeneration: page ? (state.data?.readGeneration ?? 0) : 0,
    refresh: state.refresh,
  };
}
