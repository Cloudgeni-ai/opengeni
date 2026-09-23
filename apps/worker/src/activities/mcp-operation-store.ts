import { AttemptToolResult } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  readMcpOperation as readStoredMcpOperation,
  claimMcpOperationObservation,
  releaseMcpOperationObservation,
  settleMcpOperationObservation,
  type McpOperationAttempt,
  type McpOperationRecord,
} from "@opengeni/db/mcp-operations";
import type {
  McpOperationReaderDependencies,
  McpOperationReadRecord,
} from "./mcp-operation-reader";

/** All DB calls remain bound to the actual accepted worker attempt. Locators
 * supplied to operation_read cannot replace this scope or its principal. */
export function createMcpOperationReadStore(
  db: Database,
  attempt: McpOperationAttempt,
): Pick<McpOperationReaderDependencies, "load" | "claim" | "release" | "settle"> {
  const current = { ...attempt };
  const load: McpOperationReaderDependencies["load"] = async (selector) => {
    const found = await readStoredMcpOperation(db, current, selector);
    if (found.status === "ambiguous") {
      throw new Error("MCP source call matches multiple operations; select an exact operationId");
    }
    return found.status === "found" ? projectRecord(found.operation) : null;
  };
  return {
    load,
    claim: async (operationId) => {
      const result = await claimMcpOperationObservation(db, current, operationId);
      return result.status === "claimed" ? result.claimId : null;
    },
    release: async (operationId, claimId) => {
      await releaseMcpOperationObservation(db, current, { operationId, claimId });
    },
    settle: async (operationId, claimId, receipt) => {
      const outcome = await settleMcpOperationObservation(db, current, {
        operationId,
        claimId,
        receiptRevision: receipt.receiptRevision,
        result: receipt.result,
      });
      if (outcome.status === "conflict") {
        throw new Error(
          "MCP provider returned conflicting terminal receipts; the first receipt is preserved",
        );
      }
      if (
        outcome.status !== "settled" &&
        outcome.status !== "existing" &&
        outcome.status !== "original_completed"
      ) {
        throw new Error(
          "MCP observation claim is no longer current; read the existing operation again",
        );
      }
      const recorded = await load({ operationId });
      if (!recorded) throw new Error("MCP operation is unavailable");
      return recorded;
    },
  };
}

function projectRecord(record: McpOperationRecord): McpOperationReadRecord {
  if (record.observationResult !== null && record.receiptRevision === null) {
    throw new Error("Stored MCP operation receipt is incomplete");
  }
  return {
    operationId: record.operationId,
    sourceTurnId: record.sourceTurnId,
    sourceCallId: record.sourceCallId,
    serverId: record.serverId,
    originalTool: record.originalTool,
    observerTool: record.observerTool,
    argumentDigest: record.argumentDigest,
    destinationDigest: record.destinationDigest,
    authorityDigest: record.authorityDigest,
    // Capture precedes the physical request; after a crash it is not proof
    // that the mutation was or was not sent. It never authorizes a replay.
    originalOutcome: record.originalOutcome,
    originalResult:
      record.originalResult === null ? null : AttemptToolResult.parse(record.originalResult),
    receipt:
      record.observationResult === null
        ? null
        : {
            version: 1,
            operationRef: record.operationId,
            fingerprint: { version: 1, algorithm: "sha256", value: record.argumentDigest },
            status: "completed",
            receiptRevision: record.receiptRevision!,
            result: AttemptToolResult.parse(record.observationResult),
          },
  };
}
