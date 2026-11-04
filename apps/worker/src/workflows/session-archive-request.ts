import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { ArchivedSessionRequest } from "../activities/session-archive";

const stopActivity = proxyActivities<Pick<typeof activities, "stopArchivedSessionWork">>({
  startToCloseTimeout: "2 minutes",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" },
});

const storeActivity = proxyActivities<Pick<typeof activities, "storeArchivedSession">>({
  startToCloseTimeout: "30 minutes",
  // Cancelled work takes a moment to settle; after about two hours the
  // maintenance pass, which stores archived chats first, takes over.
  retry: {
    initialInterval: "15 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 30,
  },
});

/**
 * Started with a delay when a person archives a chat, so it runs when the
 * undo window ends: stops what still runs in the chat and stores it. An
 * undone Archive makes both steps do nothing.
 */
export async function sessionArchiveRequestWorkflow(input: ArchivedSessionRequest): Promise<void> {
  const { pending } = await stopActivity.stopArchivedSessionWork(input);
  if (!pending) return;
  try {
    await storeActivity.storeArchivedSession(input);
  } catch {
    // The maintenance pass is the backstop for a chat that is slow to settle.
  }
}
