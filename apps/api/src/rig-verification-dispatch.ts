export type RigVerificationDispatchInput =
  | {
      workspaceId: string;
      changeId: string;
      attemptId: string;
      workflowId: string;
      versionId?: never;
    }
  | {
      workspaceId: string;
      versionId: string;
      attemptId: string;
      workflowId: string;
      changeId?: never;
    };

export type RigVerificationPhysicalDispatch = RigVerificationDispatchInput & {
  executionGeneration: number;
  physicalWorkflowId: string;
};

export type RigVerificationDispatchDependencies = {
  getCurrentExecutionGeneration: (input: RigVerificationDispatchInput) => Promise<number | null>;
  advanceExecutionGeneration: (
    input: RigVerificationDispatchInput & { expectedExecutionGeneration: number },
  ) => Promise<number | null>;
  start: (input: RigVerificationPhysicalDispatch) => Promise<void>;
  describeStatus: (physicalWorkflowId: string) => Promise<string>;
  isAlreadyStarted: (error: unknown) => boolean;
};

export function rigVerificationPhysicalWorkflowId(
  logicalWorkflowId: string,
  executionGeneration: number,
): string {
  return `${logicalWorkflowId}-generation-${executionGeneration}`;
}

function normalizedWorkflowStatus(status: string): string {
  return status
    .trim()
    .toUpperCase()
    .replace(/^WORKFLOW_EXECUTION_STATUS_/u, "")
    .replace(/[ -]+/gu, "_");
}

export function rigVerificationClosedStatusRequiresNewGeneration(status: string): boolean {
  const normalized = normalizedWorkflowStatus(status);
  if (
    normalized === "FAILED" ||
    normalized === "CANCELED" ||
    normalized === "CANCELLED" ||
    normalized === "TERMINATED" ||
    normalized === "TIMED_OUT" ||
    normalized === "TIMEDOUT"
  ) {
    return true;
  }
  if (normalized === "RUNNING" || normalized === "COMPLETED" || normalized === "CONTINUED_AS_NEW") {
    return false;
  }
  throw new Error(`Unsupported Rig verification workflow status: ${status}`);
}

/**
 * Dispatch one logical verification attempt through immutable physical runs.
 * A failed run advances the database generation before another physical ID can
 * start; every worker settlement is fenced by that same generation.
 */
export async function dispatchRigVerification(
  input: RigVerificationDispatchInput,
  dependencies: RigVerificationDispatchDependencies,
): Promise<void> {
  let executionGeneration = await dependencies.getCurrentExecutionGeneration(input);
  while (executionGeneration !== null) {
    const physicalWorkflowId = rigVerificationPhysicalWorkflowId(
      input.workflowId,
      executionGeneration,
    );
    try {
      await dependencies.start({
        ...input,
        executionGeneration,
        physicalWorkflowId,
      });
      return;
    } catch (error) {
      if (!dependencies.isAlreadyStarted(error)) throw error;
    }

    const status = await dependencies.describeStatus(physicalWorkflowId);
    if (!rigVerificationClosedStatusRequiresNewGeneration(status)) {
      // Running and successful duplicates are idempotent acknowledgements for
      // this physical generation. Every unsuccessful closed run advances.
      return;
    }
    executionGeneration = await dependencies.advanceExecutionGeneration({
      ...input,
      expectedExecutionGeneration: executionGeneration,
    });
  }
}
