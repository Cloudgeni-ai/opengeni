import {
  isPresentedSessionToolName,
  isRetryableStreamError,
  isSessionModelResponsePhase,
  isTransientRequestError,
  SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES,
  SESSION_EVENT_CONTENT_STEP_TYPES,
  SESSION_EVENT_CONVERSATION_FILTER_VERSION,
  SESSION_EVENT_STEP_TYPES,
  sessionEventStreamCoveredThrough,
  type SessionEvent,
  type SessionEventListOptions,
  type SessionEventPage,
  type SessionEventType,
  type SessionStatus,
  type StreamConnectionState,
} from "@opengeni/sdk";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEmbeddedSession, type EmbeddedSessionClientOverride } from "../session-context";
import { createOlderHistoryLoadReceipt, type OlderHistoryLoadReceipt } from "../older-history";
import { buildTimeline, groupTimeline, sessionStatusFromEvents } from "../timeline/projection";
import type { TimelineItem, TurnStepsItem } from "../timeline/types";
import type { EmbeddedSessionClientLike } from "../client";
import { normalizeError } from "../lib/error-message";
import { joinSessionDetailRead, sessionDetailReadMark } from "../lib/session-detail-read";
import {
  DEFAULT_TRANSIENT_READ_RETRY,
  transientReadRetryStep,
  usePageLiveActivity,
} from "./internal";
import { subscribePageWake } from "./page-wake";
import { deniesRetainedView, useRetainedSessionView } from "./session-view-cache";
import { markTurnlessOutputGap } from "./turnless-output-gaps";
import type { LatestQuestionOptions } from "./latest-question";
import { useOpenGeniText, type OpenGeniText } from "../messages/runtime";
import { isToolOutputPreviewEvent, useToolOutputReads } from "./tool-output-reads";

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
  /**
   * Loaded events, ordered by sequence, no duplicates. Windowed history holds a
   * session's conversation; a turn's steps (tool calls and outputs, streamed
   * reasoning and command output) are included while live and once a reader
   * opens that turn. Full replay holds every event.
   */
  events: SessionEvent[];
  /** Renderable timeline, including the bounded navigation witness for a distant queued prompt. */
  timeline: TimelineItem[];
  /** Latest session status observed in the event log, if any. */
  sessionStatus: SessionStatus | null;
  /** Sequence of the retained status projection, including events evicted from the window. */
  sessionStatusSequence?: number;
  connectionState: SessionEventsConnectionState;
  /** Highest sequence seen so far (0 before the first event). */
  lastSequence: number;
  /** Exact serialized bytes retained in the current browser event window. */
  windowBytes: number;
  /** Whether older delivered events were evicted from the browser window. */
  windowTruncated: boolean;
  /** True until the initial tail window has been applied (windowed mode). */
  initialLoading: boolean;
  /** A history window (including an empty tail) succeeded for this session/replay
   * identity. Stays true through later stream errors and navigation/reloads.
   * Full replay has no snapshot-completion watermark and does not set this by itself. */
  initialHistoryReady: boolean;
  /** Whether older durable events are available before the current window. */
  hasOlder: boolean;
  /** True while an older window is being fetched. */
  loadingOlder: boolean;
  /** Prepend an older density-bounded window; resolves true when more remain. */
  loadOlder: () => OlderHistoryLoadReceipt;
  /**
   * Durable events exist after the current window (history view jumped away
   * from the live tip, or a forward page is incomplete).
   */
  hasNewer: boolean;
  /** True while a newer history page is being fetched. */
  loadingNewer: boolean;
  /**
   * Append one density-bounded newer page without pulling the whole gap.
   * Resolves true when more newer history remains.
   */
  loadNewer: () => Promise<boolean>;
  /** True while replacing the window with the session start. */
  loadingOldest: boolean;
  /**
   * Jump to the durable session start: one bounded oldest window, no middle.
   * Leaves live streaming until {@link jumpToLatest} (or loadNewer catches up).
   */
  loadOldest: () => Promise<boolean>;
  /** True while reloading the live tip window. */
  loadingLatest: boolean;
  /**
   * Reload the newest bounded tip and resume live streaming. Use for
   * "Jump to latest" when the tip is not in memory (history view).
   */
  jumpToLatest: () => Promise<void>;
  /** Resolve the newest eligible durable human question. Pending prompts use the
   * optional queue destination and return null; started prompts load their actual
   * turn context (pass `timeline` to MessageTimeline as `items`). */
  jumpToLatestQuestion: (options?: LatestQuestionOptions) => Promise<number | null>;
  /** Replace history with a bounded window containing this exact durable event. */
  jumpToSequence: (sequence: number, options?: { signal?: AbortSignal }) => Promise<boolean>;
  loadingTarget: boolean;
  error: Error | null;
};

// Keep every browser history read inside one database batch, including the
// server's one-row continuation lookahead. A large total session must never
// turn one lazy page into dozens of sequential database round trips.
const SESSION_HISTORY_PAGE_SIZE = 1000;
const INITIAL_FETCH_CAP = 1;
const OLDER_GROUP_TARGET = 32;
const OLDER_FETCH_CAP = 2;
const NEWER_GROUP_TARGET = 32;
const NEWER_FETCH_CAP = 2;
const OLDEST_GROUP_TARGET = 32;
const OLDEST_FETCH_CAP = 2;
// A tail page may land inside one unusually dense turn. Permit exactly one
// additional bounded page to find its user/session boundary without turning a
// fresh open into an unbounded history walk.
const BOUNDARY_PAGE_CAP = 1;
// When the reader asks for older or newer history, pages a fallback
// conversation read keeps nothing of (an older server's tool calls only) do
// not use up the caps above; at most this many more are read per load. Any
// load that stops on an empty window stays pageable from where it stopped.
// The first window keeps the plain caps, so opening a chat stays one read.
const FILTERED_PAGE_CAP = 32;
// Rejoining the live tip (first open of a working turn, a return to a hidden
// tab or from a sleep, any stream reconnect, catching up from history)
// replays a tiny raw gap over SSE. A larger gap catches up the conversation
// only and reads the working turn's latest steps, instead of replaying every
// step since the last conversation event. Only a gap of more than this many
// pages of conversation reloads the latest window.
const DIRECT_REPLAY_MAX_SEQUENCES = 16;
const CATCHUP_MAX_PAGES = 2;
// Rejoining the tip after a reconnect or a wake is bounded: an attempt that
// completes no read for REJOIN_STALL_TIMEOUT_MS is abandoned (a slow but
// progressing catch-up is never cut short), a transient failure retries (with
// backoff) only this many times in a row, and after that the stream replays
// exactly from where the view stands rather than staying stuck "reconnecting".
const STRICT_REJOIN_ATTEMPTS = 5;
export const REJOIN_STALL_TIMEOUT_MS = 30_000;
const FOREGROUND_REJOIN_RETRY_MS = 500;
const FOREGROUND_REJOIN_RETRY_MAX_MS = 8_000;
const EMPTY_EVENTS: SessionEvent[] = [];
const encoder = new TextEncoder();
// Durable history remains on the server and is available through bounded
// navigation. Keep the live browser working set small across multiple tabs;
// serialized payloads also expand into objects and timeline projections.
export const SESSION_EVENT_BROWSER_MAX_BYTES = 16 * 1024 * 1024;
export const SESSION_EVENT_BROWSER_MAX_COUNT = 20_000;
export const SESSION_EVENT_BROWSER_PENDING_MAX_BYTES = 1024 * 1024;
export const SESSION_EVENT_BROWSER_PENDING_MAX_COUNT = 256;

export type BrowserSessionEventWindow = {
  events: SessionEvent[];
  bytes: number;
  truncated: boolean;
};

const EMPTY_EVENT_WINDOW: BrowserSessionEventWindow = {
  events: EMPTY_EVENTS,
  bytes: 2,
  truncated: false,
};

/**
 * Live-stream a session's event log with replay-by-sequence, reconnect, and
 * batched React updates. Fresh loads default to a bounded tail window; pass
 * `replay: "full"` or a nonzero `after` for the previous full replay path.
 */
