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
import {
  feeDebtRepaid,
  NEVER_UNPAID_TYPES,
  PAID_INFLOW_TYPES,
  PAID_REVERSAL_TYPES,
  needsLatestMarkUnpaid,
  paidCreditMark,
  paidCreditState,
  topUpPaidMicros,
  type PaidCreditState,
  type PaidCreditTotals,
} from "./paid-credit";
import * as schema from "./schema";

/** Read totals and grant remainders from one database snapshot. */
type CreditBalanceSnapshot = BillingBalance & { creditPolicyRevision?: number };

export async function getBillingBalance(
  db: Database,
  accountId: string,
  policyRevision?: number,
  settlementAt?: string,
  includeHeldForSettlement = false,
  /** Also report paid credits (`paidCreditsMicros`), for fee decisions. */
  includePaidCredits = false,
): Promise<CreditBalanceSnapshot> {
  const { balance, paid } = await readBillingBalance(
    db,
    accountId,
    policyRevision,
    settlementAt,
    includeHeldForSettlement,
  );
  return includePaidCredits ? { ...balance, paidCreditsMicros: paid.paidCreditsMicros } : balance;
}

/** The receipt-row sums behind paid credit, fee debt and this month's fees. */
type ReceiptTotals = Omit<PaidCreditTotals, "paidFunding" | "feeDebt"> & {
  unfunded: string;
  repaid: string;
  paidPart: string;
  feesThisMonth: string;
};

/** SQL list of text literals. */
const textList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/**
 * Rows that can carry a paid-credit receipt: credit added, Stripe refunds and
 * dispute holds, and own-key fees. Ordinary debits never do, so the read
 * never touches their metadata. Spelled as the predicate of
 * credit_ledger_receipt_rows_idx, so the paid-credit figures are read from
 * that index.
 */
const carriesReceiptSql = sql.raw(
  `(entry.amount_micros > 0 or entry.type in (${[...PAID_REVERSAL_TYPES, BYOK_PLATFORM_FEE_TYPE]
    .map((type) => `'${type}'`)
    .join(", ")}))`,
);
const markedSql = sql.raw(`(entry.metadata->'paidFundingBeforeMicros') is not null`);
const atMicrosSql = sql.raw(`floor(extract(epoch from entry.created_at) * 1000000)::bigint`);
const feeDebtRepaidSql = sql.raw(`(entry.metadata->>'feeDebtRepaidMicros')::bigint`);
/** The paid credit a receipt-carrying row adds or takes back, before fee debt repaid. */
const paidPartSql = sql.raw(`case
  when (entry.metadata->'paidCreditMicros') is not null then (entry.metadata->>'paidCreditMicros')::bigint
  when entry.type = 'credit_topup' then case
    when jsonb_typeof(entry.metadata->'stripeDiscountCents') = 'number'
      and jsonb_typeof(entry.metadata->'stripeAmountTotalCents') = 'number'
      and (entry.metadata->>'stripeDiscountCents')::numeric > 0
    then floor(entry.amount_micros::numeric * greatest(0, (entry.metadata->>'stripeAmountTotalCents')::numeric)
      / (greatest(0, (entry.metadata->>'stripeAmountTotalCents')::numeric)
        + (entry.metadata->>'stripeDiscountCents')::numeric))::bigint
    else entry.amount_micros end
  when entry.type in (${[...PAID_INFLOW_TYPES, ...PAID_REVERSAL_TYPES].map((type) => `'${type}'`).join(", ")}) then entry.amount_micros
  when entry.type = '${BYOK_PLATFORM_FEE_TYPE}' then -coalesce((entry.metadata->>'creditPaidMicros')::bigint, 0)
  else 0 end`);

/**
 * The balance and the paid-credit state behind it (see paid-credit.ts). One
 * pass over the account's ledger sums the balance and API spending, exactly
 * as without own-key fees; the paid-credit figures come from the rows that
 * can carry a receipt only, through credit_ledger_receipt_rows_idx, so their
 * cost scales with top-ups, grants, refunds and fees, not with spending.
 */
