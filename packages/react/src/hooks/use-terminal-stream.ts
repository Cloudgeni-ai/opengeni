import {
  TTYD_SUBPROTOCOL,
  TerminalCapability,
  terminalSocketUrl,
  ttydAuthFrame,
  ttydInputFrame,
  ttydResizeFrame,
  TtydServerCommand,
} from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState } from "react";

/** The ttyd connection lifecycle as surfaced to the component. */
export type TerminalStreamStatus = "connecting" | "open" | "closed" | "error";

export type UseTerminalStreamOptions = {
  /** The Terminal cell of the negotiated capabilities (`capabilities.Terminal`).
   *  The stream connects ONLY when `transport === "pty-ws"` and `url` is set; on a
   *  cold box (`transport === "sse-events"` / no url) it stays idle and the caller
   *  falls back to the Channel-A read-only firehose. */
  capability: Pick<TerminalCapability, "transport" | "url" | "token" | "expiresAt"> | null;
  /** Called for each OUTPUT payload from ttyd (write verbatim into xterm). */
  onOutput?: ((data: string) => void) | undefined;
  /** Called when ttyd sends a SET_WINDOW_TITLE frame. */
  onTitle?: ((title: string) => void) | undefined;
  /** Initial PTY size to seed the ttyd auth frame + first resize. */
  initialCols?: number | undefined;
  initialRows?: number | undefined;
};

export type UseTerminalStreamResult = {
  /** True once the ttyd socket is open (and the auth frame has been sent). */
  connected: boolean;
  status: TerminalStreamStatus;
  /** Pipe a keystroke/paste to PTY stdin. Input during CONNECTING is bounded and
   *  replayed only after ttyd authentication succeeds. */
  write: (data: string) => void;
  /** Tell ttyd the PTY window changed size (on xterm fit/resize). */
  resize: (cols: number, rows: number) => void;
  /** Tear the socket down (the effect also tears down on unmount / url change). */
  disconnect: () => void;
};

// Keystrokes entered during the websocket handshake are held until ttyd has
// accepted its auth/resize frames. Bound the queue by UTF-16 code units (a hard
// <=128 KiB string payload in current JS engines) so a paste cannot turn a slow
// handshake into unbounded renderer memory. Overflow rejects the whole pending
// input rather than ever executing a truncated shell command.
export const MAX_PENDING_TERMINAL_INPUT_CODE_UNITS = 64 * 1024;
const TERMINAL_CONNECT_EXPIRY_SKEW_MS = 5_000;

/** A bearer must remain valid long enough to finish a new websocket handshake.
 * Existing open sockets are unaffected: this is evaluated only when the
 * credential identity changes and the connection effect attempts a new socket. */
