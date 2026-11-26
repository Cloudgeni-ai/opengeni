import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withAccountRls, withRlsContext } from "./database";

export type SessionTurnCreditTotalsCheck = {
  /** Ready turns whose kept totals were compared with a full recount. */
  checked: number;
  /** Those whose kept `usage` differs from the recount. */
  mismatchedTurnIds: string[];
};

/**
 * Drift check for the per-turn credit totals (migration 1599): for each given
 * account, up to `turnsPerAccount` turns with ready, exact kept rows, chosen
 * at a random point of the turn id space, compare the terminal `usage` the
 * kept rows give (session_turn_credit_usage_kept_v1) with the full sum the
 * terminal trigger falls back to (session_turn_credit_usage_full_v1). Both
 * run in one statement of a repeatable-read transaction in the turn's own
 * tenant scope, so concurrent writes never show as drift; a turn not visible
 * in that scope (or not kept) is skipped. Any mismatch means a trigger missed
 * a change.
 */
export async function checkSessionTurnCreditTotals(
  db: Database,
  accountIds: readonly string[],
  turnsPerAccount = 4,
): Promise<SessionTurnCreditTotalsCheck> {
  const result: SessionTurnCreditTotalsCheck = { checked: 0, mismatchedTurnIds: [] };
  for (const accountId of accountIds) {
    const turns = await withAccountRls(db, accountId, async (tx) =>
      rawRows<{ turn_id: string; workspace_id: string; session_id: string }>(
        tx,
        sql`
        with start as (select gen_random_uuid() as id),
        sampled as (
          (select total.turn_id, total.workspace_id, total.session_id, 0 as pass
            from session_turn_credit_totals total, start
            where total.account_id = ${accountId} and total.side = 'events'
              and total.ready and total.exact and total.turn_id >= start.id
            order by total.turn_id limit ${turnsPerAccount})
          union all
          (select total.turn_id, total.workspace_id, total.session_id, 1 as pass
            from session_turn_credit_totals total, start
            where total.account_id = ${accountId} and total.side = 'events'
              and total.ready and total.exact and total.turn_id < start.id
            order by total.turn_id limit ${turnsPerAccount})
        )
        select turn_id, workspace_id, session_id from sampled
        order by pass, turn_id limit ${turnsPerAccount}`,
      ),
    );
    for (const turn of turns) {
      const [row] = await withRlsContext(
        db,
        { accountId, workspaceId: turn.workspace_id },
        async (tx) =>
          rawRows<{ differs: boolean }>(
            tx,
            sql`
            select compared.kept is distinct from compared.full as differs
            from (
              select opengeni_private.session_turn_credit_usage_kept_v1(
                  ${accountId}::uuid, ${turn.workspace_id}::uuid, ${turn.session_id}::uuid, ${turn.turn_id}::uuid) as kept,
                opengeni_private.session_turn_credit_usage_full_v1(
                  ${accountId}::uuid, ${turn.workspace_id}::uuid, ${turn.session_id}::uuid, ${turn.turn_id}::uuid) as full
              where exists (select 1 from session_turns turn
                where turn.id = ${turn.turn_id}::uuid and turn.session_id = ${turn.session_id}::uuid
                  and turn.workspace_id = ${turn.workspace_id}::uuid)
            ) compared
            where compared.kept is not null`,
          ),
        { isolationLevel: "repeatable read" },
      );
      if (!row) continue;
      result.checked += 1;
      if (row.differs) result.mismatchedTurnIds.push(turn.turn_id);
    }
  }
  return result;
}