export async function readBillingBalance(
  db: Database,
  accountId: string,
  policyRevision?: number,
  settlementAt?: string,
  includeHeldForSettlement = false,
): Promise<{ balance: CreditBalanceSnapshot; paid: PaidCreditState }> {
  return await withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{
      balance: string;
      grants: PromotionalCreditBalance[];
      revision: number;
      plan: BillingPlanBalance | null;
      decision: NonNullable<BillingBalance["promotionDecision"]>;
      enforcement: boolean;
      apiSpent: string;
      receipts: ReceiptTotals | null;
    }>(
      tx,
      sql`
      with current_policy as (
        select revision, policy from opengeni_private.credit_promotion_policy_revisions
        where (${policyRevision ?? null}::bigint is null or revision <= ${policyRevision ?? null}::bigint)
        order by revision desc limit 1
      ), totals as (
        -- One pass over the ledger: the balance, and what API work (other
        -- than own-key fees) has spent.
        select coalesce(sum(entry.amount_micros), 0)::text as balance,
          coalesce(sum(-entry.amount_micros) filter (where entry.usage_origin = 'api'
            and entry.type <> ${BYOK_PLATFORM_FEE_TYPE}), 0)::text as "apiSpent"
        from ${schema.creditLedgerEntries} entry
        where entry.account_id = ${accountId}
      ), receipts as (
        -- Rows that can carry a receipt only: own-key fee debt (fees'
        -- unfunded shares, less what paid-for credit repaid), this calendar
        -- month's (UTC) own-key fees, and paid credit's receipts.
        select
          coalesce(sum((entry.metadata->>'unfundedMicros')::bigint)
            filter (where entry.type = ${BYOK_PLATFORM_FEE_TYPE}), 0)::text as unfunded,
          coalesce(sum(${feeDebtRepaidSql}), 0)::text as repaid,
          coalesce(sum(-entry.amount_micros) filter (where entry.type = ${BYOK_PLATFORM_FEE_TYPE}
            and entry.created_at >= (select date_trunc('month', statement_timestamp() at time zone 'UTC') at time zone 'UTC')),
            0)::text as "feesThisMonth",
          coalesce(sum(${paidPartSql}), 0)::text as "paidPart",
          min((entry.metadata->>'paidCreditsBeforeMicros')::bigint
            + coalesce((entry.metadata->>'paidRestoredMicros')::bigint, 0)
            - (entry.metadata->>'paidFundingBeforeMicros')::bigint)
            filter (where ${markedSql})::text as "markFloor",
          floor(extract(epoch from max(entry.created_at) filter (where ${markedSql}))
            * 1000000)::bigint::text as "latestMarkAt",
          jsonb_agg(jsonb_build_array(${atMicrosSql}, ${paidPartSql}, ${markedSql}))
            filter (where entry.amount_micros > 0 and entry.type in (${textList(PAID_INFLOW_TYPES)})
              and ${paidPartSql} > 0) as "paidInflows",
          jsonb_agg(jsonb_build_array(${atMicrosSql}, entry.amount_micros - ${paidPartSql}))
            filter (where entry.amount_micros > 0 and entry.eligible_model_ids is null
              and (entry.type = 'credit_topup' or entry.type not in (${textList(NEVER_UNPAID_TYPES)}))
              and not ${markedSql} and entry.amount_micros > ${paidPartSql}) as "unpaidInflows"
        from ${schema.creditLedgerEntries} entry
        where entry.account_id = ${accountId} and ${carriesReceiptSql}
      )
      select
        coalesce((select decision from promotion_decisions where account_id=${accountId}::uuid), 'eligible') as decision,
        (select enabled from promotion_enforcement where singleton) as enforcement,
        coalesce((select revision from current_policy), 0)::int as revision,
        read_organization_plan_balance(${accountId}::uuid, coalesce(${settlementAt ?? null}::timestamptz, statement_timestamp())) as plan,
        (select balance from totals) as balance,
        (select "apiSpent" from totals) as "apiSpent",
        (select to_jsonb(receipts) from receipts) as receipts,
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
    const plan = row?.plan ?? null;
    const creditsMicros = creditsOutsidePlan(generalBalanceMicros, plan);
    const receipts = row?.receipts;
    const repaid = Number(receipts?.repaid ?? 0);
    const totals: PaidCreditTotals = {
      paidFunding: String(Number(receipts?.paidPart ?? 0) - repaid),
      feeDebt: String(Number(receipts?.unfunded ?? 0) - repaid),
      markFloor: receipts?.markFloor ?? null,
      latestMarkAt: receipts?.latestMarkAt ?? null,
      paidInflows: receipts?.paidInflows ?? null,
      unpaidInflows: receipts?.unpaidInflows ?? null,
    };
    // The debt plan credit never repays (as
    // opengeni_private.plan_app_general_balance, term for term): what API
    // work has spent plus own-key fee debt still owed.
    const debtCap = Math.max(0, Number(row?.apiSpent ?? 0) + Number(totals.feeDebt));
    const feesThisMonth = Number(receipts?.feesThisMonth ?? 0);
    const paid = paidCreditState(
      totals,
      creditsMicros,
      needsLatestMarkUnpaid(totals) ? await latestMarkUnpaidMicros(tx, accountId, totals) : null,
    );
    return {
      paid,
      balance: {
        accountId,
        creditPolicyRevision: row?.revision ?? 0,
        balanceMicros,
        generalBalanceMicros,
        creditsMicros,
        ...debts(creditsMicros, debtCap, paid.feeDebtMicros),
        paidPlanCreditMicros: paidPlanCreditMicros(plan),
        ...(feesThisMonth > 0 ? { byokPlatformFeeMonthMicros: feesThisMonth } : {}),
        heldGeneralCreditMicros,
        heldCreditMicros:
          heldGeneralCreditMicros +
          promotionalCredits.reduce(
            (sum, grant) => sum + (grant.held ? grant.remainingMicros : 0),
            0,
          ),
        promotionDecision: row?.enforcement ? row.decision : "eligible",
        promotionalCredits,
        plan,
        currency: "usd",
        updatedAt: new Date().toISOString(),
      },
    };
  });
}

/**
 * The unpaid credit the latest receipt left (`unpaidCreditsAfterMicros`):
 * read only after rows without a receipt, through the account/created_at
 * index.
 */
async function latestMarkUnpaidMicros(
  tx: Database,
  accountId: string,
  totals: PaidCreditTotals,
): Promise<number | null> {
  const [mark] = await rawRows<{ unpaid: string | null }>(
    tx,
    sql`select max((metadata->>'unpaidCreditsAfterMicros')::bigint)::text as unpaid
      from ${schema.creditLedgerEntries}
      where account_id = ${accountId}
        and created_at = timestamptz 'epoch' + ${totals.latestMarkAt}::bigint * interval '1 microsecond'
        and (metadata->'paidFundingBeforeMicros') is not null`,
  );
  return mark?.unpaid == null ? null : Number(mark.unpaid);
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
 * Two debts plan and promotional credit never repay. Own-key fee debt: fee
 * shares that found no paid credit when they settled, less what paid-for
 * credit repaid since (the next top-up repays it first; see paid-credit.ts).
 * Negative credits up to what API work has spent plus the fee debt still
 * owed are never repaid from plan credit either: the database's
 * plan_app_general_balance applies the same cap, term for term, at period
 * expiry and to a new period's opening debt. Fees paid in full never raise
 * it, so an app overdraft is still netted from the next period. API debt is
 * the part of that not owed as fee debt.
 */
function debts(creditsMicros: number, debtCapMicros: number, feeDebt: number) {
  const apiDebt = Math.max(
    0,
    Math.min(Math.max(0, -creditsMicros), Math.max(0, debtCapMicros)) - feeDebt,
  );
  return {
    ...(apiDebt > 0 ? { apiDebtMicros: apiDebt } : {}),
    ...(feeDebt > 0 ? { byokFeeDebtMicros: feeDebt } : {}),
  };
}

/**
 * General credit app work may use: API debt never shrinks the plan
 * allowance, and own-key fee debt never draws plan or promotional credit.
 */
function appGeneralMicros(balance: BillingBalance): number {
  return (
    (balance.generalBalanceMicros ?? balance.balanceMicros) +
    (balance.apiDebtMicros ?? 0) +
    (balance.byokFeeDebtMicros ?? 0)
  );
}

/**
 * Paid plan credit, which a bring-your-own-key fee may draw for app use: an
 * active paid plan's remaining unrestricted credit. Free plan credit never
 * counts, and a plan that is not active (past due, unpaid) pays no fee. Paid
 * credits (`paidCreditsMicros`) are in paid-credit.ts.
 */
function paidPlanCreditMicros(plan: BillingPlanBalance | null): number {
  return plan && plan.key !== "free" && !plan.creditScoped && plan.status === "active"
    ? Math.max(0, plan.creditRemainingMicros)
    : 0;
}

/**
 * How an own-key fee settles: a paid plan's credit first (app use, and only
 * what the plan's allowance still backs), then paid credits. The rest is fee
 * debt: parallel calls admitted on the same paid credit can run past it.
 * plan_period_usage counts exactly `planPaidMicros` against the plan.
 */
export function byokFeeFunding(
  balance: BillingBalance,
  paid: PaidCreditState,
  amountMicros: number,
  origin: BillingOrigin,
) {
  const planPaidMicros =
    origin === "app"
      ? Math.min(
          amountMicros,
          balance.paidPlanCreditMicros ?? 0,
          Math.max(0, appGeneralMicros(balance)),
        )
      : 0;
  const creditPaidMicros = Math.min(amountMicros - planPaidMicros, paid.paidCreditsMicros);
  return {
    planPaidMicros,
    creditPaidMicros,
    unfundedMicros: amountMicros - planPaidMicros - creditPaidMicros,
  };
}

/**
 * The paid-credit receipt a ledger write records on its row (paid-credit.ts),
 * read under the account lock just before the write. Paid-for credit,
 * Stripe refunds and dispute holds, and unpaid credit (promotional grants,
 * usage refunds, a coupon's discount) get one; plain spending needs none.
 */
export async function paidCreditReceipt(
  tx: Database,
  input: {
    accountId: string;
    settledAt: string;
    type: string;
    amountMicros: number;
    eligibleModelIds?: readonly string[] | null | undefined;
    metadata?: Record<string, unknown> | undefined;
    sourceType?: string | null | undefined;
    sourceId?: string | null | undefined;
  },
): Promise<Record<string, number>> {
  // Scoped grants are promotional credit outside general credit.
  if (input.eligibleModelIds) return {};
  const paidInflow =
    input.amountMicros > 0 && (PAID_INFLOW_TYPES as readonly string[]).includes(input.type);
  const reversal =
    input.amountMicros < 0 && (PAID_REVERSAL_TYPES as readonly string[]).includes(input.type);
  const unpaid = input.amountMicros > 0 && !NEVER_UNPAID_TYPES.includes(input.type);
  if (!paidInflow && !reversal && !unpaid) return {};
  const { paid } = await readBillingBalance(tx, input.accountId, undefined, input.settledAt, true);
  if (paidInflow) {
    const part =
      input.type === "credit_topup"
        ? topUpPaidMicros(input.amountMicros, input.metadata)
        : input.type === "credit_dispute_release"
          ? await releasedPaidMicros(tx, input)
          : input.amountMicros;
    // A coupon's discount (or a release beyond what its hold took from paid
    // credit) is unpaid credit, arriving here.
    return {
      paidCreditMicros: part,
      ...paidCreditMark(paid, 0, input.amountMicros - part),
      ...feeDebtRepaid(paid, part),
    };
  }
  if (reversal) {
    // Money given back takes paid credit first; the rest takes credits like spending.
    return {
      paidCreditMicros: -Math.min(-input.amountMicros, paid.paidCreditsMicros),
      ...paidCreditMark(paid),
      ...feeDebtRepaid(paid),
    };
  }
  // A usage refund reverses its debit: what the debit drew from paid credit
  // returns as paid credit, the rest as unpaid.
  const restored =
    input.type === "video_generation_refund"
      ? Math.min(input.amountMicros, await refundedDebitPaidMicros(tx, input))
      : 0;
  return {
    ...paidCreditMark(paid, restored, input.amountMicros - restored),
    ...feeDebtRepaid(paid, restored),
  };
}

/** A won dispute returns as paid credit what its hold took from paid credit. */
async function releasedPaidMicros(
  tx: Database,
  input: {
    accountId: string;
    amountMicros: number;
    sourceType?: string | null | undefined;
    sourceId?: string | null | undefined;
  },
): Promise<number> {
  const [hold] = await rawRows<{ paid: string | null }>(
    tx,
    sql`select metadata->>'paidCreditMicros' as paid from ${schema.creditLedgerEntries}
      where account_id = ${input.accountId} and type = 'credit_dispute_hold'
        and source_type is not distinct from ${input.sourceType ?? null}
        and source_id is not distinct from ${input.sourceId ?? null}
      order by created_at, id limit 1`,
  );
  return hold?.paid == null
    ? input.amountMicros
    : Math.min(input.amountMicros, Math.max(0, -Number(hold.paid)));
}

/** What a refunded video's debit drew from paid credit (`paidDrawnMicros`). */
async function refundedDebitPaidMicros(
  tx: Database,
  input: {
    accountId: string;
    sourceType?: string | null | undefined;
    sourceId?: string | null | undefined;
  },
): Promise<number> {
  const [debit] = await rawRows<{ paid: string | null }>(
    tx,
    sql`select metadata->>'paidDrawnMicros' as paid from ${schema.creditLedgerEntries}
      where account_id = ${input.accountId} and type = 'video_generation_debit'
        and source_type is not distinct from ${input.sourceType ?? null}
        and source_id is not distinct from ${input.sourceId ?? null}
      order by created_at, id limit 1`,
  );
  return Math.max(0, Number(debit?.paid ?? 0));
}

/**
 * The paid credit an ordinary debit draws, recorded on refundable debits so
 * the refund can return it: only what unpaid credit could not cover. The
 * debit charges credits whatever plan credit and covering grants
 * (`allocations`) leave.
 */
export function paidDrawnMicros(
  balance: BillingBalance,
  paid: PaidCreditState,
  amountMicros: number,
  allocations: readonly { amountMicros: number }[],
  origin: BillingOrigin,
): number {
  const net =
    amountMicros - allocations.reduce((sum, allocation) => sum + allocation.amountMicros, 0);
  const plan = balance.plan;
  const credits =
    origin === "app" && plan && !plan.creditScoped
      ? Math.max(0, net - Math.max(0, plan.creditRemainingMicros))
      : net;
  const after = (balance.creditsMicros ?? 0) + paid.feeDebtMicros - credits;
  return Math.max(0, paid.paidCreditsMicros - Math.max(0, after));
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
  const balance = await getBillingBalance(db, accountId, undefined, undefined, false, true);
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
