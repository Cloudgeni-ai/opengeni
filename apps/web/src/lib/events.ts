import { buildTimeline, presentFailure, type TimelineItem } from "@opengeni/react";

import type { Session, SessionEvent, SessionStatus } from "@/types";

// Only "cancelled" is terminal for the console: a FAILED session is revivable
// by sending it a new message (the API transitions failed -> queued and
// restarts the workflow), so the composer must stay open for it.
export function isTerminalSessionStatus(value: SessionStatus): boolean {
  return value === "cancelled";
}

/**
 * The console's timeline projection over exact session events. Falls back to
 * the session's initial message while the event log is still empty.
 */
export function projectSessionTimeline(
  session: Session,
  events: SessionEvent[],
  creationClientEventId?: string,
): TimelineItem[] {
  const items = buildTimeline(events);
  if (creationClientEventId) {
    const reconciliationKey = `user-message:${creationClientEventId}`;
    if (
      items.some(
        (item) => item.kind === "user-message" && item.reconciliationKey === reconciliationKey,
      )
    ) {
      return items;
    }
    if (!session.initialMessage && session.resources.length === 0) {
      return items;
    }
    return [
      {
        kind: "user-message",
        id: "c",
        reconciliationKey,
        text: session.initialMessage,
        resources: session.resources,
        tools: session.tools,
        occurredAt: session.createdAt,
      },
      ...items,
    ];
  }
  if (events.length === 0 && items.length === 0 && session.initialMessage) {
    return [
      {
        kind: "user-message",
        id: `user-${session.id}`,
        text: session.initialMessage,
        resources: session.resources,
        tools: session.tools,
        occurredAt: session.createdAt,
      },
    ];
  }
  return items;
}

export type SessionFailureSummary = {
  /** Human-readable reason from the latest recorded failure boundary, if any. */
  reason: string | null;
  safetyRefusal?: boolean;
  /** When the most recent failure happened. */
  failedAt: string | null;
  /** Exact durable event identity; independent of history hydration or clock precision. */
  failureEventId?: string | null;
  /** Final consecutive automatic-recovery streak, not total recoveries in a turn or session. */
  consecutiveRecoveryCount: number | null;
  detailsTruncated?: boolean;
};

/**
 * Failure honesty for the session header/banner: the latest failure reason
 * and the final consecutive retry streak when explicitly recorded by the worker.
 */
export function summarizeSessionFailure(
  events: SessionEvent[],
  sessionStatus: SessionStatus,
  diagnostics?: Session["failureDiagnostics"],
  diagnosticsThrough = diagnostics?.sequence ?? 0,
): SessionFailureSummary {
  // A detail read owns current failure identity even when the timeline has been
  // cleared or paged into older history. Legacy servers omit this field.
  events = events.filter(
    (event) =>
      !event.duplicateOfEventId && (!event.turnAssociation || event.turnAssociation === "current"),
  );
  const newerEvents = events.filter((event) => event.sequence > diagnosticsThrough);
  const newerFailure = newerEvents.some(
    (event) =>
      event.type === "turn.failed" ||
      (event.type === "session.status.changed" &&
        (event.payload as Record<string, unknown>)?.code === "pre_claim_failure" &&
        (event.payload as Record<string, unknown>)?.status === "failed" &&
        (!event.turnId || event.turnId !== diagnostics?.turnId)),
  );
  if (sessionStatus === "failed" && diagnostics !== undefined && !newerFailure) {
    const payload =
      diagnostics?.payload && typeof diagnostics.payload === "object"
        ? (diagnostics.payload as Record<string, unknown>)
        : {};
    const presentation = presentFailure(payload);
    return {
      reason:
        presentation.reason ??
        (payload.code === "pre_claim_failure"
          ? "The session failed before a turn could start. No error details were recorded."
          : null),
      safetyRefusal: presentation.safetyRefusal,
      failedAt: diagnostics?.occurredAt ?? null,
      failureEventId: diagnostics?.eventId ?? null,
      consecutiveRecoveryCount: failureRecoveryStreak(payload),
      ...((payload.projection as { truncatedFields?: unknown[] } | undefined)?.truncatedFields
        ?.length
        ? { detailsTruncated: true }
        : {}),
    };
  }
  if (diagnostics !== undefined && newerFailure) events = newerEvents;
  let reason: string | null = null;
  let safetyRefusal = false;
  let failedAt: string | null = null;
  let failureEventId: string | null = null;
  let consecutiveRecoveryCount: number | null = null;
  let latestFailedTurnId: string | null = null;
  for (const event of events) {
    if (event.type === "turn.failed") {
      latestFailedTurnId = event.turnId ?? null;
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      consecutiveRecoveryCount = failureRecoveryStreak(payload);
      const presentation = presentFailure(payload);
      reason = presentation.reason;
      safetyRefusal = presentation.safetyRefusal;
      failedAt = event.occurredAt;
      failureEventId = event.id;
    }
    if (event.type === "session.status.changed") {
      const payload = event.payload as Record<string, unknown>;
      if (
        payload?.status === "failed" &&
        payload.code === "pre_claim_failure" &&
        (!event.turnId || event.turnId !== latestFailedTurnId)
      ) {
        // An unclaimed machine update has no turn.failed event. Its status is a
        // new failure boundary, never evidence that an older provider error
        // happened again. Preserve a paired same-turn diagnostic when present.
        consecutiveRecoveryCount = failureRecoveryStreak(payload);
        const presentation = presentFailure(payload);
        reason =
          presentation.reason ??
          "The session failed before a turn could start. No error details were recorded.";
        safetyRefusal = presentation.safetyRefusal;
        failedAt = event.occurredAt;
        failureEventId = event.id;
      }
    }
  }
  return { reason, safetyRefusal, failedAt, failureEventId, consecutiveRecoveryCount };
}

