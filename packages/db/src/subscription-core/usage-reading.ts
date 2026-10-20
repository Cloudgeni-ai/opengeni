import type { StoredQuotaDocument, SubscriptionQuota } from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";
import type { Database } from "../database";

/** The caller must already hold the connection's existing read scope. */
export async function recordSubscriptionUsageReading(
  tx: Database,
  accountId: string,
  connectionId: string,
  provider: string,
  reading: { observedAt: number | null; windows: SubscriptionQuota["windows"] },
) {
  if (reading.observedAt === null) return;
  await tx.execute(sql`select opengeni_private.append_subscription_usage_reading(${accountId}::uuid,
    ${connectionId}::uuid, ${provider}, ${JSON.stringify(reading)}::jsonb)`);
}

/** Preserve the fetched observation separately from retained/merged windows. */
export function withSubscriptionUsageReading(
  stored: StoredQuotaDocument,
  observation: SubscriptionQuota,
) {
  return {
    ...stored,
    usageReading:
      observation.observedAt !== null &&
      (observation.source === "usage_endpoint" || observation.source === "response_headers")
        ? { observedAt: observation.observedAt, windows: observation.windows }
        : null,
  };
}
