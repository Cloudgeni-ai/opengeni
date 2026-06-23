import type { CapabilityUnavailableReason, DesktopRfbFactory, DesktopStreamCapability } from "@opengeni/sdk";
import { MonitorIcon, MousePointerClickIcon } from "lucide-react";
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
  /** Shown when transport is null (headless backend / degraded). */
  renderUnavailable?: ((reason: CapabilityUnavailableReason | null) => ReactNode) | undefined;
  /** Shown while the box is cold/warming (no live address yet). */
  renderWarming?: (() => ReactNode) | undefined;
  /** Shown when the per-session viewer cap (429) was hit. */
  renderViewerCap?: (() => ReactNode) | undefined;
  /** Surface the 429 cap state from `useSessionCapabilities().viewerCapReached`. */
  viewerCapReached?: boolean | undefined;
  className?: string | undefined;
};

/**
 * The desktop surface: a noVNC client connecting to the Channel-B scoped tunnel
 * URL from the capability doc. Owns the mount `<div ref>`, drives
 * `useDesktopStream` (SSR-safe lazy RFB), and renders the
 * unavailable / warming / consent / viewer-cap / live states. The read-only vs
 * interactive decision is enforced server-first (`capability.mode`): when the
 * deployment advertises mode "interactive" the viewer can TAKE CONTROL and drive
 * the mouse & keyboard into the box's :0; a "read-only" deployment disables the
 * take-control affordance (graceful, with a reason).
 *
 * Connection is gated: the RFB only attaches once a usable `url` is present
 * (post-acknowledgment, post-warm). Before that, the consent / warming notices
 * render and no socket is opened.
 */
export function DesktopViewer({
  capability,
  interactive,
  showControlToggle = true,
  scaleViewport,
  rfbFactory,
  renderConsentGate,
  onAcknowledge,
  renderUnavailable,
  renderWarming,
  renderViewerCap,
  viewerCapReached,
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

  // Decide what to render before touching the stream hook (don't connect until
  // a usable url is present — the hook stays idle on a null/incomplete cap).
  const transportNull = !capability || capability.transport === null;
  const needsAck =
    capability?.requiresAcknowledgment === true && capability.acknowledged !== true && !consented;
  const noLiveAddress = Boolean(capability) && !transportNull && !capability!.url;

  const accept = () => {
    setConsented(true);
    onAcknowledge?.();
  };

  // Esc / blur returns control to watch so the pointer is never trapped.
  useEffect(() => {
    if (!inControl || externallyControlled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTakeControl(false);
    };
    const onBlur = () => setTakeControl(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
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
  const showToggle = showControlToggle && !transportNull && !needsAck && !noLiveAddress && !overlayBlocks();
  function overlayBlocks(): boolean {
    return Boolean(viewerCapReached) || Boolean(stream.error);
  }

  let overlay: ReactNode = null;
  if (viewerCapReached) {
    overlay =
      renderViewerCap?.() ??
      defaultNotice("Too many viewers", "This session has reached its live-viewer limit. Try again shortly.");
  } else if (transportNull) {
    overlay =
      renderUnavailable?.(capability?.reason ?? null) ??
      defaultNotice("Desktop unavailable", unavailableCopy(capability?.reason ?? null));
  } else if (needsAck) {
    overlay = renderConsentGate ? (
      renderConsentGate(accept, capability?.shared ?? false)
    ) : (
      <DefaultConsentGate shared={capability?.shared ?? false} onAccept={accept} />
    );
  } else if (noLiveAddress) {
    overlay = renderWarming?.() ?? defaultNotice("Starting desktop…", "The sandbox is warming up.");
  } else if (stream.error) {
    overlay = defaultNotice("Desktop disconnected", stream.error.message, stream.reconnect);
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
      data-in-control={inControl ? "true" : undefined}
    >
      <div
        ref={containerRef}
        className="h-full w-full"
        data-opengeni-desktop-canvas
        data-state={stream.state}
      />

      {/* Idle scrim: a quiet "connecting to the desktop" state behind the canvas
          so the surface never reads as a dead black rectangle before the first
          framebuffer paints. Suppressed once connected or when an explicit
          overlay (unavailable / consent / warming / error) is showing. */}
      {!connected && !overlay && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-[color:var(--og-color-fg-subtle,var(--color-fg-subtle,#888))]">
          <MonitorIcon className="size-8 opacity-40" strokeWidth={1.5} />
          <span className="text-xs">
            {stream.state === "connecting" ? "Connecting to the desktop…" : "Watching the agent’s desktop"}
          </span>
        </div>
      )}

      {/* Take-control affordance. Two distinct states:
            - WATCHING  → a prominent, centered call-to-action button overlaid on
              the desktop (the primary CTA; tasteful so the screen stays visible).
            - IN CONTROL → a small, unobtrusive top bar ("You're in control · Esc
              to release"); the desktop stays fully usable (accent ring already on
              the viewport). Server-gated: when the deployment is read-only the CTA
              renders disabled with a reason so it degrades gracefully. */}
      {showToggle && !externallyControlled && inControl && (
        <InControlBar
          shared={capability?.shared ?? false}
          onRelease={() => setTakeControl(false)}
        />
      )}
      {/* The big CTA only appears once the framebuffer is live + the viewer is
          watching: before connect the idle scrim already communicates state, so we
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
 * The IN-CONTROL state: a small, unobtrusive top bar so the desktop stays fully
 * usable while driving (the accent ring around the viewport carries the primary
 * "you're driving" signal). Shows a one-click release affordance + the Esc hint,
 * and the shared-box disclosure when relevant.
 */
function InControlBar({ shared, onRelease }: { shared: boolean; onRelease: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
      <span className="pointer-events-auto inline-flex items-center gap-2 rounded-[var(--og-radius-sm,4px)] bg-[color:var(--og-color-accent,var(--color-brand,#3b82f6))] px-2.5 py-1 text-[11px] font-medium text-[color:var(--og-color-accent-fg,#fff)] shadow-[var(--og-shadow-md)]">
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
        You&apos;re in control
        <span className="opacity-75">· press Esc to release</span>
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
          title="Return control (Esc)"
          className={cn(
            "rounded-[var(--og-radius-sm,4px)] border px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm transition-colors",
            "border-[color:var(--og-color-border,var(--color-border,#2a2a2a))] bg-[color:var(--og-color-bg,#0d0d0d)]/70 text-[color:var(--og-color-fg-muted,var(--color-fg-muted,#aaa))]",
            "outline-none hover:text-[color:var(--og-color-fg,#e6e6e6)] focus-visible:ring-2 focus-visible:ring-[color:var(--og-color-accent,var(--color-brand,#3b82f6))]",
          )}
        >
          Release
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
      return "The sandbox is not running. Start a turn or attach to warm it.";
    default:
      return "The desktop isn't available for this sandbox.";
  }
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
      <div className="mb-1 font-medium">{title}</div>
      <p className="text-xs text-[color:var(--color-fg-subtle,#888)]">{body}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded border border-[color:var(--color-border,#2a2a2a)] px-3 py-1.5 text-xs"
        >
          Reconnect
        </button>
      )}
    </div>
  );
}
