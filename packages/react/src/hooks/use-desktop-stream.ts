import {
  desktopSocketUrl,
  nextDesktopState,
  type DesktopConnectionState,
  type DesktopRfbFactory,
  type DesktopRfbLike,
  type DesktopStreamCapability,
} from "@opengeni/sdk";
import { type RefObject, useEffect, useRef, useState } from "react";

export type UseDesktopStreamOptions = {
  /** The desktop cell of the negotiated capabilities (`capabilities.DesktopStream`). */
  capability: DesktopStreamCapability | null;
  /** The mount target. RFB attaches here on connect. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Read-only by default (v1 ruling H). interactive only when cap.mode allows. */
  interactive?: boolean | undefined;
  scaleViewport?: boolean | undefined;
  /** Custom RFB factory (tests / a WebRTC swap). Defaults to a lazy @novnc/novnc. */
  rfbFactory?: DesktopRfbFactory | undefined;
};

export type UseDesktopStreamResult = {
  state: DesktopConnectionState;
  error: Error | null;
  /** Manual reconnect (e.g. after a securityfailure once a fresh URL arrives). */
  reconnect: () => void;
};

/** Lazy-load @novnc/novnc's RFB as the default factory. Imported inside the
 *  connect effect so SSR / non-desktop bundles never pull the DOM-only lib.
 *  @novnc/novnc ships no types and a single `export default class RFB`. The
 *  specifier is STATIC (`import("@novnc/novnc")`) so Vite can pre-bundle and
 *  resolve it — a runtime-string indirection with `@vite-ignore` (the previous
 *  approach) hands the browser a bare specifier and throws
 *  "Failed to resolve module specifier '@novnc/novnc'". The dynamic form keeps
 *  it out of the SSR / non-desktop critical path while staying resolvable. */
async function defaultRfbFactory(): Promise<DesktopRfbFactory> {
  const mod = (await import("@novnc/novnc")) as unknown as {
    default: new (
      t: HTMLElement,
      u: string,
      o: { credentials?: { password?: string | undefined } | undefined },
    ) => DesktopRfbLike;
  };
  const RFB = mod.default;
  return (target, url, opts) => new RFB(target, url, opts);
}

/**
 * Drive the noVNC RFB lifecycle from a `DesktopStreamCapability`, using the
 * SDK's `desktop.ts` reducer + `desktopSocketUrl`. SSR-safe: the RFB import and
 * the DOM attach happen inside `useEffect`, so a server render is a no-op and
 * the component shows its placeholder until hydration.
 *
 * Read-only is enforced at three layers: `capability.mode` (server) →
 * `interactive` prop → `RFB.viewOnly`. v1 always resolves to read-only. On a
 * capability `url` change (a rotation), the old RFB disconnects and a fresh one
 * connects to the new URL — a brief "desktop blink", acceptable on rollover.
 */
