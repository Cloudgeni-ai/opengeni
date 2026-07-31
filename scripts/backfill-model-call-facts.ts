/**
 * Bounded idempotent YTD backfill of model_call_facts from authoritative
 * session_events agent.model.usage rows. Never rewrites billing usage_events.
 *
 * Usage:
 *   bun scripts/backfill-model-call-facts.ts [--workspace <uuid>] [--limit 50000]
 */
import { createDb, backfillModelCallFactsFromSessionEvents } from "@opengeni/db";
import { sql } from "drizzle-orm";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function startOfUtcYear(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

async function main(): Promise<void> {
  const workspaceFilter = argValue("--workspace");
  const limit = Number(argValue("--limit") ?? "50000");
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number");
  }
  const databaseUrl =
    process.env.OPENGENI_DATABASE_URL ?? "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni";
  const { db } = createDb(databaseUrl);
  const since = startOfUtcYear();
  const until = new Date();

  const workspaceIds = workspaceFilter
    ? [workspaceFilter]
    : (
        await db.execute<{ id: string }>(sql`select id from workspaces order by created_at`)
      ).map((row) => row.id);

  let totalUpserted = 0;
  let totalConsidered = 0;
  for (const workspaceId of workspaceIds) {
    const result = await backfillModelCallFactsFromSessionEvents(db, {
      workspaceId,
      since,
      until,
      limit,
    });
    totalConsidered += result.considered;
    totalUpserted += result.upserted;
    console.log(
      JSON.stringify({
        workspaceId,
        since: since.toISOString(),
        until: until.toISOString(),
        considered: result.considered,
        upserted: result.upserted,
      }),
    );
  }
  console.log(
    JSON.stringify({
      workspaces: workspaceIds.length,
      considered: totalConsidered,
      upserted: totalUpserted,
    }),
  );
}

await main();
