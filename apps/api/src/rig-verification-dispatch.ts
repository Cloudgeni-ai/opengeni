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
    if (status !== "FAILED") {
      // Running and every non-failed terminal state are idempotent dispatch
      // acknowledgements for this physical generation.
      return;
    }
    executionGeneration = await dependencies.advanceExecutionGeneration({
      ...input,
      expectedExecutionGeneration: executionGeneration,
    });
  }
}
