import { and, eq } from "drizzle-orm";
import { withAccountRls, type Database } from "./database";
import * as schema from "./schema";

export async function getBillingCustomer(
  db: Database,
  accountId: string,
  provider = "stripe",
): Promise<{
  accountId: string;
  provider: string;
  providerCustomerId: string;
  email: string | null;
} | null> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.billingCustomers)
      .where(
        and(
          eq(schema.billingCustomers.accountId, accountId),
          eq(schema.billingCustomers.provider, provider),
        ),
      )
      .limit(1);
    return row
      ? {
          accountId: row.accountId,
          provider: row.provider,
          providerCustomerId: row.providerCustomerId,
          email: row.email,
        }
      : null;
  });
}
