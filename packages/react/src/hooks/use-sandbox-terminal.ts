import type {
  SandboxCommandOutputDeltaPayload,
  SessionEvent,
  TerminalPtyExitedPayload,
  TerminalPtyOutputDeltaPayload,
} from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

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
  const [openedPtyId, setOpenedPtyId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<Error | null>(null);
  // Bumped to force a fresh PTY open after a write reveals the old PTY was lost
  // (a 409 "pty session lost" — the box rolled over since the open). This makes
  // the interactive terminal self-heal instead of dead-ending on a stale session.
  const [reopenNonce, setReopenNonce] = useState(0);

  // Open ONE interactive PTY against the box, close it on unmount/identity
  // change. The open's banner + subsequent output deltas ride A1, so xterm fills
  // from `events` — we don't thread the open's body output here (the SSE
  // projection is the single source of truth for what's written). The open is
  // gated on a WARM box: opening on a cold/warming lease races the box (the PTY
  // exec-session is created on a box that the next op may not resume), which is
  // exactly the "session not found" terminal failure; we wait for warm/draining.
  const openInFlight = useRef(false);
  const boxWarm = liveness === undefined || liveness === "warm" || liveness === "draining";
  useEffect(() => {
    if (!interactive || !sessionId || ptyFilter || !boxWarm) return;
    let cancelled = false;
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

  const { chunks, openPty, supportsInput } = useMemo(() => {
    const out: TerminalChunk[] = [];
    // Track PTY lifecycle so `running`/`write` reflect the latest state.
    const open = new Map<string, { supportsInput: boolean }>();
    let lastOpened: string | null = null;
    let lastSupportsInput = false;

    for (const event of options.events) {
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
      if (event.type === "terminal.pty.output.delta") {
        const payload = event.payload as TerminalPtyOutputDeltaPayload | null;
        if (!payload || (ptyFilter && payload.ptyId !== ptyFilter)) continue;
        out.push({
          id: event.id,
          text: payload.chunk,
          stream: payload.stream === "stderr" ? "stderr" : "stdout",
          seq: event.sequence,
        });
        continue;
      }
      if (includeAgentFirehose && !ptyFilter && event.type === "sandbox.command.output.delta") {
        const payload = event.payload as SandboxCommandOutputDeltaPayload | null;
        if (!payload?.chunk) continue;
        out.push({
          id: event.id,
          text: payload.chunk,
          stream: payload.stream === "stderr" ? "stderr" : "stdout",
          seq: event.sequence,
        });
      }
    }

    // Stable order: by sequence (the SSE spine guarantees per-session ordering).
    out.sort((a, b) => a.seq - b.seq);
    const activePty = ptyFilter && open.has(ptyFilter) ? ptyFilter : lastOpened;
    lastSupportsInput = activePty ? (open.get(activePty)?.supportsInput ?? false) : false;
    return { chunks: out, openPty: activePty, supportsInput: lastSupportsInput };
  }, [options.events, ptyFilter, includeAgentFirehose]);

  // The PTY this hook actively drives: the one it opened (interactive) wins so
  // `write` is live the instant the open resolves — even before the
  // `terminal.pty.started` event arrives through SSE. Fall back to whatever the
  // event projection found (a PTY opened elsewhere, or a caller-pinned ptyId).
  const activePtyId = openedPtyId ?? openPty;
  // An interactively-opened PTY accepts stdin by construction (we only open it on
  // a pty-capable backend); a projected PTY uses its advertised supportsInput.
  const canWrite = openedPtyId !== null || supportsInput;

  const write = useMemo(() => {
    if (!activePtyId || !canWrite || !sessionId) return null;
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
            activePtyId === openedPtyId
          ) {
            setOpenedPtyId(null);
            setReopenNonce((n) => n + 1);
          }
        });
    };
  }, [client, workspaceId, sessionId, activePtyId, canWrite, openedPtyId]);

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
    error: openError,
  };
}
