import { BYOK_PLATFORM_FEE_TYPE } from "@opengeni/contracts";

/* ----------------------------------------------------------------------------
   Paid credit: the only funding an own-key platform fee may draw
   (docs/billing-origin.md#paid-credit).

   Paid credit is credit the person paid for and has not spent: top-ups net
   of any coupon discount, operator credit grants and won disputes, less
   Stripe refunds and dispute holds, fees, and the ordinary spending that ran
   past their unpaid credits (unscoped promotional grants, discounts, usage
   refunds). Ordinary spending draws unpaid credits first.

   No ledger walk. Every write that changes paid credit other than by plain
   spending records a receipt on its row under the account lock: the paid
   part it adds or removes (`paidCreditMicros`), fee debt it repays
   (`feeDebtRepaidMicros`), and a mark: paid credits and paid funding just
   before it (`paidCreditsBeforeMicros`, `paidFundingBeforeMicros`, plus the
   paid credit a usage refund returns, `paidRestoredMicros`). Paid credit is

     min(paid funding + min(0, every mark), credits + fee debt)

   where a mark is paid credits before it (plus what it returns) less paid
   funding before it. Paid funding only changes through receipts, and
   between receipts plain spending only lowers credits, so the lowest point
   is either now or a mark. One pass over the ledger reads it: a few sums,
   plus the paid inflows and the unpaid inflows without a receipt (they scale
   with top-ups and grants, not with usage).

   Rows with no receipt (written before receipts existed, or by an older
   release while one rolls out) are bounded conservatively: an unrecorded
   unpaid inflow after the latest mark is taken to arrive when paid credit
   was zero; with no mark at all, paid credit is also at most credits less
   every unrecorded unpaid inflow, and the larger bound holds. Neither ever
   overstates paid credit, and the next receipt pins the result. A top-up
   without a receipt after the latest mark repays fee debt first.
   -------------------------------------------------------------------------- */

/** Paid-for credit: top-ups (net of a coupon discount), operator credit grants, won disputes. */
export const PAID_INFLOW_TYPES = Object.freeze([
  "credit_topup",
  "manual_credit_grant",
  "credit_dispute_release",
] as const);

/** Paid-for credit taken back: Stripe refunds and dispute holds. */
export const PAID_REVERSAL_TYPES = Object.freeze(["credit_refund", "credit_dispute_hold"] as const);

/**
 * Positive general (unscoped) credit of any other type is unpaid: promotional
 * grants, usage refunds, unknown future types. A top-up's coupon discount is
 * unpaid too.
 */
export const NEVER_UNPAID_TYPES: readonly string[] = Object.freeze([
  ...PAID_INFLOW_TYPES,
  ...PAID_REVERSAL_TYPES,
  "plan_credit_grant",
  "plan_credit_expiry",
  BYOK_PLATFORM_FEE_TYPE,
]);

/**
 * What a top-up added in paid credit: its credit, net of the share a coupon
 * discounted (Stripe records the amount paid and the discount in cents).
 * Rounded down. Mirrors the read's SQL.
 */
export function topUpPaidMicros(amountMicros: number, metadata?: Record<string, unknown>): number {
  const discount = metadata?.stripeDiscountCents;
  const total = metadata?.stripeAmountTotalCents;
  if (
    typeof discount !== "number" ||
    typeof total !== "number" ||
    !Number.isSafeInteger(discount) ||
    !Number.isSafeInteger(total) ||
    discount <= 0
  ) {
    return amountMicros;
  }
  const paid = BigInt(Math.max(0, total));
  return Number((BigInt(amountMicros) * paid) / (paid + BigInt(discount)));
}

/** The read's per-account paid-credit totals (see getBillingBalance). */
export type PaidCreditTotals = {
  paidFunding: string;
  feeDebt: string;
  markFloor: string | null;
  latestMarkAt: string | null;
  /** `[at, paid micros, has a receipt]` per paid inflow, `at` in epoch microseconds. */
  paidInflows: [number, number, boolean][] | null;
  /** `[at, unpaid micros]` per unpaid inflow without a receipt. */
  unpaidInflows: [number, number][] | null;
};

