import {
  decodeStreamFrame,
  decodeStreamOpenAck,
  encodeStreamOpen,
  STREAM_KIND_DESKTOP,
  STREAM_ROLE_CLIENT,
} from "../lib/relay-wire";
import type { DesktopConnectionState, DesktopStreamCapability } from "@opengeni/sdk";
import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * The minimal WebSocket surface the frame renderer drives. Lets tests (and a
 * future transport swap) inject a fake without a live socket — the exact
 * analogue of `DesktopRfbFactory` for the noVNC path. Structurally a subset of
 * the browser `WebSocket`.
 */
export interface DesktopWebSocketLike {
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: { data?: unknown } & Record<string, unknown>) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: { data?: unknown } & Record<string, unknown>) => void,
  ): void;
}

export type DesktopWebSocketFactory = (url: string) => DesktopWebSocketLike;

export type UseRelayFrameStreamOptions = {
  /** The desktop cell of the negotiated capabilities (`capabilities.DesktopStream`). */
  capability: DesktopStreamCapability | null;
  /** The mount target. A `<canvas>` is appended here on connect. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Custom socket factory (tests / a transport swap). Defaults to `new WebSocket(url)`. */
  webSocketFactory?: DesktopWebSocketFactory | undefined;
};

export type UseRelayFrameStreamResult = {
  state: DesktopConnectionState;
  error: Error | null;
  /** Tear down + reopen the socket (e.g. after a drop, once a fresh url arrives). */
  reconnect: () => void;
};

// Relay datagram tags: byte[0] of every binary message. Mirrors the proven wire
// protocol in `apps/api/scripts/diagnose-mac-desktop-stream.ts`.
const TAG_OPEN = 1;
const TAG_OPENACK = 2;
const TAG_FRAME = 3;

/** Build a relay datagram: a fresh Uint8Array of `body.length + 1` with the tag
 *  at [0] and the protobuf body copied at offset 1 (so `.buffer` is exact). */
