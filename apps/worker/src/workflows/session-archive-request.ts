import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
  ArchivedSessionRequest,
  SessionArchiveRestoreRequest,
} from "../activities/session-archive";

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

const restoreActivity = proxyActivities<Pick<typeof activities, "restoreArchivedSessions">>({
  startToCloseTimeout: "30 minutes",
  // A failed restore leaves the chat stored; the maintenance pass also
  // finishes a restore this workflow gives up on.
  retry: {
    initialInterval: "15 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 20,
  },
});

/**
 * Started when someone restores an archived chat whose content is in
 * long-term storage: puts that content back, chat by chat, and makes them
 * live again. Restoring one that is live already does nothing.
 */
export async function sessionArchiveRestoreWorkflow(
  input: SessionArchiveRestoreRequest,
): Promise<void> {
  await restoreActivity.restoreArchivedSessions(input);
}
