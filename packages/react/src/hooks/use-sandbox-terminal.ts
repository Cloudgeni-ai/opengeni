import type {
  SandboxCommandOutputDeltaPayload,
  SessionEvent,
  SessionEventPage,
  SessionEventType,
  TerminalPtyExitedPayload,
  TerminalPtyOutputDeltaPayload,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionClientLike } from "../client";
import { useOpenGeni, type ClientOverride } from "../provider";
import { sandboxAcceptsLiveIo } from "../lib/sandbox-liveness";
import { useTurnlessOutputGap } from "./turnless-output-gaps";

/**
 * Newest terminal output rows read when the terminal opens: one page, which
 * the server also bounds to 1 MB. xterm keeps 1,000 lines of scrollback, so
 * older pages would scroll straight out of it.
 */
export const SANDBOX_TERMINAL_HISTORY_ROWS = 1000;
/** Output rows the terminal keeps (history and live) for a rewrite. */
export const SANDBOX_TERMINAL_MAX_ROWS = 4000;

export type TerminalChunk = {
  /** Stable key (the source event id) so the xterm writer tracks a written-cursor. */
  id: string;
  /** Raw output bytes (utf-8 lossy) — written verbatim into xterm. */
  text: string;
  /** stdout vs stderr (drives optional tinting). */
  stream: "stdout" | "stderr";
  /** Global ordering: the source event sequence. */
  seq: number;
};

export type UseSandboxTerminalOptions = ClientOverride & {
  /** The live session event log (usually `useSessionEvents().events`). */
  events: SessionEvent[];
  /** Restrict to one PTY (by ptyId). Omit to interleave the agent firehose +
   *  every PTY. */
  ptyId?: string | undefined;
  /** Include the agent's command-output firehose (sandbox.command.output.delta).
   *  Default true — the read-only "terminal-as-events" the data path settled on. */
  includeAgentFirehose?: boolean | undefined;
  /**
   * OPEN an interactive PTY against the box so the user can type, not just watch.
   * When true (and the session is live) the hook calls `terminalPtyOpen` once,
   * tracks the returned ptyId, exposes `write` immediately (bound to that ptyId),
   * and closes the PTY on unmount. The PTY's banner + every output delta ride the
   * SSE spine (`terminal.pty.*`) back into `events`, so xterm fills in. Default
   * false — a caller that only wants the read-only firehose stays projection-only.
   */
  interactive?: boolean | undefined;
  /** Lease liveness ("cold" | "warm" | "draining"). The interactive PTY is only
   *  opened once the box is warm — opening on a cold box (ptyCapable is advertised
   *  cold too) races the box and leaves a dead read-only terminal. */
  liveness?: string | undefined;
  /**
   * Read this session's terminal history when true: the newest
   * {@link SANDBOX_TERMINAL_HISTORY_ROWS} PTY output rows (and agent command
   * output rows with `includeAgentFirehose`). Conversation reads carry none of
   * these rows, so this read restores the scrollback after a reload. Default
   * true; the dock enables it when its Terminal opens.
   */
  history?: boolean | undefined;
};

export type UseSandboxTerminalResult = {
  /** Ordered, deduped output chunks to write() into xterm.js. */
  chunks: TerminalChunk[];
  /** Whether a PTY is currently open (drives the prompt/cursor affordance). */
  running: boolean;
  /**
   * Interactive write fn when a PTY is open and the backend supports stdin
   * (`terminal.transport === "pty-ws"` / `PtyOpenResponse.supportsInput`). Null
   * in the read-only event-projection case (v1 default).
   */
  write: ((data: string) => void) | null;
  /** The active PTY id, if one is open. */
  activePtyId: string | null;
  /** Close the active PTY (no-op when none is open). */
  close: () => void;
  /** A PTY-open failure (interactive mode), if any. */
  error: Error | null;
};

