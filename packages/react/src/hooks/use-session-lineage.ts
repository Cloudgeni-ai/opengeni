import type { ChatClient } from "@opengeni/sdk";
import type {
  SessionEvent,
  ChatSessionLineageResponse as SessionLineageResponse,
  SessionLineageResponse as FullSessionLineageResponse,
  OpenGeniClient,
} from "@opengeni/sdk";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { MOUNT_READ_REUSE_MS } from "../lib/mount-read-reuse";
import {
  useEmbeddedSessionLineage,
  type EmbeddedSessionLineageClientOverride,
} from "../session-context";
import { deniesRetainedView, useRetainedSessionView } from "./session-view-cache";
import {
  projectionReadThrough,
  useDebouncedCallback,
  usePolledValue,
  useSessionEventTrigger,
} from "./internal";

export type UseSessionLineageOptions<Client extends ChatClient = OpenGeniClient> =
  EmbeddedSessionLineageClientOverride<Client> & {
    events?: SessionEvent[] | undefined;
    /** Refresh interval (ms). Off by default. */
    pollIntervalMs?: number | undefined;
    enabled?: boolean | undefined;
    /** Optional shared causal clock invoked when each network read starts. */
    beginRead?: (() => number) | undefined;
    /**
     * Who is reading (an identity key). Readers mounted together with the same
     * client, viewer, workspace and session take one another's latest read
     * for their first read; without it every reader reads its own.
     */
    viewer?: string | undefined;
  };

export type UseSessionLineageResult<L extends SessionLineageResponse = FullSessionLineageResponse> =
  {
    lineage: L | null;
    loading: boolean;
    error: Error | null;
    /** Causal generation captured when the accepted lineage read started. */
    readGeneration: number;
    refresh: () => Promise<void>;
  };

export function isLineageRefreshEvent(event: SessionEvent): boolean {
  if (event.type === "session.status.changed" || event.type === "session.created") {
    return true;
  }
  // A child's creation never appears on the PARENT's stream as session.created —
  // the parent sees its own spawn as an agent.toolCall.* for session_create.
  // Created events are handled separately so they can refresh immediately and
  // once after the child row has had time to commit.
  if (event.type === "agent.toolCall.output") {
    const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
    const name =
      typeof payload?.name === "string"
        ? payload.name
        : typeof payload?.toolName === "string"
          ? payload.toolName
          : "";
    return name === "session_create" || name.endsWith("__session_create");
  }
  return false;
}

function isSessionCreateToolCallCreated(event: SessionEvent): boolean {
  if (event.type !== "agent.toolCall.created") {
    return false;
  }
  const payload = event.payload as { name?: unknown; toolName?: unknown } | null | undefined;
  const name =
    typeof payload?.name === "string"
      ? payload.name
      : typeof payload?.toolName === "string"
        ? payload.toolName
        : "";
  return name === "session_create" || name.endsWith("__session_create");
}

type LineageRead = {
  lineage: SessionLineageResponse;
  readGeneration: number;
};

type PublishedLineageRead = {
  /** Resolves null when the read failed or was not stamped by the shared clock. */
  read: Promise<LineageRead | null>;
  /** When the read settled (epoch ms), or null while it is in flight. */
  settledAt: number | null;
};

type LineageReaders = {
  /** The mounted readers (hook instances) of this viewer's session lineage. */
  readers: Set<object>;
  /** The latest read any of them started, in flight or settled. */
  latest: PublishedLineageRead | null;
};

// The chat page, the session rail and the mobile header each read the open
// chat's lineage; the rail and the header learn the chat moments after the
// page's read started. While readers of one viewer's session are mounted
// together, a reader's first read takes the latest read any of them started
// (joining it in flight) instead of sending another. Nothing outlives its
// readers: the last one unmounting drops the entry. Only reads stamped by the
// client's shared read clock are taken, so a reader orders one exactly as if
// it had joined that read in flight.
const lineageReaders = new WeakMap<object, Map<string, LineageReaders>>();

