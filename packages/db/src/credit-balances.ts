import type { BillingBalance, PromotionalCreditBalance } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withAccountRls } from "./database";
import * as schema from "./schema";

/** Read totals and grant remainders from one database snapshot. */
type CreditBalanceSnapshot = BillingBalance & { creditPolicyRevision?: number };

export async function getBillingBalance(
  db: Database,
  accountId: string,
  policyRevision?: number,
): Promise<CreditBalanceSnapshot> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{
      balance: string;
      grants: PromotionalCreditBalance[];
      revision: number;
    }>(
      tx,
      sql`
      with current_policy as (
        select revision, policy from opengeni_private.credit_promotion_policy_revisions
        where (${policyRevision ?? null}::bigint is null or revision <= ${policyRevision ?? null}::bigint)
        order by revision desc limit 1
      )
      select
        coalesce((select revision from current_policy), 0)::int as revision,
        (select coalesce(sum(amount_micros), 0)::text
          from ${schema.creditLedgerEntries} where account_id = ${accountId}) as balance,
        coalesce((select jsonb_agg(jsonb_build_object(
          'grantId', g.id,
          'label', coalesce(g.metadata->>'creditOfferLabel', 'Promotional credits'),
          'eligibleModelIds', coalesce(
            (select coalesce(
              case when g.source_type = 'verified_signup_trial' then policy->'signupModelIds'
                else policy->'offers'->(g.metadata->>'creditOfferId')->'eligibleModelIds' end,
              policy->'defaultModelIds'
            ) from current_policy), to_jsonb(g.eligible_model_ids)),
          'remainingMicros', g.amount_micros - coalesce(used.amount, 0)
        ) order by g.created_at, g.id)
          from ${schema.creditLedgerEntries} g
          left join (
            select grant_entry_id, sum(amount_micros) as amount
            from ${schema.creditDebitAllocations} where account_id = ${accountId}
            group by grant_entry_id
          ) used on used.grant_entry_id = g.id
          where g.account_id = ${accountId} and g.eligible_model_ids is not null
            and g.amount_micros > coalesce(used.amount, 0)
        ), '[]'::jsonb) as grants
    `,
    );
    const balanceMicros = Number(row?.balance ?? 0);
    const promotionalCredits = row?.grants ?? [];
    return {
      accountId,
      creditPolicyRevision: row?.revision ?? 0,
      balanceMicros,
      generalBalanceMicros:
        balanceMicros - promotionalCredits.reduce((sum, grant) => sum + grant.remainingMicros, 0),
      promotionalCredits,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Missing model means a non-model resource, which can only use general credits. */
export function spendableCreditMicros(balance: BillingBalance, modelId?: string): number {
  return (
    Math.max(0, balance.generalBalanceMicros ?? balance.balanceMicros) +
    (balance.promotionalCredits ?? []).reduce(
      (sum, grant) =>
        sum + (modelId && grant.eligibleModelIds.includes(modelId) ? grant.remainingMicros : 0),
      0,
    )
  );
}

export async function getSpendableCreditBalance(
  db: Database,
  accountId: string,
  modelId?: string,
  policyRevision?: number,
): Promise<CreditBalanceSnapshot> {
  const balance = await getBillingBalance(db, accountId, policyRevision);
  return { ...balance, balanceMicros: spendableCreditMicros(balance, modelId) };
}

export function planCreditDebit(
  balance: BillingBalance,
  requestedMicros: number,
  modelId?: string,
) {
  if (!Number.isSafeInteger(requestedMicros) || requestedMicros <= 0) {
    throw new Error("credit debit requires a positive, safe integer micro amount");
  }
  const debitedMicros = Math.min(requestedMicros, spendableCreditMicros(balance, modelId));
  let remaining = debitedMicros;
  const allocations: { grantEntryId: string; amountMicros: number }[] = [];
  for (const grant of balance.promotionalCredits ?? []) {
    if (!remaining || !modelId || !grant.eligibleModelIds.includes(modelId)) continue;
    const amountMicros = Math.min(remaining, grant.remainingMicros);
    allocations.push({ grantEntryId: grant.grantId, amountMicros });
    remaining -= amountMicros;
  }
  return { debitedMicros, allocations };
}
