import { continueAsNew, proxyActivities, sleep, workflowInfo } from "@temporalio/workflow";
import type { AccountDeletionWorkHandle } from "../activities/account-deletion";
import type { advanceAccountDeletion } from "../activities";

const activities = proxyActivities<{ advanceAccountDeletion: typeof advanceAccountDeletion }>({
  startToCloseTimeout: "90 seconds",
  retry: { initialInterval: "10 seconds", maximumInterval: "5 minutes" },
});

export async function accountDeletionWorkflow(input: AccountDeletionWorkHandle): Promise<void> {
  for (let step = 0; step < 100; step++) {
    const result = await activities.advanceAccountDeletion(input);
    if (result.done) return;
    if (result.waitMs > 0) await sleep(result.waitMs);
    if (workflowInfo().continueAsNewSuggested) break;
  }
  await continueAsNew<typeof accountDeletionWorkflow>(input);
}
