import { AttemptToolResult } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import {
  fromPostgresLosslessJson,
  toPostgresLosslessJson,
  LOSSLESS_CONTENT_CODEC_VERSION,
} from "./lossless-json";

/** Worker-authenticated invocation identity, never model/HTTP/request JSON.
 * Possessing a DB handle or matching GUCs does NOT authenticate a caller.
 * Bind this tuple only after verifying the worker invocation credential. SQL
 * then derives the principal and rechecks canonical live disclosure authority. */
export type McpOperationAttempt = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

/** Structurally aligned with runtime CapturedMcpOperation, without a runtime dependency. */
export type CaptureMcpOperationInput = {
  operationId: string;
  sourceCallId?: string;
  serverId: string;
  originalTool: string;
  observerTool: string;
  destinationDigest: string;
  argumentDigest: string;
  authorityDigest: string;
};
export type McpOperationSelector =
  | { operationId: string }
  | { sourceTurnId: string; sourceCallId: string };
export type McpOperationRecord = Omit<CaptureMcpOperationInput, "sourceCallId"> & {
  sourceCallId: string | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sourceTurnId: string;
  sourceAttemptId: string;
  sourceExecutionGeneration: number;
  principalKind: "subject" | "service";
  principalId: string;
  /** captured means possibly dispatched, NEVER permission to replay a mutation. */
  originalOutcome: "captured" | "completed" | "outcome_unknown";
  originalResult: AttemptToolResult | null;
  observationResult: AttemptToolResult | null;
  receiptRevision: string | null;
  receiptDigest: string | null;
};
export type McpOperationLookup =
  | { status: "found"; operation: McpOperationRecord }
  | { status: "not_found" | "ambiguous" };

async function command<T>(
  db: Database,
  attempt: McpOperationAttempt,
  action: string,
  payload: object,
): Promise<T> {
  return withRlsContext(
    db,
    { accountId: attempt.accountId, workspaceId: attempt.workspaceId },
    async (tx) => {
      const result =
        await tx.execute(sql`select mcp_operation_command(${JSON.stringify(attempt)}::jsonb,
      ${action}::text, ${JSON.stringify(payload)}::jsonb) as value`);
      const rows = Array.isArray(result) ? result : result.rows;
      if (!rows?.[0]) throw new Error("MCP operation command returned no receipt");
      return rows[0].value as T;
    },
    undefined,
    "none", // SQL owns membership -> tenancy -> control -> session lock order.
  );
}

export function captureMcpOperation(
  db: Database,
  attempt: McpOperationAttempt,
  operation: CaptureMcpOperationInput,
) {
  return command<"created" | "existing">(db, attempt, "capture", operation);
}
export async function settleOriginalMcpOperation(
  db: Database,
  attempt: McpOperationAttempt,
  input:
    | { operationId: string; outcome: "completed"; result: AttemptToolResult }
    | { operationId: string; outcome: "outcome_unknown" },
): Promise<void> {
  const payload =
    input.outcome === "completed"
      ? {
          ...input,
          result: toPostgresLosslessJson(AttemptToolResult.parse(input.result)),
          resultCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
        }
      : input;
  const result = await command<{ status: string }>(db, attempt, "settle_original", payload);
  if (result.status !== "settled") throw new Error("Original MCP operation not found");
}
export async function readMcpOperation(
  db: Database,
  attempt: McpOperationAttempt,
  selector: McpOperationSelector,
): Promise<McpOperationLookup> {
  const result = await command<McpOperationLookup>(db, attempt, "read", selector);
  if (result.status !== "found") return result;
  const { originalResultCodecVersion, observationResultCodecVersion, ...operation } =
    result.operation as McpOperationRecord & {
      originalResultCodecVersion: number | null;
      observationResultCodecVersion: number | null;
    };
  return {
    status: "found",
    operation: {
      ...operation,
      originalResult: fromPostgresLosslessJson(
        operation.originalResult,
        originalResultCodecVersion,
      ),
      observationResult: fromPostgresLosslessJson(
        operation.observationResult,
        observationResultCodecVersion,
      ),
    },
  };
}
/** Claims authorize only the read observer; expiry never authorizes a mutation. */
export function claimMcpOperationObservation(
  db: Database,
  attempt: McpOperationAttempt,
  operationId: string,
) {
  return command<
    { status: "claimed"; claimId: string } | { status: "busy" | "terminal" | "not_found" }
  >(db, attempt, "claim_read", { operationId });
}
export function settleMcpOperationObservation(
  db: Database,
  attempt: McpOperationAttempt,
  input: {
    operationId: string;
    claimId: string;
    receiptRevision: string;
    result: AttemptToolResult;
  },
) {
  // This atomically stores one receipt, not an autonomous session notification.
  // Explicit operation_read is a new ordinary tool call: its existing result
  // lifecycle delivers the evidence. Repeated explicit reads legitimately have
  // distinct call outputs while the original timeout and receipt stay immutable.
  return command<
    | { status: "settled" | "existing" | "conflict"; receiptDigest: string }
    | { status: "stale_claim" | "not_found" | "original_completed" }
  >(db, attempt, "settle_observation", {
    ...input,
    result: toPostgresLosslessJson(AttemptToolResult.parse(input.result)),
    resultCodecVersion: LOSSLESS_CONTENT_CODEC_VERSION,
  });
}

/** Unknown/pending/error cleanup only; never releases or replaces a receipt. */
export function releaseMcpOperationObservation(
  db: Database,
  attempt: McpOperationAttempt,
  input: { operationId: string; claimId: string },
) {
  return command<{ status: "released" | "stale_claim" | "terminal" | "not_found" }>(
    db,
    attempt,
    "release_read",
    input,
  );
}

/** Bind only inside the trusted worker, after exact invocation authentication.
 * Provider authorization and immutable binding fences remain the broker's job. */
export function createMcpOperationPersistence(db: Database, attempt: McpOperationAttempt) {
  const frozen = { ...attempt };
  return {
    capture: (operation: CaptureMcpOperationInput) => captureMcpOperation(db, frozen, operation),
    settleOriginal: (input: Parameters<typeof settleOriginalMcpOperation>[2]) =>
      settleOriginalMcpOperation(db, frozen, input),
  };
}