export function useSessionEvents(
  sessionId: string | null | undefined,
  options: UseSessionEventsOptions = {},
): UseSessionEventsResult {
  const t = useOpenGeniText();
  const { client, workspaceId, reconcileSession } = useEmbeddedSession(options);
  const enabled = options.enabled ?? true;
  const pageLive = usePageLiveActivity();
  const streamEnabled = enabled && pageLive;
  const after = options.after ?? 0;
  const replay = options.replay ?? "windowed";
  const fullReplay = replay === "full" || after !== 0;
  const streamKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${after}\u0000${fullReplay ? "full" : "windowed"}`;
  // Bind callbacks to this read lifetime, including a return to a previous
  // identity. Publish during render so old callbacks are fenced before passive
  // cleanup can advance the navigation generation.
  const navigationIdentityRef = useRef({ client, streamKey, enabled });
  if (
    navigationIdentityRef.current.client !== client ||
    navigationIdentityRef.current.streamKey !== streamKey ||
    navigationIdentityRef.current.enabled !== enabled
  ) {
    navigationIdentityRef.current = { client, streamKey, enabled };
  }
  const navigationIdentity = navigationIdentityRef.current;
  const ownsNavigation = useCallback(
    () => navigationIdentityRef.current === navigationIdentity,
    [navigationIdentity],
  );

  const [eventWindow, setEventWindow] = useState<BrowserSessionEventWindow>(EMPTY_EVENT_WINDOW);
  // One navigation witness, not a second history cache. Raw events stay contiguous.
  const [questionEvidence, setQuestionEvidence] = useState<{
    client: EmbeddedSessionClientLike;
    streamKey: string;
    anchor: number;
    events: SessionEvent[];
  } | null>(null);
  const [connectionState, setConnectionState] = useState<SessionEventsConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [newerError, setNewerError] = useState<Error | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [sessionStatusProjection, setSessionStatusProjection] = useState<SessionStatus | null>(
    null,
  );
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialHistoryReady, setInitialHistoryReady] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [loadingOldest, setLoadingOldest] = useState(false);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const loadingTargetRef = useRef(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  // "history" = reading a non-tip window; live SSE must not fill the gap.
  const [viewMode, setViewMode] = useState<"live" | "history">("live");
  const lastSequenceRef = useRef(after);
  const streamResumeSequenceRef = useRef(after);
  /**
   * The newest row a first window read but kept none of: the live stream
   * resumed above it, so a working turn older history reveals below it has
   * steps up to there that neither the window nor the stream holds.
   */
  const skippedStepsThroughRef = useRef<number | null>(null);
  const oldestSequenceRef = useRef<number | null>(null);
  const newestSequenceRef = useRef<number | null>(null);
  const hasOlderRef = useRef(false);
  const hasNewerRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingOldestRef = useRef(false);
  const loadingLatestRef = useRef(false);
  const viewModeRef = useRef<"live" | "history">("live");
  const initialWindowLoadedRef = useRef(false);
  // The stream key whose live stream has opened at least once in this mount.
  const openedStreamKeyRef = useRef<string | null>(null);
  const reconcileAfterPageResumeRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const navigationGenerationRef = useRef(0);
  const eventWindowRef = useRef<BrowserSessionEventWindow>(EMPTY_EVENT_WINDOW);
  const sessionStatusRef = useRef<{
    sequence: number;
    status: SessionStatus | null;
  }>({
    sequence: after,
    status: null,
  });
  // Effects reset state after commit. Tag the state so the first render for a
  // new stream identity cannot expose the previous session's event log.
  const [stateStreamKey, setStateStreamKey] = useState(streamKey);

  const historyFilter = fullReplay ? undefined : CONVERSATION_FILTER;
  // Conversation-first history: a turn's steps live here, per turn, apart
  // from the contiguous conversation window (see `isConversationHistoryEvent`).
  const [stepStores, setStepStores] = useState<TurnStepStores>(EMPTY_STEP_STORES);
  const stepStoresRef = useRef<TurnStepStores>(EMPTY_STEP_STORES);
  // Live step rows without a turn (PTY and background command output): a
  // short tail outside the window. The sandbox dock reads their history itself.
  const [turnlessSteps, setTurnlessSteps] = useState<TurnlessSteps>(EMPTY_TURNLESS_STEPS);
  const turnlessStepsRef = useRef<TurnlessSteps>(EMPTY_TURNLESS_STEPS);
  // How many live turnless rows the last committed render had seen, and
  // whether a gap was already marked for rows appended since.
  const renderedTurnlessRef = useRef({ appended: 0, marked: false });
  useEffect(() => {
    renderedTurnlessRef.current = { appended: turnlessSteps.appended, marked: false };
  }, [turnlessSteps]);
  // Through which sequence the live stream delivered every row. A stream that
  // starts past it (the conversation side moved the cursor) skipped terminal
  // output nobody read.
  const liveThroughRef = useRef(0);
  // Retires step reads issued for a previous stream identity.
  const stepGenerationRef = useRef(0);
  // Each step read's id; a store answers only its newest read.
  const stepRequestRef = useRef(0);
  // Turns a reader has open: their steps are never trimmed or evicted.
  const retainedTurnsRef = useRef(new Map<string, number>());
  const turnStepHandlesRef = useRef(new Map<string, Pick<TurnStepsItem, "load" | "retain">>());
  // Presented tools (images, published files, Skill and learning writes) stay
  // in the conversation window with their results.
  const presentedCallIdsRef = useRef(new Set<string>());
  const presentedScanRef = useRef<readonly SessionEvent[] | null>(null);
  // Turns whose model has not responded yet: their model request rows still
  // draw the startup rail, so live ones stay in the conversation window.
  const startupRef = useRef<StartupTurns>(emptyStartupTurns());
  const [presentedOutputs, setPresentedOutputs] =
    useState<ReadonlyMap<string, SessionEvent>>(EMPTY_PRESENTED_OUTPUTS);
  const presentedRequestedRef = useRef(new Map<string, PresentedRequest>());
  // Failed reads per call: each retries after a growing pause, a few times.
  const presentedFailuresRef = useRef(new Map<string, number>());
  // Bumped when a presented-result read settles, so the next pass runs.
  const [presentedPass, setPresentedPass] = useState(0);
  // A return to the live tip from history: catch up without replaying steps.
  const rejoinPendingRef = useRef(false);
  // Consecutive transient failures to open this stream (a deploy or network
  // blip): they restart it quietly before an error is shown.
  const streamTransientStreakRef = useRef<{
    since: number;
    attempts: number;
    surfaced: boolean;
  } | null>(null);

  const commitStepStores = useCallback((next: TurnStepStores) => {
    stepStoresRef.current = next;
    setStepStores(next);
  }, []);

  /**
   * Keep the steps that are still whole for a new `window`: only turns in it,
   * and, when live continuity broke, only turns already settled in the window
   * before the break (`sealedBy`). A turn still working then may have written
   * steps this browser never saw; it reloads them when opened. `rereading` is
   * a working turn whose tail is read again right after: its steps stay on
   * screen until that read replaces them. Presented results of turns that
   * left the window go too.
   */
  const pruneStepStores = useCallback(
    (
      window: readonly SessionEvent[],
      sealedBy: readonly SessionEvent[] | null,
      rereading: string | null = null,
    ) => {
      const present = windowTurns(window);
      const settled = sealedBy ? settledTurns(sealedBy) : null;
      const next = new Map<string, TurnStepStore>();
      for (const [turnId, store] of stepStoresRef.current) {
        // A dropped store also retires its read in flight (see requestId).
        if (present.has(turnId) && (!settled || settled.has(turnId) || turnId === rereading)) {
          next.set(turnId, store);
        }
      }
      if (next.size !== stepStoresRef.current.size) commitStepStores(next);
      // After a break, results still missing are read again; otherwise only
      // reads for turns that left the window are forgotten (reads in flight
      // for the rest carry on).
      if (sealedBy) {
        presentedRequestedRef.current = new Map();
      } else {
        for (const [callId, request] of presentedRequestedRef.current) {
          if (request.turnId && !present.has(request.turnId)) {
            presentedRequestedRef.current.delete(callId);
          }
        }
      }
      setPresentedOutputs((current) => {
        let kept: Map<string, SessionEvent> | null = null;
        for (const [callId, output] of current) {
          if (output.turnId && present.has(output.turnId)) continue;
          kept ??= new Map(current);
          kept.delete(callId);
        }
        return kept ?? current;
      });
    },
    [commitStepStores],
  );

  const presentedCallIds = useCallback((event: SessionEvent): ReadonlySet<string> => {
    const ids = presentedCallIdsRef.current;
    if (event.type === "agent.toolCall.created") {
      notePresentedCalls([event], ids);
    } else if (event.type === "agent.toolCall.output") {
      const payload = event.payload as Record<string, unknown> | null;
      const windowEvents = eventWindowRef.current.events;
      if (
        typeof payload?.id === "string" &&
        !ids.has(payload.id) &&
        presentedScanRef.current !== windowEvents
      ) {
        // Presented calls loaded with history: scan once per window.
        presentedScanRef.current = windowEvents;
        notePresentedCalls(windowEvents, ids);
      }
    }
    return ids;
  }, []);

  /** The turns whose live model request rows are still conversation. */
  const startupTurns = useCallback((): StartupTurns => {
    const windowEvents = eventWindowRef.current.events;
    if (startupRef.current.window !== windowEvents) {
      // History replaced or trimmed the window: read it again once.
      const state = emptyStartupTurns();
      noteStartupTurns(windowEvents, state);
      state.window = windowEvents;
      startupRef.current = state;
    }
    return startupRef.current;
  }, []);

  const appendLiveSteps = useCallback(
    (steps: readonly SessionEvent[]) => {
      if (steps.some((event) => !event.turnId)) {
        const incoming = steps.filter((event) => !event.turnId);
        const turnless = appendTurnlessSteps(turnlessStepsRef.current, incoming);
        // A burst larger than the tail dropped rows no render showed: the
        // terminal re-reads them.
        const rendered = renderedTurnlessRef.current;
        if (!rendered.marked && turnless.appended - rendered.appended > turnless.events.length) {
          rendered.marked = true;
          if (sessionId) markTurnlessOutputGap(workspaceId, sessionId);
        }
        turnlessStepsRef.current = turnless;
        setTurnlessSteps(turnless);
      }
      const windowEvents = withTurnlessSteps(
        eventWindowRef.current.events,
        turnlessStepsRef.current,
      );
      const next = new Map(stepStoresRef.current);
      const now = Date.now();
      for (const [turnId, events] of groupByTurn(steps)) {
        const existing = next.get(turnId);
        const store: TurnStepStore = existing ?? {
          events: [],
          bytes: 2,
          // Earlier steps exist when the window skips sequences between the
          // turn's start and this first live step.
          hasOlder: turnHasHiddenSequences(windowEvents, turnId, events[0]!.sequence),
          cursor: null,
          floor: null,
          pinned: null,
          loading: false,
          error: false,
          touched: now,
          requestId: 0,
        };
        let updated: TurnStepStore = { ...store, ...appendStepEvents(store, events), touched: now };
        if (!retainedTurnsRef.current.get(turnId)) updated = trimLiveStepTail(updated);
        next.set(turnId, updated);
      }
      commitStepStores(boundStepStores(next, retainedTurnsRef.current));
    },
    [commitStepStores, workspaceId, sessionId],
  );

  /**
   * Read a turn's newest unloaded steps: the latest page when none are
   * loaded, else the page before the oldest loaded step. `before` pins the
   * read's upper bound (the durable head when rejoining a working turn) and
   * replaces whatever was loaded or loading.
   */
  const loadTurnSteps = useCallback(
    (turnId: string, before?: number) => {
      if (!ownsNavigation() || !sessionId || fullReplay) return;
      const current = stepStoresRef.current.get(turnId);
      // Retrying a failed pinned read reads the same tail again: continuing
      // below the loaded steps would leave the gap above them unread.
      const pinnedUpper =
        before ?? (current?.error && current.pinned !== null ? current.pinned : undefined);
      const pinned = pinnedUpper !== undefined;
      if (!pinned && current?.loading) return;
      const bounds = conversationTurnBounds(eventWindowRef.current.events).get(turnId);
      if (!bounds) return;
      if (!pinned && current && !stepStoreHasOlder(current, bounds) && !current.error) return;
      const upper =
        pinnedUpper ??
        current?.cursor ??
        current?.events[0]?.sequence ??
        (bounds.terminal !== null ? bounds.terminal + 1 : Number.MAX_SAFE_INTEGER);
      // Without the turn's start in the window (it begins mid-turn), the read
      // reaches back to the previous turn and stops at another turn's steps.
      const exactStart = bounds.started !== null;
      const lower = turnStepLowerBound(bounds);
      const generation = stepGenerationRef.current;
      const requestId = ++stepRequestRef.current;
      const isCurrent = () =>
        ownsNavigation() &&
        generation === stepGenerationRef.current &&
        stepStoresRef.current.get(turnId)?.requestId === requestId;
      // A pinned read (rejoining the tip) keeps the loaded steps on screen
      // while it runs, then replaces them (see below).
      const base: TurnStepStore = current ?? {
        events: [],
        bytes: 2,
        hasOlder: true,
        cursor: null,
        floor: null,
        pinned: null,
        loading: false,
        error: false,
        touched: 0,
        requestId,
      };
      commitStepStores(
        new Map(stepStoresRef.current).set(turnId, {
          ...base,
          pinned: pinned ? upper : null,
          loading: true,
          error: false,
          touched: Date.now(),
          requestId,
        }),
      );
      void readEventPage(client, workspaceId, sessionId, {
        // Bookkeeping too, whichever read built this window: rows it already
        // holds (a fallback read keeps them) merge once by id.
        includeTypes: [...TURN_STEP_READ_TYPES],
        after: Math.max(0, lower),
        before: upper,
        direction: "before",
        limit: SESSION_TURN_STEP_PAGE_SIZE,
        compact: true,
        payloadMode: "full",
        // Large tool outputs arrive as bounded previews; a row reads its
        // exact output when the reader needs it (see useToolOutputReads).
        toolOutputs: "preview",
      }).then(
        (page) => {
          if (!isCurrent()) return;
          const own = page.events.filter((event) => event.turnId === turnId);
          const latest = stepStoresRef.current.get(turnId)!;
          // A pinned page replaces what was loaded (merging a newest page into
          // older loaded steps could hide the steps between them); live steps
          // that arrived during the read stay.
          const merged = pinned
            ? appendStepEvents(
                { events: [], bytes: 2 },
                [...own, ...latest.events.filter((event) => event.sequence >= upper)].sort(
                  (left, right) => left.sequence - right.sequence,
                ),
              )
            : appendStepEvents(latest, own);
          const oldestOwn = merged.events[0]?.sequence ?? upper;
          // Turnless rows (queue changes, PTY output) say nothing about where
          // this turn starts.
          const passedStart =
            !exactStart &&
            page.events.some(
              (event) => !!event.turnId && event.turnId !== turnId && event.sequence < oldestOwn,
            );
          const moreBelow = !passedStart && (page.hasMore ?? page.events.length > 0);
          // Reaching the bottom of a guessed range (no start in the window) is
          // not final: remember where the read stopped.
          const reachedFloor = !moreBelow && !passedStart && !exactStart;
          const next = new Map(stepStoresRef.current).set(turnId, {
            ...merged,
            // A page read without a continuation fact (a client without
            // listEventPage) offers one more page until a read comes back empty.
            hasOlder: moreBelow,
            // The next page continues below this page's oldest row, even when
            // the page held only other turns' rows, or below the floor.
            cursor: reachedFloor
              ? lower + 1
              : page.events.reduce((oldest, event) => Math.min(oldest, event.sequence), upper),
            floor: reachedFloor ? lower : null,
            pinned: null,
            loading: false,
            error: false,
            touched: Date.now(),
            requestId,
          });
          commitStepStores(boundStepStores(next, retainedTurnsRef.current));
        },
        () => {
          if (!isCurrent()) return;
          const latest = stepStoresRef.current.get(turnId)!;
          commitStepStores(
            new Map(stepStoresRef.current).set(turnId, { ...latest, loading: false, error: true }),
          );
        },
      );
    },
    [client, workspaceId, sessionId, fullReplay, ownsNavigation, commitStepStores],
  );
  const loadTurnStepsRef = useRef(loadTurnSteps);
  useEffect(() => {
    loadTurnStepsRef.current = loadTurnSteps;
  }, [loadTurnSteps]);

  /** Stable per-turn handles, so an open turn's loader effects run once. */
  const turnStepHandle = useCallback((turnId: string) => {
    let handle = turnStepHandlesRef.current.get(turnId);
    if (!handle) {
      const retained = retainedTurnsRef.current;
      handle = {
        load: () => loadTurnStepsRef.current(turnId),
        retain: () => {
          retained.set(turnId, (retained.get(turnId) ?? 0) + 1);
          let released = false;
          return () => {
            if (released) return;
            released = true;
            const count = (retained.get(turnId) ?? 1) - 1;
            if (count > 0) retained.set(turnId, count);
            else retained.delete(turnId);
          };
        },
      };
      turnStepHandlesRef.current.set(turnId, handle);
    }
    return handle;
  }, []);

  // Navigation belongs to the session/client lifetime, not the transport: an
  // SSE reconnect must never cancel an in-flight history page.
  useEffect(() => {
    navigationGenerationRef.current += 1;
    setNewerError(null);
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    loadingOldestRef.current = false;
    loadingTargetRef.current = false;
    setQuestionEvidence(null);
    setLoadingTarget(false);
    setLoadingOlder(false);
    setLoadingNewer(false);
    setLoadingOldest(false);
    return () => {
      navigationGenerationRef.current += 1;
    };
  }, [client, workspaceId, sessionId, after, enabled, fullReplay]);

  useEffect(() => {
    // Reset the accumulated log only when the stream identity changes —
    // pausing via `enabled: false` keeps the timeline visible.
    if (streamKeyRef.current !== streamKey) {
      streamKeyRef.current = streamKey;
      setStateStreamKey(streamKey);
      eventWindowRef.current = EMPTY_EVENT_WINDOW;
      setEventWindow(EMPTY_EVENT_WINDOW);
      setError(null);
      setHasOlder(false);
      setHasNewer(false);
      sessionStatusRef.current = { sequence: after, status: null };
      setSessionStatusProjection(null);
      setLoadingOlder(false);
      setLoadingNewer(false);
      setLoadingOldest(false);
      setLoadingLatest(false);
      setInitialLoading(true);
      setInitialHistoryReady(false);
      lastSequenceRef.current = after;
      streamResumeSequenceRef.current = after;
      liveThroughRef.current = after;
      skippedStepsThroughRef.current = null;
      oldestSequenceRef.current = null;
      newestSequenceRef.current = null;
      hasOlderRef.current = false;
      hasNewerRef.current = false;
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      loadingOldestRef.current = false;
      loadingLatestRef.current = false;
      viewModeRef.current = "live";
      setViewMode("live");
      initialWindowLoadedRef.current = false;
      reconcileAfterPageResumeRef.current = false;
      rejoinPendingRef.current = false;
      streamTransientStreakRef.current = null;
      stepGenerationRef.current += 1;
      stepStoresRef.current = EMPTY_STEP_STORES;
      setStepStores(EMPTY_STEP_STORES);
      turnlessStepsRef.current = EMPTY_TURNLESS_STEPS;
      setTurnlessSteps(EMPTY_TURNLESS_STEPS);
      turnStepHandlesRef.current = new Map();
      presentedCallIdsRef.current = new Set();
      presentedScanRef.current = null;
      startupRef.current = emptyStartupTurns();
      presentedRequestedRef.current = new Map();
      presentedFailuresRef.current = new Map();
      setPresentedOutputs(EMPTY_PRESENTED_OUTPUTS);
    }
    // AbortController is advisory: custom SDK clients and async iterators may
    // ignore it and resolve/yield after cleanup. Fence every effect instance so
    // only the newest dependency generation can mutate refs or React state.
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!sessionId || !streamEnabled) {
      // A suspended stream starts a fresh transient streak when it resumes: a
      // failure right after a wake must not count the hidden time.
      streamTransientStreakRef.current = null;
      // A page that stayed hidden beyond the live-activity grace deliberately
      // closed its SSE connection. Replaying from the old cursor on return can
      // drip a large background backlog through React in many fast batches and
      // leave the pinned camera catching up long after the user is foregrounded.
      // Remember that suspension so the next live effect replaces the browser
      // window with one compact durable tail instead.
      if (
        sessionId &&
        enabled &&
        !pageLive &&
        !fullReplay &&
        viewModeRef.current === "live" &&
        initialWindowLoadedRef.current
      ) {
        reconcileAfterPageResumeRef.current = true;
      }
      setConnectionState("idle");
      return;
    }
    // History view owns a non-tip window; do not open SSE (it would replay the
    // entire gap into the browser). jumpToLatest / catching loadNewer resume live.
    if (viewMode === "history") {
      reconcileAfterPageResumeRef.current = false;
      setConnectionState("idle");
      setInitialLoading(false);
      return;
    }
    const reconcileForegroundResume = reconcileAfterPageResumeRef.current && !fullReplay;
    reconcileAfterPageResumeRef.current = false;
    const controller = new AbortController();
    // A head read joins a fresh detail read (useSession's) started from here on.
    const detailReadMark = sessionDetailReadMark();
    const isCurrent = () =>
      generationRef.current === generation &&
      !controller.signal.aborted &&
      navigationIdentityRef.current.client === client &&
      navigationIdentityRef.current.streamKey === streamKey &&
      navigationIdentityRef.current.enabled === enabled;
    streamAbortRef.current = controller;
    // A quiet restart or reconciliation retry scheduled by this effect instance.
    let transientRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleTransientRetry = (delayMs: number, retry: () => void) => {
      if (transientRetryTimer !== null) clearTimeout(transientRetryTimer);
      transientRetryTimer = setTimeout(() => {
        transientRetryTimer = null;
        if (isCurrent()) retry();
      }, delayMs);
    };
    // Batch yielded events into one React update per flush window so a long
    // replay (thousands of events) does not render per event. Project every
    // event before retaining it here and synchronously flush at independent
    // count+byte high-water marks: a synchronously yielding async iterator can
    // otherwise starve the 16 ms timer and grow this pre-React buffer without
    // bound even though the final browser window is bounded.
    let pending: SessionEvent[] = [];
    let pendingBytes = 2; // []
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      // A synchronous count/byte high-water flush can run before the scheduled
      // callback gets a macrotask. Cancel that callback before clearing its
      // handle so a long synchronously yielding replay retains at most one
      // timer rather than one stale callback per flushed batch.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!isCurrent()) {
        pending = [];
        pendingBytes = 2;
        return;
      }
      if (pending.length === 0) {
        return;
      }
      const batch = pending;
      pending = [];
      pendingBytes = 2;
      // The resume cursor only advances with delivered batches: events still
      // sitting in `pending` when the stream is torn down are re-fetched on
      // the next connect instead of being skipped.
      const lastInBatch = batch[batch.length - 1];
      if (lastInBatch) {
        const batchResumeSequence = Math.max(...batch.map(eventResumeSequence));
        lastSequenceRef.current = Math.max(lastSequenceRef.current, batchResumeSequence);
        streamResumeSequenceRef.current = Math.max(
          streamResumeSequenceRef.current,
          batchResumeSequence,
        );
        liveThroughRef.current = Math.max(liveThroughRef.current, batchResumeSequence);
      }
      const status = observeSessionStatus(batch, sessionStatusRef);
      if (status !== undefined) {
        setSessionStatusProjection(status);
      }
      // Live steps go to their turn's step store; the window stays the
      // conversation so it is never crowded out by one long turn's steps.
      let conversation: SessionEvent[] = batch;
      const steps: SessionEvent[] = [];
      if (!fullReplay) {
        const windowNewest = newestSequenceRef.current ?? 0;
        const startup = startupTurns();
        conversation = [];
        for (const event of batch) {
          if (!isConversationHistoryEvent(event, presentedCallIds(event), startup.open)) {
            steps.push(event);
          }
          // Rejoining at a durable head never re-applies a windowed event.
          else if (event.sequence > windowNewest) conversation.push(event);
          noteStartupTurns([event], startup);
        }
      }
      if (conversation.length > 0) {
        const current = eventWindowRef.current;
        const next = appendBrowserSessionEventWindow(current, conversation);
        const retained = {
          ...next,
          truncated: current.truncated || next.truncated,
        };
        eventWindowRef.current = retained;
        setEventWindow(retained);
        // This batch is already noted: no rescan for its own append.
        if (!fullReplay) startupRef.current.window = retained.events;
        oldestSequenceRef.current = retained.events[0]?.sequence ?? null;
        newestSequenceRef.current = maxResumeSequenceOrNull(retained.events);
        if (retained.truncated) {
          hasOlderRef.current = true;
          setHasOlder(true);
        }
      }
      // After the batch's conversation, so a turn started in this batch is
      // known to the window when its first steps arrive.
      if (steps.length > 0) appendLiveSteps(steps);
    };
    const scheduleFlush = () => {
      if (!isCurrent()) return;
      flushTimer ??= setTimeout(flush, 16);
    };
    const installCatchup = (events: SessionEvent[], head: number) => {
      const current = eventWindowRef.current;
      const windowNewest = newestSequenceRef.current ?? 0;
      const fresh = events.filter((event) => event.sequence > windowNewest);
      const status = observeSessionStatus(fresh, sessionStatusRef);
      const next = appendBrowserSessionEventWindow(current, fresh);
      const retained = { ...next, truncated: current.truncated || next.truncated };
      eventWindowRef.current = retained;
      // A window that still kept nothing keeps its raw cursors.
      oldestSequenceRef.current = retained.events[0]?.sequence ?? oldestSequenceRef.current;
      newestSequenceRef.current =
        maxResumeSequenceOrNull(retained.events) ?? newestSequenceRef.current;
      lastSequenceRef.current = Math.max(lastSequenceRef.current, head);
      streamResumeSequenceRef.current = Math.max(streamResumeSequenceRef.current, head);
      // Steps skipped below an empty first window now reach the catch-up head.
      if (skippedStepsThroughRef.current !== null) {
        skippedStepsThroughRef.current = Math.max(skippedStepsThroughRef.current, head);
      }
      if (status !== undefined) setSessionStatusProjection(status);
      if (fresh.length > 0) setEventWindow(retained);
      if (retained.truncated) {
        hasOlderRef.current = true;
        setHasOlder(true);
      }
    };
    /**
     * Join the live tip without replaying the steps written since the
     * window's newest conversation event. Small gaps replay over SSE; larger
     * ones catch up the conversation and read the working turn's latest
     * steps. Resolves "reload" when the missed conversation is too long to
     * append (the caller then loads the latest window).
     */
    // The durable head: the conversation's fresh detail read when one started
    // since `mark` (the session view's own), else a new one.
    const effectScope: RejoinScope = { signal: controller.signal, isCurrent };
    const readSessionHead = async (mark: number, scope: RejoinScope) => {
      const joined = joinSessionDetailRead(client, workspaceId, sessionId, mark);
      if (joined) {
        try {
          return await joined;
        } catch (cause) {
          if (scope.signal.aborted) throw cause;
        }
      }
      return await client.getSession(workspaceId, sessionId, {
        fresh: true,
        signal: scope.signal,
      });
    };
    // `strict` (a stream reconnect) fails on a transient read failure, so the
    // stream backs off and retries the whole check instead of replaying a
    // backlog it could not size; any other failed read replays the gap.
    const rejoinLive = async (
      force: boolean,
      {
        strict = false,
        mark = detailReadMark,
        scope = effectScope,
      }: { strict?: boolean; mark?: number; scope?: RejoinScope } = {},
    ): Promise<RejoinOutcome> => {
      const activeTurn = activeConversationTurn(eventWindowRef.current.events);
      if (!force && !activeTurn) return "joined";
      const cursor = streamResumeSequenceRef.current;
      let head: number;
      let sessionActiveTurn: string | null = null;
      try {
        const session = await readSessionHead(mark, scope);
        scope.progress?.();
        head = session.lastSequence;
        sessionActiveTurn = session.activeTurnId;
      } catch (cause) {
        if (!scope.isCurrent() || (strict && isRetryableStreamError(cause))) throw cause;
        // An optimization read: replay from the exact cursor instead.
        return "joined";
      }
      if (!scope.isCurrent()) throw abortError();
      // A head the client does not report is unknown: replay from the cursor.
      if (!Number.isSafeInteger(head) || head - cursor <= DIRECT_REPLAY_MAX_SEQUENCES) {
        return "joined";
      }
      let catchup: SessionEvent[] | null;
      try {
        catchup = await loadConversationCatchup(
          client,
          workspaceId,
          sessionId,
          cursor,
          head,
          scope,
        );
      } catch (cause) {
        if (!scope.isCurrent() || (strict && isRetryableStreamError(cause))) throw cause;
        return "joined";
      }
      if (!scope.isCurrent()) throw abortError();
      if (catchup === null) return "reload";
      // Continuity broke: steps of turns still working before the catch-up
      // may be missing, so those stores go (the working one is re-read).
      const previous = eventWindowRef.current.events;
      installCatchup(catchup, head);
      const working = sessionActiveTurn ?? activeConversationTurn(eventWindowRef.current.events);
      pruneStepStores(eventWindowRef.current.events, previous, working);
      if (working) loadTurnStepsRef.current(working, head + 1);
      // A working turn the window now shows had its steps read just now; one
      // still below the window is read once older history reveals it.
      if (working && conversationTurnBounds(eventWindowRef.current.events).has(working)) {
        skippedStepsThroughRef.current = null;
      }
      return "joined";
    };

    // Replace the browser window with the newest conversation window. The
    // previous window stays on screen until the replacement is installed.
    const loadLatestWindow = async (scope: RejoinScope = effectScope): Promise<boolean> => {
      // First paint is ONE compact fetch of the conversation — the newest
      // window, revealed at the bottom in a few hundred ms. Deeper history
      // loads only when the reader scrolls up (the sentinel drives
      // loadOlder); a turn's steps load when the reader opens it.
      const window = await loadEventWindow(t, client, workspaceId, sessionId, {
        before: Number.MAX_SAFE_INTEGER,
        pageSize: SESSION_HISTORY_PAGE_SIZE,
        targetGroups: Number.POSITIVE_INFINITY,
        maxFetches: INITIAL_FETCH_CAP,
        boundaryPageCap: BOUNDARY_PAGE_CAP,
        signal: scope.signal,
        ...(scope.progress ? { progress: scope.progress } : {}),
        filter: CONVERSATION_FILTER,
      });
      if (!scope.isCurrent()) {
        return false;
      }
      const status = observeSessionStatus(window.events, sessionStatusRef);
      const retained = boundBrowserSessionEventWindow(window.events);
      // A replacement tail retires requests against the discarded window.
      // Ordinary SSE reconnects preserve navigation, but splicing an old
      // page into this new tail could leave an inaccessible history gap.
      navigationGenerationRef.current += 1;
      loadingOlderRef.current = false;
      loadingNewerRef.current = false;
      loadingOldestRef.current = false;
      setLoadingOlder(false);
      setLoadingNewer(false);
      setLoadingOldest(false);
      const previous = eventWindowRef.current.events;
      eventWindowRef.current = retained;
      pruneStepStores(retained.events, previous);
      oldestSequenceRef.current =
        retained.events[0]?.sequence ?? window.oldestSequence ?? window.scanCursor;
      newestSequenceRef.current = maxResumeSequenceOrNull(retained.events) ?? window.newestSequence;
      hasOlderRef.current = window.hasOlder || retained.truncated;
      hasNewerRef.current = false;
      lastSequenceRef.current = Math.max(lastSequenceRef.current, window.newestSequence);
      streamResumeSequenceRef.current = window.newestSequence;
      skippedStepsThroughRef.current =
        retained.events.length === 0 && window.newestSequence > 0 ? window.newestSequence : null;
      initialWindowLoadedRef.current = true;
      streamTransientStreakRef.current = null;
      setInitialHistoryReady(true);
      setError(null);
      if (status !== undefined) {
        setSessionStatusProjection(status);
      }
      setEventWindow(retained);
      setHasOlder(window.hasOlder || retained.truncated);
      setHasNewer(false);
      setInitialLoading(false);
      return true;
    };

    // The stream starts past what it last delivered: a window load,
    // catch-up, page or jump moved the cursor with conversation reads, which
    // carry no terminal output, so the sandbox terminal reads it again.
    const noteStreamResume = () => {
      if (!fullReplay && streamResumeSequenceRef.current > liveThroughRef.current) {
        markTurnlessOutputGap(workspaceId, sessionId);
      }
      liveThroughRef.current = Math.max(liveThroughRef.current, streamResumeSequenceRef.current);
    };

    // Reconciliation after an open re-reads the API contract and projections.
    // A transient failure (a reconnect during an API rollout often lands on a
    // pod that is still starting) retries quietly; the error is shown only
    // when it is definitive or outlasts the quiet window.
    const reconcileAfterOpen = (
      initialOpen: boolean,
      streak: { since: number; attempts: number; surfaced: boolean } | null = null,
    ) => {
      void Promise.resolve()
        .then(() => reconcileSession(sessionId, { initialOpen }))
        .catch((cause) => {
          if (!isCurrent()) return;
          if (isTransientRequestError(cause)) {
            const now = Date.now();
            const current = streak ?? { since: now, attempts: 0, surfaced: false };
            const step = transientReadRetryStep(current, now, DEFAULT_TRANSIENT_READ_RETRY);
            if (step.quiet) {
              scheduleTransientRetry(step.delayMs, () => reconcileAfterOpen(initialOpen, current));
              return;
            }
          }
          setError(normalizeError(cause));
        });
    };

    // One bounded rejoin attempt: it is abandoned once no read completes for
    // REJOIN_STALL_TIMEOUT_MS, and a late result is fenced out of the view
    // (reads without a signal can only be outwaited). A `strict` attempt
    // that failed transiently or stalled resolves the cause so the caller
    // retries; a lenient one that stalled resolves "joined", which replays
    // exactly from where the view stands. Read failures are translated where
    // they happen, so anything else is a bug applying the result: it throws
    // rather than passing for a rejoin.
    const boundedRejoin = async (
      strict: boolean,
      join: (scope: RejoinScope) => Promise<RejoinOutcome>,
    ): Promise<RejoinOutcome | { retry: unknown }> => {
      if (!isCurrent()) throw abortError();
      const attempt = new AbortController();
      let timedOut = false;
      const abortAttempt = () => attempt.abort();
      controller.signal.addEventListener("abort", abortAttempt, { once: true });
      const stalled = () => {
        timedOut = true;
        attempt.abort();
      };
      let timer = setTimeout(stalled, REJOIN_STALL_TIMEOUT_MS);
      let stopWaiting: (() => void) | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        stopWaiting = () => reject(abortError());
        attempt.signal.addEventListener("abort", stopWaiting, { once: true });
      });
      const scope: RejoinScope = {
        signal: attempt.signal,
        isCurrent: () => isCurrent() && !attempt.signal.aborted,
        progress: () => {
          if (attempt.signal.aborted) return;
          clearTimeout(timer);
          timer = setTimeout(stalled, REJOIN_STALL_TIMEOUT_MS);
        },
      };
      try {
        return await Promise.race([join(scope), stopped]);
      } catch (cause) {
        if (!isCurrent()) throw cause;
        if (timedOut) {
          return strict
            ? {
                retry: new TypeError(
                  `rejoining the live session stalled for ${REJOIN_STALL_TIMEOUT_MS}ms`,
                ),
              }
            : "joined";
        }
        if (strict && isRetryableStreamError(cause)) return { retry: cause };
        throw cause;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abortAttempt);
        if (stopWaiting) attempt.signal.removeEventListener("abort", stopWaiting);
      }
    };
    // A bounded rejoin whose failure replays exactly (the first open after
    // a window load, or a return from history: their gaps are short).
    const leniently = async (
      join: (scope: RejoinScope) => Promise<RejoinOutcome>,
    ): Promise<RejoinOutcome> => {
      const result = await boundedRejoin(false, join);
      return typeof result === "string" ? result : "joined";
    };

    // Every reconnect after the stream first opened (a dropped connection, a
    // heartbeat timeout, a sleep) joins the tip like a hidden-tab return: a
    // short gap replays over SSE, a long one is caught up or reloaded instead
    // of being poured through the live stream. A transient failure makes the
    // SDK back off and call this again, at most STRICT_REJOIN_ATTEMPTS times
    // in a row (until a connection opens); after that the reconnect replays
    // exactly rather than staying stuck.
    let strictFailures = 0;
    const beforeReconnect = async (cursor: number): Promise<number> => {
      // Deliver what the broken connection already yielded first.
      flush();
      if (!isCurrent()) throw abortError();
      const strict = strictFailures < STRICT_REJOIN_ATTEMPTS;
      const mark = sessionDetailReadMark();
      let result: RejoinOutcome | { retry: unknown };
      try {
        result = await boundedRejoin(strict, async (scope) => {
          if ((await rejoinLive(true, { strict, mark, scope })) === "joined") return "joined";
          let loaded: boolean;
          try {
            loaded = await loadLatestWindow(scope);
          } catch (cause) {
            if (!scope.isCurrent() || (strict && isRetryableStreamError(cause))) throw cause;
            // A window that cannot be read: replay exactly instead.
            return "joined";
          }
          if (!loaded) throw abortError();
          // The fresh window's own gap is short: join its head the same way.
          if ((await rejoinLive(true, { strict, mark, scope })) === "reload" && strict) {
            throw new TypeError("the session outran a fresh window while rejoining it");
          }
          return "joined";
        });
      } catch (cause) {
        if (!isCurrent()) throw abortError();
        // Not a read failure: end the stream visibly instead of letting the
        // SDK retry it forever.
        if (!isRetryableStreamError(cause)) throw cause;
        throw new Error(
          `rejoining the live session failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
      if (!isCurrent()) throw abortError();
      if (typeof result === "object") {
        strictFailures += 1;
        throw result.retry;
      }
      noteStreamResume();
      return Math.max(cursor, streamResumeSequenceRef.current);
    };

    void (async () => {
      try {
        if (reconcileForegroundResume) {
          setConnectionState("connecting");
          // A short gap replays over SSE into the loaded steps; a longer one
          // drops the steps of turns that were working and re-reads the tail.
          // A transient failure (the network often returns just after a wake)
          // retries with backoff instead of replaying the backlog it could
          // not size; only after that does the stream replay exactly.
          let outcome: RejoinOutcome;
          for (let attempt = 0; ; attempt += 1) {
            const strict = attempt < STRICT_REJOIN_ATTEMPTS;
            const result = await boundedRejoin(strict, (scope) =>
              rejoinLive(true, { strict, scope }),
            );
            if (typeof result === "string") {
              outcome = result;
              break;
            }
            await abortableDelay(
              Math.min(FOREGROUND_REJOIN_RETRY_MS * 2 ** attempt, FOREGROUND_REJOIN_RETRY_MAX_MS),
              controller.signal,
            );
          }
          if (outcome === "reload") {
            // Keep the last known window visible until the bounded latest
            // replacement is ready, then install that replacement below.
            initialWindowLoadedRef.current = false;
            setError(null);
          }
        } else if (!fullReplay && initialWindowLoadedRef.current && rejoinPendingRef.current) {
          rejoinPendingRef.current = false;
          if ((await leniently((scope) => rejoinLive(false, { scope }))) === "reload") {
            initialWindowLoadedRef.current = false;
          }
        }
        rejoinPendingRef.current = false;
        // A second pass only when the catch-up after the first window was too
        // long to append; the second window is fresh, so its gap is short.
        const windowPasses = fullReplay ? 0 : 2;
        for (
          let attempt = 0;
          attempt < windowPasses && !initialWindowLoadedRef.current;
          attempt += 1
        ) {
          setConnectionState("connecting");
          if (!(await loadLatestWindow())) {
            return;
          }
          // Join at the durable head rather than replaying every row since the
          // window's last conversation event: a working turn's steps (its
          // latest are read), or terminal output written after the last turn,
          // which only the sandbox dock reads.
          if (
            (await leniently((scope) => rejoinLive(true, { scope }))) === "reload" &&
            attempt === 0
          ) {
            initialWindowLoadedRef.current = false;
          }
        }
        if (fullReplay) {
          setInitialLoading(false);
        }
        noteStreamResume();
        const stream = client.streamEvents(workspaceId, sessionId, {
          after: streamResumeSequenceRef.current,
          signal: controller.signal,
          // Full replay keeps the SDK's exactly-once reconnects.
          ...(fullReplay ? {} : { beforeReconnect }),
          onOpen: () => {
            // The first open after this mount's initial tail: every read hook
            // read its projection alongside that tail, and the shared feed
            // re-reads one only for a later event. Later opens (reconnects,
            // foreground resumes) repair every projection.
            const initialOpen = openedStreamKeyRef.current !== streamKey;
            openedStreamKeyRef.current = streamKey;
            strictFailures = 0;
            // The outage is over: drop an error a long transient streak surfaced.
            if (streamTransientStreakRef.current?.surfaced) setError(null);
            streamTransientStreakRef.current = null;
            // Reconciliation repairs projections, but it must not block reading
            // the already-open SSE body. Otherwise live events accumulate in the
            // browser and appear as one delayed burst after every reconciler ends.
            reconcileAfterOpen(initialOpen);
          },
          onStateChange: (state) => {
            if (isCurrent()) {
              setConnectionState(state);
            }
          },
        });
        for await (const event of stream) {
          if (!isCurrent()) break;
          const boundedEvent = event;
          const boundedEventBytes = browserJsonBytes(boundedEvent);
          const separatorBytes = pending.length === 0 ? 0 : 1;
          if (
            pending.length > 0 &&
            (pending.length >= SESSION_EVENT_BROWSER_PENDING_MAX_COUNT ||
              pendingBytes + separatorBytes + boundedEventBytes >
                SESSION_EVENT_BROWSER_PENDING_MAX_BYTES)
          ) {
            flush();
          }
          pending.push(boundedEvent);
          pendingBytes += (pending.length === 1 ? 0 : 1) + boundedEventBytes;
          if (
            pending.length >= SESSION_EVENT_BROWSER_PENDING_MAX_COUNT ||
            pendingBytes >= SESSION_EVENT_BROWSER_PENDING_MAX_BYTES
          ) {
            flush();
          } else {
            scheduleFlush();
          }
        }
        if (isCurrent()) {
          flush();
          setConnectionState("ended");
        }
      } catch (cause) {
        if (isCurrent()) {
          flush();
          let announce = true;
          if (isTransientRequestError(cause)) {
            // The tail read or the stream failed transiently (an API rollout
            // or a network blip). Restart quietly, keeping the loading state
            // or the current view, and show the error only if it outlasts the
            // quiet window. Afterwards keep retrying in the background.
            const now = Date.now();
            const streak = (streamTransientStreakRef.current ??= {
              since: now,
              attempts: 0,
              surfaced: false,
            });
            const step = transientReadRetryStep(streak, now, DEFAULT_TRANSIENT_READ_RETRY);
            scheduleTransientRetry(step.delayMs, () => setStreamEpoch((epoch) => epoch + 1));
            if (step.quiet) {
              setConnectionState("connecting");
              return;
            }
            // One stable error per streak: background retries that fail the
            // same way must not re-announce it.
            announce = !streak.surfaced;
            streak.surfaced = true;
          } else {
            streamTransientStreakRef.current = null;
          }
          if (announce) setError(normalizeError(cause));
          setConnectionState("error");
          // A failed first compact-tail request has no later success path in
          // this effect instance. End the loading gate so hosts can render the
          // retryable error instead of an infinite initial spinner.
          setInitialLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
      if (transientRetryTimer !== null) clearTimeout(transientRetryTimer);
      if (generationRef.current === generation) {
        generationRef.current = generation + 1;
      }
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
      }
    };
  }, [
    client,
    workspaceId,
    sessionId,
    after,
    enabled,
    pageLive,
    streamEnabled,
    fullReplay,
    streamKey,
    streamEpoch,
    viewMode,
    reconcileSession,
    t,
    pruneStepStores,
    appendLiveSteps,
    presentedCallIds,
    startupTurns,
  ]);

  // A sleep, frozen tab or lost network usually killed the stream without the
  // page ever going hidden. Rejoin at once, like a hidden-tab return, instead
  // of waiting for the heartbeat timeout and then replaying the backlog.
  useEffect(() => {
    if (!sessionId || !streamEnabled) return;
    return subscribePageWake(() => {
      const stream = streamAbortRef.current;
      // History views and paused streams have no live connection to restore.
      if (!stream || stream.signal.aborted || viewModeRef.current !== "live") return;
      if (!fullReplay && initialWindowLoadedRef.current) {
        reconcileAfterPageResumeRef.current = true;
      }
      setStreamEpoch((epoch) => epoch + 1);
    });
  }, [sessionId, streamEnabled, fullReplay]);

  const navigationBusy = (): boolean =>
    loadingTargetRef.current ||
    loadingOlderRef.current ||
    loadingNewerRef.current ||
    loadingOldestRef.current ||
    loadingLatestRef.current;

  const loadOlder = useCallback(
    (): OlderHistoryLoadReceipt =>
      createOlderHistoryLoadReceipt(async (markCommitted, preserveTail, markTailPreserved) => {
        if (!ownsNavigation() || !sessionId || navigationBusy() || !hasOlderRef.current) {
          return false;
        }
        const before = oldestSequenceRef.current;
        if (before === null) {
          oldestSequenceRef.current = null;
          hasOlderRef.current = false;
          setHasOlder(false);
          return false;
        }
        const generation = navigationGenerationRef.current;
        const isCurrent = () => ownsNavigation() && navigationGenerationRef.current === generation;
        loadingOlderRef.current = true;
        setLoadingOlder(true);
        let published = false;
        try {
          const window = await loadEventWindow(t, client, workspaceId, sessionId, {
            before,
            pageSize: SESSION_HISTORY_PAGE_SIZE,
            targetGroups: OLDER_GROUP_TARGET,
            maxFetches: OLDER_FETCH_CAP,
            filteredPageCap: FILTERED_PAGE_CAP,
            isCurrent,
            filter: historyFilter,
          });
          if (!isCurrent()) {
            return false;
          }
          if (window.events.length === 0) {
            if (window.hasOlder && window.scanCursor < before) {
              // Every row read was dropped (a fallback read): continue below them.
              oldestSequenceRef.current = window.scanCursor;
              return true;
            }
            oldestSequenceRef.current = null;
            hasOlderRef.current = false;
            setHasOlder(false);
            return false;
          }
          const current = eventWindowRef.current;
          assertPrependOrder(current.events, window.events);
          const next = boundBrowserSessionEventWindow([...window.events, ...current.events], {
            direction: "oldest",
          });
          if (preserveTail && maxResumeSequence(next.events) < maxResumeSequence(current.events)) {
            // Automatic viewport filling must not navigate away from the
            // reader's retained tail. Explicit history navigation may do so.
            markTailPreserved();
            return false;
          }
          const status = observeSessionStatus(window.events, sessionStatusRef);
          const retained = {
            ...next,
            truncated: current.truncated || next.truncated,
          };
          const retainedOldest = retained.events[0]?.sequence ?? null;
          if (retainedOldest === null || retainedOldest >= before) {
            throw new Error("@opengeni/react: loadOlder made no durable sequence progress");
          }
          const retainedNewest = maxResumeSequenceOrNull(retained.events);
          const previousNewest = maxResumeSequenceOrNull(current.events);
          const evictedLiveTail =
            previousNewest !== null && retainedNewest !== null && retainedNewest < previousNewest;
          if (evictedLiveTail && viewModeRef.current === "live") {
            // The prepend leaves the live tip. Freeze the iterator before the
            // window is replaced so a late flush cannot append live rows onto
            // (and newest-bound away) the history the reader just requested.
            streamAbortRef.current?.abort();
          }
          eventWindowRef.current = retained;
          // Leaving the live tip ends live steps: working turns' steps go.
          if (evictedLiveTail) {
            skippedStepsThroughRef.current = null;
            pruneStepStores(retained.events, current.events);
          } else {
            const skippedThrough = skippedStepsThroughRef.current;
            if (skippedThrough !== null && windowTurns(window.events).size > 0) {
              // The first turn rows below the skipped range: when they reveal a
              // working turn that began below it, read that turn's newest steps
              // up to there, as rejoining a working turn does. Rows that arrived
              // live since (of any turn or none) do not change that.
              skippedStepsThroughRef.current = null;
              const working = activeConversationTurn(retained.events);
              const bounds = working
                ? conversationTurnBounds(retained.events).get(working)
                : undefined;
              if (working && bounds && bounds.first <= skippedThrough) {
                loadTurnStepsRef.current(working, skippedThrough + 1);
              }
            }
          }
          markCommitted();
          oldestSequenceRef.current = retainedOldest;
          newestSequenceRef.current = retainedNewest;
          if (evictedLiveTail) {
            streamResumeSequenceRef.current = maxResumeSequence(retained.events);
          }
          // Oldest-directed eviction can discard newer in-memory rows. That fact
          // keeps windowTruncated true, but it does not imply older durable rows
          // exist; only the backward DB page can answer hasOlder truthfully.
          const olderStillAvailable = window.hasOlder;
          hasOlderRef.current = olderStillAvailable;
          let newer: boolean | null = null;
          let enterHistory = false;
          if (viewModeRef.current === "history" || evictedLiveTail) {
            const highWater = lastSequenceRef.current;
            newer = retainedNewest !== null && (retainedNewest < highWater || retained.truncated);
            hasNewerRef.current = newer;
            if (evictedLiveTail) {
              // A full oldest-directed browser window cannot also retain the
              // live suffix. Keep the newly loaded history and page forward;
              // reconnecting SSE here immediately newest-bounds the window and
              // evicts every row the reader just requested.
              viewModeRef.current = "history";
              enterHistory = true;
            }
          }
          // Otherwise the merge is still one contiguous live suffix and the open
          // SSE iterator keeps appending to it: every flush reads
          // eventWindowRef, so rows delivered during or after this fetch land
          // once, in order, on the prepended window. Reopening the stream here
          // would flash a connecting state and re-run session reconciliation on
          // every scroll-up for no data benefit.
          loadingOlderRef.current = false;
          startTransition(() => {
            if (status !== undefined) {
              setSessionStatusProjection(status);
            }
            setEventWindow(retained);
            setHasOlder(olderStillAvailable);
            if (newer !== null) {
              setHasNewer(newer);
            }
            if (enterHistory) {
              setViewMode("history");
            }
            setLoadingOlder(false);
          });
          published = true;
          return olderStillAvailable;
        } catch (reason) {
          if (!isCurrent()) return false;
          throw reason;
        } finally {
          if (!published && isCurrent()) {
            loadingOlderRef.current = false;
            setLoadingOlder(false);
          }
        }
      }),
    [client, workspaceId, sessionId, ownsNavigation, t, historyFilter, pruneStepStores],
  );

  const loadOldest = useCallback(async (): Promise<boolean> => {
    if (!ownsNavigation() || !sessionId || navigationBusy() || !hasOlderRef.current) {
      return false;
    }
    // Explicit window replacement supersedes unresolved question destinations.
    const generation = ++navigationGenerationRef.current;
    const isCurrent = () => ownsNavigation() && navigationGenerationRef.current === generation;
    setQuestionEvidence(null);
    loadingOldestRef.current = true;
    setLoadingOldest(true);
    let published = false;
    try {
      const window = await loadForwardEventWindow(t, client, workspaceId, sessionId, {
        after: 0,
        pageSize: SESSION_HISTORY_PAGE_SIZE,
        targetGroups: OLDEST_GROUP_TARGET,
        maxFetches: OLDEST_FETCH_CAP,
        isCurrent,
        filter: historyFilter,
      });
      if (!isCurrent()) {
        return false;
      }
      if (window.events.length === 0) {
        hasOlderRef.current = false;
        setHasOlder(false);
        return false;
      }
      streamAbortRef.current?.abort();
      const status = observeSessionStatus(window.events, sessionStatusRef);
      // Keep the oldest prefix — never the middle or tip.
      const retained = boundBrowserSessionEventWindow(window.events, { direction: "oldest" });
      const retainedOldest = retained.events[0]?.sequence ?? null;
      const retainedNewest = maxResumeSequenceOrNull(retained.events);
      const previous = eventWindowRef.current.events;
      eventWindowRef.current = retained;
      // The start of history replaces the window; paging forward reads the rest.
      skippedStepsThroughRef.current = null;
      pruneStepStores(retained.events, previous);
      oldestSequenceRef.current = retainedOldest;
      newestSequenceRef.current = retainedNewest;
      hasOlderRef.current = false;
      const highWater = Math.max(lastSequenceRef.current, retainedNewest ?? 0);
      lastSequenceRef.current = highWater;
      const newer =
        window.hasNewer ||
        retained.truncated ||
        (retainedNewest !== null && retainedNewest < highWater);
      hasNewerRef.current = newer;
      initialWindowLoadedRef.current = true;
      setInitialHistoryReady(true);
      setError(null);
      viewModeRef.current = "history";
      loadingOldestRef.current = false;
      setNewerError(null);
      startTransition(() => {
        if (status !== undefined) {
          setSessionStatusProjection(status);
        }
        setEventWindow(retained);
        setHasOlder(false);
        setHasNewer(newer);
        setViewMode("history");
        setLoadingOldest(false);
      });
      published = true;
      return newer;
    } catch (reason) {
      if (!isCurrent()) return false;
      throw reason;
    } finally {
      if (!published && isCurrent()) {
        loadingOldestRef.current = false;
        setLoadingOldest(false);
      }
    }
  }, [client, workspaceId, sessionId, ownsNavigation, t, historyFilter, pruneStepStores]);

  const loadNewer = useCallback(async (): Promise<boolean> => {
    if (!ownsNavigation() || !sessionId || navigationBusy() || !hasNewerRef.current) {
      return false;
    }
    const afterSequence = newestSequenceRef.current;
    if (afterSequence === null) {
      hasNewerRef.current = false;
      setHasNewer(false);
      return false;
    }
    const generation = navigationGenerationRef.current;
    const isCurrent = () => ownsNavigation() && navigationGenerationRef.current === generation;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    let published = false;
    try {
      const window = await loadForwardEventWindow(t, client, workspaceId, sessionId, {
        after: afterSequence,
        pageSize: SESSION_HISTORY_PAGE_SIZE,
        targetGroups: NEWER_GROUP_TARGET,
        maxFetches: NEWER_FETCH_CAP,
        filteredPageCap: FILTERED_PAGE_CAP,
        isCurrent,
        filter: historyFilter,
      });
      if (!isCurrent()) {
        return false;
      }
      if (window.events.length === 0) {
        if (window.hasNewer && window.scanCursor > afterSequence) {
          // Every row read was dropped (a fallback read): continue above them.
          newestSequenceRef.current = window.scanCursor;
          return true;
        }
        setNewerError(null);
        hasNewerRef.current = false;
        setHasNewer(false);
        // Caught up with durable history — resume the live tip stream.
        streamResumeSequenceRef.current = afterSequence;
        rejoinPendingRef.current = true;
        viewModeRef.current = "live";
        setViewMode("live");
        setStreamEpoch((epoch) => epoch + 1);
        return false;
      }
      const current = eventWindowRef.current;
      assertAppendOrder(current.events, window.events);
      const status = observeSessionStatus(window.events, sessionStatusRef);
      const previousOldest = current.events[0]?.sequence ?? null;
      // Moving forward through history: keep the newest suffix of the merge.
      const next = appendBrowserSessionEventWindow(current, window.events);
      const retained = {
        ...next,
        truncated: current.truncated || next.truncated || window.hasNewer,
      };
      const retainedOldest = retained.events[0]?.sequence ?? null;
      const retainedNewest = maxResumeSequenceOrNull(retained.events);
      if (retainedNewest === null || retainedNewest <= afterSequence) {
        throw new Error("@opengeni/react: loadNewer made no durable sequence progress");
      }
      eventWindowRef.current = retained;
      pruneStepStores(retained.events, null);
      oldestSequenceRef.current = retainedOldest;
      newestSequenceRef.current = retainedNewest;
      // Evicting the start while paging forward re-arms hasOlder.
      if (
        retainedOldest !== null &&
        (previousOldest === null ||
          retainedOldest > previousOldest ||
          (retained.truncated &&
            retained.events[0]?.type !== "session.created" &&
            retainedOldest > 1))
      ) {
        hasOlderRef.current = true;
      }
      const rearmedOlder = hasOlderRef.current;
      const highWater = Math.max(lastSequenceRef.current, retainedNewest);
      lastSequenceRef.current = highWater;
      const newer = window.hasNewer || retainedNewest < highWater;
      hasNewerRef.current = newer;
      let resumeLive = false;
      if (!newer) {
        streamResumeSequenceRef.current = retainedNewest;
        rejoinPendingRef.current = true;
        viewModeRef.current = "live";
        resumeLive = true;
      }
      loadingNewerRef.current = false;
      setNewerError(null);
      startTransition(() => {
        if (status !== undefined) {
          setSessionStatusProjection(status);
        }
        setEventWindow(retained);
        setHasOlder(rearmedOlder);
        setHasNewer(newer);
        if (resumeLive) {
          setViewMode("live");
          setStreamEpoch((epoch) => epoch + 1);
        }
        setLoadingNewer(false);
      });
      published = true;
      return newer;
    } catch (reason) {
      // A settled request from an old navigation lifetime is not a failure of
      // the current session. Preserve current loading/error state as well.
      if (!isCurrent()) {
        return false;
      }
      setNewerError(normalizeError(reason));
      // Keep authorization and integrity failures actionable for callers;
      // timeline-owned invocations attach their own explicit recovery UI.
      throw reason;
    } finally {
      if (!published && isCurrent()) {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      }
    }
  }, [client, workspaceId, sessionId, ownsNavigation, t, historyFilter, pruneStepStores]);

  const jumpToSequence = useCallback(
    async (sequence: number, navigationOptions?: { signal?: AbortSignal }): Promise<boolean> => {
      const signal = navigationOptions?.signal;
      if (!ownsNavigation() || !sessionId || !Number.isSafeInteger(sequence) || sequence < 1)
        return false;
      // A navigation that was already cancelled (for example Find closed before
      // the caller could react) must not disturb any current view state.
      if (signal?.aborted) return false;
      // Explicit targets supersede both other targets and adjacent-page requests.
      const generation = ++navigationGenerationRef.current;
      setQuestionEvidence(null);
      const current = () => generation === navigationGenerationRef.current && ownsNavigation();
      const previousMode = viewModeRef.current;
      streamAbortRef.current?.abort();
      generationRef.current += 1;
      viewModeRef.current = "history";
      setViewMode("history");
      loadingOlderRef.current = loadingNewerRef.current = loadingOldestRef.current = false;
      setLoadingOlder(false);
      setLoadingNewer(false);
      setLoadingOldest(false);
      loadingTargetRef.current = true;
      setLoadingTarget(true);
      let published = false;
      try {
        const around = (filter: HistoryFilter | undefined) =>
          Promise.all([
            loadPreviousPage(client, workspaceId, sessionId, sequence + 1, {
              pageSize: 128,
              filter,
            }),
            loadNextPage(client, workspaceId, sessionId, sequence, { pageSize: 128, filter }),
          ]);
        let [before, following] = await around(historyFilter);
        // A step target (for example a Find match in a tool output) is read
        // with its neighbouring steps, as before conversation-first history.
        if (historyFilter && current() && !before.some((event) => event.sequence === sequence)) {
          [before, following] = await around(undefined);
        }
        // Close-during-fetch fence: a pending jump must not replace the window
        // after its owner (for example ConversationFind) has gone away. The
        // finally block still settles loadingTarget for this generation.
        if (signal?.aborted) return false;
        if (!current()) return false;
        if (!before.some((event) => event.sequence === sequence)) return false;
        // Bound each side, keeping the target even if its message alone exceeds
        // the ordinary byte budget. Never evict the very event being navigated to.
        const prefix = boundBrowserSessionEventWindow(before, {
          direction: "newest",
          maxBytes: SESSION_EVENT_BROWSER_MAX_BYTES / 2,
        });
        const retained = boundBrowserSessionEventWindow([...prefix.events, ...following], {
          direction: "oldest",
        });
        if (!retained.events.some((event) => event.sequence === sequence)) return false;
        streamAbortRef.current?.abort();
        generationRef.current += 1;
        const status = observeSessionStatus(retained.events, sessionStatusRef);
        const previous = eventWindowRef.current.events;
        eventWindowRef.current = retained;
        pruneStepStores(retained.events, previous);
        oldestSequenceRef.current = retained.events[0]!.sequence;
        newestSequenceRef.current = maxResumeSequenceOrNull(retained.events);
        lastSequenceRef.current = Math.max(lastSequenceRef.current, newestSequenceRef.current ?? 0);
        hasOlderRef.current = !isLogStart(retained.events[0]!);
        // Compact/byte-bounded pages may be short despite more durable history.
        // Only an empty forward page proves the end (same rule as loadNewer).
        hasNewerRef.current =
          following.length > 0 ||
          retained.truncated ||
          (newestSequenceRef.current ?? 0) < lastSequenceRef.current;
        initialWindowLoadedRef.current = true;
        setInitialHistoryReady(true);
        setError(null);
        viewModeRef.current = "history";
        setEventWindow(retained);
        setHasOlder(hasOlderRef.current);
        setHasNewer(hasNewerRef.current);
        setInitialLoading(false);
        setViewMode("history");
        setNewerError(null);
        if (status !== undefined) setSessionStatusProjection(status);
        published = true;
        return true;
      } catch (reason) {
        if (!current() || signal?.aborted) return false;
        throw reason;
      } finally {
        if (current()) {
          loadingTargetRef.current = false;
          setLoadingTarget(false);
          if (!published && previousMode === "live") {
            viewModeRef.current = "live";
            setViewMode("live");
            setStreamEpoch((epoch) => epoch + 1);
          }
        }
      }
    },
    [client, workspaceId, sessionId, ownsNavigation, historyFilter, pruneStepStores],
  );

  const jumpToLatestQuestion = useCallback(
    async (questionOptions?: LatestQuestionOptions): Promise<number | null> => {
      if (!sessionId || !ownsNavigation()) return null;
      let generation = navigationGenerationRef.current;
      const current = () => ownsNavigation() && generation === navigationGenerationRef.current;
      try {
        // Optional action code stays off the session-open path. Capture identity
        // before the import and fence its completion just like network reads.
        const { resolveLatestQuestion } = await import("./latest-question");
        if (!current()) return null;
        const destination = await resolveLatestQuestion(t, {
          client,
          workspaceId,
          sessionId,
          isCurrent: current,
          resumeSequence: maxResumeSequence,
          options: questionOptions,
        });
        if (!destination || !current()) return null;
        if (!eventWindowRef.current.events.some((event) => event.sequence === destination.anchor)) {
          const navigation = jumpToSequence(destination.anchor);
          generation = navigationGenerationRef.current;
          if (!(await navigation) || !current()) return null;
        }
        setQuestionEvidence({
          client,
          streamKey,
          anchor: destination.anchor,
          events: destination.events,
        });
        return destination.questionSequence;
      } catch (reason) {
        if (!current()) return null;
        throw reason;
      }
    },
    [client, workspaceId, sessionId, streamKey, ownsNavigation, jumpToSequence, t],
  );

  const jumpToLatest = useCallback(async (): Promise<void> => {
    // An old host retry closure must not clear a replacement session's error
    // or abort its live feed before the passive effect cleanup has run.
    if (!ownsNavigation()) return;
    if (loadingTargetRef.current) {
      navigationGenerationRef.current += 1;
      loadingTargetRef.current = false;
      setLoadingTarget(false);
    }
    if (!sessionId || navigationBusy()) {
      return;
    }
    navigationGenerationRef.current += 1;
    setQuestionEvidence(null);
    loadingLatestRef.current = true;
    setLoadingLatest(true);
    setNewerError(null);
    setError(null);
    let published = false;
    try {
      streamAbortRef.current?.abort();
      hasNewerRef.current = false;
      hasOlderRef.current = false;
      newestSequenceRef.current = null;
      oldestSequenceRef.current = null;
      eventWindowRef.current = EMPTY_EVENT_WINDOW;
      initialWindowLoadedRef.current = false;
      streamResumeSequenceRef.current = after;
      viewModeRef.current = "live";
      loadingLatestRef.current = false;
      startTransition(() => {
        setHasNewer(false);
        setHasOlder(false);
        setEventWindow(EMPTY_EVENT_WINDOW);
        setInitialLoading(true);
        setViewMode("live");
        setStreamEpoch((epoch) => epoch + 1);
        setLoadingLatest(false);
      });
      published = true;
      // Effect reloads the tip. The tip fetch itself is owned by the effect.
      await Promise.resolve();
    } finally {
      if (!published) {
        loadingLatestRef.current = false;
        setLoadingLatest(false);
      }
    }
  }, [after, sessionId, ownsNavigation]);

  const identityMatches = stateStreamKey === streamKey;
  const freshTail =
    identityMatches && initialHistoryReady && viewMode === "live" && !fullReplay
      ? {
          events: eventWindow.events,
          hasOlder,
          truncated: eventWindow.truncated,
          bytes: eventWindow.bytes,
          sessionStatus: sessionStatusProjection,
        }
      : null;
  // Reopening a conversation draws the tail it showed when it was left (only
  // when the host retains reads for `client`) until its own fresh tail lands.
  const retainedTail = useRetainedSessionView(client, workspaceId, sessionId, "events", freshTail, {
    enabled: !fullReplay,
    bytes: (tail) => tail.bytes,
    budgetBytes: SESSION_EVENT_BROWSER_MAX_BYTES,
    discard: identityMatches && deniesRetainedView(error),
  });
  const showRetained = retainedTail !== null && !(identityMatches && initialHistoryReady);
  const visibleEvents = showRetained
    ? retainedTail.events
    : identityMatches
      ? eventWindow.events
      : EMPTY_EVENTS;
  const visibleHasOlder = showRetained ? retainedTail.hasOlder : identityMatches && hasOlder;
  const visibleTruncated = showRetained ? retainedTail.truncated : eventWindow.truncated;
  const liveSteps = identityMatches && !showRetained;
  const visibleStepStores = liveSteps ? stepStores : EMPTY_STEP_STORES;
  const visiblePresentedOutputs = liveSteps ? presentedOutputs : EMPTY_PRESENTED_OUTPUTS;
  const visibleTurnless = liveSteps ? turnlessSteps : EMPTY_TURNLESS_STEPS;
  const readToolOutput = useCallback(
    async (sequence: number) =>
      sessionId
        ? (
            await readEventPage(client, workspaceId, sessionId, {
              includeTypes: ["agent.toolCall.output"],
              after: Math.max(0, sequence - 1),
              before: sequence + 1,
              direction: "after",
              limit: 1,
              payloadMode: "full",
            })
          ).events
        : [],
    [client, workspaceId, sessionId],
  );
  const toolOutputs = useToolOutputReads(readToolOutput, stepStores);
  const visibleToolOutputs = liveSteps ? toolOutputs.exact : EMPTY_PRESENTED_OUTPUTS;
  // The conversation plus loaded steps, presented results, exact tool outputs
  // and the live turnless tail, by sequence.
  const loadedEvents = useMemo(
    () =>
      mergeLoadedEvents(
        visibleEvents,
        visibleStepStores,
        visiblePresentedOutputs,
        visibleTurnless.events,
        visibleToolOutputs,
      ),
    [
      visibleEvents,
      visibleStepStores,
      visiblePresentedOutputs,
      visibleTurnless,
      visibleToolOutputs,
    ],
  );
  // Turns whose steps are not all loaded get an expandable, loadable marker.
  const turnSteps = useMemo(() => {
    if (fullReplay) return undefined;
    const markers = new Map<string, Pick<TurnStepsItem, "state" | "load" | "retain">>();
    // Live turnless rows inside a turn are not its hidden steps.
    const bounded = withTurnlessSteps(visibleEvents, visibleTurnless);
    for (const [turnId, bounds] of conversationTurnBounds(bounded)) {
      const store = visibleStepStores.get(turnId);
      // A turn whose only steps are its bookkeeping (a plain answer's model
      // usage) has nothing to open.
      if (store && !store.loading && !store.error && !stepStoreHasOlder(store, bounds)) {
        if (!store.events.some((event) => CONTENT_STEP_TYPES.has(event.type))) continue;
      }
      const state: TurnStepsItem["state"] | null = store
        ? store.loading
          ? "loading"
          : store.error
            ? "error"
            : stepStoreHasOlder(store, bounds)
              ? "partial"
              : "complete"
        : bounds.hidden
          ? "idle"
          : null;
      if (state === null) continue;
      // A retained view is drawn before its session's own window: its
      // markers wait, and load once that window replaces them.
      markers.set(turnId, { state, ...(liveSteps ? turnStepHandle(turnId) : RETAINED_VIEW_STEPS) });
    }
    return markers;
  }, [fullReplay, visibleEvents, visibleTurnless, visibleStepStores, liveSteps, turnStepHandle]);
  const timeline = useMemo(() => {
    const witness =
      questionEvidence?.client === client &&
      questionEvidence.streamKey === streamKey &&
      visibleEvents.some((event) => event.sequence === questionEvidence.anchor)
        ? questionEvidence.events
        : EMPTY_EVENTS;
    const timelineOptions = {
      partialStart: visibleHasOlder || visibleTruncated || after > 0,
      ...(turnSteps ? { turnSteps } : {}),
      ...(liveSteps ? { toolOutputs: toolOutputs.reader } : {}),
    };
    if (witness.length === 0) return buildTimeline(t, loadedEvents, timelineOptions);
    const ids = new Set(loadedEvents.map((event) => event.id));
    return buildTimeline(
      t,
      [...loadedEvents, ...witness.filter((event) => !ids.has(event.id))],
      timelineOptions,
    );
  }, [
    loadedEvents,
    visibleEvents,
    visibleHasOlder,
    visibleTruncated,
    after,
    questionEvidence,
    client,
    streamKey,
    turnSteps,
    liveSteps,
    toolOutputs.reader,
    t,
  ]);

  // Presented results (an image, a published file, a Skill change) are primary
  // output, but their output rows are steps: read each one directly.
  useEffect(() => {
    if (fullReplay || !sessionId || !identityMatches || !initialHistoryReady) return;
    const resolved = new Set<string>(presentedOutputs.keys());
    const collect = (events: readonly SessionEvent[]) => {
      for (const event of events) {
        // A previewed result is not presented: its exact read still runs.
        if (event.type !== "agent.toolCall.output" || isToolOutputPreviewEvent(event)) continue;
        const id = (event.payload as Record<string, unknown> | null)?.id;
        if (typeof id === "string") resolved.add(id);
      }
    };
    collect(eventWindow.events);
    for (const store of stepStores.values()) collect(store.events);
    const requested = presentedRequestedRef.current;
    // At most PRESENTED_OUTPUT_READS_PER_PASS reads run at once.
    let inFlight = 0;
    for (const request of requested.values()) if (request.pending) inFlight += 1;
    const room = PRESENTED_OUTPUT_READS_PER_PASS - inFlight;
    if (room <= 0) return;
    const missing: Array<{ callId: string; sequence: number; turnId: string | null }> = [];
    for (const event of eventWindow.events) {
      if (event.type !== "agent.toolCall.created") continue;
      const payload = event.payload as Record<string, unknown> | null;
      const callId = payload?.id;
      if (
        typeof callId !== "string" ||
        resolved.has(callId) ||
        requested.has(callId) ||
        !isPresentedSessionToolName(payload?.name)
      ) {
        continue;
      }
      missing.push({ callId, sequence: event.sequence, turnId: event.turnId ?? null });
    }
    if (missing.length === 0) return;
    const bounds = conversationTurnBounds(eventWindow.events);
    for (const { callId, sequence, turnId } of missing.slice(-room)) {
      const request: PresentedRequest = { turnId, pending: true };
      requested.set(callId, request);
      const isCurrent = () =>
        presentedRequestedRef.current === requested && requested.get(callId) === request;
      const terminal = turnId ? (bounds.get(turnId)?.terminal ?? null) : null;
      void findPresentedOutput(client, workspaceId, sessionId, callId, sequence, terminal).then(
        (output) => {
          if (!ownsNavigation() || !isCurrent()) return;
          request.pending = false;
          // Not found: a working tool's result arrives live, and a settled
          // turn's result does not exist. Either way, read the next ones.
          if (output) setPresentedOutputs((current) => new Map(current).set(callId, output));
          setPresentedPass((pass) => pass + 1);
        },
        () => {
          // Retried after a pause; meanwhile the tool row still shows its call.
          if (!isCurrent()) return;
          requested.delete(callId);
          const failures = (presentedFailuresRef.current.get(callId) ?? 0) + 1;
          presentedFailuresRef.current.set(callId, failures);
          if (failures > PRESENTED_OUTPUT_RETRIES) return;
          setTimeout(() => {
            if (ownsNavigation()) setPresentedPass((pass) => pass + 1);
          }, PRESENTED_OUTPUT_RETRY_MS * failures);
        },
      );
    }
  }, [
    fullReplay,
    sessionId,
    identityMatches,
    initialHistoryReady,
    eventWindow,
    stepStores,
    presentedOutputs,
    presentedPass,
    client,
    workspaceId,
    ownsNavigation,
  ]);

  return {
    events: loadedEvents,
    timeline,
    sessionStatus: showRetained
      ? retainedTail.sessionStatus
      : identityMatches
        ? sessionStatusProjection
        : null,
    sessionStatusSequence: identityMatches ? sessionStatusRef.current.sequence : 0,
    connectionState: identityMatches ? connectionState : "idle",
    lastSequence: identityMatches ? lastSequenceRef.current : after,
    windowBytes: identityMatches ? eventWindow.bytes : 2,
    windowTruncated: identityMatches ? eventWindow.truncated : false,
    initialLoading: fullReplay || showRetained ? false : identityMatches ? initialLoading : true,
    initialHistoryReady: identityMatches && initialHistoryReady,
    hasOlder: visibleHasOlder,
    loadingOlder: !identityMatches ? false : loadingOlder,
    loadOlder,
    hasNewer: !identityMatches ? false : hasNewer,
    loadingNewer: !identityMatches ? false : loadingNewer,
    loadNewer,
    loadingOldest: !identityMatches ? false : loadingOldest,
    loadOldest,
    loadingLatest: !identityMatches ? false : loadingLatest,
    jumpToLatest,
    jumpToLatestQuestion,
    jumpToSequence,
    loadingTarget: identityMatches && loadingTarget,
    error: identityMatches ? (newerError ?? error) : null,
  };
}

