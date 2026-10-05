import type { CodemodeOperation } from "@opengeni/contracts";

/** Programmatic receipts are not open SDK calls. Exact arguments stay in protected storage. */
export function programmaticApproval(operation: CodemodeOperation) {
  return {
    id: operation.operationId,
    name: operation.identity.toolName,
    source: "codemode" as const,
    operationId: operation.operationId,
    requestId: operation.approvalRequestId,
  };
}

export function programmaticContinuationNote(
  operations: readonly CodemodeOperation[],
): string | undefined {
  if (operations.length === 0) return undefined;
  return [
    "Stored programmatic operations (durable server receipts):",
    ...operations.map(
      (operation) =>
        `${operation.operationId}: ${operation.state}${operation.errorCode ? ` (${operation.errorCode})` : ""}`,
    ),
    "Approval resumes the stored operation, not the earlier program's JavaScript stack. Read results with the current Codemode client's status/resume handle. Do not resubmit arguments for completed, running, waiting, or uncertain operations.",
  ].join("\n");
}