function datagram(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

function defaultWebSocketFactory(url: string): DesktopWebSocketLike {
  // The browser `WebSocket` is structurally a superset of `DesktopWebSocketLike`
  // (its event maps are stricter); cast so the seam stays loosely typed for fakes.
  return new WebSocket(url) as unknown as DesktopWebSocketLike;
}

/**
 * VIEW-ONLY PNG-frame renderer for a SELF-HOSTED desktop stream — the relay
 * transport (`transport: "relay-frames"`, `client: "frames"`). The self-hosted
 * agent produces one PNG per frame as a protobuf datagram over the relay; there
 * is no RFB/noVNC here. This hook opens the relay DESKTOP channel as a CLIENT
 * (mirroring the proven diagnostic wire protocol), decodes each PNG onto a
 * `<canvas>` mounted into `containerRef`, and drives the connection state
 * machine: idle → connecting (ws opening) → connected (first painted frame) →
 * error (ws error/close/ack rejection).
 *
 * It is DORMANT for any other transport (or no url): it stays idle and touches
 * nothing, so the noVNC path owns the surface. SSR-safe: the socket + DOM attach
 * live inside `useEffect`.
 *
 * Backpressure (critical — frames are ~1.8MB at ~10fps): at most one frame is
 * decoded at a time; a frame arriving mid-decode replaces the pending one
 * (latest-wins), so a slow decode can never build an unbounded queue.
 */
export function useRelayFrameStream(options: UseRelayFrameStreamOptions): UseRelayFrameStreamResult {
  const { capability, containerRef, webSocketFactory } = options;
  const [state, setState] = useState<DesktopConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const stateRef = useRef<DesktopConnectionState>("idle");
  const setBoth = (next: DesktopConnectionState) => {
    stateRef.current = next;
    setState(next);
  };

  const reconnect = () => setNonce((n) => n + 1);

  const transport = capability?.transport ?? null;
  const url = capability?.url ?? null;
  const token = capability?.token ?? null;

  // The factory is read via a ref so swapping it never re-opens the socket (it is
  // not a connect-effect dependency), symmetric with the noVNC `rfbFactory`.
  const factoryRef = useRef(webSocketFactory);
  factoryRef.current = webSocketFactory;

  useEffect(() => {
    // SSR / no DOM: stay idle and show the placeholder.
    if (typeof window === "undefined") return;
    // This hook OWNS the surface ONLY for the frame transport; anything else (or
    // no live url) → dormant idle so the noVNC path can drive.
    if (transport !== "relay-frames" || !url) {
      setBoth("idle");
      return;
    }
    const container = containerRef.current;
    if (!container) {
      // Mount target not in the DOM yet (tab hidden) — stay idle so a re-attach
      // nudge can re-run this effect once the container exists.
      setBoth("idle");
      return;
    }

    // Parse the 4 relay query params the channel is keyed on.
    let channel: {
      channelId: string;
      workspaceId: string;
      agentId: string;
      kind: number;
      port: number;
    };
    try {
      const u = new URL(url);
      channel = {
        channelId: u.searchParams.get("channel") ?? "",
        workspaceId: u.searchParams.get("ws") ?? "",
        agentId: u.searchParams.get("agent") ?? "",
        kind: STREAM_KIND_DESKTOP,
        port: Number(u.searchParams.get("port") ?? "0"),
      };
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBoth("error");
      return;
    }

    setError(null);
    setBoth("connecting");

    // Canvas mount — mirror the noVNC surface conventions: absolute-fill the
    // panel and CONTAIN the framebuffer (aspect-preserved, centered, letterboxed)
    // — never distorted, never overflowing. `max-*: 100%` + `margin: auto` +
    // intrinsic size gives fit-to-panel without a resize observer.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-opengeni-desktop-frames", "");
    const style = canvas.style;
    style.position = "absolute";
    style.top = "0";
    style.left = "0";
    style.right = "0";
    style.bottom = "0";
    style.margin = "auto";
    style.maxWidth = "100%";
    style.maxHeight = "100%";
    style.width = "auto";
    style.height = "auto";
    style.display = "block";
    style.imageRendering = "auto";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    let disposed = false;
    let acked = false;
    // Backpressure: decode at most ONE frame at a time; a frame arriving mid-
    // decode replaces `pending` (keep only the LATEST) — never a queue.
    let decoding = false;
    let pending: Uint8Array | null = null;

    const drainLatest = async () => {
      if (decoding) return;
      decoding = true;
      try {
        while (!disposed && pending) {
          const data = pending;
          pending = null;
          let bmp: ImageBitmap;
          try {
            // Copy the exact frame bytes into a fresh ArrayBuffer-backed view:
            // ts-proto's `bytes()` hands back a subarray VIEW into the larger
            // message buffer, so slicing isolates just this PNG (and satisfies the
            // `BlobPart` typing, which rejects the generic `ArrayBufferLike`).
            bmp = await createImageBitmap(new Blob([new Uint8Array(data)], { type: "image/png" }));
          } catch {
            // A corrupt/partial frame is skipped; latest-wins keeps us live.
            continue;
          }
          if (disposed) {
            bmp.close();
            break;
          }
          // Size the backing store to the frame's natural WxH on the first frame
          // (or when the resolution changes); CSS then scales the element to fit.
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          bmp.close();
          // First painted frame → connected.
          if (!disposed && stateRef.current !== "connected") setBoth("connected");
        }
      } finally {
        decoding = false;
      }
    };

    let ws: DesktopWebSocketLike;
    try {
      ws = (factoryRef.current ?? defaultWebSocketFactory)(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBoth("error");
      canvas.remove();
      return;
    }
    ws.binaryType = "arraybuffer";

    const onOpen = () => {
      if (disposed) return;
      const body = encodeStreamOpen({
        channel,
        token: token ?? "",
        role: STREAM_ROLE_CLIENT,
        resumeFromSeq: "0",
      });
      try {
        ws.send(datagram(TAG_OPEN, body).buffer as ArrayBuffer);
      } catch {
        // Socket already closing; the close/error handler surfaces it.
      }
    };

    const onMessage = (ev: { data?: unknown }) => {
      if (disposed) return;
      const data = ev.data;
      if (!(data instanceof ArrayBuffer)) return;
      const buf = new Uint8Array(data);
      if (buf.length === 0) return;
      const tag = buf[0];
      const rest = buf.subarray(1);
      if (tag === TAG_OPENACK) {
        let ack: ReturnType<typeof decodeStreamOpenAck>;
        try {
          ack = decodeStreamOpenAck(rest);
        } catch {
          return;
        }
        if (!ack.accepted) {
          setError(
            new Error(
              ack.error?.message
                ? `desktop stream rejected: ${ack.error.message}`
                : "desktop stream rejected by the relay",
            ),
          );
          setBoth("error");
          try {
            ws.close();
          } catch {
            // already closed
          }
          return;
        }
        // Accepted — stay "connecting" until the first frame paints.
        acked = true;
      } else if (tag === TAG_FRAME) {
        let fr: ReturnType<typeof decodeStreamFrame>;
        try {
          fr = decodeStreamFrame(rest);
        } catch {
          return;
        }
        if (fr.data && fr.data.length > 0) {
          pending = fr.data; // latest-wins backpressure
          void drainLatest();
        }
      }
    };

    const onError = () => {
      if (disposed) return;
      setError((prev) => prev ?? new Error("desktop stream connection error"));
      setBoth("error");
    };

    const onClose = () => {
      if (disposed) return;
      setError(
        (prev) =>
          prev ??
          new Error(acked ? "desktop stream closed" : "desktop stream closed before it opened"),
      );
      setBoth("error");
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);

    return () => {
      disposed = true;
      pending = null;
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      try {
        ws.close();
      } catch {
        // ignore teardown errors
      }
      canvas.remove();
    };
    // ONLY a real transport change reopens: a fresh url (rotation), a new token,
    // the transport flipping, or a manual reconnect (`nonce`). The factory is read
    // via a ref and must never re-open the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token, transport, nonce]);

  return { state, error, reconnect };
}
