import {
  releaseSessionAdmissionBlocksAfterAccessChange,
  type Database,
  type SessionAdmissionAccessChange,
} from "@opengeni/db";

export type AdmissionReleaseDependencies = {
  db: Database;
  /** Deliver the registered wakes now instead of on the dispatcher's next pass. */
  requestSessionWorkflowWakeDispatch?: (() => Promise<void>) | undefined;
};

/**
 * After access changes, start saved messages that were waiting on it. Never
 * fails the change that caused it: the change is already committed, and a
 * chat that is not released here still starts on Resume or its next message.
 */
export async function releaseAdmissionBlocksAfterAccessChange(
  deps: AdmissionReleaseDependencies,
  input: {
    accountId: string;
    workspaceId: string;
    change: SessionAdmissionAccessChange;
    sessionIds?: readonly string[];
  },
): Promise<void> {
  try {
    const result = await releaseSessionAdmissionBlocksAfterAccessChange(deps.db, input);
    if (result.released.length + result.nudged.length > 0) {
      await deps.requestSessionWorkflowWakeDispatch?.();
    }
  } catch (error) {
    console.warn("Could not start saved messages after an access change", {
      workspaceId: input.workspaceId,
      change: input.change,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
