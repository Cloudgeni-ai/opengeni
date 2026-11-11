import { and, eq, inArray, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "../database";
import { sessionTurns, sessionHistoryItems } from "../schema";

/** Read only provenance for the already-scoped canonical history rows. */
export async function readSubscriptionHistoryProvenance(
  db: Database,
  workspaceId: string,
  sessionId: string,
  historyIds: readonly string[],
): Promise<{ turnByHistoryId: Map<string, string>; turnMetadata: Map<string, unknown> }> {
  const ids = [...new Set(historyIds)];
  if (!ids.length) return { turnByHistoryId: new Map(), turnMetadata: new Map() };
  return withWorkspaceRls(db, workspaceId, async (tx) => {
    const entries: Array<[string, unknown]> = [];
    const turnByHistoryId = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += 256) {
      const rows = await tx
        .select({
          id: sessionTurns.id,
          metadata: sessionTurns.metadata,
          historyId: sessionHistoryItems.id,
        })
        .from(sessionHistoryItems)
        .innerJoin(
          sessionTurns,
          and(
            eq(sessionTurns.id, sessionHistoryItems.turnId),
            eq(sessionTurns.workspaceId, sessionHistoryItems.workspaceId),
            eq(sessionTurns.sessionId, sessionHistoryItems.sessionId),
          ),
        )
        .where(
          and(
            eq(sessionTurns.workspaceId, workspaceId),
            eq(sessionTurns.sessionId, sessionId),
            inArray(sessionHistoryItems.id, ids.slice(offset, offset + 256)),
          ),
        );
      entries.push(...rows.map((row) => [row.id, row.metadata] as [string, unknown]));
      for (const row of rows) turnByHistoryId.set(row.historyId, row.id);
    }
    return { turnByHistoryId, turnMetadata: new Map(entries) };
  });
}

/** Called under recovery's turn write fence, before closing the attempt.
 * No provider/registry filter: removed-source unknown outcomes still block.
 * Media/probe requests are not model outcomes. Nothing is settled by this read.
 */
export async function assertSubscriptionServingRecoverySettledTx(
  tx: Database,
  scope: { accountId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<void> {
  const [row] = await rawRows<{ unresolved: boolean }>(
    tx,
    sql`select exists (
    select 1 from subscription_operation_leases where account_id = ${scope.accountId}::uuid
      and workspace_id = ${scope.workspaceId}::uuid and session_id = ${scope.sessionId}::uuid
      and turn_id = ${scope.turnId}::uuid and operation_kind = 'model'
      and request_id is not null and request_outcome in ('reserved', 'unknown')
  ) as unresolved`,
  );
  if (!row || row.unresolved)
    throw new Error("Subscription serving switch has unresolved model requests");
}
