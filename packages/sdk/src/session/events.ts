import type { SessionEvent, SessionStatus } from "../types";
import type { SessionEventClientLike } from "./client";
import type { SessionRuntimeEnvironment } from "./environment";
import { defaultSessionRuntimeEnvironment } from "./environment";
import {
  boundSessionEvent,
  boundSessionEventWindow,
  eventResumeSequence,
  SESSION_EVENT_BROWSER_PENDING_MAX_BYTES,
  SESSION_EVENT_BROWSER_PENDING_MAX_COUNT,
  sessionEventWindowBytes,
  type BrowserSessionEventWindow,
} from "./event-window";
import { createOlderHistoryLoadReceipt, type OlderHistoryLoadReceipt } from "./older-history";
import { asError } from "./resource";
import {
  createExternalStore,
  type OpenGeniExternalStore,
  type OpenGeniStoreDiagnostics,
} from "./store";
import { buildTimeline, groupTimeline, sessionStatusFromEvents } from "./timeline/projection";

const INITIAL_TAIL_PAGE_SIZE = 1000;
const OLDER_PAGE_SIZE = 5000;
const NEWER_PAGE_SIZE = 5000;
const OLDEST_PAGE_SIZE = 1000;
const INITIAL_FETCH_CAP = 1;
const OLDER_GROUP_TARGET = 32;
const OLDER_FETCH_CAP = 2;
const NEWER_GROUP_TARGET = 32;
const NEWER_FETCH_CAP = 2;
const OLDEST_GROUP_TARGET = 32;
const OLDEST_FETCH_CAP = 2;
const BOUNDARY_PAGE_CAP = 4;

export type SessionEventsConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "ended"
  | "error";

export type SessionEventStoreSnapshot = Readonly<{
  events: readonly SessionEvent[];
  eventWindow: BrowserSessionEventWindow;
  connectionState: SessionEventsConnectionState;
  sessionStatus: SessionStatus | null;
  lastSequence: number;
  windowBytes: number;
  windowTruncated: boolean;
  initialLoading: boolean;
  loadingOlder: boolean;
  loadingNewer: boolean;
  loadingOldest: boolean;
  loadingLatest: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
  viewMode: "live" | "history";
  oldestSequence: number | null;
  newestSequence: number | null;
  resumeSequence: number;
  error: Error | null;
}>;

export type SessionEventStore = OpenGeniExternalStore<SessionEventStoreSnapshot> & {
  loadOlder(): OlderHistoryLoadReceipt;
  loadNewer(): Promise<boolean>;
  loadOldest(): Promise<boolean>;
  jumpToLatest(): Promise<void>;
  refresh(): Promise<void>;
  diagnostics(): OpenGeniStoreDiagnostics;
};

