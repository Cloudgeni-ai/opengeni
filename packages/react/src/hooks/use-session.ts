import type { Session, SessionEvent } from "@opengeni/sdk";
import { createSessionResourceStore, isTitleEvent as isSdkTitleEvent } from "@opengeni/sdk/session";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useEmbeddedSessionRead, type EmbeddedSessionReadClientOverride } from "../session-context";
import { useOwnedExternalStore, type SessionEventFeedOptions } from "./internal";

export type UseSessionOptions = EmbeddedSessionReadClientOverride &
  SessionEventFeedOptions & {
    /** Re-fetch on an interval (ms). Off by default — pair with `useSessionEvents` for live status. */
    pollIntervalMs?: number | undefined;
    /** Optional shared causal clock invoked when each network read starts. */
    beginRead?: (() => number) | undefined;
  };

export type UseSessionResult = {
  session: Session | null;
  loading: boolean;
  error: Error | null;
  /** Monotonic revision of accepted authoritative detail reads. */
  readRevision: number;
  /** Causal generation captured when the accepted network read started. */
  readGeneration: number;
  refresh: () => Promise<void>;
  /** Manually rename the session (PATCH, source='user'). Returns the updated session, or null on failure. */
  updateTitle: (title: string) => Promise<Session | null>;
  /** True while a rename is in flight. */
  updating: boolean;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/** Event types that change the session title (auto + cross-client renames). */
export function isTitleEvent(event: Pick<SessionEvent, "type">): boolean {
  return isSdkTitleEvent(event);
}

/** React compatibility adapter over the framework-neutral session resource controller. */
export function useSession(
  sessionId: string | null | undefined,
  options: UseSessionOptions = {},
): UseSessionResult {
  const { client, workspaceId, workspaceControlEvent, registerSessionReconciler } =
    useEmbeddedSessionRead(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedFeed = options.events !== undefined;
  const latestEvents = useRef(options.events);
  latestEvents.current = options.events;
  const store = useMemo(
    () =>
      createSessionResourceStore({
        client,
        workspaceId,
        sessionId,
        enabled,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(options.beginRead === undefined ? {} : { beginRead: options.beginRead }),
        ...(sharedFeed ? { events: latestEvents.current ?? [] } : {}),
      }),
    [
      client,
      enabled,
      options.beginRead,
      options.pollIntervalMs,
      sessionId,
      sharedFeed,
      workspaceId,
    ],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);

  useEffect(() => {
    if (options.events !== undefined) store.applyEvents(options.events);
  }, [options.events, store]);
  useEffect(() => {
    if (enabled && workspaceControlEvent) void store.refresh();
  }, [enabled, store, workspaceControlEvent]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "session", store.refresh);
  }, [enabled, registerSessionReconciler, sessionId, store]);

  return {
    session: snapshot.value,
    loading: snapshot.loading,
    error: snapshot.error,
    readRevision: snapshot.readRevision,
    readGeneration: snapshot.readGeneration,
    refresh: store.refresh,
    updateTitle: store.updateTitle,
    updating: snapshot.updating,
    mutationError: snapshot.mutationError,
    clearMutationError: store.clearMutationError,
  };
}
