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
