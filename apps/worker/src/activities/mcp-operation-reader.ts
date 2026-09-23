import type { AttemptToolResult } from "@opengeni/contracts";
import { observeMcpOperation, type McpObservationReceipt } from "@opengeni/runtime";
import type { McpOperationReadSelector } from "./agent-turn/mcp-operation-read-tool";

type TerminalReceipt = Extract<McpObservationReceipt, { status: "completed" }>;

/** Internal, credential-free projection loaded through canonical current
 * attempt/session authorization. Never return this object directly to tools. */
export type McpOperationReadRecord = {
  operationId: string;
  sourceTurnId: string;
  sourceCallId: string | null;
  serverId: string;
  originalTool: string;
  observerTool: string;
  argumentDigest: string;
  destinationDigest: string;
  authorityDigest: string;
  originalOutcome: "captured" | "completed" | "outcome_unknown";
  originalResult: AttemptToolResult | null;
  receipt: TerminalReceipt | null;
};

type ObserverResolution =
  | { status: "unsupported" | "auth_needed" | "binding_changed" }
  | {
      status: "ready";
      authorize: (phase: "before_request" | "before_delivery") => Promise<boolean>;
      callObserver: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
    };

export type McpOperationReaderDependencies = {
  /** Includes live attempt and original-principal/session disclosure checks. */
  load: (selector: McpOperationReadSelector) => Promise<McpOperationReadRecord | null>;
  claim: (operationId: string) => Promise<string | null>;
  release: (operationId: string, claimId: string) => Promise<void>;
  /** Claim-fenced transaction storing one immutable receipt. Must recheck
   * canonical current authority and never rewrite the original outcome.
   * Delivery uses the ordinary operation_read tool-result lifecycle. */
  settle: (
    operationId: string,
    claimId: string,
    receipt: TerminalReceipt,
  ) => Promise<McpOperationReadRecord>;
  /** Binds the current trusted config/connection to the persisted original
   * digests. Model arguments may not supply or replace any of that authority. */
  resolveObserver: (operation: McpOperationReadRecord) => Promise<ObserverResolution>;
};

/** One explicit read; no timer, inference wake, or mutation replay. */
export async function readMcpOperation(
  selector: McpOperationReadSelector,
  dependencies: McpOperationReaderDependencies,
): Promise<Record<string, unknown>> {
  const operation = await dependencies.load(selector);
  if (!operation) throw new Error("MCP operation is unavailable");
  if (operation.receipt || operation.originalOutcome === "completed") return project(operation);

  const observer = await dependencies.resolveObserver(operation);
  if (observer.status !== "ready") return project(operation, { status: observer.status });
  const claimId = await dependencies.claim(operation.operationId);
  if (!claimId) {
    // A competing reader may have committed after our initial load. Re-read
    // under current authority instead of returning an old cached projection.
    const fresh = await dependencies.load({ operationId: operation.operationId });
    if (!fresh) throw new Error("MCP operation is unavailable");
    return project(
      fresh,
      fresh.receipt || fresh.originalOutcome === "completed"
        ? undefined
        : { status: "observation_in_progress" },
    );
  }
  let settled = false;
  try {
    const receipt = await observeMcpOperation({
      binding: {
        operationId: operation.operationId,
        serverId: operation.serverId,
        originalTool: operation.originalTool,
        observerTool: operation.observerTool,
        argumentDigest: operation.argumentDigest,
      },
      authorize: observer.authorize,
      callObserver: observer.callObserver,
    });
    if (receipt.status !== "completed") return project(operation, receipt);
    const recorded = await dependencies.settle(operation.operationId, claimId, receipt);
    settled = true;
    return project(recorded);
  } finally {
    if (!settled) await dependencies.release(operation.operationId, claimId);
  }
}

function project(
  operation: McpOperationReadRecord,
  observation?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    original: { turnId: operation.sourceTurnId, sourceCallId: operation.sourceCallId },
    invocationOutcome:
      operation.originalOutcome === "captured" ? "outcome_unknown" : operation.originalOutcome,
    ...(operation.originalOutcome === "completed" ? { result: operation.originalResult } : {}),
    observation: observation ?? operation.receipt ?? { status: "unknown" },
  };
}
