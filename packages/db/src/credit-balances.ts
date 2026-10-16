import type {
  BillingBalance,
  BillingPlanBalance,
  PromotionalCreditBalance,
} from "@opengeni/contracts";
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
  settlementAt?: string,
): Promise<CreditBalanceSnapshot> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{
      balance: string;
      grants: PromotionalCreditBalance[];
      revision: number;
      plan: BillingPlanBalance | null;
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
        read_organization_plan_balance(${accountId}::uuid, ${settlementAt ?? null}::timestamptz) as plan,
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
          'remainingMicros', g.amount_micros - coalesce(used.amount, 0),
          'coversVoice', g.source_type = 'verified_signup_trial'
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
    // Expiry cannot depend on a maintenance worker being awake. Keep this read
    // lock-free; writers settle the same expiry under the account lock first.
    const balanceMicros = Number(row?.balance ?? 0) - (row?.plan?.creditPendingExpiryMicros ?? 0);
    const promotionalCredits = row?.grants ?? [];
    return {
      accountId,
      creditPolicyRevision: row?.revision ?? 0,
      balanceMicros,
      generalBalanceMicros:
        balanceMicros - promotionalCredits.reduce((sum, grant) => sum + grant.remainingMicros, 0),
      promotionalCredits,
      plan: row?.plan ?? null,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * What a charge pays for. A canonical model ID uses grants scoped to that
 * model; {@link VOICE_CREDIT_USAGE} (dictation and live voice) uses grants
 * that cover voice, which are the verified-signup trial credits. Omitted means
 * a non-model resource, which can only use general credits.
 */
export type CreditUsage = string | { readonly kind: "voice" } | undefined;

/** Deployment-funded dictation and live voice. */
export const VOICE_CREDIT_USAGE: { readonly kind: "voice" } = Object.freeze({ kind: "voice" });

function grantCovers(grant: PromotionalCreditBalance, usage: CreditUsage): boolean {
  if (!usage) return false;
  if (typeof usage === "string") return grant.eligibleModelIds.includes(usage);
  return grant.coversVoice === true;
}

export function spendableCreditMicros(balance: BillingBalance, usage?: CreditUsage): number {
  return (
    Math.max(0, balance.generalBalanceMicros ?? balance.balanceMicros) +
    (balance.promotionalCredits ?? []).reduce(
      (sum, grant) => sum + (grantCovers(grant, usage) ? grant.remainingMicros : 0),
      0,
    )
  );
}

export async function getSpendableCreditBalance(
  db: Database,
  accountId: string,
  usage?: CreditUsage,
  policyRevision?: number,
  settlementAt?: string,
): Promise<CreditBalanceSnapshot> {
  const balance = await getBillingBalance(db, accountId, policyRevision, settlementAt);
  return { ...balance, balanceMicros: spendableCreditMicros(balance, usage) };
}

/** Monthly plan credit pays first; then covering grants, oldest first. */
function allocateToCoveringGrants(
  balance: BillingBalance,
  amountMicros: number,
  usage: CreditUsage,
  planBudgetMicros = balance.plan?.creditRemainingMicros ?? 0,
) {
  let remaining = Math.max(0, amountMicros - Math.max(0, planBudgetMicros));
  const allocations: { grantEntryId: string; amountMicros: number }[] = [];
  for (const grant of balance.promotionalCredits ?? []) {
    if (!remaining || !grantCovers(grant, usage) || grant.remainingMicros <= 0) continue;
    const allocated = Math.min(remaining, grant.remainingMicros);
    allocations.push({ grantEntryId: grant.grantId, amountMicros: allocated });
    remaining -= allocated;
  }
  return allocations;
}

export function planCreditDebit(
  balance: BillingBalance,
  requestedMicros: number,
  usage?: CreditUsage,
) {
  if (!Number.isSafeInteger(requestedMicros) || requestedMicros <= 0) {
    throw new Error("credit debit requires a positive, safe integer micro amount");
  }
  const debitedMicros = Math.min(requestedMicros, spendableCreditMicros(balance, usage));
  // Existing general-credit debt can leave less spendable general funding than
  // the derived allowance. Prepaid admission must never mint spendable credit
  // by repeatedly preserving promotional grants while overdrawing general.
  const planBudget = Math.min(
    balance.plan?.creditRemainingMicros ?? 0,
    Math.max(0, balance.generalBalanceMicros ?? balance.balanceMicros),
  );
  return {
    debitedMicros,
    allocations: allocateToCoveringGrants(balance, debitedMicros, usage, planBudget),
  };
}

/**
 * Allocations for an already-consumed charge of the full amount: the monthly
 * plan pays first, covering grants pay beyond it, and other general credit
 * takes the rest, possibly going negative.
 */
export function planPostUseCreditAllocations(
  balance: BillingBalance,
  amountMicros: number,
  usage: CreditUsage,
) {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    throw new Error("credit debit requires a positive, safe integer micro amount");
  }
  return allocateToCoveringGrants(balance, amountMicros, usage);
}
