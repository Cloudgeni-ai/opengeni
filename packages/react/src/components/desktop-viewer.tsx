import type { CapabilityUnavailableReason, DesktopRfbFactory, DesktopStreamCapability } from "@opengeni/sdk";
import { LoaderCircleIcon, MonitorIcon, MousePointerClickIcon, WifiOffIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useDesktopStream } from "../hooks/use-desktop-stream";

export type DesktopViewerProps = {
  /** The desktop cell of the negotiated capabilities (`capabilities.DesktopStream`). */
  capability: DesktopStreamCapability | null;
  /**
   * Initial control mode. Default false (watch). When the user flips
   * "Take control" the viewer drives input — but only if `capability.mode`
   * permits it (server-gated; a read-only deployment disables the toggle).
   * Pass a value to control it externally; omit to let the viewer own the state.
   */
  interactive?: boolean | undefined;
  /** Render the built-in Watching ⇄ Take control toggle (default true). */
  showControlToggle?: boolean | undefined;
  scaleViewport?: boolean | undefined;
  /** Custom RFB factory (tests / a WebRTC swap). Defaults to lazy @novnc/novnc. */
  rfbFactory?: DesktopRfbFactory | undefined;
  /**
   * Consent gate for the un-redacted (and possibly shared) pixel plane. Rendered
   * BEFORE connecting whenever the desktop requires acknowledgment that hasn't
   * been given. Call `onAccept` to record consent (the host wires it to
   * `client.acknowledgeStream` + a re-negotiate). When omitted, a default
   * banner is shown.
   */
  renderConsentGate?: ((onAccept: () => void, shared: boolean) => ReactNode) | undefined;
  /** Called when the default consent gate's accept button is pressed. */
  onAcknowledge?: (() => void) | undefined;
  /**
   * Whether the host has the viewer attach engaged (i.e. the user has opted into
   * watching — the parent's `watchDesktop`/`attachDesktop`). Drives the
   * cold-state behaviour: when watching, a cold-but-warmable lease AUTO-WARMS
   * (and re-warms when the box drains) instead of dead-ending. When omitted we
   * infer it from a recorded consent (the default gate's accept), so the
   * component still self-heals after the first acknowledgment.
   */
  watching?: boolean | undefined;
  /**
   * Request a (re)warm of the sandbox WITHOUT re-acknowledging (the consent has
   * already been recorded — only the box drained). The host wires this to
   * "engage the viewer attach + re-negotiate". Called automatically when a
   * watched desktop is found cold-but-warmable, and behind the manual retry on
   * the warming notice. Distinct from `onAcknowledge`, which is the FIRST,
   * consent-bearing warm.
   */
  onWarm?: (() => void) | undefined;
  /** Shown when transport is null (headless backend / degraded / disabled). */
  renderUnavailable?: ((reason: CapabilityUnavailableReason | null) => ReactNode) | undefined;
  /** Shown while the box is cold/warming (no live address yet). */
  renderWarming?: (() => ReactNode) | undefined;
  /** Shown when the per-session viewer cap (429) was hit. */
  renderViewerCap?: (() => ReactNode) | undefined;
  /** Surface the 429 cap state from `useSessionCapabilities().viewerCapReached`. */
  viewerCapReached?: boolean | undefined;
  /**
   * Connect watchdog (ms): if a live url is present but the RFB hasn't connected
   * within this window, surface a "Couldn't connect" + Reconnect instead of an
   * eternal idle scrim. Default 13000. 0 disables the watchdog.
   */
  connectTimeoutMs?: number | undefined;
  className?: string | undefined;
};

/**
 * The derived desktop surface state. A single source of truth so the overlay,
 * the scrim, the auto-warm effect, and the watchdog all agree. Priority order
 * (highest first): viewer-cap → unavailable → consent → warming → connect-failed
 * → error → connecting → connected.
 */
