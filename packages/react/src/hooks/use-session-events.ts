import type {
  SessionEvent,
  SessionEventPayloadMode,
  SessionStatus,
  StreamConnectionState,
} from "@opengeni/sdk";
import {
  SESSION_EVENT_BROWSER_MAX_BYTES as SDK_SESSION_EVENT_BROWSER_MAX_BYTES,
  SESSION_EVENT_BROWSER_MAX_COUNT as SDK_SESSION_EVENT_BROWSER_MAX_COUNT,
  SESSION_EVENT_BROWSER_PENDING_MAX_BYTES as SDK_SESSION_EVENT_BROWSER_PENDING_MAX_BYTES,
  SESSION_EVENT_BROWSER_PENDING_MAX_COUNT as SDK_SESSION_EVENT_BROWSER_PENDING_MAX_COUNT,
  SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES as SDK_SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES,
  boundSessionEventWindow,
  createSessionEventStore,
} from "@opengeni/sdk/session";
import { useMemo, useSyncExternalStore } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import type { OlderHistoryLoadReceipt } from "../older-history";
import { buildTimeline } from "../timeline/projection";
import type { TimelineItem } from "../timeline/types";
import { useOwnedExternalStore } from "./internal";

export type SessionEventsConnectionState = StreamConnectionState | "idle" | "ended" | "error";

export type UseSessionEventsOptions = EmbeddedSessionClientOverride & {
  /** Resume after this sequence (exclusive). Nonzero keeps full replay/resume semantics. */
  after?: number | undefined;
  /** Load a bounded tail by default, or opt back into full replay from `after`. */
  replay?: "windowed" | "full" | undefined;
  /** Pause the stream without unmounting (e.g. hidden tab). Defaults to true. */
  enabled?: boolean | undefined;
};

export type UseSessionEventsResult = {
  /** Replayed + live events, ordered by sequence, no gaps, no duplicates. */
  events: SessionEvent[];
  /** Projected, renderable timeline (memoized over `events`). */
  timeline: TimelineItem[];
  /** Latest session status observed in the event log, if any. */
  sessionStatus: SessionStatus | null;
  connectionState: SessionEventsConnectionState;
  /** Highest sequence seen so far (0 before the first event). */
  lastSequence: number;
  /** Exact serialized bytes retained in the current browser event window. */
  windowBytes: number;
  /** Whether older delivered events were evicted from the browser window. */
  windowTruncated: boolean;
  /** True until the initial tail window has been applied (windowed mode). */
  initialLoading: boolean;
  /** Whether older durable events are available before the current window. */
  hasOlder: boolean;
  /** True while an older window is being fetched. */
  loadingOlder: boolean;
  /** Prepend an older density-bounded window; resolves true when more remain. */
  loadOlder: () => OlderHistoryLoadReceipt;
  /** Durable events exist after the current history window. */
  hasNewer: boolean;
  /** True while a newer history page is being fetched. */
  loadingNewer: boolean;
  /** Append one density-bounded newer page. */
  loadNewer: () => Promise<boolean>;
  /** True while replacing the window with the session start. */
  loadingOldest: boolean;
  /** Jump to the durable session start without walking the middle gap. */
  loadOldest: () => Promise<boolean>;
  /** True while reloading the live tip window. */
  loadingLatest: boolean;
  /** Reload the newest bounded tip and resume live streaming. */
  jumpToLatest: () => Promise<void>;
  error: Error | null;
};

export const SESSION_EVENT_BROWSER_MAX_BYTES = SDK_SESSION_EVENT_BROWSER_MAX_BYTES;
export const SESSION_EVENT_BROWSER_MAX_COUNT = SDK_SESSION_EVENT_BROWSER_MAX_COUNT;
export const SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES =
  SDK_SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES;
export const SESSION_EVENT_BROWSER_PENDING_MAX_BYTES = SDK_SESSION_EVENT_BROWSER_PENDING_MAX_BYTES;
export const SESSION_EVENT_BROWSER_PENDING_MAX_COUNT = SDK_SESSION_EVENT_BROWSER_PENDING_MAX_COUNT;

export type BrowserSessionEventWindow = {
  events: SessionEvent[];
  bytes: number;
  truncated: boolean;
};

/** Compatibility wrapper over the framework-neutral browser event boundary. */
export function boundBrowserSessionEventWindow(
  events: readonly SessionEvent[],
  options: {
    maxBytes?: number;
    maxCount?: number;
    direction?: "newest" | "oldest";
  } = {},
): BrowserSessionEventWindow {
  const window = boundSessionEventWindow(events, options);
  return { events: [...window.events], bytes: window.bytes, truncated: window.truncated };
}

/** React compatibility adapter over the framework-neutral event/history controller. */
export function useSessionEvents(
  sessionId: string | null | undefined,
  options: UseSessionEventsOptions = {},
): UseSessionEventsResult {
  const { client, workspaceId, reconcileSession } = useEmbeddedSession(options);
  const enabled = options.enabled ?? true;
  const after = options.after ?? 0;
  const replay = options.replay ?? "windowed";
  const store = useMemo(
    () =>
      createSessionEventStore({
        client,
        workspaceId,
        sessionId,
        enabled,
        after,
        replay,
        reconcile: sessionId ? async () => await reconcileSession(sessionId) : undefined,
      }),
    [after, client, enabled, reconcileSession, replay, sessionId, workspaceId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useOwnedExternalStore(store);
  const events = snapshot.events as SessionEvent[];
  const timeline = useMemo(() => buildTimeline(events), [events]);

  return {
    events,
    timeline,
    sessionStatus: snapshot.sessionStatus,
    connectionState: snapshot.connectionState,
    lastSequence: snapshot.lastSequence,
    windowBytes: snapshot.windowBytes,
    windowTruncated: snapshot.windowTruncated,
    initialLoading: snapshot.initialLoading,
    hasOlder: snapshot.hasOlder,
    loadingOlder: snapshot.loadingOlder,
    loadOlder: store.loadOlder,
    hasNewer: snapshot.hasNewer,
    loadingNewer: snapshot.loadingNewer,
    loadNewer: store.loadNewer,
    loadingOldest: snapshot.loadingOldest,
    loadOldest: store.loadOldest,
    loadingLatest: snapshot.loadingLatest,
    jumpToLatest: store.jumpToLatest,
    error: snapshot.error,
  };
}

// Preserve this import in the generated declaration surface used by existing consumers.
export type { SessionEventPayloadMode };
