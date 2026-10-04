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

/**
 * Recover committed programmatic approval waits/results before the first model
 * request without turning lazy MCP preparation into a first-request barrier.
 *
 * Only eager servers may gate the first request. Resuming a stored operation
 * needs the prepared attempt tool environment, so this waits for full tool
 * preparation only when there is something to resume: an approval decision
 * trigger, or a cheap durable read showing unfinished operations for this
 * logical turn (which covers every recovery that has stored work). Every other
 * turn sends its first request without waiting on any lazy server.
 */
export async function recoverProgrammaticOperationsBeforeFirstRequest(input: {
  approvalDecisionId: string | undefined;
  hasUnfinishedOperations: () => Promise<boolean>;
  toolPreparationReady: Promise<void> | null;
  resumeApproved: (
    decisionOperationId: string | undefined,
  ) => Promise<CodemodeOperation[]> | undefined;
}): Promise<CodemodeOperation[]> {
  if (input.approvalDecisionId === undefined && !(await input.hasUnfinishedOperations())) {
    return [];
  }
  await input.toolPreparationReady;
  return (await input.resumeApproved(input.approvalDecisionId)) ?? [];
}