export function terminalStreamCredentialUsable(
  capability: Pick<TerminalCapability, "transport" | "url" | "expiresAt"> | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (capability?.transport !== "pty-ws" || !capability.url) return false;
  if (!capability.expiresAt) return true;
  const expiresAt = Date.parse(capability.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs + TERMINAL_CONNECT_EXPIRY_SKEW_MS;
}

/** Decode an inbound ttyd frame's payload (everything after the 1-char command).
 *  ttyd may send either a text frame (string) or a binary frame (ArrayBuffer);
 *  for binary we slice off the first byte (the command) and utf-8 decode the rest. */
function decodeFrame(data: string | ArrayBuffer): { command: string; payload: string } {
  if (typeof data === "string") {
    return { command: data.charAt(0), payload: data.slice(1) };
  }
  const bytes = new Uint8Array(data);
  const command = bytes.length > 0 ? String.fromCharCode(bytes[0]!) : "";
  const payload = bytes.length > 1 ? new TextDecoder().decode(bytes.subarray(1)) : "";
  return { command, payload };
}

function closeSocket(socket: WebSocket | null): void {
  try {
    socket?.close();
  } catch {
    // Already closed or rejected by the host WebSocket implementation.
  }
}

/**
 * Drive a ttyd PTY-over-websocket connection from a `pty-ws` Terminal capability,
 * symmetric with `use-desktop-stream` (the noVNC-over-tunnel hook). The scoped
 * stream token is already embedded in the minted tunnel `url`; the WebSocket is
 * opened with the REQUIRED ttyd subprotocol "tty".
 *
 * ttyd wire protocol (see `@opengeni/sdk/terminal`):
 *   - first frame: `JSON.stringify({ AuthToken: "" })` (+ optional columns/rows).
 *   - client→server: INPUT = "0"+data ; RESIZE = "1"+JSON({columns,rows}).
 *   - server→client: "0" = OUTPUT (→ xterm) ; "1" = SET_WINDOW_TITLE ;
 *     "2" = SET_PREFERENCES (ignored). Binary frames are decoded the same way.
 *
 * On a `url`/`token` rotation (a box rollover folds a fresh address into the cell)
 * the effect re-runs: the old socket closes and a fresh one connects — a brief
 * terminal blink, acceptable on rollover (mirrors the desktop's RFB hot-swap).
 * SSR-safe: the socket open lives in `useEffect`, so a server render is a no-op.
 */
export function useTerminalStream(options: UseTerminalStreamOptions): UseTerminalStreamResult {
  const { capability, onOutput, onTitle, initialCols, initialRows } = options;
  const [status, setStatus] = useState<TerminalStreamStatus>("closed");
  const wsRef = useRef<WebSocket | null>(null);
  const pendingInputRef = useRef("");
  const socketFailedRef = useRef(false);
  const socketAuthenticatedRef = useRef(false);
  // Latest size, so a resize() before the socket opens is replayed on open, and a
  // reconnect seeds the right geometry.
  const sizeRef = useRef<{ cols: number; rows: number }>({
    cols: initialCols ?? 80,
    rows: initialRows ?? 24,
  });
  // Keep the callbacks current without re-running the connect effect on every
  // render (the parent passes fresh closures each time).
  const onOutputRef = useRef(onOutput);
  const onTitleRef = useRef(onTitle);
  onOutputRef.current = onOutput;
  onTitleRef.current = onTitle;

  const transport = capability?.transport ?? null;
  const url = capability?.url ?? null;
  const token = capability?.token ?? null;
  const expiresAt = capability?.expiresAt ?? null;

  useEffect(() => {
    // SSR / no WebSocket / not a live pty-ws cell: stay closed; the caller falls
    // back to the Channel-A read-only firehose.
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
    if (transport !== "pty-ws") {
      // A transport downgrade is a real semantic boundary. Do not replay input
      // captured for a PTY if this surface later changes back from firehose mode.
      pendingInputRef.current = "";
      socketAuthenticatedRef.current = false;
      setStatus("closed");
      return;
    }
    // A changed/cleared credential is a new connection attempt boundary. It may
    // receive input while its exact grant is pending even if the prior socket
    // failed; the unchanged failed identity remains fenced because this effect
    // does not re-run for a status-only render.
    socketFailedRef.current = false;
    socketAuthenticatedRef.current = false;
    if (!url) {
      // Exact grants arrive asynchronously. Preserve the bounded first input
      // while the descriptor remains pty-ws, but never open without a credential.
      setStatus("closed");
      return;
    }
    if (!terminalStreamCredentialUsable({ transport, url, expiresAt })) {
      // A descriptor from an older rolling server may still carry a bearer that
      // aged out before this surface mounted. Wait for the exact fresh grant.
      setStatus("closed");
      return;
    }

    let disposed = false;
    let socket: WebSocket;
    setStatus("connecting");
    try {
      // The ttyd "tty" subprotocol is REQUIRED — ttyd rejects a handshake without
      // it. The scoped token is already in the tunnel `url`.
      socket = new WebSocket(terminalSocketUrl({ url }), TTYD_SUBPROTOCOL);
    } catch {
      socketFailedRef.current = true;
      setStatus("error");
      return;
    }
    socket.binaryType = "arraybuffer";
    wsRef.current = socket;

    socket.onopen = () => {
      if (disposed) return;
      // ttyd's required first frame: the auth message (empty token — the gate is
      // the tunnel url + scoped stream token, not a ttyd -c credential), seeded
      // with the current PTY geometry. Then an explicit resize to be safe.
      try {
        socket.send(ttydAuthFrame({ columns: sizeRef.current.cols, rows: sizeRef.current.rows }));
        socket.send(ttydResizeFrame(sizeRef.current.cols, sizeRef.current.rows));
        if (pendingInputRef.current.length > 0) {
          // One websocket frame makes the pre-open queue all-or-nothing from this
          // client's perspective; never execute a prefix of a buffered command.
          socket.send(ttydInputFrame(pendingInputRef.current));
          pendingInputRef.current = "";
        }
        socketAuthenticatedRef.current = true;
      } catch {
        socketFailedRef.current = true;
        setStatus("error");
        closeSocket(socket);
        return;
      }
      setStatus("open");
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (disposed) return;
      const { command, payload } = decodeFrame(ev.data as string | ArrayBuffer);
      switch (command) {
        case TtydServerCommand.OUTPUT:
          onOutputRef.current?.(payload);
          break;
        case TtydServerCommand.SET_WINDOW_TITLE:
          onTitleRef.current?.(payload);
          break;
        // SET_PREFERENCES ("2") and anything else: ignored.
        default:
          break;
      }
    };

    socket.onerror = () => {
      if (!disposed) {
        socketFailedRef.current = true;
        setStatus("error");
      }
    };
    socket.onclose = () => {
      if (wsRef.current === socket) wsRef.current = null;
      socketAuthenticatedRef.current = false;
      if (!disposed) setStatus(socketFailedRef.current ? "error" : "closed");
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      socketAuthenticatedRef.current = false;
      // Drop handlers so an in-flight close/error doesn't mutate state post-unmount.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      closeSocket(socket);
    };
    // A url/token change (rotation) re-runs this effect → close old, open new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, url, token, expiresAt]);

  return useMemo<UseTerminalStreamResult>(() => {
    const write = (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && socketAuthenticatedRef.current) {
        try {
          ws.send(ttydInputFrame(data));
        } catch {
          socketFailedRef.current = true;
          setStatus("error");
          closeSocket(ws);
        }
      } else if (transport === "pty-ws" && !socketFailedRef.current) {
        const nextSize = pendingInputRef.current.length + data.length;
        if (nextSize > MAX_PENDING_TERMINAL_INPUT_CODE_UNITS) {
          pendingInputRef.current = "";
          socketFailedRef.current = true;
          setStatus("error");
          closeSocket(ws);
          return;
        }
        pendingInputRef.current += data;
      }
    };
    const resize = (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      sizeRef.current = { cols, rows };
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN && socketAuthenticatedRef.current) {
        try {
          ws.send(ttydResizeFrame(cols, rows));
        } catch {
          // socket raced closed — geometry is replayed on the next open.
        }
      }
    };
    const disconnect = () => {
      const ws = wsRef.current;
      wsRef.current = null;
      pendingInputRef.current = "";
      socketFailedRef.current = false;
      socketAuthenticatedRef.current = false;
      setStatus("closed");
      closeSocket(ws);
    };
    return { connected: status === "open", status, write, resize, disconnect };
  }, [status, transport]);
}