/**
 * Keep one direction-aware count+byte-bounded browser window. Live/default
 * accumulation retains the newest suffix; backward paging retains the oldest
 * prefix so newly fetched history cannot be immediately evicted. This is
 * deliberately separate from durable history and transport paging: when a
 * backward page evicts the live tail, the hook enters bounded history mode and
 * preserves the highest-ever-observed sequence separately for forward paging.
 * The source event remains durable in PostgreSQL throughout. An event larger
 * than the byte target is retained alone, never replaced by a lossy preview.
 */
export function boundBrowserSessionEventWindow(
  events: readonly SessionEvent[],
  options: {
    maxBytes?: number;
    maxCount?: number;
    direction?: "newest" | "oldest";
  } = {},
): BrowserSessionEventWindow {
  const maxBytes = Math.max(1024, options.maxBytes ?? SESSION_EVENT_BROWSER_MAX_BYTES);
  const maxCount = Math.max(1, Math.floor(options.maxCount ?? SESSION_EVENT_BROWSER_MAX_COUNT));
  const safe = events;
  const selected: SessionEvent[] = [];
  let bytes = 2; // []
  const direction = options.direction ?? "newest";
  const start = direction === "newest" ? safe.length - 1 : 0;
  const end = direction === "newest" ? Math.max(-1, safe.length - maxCount - 1) : safe.length;
  const step = direction === "newest" ? -1 : 1;
  for (let index = start; index !== end && selected.length < maxCount; index += step) {
    const event = safe[index]!;
    const eventBytes = browserJsonBytes(event);
    const separator = selected.length === 0 ? 0 : 1;
    if (selected.length > 0 && bytes + separator + eventBytes > maxBytes) break;
    selected.push(event);
    bytes += separator + eventBytes;
  }
  if (direction === "newest") selected.reverse();
  return {
    events: selected,
    bytes,
    truncated: selected.length < safe.length,
  };
}

