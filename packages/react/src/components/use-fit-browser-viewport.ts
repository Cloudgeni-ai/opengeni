import type { BrowserFrame } from "@opengeni/sdk/interaction";
import { useEffect, useLayoutEffect, useRef } from "react";

export const browserViewerFrameLimit = { maxWidth: 1_920, maxHeight: 1_200 } as const;
const MIN_VIEWPORT_SIZE = 240;
const RESIZE_SETTLE_MS = 180;

export function useFitBrowserViewport(options: {
  frame: BrowserFrame | null;
  scope: string | null;
  onResize: (frame: BrowserFrame, width: number, height: number) => Promise<unknown>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { scope } = options;
  useEffect(() => {
    const container = containerRef.current;
    if (!scope || container === null || typeof ResizeObserver === "undefined") return;
    let disposed = false;
    let pending = false;
    let needsMeasurement = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWidth = 0;
    let lastHeight = 0;

    const schedule = () => {
      clearTimeout(timer);
      if (disposed || document.visibilityState === "hidden") return;
      timer = setTimeout(() => {
        const { frame, scope: currentScope, onResize } = latest.current;
        if (!frame || currentScope !== scope || document.visibilityState === "hidden") return;
        if (pending) {
          needsMeasurement = true;
          return;
        }
        const { clientWidth, clientHeight } = container;
        if (!clientWidth || !clientHeight) return;
        const width = Math.max(
          MIN_VIEWPORT_SIZE,
          Math.min(clientWidth, browserViewerFrameLimit.maxWidth),
        );
        const height = Math.max(
          MIN_VIEWPORT_SIZE,
          Math.min(clientHeight, browserViewerFrameLimit.maxHeight),
        );
        // React to panel sizes, not incoming frames: don't fight another
        // viewer or an explicit resize made by the agent in the same tab.
        if (width === lastWidth && height === lastHeight) return;
        lastWidth = width;
        lastHeight = height;
        if (
          Math.abs(frame.width / frame.deviceScaleFactor - width) <= 1 &&
          Math.abs(frame.height / frame.deviceScaleFactor - height) <= 1
        )
          return;

        pending = true;
        void onResize(frame, width, height)
          // If control refuses the change, keep showing the unmodified frame.
          .catch(() => undefined)
          .finally(() => {
            pending = false;
            if (!needsMeasurement) return;
            needsMeasurement = false;
            schedule();
          });
      }, RESIZE_SETTLE_MS);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [scope]);
  return containerRef;
}
