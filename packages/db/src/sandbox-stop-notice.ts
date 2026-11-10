import { sql } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";

/** A stop of this chat's sandbox that the model has not worked in since. */
export type UnseenSandboxStop = {
  kind: "stopped" | "lost";
  /** When the stop was recorded, ISO 8601. */
  at: string;
  /** The drain reason of a reaper stop (`idle`, ...), when recorded. */
  reason: string | null;
};

/**
 * The latest stop of this chat's managed sandbox (`sandbox.box.terminated`
 * from the reaper's drain, or `sandbox.box.lost`) that is newer than the
 * model's own last action in the chat (a tool call, its result, or a
 * completed message). A tool's result counts so that a box replaced while the
 * tool ran is not reported again on the next turn.
 *
 * Only the workspace is saved and restored across such a stop: files outside
 * it and running programs may be gone, so the model is told before it relies
 * on them. Comparing with the model's own last output delivers that once, when
 * the next turn attempt prepares its input, whether or not the replacement box
 * already exists. A box found lost during an attempt, after its input was
 * prepared, is not covered: the attempt's later output hides it. A Connected
 * Machine's drain (`providerStopped: false`) stops nothing and is skipped.
 * Read-only; uses the per-type sequence index.
 */
export async function readUnseenSandboxStop(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<UnseenSandboxStop | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<{
      type: string;
      occurred_at: Date | string;
      reason: string | null;
    }>(sql`
      select stop.type, stop.occurred_at, stop.reason
      from (
        select type, sequence, occurred_at, payload ->> 'drainReason' as reason
        from session_events
        where workspace_id = ${workspaceId}
          and session_id = ${sessionId}
          and type in ('sandbox.box.terminated', 'sandbox.box.lost')
          and coalesce(payload ->> 'providerStopped', 'true') <> 'false'
        order by sequence desc
        limit 1
      ) stop
      where stop.sequence > coalesce(greatest(
        (select max(sequence) from session_events
          where workspace_id = ${workspaceId} and session_id = ${sessionId}
            and type = 'agent.toolCall.created'),
        (select max(sequence) from session_events
          where workspace_id = ${workspaceId} and session_id = ${sessionId}
            and type = 'agent.message.completed'),
        (select max(sequence) from session_events
          where workspace_id = ${workspaceId} and session_id = ${sessionId}
            and type = 'agent.toolCall.output')
      ), 0)
    `);
    const row = rows[0];
    if (!row) return null;
    const at = row.occurred_at instanceof Date ? row.occurred_at : new Date(row.occurred_at);
    return {
      kind: row.type === "sandbox.box.lost" ? "lost" : "stopped",
      at: at.toISOString(),
      reason: typeof row.reason === "string" && row.reason.length > 0 ? row.reason : null,
    };
  });
}
