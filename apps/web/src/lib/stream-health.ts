// Live-stream health for the operational beacon (client-signals.ts). The
// session event stream and the workspace live stream reconnect on their own;
// this turns their connection-state changes into three closed signals so
// "the agent looks stuck" is measurable:
//
// - `reconnect`: a live stream dropped and started reconnecting. At most one
//   per stream per minute, so a flapping connection cannot flood.
// - `reconnect_exhausted`: the stream stopped reconnecting (error state)
//   after it had been connecting, reconnecting, or live. Once per episode.
// - `long_disconnect`: the stream stayed connecting or reconnecting for more
//   than 30 seconds of visible time. Hidden time does not count, because a
//   background tab is not a person waiting. Once per episode.
import type { ClientStream, ClientStreamEvent } from "@opengeni/contracts/client-error-report";
import { useEffect, useRef } from "react";

import { reportClientStreamEvent } from "./client-signals";

export type StreamHealthState = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "error";

export const LONG_DISCONNECT_MS = 30_000;
export const RECONNECT_REPORT_INTERVAL_MS = 60_000;

export type StreamHealthMonitorOptions = {
  report: (event: ClientStreamEvent) => void;
  now?: () => number;
  isVisible?: () => boolean;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  longDisconnectMs?: number;
  reconnectReportIntervalMs?: number;
};

export type StreamHealthMonitor = {
  observe(state: StreamHealthState): void;
  visibilityChanged(): void;
  dispose(): void;
};

export function createStreamHealthMonitor(
  options: StreamHealthMonitorOptions,
): StreamHealthMonitor {
  const now = options.now ?? Date.now;
  const isVisible =
    options.isVisible ??
    (() => typeof document === "undefined" || document.visibilityState === "visible");
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const longDisconnectMs = options.longDisconnectMs ?? LONG_DISCONNECT_MS;
  const reconnectInterval = options.reconnectReportIntervalMs ?? RECONNECT_REPORT_INTERVAL_MS;

  let state: StreamHealthState = "idle";
  let lastReconnectReportAt: number | null = null;
  // A disconnection episode: from leaving `live` (or first connecting) until
  // the stream is live again, ends, or the view stops observing it.
  let episode: {
    visibleMs: number;
    visibleSince: number | null;
    longReported: boolean;
  } | null = null;
  let timer: unknown = null;

  const report = (event: ClientStreamEvent) => {
    try {
      options.report(event);
    } catch {
      // Telemetry must never affect the stream.
    }
  };
  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const visibleElapsed = () =>
    episode
      ? episode.visibleMs + (episode.visibleSince === null ? 0 : now() - episode.visibleSince)
      : 0;
  const armTimer = () => {
    stopTimer();
    if (!episode || episode.longReported || episode.visibleSince === null) return;
    timer = setTimer(checkLong, Math.max(0, longDisconnectMs - visibleElapsed()));
  };
  function checkLong() {
    timer = null;
    if (!episode || episode.longReported) return;
    if (visibleElapsed() >= longDisconnectMs) {
      episode.longReported = true;
      report("long_disconnect");
      return;
    }
    armTimer();
  }
  const startEpisode = () => {
    if (episode) return;
    const visible = isVisible();
    episode = {
      visibleMs: 0,
      visibleSince: visible ? now() : null,
      longReported: false,
    };
    armTimer();
  };
  const endEpisode = () => {
    stopTimer();
    episode = null;
  };

  return {
    observe(next) {
      const previous = state;
      if (next === previous) return;
      state = next;
      switch (next) {
        case "live":
        case "idle":
        case "ended":
          endEpisode();
          return;
        case "connecting":
          startEpisode();
          return;
        case "reconnecting": {
          if (previous === "live") {
            const at = now();
            if (lastReconnectReportAt === null || at - lastReconnectReportAt >= reconnectInterval) {
              lastReconnectReportAt = at;
              report("reconnect");
            }
          }
          startEpisode();
          return;
        }
        case "error": {
          if (previous === "connecting" || previous === "reconnecting" || previous === "live") {
            report("reconnect_exhausted");
          }
          endEpisode();
          return;
        }
      }
    },
    visibilityChanged() {
      if (!episode) return;
      const visible = isVisible();
      if (visible && episode.visibleSince === null) {
        episode.visibleSince = now();
        armTimer();
      } else if (!visible && episode.visibleSince !== null) {
        episode.visibleMs += now() - episode.visibleSince;
        episode.visibleSince = null;
        stopTimer();
      }
    },
    dispose() {
      endEpisode();
      state = "idle";
    },
  };
}

/** Report one live stream's health from its connection state while mounted. */
export function useStreamHealthTelemetry(stream: ClientStream, state: StreamHealthState): void {
  const monitor = useRef<StreamHealthMonitor | null>(null);
  useEffect(() => {
    const created = createStreamHealthMonitor({
      report: (event) => reportClientStreamEvent(stream, event),
    });
    monitor.current = created;
    const onVisibility = () => created.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      created.dispose();
      if (monitor.current === created) monitor.current = null;
    };
  }, [stream]);
  useEffect(() => {
    monitor.current?.observe(state);
  }, [state]);
}