type DesktopUiState =
  | "viewer_cap" // 429 — the per-session live-viewer limit is reached.
  | "unavailable" // genuinely unsupported (headless/policy/os/backend/not-provisioned).
  | "consent" // un-redacted/shared plane needs acknowledgment first.
  | "warming" // cold-but-warmable: box not running yet (we auto-warm + spin).
  | "connecting" // url is live, RFB negotiating/handshaking (we spin, with a watchdog).
  | "connect_failed" // watchdog fired: url present but never connected.
  | "error" // RFB error / securityfailure after a connect.
  | "connected"; // live framebuffer painting.

/** Reasons that are genuinely-unavailable (never warmable from the viewer). A
 *  `lease_cold` is deliberately EXCLUDED — that's the warmable cold state. */
function isHardUnavailable(reason: CapabilityUnavailableReason | null): boolean {
  switch (reason) {
    case "backend_unsupported":
    case "os_unsupported":
    case "not_provisioned":
    case "disabled_by_policy":
    case "tier_headless":
      return true;
    default:
      // null or "lease_cold" → not a hard reason (cold-but-warmable / live).
      return false;
  }
}

/**
 * The desktop surface: a noVNC client connecting to the Channel-B scoped tunnel
 * URL from the capability doc. Owns the mount `<div ref>`, drives
 * `useDesktopStream` (SSR-safe lazy RFB), and renders a real
 * cold → warming → connecting → connected → error state machine with live
 * feedback (spinners, transitions) — never a dead black box with stale text.
 *
 * The read-only vs interactive decision is enforced server-first
 * (`capability.mode`): when the deployment advertises mode "interactive" the
 * viewer can TAKE CONTROL and drive the mouse & keyboard into the box's :0; a
 * "read-only" deployment disables the take-control affordance (graceful, with a
 * reason).
 *
 * Warming: a cold-but-warmable lease (`reason: "lease_cold"`) is NOT a dead end.
 * When the user is watching (consented), the viewer asks the host to (re)warm
 * the box (`onWarm`) and shows a "Warming…" spinner; if the box later drains to
 * cold it re-warms. Genuinely-unavailable surfaces (headless/policy/os/backend)
 * keep a clear, static unavailable notice.
 */
