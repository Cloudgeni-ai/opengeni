import type { BrowserFrameHealthValue } from "@opengeni/runtime/sandbox";

/** A live view's stream sends frames continuously, so one that has sent none
 * for this long has stopped. */
export const BROWSER_FRAME_STALL_MS = 10_000;

export type BrowserFrameHealthSource = {
  frameHealth(): Promise<BrowserFrameHealthValue>;
};

/**
 * The streams and live-view sockets of a frame-health report that have
 * stopped producing frames, or null when every one is sending. The browser
 * controller's own log stays inside its sandbox and goes when the sandbox
 * stops, so this is what records why a live view froze.
 */
export function stalledBrowserFrames(health: BrowserFrameHealthValue): {
  streams: BrowserFrameHealthValue["streams"];
  sockets: BrowserFrameHealthValue["sockets"];
} | null {
  const streams = health.streams.filter(
    (stream) =>
      stream.subscribers > 0 && (stream.sinceLastFrameMs ?? stream.ageMs) >= BROWSER_FRAME_STALL_MS,
  );
  const sockets = health.sockets.filter(
    (socket) => (socket.sinceLastSentMs ?? socket.ageMs) >= BROWSER_FRAME_STALL_MS,
  );
  return streams.length > 0 || sockets.length > 0 ? { streams, sockets } : null;
}

/** Logs a warning when a live view of the browser has stopped getting
 * frames. Best effort: a controller that does not report frame health (an
 * older release) or fails to answer is not an error of the caller. */
export async function logStalledBrowserFrames(
  source: BrowserFrameHealthSource,
  browserSessionId: string,
  log: (event: string, fields: Record<string, unknown>) => void = console.warn,
): Promise<void> {
  let health: BrowserFrameHealthValue;
  try {
    health = await source.frameHealth();
  } catch {
    return;
  }
  const stalled = stalledBrowserFrames(health);
  if (!stalled) return;
  log("browser.frame_stream.stalled", {
    browserSessionId,
    controllerGeneration: health.controllerGeneration,
    windowParking: health.windowParking,
    streams: stalled.streams,
    sockets: stalled.sockets,
  });
}
