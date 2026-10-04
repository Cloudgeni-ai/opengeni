import { createHash } from "node:crypto";
import {
  configuredModelListPricingSchedules,
  type ModelPricing,
  type ModelPricingScheduleV1,
  type Settings,
} from "@opengeni/config";
import { sql } from "drizzle-orm";
import type { Database } from "./database";

export type InsightsListAllocationProgress = {
  snapshotId: string;
  allocatedCalls: number;
  unknownCalls: number;
  batches: number;
  completed: boolean;
};
type BatchOptions = { batchSize?: number; maxBatches?: number };
function rows<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: unknown[] }).rows) as T[];
}
function limits(options: BatchOptions) {
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 10;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 5000 ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 1000
  )
    throw new Error("Invalid bounded Insights list allocation limits");
  return { batchSize, maxBatches };
}

/** Sanitize numeric comparison metadata; never persist Settings or credentials. */
export function insightsListRateProfiles(
  settings: Settings,
): Record<string, ModelPricingScheduleV1> {
  const rates = (pricing: ModelPricing): ModelPricing => {
    const result: Record<string, number> = {};
    for (const key of [
      "inputMicrosPerMillionTokens",
      "cachedInputMicrosPerMillionTokens",
      "cacheWriteMicrosPerMillionTokens",
      "outputMicrosPerMillionTokens",
    ] as const) {
      const value = pricing[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid approved list rate");
      result[key] = value;
    }
    return result as ModelPricing;
  };
  const schedules = configuredModelListPricingSchedules(settings);
  return Object.fromEntries(
    Object.keys(schedules)
      .sort()
      .map((model) => {
        const schedule = schedules[model]!;
        return [
          model,
          {
            default: rates(schedule.default),
            ...(schedule.inputTokenTiers?.length
              ? {
                  inputTokenTiers: schedule.inputTokenTiers.map((tier) => ({
                    minimumInputTokens: tier.minimumInputTokens,
                    pricing: rates(tier.pricing),
                  })),
                }
              : {}),
          },
        ];
      }),
  );
}

/** Migration-owner operation, not an API request seam or billing writer. */
export async function installInsightsListRateSnapshot(
  db: Database,
  input: { settings: Settings; version: string } & BatchOptions,
): Promise<InsightsListAllocationProgress> {
  limits(input);
  if (!input.version.trim() || input.version.length > 200)
    throw new Error("Invalid list catalog snapshot version");
  const profiles = insightsListRateProfiles(input.settings);
  const snapshotId = createHash("sha256")
    .update(JSON.stringify({ version: input.version, profiles }))
    .digest("hex");
  await db.transaction(async (tx) => {
    const [owner] = rows<{ allowed: boolean }>(
      await tx.execute(sql`select current_user=pg_get_userbyid(relowner) as allowed
      from pg_class where oid='model_call_facts'::regclass`),
    );
    if (!owner?.allowed) throw new Error("Insights list snapshot requires the migration owner");
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('insights-list-rate-activation',605))`,
    );
    await tx.execute(sql`insert into opengeni_private.insights_list_rate_snapshots(id,version,profiles)
      values(${snapshotId},${input.version},${JSON.stringify(profiles)}::jsonb) on conflict(id) do nothing`);
    await tx.execute(
      sql`update opengeni_private.insights_list_rate_snapshots set active=false where active and id<>${snapshotId}`,
    );
    await tx.execute(
      sql`update opengeni_private.insights_list_rate_snapshots set active=true where id=${snapshotId}`,
    );
  });
  return await resumeInsightsListRateSnapshot(db, { ...input, snapshotId });
}

/** Each call resumes committed progress; a failed batch rolls back cursor and deltas together. */
export async function resumeInsightsListRateSnapshot(
  db: Database,
  input: { snapshotId: string } & BatchOptions,
): Promise<InsightsListAllocationProgress> {
  const { batchSize, maxBatches } = limits(input);
  if (!/^[a-f0-9]{64}$/u.test(input.snapshotId))
    throw new Error("Invalid list snapshot identifier");
  const progress: InsightsListAllocationProgress = {
    snapshotId: input.snapshotId,
    allocatedCalls: 0,
    unknownCalls: 0,
    batches: 0,
    completed: false,
  };
  for (let batch = 0; batch < maxBatches; batch++) {
    const [result] = rows<{ progress: { allocated: number; unknown: number; completed: boolean } }>(
      await db.execute(sql`
      select opengeni_private.insights_backfill_list_snapshot(${input.snapshotId},${batchSize}) as progress`),
    );
    if (!result) throw new Error("Missing Insights allocation batch result");
    progress.batches++;
    progress.allocatedCalls += result.progress.allocated;
    progress.unknownCalls += result.progress.unknown;
    progress.completed = result.progress.completed;
    if (progress.completed) break;
  }
  return progress;
}
