import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const indexing = proxyActivities<Pick<typeof activities, "indexKnowledge">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** Rebuild derived search projections; this is not a source-ingestion task. */
export async function knowledgeIndexingWorkflow(): Promise<void> {
  await indexing.indexKnowledge();
}
