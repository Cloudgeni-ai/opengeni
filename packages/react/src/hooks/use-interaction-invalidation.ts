import type { StreamConnectionState, WorkspaceInteractionRevisionEvent } from "@opengeni/sdk";
import { useEffect, useRef } from "react";
import { usePageLiveActivity } from "./internal";

export type InteractionInvalidationOptions = {
  workspaceId: string;
  /** Distinguishes filtered projections of the same workspace catalog. */
  key: string;
  enabled: boolean;
  event: WorkspaceInteractionRevisionEvent | null;
  connectionState: StreamConnectionState | "idle" | "error";
  /** Catalog responses carry the workspace revision; live-state lists do not. */
  knownRevision?: number | undefined;
  refresh: () => Promise<void>;
  fallbackPollIntervalMs?: number | undefined;
};

/**
 * Refetch authoritative lists on the shared latest-revision stream. Poll only
 * while that stream is unavailable, preserving standalone-hook degradation
 * without multiplying healthy-provider traffic.
 */
export function useInteractionInvalidation(options: InteractionInvalidationOptions): void {
  const {
    workspaceId,
    key,
    enabled,
    event,
    connectionState,
    knownRevision,
    refresh,
    fallbackPollIntervalMs,
  } = options;
  const pageLive = usePageLiveActivity();
  const lastUnversionedEvent = useRef<{ key: string; sequence: number }>({
    key,
    sequence: 0,
  });
  const eventSequence = event?.workspaceId === workspaceId ? event.sequence : 0;

  useEffect(() => {
    if (!enabled || eventSequence <= 0) return;
    if (knownRevision !== undefined) {
      if (eventSequence > knownRevision) void refresh();
      return;
    }
    if (lastUnversionedEvent.current.key !== key) {
      lastUnversionedEvent.current = { key, sequence: 0 };
    }
    if (eventSequence <= lastUnversionedEvent.current.sequence) return;
    lastUnversionedEvent.current = { key, sequence: eventSequence };
    void refresh();
  }, [enabled, eventSequence, key, knownRevision, refresh]);

  useEffect(() => {
    if (!enabled || !pageLive || connectionState === "live") return;
    const interval = boundedPollInterval(fallbackPollIntervalMs ?? 3_000);
    const timer = setInterval(() => void refresh(), interval);
    return () => clearInterval(timer);
  }, [connectionState, enabled, fallbackPollIntervalMs, pageLive, refresh]);
}

function boundedPollInterval(value: number): number {
  if (!Number.isFinite(value)) return 3_000;
  return Math.min(60_000, Math.max(1_000, Math.floor(value)));
}
