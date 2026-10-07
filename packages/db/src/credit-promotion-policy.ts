import { CreditPromotionPolicy } from "@opengeni/config";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

/** Runtime policy supersedes deployment bootstrap configuration. No process cache. */
export async function readCreditPromotionPolicy(db: Database) {
  const [row] = await rawRows<{ policy: unknown }>(
    db,
    sql`select policy from opengeni_private.credit_promotion_policy_revisions order by revision desc limit 1`,
  );
  return row ? CreditPromotionPolicy.parse(row.policy) : null;
}
