import { AsyncLocalStorage } from "node:async_hooks";
import type { AttemptToolResult } from "@opengeni/contracts";

export type RecoverableMcpOperation = {
  operationId: string;
  sourceCallId?: string;
  serverId: string;
  originalTool: string;
  observerTool: string;
  destinationDigest: string;
  argumentDigest: string;
};

export type CapturedMcpOperation = RecoverableMcpOperation & { authorityDigest: string };

/** Worker-owned persistence. Its implementation must enforce canonical live
 * attempt identity and store no arguments, URLs, headers, or credentials. */
export type McpOperationPersistence = {
  capture: (operation: CapturedMcpOperation) => Promise<"created" | "existing">;
  settleOriginal: (
    input:
      | { operationId: string; outcome: "completed"; result: AttemptToolResult }
      | { operationId: string; outcome: "outcome_unknown" },
  ) => Promise<void>;
};

type DispatchContext = {
  operation: RecoverableMcpOperation;
  persistence: McpOperationPersistence;
  captureStarted: boolean;
  captured: boolean;
  closed: boolean;
};

const dispatchContext = new AsyncLocalStorage<DispatchContext>();

/** Presence is an execution-routing fact, not authorization. A closed context
 * remains visible to late callbacks so they still hit the dispatch fence. */
export function hasActiveRecoverableMcpOperation(): boolean {
  return dispatchContext.getStore() !== undefined;
}

export class McpOperationOutcomeUnknownError extends Error {
  readonly code = "mcp_operation_outcome_unknown";
  constructor(
    readonly operationId: string,
    cause: unknown,
  ) {
    super(
      `MCP operation ${operationId} has an unknown outcome. Read the existing operation result; do not repeat the mutation.`,
      { cause },
    );
    this.name = "McpOperationOutcomeUnknownError";
  }
}

/** Establish trusted in-process correlation around one gateway execution. */
export async function runRecoverableMcpOperation(
  operation: RecoverableMcpOperation,
  persistence: McpOperationPersistence,
  execute: () => Promise<AttemptToolResult>,
): Promise<AttemptToolResult> {
  const context: DispatchContext = {
    operation: { ...operation },
    persistence,
    captureStarted: false,
    captured: false,
    closed: false,
  };
  return await dispatchContext.run(context, async () => {
    let result: AttemptToolResult;
    try {
      try {
        result = await execute();
      } catch (error) {
        if (!context.captured) throw error;
        // An uncertain settlement acknowledgment cannot authorize replay or
        // replace the original recovery handle with a database-only error.
        try {
          await persistence.settleOriginal({
            operationId: operation.operationId,
            outcome: "outcome_unknown",
          });
        } catch {
          /* The pre-dispatch record remains the recovery authority. */
        }
        throw new McpOperationOutcomeUnknownError(operation.operationId, error);
      }
      if (!context.captured) {
        throw new Error("Recoverable MCP execution did not cross its durable capture boundary");
      }
      try {
        await persistence.settleOriginal({
          operationId: operation.operationId,
          outcome: "completed",
          result,
        });
      } catch (error) {
        // Never submit a second, contradictory settlement after an ambiguous
        // acknowledgment of the successful one.
        throw new McpOperationOutcomeUnknownError(operation.operationId, error);
      }
      return result;
    } finally {
      context.closed = true;
    }
  });
}

/** Called by the authorized broker immediately before the physical request.
 * A second dispatch with the same identity is never an observation. */
export async function captureMcpOperationDispatch(input: {
  operationId: string;
  serverId: string;
  toolName: string;
  destinationDigest: string;
  authorityDigest: string;
}): Promise<void> {
  const context = dispatchContext.getStore();
  if (!context) return;
  const operation = context.operation;
  if (
    input.operationId !== operation.operationId ||
    input.serverId !== operation.serverId ||
    input.toolName !== operation.originalTool ||
    input.destinationDigest !== operation.destinationDigest ||
    !/^[a-f0-9]{64}$/u.test(input.authorityDigest)
  )
    throw new Error("Recoverable MCP dispatch identity does not match its trusted binding");
  if (context.closed || context.captureStarted) {
    throw new Error("MCP operation dispatch is already claimed or closed");
  }
  context.captureStarted = true;
  const result = await context.persistence.capture({
    ...operation,
    authorityDigest: input.authorityDigest,
  });
  if (result !== "created")
    throw new Error("MCP operation was already dispatched; read its existing result");
  // The SDK may have timed out while capture was committing. Do not start a
  // mutation after its enclosing execution has already returned.
  if (context.closed) throw new Error("MCP operation dispatch closed during capture");
  context.captured = true;
}