/** @internal Append immutable events without serializing the retained history again. */
export function appendBrowserSessionEventWindow(
  current: BrowserSessionEventWindow,
  batch: readonly SessionEvent[],
  options: { maxBytes?: number; maxCount?: number } = {},
): BrowserSessionEventWindow {
  const maxBytes = Math.max(1024, options.maxBytes ?? SESSION_EVENT_BROWSER_MAX_BYTES);
  const maxCount = Math.max(1, Math.floor(options.maxCount ?? SESSION_EVENT_BROWSER_MAX_COUNT));
  const events = [...current.events, ...batch];
  let bytes = current.bytes;
  for (let index = 0; index < batch.length; index += 1) {
    bytes += browserJsonBytes(batch[index]) + (current.events.length + index > 0 ? 1 : 0);
  }
  let start = 0;
  // Preserve the newest event even when it alone exceeds the byte target,
  // matching the full-window reducer and retaining exact cursor progress.
  while (events.length - start > 1 && (bytes > maxBytes || events.length - start > maxCount)) {
    bytes -= browserJsonBytes(events[start]) + 1;
    start += 1;
  }
  return {
    events: start === 0 ? events : events.slice(start),
    bytes,
    truncated: current.truncated || start > 0,
  };
}

function browserJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function observeSessionStatus(
  events: readonly SessionEvent[],
  ref: { current: { sequence: number; status: SessionStatus | null } },
): SessionStatus | undefined {
  let latest: { sequence: number; status: SessionStatus } | null = null;
  for (const event of events) {
    const status = sessionStatusFromEvents([event]);
    if (status && (!latest || event.sequence >= latest.sequence)) {
      latest = { sequence: event.sequence, status };
    }
  }
  if (!latest || latest.sequence < ref.current.sequence) return undefined;
  ref.current = latest;
  return latest.status;
}

