import { continueAsNew, defineSignal, setHandler, workflowInfo } from "@temporalio/workflow";
import type { RunKnowledgeSourceSyncBatchInput } from "../activities";
import { knowledgeSourceSyncActivity } from "./activities";

export type KnowledgeSourceSyncWorkflowInput = RunKnowledgeSourceSyncBatchInput;

export const knowledgeSourceSyncWake =
  defineSignal<[KnowledgeSourceSyncWorkflowInput]>("knowledgeSourceSyncWake");

type KnowledgeSourceSyncWorkflowState = {
  pending: KnowledgeSourceSyncWorkflowInput | null;
  batchesThisRun: number;
};

const MAX_BATCHES_PER_WORKFLOW_RUN = 50;

/** One stable workflow ID serializes all fires for a source. Signals retain at
 * most one newest pending wake; Postgres lease/checkpoint rows remain the
 * authoritative overlap and resumability fence across workflow generations. */
export async function knowledgeSourceSyncWorkflow(
  input: KnowledgeSourceSyncWorkflowInput,
  carried?: KnowledgeSourceSyncWorkflowState,
): Promise<void> {
  let current = input;
  let pending = carried?.pending ?? null;
  let batchesThisRun = carried?.batchesThisRun ?? 0;

  setHandler(knowledgeSourceSyncWake, (next) => {
    if (
      next.accountId !== input.accountId ||
      next.workspaceId !== input.workspaceId ||
      next.sourceId !== input.sourceId
    ) {
      return;
    }
    pending = next;
  });

  while (true) {
    const result = await knowledgeSourceSyncActivity.runKnowledgeSourceSyncBatch(current);
    batchesThisRun += 1;

    if (result.action === "continue") {
      if (workflowInfo().continueAsNewSuggested || batchesThisRun >= MAX_BATCHES_PER_WORKFLOW_RUN) {
        await continueAsNew<typeof knowledgeSourceSyncWorkflow>(current, {
          pending,
          batchesThisRun: 0,
        });
      }
      continue;
    }

    if (
      (result.action === "complete" || result.action === "failed") &&
      result.bufferedScheduledTaskRunId
    ) {
      current = {
        ...current,
        scheduledTaskRunId: result.bufferedScheduledTaskRunId,
      };
      pending = null;
      continue;
    }

    if (pending) {
      current = pending;
      pending = null;
      if (workflowInfo().continueAsNewSuggested || batchesThisRun >= MAX_BATCHES_PER_WORKFLOW_RUN) {
        await continueAsNew<typeof knowledgeSourceSyncWorkflow>(current, {
          pending: null,
          batchesThisRun: 0,
        });
      }
      continue;
    }

    return;
  }
}

export function knowledgeSourceSyncWorkflowId(sourceId: string): string {
  return `knowledge-source-sync-${sourceId}`;
}
