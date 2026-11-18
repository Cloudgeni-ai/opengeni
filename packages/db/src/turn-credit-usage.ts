import { turnUsageFromPayload, type SessionTurn, type TurnUsage } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import { fromPostgresLosslessJson } from "./lossless-json";

const TERMINAL_TURN_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
] as const;

/**
 * Each turn's `usage` from its latest terminal event (written there by
 * migration 1495's trigger), in one read of the session_events
 * (workspace_id, turn_id, type) index. A turn without one (still running, or
 * from before the field existed) maps to null. Runs inside the caller's
 * workspace scope.
 */
export async function turnUsageByTurn(
  scopedDb: Pick<Database, "execute">,
  workspaceId: string,
  turnIds: readonly string[],
): Promise<Map<string, TurnUsage | null>> {
  const usage = new Map<string, TurnUsage | null>();
  if (turnIds.length === 0) return usage;
  const rows = await rawRows<{
    turn_id: string;
    usage: unknown;
    payload_codec_version: number | null;
  }>(
    scopedDb,
    sql`select distinct on (turn_id) turn_id::text as turn_id, payload -> 'usage' as usage,
        payload_codec_version
      from session_events
      where workspace_id = ${workspaceId}::uuid
        and turn_id = any(${`{${turnIds.join(",")}}`}::uuid[])
        and type = any(${`{${TERMINAL_TURN_EVENT_TYPES.join(",")}}`}::text[])
        and duplicate_of_event_id is null
      order by turn_id, sequence desc`,
  );
  for (const row of rows) {
    usage.set(
      row.turn_id,
      turnUsageFromPayload({
        usage: fromPostgresLosslessJson(row.usage, row.payload_codec_version),
      }),
    );
  }
  return usage;
}

/** The turns with `usage` filled from their terminal events. */
export async function withTurnUsage(
  scopedDb: Pick<Database, "execute">,
  workspaceId: string,
  turns: SessionTurn[],
): Promise<SessionTurn[]> {
  const usage = await turnUsageByTurn(
    scopedDb,
    workspaceId,
    turns.map((turn) => turn.id),
  );
  return turns.map((turn) => ({ ...turn, usage: usage.get(turn.id) ?? null }));
}
