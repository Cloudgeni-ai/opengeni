// Zero-dependency interactive-terminal (ttyd PTY-over-websocket) transport
// contract. Symmetric with `desktop.ts`: the SDK ships only the pure transport
// CONTRACT (a URL assembler + the ttyd wire-protocol frame codec), with no DOM
// and no deps. The actual WebSocket open + xterm attach lives in `@opengeni/react`
// (`use-terminal-stream.ts`).
//
// The interactive terminal is a REAL PTY streamed over the SAME Modal raw-TLS
// tunnel as the desktop noVNC, with the SAME scoped stream-token mechanism. The
// box bakes `ttyd` on `TERMINAL_STREAM_PORT` (7681); `session.resolveExposedPort`
// mints the tunnel URL. The Terminal capability cell carries transport "pty-ws" +
// that url + the scoped token when the box is warm and a viewer is attached.

import type { TerminalCapability } from "./types";

/**
 * Translate the negotiated `pty-ws` Terminal capability into the WebSocket URL
 * the ttyd client dials. The scoped provider token is ALREADY embedded in the
 * minted `url` (the Modal tunnel host) by `session.resolveExposedPort(7681)` —
 * we do NOT append `cap.token` (identical posture to the desktop: the gate is the
 * unguessable short-TTL tunnel URL + the server-recorded scoped stream token; ttyd
 * runs `--writable` with no `-c` credential in v1). We only normalize the scheme
 * to `ws`/`wss`; a bare host is already the ttyd websocket endpoint.
 */
export function terminalSocketUrl(cap: Pick<TerminalCapability, "url">): string {
  if (!cap.url) {
    throw new Error("terminal capability has no url (transport is not pty-ws)");
  }
  const u = new URL(cap.url);
  // https → wss, http → ws (ttyd is dialed as a WebSocket, not an HTTP page).
  if (u.protocol === "https:") {
    u.protocol = "wss:";
  } else if (u.protocol === "http:") {
    u.protocol = "ws:";
  }
  return u.toString();
}

// ── ttyd wire protocol ───────────────────────────────────────────────────────
// ttyd frames are a single ASCII command char + payload. These mirror ttyd's
// `protocol.h` Command enum. Client→server and server→client share the byte 0/1/2
// values but mean different things per direction (see below).

/** ttyd subprotocol — REQUIRED on the WebSocket handshake or ttyd refuses it. */
export const TTYD_SUBPROTOCOL = "tty";

/** Client→server command bytes (the first char of each outbound text frame). */
export const TtydClientCommand = {
  /** stdin: "0" + raw input bytes. */
  INPUT: "0",
  /** window resize: "1" + JSON.stringify({ columns, rows }). */
  RESIZE: "1",
  /** flow-control pause (back-pressure): "2". */
  PAUSE: "2",
  /** flow-control resume: "3". */
  RESUME: "3",
} as const;

/** Server→client command bytes (the first char of each inbound frame). */
export const TtydServerCommand = {
  /** stdout/stderr: "0" + raw output bytes (write the rest into xterm). */
  OUTPUT: "0",
  /** set the window title: "1" + title string. */
  SET_WINDOW_TITLE: "1",
  /** ttyd client preferences JSON: "2" + json (ignored by us). */
  SET_PREFERENCES: "2",
} as const;

/**
 * The ttyd handshake's first frame: an auth message. ttyd expects
 * `JSON.stringify({ AuthToken })` as the FIRST text frame on the socket. We send
 * an empty token — our gate is the tunnel URL + scoped stream token, NOT a ttyd
 * `-c` basic-auth credential (which the box does not set in v1). Optional ttyd
 * `columns`/`rows` can ride this frame to seed the PTY size before the first
 * resize. Pure (string-building only) so it stays unit-testable in the SDK.
 */
export function ttydAuthFrame(opts?: { columns?: number; rows?: number }): string {
  const frame: { AuthToken: string; columns?: number; rows?: number } = { AuthToken: "" };
  if (opts?.columns && opts.columns > 0) frame.columns = opts.columns;
  if (opts?.rows && opts.rows > 0) frame.rows = opts.rows;
  return JSON.stringify(frame);
}

/** Build a client→server INPUT (stdin) frame: "0" + data. */
export function ttydInputFrame(data: string): string {
  return TtydClientCommand.INPUT + data;
}

/** Build a client→server RESIZE frame: "1" + JSON.stringify({ columns, rows }). */
export function ttydResizeFrame(columns: number, rows: number): string {
  return TtydClientCommand.RESIZE + JSON.stringify({ columns, rows });
}