/**
 * Project the Channel-A event log into an xterm-writable byte stream. The
 * terminal is "terminal-as-events": there is NO new socket in v1 — the agent's
 * command output (`sandbox.command.output.delta`) and any interactive PTY
 * (`terminal.pty.output.delta`) ride the existing SSE spine. When a PTY is open
 * and the backend accepts stdin, `write` pipes keystrokes via the SDK
 * `terminalPtyWrite` (the synchronous Channel-A control path).
 */
export function useSandboxTerminal(
  sessionId: string | null | undefined,
  options: UseSandboxTerminalOptions,
): UseSandboxTerminalResult {
  const { client, workspaceId } = useOpenGeni(options);
  const includeAgentFirehose = options.includeAgentFirehose ?? true;
  const interactive = options.interactive ?? false;
  // When the caller controls a fixed ptyId we project that one; otherwise (the
  // interactive default) the hook opens its OWN PTY and tracks it here so `write`
  // is live before the `terminal.pty.started` event round-trips through SSE.
  const ptyFilter = options.ptyId;
  const liveness = options.liveness;
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${interactive}\u0000${ptyFilter ?? ""}`;
  const [openedPtyId, setOpenedPtyId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<Error | null>(null);
  const [stateIdentity, setStateIdentity] = useState(identityKey);
  // Bumped to force a fresh PTY open after a write reveals the old PTY was lost
  // (a 409 "pty session lost" — the box rolled over since the open). This makes
  // the interactive terminal self-heal instead of dead-ending on a stale session.
  const [reopenNonce, setReopenNonce] = useState(0);
  const currentIdentityRef = useRef(identityKey);
  currentIdentityRef.current = identityKey;

  // Async PTY state belongs to one workspace/session/mode identity. Hide it
  // synchronously on the switching render, then clear it durably in the effect.
  useEffect(() => {
    setStateIdentity(identityKey);
    setOpenedPtyId(null);
    setOpenError(null);
  }, [identityKey]);

  // Open ONE interactive PTY against the box, close it on unmount/identity
  // change. The open's banner + subsequent output deltas ride A1, so xterm fills
  // from `events` — we don't thread the open's body output here (the SSE
  // projection is the single source of truth for what's written). The open is
  // gated on a WARM box: opening on a cold/warming lease races the box (the PTY
  // exec-session is created on a box that the next op may not resume), which is
  // exactly the "session not found" terminal failure; we wait for warm.
  const openInFlight = useRef(false);
  const boxWarm = liveness === undefined || sandboxAcceptsLiveIo(liveness);
  useEffect(() => {
    if (!interactive || !sessionId || ptyFilter || !boxWarm) {
      setOpenError(null);
      return;
    }
    let cancelled = false;
    setOpenError(null);
    openInFlight.current = true;
    let openedId: string | null = null;
    void client
      .terminalPtyOpen(workspaceId, sessionId, {})
      .then((res) => {
        if (cancelled) {
          // Raced past unmount — close the orphan we just opened.
          void client
            .terminalPtyClose(workspaceId, sessionId, { ptyId: res.ptyId })
            .catch(() => {});
          return;
        }
        openedId = res.ptyId;
        setOpenedPtyId(res.ptyId);
      })
      .catch((cause) => {
        if (!cancelled) setOpenError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        openInFlight.current = false;
      });
    return () => {
      cancelled = true;
      setOpenedPtyId(null);
      const id = openedId;
      if (id) void client.terminalPtyClose(workspaceId, sessionId, { ptyId: id }).catch(() => {});
    };
  }, [interactive, client, workspaceId, sessionId, ptyFilter, boxWarm, reopenNonce]);

  // Terminal history: conversation reads carry no PTY output and only the
  // turns a reader opened carry command output, so the terminal reads its own
  // newest page once it is enabled (the dock enables it when its Terminal
  // opens). Live rows keep arriving through `events`; when the live stream may
  // have skipped some (it rejoined at the head, or a burst overflowed its
  // tail), the session's gap generation moves and the newest page is read
  // again. A failed read retries with backoff while the terminal is enabled.
  const outputTypes = useMemo<SessionEventType[]>(
    () =>
      includeAgentFirehose && !ptyFilter
        ? ["terminal.pty.output.delta", "sandbox.command.output.delta"]
        : ["terminal.pty.output.delta"],
    [includeAgentFirehose, ptyFilter],
  );
  const historyKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${outputTypes.join(",")}`;
  const historyEnabled = (options.history ?? true) && Boolean(sessionId);
  const gapGeneration = useTurnlessOutputGap(workspaceId, sessionId);
  const [history, setHistory] = useState<TerminalHistory | null>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const readRef = useRef<HistoryReadState>(historyReadState(historyKey));
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const state = readRef.current;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    };
  }, []);
  useEffect(() => {
    let state = readRef.current;
    // Another session (or set of types) forgets this one's page, so coming
    // back reads what was written meanwhile.
    if (state.key !== historyKey) {
      if (state.timer) clearTimeout(state.timer);
      state = historyReadState(historyKey);
      readRef.current = state;
      setHistory(null);
    }
    if (!historyEnabled || !sessionId || state.inFlight || state.timer) return;
    if (!state.failed && state.generation === gapGeneration) return;
    const now = Date.now();
    const wait = state.failed
      ? terminalHistoryRetryDelay(state.failures) - (now - state.startedAt)
      : state.generation === null
        ? 0
        : SANDBOX_TERMINAL_REREAD_MIN_MS - (now - state.startedAt);
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = null;
        if (mountedRef.current) setHistoryTick((tick) => tick + 1);
      }, wait);
      return;
    }
    const generation = gapGeneration;
    state.inFlight = true;
    state.startedAt = now;
    const current = () => mountedRef.current && readRef.current === state;
    void readTerminalHistory(client, workspaceId, sessionId, outputTypes).then(
      (page) => {
        state.inFlight = false;
        if (!current()) return;
        state.failed = false;
        state.failures = 0;
        state.generation = generation;
        setHistory({ key: state.key, events: page.events, complete: page.complete });
        // A gap marked during the read is read again.
        setHistoryTick((tick) => tick + 1);
      },
      (cause: unknown) => {
        state.inFlight = false;
        if (!current()) return;
        // A refusal (another 4xx than a timeout or rate limit) will not
        // change by retrying: wait for the next gap or session instead.
        if (
          cause instanceof OpenGeniApiError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          cause.status !== 408 &&
          cause.status !== 429
        ) {
          state.failed = false;
          state.failures = 0;
          state.generation = generation;
          return;
        }
        state.failed = true;
        state.failures += 1;
        setHistoryTick((tick) => tick + 1);
      },
    );
  }, [
    historyEnabled,
    historyKey,
    gapGeneration,
    historyTick,
    outputTypes,
    client,
    workspaceId,
    sessionId,
  ]);

  // Live output rows seen in `events`, kept after they leave it (a host's
  // event window keeps only a short tail of them).
  const liveRef = useRef<LiveTerminalRows>({ key: historyKey, rows: new Map(), below: 0 });

  const { chunks, openPty, supportsInput } = useMemo(() => {
    // Track PTY lifecycle so `running`/`write` reflect the latest state.
    const open = new Map<string, { supportsInput: boolean }>();
    let lastOpened: string | null = null;
    let lastSupportsInput = false;
    if (liveRef.current.key !== historyKey) {
      liveRef.current = { key: historyKey, rows: new Map(), below: 0 };
    }
    const liveRows = liveRef.current;
    const live = liveRows.rows;
    const types = new Set<string>(outputTypes);

    for (const event of options.events) {
      // The hook is session-scoped even if a host accidentally retains the old
      // event array for one render during navigation.
      if (event.workspaceId !== workspaceId || event.sessionId !== sessionId) continue;
      if (event.type === "terminal.pty.started") {
        const payload = event.payload as { ptyId?: string } | null;
        if (payload?.ptyId) {
          open.set(payload.ptyId, { supportsInput: true });
          lastOpened = payload.ptyId;
        }
        continue;
      }
      if (event.type === "terminal.pty.exited") {
        const payload = event.payload as TerminalPtyExitedPayload | null;
        if (payload?.ptyId) {
          open.delete(payload.ptyId);
          if (lastOpened === payload.ptyId) lastOpened = null;
        }
        continue;
      }
      // Rows below the trimmed floor stay out (an opened turn's older steps).
      if (types.has(event.type) && event.sequence >= liveRows.below && !live.has(event.id)) {
        live.set(event.id, event);
      }
    }
    trimLiveRows(liveRows);

    const loaded = history?.key === historyKey ? history : null;
    // Rows older than an incomplete history page are outside what the
    // terminal shows (for example the steps of an old turn a reader opened).
    const floor = loaded && !loaded.complete ? (loaded.events[0]?.sequence ?? 0) : 0;
    const seen = new Set<string>();
    const out: TerminalChunk[] = [];
    const add = (event: SessionEvent) => {
      if (seen.has(event.id) || event.sequence < floor) return;
      seen.add(event.id);
      const chunk = terminalChunk(event, ptyFilter);
      if (chunk) out.push(chunk);
    };
    loaded?.events.forEach(add);
    live.forEach(add);

    // Stable order: by sequence (the SSE spine guarantees per-session ordering).
    out.sort((a, b) => a.seq - b.seq);
    const activePty = ptyFilter && open.has(ptyFilter) ? ptyFilter : lastOpened;
    lastSupportsInput = activePty ? (open.get(activePty)?.supportsInput ?? false) : false;
    return {
      chunks: out.length > SANDBOX_TERMINAL_MAX_ROWS ? out.slice(-SANDBOX_TERMINAL_MAX_ROWS) : out,
      openPty: activePty,
      supportsInput: lastSupportsInput,
    };
  }, [options.events, history, historyKey, outputTypes, ptyFilter, workspaceId, sessionId]);

  // The PTY this hook actively drives: the one it opened (interactive) wins so
  // `write` is live the instant the open resolves — even before the
  // `terminal.pty.started` event arrives through SSE. Fall back to whatever the
  // event projection found (a PTY opened elsewhere, or a caller-pinned ptyId).
  const identityMatches = stateIdentity === identityKey;
  const activePtyId = identityMatches ? (openedPtyId ?? openPty) : null;
  // An interactively-opened PTY accepts stdin by construction (we only open it on
  // a pty-capable backend); a projected PTY uses its advertised supportsInput.
  const canWrite = openedPtyId !== null || supportsInput;

  const write = useMemo(() => {
    if (!activePtyId || !canWrite || !sessionId) return null;
    const writeIdentity = identityKey;
    return (data: string) => {
      void client
        .terminalPtyWrite(workspaceId, sessionId, { ptyId: activePtyId, data })
        .catch((cause) => {
          // The PTY exec-session was lost on the live box (409/404 — the box rolled
          // over since the open). Self-heal: drop the stale id and re-open a fresh
          // PTY against the current box rather than silently swallowing keystrokes.
          if (
            cause instanceof OpenGeniApiError &&
            (cause.status === 409 || cause.status === 404) &&
            activePtyId === openedPtyId &&
            currentIdentityRef.current === writeIdentity
          ) {
            setOpenedPtyId(null);
            setReopenNonce((n) => n + 1);
          }
        });
    };
  }, [client, workspaceId, sessionId, activePtyId, canWrite, openedPtyId, identityKey]);

  const close = useCallback(() => {
    if (!activePtyId || !sessionId) return;
    void client.terminalPtyClose(workspaceId, sessionId, { ptyId: activePtyId }).catch(() => {});
  }, [client, workspaceId, sessionId, activePtyId]);

  return {
    chunks,
    running: activePtyId !== null,
    write,
    activePtyId,
    close,
    error: identityMatches ? openError : null,
  };
}

