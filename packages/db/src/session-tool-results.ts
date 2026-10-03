import { and, eq, sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";
import * as schema from "./schema";

function historyCallId(item: Record<string, unknown>): string | null {
  if (typeof item.callId === "string") return item.callId;
  if (typeof item.call_id === "string") return item.call_id;
  return null;
}

/**
 * Model-visible results of one function tool in a session's active history,
 * position-ordered. A result counts only when its call is also active at an
 * earlier position, the same pairing the model read path requires. Compaction
 * marks superseded rows inactive, so a result that was compacted away is
 * absent here. The session comes from the caller's own authority, never from
 * model input.
 */
export async function getActiveSessionFunctionToolResults(
  db: Database,
  input: { workspaceId: string; sessionId: string; toolName: string },
): Promise<Array<{ position: number; item: Record<string, unknown> }>> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb
      .select({
        position: schema.sessionHistoryItems.position,
        item: schema.sessionHistoryItems.item,
        itemCodecVersion: schema.sessionHistoryItems.itemCodecVersion,
      })
      .from(schema.sessionHistoryItems)
      .where(
        and(
          eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
          eq(schema.sessionHistoryItems.sessionId, input.sessionId),
          eq(schema.sessionHistoryItems.active, true),
          sql`${schema.sessionHistoryItems.item}->>'type' in ('function_call', 'function_call_result')`,
          sql`${schema.sessionHistoryItems.item}->>'name' = ${input.toolName}`,
        ),
      )
      .orderBy(schema.sessionHistoryItems.position);
    const calls = new Set<string>();
    const results: Array<{ position: number; item: Record<string, unknown> }> = [];
    for (const row of rows) {
      const item = fromPostgresLosslessJson(row.item, row.itemCodecVersion);
      const callId = historyCallId(item);
      if (!callId) continue;
      if (item.type === "function_call") calls.add(callId);
      else if (calls.has(callId)) results.push({ position: row.position, item });
    }
    return results;
  });
}