function lineageReadersKey(viewer: string, workspaceId: string, sessionId: string): string {
  return JSON.stringify([viewer, workspaceId, sessionId]);
}

function registerLineageReader(client: object, key: string, reader: object): () => void {
  let entries = lineageReaders.get(client);
  if (!entries) {
    entries = new Map();
    lineageReaders.set(client, entries);
  }
  let entry = entries.get(key);
  if (!entry) {
    entry = { readers: new Set(), latest: null };
    entries.set(key, entry);
  }
  const registered = entry;
  registered.readers.add(reader);
  return () => {
    registered.readers.delete(reader);
    if (registered.readers.size === 0 && entries.get(key) === registered) entries.delete(key);
  };
}

/** The latest read another mounted reader started, joined until it settles; null to read anew. */
async function joinLineageRead(
  client: object,
  key: string,
  reader: object,
): Promise<LineageRead | null> {
  const entry = lineageReaders.get(client)?.get(key);
  if (!entry?.readers.has(reader) || entry.readers.size < 2) return null;
  let joined = entry.latest;
  if (
    !joined ||
    (joined.settledAt !== null && Date.now() - joined.settledAt >= MOUNT_READ_REUSE_MS)
  ) {
    return null;
  }
  for (;;) {
    const result = await joined.read;
    // A newer read started meanwhile (a refresh): take that one instead.
    const newest: PublishedLineageRead | null = entry.latest;
    if (newest && newest !== joined) {
      joined = newest;
      continue;
    }
    return entry.readers.has(reader) ? result : null;
  }
}

function publishLineageRead(
  client: object,
  key: string,
  reader: object,
  read: Promise<LineageRead | null>,
): void {
  const entry = lineageReaders.get(client)?.get(key);
  if (!entry?.readers.has(reader)) return;
  const published: PublishedLineageRead = { read, settledAt: null };
  entry.latest = published;
  void read.then((result) => {
    if (entry.latest !== published) return;
    if (result) published.settledAt = Date.now();
    else entry.latest = null;
  });
}

