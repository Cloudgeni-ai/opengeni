import {
  MCP_MUTATION_RECEIPT_VERSION,
  McpMutationReceipt,
  type McpMutationReceiptType,
} from "@opengeni/contracts";

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

export type SessionCreateReceiptResult = {
  session: {
    id: string;
    queueVersion: number;
    status: string;
    sandboxGroupId: string;
    parentSessionId: string | null;
  };
  outcome: "created" | "repaired" | "replayed";
  changed: boolean;
  usageRecording: "recorded" | "failed";
};

/** Project committed session-create truth without copying request fields. */
export function sessionCreateMutationReceipt(
  result: SessionCreateReceiptResult,
  idempotencyKeyRequested: boolean,
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
    },
    nextAction: {
      tool: "session_get",
      arguments: { sessionId: result.session.id },
    },
  });
}
