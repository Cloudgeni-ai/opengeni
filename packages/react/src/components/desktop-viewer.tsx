import type { CapabilityUnavailableReason, DesktopRfbFactory, DesktopStreamCapability } from "@opengeni/sdk";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useDesktopStream } from "../hooks/use-desktop-stream";

export type DesktopViewerProps = {
  /** The desktop cell of the negotiated capabilities (`capabilities.DesktopStream`). */
  capability: DesktopStreamCapability | null;
  /** read-only vs interactive. Forced read-only when `capability.mode === "read-only"`. */
  interactive?: boolean | undefined;
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
 * URL from the capability doc — read-only in v1. Owns the mount `<div ref>`,
 * drives `useDesktopStream` (SSR-safe lazy RFB), and renders the
 * unavailable / warming / consent / viewer-cap / live states. The read-only vs
 * interactive decision is enforced server-first (`capability.mode`).
 *
 * Connection is gated: the RFB only attaches once a usable `url` is present
 * (post-acknowledgment, post-warm). Before that, the consent / warming notices
 * render and no socket is opened.
 */
export function DesktopViewer({
  capability,
  interactive,
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

  // The hook is always called (rules of hooks); it stays idle until `url` is set.
  const connectCapability = !transportNull && !needsAck ? capability : null;
  const stream = useDesktopStream({
    capability: connectCapability,
    containerRef,
    ...(interactive !== undefined ? { interactive } : {}),
    ...(scaleViewport !== undefined ? { scaleViewport } : {}),
    ...(rfbFactory ? { rfbFactory } : {}),
  });

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
    <div className={cn("relative h-full w-full overflow-hidden bg-black", className)} data-opengeni-desktop>
      <div
        ref={containerRef}
        className="h-full w-full"
        data-opengeni-desktop-canvas
        data-state={stream.state}
      />
      {overlay && (
        <div className="absolute inset-0 flex items-center justify-center p-4">{overlay}</div>
      )}
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
