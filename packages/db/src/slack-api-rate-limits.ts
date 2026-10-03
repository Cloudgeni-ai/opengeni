import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Settings } from "@opengeni/config";
import { rawRows, type Database } from "./database";

/** Zero admits one request; a positive value asks the caller to retry later.
 * Cooldowns contain no credential, actor, message, or channel data and grant no authority.
 * Admission commits before dispatch; a lost response still consumes its slot.
 */
export function buildSlackApiRateLimiter(
  db: Database,
  settings: Pick<Settings, "slackClientId" | "slackAccessMode">,
): (teamId: string, method: string, retryAfterSeconds?: number) => Promise<number> {
  return async (teamId, method, retryAfterSeconds) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId) || !/^[a-z]+(?:\.[A-Za-z]+)+$/.test(method)) {
      throw new Error("Invalid Slack quota identity");
    }
    const appKey = settings.slackClientId?.trim();
    if (!appKey) throw new Error("Slack quota requires the deployment Slack client identity");
    const scopeHash = createHash("sha256")
      .update(JSON.stringify([appKey, teamId, method]))
      .digest("hex");
    if (retryAfterSeconds !== undefined) {
      if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0)
        throw new Error("Invalid Slack retry delay");
      await db.execute(sql`insert into slack_api_rate_limits (scope_hash, next_allowed_at)
        values (${scopeHash}, clock_timestamp() + ${Math.ceil(retryAfterSeconds)} * interval '1 second')
        on conflict (scope_hash) do update set next_allowed_at = greatest(
          slack_api_rate_limits.next_allowed_at, excluded.next_allowed_at)`);
      return 0;
    }
    const intervalSeconds =
      settings.slackAccessMode === "limited" &&
      (method === "conversations.history" || method === "conversations.replies")
        ? 60
        : 0;
    // Conditional UPSERT serializes simultaneous admissions across replicas and humans.
    const rows = await rawRows<{ admitted: boolean; retry_after: number }>(
      db,
      sql`
      with admitted as (
        insert into slack_api_rate_limits (scope_hash, next_allowed_at)
        values (${scopeHash}, clock_timestamp() + ${intervalSeconds} * interval '1 second')
        on conflict (scope_hash) do update set next_allowed_at = excluded.next_allowed_at
        where slack_api_rate_limits.next_allowed_at <= clock_timestamp()
        returning scope_hash
      ) select exists(select 1 from admitted) as admitted,
        coalesce((select greatest(1, ceil(extract(epoch from next_allowed_at - clock_timestamp())))
          from slack_api_rate_limits where scope_hash = ${scopeHash}), 1)::integer as retry_after`,
    );
    if (rows[0]?.admitted) return 0;
    // A conflict can wait on an insert invisible to the statement snapshot.
    // Read again after that wait to return its committed delay accurately.
    const current = await rawRows<{ retry_after: number }>(
      db,
      sql`select
      greatest(1, ceil(extract(epoch from next_allowed_at - clock_timestamp())))::integer as retry_after
      from slack_api_rate_limits where scope_hash = ${scopeHash}`,
    );
    return Math.max(1, Number(current[0]?.retry_after ?? intervalSeconds ?? 1));
  };
}
