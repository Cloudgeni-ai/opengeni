import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const sweepActivity = proxyActivities<Pick<typeof activities, "sweepKnowledgeBanks">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded dirty-workspace sweep; the Temporal Schedule owns the cadence. */
export async function knowledgeBankSweepWorkflow(): Promise<void> {
  await sweepActivity.sweepKnowledgeBanks();
}
