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
type CreditBalanceSnapshot = BillingBalance & {
  creditPolicyRevision?: number;
  /**
   * Admission only ({@link getSpendableCreditBalance}): the database clock
   * after this snapshot was read. Pass it to settlement as `fundingAdmittedAt`.
   */
  fundingAdmittedAt?: string;
};

/**
 * A database-clock admission time from {@link getSpendableCreditBalance}, as
 * an ISO-8601 UTC string with microseconds. Anything else is ignored, which
 * keeps held promotional funding held: the safe default.
 */
const FUNDING_ADMITTED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function validFundingAdmittedAt(value: string | null | undefined): string | null {
  return typeof value === "string" &&
    FUNDING_ADMITTED_AT.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/**
 * The balance as of one snapshot. Settlement passes `fundingAdmittedAt`, the
 * database time its usage was admitted: promotional funding held by a
 * non-eligible decision that took effect after that time still pays for the
 * already-dispatched usage. Usage admitted after the decision, or with no
 * trustworthy admission time, never settles against held funding.
 */
export async function getBillingBalance(
  db: Database,
  accountId: string,
  policyRevision?: number,
  settlementAt?: string,
  fundingAdmittedAt?: string | null,
): Promise<CreditBalanceSnapshot> {
  return (await readBillingBalance(db, accountId, policyRevision, settlementAt, fundingAdmittedAt))
    .balance;
}

async function readBillingBalance(
  db: Database,
  accountId: string,
  policyRevision?: number,
  settlementAt?: string,
  fundingAdmittedAt?: string | null,
): Promise<{ balance: CreditBalanceSnapshot; readAt: string }> {
  const admittedAt = validFundingAdmittedAt(fundingAdmittedAt);
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{
      balance: string;
      grants: PromotionalCreditBalance[];
      revision: number;
      plan: BillingPlanBalance | null;
      decision: NonNullable<BillingBalance["promotionDecision"]>;
      enforcement: boolean;
      decided_after_admission: boolean;
      read_at: string;
    }>(
      tx,
      sql`
      with current_policy as (
        select revision, policy from opengeni_private.credit_promotion_policy_revisions
        where (${policyRevision ?? null}::bigint is null or revision <= ${policyRevision ?? null}::bigint)
        order by revision desc limit 1
      )
      select
        coalesce((select decision from promotion_decisions where account_id=${accountId}::uuid), 'eligible') as decision,
        (select enabled from promotion_enforcement where singleton) as enforcement,
        -- Decision writers hold the account credit lock and stamp the database
        -- clock. Without an admission time this is false: funding stays held.
        coalesce((select updated_at > ${admittedAt}::timestamptz
          from promotion_decisions where account_id=${accountId}::uuid), false) as decided_after_admission,
        -- Evaluated after this statement's snapshot: a hold visible here
        -- always has an earlier updated_at than this admission time.
        to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as read_at,
        coalesce((select revision from current_policy), 0)::int as revision,
        read_organization_plan_balance(${accountId}::uuid, coalesce(${settlementAt ?? null}::timestamptz, statement_timestamp())) as plan,
        (select coalesce(sum(amount_micros), 0)::text
          from ${schema.creditLedgerEntries} where account_id = ${accountId}) as balance,
        coalesce((select jsonb_agg(jsonb_build_object(
          'grantId', g.id,
          'label', coalesce(g.metadata->>'creditOfferLabel', 'Promotional credits'),
          'eligibleModelIds', coalesce(
            (select coalesce(
              case when g.source_type = 'verified_signup_trial' or g.type = 'plan_credit_grant' then policy->'signupModelIds'
                else policy->'offers'->(g.metadata->>'creditOfferId')->'eligibleModelIds' end,
              policy->'defaultModelIds'
            ) from current_policy), to_jsonb(g.eligible_model_ids)),
          'remainingMicros', g.amount_micros - coalesce(used.amount, 0),
          'coversVoice', g.source_type = 'verified_signup_trial',
          'planCredit', g.type = 'plan_credit_grant',
          'held', coalesce((g.source_type = 'verified_signup_trial' OR (g.type='plan_credit_grant' AND period.plan_key='free'))
            AND EXISTS (SELECT 1 FROM promotion_enforcement WHERE enabled)
            AND EXISTS (SELECT 1 FROM promotion_decisions WHERE account_id=${accountId}::uuid AND decision <> 'eligible'), false)
        ) order by g.created_at, g.id)
          from ${schema.creditLedgerEntries} g
          left join plan_credit_periods period on period.grant_entry_id = g.id
          left join (
            select grant_entry_id, sum(amount_micros) as amount
            from ${schema.creditDebitAllocations} where account_id = ${accountId}
            group by grant_entry_id
          ) used on used.grant_entry_id = g.id
          where g.account_id = ${accountId} and g.eligible_model_ids is not null
            and g.amount_micros > coalesce(used.amount, 0)
            and (g.type <> 'plan_credit_grant' or (period.expired_at is null
              and period.period_end > coalesce(${settlementAt ?? null}::timestamptz, statement_timestamp())))
        ), '[]'::jsonb) as grants
    `,
    );
    // Expiry cannot depend on a maintenance worker being awake. Keep this read
    // lock-free; writers settle the same expiry under the account lock first.
    const balanceMicros = Number(row?.balance ?? 0) - (row?.plan?.creditPendingExpiryMicros ?? 0);
    // Only the decision that held the funds can be newer than the admission;
    // releasing a hold already makes the funds ordinary (not held) again.
    const heldAfterAdmission = row?.decided_after_admission === true;
    const promotionalCredits = (row?.grants ?? []).map((grant) => ({
      ...grant,
      held: heldAfterAdmission ? false : grant.held,
    }));
    const generalBalanceMicros =
      balanceMicros - promotionalCredits.reduce((sum, grant) => sum + grant.remainingMicros, 0);
    // Legacy Free periods were unrestricted, but have their own immutable
    // period usage accounting. Never mistake paid-plan periods for subsidies.
    const heldGeneralCreditMicros =
      !heldAfterAdmission &&
      row?.enforcement &&
      row.decision !== "eligible" &&
      row.plan?.key === "free" &&
      !row.plan.creditScoped
        ? Math.min(Math.max(0, generalBalanceMicros), row.plan.creditRemainingMicros)
        : 0;
    const balance: CreditBalanceSnapshot = {
      accountId,
      creditPolicyRevision: row?.revision ?? 0,
      balanceMicros,
      generalBalanceMicros,
      heldGeneralCreditMicros,
      heldCreditMicros:
        heldGeneralCreditMicros +
        promotionalCredits.reduce(
          (sum, grant) => sum + (grant.held ? grant.remainingMicros : 0),
          0,
        ),
      promotionDecision: row?.enforcement ? row.decision : "eligible",
      promotionalCredits,
      plan: row?.plan ?? null,
      currency: "usd",
      updatedAt: new Date().toISOString(),
    };
    return { balance, readAt: row?.read_at ?? "" };
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
  if (grant.held || !usage) return false;
  if (typeof usage === "string") return grant.eligibleModelIds.includes(usage);
  return grant.coversVoice === true;
}

export function spendableCreditMicros(balance: BillingBalance, usage?: CreditUsage): number {
  return (
    Math.max(
      0,
      (balance.generalBalanceMicros ?? balance.balanceMicros) -
        (balance.heldGeneralCreditMicros ?? 0),
    ) +
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
  // This existing definer also refreshes structured abuse evidence. Run it
  // only for admission, never for settlement of an already-dispatched call.
  await withAccountRls(db, accountId, async (tx) => {
    await tx.execute(sql`select free_plan_credit_eligible(${accountId}::uuid)`);
  });
  const { balance, readAt } = await readBillingBalance(db, accountId, policyRevision, settlementAt);
  // Usage admitted while funding is held never earns an admission time, so
  // no later decision change can let its settlement reach held funds.
  const fundingAdmittedAt =
    balance.promotionDecision === "eligible" ? validFundingAdmittedAt(readAt) : null;
  return {
    ...balance,
    balanceMicros: spendableCreditMicros(balance, usage),
    ...(fundingAdmittedAt ? { fundingAdmittedAt } : {}),
  };
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
  // Sort a copy: the API/UI's chronological display remains stable. Scoped plan
  // funding requires explicit allocations, unlike legacy/general allowances.
  const grants = [...(balance.promotionalCredits ?? [])].sort(
    (a, b) => Number(b.planCredit ?? false) - Number(a.planCredit ?? false),
  );
  for (const grant of grants) {
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
    balance.plan?.creditScoped ? 0 : (balance.plan?.creditRemainingMicros ?? 0),
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
  // Funding reversals/dispute holds can remove general funds without reducing
  // derived period usage. Do not preserve covering promotions by charging an
  // allowance that is no longer backed by a positive general balance.
  const planBudget = Math.min(
    balance.plan?.creditScoped ? 0 : (balance.plan?.creditRemainingMicros ?? 0),
    Math.max(0, balance.generalBalanceMicros ?? balance.balanceMicros),
  );
  return allocateToCoveringGrants(balance, amountMicros, usage, planBudget);
}
