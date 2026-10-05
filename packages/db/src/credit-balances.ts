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
): Promise<CreditBalanceSnapshot> {
  const balance = await getBillingBalance(db, accountId, policyRevision);
  return { ...balance, balanceMicros: spendableCreditMicros(balance, usage) };
}

/** Covering grants pay first, oldest first; the rest is general credit. */
function allocateToCoveringGrants(balance: BillingBalance, amountMicros: number, usage: CreditUsage) {
  let remaining = amountMicros;
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
  return { debitedMicros, allocations: allocateToCoveringGrants(balance, debitedMicros, usage) };
}

/**
 * Allocations for an already-consumed charge of the full amount: covering
 * grants pay what they can and general credit takes the rest, possibly going
 * negative.
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
