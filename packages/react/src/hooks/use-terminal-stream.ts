import {
  TTYD_SUBPROTOCOL,
  TerminalCapability,
  terminalSocketUrl,
  ttydAuthFrame,
  ttydInputFrame,
  ttydResizeFrame,
  TtydServerCommand,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeStreamFrame,
  decodeStreamOpenAck,
  encodeStreamFrame,
  encodeStreamOpen,
  type RelayChannel,
  STREAM_KIND_PTY,
  STREAM_ROLE_CLIENT,
} from "../lib/relay-wire";
import {
  TERMINAL_INPUT_READY_PREFERENCE,
  TERMINAL_INPUT_READY_PROTOCOL,
  terminalInputReadyDecoder,
} from "../lib/terminal-input-readiness";

/** The ttyd connection lifecycle as surfaced to the component. */
export type TerminalStreamStatus = "connecting" | "open" | "closed" | "error";

export type UseTerminalStreamOptions = {
  /** The Terminal cell of the negotiated capabilities (`capabilities.Terminal`).
   *  The stream connects ONLY when `transport === "pty-ws"` and `url` is set; on a
   *  cold box (`transport === "sse-events"` / no url) it stays idle and the caller
   *  falls back to the Channel-A firehose. Explicit PTY-capable cold cells may
   *  buffer input, but cannot connect or flush until the grant arrives. */
  capability:
    | (Pick<TerminalCapability, "transport" | "url" | "token" | "expiresAt"> &
        Partial<Pick<TerminalCapability, "ptyCapable" | "reason">>)
    | null;
  /** Called for each OUTPUT payload from ttyd (write verbatim into xterm). */
  onOutput?: ((data: string) => void) | undefined;
  /** Called when ttyd sends a SET_WINDOW_TITLE frame. */
  onTitle?: ((title: string) => void) | undefined;
  /** Requests a fresh negotiated terminal grant after an unexpected transport
   * failure. Intentional disconnects and effect cleanup never call it. */
  onReconnectNeeded?: (() => void) | undefined;
  /** Initial PTY size to seed the ttyd auth frame + first resize. */
  initialCols?: number | undefined;
  initialRows?: number | undefined;
};

export type UseTerminalStreamResult = {
  /** True when input can be sent. Legacy ttyd does not guarantee shell readiness. */
  connected: boolean;
  status: TerminalStreamStatus;
  /** `waiting` requires explicit shell readiness; `legacy` has no such guarantee. */
  inputReadiness: "pending" | "waiting" | "ready" | "legacy";
  /** Deliberate escape for startup prompts/no-Readline shells. Clears queued
   * typing without executing it, then enables unguaranteed manual input. */
  useLegacyInput: () => void;
  /** Pipe a keystroke/paste to PTY stdin. Input during CONNECTING is bounded and
   *  replayed after negotiated readiness (or legacy ttyd preferences). */
  write: (data: string) => void;
  /** Tell ttyd the PTY window changed size (on xterm fit/resize). */
  resize: (cols: number, rows: number) => void;
  /** Tear the socket down (the effect also tears down on unmount / url change). */
  disconnect: () => void;
};

// Keystrokes entered during startup are held until the negotiated input boundary.
// Old ttyd servers retain explicitly legacy semantics. Bound by UTF-16 code units (a hard
// <=128 KiB string payload in current JS engines) so a paste cannot turn a slow
// handshake into unbounded renderer memory. Overflow rejects the whole pending
// input rather than ever executing a truncated shell command.
export const MAX_PENDING_TERMINAL_INPUT_CODE_UNITS = 64 * 1024;
const TERMINAL_CONNECT_EXPIRY_SKEW_MS = 5_000;
const TERMINAL_RECONNECT_INITIAL_MS = 100;
const TERMINAL_RECONNECT_MAX_MS = 3_000;
const RELAY_TAG_OPEN = 1;
const RELAY_TAG_OPEN_ACK = 2;
const RELAY_TAG_FRAME = 3;

function relayDatagram(tag: number, body: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(body.length + 1);
  bytes[0] = tag;
  bytes.set(body, 1);
  return bytes.buffer;
}

