import type { SessionStatus } from "@opengeni/sdk";
import { type OpenGeniText } from "./messages/runtime";

/** Status token family (`--og-color-status-<tone>`) for a session status. */
export type SessionStatusTone = "queued" | "running" | "waiting" | "idle" | "failed" | "cancelled";

/**
 * The status a person sees. `blocked` is a `requires_action` session whose
 * next turn the runtime refused to start (an admission block): nothing is
 * asked of the person, so it must not read as "Waiting on you". Accepted work
 * is kept, and Resume (or a new message) rechecks and starts it again.
 */
export type SessionDisplayStatus = SessionStatus | "blocked";

/** True when a `requires_action` session is held by an admission block, not by a person. */
export function sessionAdmissionBlocked(session: {
  status: SessionStatus;
  admissionBlock?: unknown;
}): boolean {
  return (
    session.status === "requires_action" &&
    typeof session.admissionBlock === "object" &&
    session.admissionBlock !== null
  );
}

/** The status to present for a session (or a list row carrying its admission block). */
export function sessionDisplayStatus(session: {
  status: SessionStatus;
  admissionBlock?: unknown;
}): SessionDisplayStatus {
  return sessionAdmissionBlocked(session) ? "blocked" : session.status;
}

/** Renderer-neutral session status presentation: label, color family and liveness. */
export const SESSION_STATUS_PRESENTATION = (
  t: OpenGeniText,
): Record<SessionDisplayStatus, { label: string; tone: SessionStatusTone; pulse: boolean }> => ({
  queued: { label: t("sessionStatusModel.queued"), tone: "queued", pulse: false },
  running: { label: t("sessionStatusModel.running"), tone: "running", pulse: true },
  recovering: { label: t("sessionStatusModel.recovering"), tone: "running", pulse: true },
  // Model subscription capacity is exhausted; the turn continues by itself.
  waiting_capacity: { label: t("sessionStatusModel.limitReached"), tone: "waiting", pulse: true },
  idle: { label: t("sessionStatusModel.idle"), tone: "idle", pulse: false },
  requires_action: { label: t("sessionStatusModel.waitingOnYou"), tone: "waiting", pulse: true },
  // The runtime could not start the next turn. Nothing moves until a recheck.
  blocked: { label: t("sessionStatusModel.stuck"), tone: "failed", pulse: false },
  failed: { label: t("sessionStatusModel.failed"), tone: "failed", pulse: false },
  cancelled: { label: t("sessionStatusModel.cancelled"), tone: "cancelled", pulse: false },
});

/**
 * The status badge's color tokens (text, border and its alpha); the fill is the
 * status color at 10%. Mirrors the web badge classes, for non-DOM renderers.
 */
export const SESSION_STATUS_BADGE: Record<
  SessionDisplayStatus,
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
  blocked: {
    text: "status-failed",
    border: "status-failed",
    borderAlpha: 0.35,
    fill: "status-failed",
  },
  failed: {
    text: "status-failed",
    border: "status-failed",
    borderAlpha: 0.35,
    fill: "status-failed",
  },
  cancelled: { text: "fg-subtle", border: "border", borderAlpha: 1, fill: "status-cancelled" },
};
