import {
  OpenGeniApiError,
  applyUrlRotation,
  type SessionCapabilities,
  type SessionEvent,
  type StreamUrlRotatedPayload,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";

export type SessionCapabilitiesState = "idle" | "negotiating" | "ready" | "cold" | "error";

export type UseSessionCapabilitiesOptions = ClientOverride & {
  /**
   * Live event log to fold `stream.url.rotated` from (usually
   * `useSessionEvents().events`). When present the desktop socket stays fresh on
   * a box rollover without a round-trip; stale-epoch rotations are dropped.
   */
  events?: SessionEvent[] | undefined;
  /**
   * Whether to acquire a viewer holder for the desktop pixel plane. Requires the
   * un-redacted acknowledgment to have been recorded (else the attach 409s and
   * the hook surfaces the consent requirement). Default false: read-only
   * negotiation (no holder, no warm) — terminal/files/git work without it.
   */
  attachDesktop?: boolean | undefined;
  /** Hold off negotiating (e.g. the workbench panel is collapsed). Default true. */
  enabled?: boolean | undefined;
  /** Poll cadence (ms) while the lease is cold/warming. Default 1500. */
  warmingPollMs?: number | undefined;
  /**
   * Give up waiting for `warm` after this long while polling (ms) and surface a
   * stalled error with a manual `renegotiate`. Default 30000 (must agree with
   * the lease warming TTL — I15). 0 disables the deadline.
   */
  warmingDeadlineMs?: number | undefined;
};

export type UseSessionCapabilitiesResult = {
  /** The negotiated capability doc — the single source of UI truth. */
  capabilities: SessionCapabilities | null;
  state: SessionCapabilitiesState;
  error: Error | null;
  /**
   * 409 from the desktop attach: the un-redacted (or shared) plane needs explicit
   * acknowledgment before a viewer holder is granted. Drives the consent prompt.
   */
  acknowledgmentRequired: "unredacted" | "shared" | null;
  /** 429 from the desktop attach: the per-session viewer cap is reached. */
  viewerCapReached: boolean;
  /** The viewer holder id minted on a desktop attach (for detach/heartbeat). */
  viewerId: string | null;
  /** Force a re-negotiation (after acknowledging, a resolution change, etc.). */
  renegotiate: () => void;
};

/** Read `stream.url.rotated` payloads off the live event log, newest last. */
function rotationsFrom(events: SessionEvent[]): StreamUrlRotatedPayload[] {
  const out: StreamUrlRotatedPayload[] = [];
  for (const event of events) {
    if (event.type === "stream.url.rotated" && event.payload && typeof event.payload === "object") {
      out.push(event.payload as StreamUrlRotatedPayload);
    }
  }
  return out;
}

/**
 * The capability-negotiation hook. Discovers what THIS session+backend+OS
 * supports (FileSystem/Terminal/Git always-ish; DesktopStream/Recording
 * sometimes), drives capability-gated rendering, and — when `attachDesktop` —
 * holds a viewer lease + heartbeats it so the box stays warm while watched.
 *
 * Degradation is a value, never a crash: an unsupported surface comes back
 * `available:false`/`transport:null` + a `reason`; the components render the
 * reason-aware empty state. 409 (consent) and 429 (viewer cap) are surfaced as
 * typed signals, not thrown.
 */
export function useSessionCapabilities(
  sessionId: string | null | undefined,
  options: UseSessionCapabilitiesOptions = {},
): UseSessionCapabilitiesResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const attachDesktop = options.attachDesktop ?? false;
  const warmingPollMs = options.warmingPollMs ?? 1500;
  const warmingDeadlineMs = options.warmingDeadlineMs ?? 30_000;

  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [state, setState] = useState<SessionCapabilitiesState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [acknowledgmentRequired, setAcknowledgmentRequired] = useState<"unredacted" | "shared" | null>(null);
  const [viewerCapReached, setViewerCapReached] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  // Bumped to force a fresh negotiation cycle.
  const [nonce, setNonce] = useState(0);

  // The epoch the client has settled on — used to fence stale rotations folded
  // from the event log, and echoed on heartbeats.
  const epochRef = useRef(0);
  const viewerIdRef = useRef<string | null>(null);

  const renegotiate = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  // ── Negotiation + viewer lifecycle ──────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !sessionId) {
      setState("idle");
      setCapabilities(null);
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let localViewerId: string | null = null;
    const startedAt = Date.now();

    const clearTimers = () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
    };

    const settle = (caps: SessionCapabilities) => {
      if (cancelled) return;
      epochRef.current = caps.leaseEpoch;
      setCapabilities(caps);
      setError(null);
    };

    const startHeartbeat = (caps: SessionCapabilities) => {
      if (!localViewerId || heartbeatTimer !== null) return;
      const intervalMs = caps.viewerHeartbeatIntervalMs > 0 ? caps.viewerHeartbeatIntervalMs : 30_000;
      heartbeatTimer = setInterval(() => {
        if (cancelled || !localViewerId) return;
        void client
          .heartbeatViewer(workspaceId, sessionId, localViewerId, { leaseEpoch: epochRef.current })
          .then((res) => {
            // alive:false ⇒ the holder was reaped or the epoch moved under us;
            // re-negotiate to re-acquire against the new owner.
            if (!res.alive && !cancelled) {
              renegotiate();
            }
          })
          .catch((cause) => {
            if (cancelled) return;
            if (cause instanceof OpenGeniApiError && (cause.status === 409 || cause.status === 410)) {
              renegotiate();
            }
          });
      }, intervalMs);
    };

    const pollUntilWarm = () => {
      pollTimer = setTimeout(() => {
        if (cancelled) return;
        void client
          .getStreamCapabilities(workspaceId, sessionId)
          .then((caps) => {
            if (cancelled) return;
            settle(caps);
            if (caps.liveness === "warm" || caps.liveness === "draining") {
              setState("ready");
              return;
            }
            if (warmingDeadlineMs > 0 && Date.now() - startedAt > warmingDeadlineMs) {
              setState("error");
              setError(new Error("sandbox did not warm in time — retry to re-negotiate"));
              return;
            }
            pollUntilWarm();
          })
          .catch((cause) => {
            if (!cancelled) {
              setState("error");
              setError(cause instanceof Error ? cause : new Error(String(cause)));
            }
          });
      }, warmingPollMs);
    };

    void (async () => {
      setState("negotiating");
      setAcknowledgmentRequired(null);
      setViewerCapReached(false);
      try {
        const caps = await client.getStreamCapabilities(workspaceId, sessionId);
        if (cancelled) return;
        settle(caps);

        // Optional desktop attach: acquire a viewer holder (warms a cold box).
        // The consent gate (409) and the viewer cap (429) surface as typed
        // signals rather than throwing — the desktop tab degrades gracefully.
        if (attachDesktop && caps.DesktopStream.transport !== null) {
          try {
            const holder = await client.attachViewer(workspaceId, sessionId, {});
            if (cancelled) return;
            localViewerId = holder.viewerId;
            viewerIdRef.current = holder.viewerId;
            setViewerId(holder.viewerId);
            epochRef.current = holder.leaseEpoch;
            // Fold the freshly-minted live address into the doc the components read.
            setCapabilities((prev) =>
              prev
                ? {
                    ...prev,
                    liveness: holder.liveness,
                    leaseEpoch: holder.leaseEpoch,
                    viewerHeartbeatIntervalMs: holder.viewerHeartbeatIntervalMs,
                    DesktopStream: {
                      ...prev.DesktopStream,
                      transport: holder.transport ?? prev.DesktopStream.transport,
                      client: holder.client ?? prev.DesktopStream.client,
                      url: holder.dataPlaneUrl ?? prev.DesktopStream.url,
                      token: holder.streamToken ?? prev.DesktopStream.token,
                      expiresAt: holder.streamExpiresAt ?? prev.DesktopStream.expiresAt,
                      resolution: holder.resolution ?? prev.DesktopStream.resolution,
                    },
                  }
                : prev,
            );
          } catch (cause) {
            if (cancelled) return;
            if (cause instanceof OpenGeniApiError) {
              if (cause.status === 409) {
                setAcknowledgmentRequired(
                  cause.message.includes("shared_acknowledgment") ? "shared" : "unredacted",
                );
              } else if (cause.status === 429) {
                setViewerCapReached(true);
              } else if (cause.status === 403) {
                setState("error");
                setError(cause);
                return;
              }
              // 409/429 are recoverable: structured surfaces still negotiated;
              // keep going to set ready/cold below.
            } else {
              throw cause;
            }
          }
        }

        if (caps.liveness === "warm" || caps.liveness === "draining" || localViewerId) {
          setState("ready");
          startHeartbeat(caps);
        } else {
          setState("cold");
          pollUntilWarm();
        }
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof OpenGeniApiError && cause.status === 403) {
          setState("error");
          setError(new Error("not permitted to view this session's sandbox"));
          return;
        }
        setState("error");
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    })();

    return () => {
      cancelled = true;
      clearTimers();
      // Fire-and-forget detach (idempotent delete-my-row). Capture the id so a
      // re-render/unmount race still releases the right holder.
      const releaseId = localViewerId ?? viewerIdRef.current;
      if (releaseId) {
        void client.detachViewer(workspaceId, sessionId, releaseId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, workspaceId, sessionId, enabled, attachDesktop, warmingPollMs, warmingDeadlineMs, nonce]);

  // ── Fold stream.url.rotated from the live event log (no round trip) ──────────
  const events = options.events;
  useEffect(() => {
    if (!events || events.length === 0) return;
    setCapabilities((prev) => {
      if (!prev || !prev.DesktopStream.url) return prev;
      let next = prev.DesktopStream;
      let changed = false;
      for (const rotation of rotationsFrom(events)) {
        // Only this viewer's rotations (others' are filtered by viewerId when set).
        if (rotation.viewerId && viewerIdRef.current && rotation.viewerId !== viewerIdRef.current) {
          continue;
        }
        const applied = applyUrlRotation(next, rotation, epochRef.current);
        if (applied) {
          next = { ...next, url: applied.url, token: applied.token, expiresAt: applied.expiresAt };
          epochRef.current = Math.max(epochRef.current, rotation.leaseEpoch);
          changed = true;
        }
      }
      return changed ? { ...prev, DesktopStream: next, leaseEpoch: epochRef.current } : prev;
    });
  }, [events]);

  return {
    capabilities,
    state,
    error,
    acknowledgmentRequired,
    viewerCapReached,
    viewerId,
    renegotiate,
  };
}
