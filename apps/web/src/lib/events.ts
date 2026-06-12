import { buildTimeline, type TimelineItem } from "@opengeni/react";

import type { Session, SessionEvent, SessionStatus } from "@/types";

// Only "cancelled" is terminal for the console: a FAILED session is revivable
// by sending it a new message (the API transitions failed -> queued and
// restarts the workflow), so the composer must stay open for it.
export function isTerminalSessionStatus(value: SessionStatus): boolean {
  return value === "cancelled";
}

/**
 * The console's timeline projection: the package's `buildTimeline` over
 * console-sanitized events (archived/provider-internal failure payloads are
 * redacted before they reach the timeline). Falls back to the session's
 * initial message while the event log is still empty.
 */
export function projectSessionTimeline(session: Session, events: SessionEvent[]): TimelineItem[] {
  const items = buildTimeline(events.map((event) => sanitizeEventForDisplay(event, session.status)));
  if (items.length === 0 && session.initialMessage) {
    return [{
      kind: "user-message",
      id: `user-${session.id}`,
      text: session.initialMessage,
      resources: session.resources,
      tools: session.tools,
      occurredAt: session.createdAt,
    }];
  }
  return items;
}

export function sanitizeEventForDisplay(event: SessionEvent, sessionStatus?: SessionStatus): SessionEvent {
  if (isTerminalSessionStatus(sessionStatus ?? "idle") && (event.type === "turn.failed" || event.type === "sandbox.operation.failed")) {
    return {
      ...event,
      payload: {
        archived: true,
        status: sessionStatus,
        message: "Historical failure payload hidden in the web console.",
      },
    };
  }
  if (event.type === "turn.failed" || event.type === "sandbox.operation.failed") {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    const message = failurePayloadMessage(payload);
    if (message && isProviderInternalFailure(message)) {
      return {
        ...event,
        payload: {
          error: providerInternalFailureDisplayMessage(message),
          redacted: true,
        },
      };
    }
  }
  if (event.type !== "agent.reasoning.delta") {
    return event;
  }
  const text = reasoningSummaryText(event.payload);
  return {
    ...event,
    payload: { text: text || "Reasoning summary received." },
  };
}

export type SessionFailureSummary = {
  /** Human-readable reason from the most recent turn.failed event, if any. */
  reason: string | null;
  /** When the most recent failure happened. */
  failedAt: string | null;
  /** Worker-death recoveries: turns the platform re-dispatched (turn.preempted). */
  redispatchCount: number;
  /** Total failed turns in the log — > 1 means the session failed before and was revived. */
  failedTurnCount: number;
};

/**
 * Failure honesty for the session header/banner: the latest failure reason
 * (run through the same provider-internal redaction as the timeline) plus
 * the re-dispatch history from worker-death recovery (`turn.preempted`).
 */
export function summarizeSessionFailure(events: SessionEvent[], sessionStatus: SessionStatus): SessionFailureSummary {
  let reason: string | null = null;
  let failedAt: string | null = null;
  let redispatchCount = 0;
  let failedTurnCount = 0;
  for (const event of events) {
    if (event.type === "turn.preempted") {
      redispatchCount += 1;
    }
    if (event.type === "turn.failed") {
      failedTurnCount += 1;
      const sanitized = sanitizeEventForDisplay(event, sessionStatus);
      const payload = sanitized.payload && typeof sanitized.payload === "object" && !Array.isArray(sanitized.payload)
        ? sanitized.payload as Record<string, unknown>
        : {};
      reason = failurePayloadMessage(payload) ?? reason;
      failedAt = event.occurredAt;
    }
  }
  return { reason, failedAt, redispatchCount, failedTurnCount };
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
  const rawItem = item && typeof item === "object" ? (item as { rawItem?: unknown }).rawItem : undefined;
  const content = rawItem && typeof rawItem === "object" ? (rawItem as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
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

function isProviderInternalFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    ["modal", ".client", ".modal", "client"],
    ["container", "filesystem", "exec"],
    ["sandbox", "terminate"],
    ["resource", "_", "exhausted"],
    ["failed to apply a ", "modal", " sandbox manifest"],
    ["bandwidth exhausted", " or memory limit exceeded"],
  ].some((parts) => normalized.includes(parts.join("")));
}

function providerInternalFailureDisplayMessage(message: string): string {
  const normalized = message.toLowerCase();
  if (
    normalized.includes(["resource", "_", "exhausted"].join(""))
    || normalized.includes(["bandwidth exhausted", " or memory limit exceeded"].join(""))
  ) {
    return "Sandbox setup failed because the execution provider reported a temporary capacity limit. Start a new session.";
  }
  return "Sandbox setup failed while preparing the execution environment. Start a new session.";
}

export function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "session.created": "Session created",
    "session.status.changed": "Status changed",
    "session.requiresAction": "Approval required",
    "user.message": "User message",
    "user.interrupt": "User interrupt",
    "user.approvalDecision": "Approval decision",
    "turn.queued": "Turn queued",
    "turn.updated": "Turn updated",
    "turn.started": "Turn started",
    "turn.completed": "Turn completed",
    "turn.failed": "Turn failed",
    "turn.cancelled": "Turn cancelled",
    "turn.preempted": "Turn re-dispatched (worker restart)",
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
    "goal.continuation": "Goal continuation",
  };
  return labels[type] ?? type;
}