export function createSessionEventStore(options: {
  client: SessionEventClientLike;
  workspaceId: string;
  sessionId: string | null | undefined;
  enabled?: boolean;
  after?: number;
  replay?: "windowed" | "full";
  reconcile?: (() => void | Promise<void>) | undefined;
  hiddenGraceMs?: number;
  environment?: SessionRuntimeEnvironment;
}): SessionEventStore {
  const environment = options.environment ?? defaultSessionRuntimeEnvironment();
  const sessionId = options.sessionId ?? "";
  const enabled = (options.enabled ?? true) && sessionId.length > 0;
  const after = options.after ?? 0;
  const fullReplay = options.replay === "full" || after !== 0;
  let generation = 0;
  let cycleGeneration = 0;
  let pageLive = true;
  let eventWindow = boundSessionEventWindow([]);
  let connectionState: SessionEventsConnectionState = "idle";
  let error: Error | null = null;
  let hasOlder = false;
  let hasNewer = false;
  let sessionStatus: SessionStatus | null = null;
  let statusSequence = after;
  let initialLoading = enabled && !fullReplay;
  let loadingOlder = false;
  let loadingNewer = false;
  let loadingOldest = false;
  let loadingLatest = false;
  let viewMode: "live" | "history" = "live";
  let lastSequence = after;
  let streamResumeSequence = after;
  let oldestSequence: number | null = null;
  let newestSequence: number | null = null;
  let initialWindowLoaded = false;
  let streamAbort: AbortController | null = null;
  let streamIterator: AsyncIterator<SessionEvent> | null = null;
  let flushTimer: unknown;
  let pending: SessionEvent[] = [];
  let pendingBytes = 2;
  let pendingInitialPublishCycle: number | null = null;
  let hiddenTimer: unknown;
  let visibilityUnsubscribe: (() => void) | undefined;

  const snapshot = (): SessionEventStoreSnapshot => ({
    events: eventWindow.events,
    eventWindow,
    connectionState,
    sessionStatus,
    lastSequence,
    windowBytes: eventWindow.bytes,
    windowTruncated: eventWindow.truncated,
    initialLoading: fullReplay ? false : initialLoading,
    loadingOlder,
    loadingNewer,
    loadingOldest,
    loadingLatest,
    hasOlder,
    hasNewer,
    viewMode,
    oldestSequence,
    newestSequence,
    resumeSequence: streamResumeSequence,
    error,
  });

  const store = createExternalStore<SessionEventStoreSnapshot>({
    initialSnapshot: snapshot(),
    start: async () => {
      if (!enabled) {
        initialLoading = false;
        emit();
        return;
      }
      if (environment.visibility) {
        visibilityUnsubscribe = environment.visibility.subscribe(syncVisibility);
        store.trackListener(1);
        syncVisibility();
      }
      await startLiveCycle();
    },
    destroy: () => {
      generation += 1;
      stopStream();
      clearHiddenTimer();
      if (visibilityUnsubscribe) {
        visibilityUnsubscribe();
        visibilityUnsubscribe = undefined;
        store.trackListener(-1);
      }
    },
  });

  const emit = (): void => store.publish(snapshot());

  const startLiveCycle = async (): Promise<void> => {
    if (!enabled || !pageLive || store.signal.aborted) return;
    if (viewMode === "history") {
      connectionState = "idle";
      initialLoading = false;
      emit();
      return;
    }
    const owned = ++cycleGeneration;
    stopStream(false);
    const ownedAbort = new AbortController();
    streamAbort = ownedAbort;
    const isCurrent = () =>
      owned === cycleGeneration && !ownedAbort.signal.aborted && !store.signal.aborted;
    connectionState = "connecting";
    emit();
    try {
      if (!fullReplay && !initialWindowLoaded) {
        const window = await store.trackRead(() =>
          loadEventWindow(options.client, options.workspaceId, sessionId, {
            before: Number.MAX_SAFE_INTEGER,
            pageSize: INITIAL_TAIL_PAGE_SIZE,
            targetGroups: Number.POSITIVE_INFINITY,
            maxFetches: INITIAL_FETCH_CAP,
            signal: ownedAbort.signal,
          }),
        );
        if (!isCurrent()) return;
        observeStatus(window.events);
        eventWindow = boundSessionEventWindow(window.events);
        oldestSequence = eventWindow.events[0]?.sequence ?? window.oldestSequence;
        newestSequence = maxResumeSequenceOrNull(eventWindow.events) ?? window.newestSequence;
        hasOlder = window.hasOlder || eventWindow.truncated;
        hasNewer = false;
        lastSequence = window.newestSequence;
        streamResumeSequence = window.newestSequence;
        initialWindowLoaded = true;
        initialLoading = false;
        pendingInitialPublishCycle = owned;
      }
      if (fullReplay) initialLoading = false;
      if (!isCurrent()) return;
      startStreamTask(owned, ownedAbort);
      queueMicrotask(() => {
        if (isCurrent() && pendingInitialPublishCycle === owned) emitStreamCycle(owned);
      });
    } catch (cause) {
      if (!isCurrent()) return;
      error = asError(cause);
      connectionState = "error";
      initialLoading = false;
      emit();
    }
  };

  const startStreamTask = (owned: number, ownedAbort: AbortController): void => {
    const isCurrent = () =>
      owned === cycleGeneration && !ownedAbort.signal.aborted && !store.signal.aborted;
    void store.trackStream(async () => {
      try {
        const stream = options.client.streamEvents(options.workspaceId, sessionId, {
          after: streamResumeSequence,
          signal: ownedAbort.signal,
          onOpen: () => {
            if (!isCurrent()) return;
            void Promise.resolve()
              .then(() => options.reconcile?.())
              .catch((cause) => {
                if (!isCurrent()) return;
                error = asError(cause);
                emitStreamCycle(owned);
              });
          },
          onStateChange: (state) => {
            if (!isCurrent()) return;
            connectionState = state;
            emitStreamCycle(owned);
          },
        });
        const iterator = stream[Symbol.asyncIterator]();
        streamIterator = iterator;
        while (isCurrent()) {
          const next = await iterator.next();
          if (next.done) break;
          const bounded = boundSessionEvent(next.value);
          const boundedBytes = sessionEventWindowBytes(bounded);
          const separatorBytes = pending.length === 0 ? 0 : 1;
          if (
            pending.length > 0 &&
            (pending.length >= SESSION_EVENT_BROWSER_PENDING_MAX_COUNT ||
              pendingBytes + separatorBytes + boundedBytes >
                SESSION_EVENT_BROWSER_PENDING_MAX_BYTES)
          ) {
            flushPending(owned);
          }
          pending.push(bounded);
          pendingBytes += (pending.length === 1 ? 0 : 1) + boundedBytes;
          if (
            pending.length >= SESSION_EVENT_BROWSER_PENDING_MAX_COUNT ||
            pendingBytes >= SESSION_EVENT_BROWSER_PENDING_MAX_BYTES
          ) {
            flushPending(owned);
          } else {
            scheduleFlush(owned);
          }
        }
        if (isCurrent()) {
          flushPending(owned);
          connectionState = "ended";
          emitStreamCycle(owned);
        }
      } catch (cause) {
        if (!isCurrent()) return;
        flushPending(owned);
        error = asError(cause);
        connectionState = "error";
        initialLoading = false;
        emitStreamCycle(owned);
      } finally {
        if (owned === cycleGeneration) {
          streamAbort = null;
          streamIterator = null;
        }
      }
    });
  };

  const scheduleFlush = (owned: number): void => {
    if (owned !== cycleGeneration || store.signal.aborted || flushTimer !== undefined) return;
    store.trackTimer(1);
    flushTimer = environment.clock.setTimeout(() => {
      flushTimer = undefined;
      store.trackTimer(-1);
      flushPending(owned);
    }, 16);
  };

  const flushPending = (owned: number): void => {
    clearFlushTimer();
    if (owned !== cycleGeneration || store.signal.aborted) {
      pending = [];
      pendingBytes = 2;
      return;
    }
    if (pending.length === 0 || viewMode !== "live") return;
    const batch = pending;
    pending = [];
    pendingBytes = 2;
    const batchResume = maxResumeSequence(batch);
    lastSequence = Math.max(lastSequence, batchResume);
    streamResumeSequence = Math.max(streamResumeSequence, batchResume);
    observeStatus(batch);
    const next = boundSessionEventWindow([...eventWindow.events, ...batch]);
    eventWindow = Object.freeze({
      ...next,
      truncated: eventWindow.truncated || next.truncated,
    });
    oldestSequence = eventWindow.events[0]?.sequence ?? null;
    newestSequence = maxResumeSequenceOrNull(eventWindow.events);
    if (eventWindow.truncated) hasOlder = true;
    error = null;
    emitStreamCycle(owned);
  };

  const emitStreamCycle = (owned: number): void => {
    if (pendingInitialPublishCycle === owned) pendingInitialPublishCycle = null;
    emit();
  };

  function clearFlushTimer(): void {
    if (flushTimer === undefined) return;
    environment.clock.clearTimeout(flushTimer);
    flushTimer = undefined;
    store.trackTimer(-1);
  }

  function stopStream(incrementGeneration = true): void {
    if (incrementGeneration) cycleGeneration += 1;
    streamAbort?.abort();
    streamAbort = null;
    const iterator = streamIterator;
    streamIterator = null;
    if (iterator?.return) void iterator.return().catch(() => undefined);
    clearFlushTimer();
    pending = [];
    pendingBytes = 2;
    pendingInitialPublishCycle = null;
  }

  const observeStatus = (events: readonly SessionEvent[]): void => {
    let latest: { sequence: number; status: SessionStatus } | null = null;
    for (const event of events) {
      const status = sessionStatusFromEvents([event]);
      if (status && (!latest || event.sequence >= latest.sequence)) {
        latest = { sequence: event.sequence, status };
      }
    }
    if (!latest || latest.sequence < statusSequence) return;
    statusSequence = latest.sequence;
    sessionStatus = latest.status;
  };

  const navigationBusy = (): boolean =>
    loadingOlder || loadingNewer || loadingOldest || loadingLatest;

  const loadOlder = (): OlderHistoryLoadReceipt =>
    createOlderHistoryLoadReceipt(async (markCommitted) => {
      if (!enabled || navigationBusy() || !hasOlder || store.signal.aborted) return false;
      const before = oldestSequence;
      if (before === null) {
        hasOlder = false;
        emit();
        return false;
      }
      const ownedGeneration = generation;
      loadingOlder = true;
      emit();
      let published = false;
      try {
        const window = await store.trackRead(() =>
          loadEventWindow(options.client, options.workspaceId, sessionId, {
            before,
            pageSize: OLDER_PAGE_SIZE,
            targetGroups: OLDER_GROUP_TARGET,
            maxFetches: OLDER_FETCH_CAP,
          }),
        );
        if (ownedGeneration !== generation || store.signal.aborted) return false;
        if (window.events.length === 0) {
          oldestSequence = null;
          hasOlder = false;
          return false;
        }
        const current = eventWindow;
        assertPrependOrder([...current.events], window.events);
        stopStream();
        observeStatus(window.events);
        const next = boundSessionEventWindow([...window.events, ...current.events], {
          direction: "oldest",
        });
        const retained = Object.freeze({
          ...next,
          truncated: current.truncated || next.truncated,
        });
        const retainedOldest = retained.events[0]?.sequence ?? null;
        if (retainedOldest === null || retainedOldest >= before) {
          throw new Error("@opengeni/sdk: loadOlder made no durable sequence progress");
        }
        const retainedNewest = maxResumeSequenceOrNull(retained.events);
        const previousNewest = maxResumeSequenceOrNull(current.events);
        eventWindow = retained;
        markCommitted();
        oldestSequence = retainedOldest;
        newestSequence = retainedNewest;
        streamResumeSequence = maxResumeSequence(retained.events);
        hasOlder = window.hasOlder;
        const evictedLiveTail =
          previousNewest !== null && retainedNewest !== null && retainedNewest < previousNewest;
        let reconnectLive = false;
        if (viewMode === "history" || evictedLiveTail) {
          hasNewer =
            retainedNewest !== null && (retainedNewest < lastSequence || retained.truncated);
          if (evictedLiveTail) {
            viewMode = "history";
            connectionState = "idle";
          }
        } else {
          reconnectLive = true;
        }
        loadingOlder = false;
        emit();
        published = true;
        if (reconnectLive) void startLiveCycle();
        return hasOlder;
      } finally {
        if (!published) {
          loadingOlder = false;
          emit();
        }
      }
    });

  const loadOldest = async (): Promise<boolean> => {
    if (!enabled || navigationBusy() || !hasOlder || store.signal.aborted) return false;
    const ownedGeneration = generation;
    loadingOldest = true;
    emit();
    let published = false;
    try {
      const window = await store.trackRead(() =>
        loadForwardEventWindow(options.client, options.workspaceId, sessionId, {
          after: 0,
          pageSize: OLDEST_PAGE_SIZE,
          targetGroups: OLDEST_GROUP_TARGET,
          maxFetches: OLDEST_FETCH_CAP,
        }),
      );
      if (ownedGeneration !== generation || store.signal.aborted) return false;
      if (window.events.length === 0) {
        hasOlder = false;
        return false;
      }
      stopStream();
      observeStatus(window.events);
      eventWindow = boundSessionEventWindow(window.events, { direction: "oldest" });
      oldestSequence = eventWindow.events[0]?.sequence ?? null;
      newestSequence = maxResumeSequenceOrNull(eventWindow.events);
      hasOlder = false;
      lastSequence = Math.max(lastSequence, newestSequence ?? 0);
      hasNewer =
        window.hasNewer ||
        eventWindow.truncated ||
        (newestSequence !== null && newestSequence < lastSequence);
      initialWindowLoaded = true;
      viewMode = "history";
      connectionState = "idle";
      loadingOldest = false;
      emit();
      published = true;
      return hasNewer;
    } finally {
      if (!published) {
        loadingOldest = false;
        emit();
      }
    }
  };

  const loadNewer = async (): Promise<boolean> => {
    if (!enabled || navigationBusy() || !hasNewer || store.signal.aborted) return false;
    const afterSequence = newestSequence;
    if (afterSequence === null) {
      hasNewer = false;
      emit();
      return false;
    }
    const ownedGeneration = generation;
    loadingNewer = true;
    emit();
    let published = false;
    try {
      const window = await store.trackRead(() =>
        loadForwardEventWindow(options.client, options.workspaceId, sessionId, {
          after: afterSequence,
          pageSize: NEWER_PAGE_SIZE,
          targetGroups: NEWER_GROUP_TARGET,
          maxFetches: NEWER_FETCH_CAP,
        }),
      );
      if (ownedGeneration !== generation || store.signal.aborted) return false;
      if (window.events.length === 0) {
        hasNewer = false;
        streamResumeSequence = afterSequence;
        viewMode = "live";
        loadingNewer = false;
        emit();
        published = true;
        void startLiveCycle();
        return false;
      }
      const current = eventWindow;
      assertAppendOrder([...current.events], window.events);
      observeStatus(window.events);
      const previousOldest = current.events[0]?.sequence ?? null;
      const next = boundSessionEventWindow([...current.events, ...window.events], {
        direction: "newest",
      });
      eventWindow = Object.freeze({
        ...next,
        truncated: current.truncated || next.truncated || window.hasNewer,
      });
      const retainedOldest = eventWindow.events[0]?.sequence ?? null;
      const retainedNewest = maxResumeSequenceOrNull(eventWindow.events);
      if (retainedNewest === null || retainedNewest <= afterSequence) {
        throw new Error("@opengeni/sdk: loadNewer made no durable sequence progress");
      }
      oldestSequence = retainedOldest;
      newestSequence = retainedNewest;
      if (
        retainedOldest !== null &&
        (previousOldest === null ||
          retainedOldest > previousOldest ||
          (eventWindow.truncated &&
            eventWindow.events[0]?.type !== "session.created" &&
            retainedOldest > 1))
      ) {
        hasOlder = true;
      }
      lastSequence = Math.max(lastSequence, retainedNewest);
      hasNewer = window.hasNewer || retainedNewest < lastSequence;
      let resumeLive = false;
      if (!hasNewer) {
        streamResumeSequence = retainedNewest;
        viewMode = "live";
        resumeLive = true;
      }
      loadingNewer = false;
      emit();
      published = true;
      if (resumeLive) void startLiveCycle();
      return hasNewer;
    } finally {
      if (!published) {
        loadingNewer = false;
        emit();
      }
    }
  };

  const jumpToLatest = async (): Promise<void> => {
    if (!enabled || navigationBusy() || store.signal.aborted) return;
    loadingLatest = true;
    emit();
    stopStream();
    hasNewer = false;
    hasOlder = false;
    newestSequence = null;
    oldestSequence = null;
    eventWindow = boundSessionEventWindow([]);
    initialWindowLoaded = false;
    streamResumeSequence = after;
    viewMode = "live";
    loadingLatest = false;
    initialLoading = !fullReplay;
    connectionState = "idle";
    emit();
    void startLiveCycle();
    await Promise.resolve();
  };

  const refresh = async (): Promise<void> => await jumpToLatest();

  const deactivate = (): void => {
    if (!pageLive) return;
    pageLive = false;
    generation += 1;
    stopStream();
    connectionState = "idle";
    loadingOlder = false;
    loadingNewer = false;
    loadingOldest = false;
    loadingLatest = false;
    emit();
  };

  function syncVisibility(): void {
    const visibility = environment.visibility;
    if (!visibility || store.signal.aborted) return;
    if (visibility.getState() === "visible") {
      clearHiddenTimer();
      if (pageLive) return;
      pageLive = true;
      void startLiveCycle();
      return;
    }
    if (!pageLive || hiddenTimer !== undefined) return;
    store.trackTimer(1);
    hiddenTimer = environment.clock.setTimeout(() => {
      hiddenTimer = undefined;
      store.trackTimer(-1);
      if (environment.visibility?.getState() === "hidden") deactivate();
    }, options.hiddenGraceMs ?? 2_000);
  }

  function clearHiddenTimer(): void {
    if (hiddenTimer === undefined) return;
    environment.clock.clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
    store.trackTimer(-1);
  }

  return Object.assign(store, {
    loadOlder,
    loadNewer,
    loadOldest,
    jumpToLatest,
    refresh,
    diagnostics: store.diagnostics,
  });
}

