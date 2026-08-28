import type { TurnHistorySink } from "./history-sink";

/**
 * Persist the SDK's complete prior model/tool history before another provider
 * request can start. The first request has no prior model/tool rows to append.
 * Follow-up requests run only after the preceding complete call/result batch is
 * replay-safe.
 */
export async function checkpointHistoryBeforeProviderDispatch(
  historySink: Pick<TurnHistorySink, "reconcileConversationTruth">,
): Promise<void> {
  await historySink.reconcileConversationTruth({ requireDurable: true });
}
