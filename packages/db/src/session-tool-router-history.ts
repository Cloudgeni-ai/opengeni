import { and, eq, sql } from "drizzle-orm";
import { type Database, withRlsContext } from "./database";
import * as schema from "./schema";

/**
 * Router items in a session's history. This must stay textually identical to
 * the predicate of session_history_items_tool_router_idx (migration 0806):
 * PostgreSQL only uses a partial index whose predicate the query implies, and
 * without it the probe parses every history item of a session that never used
 * the router.
 */
export const toolRouterHistoryItemPredicate = sql`(
          ${schema.sessionHistoryItems.item}->>'type' IN ('tool_search_call', 'tool_search_output')
          OR (${schema.sessionHistoryItems.item}->>'type' = 'function_call'
            AND ${schema.sessionHistoryItems.item}->>'name' IN ('tool_search', 'tool_list', 'tool_invoke'))
        )`;

export function toolRouterHistoryProbe(
  db: Pick<Database, "select">,
  input: { workspaceId: string; sessionId: string },
) {
  return db
    .select({ id: schema.sessionHistoryItems.id })
    .from(schema.sessionHistoryItems)
    .where(
      and(
        eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
        eq(schema.sessionHistoryItems.sessionId, input.sessionId),
        toolRouterHistoryItemPredicate,
      ),
    )
    .limit(1);
}

/** Historical router exposure is a protocol fact, not renewed tool authority. */
export async function sessionHasToolRouterHistory(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionId: string },
): Promise<boolean> {
  return withRlsContext(db, input, async (scopedDb) => {
    const rows = await toolRouterHistoryProbe(scopedDb, input);
    return rows.length > 0;
  });
}
