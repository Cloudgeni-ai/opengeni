import {
  HTML_FRAME_HOST_MESSAGE,
  HTML_FRAME_HOST_VERSION,
  htmlFrameHostUrl,
  type HtmlFrameRenderMode,
} from "@opengeni/contracts/html-frame-host";
import { useEffect, useRef, type RefObject } from "react";

/** Where a frame-host frame is: loading the host, HTML sent, HTML loaded. */
export type HtmlFrameHostPhase = "loader" | "sent" | "loaded";

/**
 * The frame host URL for this page, or null when none is configured. `self`
 * names the page's own origin (a deployment without a Sites domain).
 */
export function htmlFrameHostSrc(frameHost: string | null | undefined): string | null {
  if (!frameHost || typeof window === "undefined") return null;
  const origin = window.location.origin;
  try {
    return htmlFrameHostUrl(frameHost === "self" ? origin : frameHost, origin);
  } catch {
    return null;
  }
}

/**
 * Drive one frame-host iframe (see `@opengeni/contracts/html-frame-host`):
 * answer the loader's `ready` with the HTML, and report when the HTML's own
 * document has loaded. Messages count only when they come from this frame's
 * window with the opaque origin a sandboxed frame has, and the HTML is sent
 * once per load of the frame host.
 *
 * `onFrameLoad` must be the iframe's `load` handler. It returns true for a
 * load after the HTML has loaded (the frame navigated elsewhere), which the
 * caller treats like a `srcdoc` frame's later loads.
 */
export function useHtmlFrameHost(options: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  enabled: boolean;
  html: string;
  mode: HtmlFrameRenderMode;
  onLoaded?: () => void;
}): { phaseRef: RefObject<HtmlFrameHostPhase>; onFrameLoad: () => boolean } {
  const phaseRef = useRef<HtmlFrameHostPhase>("loader");
  const htmlRef = useRef(options.html);
  const onLoadedRef = useRef(options.onLoaded);
  // New HTML remounts the frame (the caller keys it on the HTML): start over.
  if (htmlRef.current !== options.html) phaseRef.current = "loader";
  htmlRef.current = options.html;
  onLoadedRef.current = options.onLoaded;
  const { frameRef, enabled, mode } = options;
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const receive = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow || event.origin !== "null") return;
      const data = event.data as { type?: unknown; version?: unknown } | null;
      if (!data || data.version !== HTML_FRAME_HOST_VERSION) return;
      if (data.type === HTML_FRAME_HOST_MESSAGE.ready && phaseRef.current === "loader") {
        phaseRef.current = "sent";
        // A sandboxed frame's origin is opaque and cannot be named; the
        // loader checks this window and origin before it accepts the HTML.
        frameWindow.postMessage(
          {
            type: HTML_FRAME_HOST_MESSAGE.render,
            version: HTML_FRAME_HOST_VERSION,
            mode,
            html: htmlRef.current,
          },
          "*",
        );
      } else if (data.type === HTML_FRAME_HOST_MESSAGE.loaded && phaseRef.current === "sent") {
        phaseRef.current = "loaded";
        onLoadedRef.current?.();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [enabled, frameRef, mode]);
  return {
    phaseRef,
    onFrameLoad: () => phaseRef.current === "loaded",
  };
}