export function DesktopViewer({
  capability,
  interactive,
  showControlToggle = true,
  scaleViewport,
  rfbFactory,
  renderConsentGate,
  onAcknowledge,
  watching,
  onWarm,
  renderUnavailable,
  renderWarming,
  renderViewerCap,
  viewerCapReached,
  connectTimeoutMs = 13_000,
  className,
}: DesktopViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [consented, setConsented] = useState(false);
  // Local control state when not externally controlled. The server gate
  // (`capability.mode`) is the hard ceiling — a read-only deployment can never
  // be flipped to interactive regardless of this toggle.
  const [takeControl, setTakeControl] = useState(interactive ?? false);
  const externallyControlled = interactive !== undefined;
  const serverAllowsControl = capability?.mode !== "read-only";
  const wantControl = externallyControlled ? interactive : takeControl;
  const inControl = Boolean(wantControl) && serverAllowsControl;

  // Whether the host has the viewer attach engaged. Prefer the explicit prop;
  // fall back to a locally-recorded consent so the component still self-heals
  // (auto-warms / re-warms) once the user has accepted the gate at least once.
  const isWatching = watching ?? consented;

  // ── Decide the rendered state (before touching the stream hook) ─────────────
  const transportNull = !capability || capability.transport === null;
  const reason = capability?.reason ?? null;
  const needsAck =
    capability?.requiresAcknowledgment === true && capability.acknowledged !== true && !consented;
  // No live address yet on an otherwise-live transport (post-ack, mid-warm).
  const noLiveAddress = Boolean(capability) && !transportNull && !capability!.url;

  // Cold-but-warmable: the lease is cold (`lease_cold`) OR the transport is up
  // but no url has been minted yet — either way warming, not unavailable.
  const coldWarmable =
    (transportNull && reason === "lease_cold") || (!transportNull && noLiveAddress);
  // Genuinely-unavailable: transport null for a HARD reason (not lease_cold).
  const hardUnavailable = transportNull && isHardUnavailable(reason);

  const accept = () => {
    setConsented(true);
    onAcknowledge?.();
  };

  // Release control WITHOUT ever swallowing a key the desktop needs. Esc, and
  // every other key, pass straight through to noVNC/:0 — vital for vim, menus,
  // and dialogs inside the box. Exactly ONE non-trapping keyboard exit:
  //   • A single non-conflicting chord — Ctrl+Alt+Shift pressed on its own (no
  //     other key) — which no app binds, so it never eats a real keystroke.
  //  (Plus the always-visible "Return control" button in the in-control bar.)
  //
  // We deliberately DO NOT release on pointer-leave (or window blur): those fire
  // as a SIDE EFFECT of connecting — the noVNC canvas re-laying-out, the surface
  // grabbing focus, the connecting scrim swapping in — which bounced control
  // straight back to "watch" the instant the user took it. Control is given up
  // only on an explicit, intentional gesture (the button or the chord).
  useEffect(() => {
    if (!inControl || externallyControlled) return;
    const onKey = (event: KeyboardEvent) => {
      // Only the bare modifier chord releases; if any non-modifier key is also
      // down (event.key is a real key like "a"/"Escape"), let it pass through.
      if (
        event.ctrlKey &&
        event.altKey &&
        event.shiftKey &&
        (event.key === "Control" || event.key === "Alt" || event.key === "Shift")
      ) {
        event.preventDefault();
        setTakeControl(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [inControl, externallyControlled]);

  // The hook is always called (rules of hooks); it stays idle until `url` is set.
  // Do NOT open a socket while the viewer-cap (429) notice is showing — the slot
  // is already exhausted, so connecting would only burn a doomed attempt (and in
  // tests leak an unhandled ws error from the never-resolving tunnel URL).
  const connectCapability =
    !transportNull && !needsAck && !viewerCapReached ? capability : null;
  const stream = useDesktopStream({
    capability: connectCapability,
    containerRef,
    interactive: inControl,
    ...(scaleViewport !== undefined ? { scaleViewport } : {}),
    ...(rfbFactory ? { rfbFactory } : {}),
  });

  const connected = stream.state === "connected";
  const hasLiveUrl = Boolean(connectCapability?.url);
  // The latest stream state, read without making it an effect dependency — so the
  // re-attach below can consult it on a visibility change WITHOUT re-subscribing
  // (and re-firing) every time the state walks idle→negotiating→connected.
  const streamStateRef = useRef(stream.state);
  streamStateRef.current = stream.state;

  // ── AUTO-WARM ───────────────────────────────────────────────────────────────
  // When the user is watching and the desktop is cold-but-warmable, ask the host
  // to (re)warm the box. This covers BOTH (a) the user just accepted consent and
  // (b) a previously-warm box that drained back to cold under a live viewer. We
  // fire once per distinct cold episode (keyed on the lease epoch + url) so we
  // don't spam the attach while a single warm is in flight. `onWarm` is the
  // no-re-ack path; if the host only wired `onAcknowledge` (no `onWarm`), the
  // first warm still rides consent and subsequent drains fall back to it.
  const warmKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isWatching || !coldWarmable || needsAck || viewerCapReached) {
      // Reset the de-dupe once we leave the cold episode so a future drain warms.
      if (!coldWarmable) warmKeyRef.current = null;
      return;
    }
    const warm = onWarm ?? onAcknowledge;
    if (!warm) return;
    // Key the de-dupe on the cell fields available to the viewer: while cold,
    // `reason`/`url`/`expiresAt` are stable, so we warm exactly once; once the box
    // warms the cell changes (url+expiresAt minted) and `coldWarmable` flips false,
    // resetting the ref so a later drain re-warms.
    const key = `${capability?.reason ?? ""}:${capability?.url ?? ""}:${capability?.expiresAt ?? ""}`;
    if (warmKeyRef.current === key) return; // already kicked this episode.
    warmKeyRef.current = key;
    warm();
    // capability identity is the trigger; leaseEpoch/expiresAt key the episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWatching, coldWarmable, needsAck, viewerCapReached, capability, onWarm, onAcknowledge]);

  // ── TAB RE-ATTACH ───────────────────────────────────────────────────────────
  // The "stuck Watching, never connects" bug: the RFB socket never (re)fires when
  // the Desktop tab is shown without a refresh. When a live url exists but we are
  // not connected/connecting, nudge the stream hook to (re)attach — on mount, on
  // the document becoming visible, and on a fresh capability. Re-attach is cheap
  // (disconnect-old/connect-new) and idempotent: the hook ignores it once live.
  useEffect(() => {
    if (!hasLiveUrl || typeof document === "undefined") return;
    const maybeReattach = () => {
      if (document.visibilityState !== "visible") return;
      // Only kick a socket that never OPENED (idle — e.g. the tab was hidden when
      // the url arrived, so the connect effect bailed on a missing container).
      // Deliberately NOT on "error": that surfaces an overlay with an explicit
      // Reconnect, and auto-retrying here would hammer (reconnect → error →
      // reconnect…). We read the live state via a ref so this effect does NOT
      // depend on `stream.state` — depending on it re-ran the effect on every
      // transition and re-fired the kick, which is the reconnect loop.
      if (streamStateRef.current === "idle") stream.reconnect();
    };
    // The connect effect already opens the socket on mount / a fresh url. The
    // ONLY gap it can't self-heal is a tab that was hidden when the url arrived
    // (container not in the DOM → connect effect bailed to idle): the socket then
    // never (re)fires on its own. So we revive it on the tab becoming visible —
    // NOT on mount (that double-opens the socket the connect effect just opened).
    document.addEventListener("visibilitychange", maybeReattach);
    return () => document.removeEventListener("visibilitychange", maybeReattach);
    // Re-run ONLY on a fresh live url, never on a state transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLiveUrl, connectCapability?.url]);

  // ── CONNECT WATCHDOG ─────────────────────────────────────────────────────────
  // If a live url is present but the RFB hasn't reached "connected" within the
  // window, stop spinning forever and surface "Couldn't connect" + Reconnect.
  // Cleared whenever we connect, the url rotates, or the user reconnects.
  const [connectTimedOut, setConnectTimedOut] = useState(false);
  // Bumped on every manual reconnect so the watchdog re-arms its window (the
  // stream hook's url/error don't change on a reconnect, so we need our own key).
  const [reconnectNonce, setReconnectNonce] = useState(0);
  useEffect(() => {
    // Re-arm on a fresh url / a reconnect and clear the moment we connect or hit a
    // real RFB error. We deliberately do NOT key on `stream.state`, so the benign
    // idle→connecting walk doesn't keep resetting the window — the full timeout
    // runs from the url becoming live.
    setConnectTimedOut(false);
    if (!hasLiveUrl || connected || stream.error || connectTimeoutMs <= 0) return;
    const timer = setTimeout(() => setConnectTimedOut(true), connectTimeoutMs);
    return () => clearTimeout(timer);
  }, [hasLiveUrl, connected, connectTimeoutMs, connectCapability?.url, stream.error, reconnectNonce]);

  const reconnect = () => {
    setConnectTimedOut(false);
    setReconnectNonce((n) => n + 1);
    stream.reconnect();
  };

  // ── Resolve the single UI state (priority order) ────────────────────────────
  let uiState: DesktopUiState;
  if (viewerCapReached) uiState = "viewer_cap";
  else if (hardUnavailable) uiState = "unavailable";
  else if (needsAck && !isWatching) uiState = "consent";
  else if (coldWarmable) uiState = "warming";
  else if (connected) uiState = "connected";
  else if (stream.error) uiState = "error";
  else if (connectTimedOut) uiState = "connect_failed";
  else uiState = "connecting"; // hasLiveUrl && not yet connected (idle/negotiating/connecting).

  // An overlay blocks the surface for every state except connected; the toggle
  // and the live scrim are suppressed under an overlay.
  const overlayShown = uiState !== "connected" && uiState !== "connecting";
  const showToggle = showControlToggle && !overlayShown;

  let overlay: ReactNode = null;
  switch (uiState) {
    case "viewer_cap":
      overlay =
        renderViewerCap?.() ??
        defaultNotice("Too many viewers", "This session has reached its live-viewer limit. Try again shortly.");
      break;
    case "unavailable":
      overlay =
        renderUnavailable?.(reason) ?? defaultNotice("Desktop unavailable", unavailableCopy(reason));
      break;
    case "consent":
      overlay = renderConsentGate ? (
        renderConsentGate(accept, capability?.shared ?? false)
      ) : (
        <DefaultConsentGate shared={capability?.shared ?? false} onAccept={accept} />
      );
      break;
    case "warming":
      overlay = renderWarming?.() ?? <WarmingNotice />;
      break;
    case "connect_failed":
      overlay = defaultNotice(
        "Couldn’t connect",
        "The desktop is warm but the live stream didn’t come up. This usually clears on a retry.",
        reconnect,
      );
      break;
    case "error":
      overlay = defaultNotice("Desktop disconnected", stream.error?.message ?? "The stream dropped.", reconnect);
      break;
    case "connecting":
    case "connected":
      overlay = null;
      break;
  }

  return (
    <div
      className={cn(
        "relative h-full w-full overflow-hidden bg-black",
        inControl &&
          "ring-2 ring-inset ring-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]",
        className,
      )}
      data-opengeni-desktop
      data-state={stream.state}
      data-ui-state={uiState}
      data-in-control={inControl ? "true" : undefined}
    >
      {/* noVNC mount target. It appends a `width:100%;height:100%` `_screen` div
          and AUTOSCALES the 1280x800 framebuffer to fit THIS box. We pin it to
          the bounded `relative` wrapper with `absolute inset-0` (not just
          `h-full w-full`) so its measured size is ALWAYS the panel — never the
          canvas content. A content-sized mount is exactly what makes noVNC
          measure a huge screen and paint the desktop "zoomed in". `overflow-hidden`
          keeps the centered (margin:auto) canvas from ever spilling the panel. */}
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        data-opengeni-desktop-canvas
        data-state={stream.state}
      />

      {/* Idle / connecting scrim: a quiet, ALIVE "connecting to the desktop"
          state behind the canvas so the surface never reads as a dead black
          rectangle before the first framebuffer paints. Only shown in the
          `connecting` UI-state (every other non-connected state has an explicit
          overlay). A spinner + transitional copy makes it feel live. */}
      {uiState === "connecting" && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
          <span className="relative flex items-center justify-center">
            <MonitorIcon className="size-8 opacity-30" strokeWidth={1.5} />
            <LoaderCircleIcon
              className="absolute size-12 animate-og-spin text-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] opacity-70"
              strokeWidth={1.25}
            />
          </span>
          <span className="text-xs">Connecting to the desktop…</span>
        </div>
      )}

      {/* Take-control affordance. Two distinct states:
            - WATCHING  → a prominent, centered call-to-action button overlaid on
              the desktop (the primary CTA; tasteful so the screen stays visible).
            - IN CONTROL → a small top bar ("You're in control · click Return
              control (or Ctrl+Alt+Shift)") with a clearly-visible Return-control
              button; the desktop stays fully usable and EVERY key — Esc included —
              passes through to the box. Server-gated: when the deployment is
              read-only the CTA renders disabled with a reason so it degrades
              gracefully. */}
      {showToggle && !externallyControlled && inControl && (
        <InControlBar
          shared={capability?.shared ?? false}
          onRelease={() => setTakeControl(false)}
        />
      )}
      {/* The big CTA only appears once the framebuffer is live + the viewer is
          watching: before connect the scrim already communicates state, so we
          don't double up. A read-only deployment (serverAllowsControl=false) still
          surfaces the CTA disabled-with-reason once connected, so it degrades
          gracefully and stays discoverable. */}
      {showToggle && !externallyControlled && !inControl && connected && (
        <TakeControlCallToAction
          disabled={!serverAllowsControl}
          disabledReason={
            !serverAllowsControl ? "This deployment streams the desktop read-only" : undefined
          }
          onTakeControl={() => setTakeControl(true)}
        />
      )}

      {overlay && (
        <div className="absolute inset-0 flex items-center justify-center p-4">{overlay}</div>
      )}
    </div>
  );
}

/**
 * The primary WATCHING-state call-to-action: a large, centered pill button
 * overlaid on the desktop inviting the viewer to drive the mouse & keyboard.
 * Tasteful by default — it sits in the LOWER-center with a soft scrim only behind
 * the button (not the whole screen) and lifts on hover, so a watcher can still see
 * the agent work. Server-gated: when the deployment is read-only (or the desktop
 * hasn't connected yet) it renders disabled with a reason. Accessible: a real
 * <button> with a title, focus ring, and Enter/Space activation.
 */
function TakeControlCallToAction({
  disabled,
  disabledReason,
  onTakeControl,
}: {
  disabled: boolean;
  disabledReason?: string | undefined;
  onTakeControl: () => void;
}) {
  return (
    // The wrapper spans the surface but is click-through (pointer-events-none); only
    // the button itself is interactive, so watchers can still see the desktop.
    <div className="pointer-events-none absolute inset-0 flex items-end justify-center pb-[8%]">
      <button
        type="button"
        disabled={disabled}
        aria-label="Take control of the desktop"
        title={disabled ? disabledReason : "Take control of the desktop"}
        onClick={onTakeControl}
        className={cn(
          "group pointer-events-auto flex items-center gap-3 rounded-[var(--og-radius-lg,12px)] border px-5 py-3",
          "border-[color:var(--og-color-border,var(--color-border,#2a2a2a))]",
          "bg-[color:var(--og-color-bg,#0d0d0d)]/85 backdrop-blur-md",
          "shadow-[var(--og-shadow-lg,0_10px_30px_-10px_rgba(0,0,0,0.6))]",
          "outline-none transition-all duration-150 ease-out",
          "focus-visible:ring-2 focus-visible:ring-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] focus-visible:ring-offset-2 focus-visible:ring-offset-black",
          disabled
            ? "cursor-not-allowed opacity-60"
            : cn(
                "cursor-pointer opacity-90 hover:-translate-y-0.5 hover:opacity-100",
                "hover:border-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]",
                "hover:bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]/10",
              ),
        )}
      >
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
            "bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]",
            "text-[color:var(--og-color-accent-fg,#fff)]",
            disabled ? "" : "group-hover:scale-105",
          )}
        >
          <MousePointerClickIcon className="size-5" strokeWidth={2} />
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-sm font-semibold text-[color:var(--og-color-fg,#e6e6e6)]">
            Take control
          </span>
          <span className="text-[11px] text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
            {disabled && disabledReason ? disabledReason : "Drive the mouse & keyboard"}
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * The IN-CONTROL state: a small top bar so the desktop stays fully usable while
 * driving (the accent ring around the viewport carries the primary "you're
 * driving" signal). Every keystroke — including Esc — passes through to the box,
 * so release lives only on explicit, non-trapping affordances: a clearly-visible
 * "Return control" button and the Ctrl+Alt+Shift chord. The button is solid
 * (not a faint ghost) so it's always discoverable as the way out.
 */
function InControlBar({ shared, onRelease }: { shared: boolean; onRelease: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
      <span className="pointer-events-auto inline-flex items-center gap-2 rounded-[var(--og-radius-sm,4px)] bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] px-2.5 py-1 text-[11px] font-medium text-[color:var(--og-color-accent-fg,#fff)] shadow-[var(--og-shadow-md)]">
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
        You&apos;re in control
        <span className="opacity-75">· click Return control (or Ctrl+Alt+Shift)</span>
      </span>
      <div className="pointer-events-auto flex items-center gap-1.5">
        {shared && (
          <span className="rounded-[var(--og-radius-sm,4px)] bg-[color:var(--og-color-danger,var(--color-danger,#f85149))]/85 px-2 py-0.5 text-[10px] text-white">
            Shared box — others are watching
          </span>
        )}
        <button
          type="button"
          onClick={onRelease}
          title="Return control (or press Ctrl+Alt+Shift)"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[var(--og-radius-sm,4px)] border px-2.5 py-1 text-[11px] font-semibold shadow-[var(--og-shadow-md)] transition-colors",
            "border-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] bg-[color:var(--og-color-bg,#0d0d0d)]/90 text-[color:var(--og-color-fg,#e6e6e6)] backdrop-blur-sm",
            "outline-none hover:bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] hover:text-[color:var(--og-color-accent-fg,#fff)] focus-visible:ring-2 focus-visible:ring-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]",
          )}
        >
          <MonitorIcon className="size-3.5" strokeWidth={2} aria-hidden />
          Return control
        </button>
      </div>
    </div>
  );
}

function unavailableCopy(reason: CapabilityUnavailableReason | null): string {
  switch (reason) {
    case "backend_unsupported":
      return "This sandbox backend cannot stream a desktop.";
    case "tier_headless":
      return "This deployment is headless — terminal, files, and diff only.";
    case "os_unsupported":
      return "The sandbox OS does not support a desktop stream.";
    case "not_provisioned":
      return "No display stack is provisioned on this box yet.";
    case "disabled_by_policy":
      return "Desktop streaming is disabled on this deployment.";
    case "lease_cold":
      // Should not reach the unavailable notice (lease_cold warms), but keep
      // friendly copy as a fallback rather than the old dead-end wording.
      return "Waiting for the sandbox to start…";
    default:
      return "The desktop isn’t available for this sandbox.";
  }
}

/**
 * The WARMING state: a cold-but-warmable box that is being spun up. A spinner +
 * clear, accurate copy — and (when the host wired a manual warm) an explicit
 * retry so a slow warm never feels stuck. This is the cure for the old
 * "Desktop unavailable — Start a turn or attach to warm it" dead-end: the box IS
 * being warmed automatically; we just tell the user it's happening.
 */
function WarmingNotice({ onRetry }: { onRetry?: (() => void) | undefined }) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-[color:var(--color-border,#2a2a2a)] bg-[color:var(--color-bg,#0d0d0d)]/90 p-5 text-center text-sm text-[color:var(--color-fg,#e6e6e6)] backdrop-blur-sm">
      <LoaderCircleIcon
        className="size-7 animate-og-spin text-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]"
        strokeWidth={1.5}
      />
      <div className="space-y-1">
        <div className="font-medium">Warming the sandbox…</div>
        <p className="text-xs text-[color:var(--color-fg-subtle,#888)]">
          Spinning up the desktop — this takes a few seconds.
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-[color:var(--color-border,#2a2a2a)] px-3 py-1.5 text-xs text-[color:var(--color-fg-muted,#aaa)] transition-colors hover:text-[color:var(--color-fg,#e6e6e6)]"
        >
          Taking too long? Retry
        </button>
      )}
    </div>
  );
}

function DefaultConsentGate({ shared, onAccept }: { shared: boolean; onAccept: () => void }) {
  return (
    <div className="max-w-sm rounded-lg border border-[color:var(--color-border,#2a2a2a)] bg-[color:var(--color-bg,#0d0d0d)] p-4 text-center text-sm text-[color:var(--color-fg,#e6e6e6)]">
      <div className="mb-1 font-medium">Watch the live desktop?</div>
      <p className="mb-3 text-xs text-[color:var(--color-fg-subtle,#888)]">
        The desktop pixel stream is <strong>un-redacted</strong> — it can show secrets the agent prints
        on screen.
        {shared
          ? " This box is shared: you will also see sibling sessions' agents on the same screen."
          : ""}
      </p>
      <button
        type="button"
        onClick={onAccept}
        className="rounded bg-[color:var(--color-brand,#3b82f6)] px-3 py-1.5 text-xs font-medium text-white"
      >
        I understand — show the desktop
      </button>
    </div>
  );
}

function defaultNotice(title: string, body: string, onRetry?: () => void): ReactNode {
  return (
    <div className="max-w-sm rounded-lg border border-[color:var(--color-border,#2a2a2a)] bg-[color:var(--color-bg,#0d0d0d)] p-4 text-center text-sm text-[color:var(--color-fg,#e6e6e6)]">
      <div className="mb-1 flex items-center justify-center gap-1.5 font-medium">
        {onRetry && <WifiOffIcon className="size-4 opacity-70" strokeWidth={1.75} />}
        {title}
      </div>
      <p className="text-xs text-[color:var(--color-fg-subtle,#888)]">{body}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded border border-[color:var(--color-border,#2a2a2a)] px-3 py-1.5 text-xs transition-colors hover:border-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
