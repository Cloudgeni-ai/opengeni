import type { ChatClient } from "@opengeni/sdk";
import {
  OpenGeniApiError,
  applyUrlRotation,
  type SessionCapabilities,
  type SessionEvent,
  type StreamUrlRotatedPayload,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenGeni, type ClientOverride } from "../provider";
import { sandboxAcceptsLiveIo } from "../lib/sandbox-liveness";
import { terminalCanAcquirePty } from "../lib/terminal-capability";
import { normalizeError } from "../lib/error-message";
import { usePageLiveActivity } from "./internal";

// "on-demand" is the boxless-benign resting state: the lease is not currently
// holder-backed and NOTHING asked to warm a box (no viewer/consent action, no
// files-tab warm). Under lazy
// provisioning a chat-only turn never creates a box, so this is the correct calm
// terminal state — NOT an error. It is distinct from "cold", which now means "a
// warm-up is genuinely in flight" (a viewer attach was requested) and therefore
// still polls with a patience deadline. A box appears on demand when the agent
// first runs a sandbox tool; the workbench observes `sandbox.provision` and
// renegotiates to pick up the freshly-warm box.
export type SessionCapabilitiesState =
  | "idle"
  | "negotiating"
  | "ready"
  | "cold"
  | "on-demand"
  | "error";

export type UseSessionCapabilitiesOptions = ClientOverride<ChatClient> & {
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
   * Whether to acquire a viewer holder to warm the box for a FILE WRITE — the
   * wake-on-edit INTENT (a first keystroke in the editor), NOT passive browsing.
   * Shares the SAME viewer attach as the desktop/terminal (one warm box, one
   * holder) and — like the terminal — needs NO un-redacted acknowledgment:
   * reading/writing files is the ordinary Channel-A control plane, not the pixel
   * plane. It folds NO live URL (files ride the stateless HTTP plane) — it only
   * refcounts liveness. Unlike desktop/terminal it warms even a COLD box: an edit
   * legitimately cold-creates (that IS the wake), so the write lands ~100ms warm
   * instead of paying the ~5s cold resume. Default false. IMPORTANT: merely
   * opening/reading the Files tab must NOT set this — browsing capture-served
   * trees/diffs needs no box, and warming one on a cold glance burns box-hours to
   * serve reads the capture already answers for free.
   */
  attachFiles?: boolean | undefined;
  /** Hold off negotiating (e.g. the workbench panel is collapsed). Default true. */
  enabled?: boolean | undefined;
  /** Poll cadence (ms) while the lease is cold/warming. Default 1500. */
  warmingPollMs?: number | undefined;
  /**
   * Give up waiting for `warm` after this long while polling (ms) and surface a
   * stalled error with a manual `renegotiate`. Default 30000. This is a UI
   * patience deadline, independent from the worker's sandbox warming timeout.
   * 0 disables the deadline.
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
   * acknowledgment before a viewer holder is granted. The workbench uses this
   * to complete acknowledgment automatically while Desktop is opening.
   */
  acknowledgmentRequired: "unredacted" | "shared" | null;
  /** 429 from the desktop attach: the per-session viewer cap is reached. */
  viewerCapReached: boolean;
  /** Which limit the 429 hit: `viewers` (too many live viewers) or
   * `computers` (the workspace or plan limit on computers running with no
   * task, or on running computers). Null when no limit was hit. */
  viewerCapReason: "viewers" | "computers" | null;
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

/** Events that mean a person is at the page. Captured on the window so a
 * canvas or terminal that stops propagation still counts. */
const VIEWER_INTERACTION_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/**
 * Track when the person last interacted with the page, for the viewer
 * heartbeat (`lastInteractionAgeMs`). Page load, pointer, keyboard, wheel,
 * touch, window focus and the page becoming visible all count. `onInteraction`
 * runs after each recorded interaction.
 */
function useViewerInteractionClock(onInteraction: () => void): {
  current: number;
} {
  const lastInteractionRef = useRef(Date.now());
  const onInteractionRef = useRef(onInteraction);
  onInteractionRef.current = onInteraction;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const record = () => {
      lastInteractionRef.current = Date.now();
      onInteractionRef.current();
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") record();
    };
    const listenerOptions = { capture: true, passive: true } as const;
    for (const type of VIEWER_INTERACTION_EVENTS) {
      window.addEventListener(type, record, listenerOptions);
    }
    window.addEventListener("focus", record, listenerOptions);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      for (const type of VIEWER_INTERACTION_EVENTS) {
        window.removeEventListener(type, record, listenerOptions);
      }
      window.removeEventListener("focus", record, listenerOptions);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, []);
  return lastInteractionRef;
}