/** Read the ancestors + descendant tree for one session. Data-only; no UI state. */
export function useSessionLineage(
  sessionId: string | null | undefined,
  options?: UseSessionLineageOptions,
): UseSessionLineageResult;
export function useSessionLineage(
  sessionId: string | null | undefined,
  options: UseSessionLineageOptions<ChatClient>,
): UseSessionLineageResult<SessionLineageResponse>;
export function useSessionLineage(
  sessionId: string | null | undefined,
  options: UseSessionLineageOptions<ChatClient> = {},
): UseSessionLineageResult<SessionLineageResponse> {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useEmbeddedSessionLineage(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const nextReadGeneration = useRef(0);
  const beginRead = options.beginRead;
  const viewer = options.viewer;
  const reader = useRef<object>({}).current;
  const readersKey =
    enabled && viewer !== undefined && sessionId
      ? lineageReadersKey(viewer, workspaceId, sessionId)
      : null;
  // Registered in the layout phase, so a reader is mounted before any reader's
  // first read starts in the same commit.
  useLayoutEffect(() => {
    if (readersKey === null) return;
    return registerLineageReader(client, readersKey, reader);
  }, [client, reader, readersKey]);
  const load = useMemo(() => {
    // A reader's first read for this session (on mount or when it learns the
    // session) takes the latest read of another mounted reader; every later
    // read (refreshes, polls, live events, the page shown again) reads anew.
    let first = true;
    return async (signal?: AbortSignal) => {
      if (!sessionId) {
        return {
          lineage: { ancestors: [], children: [], truncated: false },
          readGeneration: 0,
        };
      }
      const mayReuse = first;
      first = false;
      if (readersKey !== null && mayReuse) {
        const joined = await joinLineageRead(client, readersKey, reader);
        if (joined) return joined;
      }
      let readGeneration = 0;
      let shared = false;
      const request = client.getSessionLineage(workspaceId, sessionId, {
        signal,
        onRequestStart: (sharedReadGeneration) => {
          shared = sharedReadGeneration !== undefined;
          readGeneration = sharedReadGeneration ?? beginRead?.() ?? ++nextReadGeneration.current;
        },
      });
      if (readersKey !== null) {
        publishLineageRead(
          client,
          readersKey,
          reader,
          request.then(
            (lineage) => (shared ? { lineage, readGeneration } : null),
            () => null,
          ),
        );
      }
      const lineage = await request;
      return {
        lineage,
        readGeneration,
      };
    };
  }, [beginRead, client, reader, readersKey, workspaceId, sessionId]);
  const state = usePolledValue(load, { pollIntervalMs: options.pollIntervalMs, enabled });
  const refresh = state.refresh;
  useEffect(() => {
    if (enabled && workspaceControlEvent) void refresh();
  }, [enabled, refresh, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "lineage", refresh);
  }, [enabled, refresh, registerSessionReconciler, sessionId]);
  const refreshSoon = useDebouncedCallback(() => void refresh(), 150);
  const delayedChildRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear a pending delayed refresh on session/workspace SWITCH (not just
  // unmount): otherwise a timer scheduled for the previous session can fire
  // ~2.5s later and commit that session's lineage onto the new one.
  useEffect(() => {
    return () => {
      if (delayedChildRefreshRef.current !== null) {
        clearTimeout(delayedChildRefreshRef.current);
        delayedChildRefreshRef.current = null;
      }
    };
  }, [sessionId, workspaceId]);
  const refreshAfterChildCreate = useCallback(() => {
    void refresh();
    if (delayedChildRefreshRef.current !== null) {
      clearTimeout(delayedChildRefreshRef.current);
    }
    delayedChildRefreshRef.current = setTimeout(() => {
      delayedChildRefreshRef.current = null;
      void refresh();
    }, 2500);
  }, [refresh]);
  // Lineage reflects this session's events through the sequence its read
  // observed; only a later spawn or status change can add or move children.
  const readThrough = projectionReadThrough(state.data?.lineage, state.loading);
  useSessionEventTrigger(
    client,
    workspaceId,
    sessionId,
    isLineageRefreshEvent,
    refreshSoon,
    // SHARED-FEED ONLY: without a caller-provided events log the trigger would
    // open its OWN streamEvents tail — a second live SSE connection next to the
    // session route's useSessionEvents. A caller with no feed opts into polling
    // (pollIntervalMs), never a duplicate stream.
    {
      events: options.events,
      enabled: enabled && options.events !== undefined,
      readThrough,
      refresh: refreshSoon,
    },
  );
  // A spawn's child row can commit after the lineage read even when the tool
  // call started before it, so a spawn still in flight always refreshes (now
  // and once more shortly after). A finished spawn is covered by its output
  // event, which the watermark above settles.
  const feedRef = useRef(options.events);
  useLayoutEffect(() => {
    feedRef.current = options.events;
  }, [options.events]);
  const isSpawnInFlight = useCallback((event: SessionEvent) => {
    if (!isSessionCreateToolCallCreated(event)) return false;
    const callId = (event.payload as { id?: unknown } | null | undefined)?.id;
    if (typeof callId !== "string") return true;
    return !(feedRef.current ?? []).some(
      (item) =>
        item.type === "agent.toolCall.output" &&
        (item.payload as { id?: unknown } | null | undefined)?.id === callId,
    );
  }, []);
  useSessionEventTrigger(client, workspaceId, sessionId, isSpawnInFlight, refreshAfterChildCreate, {
    events: options.events,
    enabled: enabled && options.events !== undefined,
  });
  // Until the first read lands, show the lineage as it was when this
  // conversation was last left (only when the host retains reads).
  const retainedLineage = useRetainedSessionView(
    client,
    workspaceId,
    sessionId,
    "lineage",
    state.data?.lineage ?? null,
    { enabled, discard: deniesRetainedView(state.error) },
  );
  return {
    lineage: state.data?.lineage ?? retainedLineage,
    loading: state.loading && retainedLineage === null,
    error: state.error,
    readGeneration: state.data?.readGeneration ?? 0,
    refresh,
  };
}