/**
 * The conversation events after `cursor` through `head`, or null when they
 * span more than the catch-up cap (the caller then reloads the latest window).
 * Steps are not replayed: a turn's steps load when a reader opens it.
 */
async function loadConversationCatchup(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  cursor: number,
  head: number,
  options: { signal?: AbortSignal; isCurrent: () => boolean; progress?: () => void },
): Promise<SessionEvent[] | null> {
  const events: SessionEvent[] = [];
  let after = cursor;
  for (let fetch = 0; fetch < CATCHUP_MAX_PAGES; fetch += 1) {
    if (options.signal?.aborted) throw abortError();
    const page = await readConversationPage(client, workspaceId, sessionId, {
      after,
      before: head + 1,
      direction: "after",
      limit: SESSION_HISTORY_PAGE_SIZE,
      compact: true,
      payloadMode: "full",
    });
    if (!options.isCurrent()) throw abortError();
    options.progress?.();
    const fresh = page.filter((event) => eventResumeSequence(event) > after);
    assertAscending(fresh);
    events.push(...fresh);
    // Rows the reader dropped (an older server's tool calls) still advance.
    if (page.raw.newest === null || page.raw.newest <= after) return events;
    after = page.raw.newest;
    if (after >= head || page.hasMore === false) return events;
  }
  return null;
}