type LoadedEventWindow = {
  events: SessionEvent[];
  oldestSequence: number | null;
  newestSequence: number;
  hasOlder: boolean;
};

type LoadedForwardEventWindow = {
  events: SessionEvent[];
  oldestSequence: number | null;
  newestSequence: number;
  hasNewer: boolean;
};

async function loadEventWindow(
  client: SessionEventClientLike,
  workspaceId: string,
  sessionId: string,
  options: {
    before: number;
    pageSize: number;
    targetGroups: number;
    maxFetches: number;
    signal?: AbortSignal;
  },
): Promise<LoadedEventWindow> {
  let cursor = options.before;
  let buffer: SessionEvent[] = [];
  let reachedStart = false;
  let fetches = 0;
  while (fetches < options.maxFetches) {
    if (buffer.length > 0 && groupCount(buffer) >= options.targetGroups) break;
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    fetches += 1;
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page[0]!.sequence;
    if (isLogStart(page[0]!)) {
      reachedStart = true;
      break;
    }
  }
  let snapPages = 0;
  while (
    !reachedStart &&
    findBoundaryIndex(buffer) === -1 &&
    snapPages < BOUNDARY_PAGE_CAP &&
    fetches < options.maxFetches
  ) {
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    fetches += 1;
    snapPages += 1;
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page[0]!.sequence;
    if (isLogStart(page[0]!)) {
      reachedStart = true;
      break;
    }
  }
  if (!reachedStart) {
    const boundary = findBoundaryIndex(buffer);
    if (boundary > 0) buffer = buffer.slice(boundary);
  }
  const densityWindow = trimBackwardToGroupTarget(buffer, options.targetGroups);
  buffer = densityWindow.events;
  const oldest = buffer[0] ?? null;
  const newest = buffer.at(-1) ?? null;
  return {
    events: buffer,
    oldestSequence: oldest?.sequence ?? null,
    newestSequence: newest ? maxResumeSequence(buffer) : 0,
    hasOlder:
      buffer.length > 0 &&
      (densityWindow.trimmed || (!reachedStart && oldest?.type !== "session.created")),
  };
}

