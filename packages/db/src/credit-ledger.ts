import type { BillingBalance } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import { getBillingBalance, paidCreditReceipt } from "./credit-balances";
import { beginPlanCreditSettlement } from "./subscription-plans";
import * as schema from "./schema";

type CreditLedgerEntryInput = {
  accountId: string;
  workspaceId?: string | null;
  type: string;
  amountMicros: number;
  eligibleModelIds?: string[] | undefined;
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
};

export async function applyCreditLedgerEntry(
  db: Database,
  input: CreditLedgerEntryInput,
): Promise<BillingBalance> {
  return (await applyCreditLedgerEntryOnce(db, input)).balance;
}

/**
 * {@link applyCreditLedgerEntry} that also reports whether this call inserted
 * the row. `inserted` is false when the idempotency key already existed, so a
 * caller can count a purchase exactly once even when two deliveries race.
 */
export async function applyCreditLedgerEntryOnce(
  db: Database,
  input: CreditLedgerEntryInput,
): Promise<{ balance: BillingBalance; inserted: boolean }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId ?? null },
    async (scopedDb) => {
      // Funding and usage adjustments share the expiry boundary too.
      await scopedDb.execute(sql`select pg_advisory_xact_lock(hashtext(${input.accountId}))`);
      const settledAt = await beginPlanCreditSettlement(scopedDb, input.accountId);
      // Paid-for credit, refunds of it and unpaid credit record what they
      // change in paid credit (paid-credit.ts).
      const receipt = await paidCreditReceipt(scopedDb, {
        accountId: input.accountId,
        settledAt,
        type: input.type,
        amountMicros: input.amountMicros,
        eligibleModelIds: input.eligibleModelIds ?? null,
        metadata: input.metadata,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      });
      const inserted = await scopedDb
        .insert(schema.creditLedgerEntries)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId ?? null,
          type: input.type,
          amountMicros: input.amountMicros,
          eligibleModelIds: input.eligibleModelIds ?? null,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          idempotencyKey: input.idempotencyKey,
          metadata: { ...input.metadata, ...receipt.metadata },
          occurredAt: input.occurredAt ?? new Date(),
          createdAt: receipt.createdAt,
        })
        .onConflictDoNothing({
          target: schema.creditLedgerEntries.idempotencyKey,
        })
        .returning({ id: schema.creditLedgerEntries.id });
      return {
        balance: await getBillingBalance(scopedDb, input.accountId),
        inserted: inserted.length > 0,
      };
    },
  );
}
