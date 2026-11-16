import {
  MCP_MUTATION_RECEIPT_VERSION,
  McpMutationReceipt,
  type McpMutationReceiptType,
  type SessionPromptRouting,
  type SessionSystemUpdateState,
} from "@opengeni/contracts";
import type { AgentMessageReadAt, AgentSteerReadAt } from "@opengeni/db";

export type McpMutationReceiptInput = Omit<
  McpMutationReceiptType,
  "receiptVersion" | "timestamp" | "warnings"
> & {
  timestamp?: string;
  warnings?: string[];
};

/**
 * Build and validate a compact first-party MCP mutation receipt at the API
 * boundary. Contract parsing is intentional: it prevents a handler from
 * accidentally adding an unbounded entity or a copy of request fields.
 */
export function mcpMutationReceipt(input: McpMutationReceiptInput): McpMutationReceiptType {
  return McpMutationReceipt.parse({
    receiptVersion: MCP_MUTATION_RECEIPT_VERSION,
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
    warnings: input.warnings ?? [],
  });
}

/**
 * Messaging another session has the same two modes a person has in the chat.
 * Queue (session_queue_message) waits for the target's current turn to end and
 * adds information; Steer (session_steer) is read at the target's next step
 * and replaces its direction. Each sentence says which happened and when the
 * target reads it, because "accepted" alone reads like "delivered".
 */
const QUEUE_SUMMARY: Record<AgentMessageReadAt, string> = {
  starts_next_turn:
    "Queued: the target session was idle, so this message starts its next turn now.",
  after_current_turn:
    "Queued: the target session is mid-turn and will read this after its current turn ends. It does not change what it is doing now; use session_steer to change its direction now.",
  after_resume: "Queued: the target session is paused and will read this only after it is resumed.",
  when_next_turn_starts:
    "Queued: the target session cannot start a turn right now and will read this when its next turn starts. It does not change what it is doing now.",
};

const STEER_SUMMARY: Record<AgentSteerReadAt, string> = {
  next_step:
    "Steered: the target session will read this at its next step, after its current tool calls finish. It replaces what the session is doing now.",
  after_compaction:
    "Steered: the target session is compacting its context and will read this as soon as that finishes. It replaces what the session is doing now.",
  starts_next_turn:
    "Steered: the target session had no turn running, so this starts its next turn now.",
};

function replaySummary(mode: "queue" | "steer", followWith: string): string {
  return `Nothing new was sent: an earlier call with this idempotency key already ${
    mode === "queue" ? "queued this message" : "sent this steer"
  }. Use ${followWith} to see whether the target has read it.`;
}

/** An agent's Queue or Steer, followed by its update ID with session_message_status. */
export function agentSessionInputReceipt(
  input: {
    targetSessionId: string;
    updateId: string;
    replay: boolean;
    timestamp: string;
  } & (
    | { operation: "session_queue_message"; readAt: AgentMessageReadAt }
    | { operation: "session_steer"; readAt: AgentSteerReadAt }
  ),
): McpMutationReceiptType {
  const queue = input.operation === "session_queue_message";
  return mcpMutationReceipt({
    operation: input.operation,
    committed: true,
    outcome: input.replay ? "replayed" : queue ? "queued" : "steered",
    changed: !input.replay,
    summary: input.replay
      ? replaySummary(queue ? "queue" : "steer", "session_message_status")
      : input.operation === "session_queue_message"
        ? QUEUE_SUMMARY[input.readAt]
        : STEER_SUMMARY[input.readAt],
    // The message itself, unread until the target claims it.
    resource: {
      type: "session_system_update",
      id: input.updateId,
      ...(input.replay ? {} : { state: "pending" }),
    },
    relatedResources: [{ type: "session", id: input.targetSessionId }],
    timestamp: input.timestamp,
    idempotency: { status: input.replay ? "replayed" : "applied" },
    updateId: input.updateId,
    nextAction: {
      tool: "session_message_status",
      arguments: { sessionId: input.targetSessionId, updateId: input.updateId },
    },
  });
}

/** The same sentence for a sessionless (human/API) Queue or Steer prompt. */
export function operatorSessionInputSummary(input: {
  routing: SessionPromptRouting;
  replay: boolean;
}): string {
  if (input.replay) {
    return replaySummary(
      input.routing === "accepted_for_steering" ? "steer" : "queue",
      "session_get",
    );
  }
  switch (input.routing) {
    case "accepted_for_execution":
      return QUEUE_SUMMARY.starts_next_turn;
    case "queued_for_execution":
      return "Queued: the target session is busy or paused and will read this after the work ahead of it finishes. It does not change what it is doing now; use session_steer to change its direction now.";
    case "accepted_for_steering":
      return "Steered: the target session will read this at its next step, or start a turn with it if none is running. It replaces what the session is doing now.";
  }
}

