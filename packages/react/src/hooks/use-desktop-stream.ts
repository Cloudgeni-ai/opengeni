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
  const transport = capability?.transport ?? null;
  const mode = capability?.mode ?? "read-only";

  useEffect(() => {
    // SSR / no DOM / no usable transport: stay idle and show the placeholder.
    if (typeof window === "undefined") return;
    if (!capability || transport !== "vnc-ws" || !url) {
      setBoth("idle");
      return;
    }
    const container = containerRef.current;
    if (!container) return;

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
        const factory = rfbFactory ?? (await defaultRfbFactory());
        if (disposed) return;
        const socketUrl = desktopSocketUrl({ url });
        setBoth(nextDesktopState(stateRef.current, { type: "negotiated" }));
        rfb = factory(container, socketUrl, {
          credentials: capability.token ? { password: capability.token } : undefined,
        });
        // read-only is forced when the server says so OR the caller didn't opt in.
        rfb.viewOnly = mode === "read-only" || !interactive;
        rfb.scaleViewport = scaleViewport ?? true;
        rfb.addEventListener("connect", onConnect);
        rfb.addEventListener("disconnect", onDisconnect);
        rfb.addEventListener("securityfailure", onSecurityFailure);
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setBoth("error");
        }
      }
    })();

    return () => {
      disposed = true;
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
    // A url change (rotation) re-runs this effect → disconnect old, connect new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capability, url, transport, mode, interactive, scaleViewport, rfbFactory, nonce]);

  return { state, error, reconnect };
}
