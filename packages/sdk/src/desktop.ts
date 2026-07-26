// Zero-dependency desktop (noVNC) transport contract.
//
// The actual `@novnc/novnc` RFB import is a browser-only DOM dependency and
// lives in `@opengeni/react` (lazily imported, SSR-safe). The framework-agnostic
// SDK ships only the transport CONTRACT: a URL assembler, the minimal RFB
// surface the component drives, the connection state machine, and the
// rotation/fence reducers — all pure and unit-testable, with no DOM and no deps.
//
// Channel A (terminal-as-events, files, git) needs NO new transport here: those
// are event projections + the synchronous fs/git/terminal point queries on
// `OpenGeniClient`. Only the desktop pixel plane (Channel B, direct-to-provider)
// needs this.

import type { DesktopStreamCapability, StreamUrlRotatedPayload } from "./types";

/**
 * Translate the negotiated desktop capability into the WebSocket URL the noVNC
 * RFB client connects to. The scoped provider token is ALREADY embedded in the
 * minted `url` (Modal tunnel host, Blaxel `bl_preview_token`, Daytona signed
 * preview) by `session.resolveExposedPort(6080)` — we do NOT append `cap.token`
 * as a query param (that double-auth was an adversarial-review bug: the box runs
 * `-nopw` in v1, so the RFB password is meaningless and the real auth is the
 * tunnel token in the host). We only normalize the scheme to `ws`/`wss` and, when
 * the minted URL points at a `vnc.html` viewer page, rewrite it to the
 * websockify socket path noVNC actually dials.
 */
export function desktopSocketUrl(cap: Pick<DesktopStreamCapability, "url">): string {
  if (!cap.url) {
    throw new Error("desktop capability has no url (transport is null)");
  }
  const u = new URL(cap.url);
  // https → wss, http → ws (noVNC dials a WebSocket, not the HTTP viewer page).
  if (u.protocol === "https:") {
    u.protocol = "wss:";
  } else if (u.protocol === "http:") {
    u.protocol = "ws:";
  }
  // A minted `…/vnc.html` (or `…/vnc_lite.html`) viewer page → the websockify
  // socket the page itself would open (`…/websockify`). A bare host/path with no
  // viewer page is already the socket path; leave it untouched.
  if (/\/vnc(_lite)?\.html$/.test(u.pathname)) {
    u.pathname = u.pathname.replace(/\/vnc(_lite)?\.html$/, "/websockify");
    u.search = "";
    u.hash = "";
  }
  return u.toString();
}

/**
 * The minimal RFB surface the React component drives. Lets tests (and 3rd
 * parties swapping noVNC for a WebRTC client in v3) provide a fake without the
 * DOM. Matches `@novnc/novnc`'s RFB constructor + lifecycle.
 */
export interface DesktopRfbLike {
  viewOnly: boolean;
  scaleViewport: boolean;
  /**
   * 1:1 viewport clipping. We always drive this FALSE: with clipping on, noVNC
   * paints the framebuffer pixel-for-pixel and scrolls/crops to the container
   * (the "zoomed in" look). FALSE lets `scaleViewport` shrink the 1280x800 frame
   * to fit the panel (aspect-preserved). Declared so the hook can pin it instead
   * of relying on noVNC's default — `scaleViewport=true` forces clip off
   * internally, but a stale/partial state on reconnect could leave it on.
   */
  clipViewport: boolean;
  addEventListener(
    type: "connect" | "disconnect" | "securityfailure",
    cb: (e?: unknown) => void,
  ): void;
  removeEventListener?: (
    type: "connect" | "disconnect" | "securityfailure",
    cb: (e?: unknown) => void,
  ) => void;
  disconnect(): void;
}

export type DesktopRfbFactory = (
  target: HTMLElement,
  url: string,
  opts: { credentials?: { password?: string | undefined } | undefined },
) => DesktopRfbLike;

export type DesktopConnectionState =
  | "idle"
  | "negotiating"
  | "connecting"
  | "connected"
  | "rotating"
  | "reconnecting"
  | "error"
  | "ended";

export type DesktopStreamEvent =
  | { type: "negotiated" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "rotate" }
  | { type: "fail" }
  | { type: "abort" };

/**
 * Pure reducer for the desktop connection lifecycle. The component owns the RFB
 * object + DOM; this owns the transitions so they are unit-testable. Mirrors the
 * Channel-A stream reducer discipline.
 */
export function nextDesktopState(
  current: DesktopConnectionState,
  ev: DesktopStreamEvent,
): DesktopConnectionState {
  switch (ev.type) {
    case "negotiated":
      return "connecting";
    case "connected":
      return "connected";
    case "rotate":
      return current === "connected" ? "rotating" : current;
    case "disconnected":
      // A deliberate teardown (ended) stays ended; everything else reconnects.
      return current === "ended" ? "ended" : "reconnecting";
    case "fail":
      return "error";
    case "abort":
      return "ended";
    default:
      return current;
  }
}

// `DesktopStreamCapability` is the desktop cell of `SessionCapabilities`; alias
// it for the rotation reducer below without depending on the whole doc.
export type DesktopStreamCapabilityLike = {
  url: string | null;
  token: string | null;
  expiresAt: string | null;
};

/**
 * Apply a `stream.url.rotated` event onto a desktop capability, fencing on
 * leaseEpoch (split-brain). A rotation minted under an epoch the client has
 * already advanced PAST is from a superseded owner and is dropped (returns
 * null); otherwise the fresh url/token/expiresAt are folded in.
 */
export function applyUrlRotation<T extends DesktopStreamCapabilityLike>(
  cap: T,
  payload: StreamUrlRotatedPayload,
  knownEpoch: number,
): T | null {
  if (payload.leaseEpoch < knownEpoch) {
    return null;
  }
  return { ...cap, url: payload.url, token: payload.token, expiresAt: payload.expiresAt };
}