type LoadedEventWindow = {
  events: SessionEvent[];
  oldestSequence: number | null;
  newestSequence: number;
  hasOlder: boolean;
  /** The next older read starts below this (the oldest row read, kept or not). */
  scanCursor: number;
};

type LoadedForwardEventWindow = {
  events: SessionEvent[];
  oldestSequence: number | null;
  newestSequence: number;
  hasNewer: boolean;
  /** The next newer read starts above this (the newest row read, kept or not). */
  scanCursor: number;
};

async function loadEventWindow(
  t: OpenGeniText,
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  options: {
    before: number;
    pageSize: number;
    targetGroups: number;
    maxFetches: number;
    boundaryPageCap?: number;
    /** Pages kept nothing of that do not count against the caps. */
    filteredPageCap?: number;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    /** Called after each completed page read. */
    progress?: () => void;
    filter?: HistoryFilter | undefined;
  },
): Promise<LoadedEventWindow> {
  let cursor = options.before;
  let buffer: SessionEvent[] = [];
  let reachedStart = false;
  let fetches = 0;
  let filteredPages = 0;
  // The newest sequence read, kept or not: what the window has covered.
  let rawNewest = 0;
  // A page the reader kept nothing of does not count, up to filteredPageCap.
  const counts = (page: PreviousPage): boolean => {
    rawNewest = Math.max(rawNewest, page.raw.newest ?? 0);
    return page.length > 0 || (filteredPages += 1) > (options.filteredPageCap ?? 0);
  };

  while (fetches < options.maxFetches) {
    if (buffer.length > 0 && groupCount(t, buffer) >= options.targetGroups) {
      break;
    }
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      filter: options.filter,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.isCurrent?.() === false) throw abortError();
    options.progress?.();
    if (page.raw.oldest === null) {
      reachedStart = true;
      break;
    }
    if (counts(page)) fetches += 1;
    assertAscending(page);
    buffer = [...page, ...buffer];
    // Below the oldest row read, even one the reader dropped.
    cursor = page.raw.oldest;
    if (page.raw.oldest <= 1 || (page[0] !== undefined && isLogStart(page[0]))) {
      reachedStart = true;
      break;
    }
  }

  // Boundary snap: a window that starts mid-turn TRIMS its head to the oldest
  // turn boundary already in the buffer — the dropped fragment is refetched by
  // the next loadOlder (everything below the new oldest sequence), whose own
  // window snaps the same way, so every seam lands on a turn start. Extra
  // page is fetched only when the buffer holds no boundary at all (one dense
  // turn); past the cap the existing truncation/hasOlder signal remains true.
  let snapPages = 0;
  while (
    !reachedStart &&
    findBoundaryIndex(buffer) === -1 &&
    snapPages < (options.boundaryPageCap ?? 0)
  ) {
    const page = await loadPreviousPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      filter: options.filter,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.isCurrent?.() === false) throw abortError();
    options.progress?.();
    if (page.raw.oldest === null) {
      reachedStart = true;
      break;
    }
    if (counts(page)) {
      fetches += 1;
      snapPages += 1;
    }
    assertAscending(page);
    buffer = [...page, ...buffer];
    cursor = page.raw.oldest;
    if (page.raw.oldest <= 1 || (page[0] !== undefined && isLogStart(page[0]))) {
      reachedStart = true;
      break;
    }
  }
  if (!reachedStart) {
    const boundary = findBoundaryIndex(buffer);
    if (boundary > 0) {
      buffer = buffer.slice(boundary);
    }
  }
  const densityWindow = trimBackwardToGroupTarget(t, buffer, options.targetGroups);
  buffer = densityWindow.events;

  const oldest = buffer[0] ?? null;
  const newest = buffer[buffer.length - 1] ?? null;
  return {
    events: buffer,
    oldestSequence: oldest?.sequence ?? null,
    // A window that kept nothing resumes a live stream above the rows it read,
    // not at the start of history. Otherwise rows dropped above its newest
    // kept row are replayed (or caught up) into their turn's steps, so a
    // working turn's latest tool calls still show.
    newestSequence: newest ? maxResumeSequence(buffer) : rawNewest,
    // An empty window that stopped before the start is still pageable.
    hasOlder:
      buffer.length > 0
        ? densityWindow.trimmed || (!reachedStart && oldest?.type !== "session.created")
        : !reachedStart,
    scanCursor: cursor,
  };
}

/** Index of the oldest clean turn start in the buffer, or -1. */
function findBoundaryIndex(events: SessionEvent[]): number {
  for (let index = 0; index < events.length; index += 1) {
    if (isTurnBoundary(events[index]!)) {
      return index;
    }
  }
  return -1;
}

function isTurnBoundary(event: SessionEvent): boolean {
  return event.type === "session.created" || event.type === "user.message";
}

/**
 * Forward (oldest→newer) density-bounded window. Used for jump-to-start and
 * loadNewer so the browser never walks the whole middle gap.
 */
