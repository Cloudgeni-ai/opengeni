import type { SessionStatus } from "@opengeni/sdk";
import { SESSION_ARCHIVE_STOP_REASON } from "@opengeni/contracts/session-history";
import { type OpenGeniText } from "./messages/runtime";

/** Status token family (`--og-color-status-<tone>`) for a session status. */
export type SessionStatusTone = "queued" | "running" | "waiting" | "idle" | "failed" | "cancelled";

/**
 * The status a person sees. `blocked` is a `requires_action` session whose
 * next turn the runtime refused to start (an admission block): nothing is
 * asked of the person, so it must not read as "Waiting on you". Accepted work
 * is kept, and Resume (or a new message) rechecks and starts it again.
 *
 * `archived` is a chat someone archived, or one the deployment archived after
 * a long idle period: read-only, kept in long-term storage, continuable in a
 * new chat. Archiving stops running work, which leaves the server status
 * `cancelled`; that internal word never reaches a person for an archive.
 */
export type SessionDisplayStatus = SessionStatus | "blocked" | "archived";

/** The archive facts a session (or a list row) carries; both are optional on older servers. */
export type SessionArchiveFacts = {
  archived?: boolean | undefined;
  retention?: { archive: unknown } | null | undefined;
};

/**
 * True when the chat is archived: archived by a person (`archived`, set the
 * moment Archive is pressed) or moving to or in long-term storage
 * (`retention.archive`). Either way it is read-only.
 */
export function sessionArchived(session: SessionArchiveFacts): boolean {
  return session.archived === true || (session.retention?.archive ?? null) !== null;
}

/**
 * True for the `cancelled` status change that archiving a chat records when it
 * stops the chat's work: a timeline reads it as archived, never "cancelled".
 */
export function sessionStatusChangeIsArchive(payload: {
  status?: unknown;
  reason?: unknown;
}): boolean {
  return payload.status === "cancelled" && payload.reason === SESSION_ARCHIVE_STOP_REASON;
}

/** The status a timeline status divider presents: archived, stuck, or its own. */
export function sessionStatusItemDisplayStatus(item: {
  status: SessionStatus;
  blocked?: true | undefined;
  archived?: true | undefined;
}): SessionDisplayStatus {
  return item.archived ? "archived" : item.blocked ? "blocked" : item.status;
}

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

/**
 * The status to present for a session (or a list row carrying its admission
 * block and archive facts). An archived chat reads as archived whatever its
 * last run state was.
 */
export function sessionDisplayStatus(
  session: {
    status: SessionStatus;
    admissionBlock?: unknown;
  } & SessionArchiveFacts,
): SessionDisplayStatus {
  if (sessionArchived(session)) return "archived";
  return sessionAdmissionBlocked(session) ? "blocked" : session.status;
}

/**
 * Where a person's ordinary Send shows before the server answers. While a
 * turn is still current or prompts already wait, it joins the queue. A turn
 * parked on provider capacity (a used-up plan, an account to reconnect) is
 * not work the Send waits for: the server starts the new message right away
 * in its place, so it shows in the chat, unless an admission block (used-up
 * Opengeni allowance or credits) holds every new turn.
 */
export function promptSendDestination(input: {
  status: SessionStatus | null | undefined;
  activeTurnId: string | null | undefined;
  queuedPrompts: number;
  admissionBlock?: unknown;
}): "chat" | "queue" {
  if (input.status === "waiting_capacity" && (input.admissionBlock ?? null) === null) return "chat";
  return input.queuedPrompts > 0 ||
    input.status === "running" ||
    (input.activeTurnId ?? null) !== null
    ? "queue"
    : "chat";
}

/**
 * Whether the session's own turn keeps the composer's run control (Pause)
 * available: it runs, recovers, or is parked on provider capacity, where
 * Pause is how a person stops it continuing by itself at the reset.
 */
export function sessionTurnKeepsRunControl(status: SessionStatus | null | undefined): boolean {
  return status === "running" || status === "recovering" || status === "waiting_capacity";
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
  // Read-only and settled: the quiet neutral hue of a stopped chat.
  archived: { label: t("sessionStatusModel.archived"), tone: "cancelled", pulse: false },
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
  archived: { text: "fg-subtle", border: "border", borderAlpha: 1, fill: "status-cancelled" },
};