/** One plain sentence for session_message_status: has the target read it yet? */
export function sessionMessageStatusSummary(input: {
  kind: "agent_message" | "agent_steer_instruction";
  state: SessionSystemUpdateState;
  deliveredAt: string | null;
  hasOutcome: boolean;
}): string {
  switch (input.state) {
    case "pending":
      return input.kind === "agent_message"
        ? "Not read yet: a queued message is read after the target's current turn ends, or when its next turn starts. It does not change what the target is doing now; use session_steer for that."
        : "Not read yet: the target reads this steer at its next step.";
    case "delivered":
      return `Read by the target${input.deliveredAt ? ` at ${input.deliveredAt}` : ""}; turnId is the turn that read it. ${
        input.hasOutcome
          ? "That turn has finished; nextAction reads its result."
          : "That turn has no result yet."
      }`;
    case "superseded":
      return "Not read: a newer steer replaced it before the target read it.";
    case "cancelled":
      return "Not read: it was cancelled before the target read it.";
    case "failed":
      return "Not read: delivery failed.";
  }
}

export function sessionControlMutationReceipt(input: {
  operation: "session_pause" | "session_resume";
  sessionId: string;
  state: string;
  receiptId: string;
  timestamp: string;
  outcome: "changed" | "unchanged" | "replayed";
  interruptionCount: number;
}): McpMutationReceiptType {
  return mcpMutationReceipt({
    operation: input.operation,
    committed: true,
    outcome:
      input.outcome === "changed"
        ? "updated"
        : input.outcome === "unchanged"
          ? "unchanged"
          : "replayed",
    changed: input.outcome === "changed",
    resource: {
      type: "session",
      id: input.sessionId,
      state: input.state,
    },
    relatedResources: [{ type: "session_command_receipt", id: input.receiptId }],
    timestamp: input.timestamp,
    idempotency: {
      status: input.outcome === "replayed" ? "replayed" : "applied",
    },
    facts: { interruptionCount: input.interruptionCount },
    nextAction: { tool: "session_get", arguments: { sessionId: input.sessionId } },
  });
}

export type SessionCreateReceiptResult = {
  session: {
    id: string;
    queueVersion: number;
    status: string;
    sandboxGroupId: string;
    parentSessionId: string | null;
    rootSessionId: string;
    nestedAgentDepth: number;
    effectiveMaxNestedAgentDepth: number;
  };
  outcome: "created" | "repaired" | "replayed";
  changed: boolean;
  usageRecording: "recorded" | "failed";
};

/** Project committed session-create truth without copying request fields. */
export function sessionCreateMutationReceipt(
  result: SessionCreateReceiptResult,
  idempotencyKeyRequested: boolean,
  // The new chat's canonical link, when the deployment has a web base URL.
  chatUrl: string | null = null,
): McpMutationReceiptType {
  const usageRecordingFailed = result.usageRecording === "failed";
  const retryable = usageRecordingFailed && idempotencyKeyRequested;
  return mcpMutationReceipt({
    operation: "session_create",
    committed: true,
    outcome: usageRecordingFailed ? "partial_failure" : result.outcome,
    changed: result.changed,
    resource: {
      type: "session",
      id: result.session.id,
      version: result.session.queueVersion,
      state: result.session.status,
    },
    idempotency: {
      status:
        result.outcome === "replayed"
          ? "replayed"
          : idempotencyKeyRequested
            ? "applied"
            : "not_requested",
    },
    ...(usageRecordingFailed
      ? {
          partialFailure: { stage: "usage_recording", retryable },
          warnings: [
            retryable
              ? "The session committed, but usage recording failed. Retry only with the same idempotency key."
              : "The session committed, but usage recording failed. Do not retry this keyless request; inspect the returned session.",
          ],
        }
      : {}),
    facts: {
      sandboxGroupId: result.session.sandboxGroupId,
      parentSessionId: result.session.parentSessionId,
      sessionCreateOutcome: result.outcome,
      ...(chatUrl ? { chatUrl } : {}),
    },
    id: result.session.id,
    rootSessionId: result.session.rootSessionId,
    nestedAgentDepth: result.session.nestedAgentDepth,
    effectiveMaxNestedAgentDepth: result.session.effectiveMaxNestedAgentDepth,
    nextAction: {
      tool: "session_get",
      arguments: { sessionId: result.session.id },
    },
  });
}