async function loadForwardEventWindow(
  t: OpenGeniText,
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  options: {
    after: number;
    pageSize: number;
    targetGroups: number;
    maxFetches: number;
    /** Pages kept nothing of that do not count against the caps. */
    filteredPageCap?: number;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    filter?: HistoryFilter | undefined;
  },
): Promise<LoadedForwardEventWindow> {
  let cursor = options.after;
  let buffer: SessionEvent[] = [];
  let fetches = 0;
  let reachedEnd = false;
  let filteredPages = 0;

  while (fetches < options.maxFetches) {
    if (buffer.length > 0 && groupCount(t, buffer) >= options.targetGroups) {
      break;
    }
    const page = await loadNextPage(client, workspaceId, sessionId, cursor, {
      pageSize: options.pageSize,
      filter: options.filter,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (options.isCurrent?.() === false) throw abortError();
    if (page.raw.newest === null) {
      reachedEnd = true;
      break;
    }
    // A page the reader kept nothing of does not count, up to filteredPageCap.
    if (page.length > 0 || (filteredPages += 1) > (options.filteredPageCap ?? 0)) fetches += 1;
    assertAscending(page);
    buffer = [...buffer, ...page];
    // Compact events retain their first raw sequence in `sequence` and expose
    // the covered high-water mark through `coalescedUntil`. Advancing by the
    // first sequence duplicates compacted text on the next page. A compact
    // response length is not an end-of-history signal either: thousands of raw
    // events may legitimately collapse into one returned event.
    cursor = page.raw.newest;
  }
  const densityWindow = trimForwardToGroupTarget(t, buffer, options.targetGroups);
  buffer = densityWindow.events;

  const oldest = buffer[0] ?? null;
  const newest = buffer[buffer.length - 1] ?? null;
  return {
    events: buffer,
    oldestSequence: oldest?.sequence ?? null,
    newestSequence: newest ? maxResumeSequence(buffer) : 0,
    // An empty window that stopped before the end is still pageable.
    hasNewer: buffer.length > 0 ? densityWindow.trimmed || !reachedEnd : !reachedEnd,
    scanCursor: cursor,
  };
}

type DensityWindow = {
  events: SessionEvent[];
  trimmed: boolean;
};

/** Keep the newest complete turn groups near an older-history seam. */
function trimBackwardToGroupTarget(
  t: OpenGeniText,
  events: SessionEvent[],
  targetGroups: number,
): DensityWindow {
  if (!Number.isFinite(targetGroups) || targetGroups <= 0 || events.length === 0) {
    return { events, trimmed: false };
  }
  for (let index = events.length - 1; index > 0; index -= 1) {
    if (!isTurnBoundary(events[index]!)) continue;
    const candidate = events.slice(index);
    if (groupCount(t, candidate) >= targetGroups) {
      return { events: candidate, trimmed: true };
    }
  }
  return { events, trimmed: false };
}

/** Keep the oldest complete turn groups near a forward-history seam. */
function trimForwardToGroupTarget(
  t: OpenGeniText,
  events: SessionEvent[],
  targetGroups: number,
): DensityWindow {
  if (!Number.isFinite(targetGroups) || targetGroups <= 0 || events.length === 0) {
    return { events, trimmed: false };
  }
  for (let index = 1; index < events.length; index += 1) {
    if (!isTurnBoundary(events[index]!)) continue;
    const candidate = events.slice(0, index);
    if (groupCount(t, candidate) >= targetGroups) {
      return { events: candidate, trimmed: true };
    }
  }
  return { events, trimmed: false };
}

/** A history page, plus the rows read before the reader dropped any. */
type PreviousPage = SessionEvent[] & {
  requested: number;
  raw: RawPageExtent;
  hasMore?: boolean | null;
};

type RawPageExtent = {
  /** The oldest row read (null when the read was empty). */
  oldest: number | null;
  /** The newest sequence the read covered (null when it was empty). */
  newest: number | null;
};

function rawPageExtent(events: readonly SessionEvent[]): RawPageExtent {
  return events.length === 0
    ? { oldest: null, newest: null }
    : { oldest: events[0]!.sequence, newest: maxResumeSequence(events) };
}

function historyPage(
  events: SessionEvent[],
  requested: number,
  raw: RawPageExtent = rawPageExtent(events),
): PreviousPage {
  return Object.assign(events, { requested, raw });
}

async function loadPreviousPage(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  before: number,
  options: {
    pageSize: number;
    signal?: AbortSignal;
    filter?: HistoryFilter | undefined;
  },
): Promise<PreviousPage> {
  if (options.signal?.aborted) {
    throw abortError();
  }
  const requested = options.pageSize;
  if (requested === 0) {
    return historyPage([], requested);
  }
  const read: ConversationReadOptions = {
    before,
    limit: requested,
    compact: true,
    // Monitoring summaries omit correlation fields once a bounded durable
    // payload exceeds their preview threshold. The browser timeline needs the
    // exact stored payload so persisted tool outputs still match their
    // calls and expose truthful truncation telemetry after a reload.
    payloadMode: "full",
  };
  const page = options.filter
    ? await readConversationPage(client, workspaceId, sessionId, read)
    : historyPage(await client.listEvents(workspaceId, sessionId, read), requested);
  if (options.signal?.aborted) {
    throw abortError();
  }
  return Object.assign(page, { requested });
}

async function loadNextPage(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  after: number,
  options: {
    pageSize: number;
    signal?: AbortSignal;
    filter?: HistoryFilter | undefined;
    before?: number | undefined;
  },
): Promise<PreviousPage> {
  if (options.signal?.aborted) {
    throw abortError();
  }
  const requested = options.pageSize;
  if (requested === 0) {
    return historyPage([], requested);
  }
  const read: ConversationReadOptions = {
    ...(options.before !== undefined ? { before: options.before } : {}),
    after,
    limit: requested,
    compact: true,
    direction: "after",
    payloadMode: "full",
  };
  const page = options.filter
    ? await readConversationPage(client, workspaceId, sessionId, read)
    : historyPage(await client.listEvents(workspaceId, sessionId, read), requested);
  if (options.signal?.aborted) {
    throw abortError();
  }
  return Object.assign(page, { requested });
}

function groupCount(t: OpenGeniText, events: SessionEvent[]): number {
  if (events.length === 0) {
    return 0;
  }
  return groupTimeline(t, buildTimeline(t, events)).length;
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

function eventResumeSequence(event: SessionEvent): number {
  const streamedCoverage = sessionEventStreamCoveredThrough(event);
  if (streamedCoverage !== null) return streamedCoverage;
  return typeof event.coveredThrough === "number" &&
    Number.isSafeInteger(event.coveredThrough) &&
    event.coveredThrough >= event.sequence
    ? event.coveredThrough
    : event.sequence;
}

function assertAscending(events: SessionEvent[]): void {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]!.sequence >= events[index]!.sequence) {
      throw new Error("@opengeni/react: session events must be ordered by ascending sequence");
    }
  }
}

function assertPrependOrder(existing: SessionEvent[], older: SessionEvent[]): void {
  if (!shouldAssertDevelopment() || existing.length === 0 || older.length === 0) {
    return;
  }
  if (older[older.length - 1]!.sequence >= existing[0]!.sequence) {
    throw new Error("@opengeni/react: loadOlder returned overlapping session events");
  }
}

function assertAppendOrder(existing: SessionEvent[], newer: SessionEvent[]): void {
  if (!shouldAssertDevelopment() || existing.length === 0 || newer.length === 0) {
    return;
  }
  if (newer[0]!.sequence <= existing[existing.length - 1]!.sequence) {
    throw new Error("@opengeni/react: loadNewer returned overlapping session events");
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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One rejoin attempt's cancellation: its signal, whether it still owns state,
 * and `progress`, reported after each completed read (it keeps a slow but
 * progressing attempt from being abandoned as stalled).
 */
type RejoinScope = { signal: AbortSignal; isCurrent: () => boolean; progress?: () => void };
type RejoinOutcome = "joined" | "reload";

/* ----------------------------------------------------------------------------
   Conversation-first history

   History reads exclude a turn's steps (tool calls and outputs, streamed
   reasoning and command output), which are most of a long session's rows and
   bytes. Live steps and steps a reader opens are kept per turn, apart from the
   contiguous conversation window, and merged only for projection.
   -------------------------------------------------------------------------- */

const CONTENT_STEP_TYPES: ReadonlySet<string> = new Set(SESSION_EVENT_CONTENT_STEP_TYPES);
const COMPAT_EXCLUDED_TYPES: ReadonlySet<string> = new Set(
  SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES,
);
/** History reads of the conversation (see {@link readConversationPage}). */
const CONVERSATION_FILTER: HistoryFilter = "conversation";
// One opened page of a turn's steps, newest first. Inside the server's
// single-query interactive page so opening a turn is one indexed read.
export const SESSION_TURN_STEP_PAGE_SIZE = 200;
// A collapsed live turn only shows its latest step; keep a short tail.
export const SESSION_TURN_LIVE_STEP_TAIL = 200;
const SESSION_TURN_LIVE_STEP_TAIL_BYTES = 2 * 1024 * 1024;
// Live turnless output kept for the sandbox terminal between its renders.
// It reads its own history; a burst past this tail makes it re-read.
const TURNLESS_STEP_TAIL = 1000;
const TURNLESS_STEP_TAIL_BYTES = 4 * 1024 * 1024;
// A turn's step reads skip PTY output: it never belongs to a turn's work rows,
// and a turn with only terminal output in its span finds nothing in one read.
const TURN_STEP_READ_TYPES: readonly SessionEventType[] = SESSION_EVENT_STEP_TYPES.filter(
  (type) => type !== "terminal.pty.output.delta",
);
// Steps of turns nobody is viewing; least recently used turns are dropped
// first and reload when reopened. Opened turns are never evicted.
export const SESSION_STEP_BROWSER_MAX_BYTES = 16 * 1024 * 1024;
const TERMINAL_TURN_TYPES: ReadonlySet<string> = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

type HistoryFilter = "conversation";

type TurnStepStore = {
  /** This turn's loaded steps, ascending, one per event id. */
  events: SessionEvent[];
  bytes: number;
  /** Earlier steps of this turn exist before `events[0]`. */
  hasOlder: boolean;
  /** Exclusive upper bound of the next earlier page (else `events[0]`). */
  cursor: number | null;
  /**
   * The lower bound a read reached without the turn's start in the window.
   * Steps below it were not read: when a later window gives the turn a lower
   * bound (its start, or an earlier other turn), the store has older steps.
   */
  floor: number | null;
  /** The upper bound of a pinned read not yet answered; a retry stays pinned. */
  pinned: number | null;
  loading: boolean;
  error: boolean;
  /** Recency for eviction of turns nobody is viewing. */
  touched: number;
  /** The read this store answers; a newer read or a dropped store retires it. */
  requestId: number;
};

type TurnStepStores = ReadonlyMap<string, TurnStepStore>;

const EMPTY_STEP_STORES: TurnStepStores = new Map();

type TurnlessSteps = {
  /** The newest live turnless steps, ascending. */
  events: SessionEvent[];
  bytes: number;
  /** Inclusive sequence runs of every live turnless step seen, ascending. */
  ranges: ReadonlyArray<readonly [number, number]>;
  /** How many live turnless rows were ever appended. */
  appended: number;
};

const EMPTY_TURNLESS_STEPS: TurnlessSteps = { events: [], bytes: 2, ranges: [], appended: 0 };
// Runs of turnless sequences kept for turn extents; terminal output comes in
// bursts, so a run usually spans many rows.
const TURNLESS_STEP_MAX_RANGES = 4096;

/** Add live turnless steps, keeping a bounded tail for the sandbox terminal. */
function appendTurnlessSteps(
  current: TurnlessSteps,
  incoming: readonly SessionEvent[],
): TurnlessSteps {
  const ranges = current.ranges.map((range): [number, number] => [range[0], range[1]]);
  for (const event of incoming) {
    const sequence = event.sequence;
    const last = ranges.at(-1);
    if (last && sequence >= last[0] && sequence <= last[1]) continue;
    if (last && sequence === last[1] + 1) last[1] = sequence;
    else if (!last || sequence > last[1]) ranges.push([sequence, sequence]);
    else if (!ranges.some(([first, end]) => sequence >= first && sequence <= end)) {
      ranges.push([sequence, sequence]);
      ranges.sort((left, right) => left[0] - right[0]);
    }
  }
  if (ranges.length > TURNLESS_STEP_MAX_RANGES) {
    ranges.splice(0, ranges.length - TURNLESS_STEP_MAX_RANGES);
  }
  const next = appendStepEvents(current, incoming);
  const appended = current.appended + incoming.length;
  if (next.events.length <= TURNLESS_STEP_TAIL && next.bytes <= TURNLESS_STEP_TAIL_BYTES) {
    return { ...next, ranges, appended };
  }
  const kept = boundBrowserSessionEventWindow(next.events, {
    maxCount: TURNLESS_STEP_TAIL,
    maxBytes: TURNLESS_STEP_TAIL_BYTES,
  });
  return { events: kept.events, bytes: kept.bytes, ranges, appended };
}

/**
 * The window with a placeholder over each run of live turnless steps inside
 * its range, so the sequences they fill do not read as a turn's hidden steps.
 * Only for turn extents: placeholders are never shown.
 */
function withTurnlessSteps(
  window: readonly SessionEvent[],
  turnless: TurnlessSteps,
): readonly SessionEvent[] {
  const first = window[0]?.sequence;
  if (first === undefined || turnless.ranges.length === 0) return window;
  const placeholders: SessionEvent[] = [];
  for (const [start, end] of turnless.ranges) {
    // Runs past the window's newest event still fill a live turn's span.
    if (end < first) continue;
    placeholders.push({
      id: `turnless-steps-${start}`,
      workspaceId: window[0]!.workspaceId,
      sessionId: window[0]!.sessionId,
      sequence: start,
      coveredThrough: end,
      type: "terminal.pty.output.delta",
      payload: null,
      occurredAt: window[0]!.occurredAt,
      turnId: null,
    });
  }
  if (placeholders.length === 0) return window;
  return [...window, ...placeholders].sort((left, right) => left.sequence - right.sequence);
}

/** The exclusive lower bound of a turn's step reads in the current window. */
function turnStepLowerBound(bounds: TurnBounds): number {
  return bounds.started !== null ? bounds.started - 1 : bounds.previous;
}

/** Whether earlier steps of a turn remain to read, for the current window. */
function stepStoreHasOlder(store: TurnStepStore, bounds: TurnBounds): boolean {
  return store.hasOlder || (store.floor !== null && turnStepLowerBound(bounds) < store.floor);
}

/**
 * @internal Whether an event belongs in the conversation window. With
 * `startupTurns` (the turns whose model has not responded yet), a turn's
 * bookkeeping is a step except its model request rows up to that response.
 */
export function isConversationHistoryEvent(
  event: SessionEvent,
  presentedCallIds: ReadonlySet<string>,
  startupTurns?: ReadonlySet<string>,
): boolean {
  if (event.turnId) {
    if (event.type === "agent.model.usage") return startupTurns === undefined;
    if (event.type === "agent.model.request") {
      return startupTurns === undefined || startupTurns.has(event.turnId);
    }
  }
  if (!CONTENT_STEP_TYPES.has(event.type)) return true;
  const payload = event.payload as Record<string, unknown> | null;
  // Presented results stay, with or without a turn (the server keeps them too).
  if (event.type === "agent.toolCall.created") return isPresentedSessionToolName(payload?.name);
  if (event.type === "agent.toolCall.output") {
    return typeof payload?.id === "string" && presentedCallIds.has(payload.id);
  }
  // Other steps, including turnless PTY and background command output, which
  // the sandbox terminal reads itself so they never crowd the conversation.
  return false;
}

type StartupTurns = {
  /** The window last read into this state. */
  window: readonly SessionEvent[] | null;
  /** Turns started and still waiting for their model's first response. */
  open: Set<string>;
  responded: Set<string>;
};

function emptyStartupTurns(): StartupTurns {
  return { window: null, open: new Set(), responded: new Set() };
}

function noteStartupTurns(events: readonly SessionEvent[], state: StartupTurns): void {
  for (const event of events) {
    const turnId = event.turnId;
    if (!turnId) continue;
    if (event.type === "turn.started") {
      if (!state.responded.has(turnId)) state.open.add(turnId);
    } else if (
      event.type === "agent.model.request" &&
      isSessionModelResponsePhase((event.payload as Record<string, unknown> | null)?.phase)
    ) {
      state.open.delete(turnId);
      state.responded.add(turnId);
    }
  }
}

/*
 * Conversation reads and server versions. A server announcing
 * SESSION_EVENT_CONVERSATION_FILTER_VERSION applies `presentedToolCalls` and
 * keeps the bookkeeping rows the conversation draws; it is read with every
 * step type excluded. A server that announces nothing may ignore
 * `presentedToolCalls` (and drop presented tool calls with the other steps),
 * so it is read with tool calls included and bookkeeping kept, and the reader
 * drops the calls that are not presented. Each read learns the mode for the
 * next one, so neither the server nor the package has to be released first.
 */
type ConversationFilterMode = "v2" | "compat";
const conversationFilterModes = new WeakMap<object, ConversationFilterMode>();
type ConversationRead = { excludeTypes: SessionEventType[]; presentedToolCalls: "include" };
type ConversationReadOptions = {
  after?: number;
  before?: number;
  limit: number;
  compact: true;
  direction?: "before" | "after";
  payloadMode: "full";
};
const CONVERSATION_READS: Record<ConversationFilterMode, ConversationRead> = {
  v2: { excludeTypes: [...SESSION_EVENT_STEP_TYPES], presentedToolCalls: "include" },
  compat: {
    excludeTypes: [...SESSION_EVENT_COMPAT_EXCLUDED_STEP_TYPES],
    presentedToolCalls: "include",
  },
};

/**
 * @internal How the next conversation read of `client` filters. A client
 * without `listEventPage` cannot see the server's announcement.
 */
export function conversationFilterMode(client: EmbeddedSessionClientLike): ConversationFilterMode {
  if (typeof (client as EmbeddedSessionClientLike & EventPageClient).listEventPage !== "function") {
    return "compat";
  }
  return conversationFilterModes.get(client) ?? "v2";
}

/** One conversation page, read the way the server supports. */
async function readConversationPage(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  options: ConversationReadOptions,
): Promise<PreviousPage> {
  let mode = conversationFilterMode(client);
  for (;;) {
    const read = await readEventPage(client, workspaceId, sessionId, {
      ...CONVERSATION_READS[mode],
      ...options,
    });
    const announced = (read.conversationFilter ?? 0) >= SESSION_EVENT_CONVERSATION_FILTER_VERSION;
    if (read.conversationFilter !== undefined) {
      conversationFilterModes.set(client, announced ? "v2" : "compat");
    }
    // The server may have dropped presented tool calls: read the page again.
    if (mode === "v2" && !announced) {
      mode = "compat";
      continue;
    }
    const events = mode === "compat" ? read.events.filter(isCompatConversationEvent) : read.events;
    return Object.assign(events === read.events ? [...events] : events, {
      requested: options.limit,
      raw: rawPageExtent(read.events),
      hasMore: read.hasMore,
    });
  }
}

/**
 * A compat read's rows minus a turn's steps: tool calls that are not
 * presented, and any excluded step row a server returned anyway.
 */
function isCompatConversationEvent(event: SessionEvent): boolean {
  // Turnless output too: the sandbox terminal reads it itself.
  if (COMPAT_EXCLUDED_TYPES.has(event.type)) return false;
  if (event.type !== "agent.toolCall.created") return true;
  return isPresentedSessionToolName((event.payload as Record<string, unknown> | null)?.name);
}

function notePresentedCalls(events: readonly SessionEvent[], ids: Set<string>): void {
  for (const event of events) {
    if (event.type !== "agent.toolCall.created") continue;
    const payload = event.payload as Record<string, unknown> | null;
    if (typeof payload?.id === "string" && isPresentedSessionToolName(payload.name)) {
      ids.add(payload.id);
    }
  }
}

type TurnBounds = {
  /** The turn's first window event (normally `turn.started`). */
  first: number;
  /** The turn's `turn.started`, when the window holds it. */
  started: number | null;
  /**
   * The last sequence of another turn before this turn's first window event
   * (0 when none). Turnless rows (queue changes, PTY output) do not count:
   * the turn's steps can sit below them.
   */
  previous: number;
  /** The turn's settlement, when the window holds it. */
  terminal: number | null;
  /** Steps hidden between the turn's window events. */
  hidden: boolean;
};

/**
 * Each turn's extent in the conversation window and whether sequences inside
 * it are absent: those are steps (or other unread rows) a reader can load.
 * Compacted events cover `[sequence, coveredThrough]`.
 */
export function conversationTurnBounds(events: readonly SessionEvent[]): Map<string, TurnBounds> {
  const bounds = new Map<string, TurnBounds & { last: number }>();
  const gaps: number[] = []; // first missing sequence of each gap
  let expected: number | null = null;
  let previous = 0;
  for (const event of events) {
    if (expected !== null && event.sequence > expected) gaps.push(expected);
    const resume = eventResumeSequence(event);
    expected = Math.max(expected ?? 0, resume + 1);
    const turnId = event.turnId;
    if (!turnId) continue;
    const current = bounds.get(turnId);
    if (!current) {
      bounds.set(turnId, {
        first: event.sequence,
        started: event.type === "turn.started" ? event.sequence : null,
        previous,
        last: resume,
        terminal: TERMINAL_TURN_TYPES.has(event.type) ? event.sequence : null,
        hidden: false,
      });
    } else {
      current.last = Math.max(current.last, resume);
      if (event.type === "turn.started" && current.started === null) {
        current.started = event.sequence;
      }
      if (TERMINAL_TURN_TYPES.has(event.type)) current.terminal = event.sequence;
    }
    // A queued turn's rows can precede the working turn's later steps.
    if (!PRE_START_TURN_TYPES.has(event.type)) previous = resume;
  }
  for (const turn of bounds.values()) {
    // Any gap that starts after the turn's first event and before its last.
    let low = 0;
    let high = gaps.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (gaps[middle]! <= turn.first) low = middle + 1;
      else high = middle;
    }
    turn.hidden = low < gaps.length && gaps[low]! < turn.last;
  }
  return bounds;
}

/** The newest turn in the window that has started but not settled. */
export function activeConversationTurn(events: readonly SessionEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (!event.turnId) continue;
    if (TERMINAL_TURN_TYPES.has(event.type)) return null;
    if (event.type === "turn.started") return event.turnId;
  }
  return null;
}