function relayChannelFromUrl(url: string): RelayChannel {
  const endpoint = new URL(url);
  const channel: RelayChannel = {
    channelId: endpoint.searchParams.get("channel") ?? "",
    workspaceId: endpoint.searchParams.get("ws") ?? "",
    agentId: endpoint.searchParams.get("agent") ?? "",
    kind: STREAM_KIND_PTY,
    port: Number(endpoint.searchParams.get("port") ?? "0"),
  };
  if (
    !channel.channelId ||
    !channel.workspaceId ||
    !channel.agentId ||
    !Number.isSafeInteger(channel.port) ||
    channel.port <= 0
  ) {
    throw new Error("terminal relay endpoint is incomplete");
  }
  return channel;
}

function sendRelayInput(
  socket: WebSocket,
  channel: RelayChannel,
  sequence: bigint,
  data: string,
): void {
  socket.send(
    relayDatagram(
      RELAY_TAG_FRAME,
      encodeStreamFrame({
        channelId: channel.channelId,
        seq: sequence.toString(),
        data: new TextEncoder().encode(data),
        producedAtMs: String(Date.now()),
      }),
    ),
  );
}

/** A bearer must remain valid long enough to finish a new websocket handshake.
 * Existing open sockets are unaffected: this is evaluated only when the
 * credential identity changes and the connection effect attempts a new socket. */