async function loadForwardEventWindow(
  client: SessionEventClientLike,
  workspaceId: string,
  sessionId: string,
  options: {
    after: number;
    pageSize: number;
    targetGroups: number;
    maxFetches: number;
    signal?: AbortSignal;
  },
): Promise<LoadedForwardEventWindow> {
  let cursor = options.after;
  let buffer: SessionEvent[] = [];
  let fetches = 0;
  let reachedEnd = false;
  while (fetches < options.maxFetches) {
    if (buffer.length > 0 && groupCount(buffer) >= options.targetGroups) break;
    const page = await loadNextPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    fetches += 1;
    if (page.length === 0) {
      reachedEnd = true;
      break;
    }
    assertAscending(page);
    buffer = [...buffer, ...page];
    cursor = maxResumeSequence(page);
  }
  const densityWindow = trimForwardToGroupTarget(buffer, options.targetGroups);
  buffer = densityWindow.events;
  const oldest = buffer[0] ?? null;
  const newest = buffer.at(-1) ?? null;
  return {
    events: buffer,
    oldestSequence: oldest?.sequence ?? null,
    newestSequence: newest ? maxResumeSequence(buffer) : 0,
    hasNewer: buffer.length > 0 && (densityWindow.trimmed || !reachedEnd),
  };
}