export function useDesktopStream(options: UseDesktopStreamOptions): UseDesktopStreamResult {
  const { capability, containerRef, interactive, scaleViewport, rfbFactory } = options;
  const [state, setState] = useState<DesktopConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const stateRef = useRef<DesktopConnectionState>("idle");
  const setBoth = (next: DesktopConnectionState) => {
    stateRef.current = next;
    setState(next);
  };

  const reconnect = () => setNonce((n) => n + 1);

  const url = capability?.url ?? null;
  // The credential is keyed into the connect effect so a token rotation (new
  // password) reconnects, but NOT folded into the whole-`capability` identity —
  // a benign re-negotiation that re-mints the same cell must not churn the socket.
  const token = capability?.token ?? null;
  const transport = capability?.transport ?? null;
  const mode = capability?.mode ?? "read-only";

  // The live RFB handle. Holding it in a ref lets us flip view-only (take
  // control / return control) and re-scale on the OPEN connection instead of
  // tearing the socket down — the old behaviour reconnected on every
  // `interactive` change, which read as a constant "refresh" and (combined with
  // the canvas churn) bounced control back to watch.
  const rfbRef = useRef<DesktopRfbLike | null>(null);
  // Latest input/scale/factory the connect effect reads via refs so they are NOT
  // connect-effect dependencies: changing them must update the live RFB in place,
  // never reconnect it.
  const interactiveRef = useRef(interactive);
  const scaleViewportRef = useRef(scaleViewport);
  const modeRef = useRef(mode);
  const rfbFactoryRef = useRef(rfbFactory);
  interactiveRef.current = interactive;
  scaleViewportRef.current = scaleViewport;
  modeRef.current = mode;
  rfbFactoryRef.current = rfbFactory;

  // read-only is forced when the server says so OR the caller didn't opt in.
  const viewOnlyFor = (m: string, want: boolean | undefined) => m === "read-only" || !want;

  useEffect(() => {
    // SSR / no DOM / no usable transport: stay idle and show the placeholder.
    if (typeof window === "undefined") return;
    if (transport !== "vnc-ws" || !url) {
      setBoth("idle");
      return;
    }
    const container = containerRef.current;
    if (!container) {
      // The mount target isn't in the DOM yet (e.g. the tab is still hidden).
      // Stay idle (not a stale negotiating/connecting) so a re-attach nudge —
      // fired by the viewer on becoming visible / on mount — can re-run this
      // effect once the container exists. Without this the surface can stick
      // forever on the idle scrim and never open a socket.
      setBoth("idle");
      return;
    }

    let rfb: DesktopRfbLike | null = null;
    let disposed = false;
    setError(null);
    setBoth("negotiating");

    const onConnect = () => {
      if (!disposed) setBoth(nextDesktopState(stateRef.current, { type: "connected" }));
    };
    const onDisconnect = () => {
      if (!disposed) setBoth(nextDesktopState(stateRef.current, { type: "disconnected" }));
    };
    const onSecurityFailure = () => {
      if (disposed) return;
      setError(new Error("desktop authentication failed (token expired or revoked)"));
      setBoth(nextDesktopState(stateRef.current, { type: "fail" }));
    };

    void (async () => {
      try {
        const factory = rfbFactoryRef.current ?? (await defaultRfbFactory());
        if (disposed) return;
        const socketUrl = desktopSocketUrl({ url });
        setBoth(nextDesktopState(stateRef.current, { type: "negotiated" }));
        rfb = factory(container, socketUrl, {
          credentials: token ? { password: token } : undefined,
        });
        rfb.viewOnly = viewOnlyFor(modeRef.current, interactiveRef.current);
        // Fit-to-panel: SCALE the 1280x800 framebuffer down to the container
        // (aspect-preserved) and never 1:1-clip. `clipViewport=false` is pinned
        // explicitly — noVNC forces it off while scaling, but a fresh RFB on a
        // url rotation could otherwise start from a stale clip and read as
        // "zoomed in". Order matters: clip off, then scale on.
        rfb.clipViewport = false;
        rfb.scaleViewport = scaleViewportRef.current ?? true;
        rfb.addEventListener("connect", onConnect);
        rfb.addEventListener("disconnect", onDisconnect);
        rfb.addEventListener("securityfailure", onSecurityFailure);
        rfbRef.current = rfb;
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setBoth("error");
        }
      }
    })();

    return () => {
      disposed = true;
      if (rfbRef.current === rfb) rfbRef.current = null;
      if (rfb) {
        rfb.removeEventListener?.("connect", onConnect);
        rfb.removeEventListener?.("disconnect", onDisconnect);
        rfb.removeEventListener?.("securityfailure", onSecurityFailure);
        try {
          rfb.disconnect();
        } catch {
          // ignore teardown errors
        }
      }
    };
    // ONLY a real transport change reconnects: a fresh url (rotation), a new
    // credential, the transport flipping, or an explicit manual reconnect
    // (`nonce`). `interactive`/`scaleViewport`/`mode`/`rfbFactory` are read via
    // refs and applied live below — they must never re-open the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token, transport, nonce]);

  // Apply take-control / return-control to the OPEN connection in place. noVNC
  // honours `viewOnly` live, so flipping it neither blinks the surface nor drops
  // the framebuffer — the cure for the take-control "refresh + auto-release" loop.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (rfb) rfb.viewOnly = viewOnlyFor(mode, interactive);
    // viewOnlyFor is pure; re-run only when the inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, mode, state]);

  // Re-scale the live RFB in place (no reconnect) when the scale preference flips
  // OR the connection state advances (e.g. the first framebuffer paints after a
  // take-control flip / a re-attach). Re-asserting clip-off + scale-on here is the
  // belt-and-suspenders against a "zoomed" surface: it re-fits the canvas to the
  // panel on every meaningful transition, so a transient mis-measure at connect
  // time can never stick.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (rfb) {
      rfb.clipViewport = false;
      rfb.scaleViewport = scaleViewport ?? true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scaleViewport, state]);

  return { state, error, reconnect };
}
