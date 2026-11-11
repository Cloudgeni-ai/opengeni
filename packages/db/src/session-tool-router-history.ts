import { and, eq, sql, type SQL } from "drizzle-orm";
import { type Database, isTransactionHandle, rawRows, withRlsContext } from "./database";
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
  input: { workspaceId: string; sessionId: string | SQL },
) {
  return db
    .select({ present: sql<number>`1` })
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

/** The same indexed history fact for a response page, with one scoped transaction. */
export async function sessionsWithToolRouterHistory(
  db: Database,
  input: { accountId: string; workspaceId: string; sessionIds: readonly string[] },
): Promise<Set<string>> {
  const sessionIds = [...new Set(input.sessionIds)];
  if (sessionIds.length === 0) return new Set();
  return withRlsContext(db, input, async (scopedDb) => {
    // Keep LIMIT 1 inside each keyed probe: grouping all matching history rows
    // would scan every retained router item in long-running sessions.
    const probe = toolRouterHistoryProbe(scopedDb, {
      workspaceId: input.workspaceId,
      sessionId: sql`requested.session_id`,
    });
    // Only a plain index scan stops each probe at its first router item. The
    // planner prices a probe for an unknown requested session at a few rows, so
    // a bitmap scan costs within a few percent and wins on small statistics
    // shifts; it collects every router item of the session before LIMIT 1 can
    // stop. Rule bitmap scans out for this scope only.
    const [previous] = isTransactionHandle(db)
      ? await rawRows<{ setting: string }>(
          scopedDb,
          sql`select current_setting('enable_bitmapscan') as setting`,
        )
      : [];
    await scopedDb.execute(sql`select set_config('enable_bitmapscan', 'off', true)`);
    const rows = await rawRows<{ sessionId: string }>(
      scopedDb,
      sql`
      select requested.session_id as "sessionId"
      from unnest(${sql.param(sessionIds)}::uuid[]) as requested(session_id)
      cross join lateral (${probe}) found
    `,
    );
    // A released savepoint keeps transaction-local settings; restore the
    // caller's. A failed probe rolls the savepoint, and the setting, back.
    if (previous) {
      await scopedDb.execute(
        sql`select set_config('enable_bitmapscan', ${previous.setting}, true)`,
      );
    }
    return new Set(rows.map((row) => row.sessionId));
  });
}