export type PaidCreditState = {
  /** Paid credit a fee may draw now; never negative. */
  paidCreditsMicros: number;
  /** Paid funding, net of fees and fee debt repaid: the receipts' baseline. */
  paidFundingMicros: number;
  /** Own-key fee debt still owed. */
  feeDebtMicros: number;
  /** Fee debt that top-ups written without a receipt repaid; the next receipt records it. */
  unrecordedFeeDebtRepaidMicros: number;
};

/** Paid credit from the read's totals and the account's credits (`creditsMicros`). */
export function paidCreditState(totals: PaidCreditTotals, creditsMicros: number): PaidCreditState {
  const latestMark = totals.latestMarkAt === null ? null : Number(totals.latestMarkAt);
  const unpinned = (at: number) => latestMark === null || at > latestMark;
  const paidInflows = [...(totals.paidInflows ?? [])].sort((a, b) => a[0] - b[0]);
  const recordedDebt = Math.max(0, Number(totals.feeDebt));
  // Top-ups an older release wrote after the latest receipt repay fee debt first.
  const unrecordedPaid =
    latestMark === null
      ? 0
      : paidInflows.reduce(
          (sum, [at, paid, recorded]) => sum + (!recorded && unpinned(at) ? paid : 0),
          0,
        );
  const repaid = Math.min(recordedDebt, unrecordedPaid);
  const feeDebtMicros = recordedDebt - repaid;
  const paidFundingMicros = Number(totals.paidFunding) - repaid;
  // Credits ordinary spending may use: fee debt is owed from paid credit only.
  const credits = creditsMicros + feeDebtMicros;
  let floor = Math.min(0, totals.markFloor === null ? 0 : Number(totals.markFloor));
  let unrecordedUnpaid = 0;
  let paidBefore = 0;
  let next = 0;
  const unpaidInflows = (totals.unpaidInflows ?? [])
    .filter(([at]) => unpinned(at))
    .sort((a, b) => a[0] - b[0]);
  for (const [at, amount] of unpaidInflows) {
    while (next < paidInflows.length && paidInflows[next]![0] < at) {
      paidBefore += paidInflows[next]![1];
      next += 1;
    }
    // Taken to arrive when paid credit was zero: all paid before it is spent.
    floor = Math.min(floor, -paidBefore);
    unrecordedUnpaid += amount;
  }
  let paidCreditsMicros = Math.max(0, Math.min(paidFundingMicros + floor, credits));
  if (latestMark === null) {
    // The unpaid credit left is at most what those inflows added.
    paidCreditsMicros = Math.max(
      paidCreditsMicros,
      Math.min(paidFundingMicros, credits - unrecordedUnpaid),
    );
  }
  return {
    paidCreditsMicros,
    paidFundingMicros,
    feeDebtMicros,
    unrecordedFeeDebtRepaidMicros: repaid,
  };
}

/** A receipt's mark: paid credits and paid funding just before its row. */
export function paidCreditMark(state: PaidCreditState, restoredMicros = 0) {
  return {
    paidCreditsBeforeMicros: state.paidCreditsMicros,
    paidFundingBeforeMicros: state.paidFundingMicros,
    ...(restoredMicros > 0 ? { paidRestoredMicros: restoredMicros } : {}),
  };
}

/** Fee debt a receipt records as repaid: what unrecorded top-ups repaid, then its own share. */
export function feeDebtRepaid(state: PaidCreditState, ownMicros = 0) {
  const repaid =
    state.unrecordedFeeDebtRepaidMicros + Math.min(state.feeDebtMicros, Math.max(0, ownMicros));
  return repaid > 0 ? { feeDebtRepaidMicros: repaid } : {};
}
