import type { AuthNeededItem, TimelineItem } from "@opengeni/sdk/session";

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

export type AuthNeededPresentation = Readonly<{
  provider: string;
  title: string;
  reasonLine: string;
  actionLabel: "Connect" | "Reconnect" | "Review";
  actionable: boolean;
  capability: boolean;
  requiredVariables: readonly string[];
  followUpLine: string | null;
}>;

export function authNeededPresentation(item: AuthNeededItem): AuthNeededPresentation {
  const recommendation = item.capability ?? null;
  const provider =
    recommendation?.name ??
    (item.serverId === "codex_apps" ? "Codex Apps" : providerLabel(item.providerDomain));
  const actionable = ![
    "personal_authority_unavailable",
    "unsupported_auth",
    "resource_scope_unavailable",
  ].includes(item.reason ?? "");
  const missing = item.reason === "missing_connection";
  const actionLabel = recommendation
    ? recommendation.action === "connect"
      ? "Connect"
      : "Review"
    : missing
      ? "Connect"
      : "Reconnect";
  const title = recommendation
    ? recommendation.action === "connect"
      ? `Connect ${provider}`
      : recommendation.action === "add_credentials"
        ? `Set up ${provider}`
        : `Enable ${provider}`
    : actionable
      ? `${actionLabel} ${provider}`
      : `${provider} tools unavailable`;
  return {
    provider,
    title,
    reasonLine: recommendation?.rationale ?? authReasonLine(item.reason),
    actionLabel,
    actionable,
    capability: recommendation !== null,
    requiredVariables: recommendation?.requiredVariables ?? [],
    followUpLine: actionable
      ? recommendation
        ? "No access has been granted. Review and confirm the provider before continuing."
        : `This tool call wasn't replayed. After ${missing ? "connecting" : "reconnecting"}, send a new message to try again.`
      : null,
  };
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
      return authNeededPresentation(item).title;
    case "turn-end":
      return item.failureText || `Turn ${item.outcome}`;
  }
}

function providerLabel(domain: string): string {
  const host =
    domain
      .trim()
      .replace(/^https?:\/\//u, "")
      .replace(/^www\./u, "")
      .split("/")[0] ?? "";
  const first = host.split(".")[0] ?? host;
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}` : "this service";
}

function authReasonLine(reason: AuthNeededItem["reason"]): string {
  switch (reason) {
    case "insufficient_scope":
      return "It needs additional access to continue.";
    case "missing_connection":
      return "It isn't connected yet.";
    case "expired":
    case "refresh_failed":
      return "Its access expired.";
    case "personal_authority_unavailable":
      return "This automation was not granted access to your personal connection.";
    case "unsupported_auth":
      return "This connection cannot authenticate the configured tool endpoint.";
    case "resource_scope_unavailable":
      return "This tool endpoint cannot enforce the selected repository access.";
    default:
      return "Its connection needs attention.";
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
