import type {
  SessionEvent,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import {
  createHumanInputStore,
  isHumanInputEvent as isSdkHumanInputEvent,
} from "@opengeni/sdk/session";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  useEmbeddedHumanInputSession,
  type EmbeddedHumanInputClientOverride,
} from "../session-context";
import { useOwnedExternalStore, type SessionEventFeedOptions } from "./internal";

/** Events that can create, settle, or invalidate an actionable request. */
export function isHumanInputEvent(event: Pick<SessionEvent, "type">): boolean {
  return isSdkHumanInputEvent(event);
}

export type UseHumanInputRequestsOptions = EmbeddedHumanInputClientOverride &
  SessionEventFeedOptions & {
    /** Optional safety-net polling. Durable events drive refresh by default. */
    pollIntervalMs?: number | undefined;
  };

export type UseHumanInputRequestsResult = {
  requests: SessionHumanInputRequest[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  respond: (
    requestId: string,
    response: SubmitHumanInputResponseRequest,
  ) => Promise<SessionEvent | null>;
  respondingRequestId: string | null;
  mutationError: Error | null;
  clearMutationError: () => void;
};

/** React compatibility adapter over the authoritative structured-input controller. */
export function useHumanInputRequests(
  sessionId: string | null | undefined,
  options: UseHumanInputRequestsOptions = {},
): UseHumanInputRequestsResult {
  const { client, workspaceId, registerSessionReconciler } = useEmbeddedHumanInputSession(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const sharedFeed = options.events !== undefined;
  const latestEvents = useRef(options.events);
  latestEvents.current = options.events;
  const store = useMemo(
    () =>
      createHumanInputStore({
        client,
        workspaceId,
        sessionId,
        enabled,
        ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
        ...(sharedFeed ? { events: latestEvents.current ?? [] } : {}),
      }),
    [client, enabled, options.pollIntervalMs, sessionId, sharedFeed, workspaceId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);

  useEffect(() => {
    if (options.events !== undefined) store.applyEvents(options.events);
  }, [options.events, store]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    return registerSessionReconciler(sessionId, "human-input", store.refresh);
  }, [enabled, registerSessionReconciler, sessionId, store]);

  return {
    requests: snapshot.requests as SessionHumanInputRequest[],
    loading: snapshot.loading,
    error: snapshot.error,
    refresh: store.refresh,
    respond: store.respond,
    respondingRequestId: snapshot.respondingRequestId,
    mutationError: snapshot.mutationError,
    clearMutationError: store.clearMutationError,
  };
}
