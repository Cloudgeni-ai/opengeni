import type { Database, SessionActivityDatabase } from "./database";
import { deleteSubscriptionCoreWaitersForTurns } from "./subscription-core/waiters";
import { SUBSCRIPTION_CORE_CODEX_PROVIDER } from "./subscription-core-codex-provider";
import { subscriptionCoreProviderIds } from "./subscription-core-providers";

/** Delete the core's Codex waiters of turns whose wait a Steer or Cancel ended. */
export function deleteSubscriptionCoreCodexWaitersForTurns(
  db: Database | SessionActivityDatabase,
  input: { workspaceId: string; turnIds: readonly string[]; sessionId?: string },
): Promise<number> {
  return deleteSubscriptionCoreWaitersForTurns(db, SUBSCRIPTION_CORE_CODEX_PROVIDER, input);
}

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
