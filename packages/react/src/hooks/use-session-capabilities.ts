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
  /**
   * Whether to acquire a viewer holder to warm the box for the REAL interactive
   * terminal (the ttyd pty-ws plane). Symmetric with `attachDesktop` and shares
   * the SAME viewer attach (one warm box serves both planes), but needs NO
   * un-redacted acknowledgment — a shell is interactive by nature, and the gate
   * is the scoped tunnel URL + stream token. Default false: the terminal stays on
   * the read-only Channel-A firehose until the user opens/focuses it. The attach
   * folds the minted `pty-ws` url+token into the `Terminal` cell.
   */
  attachTerminal?: boolean | undefined;
  /**
   * Whether to acquire a viewer holder purely to KEEP THE BOX WARM while the
   * structured Files surface is open. Shares the SAME viewer attach as the
   * desktop/terminal (one warm box, one holder) and — like the terminal — needs
   * NO un-redacted acknowledgment: listing/reading/writing files is the ordinary
   * Channel-A control plane, not the pixel plane. Default false: the Files tab
   * negotiates read-only and each op pays the cold-box resume (~5s). When true,
   * the holder warms the box once and heartbeats it, so subsequent fs ops are
   * ~100ms instead of re-resuming the box on every list/write. It folds NO live
   * URL (files ride the stateless HTTP plane) — it only refcounts liveness.
   */
  attachFiles?: boolean | undefined;
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

/**
 * Whether a desktop attach (POST /viewers) is worth attempting for this cell.
 * The desktop is FEASIBLE — and thus worth warming — when it already has a live
 * transport, OR when the only thing missing is a warm box (a cold/un-provisioned
 * lease). The handshake never warms a box, so a feasible-but-cold cell reports
 * transport:null with a transient reason; the viewer attach is exactly what warms
 * it. A genuinely-unsupported desktop (backend/os/policy/headless) is never
 * attachable — attaching would 409/403/no-op without ever producing a stream.
 */
function desktopAttachable(cell: SessionCapabilities["DesktopStream"]): boolean {
  if (cell.transport !== null) return true;
  // transport === null: attach only when the reason is a transient cold state.
  return cell.reason === "lease_cold" || cell.reason === "not_provisioned" || cell.reason === null;
}

/**
 * Whether warming the box for the interactive terminal (pty-ws) is worth it.
 * The Terminal cell is ALWAYS feasible when the backend advertises a transport at
 * all (`sse-events` on a cold box, `pty-ws` once warm) — only a genuinely
 * terminal-less backend reports transport:null with a hard reason. The attach is
 * what flips `sse-events` → `pty-ws` by warming the box and minting the ttyd
 * tunnel URL, so we attach whenever the terminal is not hard-unavailable.
 */