export function terminalStreamCredentialUsable(
  capability: Pick<TerminalCapability, "transport" | "url" | "expiresAt"> | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (
    (capability?.transport !== "pty-ws" && capability?.transport !== "relay-pty") ||
    !capability.url
  ) {
    return false;
  }
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
 *     "2" = SET_PREFERENCES (readiness negotiation). Binary frames decode identically.
 *
 * On a `url`/`token` rotation (a box rollover folds a fresh address into the cell)
 * the effect re-runs: the old socket closes and a fresh one connects — a brief
 * terminal blink, acceptable on rollover (mirrors the desktop's RFB hot-swap).
 * SSR-safe: the socket open lives in `useEffect`, so a server render is a no-op.
 */
export function useTerminalStream(options: UseTerminalStreamOptions): UseTerminalStreamResult {
  const { capability, onOutput, onTitle, onReconnectNeeded, initialCols, initialRows } = options;
  const [status, setStatus] = useState<TerminalStreamStatus>("closed");
  const [inputReadiness, setInputReadiness] =
    useState<UseTerminalStreamResult["inputReadiness"]>("pending");
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingInputRef = useRef("");
  const socketFailedRef = useRef(false);
  const socketAuthenticatedRef = useRef(false);
  const legacyInputRef = useRef<(() => void) | null>(null);
  const manuallyDisconnectedRef = useRef(false);
  const relayChannelRef = useRef<RelayChannel | null>(null);
  const relayIdentityRef = useRef<string | null>(null);
  const relayInputSequenceRef = useRef(0n);
  const relayOutputSequenceRef = useRef(0n);
  const reconnectAttemptRef = useRef(0);
  const credentialIdentityRef = useRef<string | null>(null);
  const refreshRequestedRef = useRef(false);
  const intentionalCloseRef = useRef<WeakSet<WebSocket>>(new WeakSet());
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
  const onReconnectNeededRef = useRef(onReconnectNeeded);
  onOutputRef.current = onOutput;
  onTitleRef.current = onTitle;
  onReconnectNeededRef.current = onReconnectNeeded;

  const transport = capability?.transport ?? null;
  const url = capability?.url ?? null;
  const token = capability?.token ?? null;
  const expiresAt = capability?.expiresAt ?? null;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  // A cold, explicitly PTY-capable cell may collect input before its viewer
  // grant arrives. This is not a socket credential or a readiness assertion.
  const acquiringPty =
    transport === "sse-events" &&
    capability?.ptyCapable === true &&
    (capability.reason === "lease_cold" || capability.reason === "not_provisioned");
  const acquiringPtyRef = useRef(acquiringPty);
  acquiringPtyRef.current = acquiringPty;

  useEffect(() => {
    manuallyDisconnectedRef.current = false;
    setInputReadiness("pending");
    // SSR / no WebSocket / not a live pty-ws cell: stay closed; the caller falls
    // back to the Channel-A read-only firehose.
    if (typeof window === "undefined" || typeof WebSocket === "undefined") return;
    const relay = transport === "relay-pty";
    if (transport !== "pty-ws" && !relay) {
      // A transport downgrade is a real semantic boundary. Do not replay input
      // captured for a PTY if this surface later changes back from firehose mode.
      pendingInputRef.current = "";
      socketAuthenticatedRef.current = false;
      relayIdentityRef.current = null;
      relayInputSequenceRef.current = 0n;
      relayOutputSequenceRef.current = 0n;
      reconnectAttemptRef.current = 0;
      credentialIdentityRef.current = null;
      refreshRequestedRef.current = false;
      socketFailedRef.current = false;
      setStatus("closed");
      return;
    }
    const credentialIdentity = `${transport}\u0000${url ?? ""}\u0000${token ?? ""}\u0000${expiresAt ?? ""}`;
    if (credentialIdentityRef.current !== credentialIdentity) {
      credentialIdentityRef.current = credentialIdentity;
      reconnectAttemptRef.current = 0;
      refreshRequestedRef.current = false;
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
      // aged out before this surface mounted. Ask once for the exact fresh grant.
      setStatus("closed");
      if (!refreshRequestedRef.current) {
        refreshRequestedRef.current = true;
        onReconnectNeededRef.current?.();
      }
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let socket: WebSocket;
    let relayChannel: RelayChannel | null = null;
    let authSent = false;
    let preferencesReceived = false;
    let readinessNegotiated = false;
    let sentSize: { cols: number; rows: number } | null = null;
    const decodeReadyOutput = terminalInputReadyDecoder();
    const relayOutputDecoder = new TextDecoder();
    setStatus("connecting");
    try {
      if (relay) {
        relayChannel = relayChannelFromUrl(url);
        const relayIdentity = [
          relayChannel.workspaceId,
          relayChannel.agentId,
          relayChannel.port,
          relayChannel.channelId,
        ].join("\u0000");
        if (relayIdentityRef.current !== relayIdentity) {
          relayIdentityRef.current = relayIdentity;
          relayInputSequenceRef.current = 0n;
          relayOutputSequenceRef.current = 0n;
        }
        relayChannelRef.current = relayChannel;
        socket = new WebSocket(url);
      } else {
        // The ttyd "tty" subprotocol is REQUIRED — ttyd rejects a handshake without
        // it. The scoped token is already in the tunnel `url`.
        socket = new WebSocket(terminalSocketUrl({ url }), TTYD_SUBPROTOCOL);
      }
    } catch {
      socketFailedRef.current = true;
      setStatus("error");
      return;
    }
    socket.binaryType = "arraybuffer";
    wsRef.current = socket;

    const requestFreshGrant = () => {
      if (disposed || refreshRequestedRef.current || intentionalCloseRef.current.has(socket))
        return;
      refreshRequestedRef.current = true;
      onReconnectNeededRef.current?.();
    };

    const scheduleTransportReconnect = () => {
      if (disposed || reconnectTimer !== null || intentionalCloseRef.current.has(socket)) return;
      if (refreshRequestedRef.current) return;
      if (!terminalStreamCredentialUsable({ transport, url, expiresAt })) {
        requestFreshGrant();
        return;
      }
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(
        TERMINAL_RECONNECT_INITIAL_MS * 2 ** Math.min(attempt, 8),
        TERMINAL_RECONNECT_MAX_MS,
      );
      setStatus("connecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!disposed && !manuallyDisconnectedRef.current)
          setReconnectGeneration((generation) => generation + 1);
      }, delay);
    };

    const openTtydInput = (mode: "ready" | "legacy", discardPending = false) => {
      if (
        disposed ||
        wsRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        !authSent ||
        socketFailedRef.current
      )
        return;
      if (discardPending) pendingInputRef.current = "";
      try {
        // A fit/resize may have happened while shell readiness was pending.
        if (sentSize?.cols !== sizeRef.current.cols || sentSize.rows !== sizeRef.current.rows) {
          socket.send(ttydResizeFrame(sizeRef.current.cols, sizeRef.current.rows));
          sentSize = { ...sizeRef.current };
        }
        if (pendingInputRef.current.length > 0) {
          socket.send(ttydInputFrame(pendingInputRef.current));
          pendingInputRef.current = "";
        }
        socketAuthenticatedRef.current = true;
        legacyInputRef.current = null;
        setInputReadiness(mode);
        setStatus("open");
        reconnectAttemptRef.current = 0;
        refreshRequestedRef.current = false;
      } catch {
        socketAuthenticatedRef.current = false;
        setInputReadiness("pending");
        setStatus("connecting");
        closeSocket(socket);
      }
    };

    socket.onopen = () => {
      if (disposed || wsRef.current !== socket || socketFailedRef.current) return;
      if (relay && relayChannel) {
        try {
          socket.send(
            relayDatagram(
              RELAY_TAG_OPEN,
              encodeStreamOpen({
                channel: relayChannel,
                token: token ?? "",
                role: STREAM_ROLE_CLIENT,
                resumeFromSeq: relayOutputSequenceRef.current.toString(),
              }),
            ),
          );
        } catch {
          socketFailedRef.current = false;
          setStatus("connecting");
          closeSocket(socket);
        }
        return;
      }
      // ttyd's required first frame: the auth message (empty token — the gate is
      // the tunnel url + scoped stream token, not a ttyd -c credential), seeded
      // with the current PTY geometry. Then an explicit resize to be safe.
      try {
        socket.send(ttydAuthFrame({ columns: sizeRef.current.cols, rows: sizeRef.current.rows }));
        socket.send(ttydResizeFrame(sizeRef.current.cols, sizeRef.current.rows));
        sentSize = { ...sizeRef.current };
        authSent = true;
      } catch {
        socketFailedRef.current = false;
        setStatus("connecting");
        closeSocket(socket);
        return;
      }
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (disposed || wsRef.current !== socket || socketFailedRef.current) return;
      if (relay) {
        if (!(ev.data instanceof ArrayBuffer) || !relayChannel) return;
        const bytes = new Uint8Array(ev.data);
        if (bytes.length < 1) return;
        const tag = bytes[0];
        const body = bytes.subarray(1);
        if (tag === RELAY_TAG_OPEN_ACK) {
          try {
            const ack = decodeStreamOpenAck(body);
            if (!ack.accepted) throw new Error(ack.error?.message ?? "terminal relay rejected");
            reconnectAttemptRef.current = 0;
            refreshRequestedRef.current = false;
            socketAuthenticatedRef.current = true;
            if (pendingInputRef.current.length > 0) {
              sendRelayInput(
                socket,
                relayChannel,
                relayInputSequenceRef.current++,
                pendingInputRef.current,
              );
              pendingInputRef.current = "";
            }
            setStatus("open");
            setInputReadiness("ready");
          } catch {
            socketFailedRef.current = true;
            setStatus("error");
            requestFreshGrant();
            closeSocket(socket);
          }
        } else if (tag === RELAY_TAG_FRAME && socketAuthenticatedRef.current) {
          try {
            const frame = decodeStreamFrame(body);
            const sequence = BigInt(frame.seq);
            if (sequence < relayOutputSequenceRef.current) return;
            relayOutputSequenceRef.current = sequence + 1n;
            if (frame.data.length > 0) {
              onOutputRef.current?.(relayOutputDecoder.decode(frame.data, { stream: true }));
            }
          } catch {
            // Ignore one malformed frame; the live PTY remains usable.
          }
        }
        return;
      }
      const { command, payload } = decodeFrame(ev.data as string | ArrayBuffer);
      switch (command) {
        case TtydServerCommand.OUTPUT:
          if (readinessNegotiated) {
            const decoded = decodeReadyOutput(payload);
            if (decoded.output) onOutputRef.current?.(decoded.output);
            if (decoded.ready && !socketAuthenticatedRef.current) openTtydInput("ready");
          } else {
            onOutputRef.current?.(payload);
          }
          break;
        case TtydServerCommand.SET_WINDOW_TITLE:
          onTitleRef.current?.(payload);
          break;
        case TtydServerCommand.SET_PREFERENCES:
          if (!authSent || preferencesReceived || socketAuthenticatedRef.current) break;
          preferencesReceived = true;
          try {
            const preferences = JSON.parse(payload) as Record<string, unknown>;
            if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
              throw new Error("invalid ttyd preferences");
            }
            const protocol = preferences[TERMINAL_INPUT_READY_PREFERENCE];
            if (protocol === undefined) {
              // Old images/running daemons do not acquire a guarantee merely
              // because this client is new. Preserve their legacy input path.
              openTtydInput("legacy");
            } else {
              readinessNegotiated = protocol === TERMINAL_INPUT_READY_PROTOCOL;
              setInputReadiness("waiting");
              legacyInputRef.current = () => openTtydInput("legacy", true);
            }
          } catch {
            // Invalid negotiation is not readiness. Manual input remains a
            // deliberate escape, never an automatic fallback or timer flush.
            setInputReadiness("waiting");
            legacyInputRef.current = () => openTtydInput("legacy", true);
          }
          break;
        default:
          break;
      }
    };

    socket.onerror = () => {
      if (!disposed && wsRef.current === socket && !intentionalCloseRef.current.has(socket)) {
        // A network/relay outage is retryable with the same credential and PTY.
        // Keep accepting bounded input while the transport comes back.
        socketFailedRef.current = false;
        setStatus("connecting");
        closeSocket(socket);
      }
    };
    socket.onclose = () => {
      if (disposed || wsRef.current !== socket) return;
      if (wsRef.current === socket) wsRef.current = null;
      socketAuthenticatedRef.current = false;
      legacyInputRef.current = null;
      setInputReadiness("pending");
      if (!disposed) {
        if (socketFailedRef.current) setStatus("error");
        else scheduleTransportReconnect();
      }
    };

    return () => {
      disposed = true;
      wsRef.current = null;
      socketAuthenticatedRef.current = false;
      legacyInputRef.current = null;
      relayChannelRef.current = null;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      // Drop handlers so an in-flight close/error doesn't mutate state post-unmount.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      closeSocket(socket);
    };
    // A url/token change (rotation) re-runs this effect → close old, open new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, url, token, expiresAt, acquiringPty, reconnectGeneration]);

  const write = useCallback((data: string) => {
    const currentTransport = transportRef.current;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && socketAuthenticatedRef.current) {
      try {
        const relayChannel = relayChannelRef.current;
        if (currentTransport === "relay-pty" && relayChannel) {
          sendRelayInput(ws, relayChannel, relayInputSequenceRef.current++, data);
        } else {
          ws.send(ttydInputFrame(data));
        }
      } catch {
        // A synchronous ttyd send failure did not enqueue these bytes. Retain
        // them for the next explicit readiness boundary, never replay a send
        // which returned successfully. Relay sequencing keeps its own contract.
        if (currentTransport === "pty-ws") {
          const nextSize = pendingInputRef.current.length + data.length;
          if (nextSize > MAX_PENDING_TERMINAL_INPUT_CODE_UNITS) {
            pendingInputRef.current = "";
            socketFailedRef.current = true;
            socketAuthenticatedRef.current = false;
            setStatus("error");
            closeSocket(ws);
            return;
          }
          pendingInputRef.current += data;
        }
        socketAuthenticatedRef.current = false;
        socketFailedRef.current = false;
        setStatus("connecting");
        closeSocket(ws);
      }
    } else if (
      (currentTransport === "pty-ws" ||
        currentTransport === "relay-pty" ||
        acquiringPtyRef.current) &&
      !socketFailedRef.current
    ) {
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
  }, []);
  const resize = useCallback((cols: number, rows: number) => {
    if (cols <= 0 || rows <= 0) return;
    sizeRef.current = { cols, rows };
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && socketAuthenticatedRef.current) {
      try {
        // Self-hosted relay PTYs carry raw input/output frames. Resize remains
        // an out-of-band control operation; do not send ttyd framing into them.
        if (transportRef.current === "pty-ws") ws.send(ttydResizeFrame(cols, rows));
      } catch {
        // socket raced closed — geometry is replayed on the next open.
      }
    }
  }, []);
  const disconnect = useCallback(() => {
    manuallyDisconnectedRef.current = true;
    const ws = wsRef.current;
    wsRef.current = null;
    pendingInputRef.current = "";
    socketFailedRef.current = false;
    socketAuthenticatedRef.current = false;
    legacyInputRef.current = null;
    relayChannelRef.current = null;
    setStatus("closed");
    setInputReadiness("pending");
    if (ws) intentionalCloseRef.current.add(ws);
    closeSocket(ws);
  }, []);
  const useLegacyInput = useCallback(() => legacyInputRef.current?.(), []);

  return useMemo<UseTerminalStreamResult>(() => {
    return {
      connected: status === "open",
      status,
      inputReadiness,
      useLegacyInput,
      write,
      resize,
      disconnect,
    };
  }, [status, inputReadiness, useLegacyInput, write, resize, disconnect]);
}