async function loadPreviousPage(
  client: SessionEventClientLike,
  workspaceId: string,
  sessionId: string,
  before: number,
  options: { pageSize: number; signal?: AbortSignal },
): Promise<SessionEvent[]> {
  if (options.signal?.aborted) throw abortError();
  if (options.pageSize === 0) return [];
  const page = await client.listEvents(workspaceId, sessionId, {
    before,
    limit: options.pageSize,
    compact: true,
    payloadMode: "full",
  });
  if (options.signal?.aborted) throw abortError();
  return page;
}

async function loadNextPage(
  client: SessionEventClientLike,
  workspaceId: string,
  sessionId: string,
  after: number,
  options: { pageSize: number; signal?: AbortSignal },
): Promise<SessionEvent[]> {
  if (options.signal?.aborted) throw abortError();
  if (options.pageSize === 0) return [];
  const page = await client.listEvents(workspaceId, sessionId, {
    after,
    limit: options.pageSize,
    compact: true,
    direction: "after",
    payloadMode: "full",
  });
  if (options.signal?.aborted) throw abortError();
  return page;
}

type DensityWindow = { events: SessionEvent[]; trimmed: boolean };

function trimBackwardToGroupTarget(events: SessionEvent[], targetGroups: number): DensityWindow {
  if (!Number.isFinite(targetGroups) || targetGroups <= 0 || events.length === 0) {
    return { events, trimmed: false };
  }
  for (let index = events.length - 1; index > 0; index -= 1) {
    if (!isTurnBoundary(events[index]!)) continue;
    const candidate = events.slice(index);
    if (groupCount(candidate) >= targetGroups) return { events: candidate, trimmed: true };
  }
  return { events, trimmed: false };
}