function failureRecoveryStreak(payload: Record<string, unknown>): number | null {
  const value = payload.providerRecoveryCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function reasoningSummaryText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const directText = (payload as { text?: unknown }).text;
  if (typeof directText === "string") {
    return directText;
  }
  const item = (payload as { item?: unknown }).item;
  const rawItem =
    item && typeof item === "object" ? (item as { rawItem?: unknown }).rawItem : undefined;
  const content =
    rawItem && typeof rawItem === "object" ? (rawItem as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("");
}

export function failurePayloadMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error;
  }
  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }
  return undefined;
}

// Human labels for NAMED sandbox operations (the op `name` on a
// `sandbox.operation.*` payload), translated at the UI boundary so the raw op id
// never renders as a label. Additive: an unknown op falls back to the generic
// event-type label. "sandbox.provision" is the lazy first-establish that now
// happens mid-turn — the user should read "Starting sandbox", not an unexplained
// long-running operation.
const SANDBOX_OPERATION_LABELS: Record<string, string> = {
  "sandbox.provision": "Starting sandbox",
  "repository-clone": "Preparing repository",
  "file-resource-download": "Preparing files",
};

/** The named op on a `sandbox.operation.*` payload, or null. */
function sandboxOperationName(event: SessionEvent): string | null {
  if (
    (event.type === "sandbox.operation.started" ||
      event.type === "sandbox.operation.completed" ||
      event.type === "sandbox.operation.failed") &&
    event.payload &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
  ) {
    const name = (event.payload as Record<string, unknown>).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

/**
 * The display label for an event, preferring a named-operation label over the
 * generic event-type one (so `sandbox.provision` reads "Starting sandbox" rather
 * than "Sandbox operation started"). Falls back to {@link eventLabel}.
 */
export function eventDisplayLabel(event: SessionEvent): string {
  const opName = sandboxOperationName(event);
  if (opName && SANDBOX_OPERATION_LABELS[opName]) {
    if (event.type === "sandbox.operation.completed") {
      if (opName === "sandbox.provision") return "Sandbox ready";
      if (opName === "repository-clone") return "Repository ready";
      if (opName === "file-resource-download") return "Files ready";
    }
    if (event.type === "sandbox.operation.failed") {
      if (opName === "sandbox.provision") return "Sandbox didn’t start";
      if (opName === "repository-clone") return "Repository preparation failed";
      if (opName === "file-resource-download") return "File preparation failed";
    }
    return SANDBOX_OPERATION_LABELS[opName]!;
  }
  return eventLabel(event.type);
}

/**
 * Whether a lazy sandbox provision is in flight on this event stream: the latest
 * `sandbox.provision` operation event is a `.started` not yet closed by a
 * `.completed`/`.failed`. Drives the workbench "Starting sandbox…" affordance and
 * the renegotiate-on-settle that picks the freshly-warm box back up.
 */
export function sandboxProvisionInFlight(events: SessionEvent[]): boolean {
  let inFlight = false;
  for (const event of events) {
    if (sandboxOperationName(event) !== "sandbox.provision") {
      continue;
    }
    if (event.type === "sandbox.operation.started") {
      inFlight = true;
    } else if (
      event.type === "sandbox.operation.completed" ||
      event.type === "sandbox.operation.failed"
    ) {
      inFlight = false;
    }
  }
  return inFlight;
}

export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "session.created": "Session created",
    "session.variable_sets.updated": "Variable Sets updated",
    "session.runtime.configured": "Restart setup configured",
    "session.status.changed": "Status changed",
    "session.requiresAction": "Approval required",
    "user.message": "User message",
    "user.pause": "User paused",
    "user.approvalDecision": "Approval decision",
    "turn.queued": "Turn queued",
    "turn.started": "Turn started",
    "turn.completed": "Turn completed",
    "turn.failed": "Turn failed",
    "turn.cancelled": "Turn cancelled",
    "turn.recovery.requested": "Turn recovery requested",
    "turn.startup.phase.started": "Turn preparation started",
    "turn.startup.phase.completed": "Turn preparation completed",
    "turn.startup.phase.failed": "Turn preparation failed",
    "session.control.paused": "Session paused",
    "session.control.resumed": "Session resumed",
    "session.control.steer_requested": "Steer requested",
    "turn.event.rejected_late": "Late attempt event rejected",
    "agent.message.delta": "Assistant delta",
    "agent.message.completed": "Assistant completed",
    "agent.reasoning.delta": "Model activity",
    "agent.toolCall.created": "Tool call",
    "agent.toolCall.output": "Tool output",
    "agent.updated": "Agent updated",
    "sandbox.operation.started": "Sandbox operation started",
    "sandbox.operation.completed": "Sandbox operation completed",
    "sandbox.operation.failed": "Sandbox operation failed",
    "sandbox.command.output.delta": "Sandbox output",
    "artifact.created": "Artifact created",
    "goal.set": "Goal set",
    "goal.updated": "Goal updated",
    "goal.completed": "Goal completed",
    "goal.paused": "Goal paused",
    "goal.resumed": "Goal resumed",
    "goal.held": "Goal held",
    "goal.continuation": "Goal continuation",
    "memory.saved": "Memory saved",
    "memory.corrected": "Memory corrected",
  };
  return labels[type] ?? humanizeEventType(type);
}

function humanizeEventType(type: string): string {
  const words = type.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) {
    return "Event";
  }
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}
