import { and, eq, inArray } from "drizzle-orm";
import type { ProviderId } from "@opengeni/subscriptions";
import type { Database, SessionActivityDatabase } from "../database";
import * as schema from "../schema";

/**
 * Delete the shared subscription core's waiters for one provider of turns
 * whose wait a human or control transition ended (Steer, Cancel), inside
 * that transition. A core waiter exists only while its turn waits, so unlike
 * the legacy waiter there is no `superseded` status to keep; its pending
 * wake deliveries cascade. Runs under the caller's workspace RLS.
 */
export async function deleteSubscriptionCoreWaitersForTurns(
  db: Database | SessionActivityDatabase,
  provider: ProviderId,
  input: { workspaceId: string; turnIds: readonly string[]; sessionId?: string },
): Promise<number> {
  if (input.turnIds.length === 0) return 0;
  const deleted = await db
    .delete(schema.subscriptionCapacityWaiters)
    .where(
      and(
        eq(schema.subscriptionCapacityWaiters.workspaceId, input.workspaceId),
        ...(input.sessionId
          ? [eq(schema.subscriptionCapacityWaiters.sessionId, input.sessionId)]
          : []),
        eq(schema.subscriptionCapacityWaiters.provider, provider),
        inArray(schema.subscriptionCapacityWaiters.turnId, [...input.turnIds]),
      ),
    )
    .returning({ waiterId: schema.subscriptionCapacityWaiters.waiterId });
  return deleted.length;
}