function trimForwardToGroupTarget(events: SessionEvent[], targetGroups: number): DensityWindow {
  if (!Number.isFinite(targetGroups) || targetGroups <= 0 || events.length === 0) {
    return { events, trimmed: false };
  }
  for (let index = 1; index < events.length; index += 1) {
    if (!isTurnBoundary(events[index]!)) continue;
    const candidate = events.slice(0, index);
    if (groupCount(candidate) >= targetGroups) return { events: candidate, trimmed: true };
  }
  return { events, trimmed: false };
}

function findBoundaryIndex(events: SessionEvent[]): number {
  for (let index = 0; index < events.length; index += 1) {
    if (isTurnBoundary(events[index]!)) return index;
  }
  return -1;
}

function isTurnBoundary(event: SessionEvent): boolean {
  return event.type === "session.created" || event.type === "user.message";
}

function groupCount(events: SessionEvent[]): number {
  return events.length === 0 ? 0 : groupTimeline(buildTimeline(events)).length;
}

function isLogStart(event: SessionEvent): boolean {
  return event.type === "session.created" || event.sequence <= 1;
}

function maxResumeSequence(events: readonly SessionEvent[]): number {
  return events.reduce((max, event) => Math.max(max, eventResumeSequence(event)), 0);
}

function maxResumeSequenceOrNull(events: readonly SessionEvent[]): number | null {
  return events.length > 0 ? maxResumeSequence(events) : null;
}

function assertAscending(events: SessionEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]!.sequence >= events[index]!.sequence) {
      throw new Error("@opengeni/sdk: session events must be ordered by ascending sequence");
    }
  }
}

function assertPrependOrder(existing: SessionEvent[], older: SessionEvent[]): void {
  if (!shouldAssertDevelopment() || existing.length === 0 || older.length === 0) return;
  if (older.at(-1)!.sequence >= existing[0]!.sequence) {
    throw new Error("@opengeni/sdk: loadOlder returned overlapping session events");
  }
}

function assertAppendOrder(existing: SessionEvent[], newer: SessionEvent[]): void {
  if (!shouldAssertDevelopment() || existing.length === 0 || newer.length === 0) return;
  if (newer[0]!.sequence <= existing.at(-1)!.sequence) {
    throw new Error("@opengeni/sdk: loadNewer returned overlapping session events");
  }
}

function shouldAssertDevelopment(): boolean {
  const processEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env;
  return processEnv !== undefined && processEnv.NODE_ENV !== "production";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
