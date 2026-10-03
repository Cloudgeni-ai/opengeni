import type { SessionStatus } from "@opengeni/sdk";

/** Status token family (`--og-color-status-<tone>`) for a session status. */
export type SessionStatusTone = "queued" | "running" | "waiting" | "idle" | "failed" | "cancelled";

/** Renderer-neutral session status presentation: label, color family and liveness. */
export const SESSION_STATUS_PRESENTATION: Record<
  SessionStatus,
  { label: string; tone: SessionStatusTone; pulse: boolean }
> = {
  queued: { label: "Queued", tone: "queued", pulse: false },
  running: { label: "Running", tone: "running", pulse: true },
  recovering: { label: "Recovering", tone: "running", pulse: true },
  waiting_capacity: { label: "Waiting for capacity", tone: "waiting", pulse: true },
  idle: { label: "Idle", tone: "idle", pulse: false },
  requires_action: { label: "Waiting on you", tone: "waiting", pulse: true },
  failed: { label: "Failed", tone: "failed", pulse: false },
  cancelled: { label: "Cancelled", tone: "cancelled", pulse: false },
};

/**
 * The status badge's color tokens (text, border and its alpha); the fill is the
 * status color at 10%. Mirrors the web badge classes, for non-DOM renderers.
 */
export const SESSION_STATUS_BADGE: Record<
  SessionStatus,
  { text: string; border: string; borderAlpha: number; fill: string }
> = {
  queued: { text: "fg-muted", border: "border", borderAlpha: 1, fill: "status-queued" },
  running: {
    text: "status-running",
    border: "status-running",
    borderAlpha: 0.3,
    fill: "status-running",
  },
  recovering: {
    text: "status-running",
    border: "status-running",
    borderAlpha: 0.3,
    fill: "status-running",
  },
  waiting_capacity: {
    text: "status-waiting",
    border: "status-waiting",
    borderAlpha: 0.35,
    fill: "status-waiting",
  },
  idle: { text: "status-idle", border: "status-idle", borderAlpha: 0.3, fill: "status-idle" },
  requires_action: {
    text: "status-waiting",
    border: "status-waiting",
    borderAlpha: 0.35,
    fill: "status-waiting",
  },
  failed: {
    text: "status-failed",
    border: "status-failed",
    borderAlpha: 0.35,
    fill: "status-failed",
  },
  cancelled: { text: "fg-subtle", border: "border", borderAlpha: 1, fill: "status-cancelled" },
};
