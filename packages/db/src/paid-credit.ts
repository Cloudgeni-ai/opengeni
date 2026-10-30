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
   paid credit a usage refund returns, `paidRestoredMicros`) and the unpaid
   credit just after it (`unpaidCreditsAfterMicros`). Paid credit is

     min(paid funding + min(0, every mark), credits + fee debt)

   where a mark is paid credits before it (plus what it returns) less paid
   funding before it. Paid funding only changes through receipts, and
   between receipts plain spending only lowers credits, so the lowest point
   is either now or a mark. The balance read takes it from the rows that can
   carry a receipt alone (credit added, Stripe refunds and dispute holds,
   fees; credit_ledger_receipt_rows_idx): a few sums, plus the paid inflows
   and the unpaid inflows without a receipt. Its cost scales with top-ups,
   grants, refunds and fees; ordinary debits' metadata is never read.

   Rows with no receipt (written before receipts existed, or by an older
   release while one rolls out) are bounded conservatively. Unpaid credit
   only grows through unpaid inflows, so after unrecorded ones paid credit is
   at least credits less the unpaid credit the latest receipt left (none
   before the first) less those inflows. Each such inflow is also taken to
   arrive when paid credit was zero, and the larger bound holds. Neither
   ever overstates paid credit, and the next receipt pins the result. A
   top-up without a receipt after the latest mark repays fee debt first.
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
  /** Unpaid credit: credits (with fee debt added back) that are not paid credit. */
  unpaidCreditsMicros: number;
};

/**
 * Whether paid credit needs the unpaid credit the latest receipt left
 * (`unpaidCreditsAfterMicros`): only after unpaid inflows without a receipt.
 */
export function needsLatestMarkUnpaid(totals: PaidCreditTotals): boolean {
  if (totals.latestMarkAt === null) return false;
  const latestMark = Number(totals.latestMarkAt);
  return (totals.unpaidInflows ?? []).some(([at]) => at > latestMark);
}

/**
 * Paid credit from the read's totals and the account's credits
 * (`creditsMicros`). `latestMarkUnpaidMicros` is the latest receipt's
 * `unpaidCreditsAfterMicros` when {@link needsLatestMarkUnpaid}.
 */
export function paidCreditState(
  totals: PaidCreditTotals,
  creditsMicros: number,
  latestMarkUnpaidMicros?: number | null,
): PaidCreditState {
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
  const recordedFloor = Math.min(0, totals.markFloor === null ? 0 : Number(totals.markFloor));
  let floor = recordedFloor;
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
  const unpaidBefore = latestMark === null ? 0 : latestMarkUnpaidMicros;
  if (unrecordedUnpaid > 0 && typeof unpaidBefore === "number") {
    // Unpaid credit is at most what the latest receipt left plus those
    // inflows; never more than the receipts alone allow.
    const upper = Math.max(0, Math.min(paidFundingMicros + recordedFloor, credits));
    paidCreditsMicros = Math.max(
      paidCreditsMicros,
      Math.min(upper, credits - Math.max(0, unpaidBefore) - unrecordedUnpaid),
    );
  }
  return {
    paidCreditsMicros,
    paidFundingMicros,
    feeDebtMicros,
    unrecordedFeeDebtRepaidMicros: repaid,
    unpaidCreditsMicros: Math.max(0, credits - paidCreditsMicros),
  };
}

/**
 * A receipt's mark: paid credits and paid funding just before its row, and
 * the unpaid credit just after it (at most what was there plus the unpaid
 * credit the row adds, `unpaidAddedMicros`).
 */
export function paidCreditMark(state: PaidCreditState, restoredMicros = 0, unpaidAddedMicros = 0) {
  return {
    paidCreditsBeforeMicros: state.paidCreditsMicros,
    paidFundingBeforeMicros: state.paidFundingMicros,
    ...(restoredMicros > 0 ? { paidRestoredMicros: restoredMicros } : {}),
    unpaidCreditsAfterMicros: state.unpaidCreditsMicros + Math.max(0, unpaidAddedMicros),
  };
}

/** Fee debt a receipt records as repaid: what unrecorded top-ups repaid, then its own share. */
export function feeDebtRepaid(state: PaidCreditState, ownMicros = 0) {
  const repaid =
    state.unrecordedFeeDebtRepaidMicros + Math.min(state.feeDebtMicros, Math.max(0, ownMicros));
  return repaid > 0 ? { feeDebtRepaidMicros: repaid } : {};
}