/** The terminal's history page for one session and set of output types. */
type TerminalHistory = {
  key: string;
  /** Ascending. */
  events: SessionEvent[];
  /** No older output rows exist. */
  complete: boolean;
};

type LiveTerminalRows = {
  key: string;
  rows: Map<string, SessionEvent>;
  /** Rows below this sequence were trimmed and are not taken again. */
  below: number;
};

/**
 * Keep the newest {@link SANDBOX_TERMINAL_MAX_ROWS} live rows, trimming in
 * batches so a long-running terminal sorts rarely.
 */
function trimLiveRows(live: LiveTerminalRows): void {
  const { rows } = live;
  if (rows.size <= SANDBOX_TERMINAL_MAX_ROWS + SANDBOX_TERMINAL_MAX_ROWS / 4) return;
  const sorted = [...rows.values()].sort((left, right) => left.sequence - right.sequence);
  const drop = sorted.length - SANDBOX_TERMINAL_MAX_ROWS;
  for (const event of sorted.slice(0, drop)) rows.delete(event.id);
  live.below = Math.max(live.below, sorted[drop]!.sequence);
}

/** Where the terminal's history read stands for one session and set of types. */
type HistoryReadState = {
  key: string;
  /** The gap generation the last successful read started at. */
  generation: number | null;
  inFlight: boolean;
  failed: boolean;
  failures: number;
  /** When the latest read started (ms). */
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

function historyReadState(key: string): HistoryReadState {
  return {
    key,
    generation: null,
    inFlight: false,
    failed: false,
    failures: 0,
    startedAt: 0,
    timer: null,
  };
}

/** Re-reads after live gaps start at most this often. */
const SANDBOX_TERMINAL_REREAD_MIN_MS = 1000;

/** Backoff after failed history reads: 1 s, doubling, at most 30 s. */
function terminalHistoryRetryDelay(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

function terminalChunk(event: SessionEvent, ptyFilter: string | undefined): TerminalChunk | null {
  if (event.type === "terminal.pty.output.delta") {
    const payload = event.payload as TerminalPtyOutputDeltaPayload | null;
    if (!payload || typeof payload.chunk !== "string") return null;
    if (ptyFilter && payload.ptyId !== ptyFilter) return null;
    return {
      id: event.id,
      text: payload.chunk,
      stream: payload.stream === "stderr" ? "stderr" : "stdout",
      seq: event.sequence,
    };
  }
  if (event.type === "sandbox.command.output.delta" && !ptyFilter) {
    const payload = event.payload as SandboxCommandOutputDeltaPayload | null;
    if (!payload?.chunk) return null;
    return {
      id: event.id,
      text: payload.chunk,
      stream: payload.stream === "stderr" ? "stderr" : "stdout",
      seq: event.sequence,
    };
  }
  return null;
}

type EventPageClient = {
  listEventPage?: (
    workspaceId: string,
    sessionId: string,
    options: Parameters<SessionClientLike["listEvents"]>[2],
  ) => Promise<SessionEventPage>;
};

/**
 * The newest page of terminal output rows, ascending. Uses the SDK's page read
 * when the client has it (it says whether older rows remain).
 */
async function readTerminalHistory(
  client: SessionClientLike,
  workspaceId: string,
  sessionId: string,
  includeTypes: SessionEventType[],
): Promise<{ events: SessionEvent[]; complete: boolean }> {
  const options = {
    includeTypes,
    direction: "before" as const,
    // Explicit: a cursorless read otherwise defaults to the monitoring tail,
    // which drops raw output deltas.
    mode: "forensic" as const,
    payloadMode: "full" as const,
    limit: SANDBOX_TERMINAL_HISTORY_ROWS,
  };
  const pageClient = client as SessionClientLike & EventPageClient;
  const page =
    typeof pageClient.listEventPage === "function"
      ? await pageClient.listEventPage(workspaceId, sessionId, options)
      : null;
  const events = page ? page.events : await client.listEvents(workspaceId, sessionId, options);
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  return {
    events: sorted,
    // Without a continuation fact, only an empty read is known complete: the
    // server's byte bound can cut a page short of the row limit.
    complete: page ? !page.hasMore : sorted.length === 0,
  };
}