/**
 * Whether warming the box for the interactive terminal (pty-ws) is worth it.
 * A real-PTY descriptor is attachable when already routed as `pty-ws`, or while
 * transiently cold. A firehose-only backend and policy/OS/backend degradation
 * cannot become interactive, so attaching there would only waste a holder.
 */
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
 * reason-aware empty state. 409 (acknowledgment) and 429 (viewer cap) are
 * surfaced as typed signals, not thrown.
 */
export function useSessionCapabilities(
  sessionId: string | null | undefined,
  options: UseSessionCapabilitiesOptions = {},
): UseSessionCapabilitiesResult {
  const { client, workspaceId } = useOpenGeni(options);
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const pageLive = usePageLiveActivity();
  const lifecycleEnabled = enabled && pageLive;
  const attachDesktop = options.attachDesktop ?? false;
  const attachTerminal = options.attachTerminal ?? false;
  const attachFiles = options.attachFiles ?? false;
  const warmingPollMs = options.warmingPollMs ?? 1500;
  const warmingDeadlineMs = options.warmingDeadlineMs ?? 30_000;
  const identityKey = `${workspaceId}\u0000${sessionId ?? ""}\u0000${enabled}`;

  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [state, setState] = useState<SessionCapabilitiesState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [acknowledgmentRequired, setAcknowledgmentRequired] = useState<
    "unredacted" | "shared" | null
  >(null);
  const [viewerCapReached, setViewerCapReached] = useState(false);
  const [viewerCapReason, setViewerCapReason] = useState<"viewers" | "computers" | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [stateIdentity, setStateIdentity] = useState(identityKey);
  // Bumped to force a fresh negotiation cycle.
  const [nonce, setNonce] = useState(0);

  // The epoch the client has settled on — used to fence stale rotations folded
  // from the event log, and echoed on heartbeats.
  const epochRef = useRef(0);
  const viewerIdRef = useRef<string | null>(null);
  const previousIdentityRef = useRef(identityKey);

  const renegotiate = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  // Set when the server released this page's viewer while the person was away
  // (the idle drain): the box is re-acquired on their next interaction rather
  // than re-warmed at once for an empty room.
  const resumeOnInteractionRef = useRef(false);
  const lastInteractionRef = useViewerInteractionClock(() => {
    if (!resumeOnInteractionRef.current) return;
    resumeOnInteractionRef.current = false;
    setNonce((n) => n + 1);
  });

  // ── Negotiation + viewer lifecycle ──────────────────────────────────────────
  useEffect(() => {
    const identityChanged = previousIdentityRef.current !== identityKey;
    previousIdentityRef.current = identityKey;
    if (identityChanged) {
      setStateIdentity(identityKey);
      setCapabilities(null);
      setState("idle");
      setError(null);
      setAcknowledgmentRequired(null);
      setViewerCapReached(false);
      setViewerCapReason(null);
      setViewerId(null);
      epochRef.current = 0;
      viewerIdRef.current = null;
      resumeOnInteractionRef.current = false;
    }
    if (!lifecycleEnabled || !sessionId) {
      setState("idle");
      setCapabilities(null);
      viewerIdRef.current = null;
      setViewerId(null);
      return;
    }
    // The preceding effect cleanup released any old holder before this fresh
    // lifecycle starts. Never project that stale id while re-negotiating or if
    // the replacement grant degrades.
    viewerIdRef.current = null;
    setViewerId(null);
    // Still set when the server released this page's viewer while the person
    // was away and they have not come back: this negotiation (an outside
    // re-check) reads capabilities but must not re-attach and re-warm the box.
    // Their next interaction clears it and re-negotiates with an attach.
    const awaitingInteraction = resumeOnInteractionRef.current;
    let cancelled = false;
    // The server's viewer idle window from the attach (null: off or unknown).
    let idleDrainMs: number | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let localViewerId: string | null = null;
    const requestAbort = new AbortController();
    const startedAt = Date.now();

    const clearTimers = () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
      pollTimer = null;
      heartbeatTimer = null;
    };

    const settle = (caps: SessionCapabilities) => {
      if (cancelled) return;
      epochRef.current = caps.leaseEpoch;
      setCapabilities(caps);
      setError(null);
    };

    // The holder is gone (reaped, idle-released or fenced by a new epoch).
    // When the person has been away at least the server's idle window, the
    // server released it on purpose: stop beating and re-attach on their next
    // interaction. Otherwise re-negotiate now.
    const reacquire = () => {
      if (cancelled) return;
      if (idleDrainMs !== null && Date.now() - lastInteractionRef.current >= idleDrainMs) {
        localViewerId = null;
        viewerIdRef.current = null;
        setViewerId(null);
        setState("on-demand");
        resumeOnInteractionRef.current = true;
        return;
      }
      renegotiate();
    };

    const startHeartbeat = (caps: SessionCapabilities) => {
      if (!localViewerId || heartbeatTimer !== null) return;
      const intervalMs =
        caps.viewerHeartbeatIntervalMs > 0 ? caps.viewerHeartbeatIntervalMs : 30_000;
      const schedule = () => {
        if (cancelled || !localViewerId) return;
        heartbeatTimer = setTimeout(() => {
          heartbeatTimer = null;
          if (cancelled || !localViewerId) return;
          void client
            .heartbeatViewer(workspaceId, sessionId, localViewerId, {
              leaseEpoch: epochRef.current,
              lastInteractionAgeMs: Math.max(0, Date.now() - lastInteractionRef.current),
            })
            .then((res) => {
              // alive:false ⇒ the holder was reaped or the epoch moved under us;
              // re-negotiate to re-acquire against the new owner.
              if (!res.alive && !cancelled) {
                reacquire();
              }
            })
            .catch((cause) => {
              if (cancelled) return;
              if (
                cause instanceof OpenGeniApiError &&
                (cause.status === 409 || cause.status === 410)
              ) {
                reacquire();
              }
            })
            .finally(schedule);
        }, intervalMs);
      };
      schedule();
    };

    const pollUntilWarm = () => {
      pollTimer = setTimeout(() => {
        if (cancelled) return;
        void client
          .getStreamCapabilities(workspaceId, sessionId, { signal: requestAbort.signal })
          .then((caps) => {
            if (cancelled) return;
            settle(caps);
            if (sandboxAcceptsLiveIo(caps.liveness)) {
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
              if (isSandboxOwnershipDisabledError(cause)) {
                setState("on-demand");
                setError(null);
                return;
              }
              setState("error");
              setError(normalizeError(cause));
            }
          });
      }, warmingPollMs);
    };

    void (async () => {
      setState("negotiating");
      setAcknowledgmentRequired(null);
      setViewerCapReached(false);
      setViewerCapReason(null);
      try {
        const caps = await client.getStreamCapabilities(workspaceId, sessionId, {
          signal: requestAbort.signal,
        });
        if (cancelled) return;
        settle(caps);

        // Optional viewer attach: acquire a viewer holder (warms a cold box). ONE
        // attach serves BOTH live planes — the desktop pixel stream AND the
        // interactive terminal (ttyd pty-ws) ride the same warm box and the same
        // holder; the response folds the minted address for each requested plane.
        // The acknowledgment requirement (409) and viewer cap (429) surface as
        // typed signals rather than throwing — the tabs degrade gracefully.
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
        const wantTerminalAttach = attachTerminal && terminalCanAcquirePty(caps.Terminal);
        // The Files attach warms the box for a file WRITE (wake-on-edit intent). It
        // folds no live URL (files are stateless HTTP) — the attach is purely a
        // liveness refcount. Unlike the previous "keep the box warm while the Files
        // tab is on screen" wiring, this fires on genuine EDIT intent only, so it
        // legitimately cold-CREATES: an edit is the wake, and the caller (the dock)
        // never sets it for passive browsing. Gate solely on the FileSystem cap
        // being advertised; liveness (cold included) does not suppress it — POST
        // /viewers warms a cold box exactly as it does for a desktop/terminal engage.
        const wantFilesAttach = attachFiles && caps.FileSystem.available;
        // Set when the server refused the attach for a bound on boxes kept warm
        // only for viewers (429): the session stays usable without a live box,
        // so do not poll for a warm-up that will not come.
        let attachRefused = false;
        if (!awaitingInteraction && (wantDesktopAttach || wantTerminalAttach || wantFilesAttach)) {
          try {
            // Declare WHICH plane we're attaching for. `desktop:true` opts into the
            // un-redacted pixel plane (which carries the consent gate); a
            // terminal-only attach (`desktop:false`) warms the box + mints the
            // pty-ws terminal cell WITHOUT tripping the desktop consent 409.
            const holder = await client.attachViewer(workspaceId, sessionId, {
              desktop: wantDesktopAttach,
              terminal: wantTerminalAttach,
              files: wantFilesAttach,
              lastInteractionAgeMs: Math.max(0, Date.now() - lastInteractionRef.current),
            });
            if (cancelled) {
              // The attach crossed an identity/unmount boundary after the server
              // had already minted a holder. It is too late to publish the result,
              // but abandoning it would keep the old sandbox warm until the
              // reaper runs. Release that exact old-session holder immediately.
              void client.detachViewer(workspaceId, sessionId, holder.viewerId).catch(() => {});
              return;
            }
            if (
              (wantDesktopAttach &&
                (!holder.dataPlaneUrl || !holder.transport || !holder.client)) ||
              (wantTerminalAttach && (!holder.terminalUrl || !holder.terminalTransport))
            ) {
              // Nullable plane cells are valid graceful-degradation values at
              // the raw API boundary, but an explicit UI grant must not become
              // a successful holder that waits forever. Release it and surface
              // a retryable error instead of retaining stale credentials.
              await client.detachViewer(workspaceId, sessionId, holder.viewerId).catch(() => {});
              throw new Error("live plane unavailable");
            }
            localViewerId = holder.viewerId;
            viewerIdRef.current = holder.viewerId;
            idleDrainMs =
              typeof holder.viewerIdleDrainMs === "number" && holder.viewerIdleDrainMs > 0
                ? holder.viewerIdleDrainMs
                : null;
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
                          url: holder.dataPlaneUrl,
                          token: holder.streamToken,
                          expiresAt: holder.streamExpiresAt,
                          resolution: holder.resolution ?? prev.DesktopStream.resolution,
                        }
                      : prev.DesktopStream,
                    Terminal: wantTerminalAttach
                      ? {
                          ...prev.Terminal,
                          transport: holder.terminalTransport ?? prev.Terminal.transport,
                          url: holder.terminalUrl,
                          token: holder.terminalToken,
                          expiresAt: holder.terminalExpiresAt,
                          // A live pty-ws means the box is pty-capable for real.
                          ptyCapable: holder.terminalTransport ? true : prev.Terminal.ptyCapable,
                          reason: holder.terminalTransport ? null : prev.Terminal.reason,
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
                // terminal-only warm attach needs no acknowledgment, so a 409 there
                // is not a desktop-open signal — the terminal stays on the read-only
                // firehose. Only raise the consent requirement when the desktop was
                // the (or a) reason we attached.
                if (wantDesktopAttach) {
                  setAcknowledgmentRequired(
                    cause.message.includes("shared_acknowledgment") ? "shared" : "unredacted",
                  );
                }
              } else if (cause.status === 429) {
                if (cause.message.includes("went unused")) {
                  // The box was stopped while nobody used the page: wait for
                  // the person to interact, then attach again.
                  attachRefused = true;
                  resumeOnInteractionRef.current = true;
                } else {
                  setViewerCapReached(true);
                  // A limit on computers (running with no task, or running
                  // at all) under the workspace or plan: nothing will warm
                  // this box for us, so rest on-demand instead of polling
                  // toward a warm-up. Other limits keep polling, as another
                  // holder may warm it.
                  const computers = cause.message.includes("computers");
                  setViewerCapReason(computers ? "computers" : "viewers");
                  if (computers) attachRefused = true;
                }
              } else if (cause.status === 403) {
                setState("error");
                setError(cause);
                return;
              } else {
                throw cause;
              }
              // 409/429 are recoverable: structured surfaces still negotiated;
              // keep going to set ready/cold below.
            } else {
              throw cause;
            }
          }
        }

        // Whether ANYTHING asked to warm a box this negotiation. Only then is a
        // non-warm lease "warming in flight" — worth polling, and worth surfacing a
        // stall as an error. With no warm-up requested a cold lease is the benign
        // boxless resting state (below), never an error.
        const warmUpRequested =
          !awaitingInteraction &&
          !attachRefused &&
          (wantDesktopAttach || wantTerminalAttach || wantFilesAttach);
        if (sandboxAcceptsLiveIo(caps.liveness) || localViewerId) {
          setState("ready");
          startHeartbeat(caps);
        } else if (warmUpRequested) {
          // A warm-up is genuinely in flight (a viewer attach was requested) but the
          // box isn't holder-confirmed warm yet — poll until it is, with the deadline so a
          // real stall surfaces as an error.
          setState("cold");
          pollUntilWarm();
        } else {
          // Boxless and nobody asked for a box: rest in the benign on-demand state.
          // NO poll, NO deadline, NO false "sandbox offline". The box is created on
          // demand when the agent first runs a sandbox tool; the workbench watches
          // for `sandbox.provision` and renegotiates to pick the warm box back up.
          setState("on-demand");
        }
      } catch (cause) {
        if (cancelled) return;
        if (isSandboxOwnershipDisabledError(cause)) {
          setState("on-demand");
          setError(null);
          return;
        }
        if (cause instanceof OpenGeniApiError && cause.status === 403) {
          setState("error");
          setError(new Error("not permitted to view this session's sandbox"));
          return;
        }
        setState("error");
        setError(normalizeError(cause));
      }
    })();

    return () => {
      cancelled = true;
      requestAbort.abort();
      clearTimers();
      // Fire-and-forget detach (idempotent delete-my-row). Capture the id so a
      // re-render/unmount race still releases the right holder.
      const releaseId = localViewerId ?? viewerIdRef.current;
      if (releaseId) {
        void client.detachViewer(workspaceId, sessionId, releaseId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    client,
    workspaceId,
    sessionId,
    lifecycleEnabled,
    attachDesktop,
    attachTerminal,
    attachFiles,
    warmingPollMs,
    warmingDeadlineMs,
    nonce,
    identityKey,
  ]);

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

  const identityMatches = enabled && stateIdentity === identityKey;
  return {
    capabilities: identityMatches ? capabilities : null,
    state: identityMatches ? state : "idle",
    error: identityMatches ? error : null,
    acknowledgmentRequired: identityMatches ? acknowledgmentRequired : null,
    viewerCapReached: identityMatches && viewerCapReached,
    viewerCapReason: identityMatches && viewerCapReached ? viewerCapReason : null,
    viewerId: identityMatches ? viewerId : null,
    renegotiate,
  };
}

function isSandboxOwnershipDisabledError(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status === 404 &&
    error.message.includes("sandbox ownership is not enabled")
  );
}
