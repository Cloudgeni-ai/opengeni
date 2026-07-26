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
  capability: Pick<TerminalCapability, "transport" | "url" | "token"> | null;
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
  /** Pipe a keystroke/paste to the PTY stdin. No-op until the socket is open. */
  write: (data: string) => void;
  /** Tell ttyd the PTY window changed size (on xterm fit/resize). */
  resize: (cols: number, rows: number) => void;
  /** Tear the socket down (the effect also tears down on unmount / url change). */
  disconnect: () => void;
};

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

  useEffect(() => {
    // SSR / no WebSocket / not a live pty-ws cell: stay closed; the caller falls
    // back to the Channel-A read-only firehose.
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
    if (transport !== "pty-ws" || !url) {
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
      } catch {
        // a closed socket between open and send — onclose handles state.
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
      if (!disposed) setStatus("error");
    };
    socket.onclose = () => {
      if (!disposed) setStatus("closed");
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      // Drop handlers so an in-flight close/error doesn't mutate state post-unmount.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // ignore teardown errors
      }
    };
    // A url/token change (rotation) re-runs this effect → close old, open new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, url, token]);

  return useMemo<UseTerminalStreamResult>(() => {
    const write = (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(ttydInputFrame(data));
        } catch {
          // socket raced closed — the reconnect effect will re-establish.
        }
      }
    };
    const resize = (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      sizeRef.current = { cols, rows };
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
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
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
    return { connected: status === "open", status, write, resize, disconnect };
  }, [status]);
}
