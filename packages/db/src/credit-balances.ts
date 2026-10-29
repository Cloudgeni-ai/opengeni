import { BYOK_PLATFORM_FEE_TYPE } from "@opengeni/contracts";
import type {
  BillingBalance,
  BillingOrigin,
  BillingPlanBalance,
  PromotionalCreditBalance,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { ambientBillingOrigin } from "./credit-debit-attribution";
import { rawRows, withAccountRls } from "./database";
import * as schema from "./schema";

/** Read totals and grant remainders from one database snapshot. */
type CreditBalanceSnapshot = BillingBalance & { creditPolicyRevision?: number };

export async function getBillingBalance(
  db: Database,
  accountId: string,
  policyRevision?: number,
  settlementAt?: string,
  includeHeldForSettlement = false,
): Promise<CreditBalanceSnapshot> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{
      balance: string;
      grants: PromotionalCreditBalance[];
      revision: number;
      plan: BillingPlanBalance | null;
      decision: NonNullable<BillingBalance["promotionDecision"]>;
      enforcement: boolean;
      apiSpent: string;
      paidFunding: string;
      feesFromCredits: string;
      feesThisMonth: string;
    }>(
      tx,
      sql`
      with current_policy as (
        select revision, policy from opengeni_private.credit_promotion_policy_revisions
        where (${policyRevision ?? null}::bigint is null or revision <= ${policyRevision ?? null}::bigint)
        order by revision desc limit 1
      ), totals as (
        -- One pass: the balance, and what API work has spent (negative
        -- credits up to this are API debt).
        select coalesce(sum(amount_micros), 0)::text as balance,
          greatest(0, coalesce(sum(-amount_micros) filter (where usage_origin = 'api'), 0))::text as "apiSpent",
          -- Paid-for funding (top-ups and operator grants net of refunds and
          -- disputes); what own-key fees drew beyond paid plan credit (paid
          -- credits, or debt when those ran out); this calendar month's (UTC)
          -- own-key fees.
          coalesce(sum(amount_micros) filter (where type in ('credit_topup', 'manual_credit_grant',
            'credit_refund', 'credit_dispute_hold', 'credit_dispute_release')), 0)::text as "paidFunding",
          coalesce(sum(-amount_micros - coalesce((metadata->>'planPaidMicros')::bigint, 0))
            filter (where type = ${BYOK_PLATFORM_FEE_TYPE}), 0)::text as "feesFromCredits",
          coalesce(sum(-amount_micros) filter (where type = ${BYOK_PLATFORM_FEE_TYPE}
            and created_at >= date_trunc('month', statement_timestamp() at time zone 'UTC') at time zone 'UTC'),
            0)::text as "feesThisMonth"
        from ${schema.creditLedgerEntries} where account_id = ${accountId}
      )
      select
        coalesce((select decision from promotion_decisions where account_id=${accountId}::uuid), 'eligible') as decision,
        (select enabled from promotion_enforcement where singleton) as enforcement,
        coalesce((select revision from current_policy), 0)::int as revision,
        read_organization_plan_balance(${accountId}::uuid, coalesce(${settlementAt ?? null}::timestamptz, statement_timestamp())) as plan,
        (select balance from totals) as balance,
        (select "apiSpent" from totals) as "apiSpent",
        (select "paidFunding" from totals) as "paidFunding",
        (select "feesFromCredits" from totals) as "feesFromCredits",
        (select "feesThisMonth" from totals) as "feesThisMonth",
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
    const promotionalCredits = (row?.grants ?? []).map((grant) => ({
      ...grant,
      held: includeHeldForSettlement ? false : grant.held,
    }));
    const generalBalanceMicros =
      balanceMicros - promotionalCredits.reduce((sum, grant) => sum + grant.remainingMicros, 0);
    // Legacy Free periods were unrestricted, but have their own immutable
    // period usage accounting. Never mistake paid-plan periods for subsidies.
    const heldGeneralCreditMicros =
      !includeHeldForSettlement &&
      row?.enforcement &&
      row.decision !== "eligible" &&
      row.plan?.key === "free" &&
      !row.plan.creditScoped
        ? Math.min(Math.max(0, generalBalanceMicros), row.plan.creditRemainingMicros)
        : 0;
    return {
      accountId,
      creditPolicyRevision: row?.revision ?? 0,
      balanceMicros,
      generalBalanceMicros,
      creditsMicros: creditsOutsidePlan(generalBalanceMicros, row?.plan ?? null),
      ...apiDebt(
        creditsOutsidePlan(generalBalanceMicros, row?.plan ?? null),
        Number(row?.apiSpent ?? 0),
      ),
      ...paidCredit(
        creditsOutsidePlan(generalBalanceMicros, row?.plan ?? null),
        row?.plan ?? null,
        Number(row?.paidFunding ?? 0),
        Number(row?.feesFromCredits ?? 0),
      ),
      ...(Number(row?.feesThisMonth ?? 0) > 0
        ? { byokPlatformFeeMonthMicros: Number(row?.feesThisMonth) }
        : {}),
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
  });
}

/**
 * Credits: general credit that is not this month's unrestricted plan
 * allowance (top-ups, operator grants, unrestricted legacy grants). A scoped
 * plan allowance is a promotional grant and never part of general credit.
 * Negative after API use ran past it.
 */
function creditsOutsidePlan(generalBalanceMicros: number, plan: BillingPlanBalance | null) {
  return generalBalanceMicros - (plan && !plan.creditScoped ? plan.creditRemainingMicros : 0);
}

/**
 * Credit debt that API work ran up: negative credits, up to what API work has
 * spent. Plan credit never repays it (the database's plan_app_general_balance
 * applies the same rule at period expiry and to a new period's opening debt).
 */
function apiDebt(creditsMicros: number, apiSpentMicros: number) {
  const debt = Math.min(Math.max(0, -creditsMicros), Math.max(0, apiSpentMicros));
  return debt > 0 ? { apiDebtMicros: debt } : {};
}

/**
 * General credit app work may use: API debt never shrinks the plan
 * allowance, and own-key fee debt never draws promotional credit. The larger
 * of the two is added back, so a debt that is both is never counted twice.
 */
function appGeneralMicros(balance: BillingBalance): number {
  return (
    (balance.generalBalanceMicros ?? balance.balanceMicros) +
    Math.max(balance.apiDebtMicros ?? 0, balance.byokFeeDebtMicros ?? 0)
  );
}

/**
 * Paid credit, the only funding a bring-your-own-key fee may use: a paid
 * plan's remaining unrestricted credit, and credits up to what was paid for
 * (top-ups, operator grants) and not already spent on fees. Free plan,
 * signup and promotional credit never count.
 */
function paidCredit(
  creditsMicros: number,
  plan: BillingPlanBalance | null,
  paidFundingMicros: number,
  feesFromCreditsMicros: number,
) {
  // Fees settle after use, so parallel calls can run past paid credit. The
  // excess is fee debt: the next top-up repays it, and it never draws
  // promotional credit (spendable figures add it back).
  const feeDebtMicros = Math.max(0, feesFromCreditsMicros - paidFundingMicros);
  return {
    paidPlanCreditMicros:
      plan && plan.key !== "free" && !plan.creditScoped
        ? Math.max(0, plan.creditRemainingMicros)
        : 0,
    paidCreditsMicros: Math.max(
      0,
      Math.min(creditsMicros, paidFundingMicros - feesFromCreditsMicros),
    ),
    ...(feeDebtMicros > 0 ? { byokFeeDebtMicros: feeDebtMicros } : {}),
  };
}

/** What a bring-your-own-key fee may draw: paid plan credit (app use only), then paid credits. */
export function byokFeeSpendableMicros(balance: BillingBalance, origin: BillingOrigin): number {
  return (
    (origin === "app" ? (balance.paidPlanCreditMicros ?? 0) : 0) + (balance.paidCreditsMicros ?? 0)
  );
}

/** Admission read for a bring-your-own-key call: its spendable paid credit. */
export async function getByokFeeSpendableBalance(
  db: Database,
  accountId: string,
  origin?: BillingOrigin | null,
): Promise<CreditBalanceSnapshot> {
  const balance = await getBillingBalance(db, accountId);
  return {
    ...balance,
    balanceMicros: byokFeeSpendableMicros(balance, chargeBillingOrigin(origin)),
  };
}

/** Credits only: what API-origin work may spend (never plan or promotional credit). */
export function apiSpendableCreditMicros(balance: BillingBalance): number {
  // Without a credits figure, nothing is known to be credits: fail closed.
  if (balance.creditsMicros === undefined) return 0;
  // Own-key fee debt is owed from paid credit, never from promotional credit.
  return Math.max(0, balance.creditsMicros + (balance.byokFeeDebtMicros ?? 0));
}

/**
 * The origin a charge is funded under: the caller's explicit origin, else
 * the one a trusted outer scope fixed (an API request, an agent's turn),
 * else app, today's behaviour.
 */
export function chargeBillingOrigin(origin?: BillingOrigin | null): BillingOrigin {
  return origin ?? ambientBillingOrigin() ?? "app";
}

/**
 * What a charge pays for. A canonical model ID uses grants scoped to that
 * model; {@link VOICE_CREDIT_USAGE} (dictation and live voice) uses grants
 * that cover voice: the verified-signup trial credits and plan credit. Omitted
 * means a non-model resource, which uses general credits and plan credit.
 */
export type CreditUsage = string | { readonly kind: "voice" } | undefined;

/** Deployment-funded dictation and live voice. */
export const VOICE_CREDIT_USAGE: { readonly kind: "voice" } = Object.freeze({ kind: "voice" });

function grantCovers(grant: PromotionalCreditBalance, usage: CreditUsage): boolean {
  if (grant.held) return false;
  // Plan credit, the Free plan's too, pays for app tools (search, voice,
  // images, video, sandbox time); its model scope only limits which models.
  if (grant.planCredit && typeof usage !== "string") return true;
  if (!usage) return false;
  if (typeof usage === "string") return grant.eligibleModelIds.includes(usage);
  return grant.coversVoice === true;
}

export function spendableCreditMicros(
  balance: BillingBalance,
  usage?: CreditUsage,
  origin: BillingOrigin = "app",
): number {
  if (origin === "api") return apiSpendableCreditMicros(balance);
  return (
    Math.max(0, appGeneralMicros(balance) - (balance.heldGeneralCreditMicros ?? 0)) +
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
  /** Funding origin; omitted uses {@link chargeBillingOrigin}. */
  origin?: BillingOrigin | null,
): Promise<CreditBalanceSnapshot> {
  // This existing definer also refreshes structured abuse evidence. Run it
  // only for admission, never for settlement of an already-dispatched call.
  await withAccountRls(db, accountId, async (tx) => {
    await tx.execute(sql`select free_plan_credit_eligible(${accountId}::uuid)`);
  });
  const balance = await getBillingBalance(db, accountId, policyRevision, settlementAt);
  return {
    ...balance,
    balanceMicros: spendableCreditMicros(balance, usage, chargeBillingOrigin(origin)),
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
  origin: BillingOrigin = "app",
) {
  if (!Number.isSafeInteger(requestedMicros) || requestedMicros <= 0) {
    throw new Error("credit debit requires a positive, safe integer micro amount");
  }
  const debitedMicros = Math.min(requestedMicros, spendableCreditMicros(balance, usage, origin));
  // API work spends credits only: no plan allowance and no promotional grant.
  if (origin === "api") return { debitedMicros, allocations: [] };
  // Existing general-credit debt can leave less spendable general funding than
  // the derived allowance. Prepaid admission must never mint spendable credit
  // by repeatedly preserving promotional grants while overdrawing general.
  const planBudget = Math.min(
    balance.plan?.creditScoped ? 0 : (balance.plan?.creditRemainingMicros ?? 0),
    Math.max(0, appGeneralMicros(balance)),
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
  origin: BillingOrigin = "app",
) {
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
    throw new Error("credit debit requires a positive, safe integer micro amount");
  }
  // API work is charged to credits only, which may go negative after use.
  if (origin === "api") return [];
  // Funding reversals/dispute holds can remove general funds without reducing
  // derived period usage. Do not preserve covering promotions by charging an
  // allowance that is no longer backed by a positive general balance.
  const planBudget = Math.min(
    balance.plan?.creditScoped ? 0 : (balance.plan?.creditRemainingMicros ?? 0),
    Math.max(0, appGeneralMicros(balance)),
  );
  return allocateToCoveringGrants(balance, amountMicros, usage, planBudget);
}
