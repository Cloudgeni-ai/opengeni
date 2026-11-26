import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withAccountRls, withRlsContext } from "./database";

export type SessionTurnCreditTotalsCheck = {
  /** Ready turns whose kept totals were compared with a full recount. */
  checked: number;
  /** Sampled turns not compared: too many calls, or the recount ran out of time. */
  skipped: number;
  /** Those whose kept `usage` differs from the recount. */
  mismatchedTurnIds: string[];
};

export type SessionTurnCreditTotalsCheckBounds = {
  /** Turns sampled per account. */
  turnsPerAccount?: number;
  /** A turn with more kept call rows than this is skipped (its recount is the slow query). */
  maxCalls?: number;
  /** Per-turn bound on the comparison statement. */
  statementTimeoutMs?: number;
};

const QUERY_CANCELED = "57014";

function sqlState(error: unknown): string | null {
  for (let current: unknown = error; current && typeof current === "object";) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Drift check for the per-turn credit totals (migration 1599): for each given
 * account, up to `turnsPerAccount` turns with ready, exact kept rows and at
 * most `maxCalls` calls, chosen at a random point of the turn id space,
 * compare the terminal `usage` the kept rows give
 * (session_turn_credit_usage_kept_v1) with the full sum the terminal trigger
 * falls back to (session_turn_credit_usage_full_v1). Both run in one statement
 * of a repeatable-read transaction in the turn's own tenant scope, bounded by
 * `statementTimeoutMs`, so concurrent writes never show as drift; a turn not
 * visible in that scope (or not kept) is skipped, and one whose recount runs
 * out of time counts as skipped. Any mismatch means a trigger missed a change.
 */
export async function checkSessionTurnCreditTotals(
  db: Database,
  accountIds: readonly string[],
  bounds: SessionTurnCreditTotalsCheckBounds = {},
): Promise<SessionTurnCreditTotalsCheck> {
  const turnsPerAccount = bounds.turnsPerAccount ?? 1;
  const maxCalls = bounds.maxCalls ?? 500;
  const statementTimeoutMs = bounds.statementTimeoutMs ?? 2_000;
  const result: SessionTurnCreditTotalsCheck = { checked: 0, skipped: 0, mismatchedTurnIds: [] };
  for (const accountId of accountIds) {
    const turns = await withAccountRls(db, accountId, async (tx) =>
      rawRows<{ turn_id: string; workspace_id: string; session_id: string; small: boolean }>(
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
        select sampled.turn_id, sampled.workspace_id, sampled.session_id,
          not exists (select 1 from session_turn_credit_calls kc
            where kc.turn_id = sampled.turn_id offset ${maxCalls}) as small
        from sampled
        order by pass, turn_id limit ${turnsPerAccount}`,
      ),
    );
    for (const turn of turns) {
      if (!turn.small) {
        result.skipped += 1;
        continue;
      }
      let row: { differs: boolean } | undefined;
      try {
        [row] = await withRlsContext(
          db,
          { accountId, workspaceId: turn.workspace_id },
          async (tx) => {
            await tx.execute(
              sql`select pg_catalog.set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`,
            );
            return rawRows<{ differs: boolean }>(
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
            );
          },
          { isolationLevel: "repeatable read" },
        );
      } catch (error) {
        if (sqlState(error) !== QUERY_CANCELED) throw error;
        result.skipped += 1;
        continue;
      }
      if (!row) continue;
      result.checked += 1;
      if (row.differs) result.mismatchedTurnIds.push(turn.turn_id);
    }
  }
  return result;
}
