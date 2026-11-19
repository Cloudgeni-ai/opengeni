import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
  OrgAgentPublishMoveCursor,
  OrgAgentPublishMoveInput,
} from "../activities/org-agent-publish-move";

const moveActivity = proxyActivities<
  Pick<
    typeof activities,
    "beginOrgAgentPublishMove" | "moveOrgAgentChatsBatch" | "finishOrgAgentPublishMove"
  >
>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 10,
  },
});

/** First wait before scanning again for deferred chats, doubled up to the cap. */
const DEFERRED_RETRY_INITIAL_MS = 30_000;
const DEFERRED_RETRY_MAX_MS = 10 * 60_000;
/** After this, chats still deferred count as failed. */
const DEFERRED_RETRY_LIMIT_MS = 6 * 60 * 60_000;

/**
 * A publish that moves running chats (started by the API with the publish
 * operation's id): moves every chat of the agent to the published version in
 * batches. Chats busy with a turn or waiting on a person are moved on later
 * scans; the operation records the moved and failed counts.
 */
export async function orgAgentPublishMoveWorkflow(input: OrgAgentPublishMoveInput): Promise<void> {
  const start = await moveActivity.beginOrgAgentPublishMove(input);
  if (!start.proceed) return;
  if (!start.moveRunningChats) {
    await moveActivity.finishOrgAgentPublishMove({
      ...input,
      status: "succeeded",
      remainingDeferred: 0,
    });
    return;
  }
  const startedAt = Date.now();
  let delayMs = DEFERRED_RETRY_INITIAL_MS;
  let deferred = 0;
  for (;;) {
    // One full scan over the agent's workspaces.
    deferred = 0;
    let cursor: OrgAgentPublishMoveCursor = { workspaceIndex: 0, afterSessionId: null };
    let superseded = false;
    for (;;) {
      const batch = await moveActivity.moveOrgAgentChatsBatch({
        ...input,
        toVersion: start.toVersion,
        cursor,
      });
      deferred += batch.deferred;
      cursor = batch.cursor;
      if (batch.superseded) superseded = true;
      if (batch.done) break;
    }
    if (superseded) {
      // A newer publish moves the chats; this one ends with what it moved and
      // records why it stopped early.
      await moveActivity.finishOrgAgentPublishMove({
        ...input,
        status: "succeeded",
        remainingDeferred: 0,
        failureReason: "superseded",
      });
      return;
    }
    if (deferred === 0) break;
    if (Date.now() - startedAt + delayMs > DEFERRED_RETRY_LIMIT_MS) break;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, DEFERRED_RETRY_MAX_MS);
  }
  await moveActivity.finishOrgAgentPublishMove({
    ...input,
    status: deferred === 0 ? "succeeded" : "failed",
    remainingDeferred: deferred,
  });
}