function settledTurns(events: readonly SessionEvent[]): Set<string> {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.turnId && TERMINAL_TURN_TYPES.has(event.type)) settled.add(event.turnId);
  }
  return settled;
}

function windowTurns(events: readonly SessionEvent[]): Set<string> {
  const turns = new Set<string>();
  for (const event of events) if (event.turnId) turns.add(event.turnId);
  return turns;
}

const EMPTY_PRESENTED_OUTPUTS: ReadonlyMap<string, SessionEvent> = new Map();
/** Rows a turn writes before it starts, while an earlier turn may still run. */
const PRE_START_TURN_TYPES: ReadonlySet<string> = new Set(["turn.queued", "turn.capacity_waiting"]);
/** A presented result read: its turn, and whether it is still in flight. */
type PresentedRequest = { turnId: string | null; pending: boolean };
// Presented results read per pass; each scans later outputs a page at a time,
// bounded by its turn's settlement, up to a page cap.
const PRESENTED_OUTPUT_READS_PER_PASS = 8;
const PRESENTED_OUTPUT_PAGE_SIZE = 16;
const PRESENTED_OUTPUT_MAX_PAGES = 16;
const PRESENTED_OUTPUT_RETRIES = 3;
const PRESENTED_OUTPUT_RETRY_MS = 2_000;
const RETAINED_VIEW_STEPS: Pick<TurnStepsItem, "load" | "retain"> = {
  load: () => {},
  retain: () => () => {},
};

/**
 * The conversation window with loaded steps and presented results of its
 * turns merged in.
 */
function mergeLoadedEvents(
  conversation: SessionEvent[],
  stores: TurnStepStores,
  presented: ReadonlyMap<string, SessionEvent>,
  turnless: readonly SessionEvent[],
  exactOutputs: ReadonlyMap<string, SessionEvent> = EMPTY_PRESENTED_OUTPUTS,
): SessionEvent[] {
  if (
    stores.size === 0 &&
    presented.size === 0 &&
    turnless.length === 0 &&
    exactOutputs.size === 0
  ) {
    return conversation;
  }
  const turns = windowTurns(conversation);
  const ids = new Set(conversation.map((event) => event.id));
  const extra: SessionEvent[] = [];
  const add = (event: SessionEvent) => {
    if (ids.has(event.id) || !event.turnId || !turns.has(event.turnId)) return;
    ids.add(event.id);
    extra.push(event);
  };
  // Exact outputs first: they replace the previews a step page delivered.
  presented.forEach(add);
  // `add` keeps only events of the window's turns.
  exactOutputs.forEach(add);
  for (const [turnId, store] of stores) if (turns.has(turnId)) store.events.forEach(add);
  for (const event of turnless) {
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    extra.push(event);
  }
  if (extra.length === 0) return conversation;
  return [...conversation, ...extra].sort((left, right) => left.sequence - right.sequence);
}

function groupByTurn(events: readonly SessionEvent[]): Map<string, SessionEvent[]> {
  const turns = new Map<string, SessionEvent[]>();
  for (const event of events) {
    if (!event.turnId) continue;
    const list = turns.get(event.turnId);
    if (list) list.push(event);
    else turns.set(event.turnId, [event]);
  }
  return turns;
}

/** Add steps once each, ascending, counting only the added bytes. */
function appendStepEvents(
  store: Pick<TurnStepStore, "events" | "bytes">,
  incoming: readonly SessionEvent[],
): Pick<TurnStepStore, "events" | "bytes"> {
  if (incoming.length === 0) return { events: store.events, bytes: store.bytes };
  const ids = new Set(store.events.map((event) => event.id));
  let bytes = store.bytes;
  const fresh: SessionEvent[] = [];
  for (const event of incoming) {
    if (ids.has(event.id)) continue;
    ids.add(event.id);
    fresh.push(event);
    bytes += browserJsonBytes(event) + (store.events.length + fresh.length > 1 ? 1 : 0);
  }
  if (fresh.length === 0) return { events: store.events, bytes: store.bytes };
  const last = store.events[store.events.length - 1];
  const events = [...store.events, ...fresh];
  if (last && fresh.some((event) => event.sequence < last.sequence)) {
    events.sort((left, right) => left.sequence - right.sequence);
  } else if (!last) {
    events.sort((left, right) => left.sequence - right.sequence);
  }
  return { events, bytes };
}

/**
 * Whether the window skips a sequence between a turn's first window event and
 * `before`: steps of that turn the browser has not read. A turn the window
 * does not know is assumed to have some.
 */
function turnHasHiddenSequences(
  events: readonly SessionEvent[],
  turnId: string,
  before: number,
): boolean {
  const start = events.findIndex((event) => event.turnId === turnId);
  if (start < 0) return true;
  let expected = eventResumeSequence(events[start]!) + 1;
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence >= before) break;
    if (event.sequence > expected) return true;
    expected = Math.max(expected, eventResumeSequence(event) + 1);
  }
  return expected < before;
}

/** Keep the newest steps of a collapsed live turn. */
function trimLiveStepTail(store: TurnStepStore): TurnStepStore {
  if (
    store.events.length <= SESSION_TURN_LIVE_STEP_TAIL &&
    store.bytes <= SESSION_TURN_LIVE_STEP_TAIL_BYTES
  ) {
    return store;
  }
  const kept = boundBrowserSessionEventWindow(store.events, {
    maxCount: SESSION_TURN_LIVE_STEP_TAIL,
    maxBytes: SESSION_TURN_LIVE_STEP_TAIL_BYTES,
  });
  return { ...store, events: kept.events, bytes: kept.bytes, hasOlder: true, cursor: null };
}

/** Drop the least recently used steps of turns nobody is viewing. */
function boundStepStores(
  stores: Map<string, TurnStepStore>,
  retained: ReadonlyMap<string, number>,
): Map<string, TurnStepStore> {
  let total = 0;
  for (const [turnId, store] of stores) {
    if (!retained.get(turnId)) total += store.bytes;
  }
  if (total <= SESSION_STEP_BROWSER_MAX_BYTES) return stores;
  const candidates = [...stores]
    .filter(([turnId, store]) => !retained.get(turnId) && !store.loading)
    .sort((left, right) => left[1].touched - right[1].touched);
  for (const [turnId, store] of candidates) {
    if (total <= SESSION_STEP_BROWSER_MAX_BYTES) break;
    stores.delete(turnId);
    total -= store.bytes;
  }
  return stores;
}

/**
 * A presented call's result: later outputs, a page at a time, up to the
 * call's turn settlement (parallel calls can put many outputs before it).
 */
async function findPresentedOutput(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  callId: string,
  after: number,
  terminal: number | null,
): Promise<SessionEvent | null> {
  let cursor = after;
  for (let page = 0; page < PRESENTED_OUTPUT_MAX_PAGES; page += 1) {
    const read = await readEventPage(client, workspaceId, sessionId, {
      includeTypes: ["agent.toolCall.output"],
      after: cursor,
      ...(terminal !== null ? { before: terminal + 1 } : {}),
      direction: "after",
      limit: PRESENTED_OUTPUT_PAGE_SIZE,
      payloadMode: "full",
    });
    const output = read.events.find(
      (event) => (event.payload as Record<string, unknown> | null)?.id === callId,
    );
    if (output) return output;
    const last = read.events.at(-1);
    if (!last || !(read.hasMore ?? read.events.length >= PRESENTED_OUTPUT_PAGE_SIZE)) return null;
    cursor = last.sequence;
  }
  return null;
}

type StepPage = {
  events: SessionEvent[];
  hasMore: boolean | null;
  /** The server's conversation-filter announcement; undefined when unseen. */
  conversationFilter?: number | null;
};

type EventPageClient = {
  listEventPage?: (
    workspaceId: string,
    sessionId: string,
    options: SessionEventListOptions,
  ) => Promise<SessionEventPage>;
};

/**
 * One bounded page. Uses the SDK's page read when the client has it, which
 * reports whether more rows remain; a compact page's length cannot.
 */
async function readEventPage(
  client: EmbeddedSessionClientLike,
  workspaceId: string,
  sessionId: string,
  options: SessionEventListOptions,
): Promise<StepPage> {
  const pageClient = client as EmbeddedSessionClientLike & EventPageClient;
  if (typeof pageClient.listEventPage === "function") {
    const page = await pageClient.listEventPage(workspaceId, sessionId, options);
    return {
      events: page.events,
      hasMore: page.hasMore,
      // An SDK that predates the announcement reports nothing: treat it as none.
      conversationFilter: page.conversationFilter ?? null,
    };
  }
  return { events: await client.listEvents(workspaceId, sessionId, options), hasMore: null };
}