function terminalAttachable(cell: SessionCapabilities["Terminal"]): boolean {
  if (cell.transport === null) {
    // No terminal at all unless the only blocker is a transient cold state.
    return cell.reason === "lease_cold" || cell.reason === "not_provisioned" || cell.reason === null;
  }
  // Already pty-ws (warm) is fine to (re)attach; sse-events is the cold state the
  // attach upgrades. Either way it's attachable.
  return true;
}

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
  const attachTerminal = options.attachTerminal ?? false;
  const attachFiles = options.attachFiles ?? false;
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

        // Optional viewer attach: acquire a viewer holder (warms a cold box). ONE
        // attach serves BOTH live planes — the desktop pixel stream AND the
        // interactive terminal (ttyd pty-ws) ride the same warm box and the same
        // holder; the response folds the minted address for each requested plane.
        // The consent gate (409) and the viewer cap (429) surface as typed signals
        // rather than throwing — the tabs degrade gracefully.
        //
        // KEY: the handshake (getStreamCapabilities) NEVER spins up a cold box, so
        // on a cold/warming lease the desktop cell comes back transport:null and
        // the terminal cell comes back `sse-events` (read-only firehose) with a
        // transient reason (`lease_cold`/`not_provisioned`). Gating the attach on
        // `transport` therefore dead-ends both surfaces (forever "Starting…"): they
        // never warm because they never attach, and never attach because they
        // aren't warm. We attach whenever a REQUESTED plane is FEASIBLE — transport
        // already live OR cold-but-feasible — and let POST /viewers warm the box and
        // mint the URLs. Only a genuinely-unsupported reason suppresses the attach.
        const wantDesktopAttach = attachDesktop && desktopAttachable(caps.DesktopStream);
        const wantTerminalAttach = attachTerminal && terminalAttachable(caps.Terminal);
        // The Files surface warms the box for fast Channel-A ops. It folds no live
        // URL (files are stateless HTTP) — the attach is purely a liveness refcount,
        // so it's wanted whenever the FileSystem capability is advertised at all.
        const wantFilesAttach = attachFiles && caps.FileSystem.available;
        if (wantDesktopAttach || wantTerminalAttach || wantFilesAttach) {
          try {
            // Declare WHICH plane we're attaching for. `desktop:true` opts into the
            // un-redacted pixel plane (which carries the consent gate); a
            // terminal-only attach (`desktop:false`) warms the box + mints the
            // pty-ws terminal cell WITHOUT tripping the desktop consent 409.
            const holder = await client.attachViewer(workspaceId, sessionId, { desktop: wantDesktopAttach });
            if (cancelled) return;
            localViewerId = holder.viewerId;
            viewerIdRef.current = holder.viewerId;
            setViewerId(holder.viewerId);
            epochRef.current = holder.leaseEpoch;
            // Fold the freshly-minted live address(es) into the doc the components
            // read. Desktop fields fold only when a desktop attach was wanted;
            // terminal fields fold the minted ttyd pty-ws url+token when present.
            setCapabilities((prev) =>
              prev
                ? {
                    ...prev,
                    liveness: holder.liveness,
                    leaseEpoch: holder.leaseEpoch,
                    viewerHeartbeatIntervalMs: holder.viewerHeartbeatIntervalMs,
                    DesktopStream: wantDesktopAttach
                      ? {
                          ...prev.DesktopStream,
                          transport: holder.transport ?? prev.DesktopStream.transport,
                          client: holder.client ?? prev.DesktopStream.client,
                          url: holder.dataPlaneUrl ?? prev.DesktopStream.url,
                          token: holder.streamToken ?? prev.DesktopStream.token,
                          expiresAt: holder.streamExpiresAt ?? prev.DesktopStream.expiresAt,
                          resolution: holder.resolution ?? prev.DesktopStream.resolution,
                        }
                      : prev.DesktopStream,
                    Terminal:
                      holder.terminalUrl && holder.terminalTransport
                        ? {
                            ...prev.Terminal,
                            transport: holder.terminalTransport,
                            url: holder.terminalUrl,
                            token: holder.terminalToken ?? prev.Terminal.token,
                            // A live pty-ws means the box is pty-capable for real.
                            ptyCapable: true,
                            reason: null,
                          }
                        : prev.Terminal,
                  }
                : prev,
            );
          } catch (cause) {
            if (cancelled) return;
            if (cause instanceof OpenGeniApiError) {
              if (cause.status === 409) {
                // The un-redacted/shared consent gate is a DESKTOP requirement. A
                // terminal-only warm attach needs no consent, so a 409 there is not
                // a consent prompt — the terminal just stays on the read-only
                // firehose. Only raise the consent requirement when the desktop was
                // the (or a) reason we attached.
                if (wantDesktopAttach) {
                  setAcknowledgmentRequired(
                    cause.message.includes("shared_acknowledgment") ? "shared" : "unredacted",
                  );
                }
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
  }, [client, workspaceId, sessionId, enabled, attachDesktop, attachTerminal, attachFiles, warmingPollMs, warmingDeadlineMs, nonce]);

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
