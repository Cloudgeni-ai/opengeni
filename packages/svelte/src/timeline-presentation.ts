import type { TimelineItem } from "@opengeni/sdk/session";

export const TIMELINE_KIND_LABELS = {
  "user-message": "You",
  "human-input": "Structured answer",
  "agent-message": "OpenGeni",
  reasoning: "Reasoning",
  "tool-call": "Tool",
  worker: "Worker",
  "worker-completion": "Worker result",
  sandbox: "Sandbox",
  "startup-phase": "Startup",
  memory: "Memory",
  "fleet-decision": "Placement decision",
  "session-status": "Session status",
  goal: "Goal",
  notice: "Notice",
  "context-compaction": "Context",
  "machine-input-batch": "Machine input",
  "auth-needed": "Connection required",
  "turn-end": "Turn",
} as const satisfies Record<TimelineItem["kind"], string>;

export function timelineItemLabel(item: TimelineItem): string {
  return TIMELINE_KIND_LABELS[item.kind];
}

export function timelineItemOutcome(item: TimelineItem): string | undefined {
  switch (item.kind) {
    case "agent-message":
    case "reasoning":
      return item.streaming ? "streaming" : "ready";
    case "tool-call":
    case "worker":
    case "sandbox":
    case "startup-phase":
      return item.status;
    case "worker-completion":
      return item.childStatus;
    case "fleet-decision":
      return item.actualOutcome;
    case "session-status":
      return item.status;
    case "goal":
      return item.action;
    case "notice":
      return item.tone;
    case "context-compaction":
      return item.phase;
    case "machine-input-batch":
      return item.members.some((member) => member.classification === "failure")
        ? "failed"
        : item.members.some((member) => member.classification === "action_required")
          ? "action-required"
          : "ready";
    case "auth-needed":
      return "action-required";
    case "turn-end":
      return item.outcome;
    case "user-message":
      return item.delivery?.state;
    case "human-input":
      return item.response.outcome;
    case "memory":
      return item.variant;
  }
}

export function timelineItemSummary(item: TimelineItem): string {
  switch (item.kind) {
    case "user-message":
    case "agent-message":
    case "reasoning":
      return item.text;
    case "human-input":
      return item.questions.map((question) => question.label || question.prompt).join(" · ");
    case "tool-call":
      return item.name;
    case "worker":
      return item.prompt || `${item.action === "spawn" ? "Started" : "Messaged"} a worker`;
    case "worker-completion":
      return item.goalText || item.text || `Worker ${item.childStatus}`;
    case "sandbox":
      return item.command || item.name;
    case "startup-phase":
      return `${item.phase.replaceAll("_", " ")}${item.durationMs === null ? "" : ` · ${item.durationMs} ms`}`;
    case "memory":
      return item.variant === "corrected" && item.replacementPreview
        ? `${item.preview} → ${item.replacementPreview}`
        : item.preview;
    case "fleet-decision":
      return `${item.actualOutcome.replaceAll("_", " ")} · ${item.actualReason.replaceAll("_", " ")}`;
    case "session-status":
      return item.status.replaceAll("_", " ");
    case "goal":
      return item.text || item.action.replaceAll("_", " ");
    case "notice":
      return item.text;
    case "context-compaction":
      return item.phase === "compacted"
        ? "Conversation history compacted"
        : item.phase === "started"
          ? "Compacting conversation history…"
          : "Conversation history was not compacted";
    case "machine-input-batch":
      return item.members.length === 1
        ? item.members[0]!.summary
        : `${item.members.length} machine inputs`;
    case "auth-needed":
      return `${item.providerDomain || "Provider"} needs to be connected again`;
    case "turn-end":
      return item.failureText || `Turn ${item.outcome}`;
  }
}

export function boundedTimelineValue(value: unknown, maxLength = 4_096): string {
  if (value === null || value === undefined) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  } catch {
    return String(value);
  }
}
