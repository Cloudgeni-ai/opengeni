import type { Database, SessionActivityDatabase } from "./database";
import { deleteSubscriptionCoreWaitersForTurns } from "./subscription-core/waiters";
import { subscriptionCoreProviderIds } from "./subscription-core-providers";

/** Delete every registered provider's core waiters of turns whose wait a Steer or Cancel ended. */
export async function deleteSubscriptionCoreWaitersOfEveryProviderForTurns(
  db: Database | SessionActivityDatabase,
  input: { workspaceId: string; turnIds: readonly string[]; sessionId?: string },
): Promise<number> {
  let deleted = 0;
  for (const provider of subscriptionCoreProviderIds()) {
    deleted += await deleteSubscriptionCoreWaitersForTurns(db, provider, input);
  }
  return deleted;
}
