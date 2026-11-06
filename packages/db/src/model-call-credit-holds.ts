import type { BillingOrigin } from "@opengeni/contracts";
import { and, eq, lte, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";
import * as schema from "./schema";
import { getSpendableCreditBalance, type CreditUsage } from "./credit-balances";
import { beginPlanCreditSettlement } from "./subscription-plans";

/**
 * How long a stateless model call's credit hold counts. A call deletes its
 * hold when it settles or fails; this bounds a hold left behind by a process
 * that stopped mid-call. It is far longer than any single call runs.
 */
export const MODEL_CALL_CREDIT_HOLD_WINDOW_SECONDS = 30 * 60;

export type ModelCallCreditReservation = {
  reserved: boolean;
  /** The credit policy revision the balance was read at, for settlement. */
  creditPolicyRevision: number | undefined;
};

/**
 * Reserve the maximum priced cost of one stateless Opengeni-credit model call
 * before its provider request. Under the account advisory lock that model
 * settlement takes, the call is admitted only when the spendable balance
 * minus every other live hold on the account covers `amountMicros`; the hold
 * is then recorded under the call's request id. Calls running at the same
 * time therefore cannot together be admitted for more than the balance.
 * Expired holds on the account are removed on the way.
 */
export async function reserveModelCallCredits(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    requestId: string;
    /** Canonical product model id (or credit usage) whose grants may pay. */
    usage: CreditUsage;
    origin: BillingOrigin;
    amountMicros: number;
  },
): Promise<ModelCallCreditReservation> {
  if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros <= 0) {
    throw new Error("Model call credit hold amount is outside the supported range");
  }
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.accountId}))`);
      const settledAt = await beginPlanCreditSettlement(tx, input.accountId);
      const balance = await getSpendableCreditBalance(
        tx,
        input.accountId,
        input.usage,
        undefined,
        settledAt,
        input.origin,
      );
      await tx
        .delete(schema.modelCallCreditHolds)
        .where(
          and(
            eq(schema.modelCallCreditHolds.accountId, input.accountId),
            lte(schema.modelCallCreditHolds.expiresAt, sql`statement_timestamp()`),
          ),
        );
      const [held] = await rawRows<{ micros: string }>(
        tx,
        sql`
        select coalesce(sum(amount_micros), 0)::text as micros
        from model_call_credit_holds
        where account_id = ${input.accountId}::uuid
          and expires_at > statement_timestamp()
          and request_id <> ${input.requestId}::uuid`,
      );
      const available = balance.balanceMicros - Number(held?.micros ?? 0);
      if (!Number.isSafeInteger(available) || available < input.amountMicros) {
        return { reserved: false, creditPolicyRevision: balance.creditPolicyRevision };
      }
      await tx
        .insert(schema.modelCallCreditHolds)
        .values({
          accountId: input.accountId,
          requestId: input.requestId,
          workspaceId: input.workspaceId,
          amountMicros: input.amountMicros,
          expiresAt: sql`statement_timestamp() + make_interval(secs => ${MODEL_CALL_CREDIT_HOLD_WINDOW_SECONDS})`,
        })
        .onConflictDoUpdate({
          target: [schema.modelCallCreditHolds.accountId, schema.modelCallCreditHolds.requestId],
          set: {
            amountMicros: input.amountMicros,
            expiresAt: sql`statement_timestamp() + make_interval(secs => ${MODEL_CALL_CREDIT_HOLD_WINDOW_SECONDS})`,
          },
        });
      return { reserved: true, creditPolicyRevision: balance.creditPolicyRevision };
    },
  );
}

/** Delete a call's hold once it has settled, failed or been aborted. */
export async function releaseModelCallCredits(
  db: Database,
  input: { accountId: string; workspaceId: string; requestId: string },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await tx
        .delete(schema.modelCallCreditHolds)
        .where(
          and(
            eq(schema.modelCallCreditHolds.accountId, input.accountId),
            eq(schema.modelCallCreditHolds.requestId, input.requestId),
          ),
        );
    },
  );
}
