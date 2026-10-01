import postgres from "postgres";

/**
 * One-time, operator-invoked backfill of product lifecycle facts captured
 * before the first `lifecycle_fact` consumer registered (migration 0565).
 *
 * Each source is drained through
 * `opengeni_private.backfill_product_lifecycle_facts`: the first call reads
 * the source tables once (ACCESS SHARE only) into a private queue, and every
 * call then enqueues one primary-key page of it in its own short
 * transaction. Backfilled facts reuse the live trigger's deterministic fact
 * ids and keep their original timestamps, so an overlap with live capture or
 * a repeated run never adds a second fact. A completed source is a durable
 * no-op. Run as the migration owner only after a lifecycle consumer is
 * registered:
 *
 *   OPENGENI_MIGRATIONS_DATABASE_URL=... bun run db:backfill-lifecycle-facts
 */
export const LIFECYCLE_BACKFILL_SOURCES = [
  "auth.sign_up",
  "auth.email_verified",
  "auth.sign_in",
  "organization.setup",
  "model.connected",
  "credits.purchased",
  "credits.granted",
  "connection.created",
  "connection.revoked",
  "scheduled_task.created",
  "skill.installed",
  "slack.user_linked",
  "machine.enrolled",
  "member.joined",
  "user.active",
] as const;
export type LifecycleBackfillSource = (typeof LIFECYCLE_BACKFILL_SOURCES)[number];

export type LifecycleBackfillResult = {
  source: LifecycleBackfillSource;
  enqueued: number;
  scanned: number;
  batches: number;
};

export async function backfillProductLifecycleFacts(
  sql: postgres.Sql,
  options: {
    sources?: readonly LifecycleBackfillSource[];
    batchSize?: number;
    onBatch?: (batch: LifecycleBackfillResult) => void;
  } = {},
): Promise<LifecycleBackfillResult[]> {
  const batchSize = options.batchSize ?? 500;
  const results: LifecycleBackfillResult[] = [];
  for (const source of options.sources ?? LIFECYCLE_BACKFILL_SOURCES) {
    const total: LifecycleBackfillResult = { source, enqueued: 0, scanned: 0, batches: 0 };
    for (;;) {
      const [row] = await sql<
        { enqueued_count: number; scanned_count: number; backfill_completed: boolean }[]
      >`
        select enqueued_count, scanned_count, backfill_completed
        from opengeni_private.backfill_product_lifecycle_facts(${source}, ${batchSize})`;
      if (!row) throw new Error(`lifecycle backfill returned no row for ${source}`);
      total.enqueued += Number(row.enqueued_count);
      total.scanned += Number(row.scanned_count);
      total.batches += 1;
      options.onBatch?.({ ...total });
      if (row.backfill_completed) break;
    }
    results.push(total);
  }
  return results;
}

if (import.meta.main) {
  const databaseUrl =
    process.env.OPENGENI_MIGRATIONS_DATABASE_URL ?? process.env.OPENGENI_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Set OPENGENI_MIGRATIONS_DATABASE_URL to the migration owner database URL");
  }
  const requested = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const unknown = requested.filter(
    (value) => !(LIFECYCLE_BACKFILL_SOURCES as readonly string[]).includes(value),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown lifecycle backfill source(s): ${unknown.join(", ")}. ` +
        `Known: ${LIFECYCLE_BACKFILL_SOURCES.join(", ")}`,
    );
  }
  const batchArgument = process.argv.find((value) => value.startsWith("--batch-size="));
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const results = await backfillProductLifecycleFacts(sql, {
      ...(requested.length > 0 ? { sources: requested as LifecycleBackfillSource[] } : {}),
      ...(batchArgument ? { batchSize: Number(batchArgument.split("=")[1]) } : {}),
    });
    for (const result of results) {
      console.info(
        `[lifecycle-backfill] ${result.source}: enqueued=${result.enqueued} scanned=${result.scanned} batches=${result.batches}`,
      );
    }
  } finally {
    await sql.end();
  }
}
