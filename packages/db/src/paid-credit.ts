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
   is either now or a mark.

   Each receipt also carries the running totals over every row up to and
   including it (`paidCreditTotals`, PaidCreditChain): the sums of
   paid parts, fee debt repaid, fees' unfunded shares and paid inflows, the
   lowest mark, and this month's fees. Ledger writes that change paid credit
   take the account lock and stamp `created_at` after it, so the latest
   receipt holds the totals of every row before it. The balance read takes
   that one receipt, through credit_ledger_receipt_rows_idx, plus the rows
   that can carry a receipt written after it (normally none). Its cost does
   not grow with fees, top-ups or grants; ordinary debits' metadata is never
   read.

   Rows with no receipt (written before receipts existed, or by an older
   release while one rolls out) are bounded conservatively. Unpaid credit
   only grows through unpaid inflows, so after unrecorded ones paid credit is
   at least credits less the unpaid credit the latest receipt left (none
   before the first) less those inflows. Each such inflow is also taken to
   arrive when paid credit was zero, and the larger bound holds. Neither
   ever overstates paid credit, and the next receipt folds them into its
   totals. A top-up without a receipt after the latest receipt repays fee
   debt first.
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

/**
 * Running totals a receipt carries (`paidCreditTotals`), over every ledger
 * row up to and including its own. Fees are this month's (UTC), `feeMonth`.
 */
export type PaidCreditChain = {
  /** Receipts so far: orders receipts written in the same microsecond. */
  n: number;
  /** Paid credit receipts added or took back (fees: what they drew). */
  paidPart: number;
  /** Fee debt repaid. */
  repaid: number;
  /** Fees' unfunded shares. */
  unfunded: number;
  /** The lowest mark. */
  markFloor: number | null;
  /** Paid inflows' paid parts. */
  paidInflow: number;
  feeMonth: string | null;
  feesInMonth: number;
};

export const EMPTY_PAID_CREDIT_CHAIN: PaidCreditChain = Object.freeze({
  n: 0,
  paidPart: 0,
  repaid: 0,
  unfunded: 0,
  markFloor: null,
  paidInflow: 0,
  feeMonth: null,
  feesInMonth: 0,
});

/** The read's per-account paid-credit totals (see readBillingBalance). */
export type PaidCreditTotals = {
  /** Running totals through now: the latest receipt's plus the rows after it. */
  chain: PaidCreditChain;
  /** When the latest receipt was written, epoch microseconds; null before the first. */
  latestMarkAt: number | null;
  /** The unpaid credit the latest receipt left (`unpaidCreditsAfterMicros`). */
  latestMarkUnpaid: number | null;
  /** Paid inflows' paid parts up to the latest receipt. */
  paidInflowBefore: number;
  /** `[at, paid micros, has a receipt]` per paid inflow after it, `at` in epoch microseconds. */
  paidInflows: [number, number, boolean][] | null;
  /** `[at, unpaid micros]` per unpaid inflow without a receipt after it. */
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
  /** Running totals through now, which the next receipt extends. */
  chain: PaidCreditChain;
};

/** Paid credit from the read's totals and the account's credits (`creditsMicros`). */
export function paidCreditState(totals: PaidCreditTotals, creditsMicros: number): PaidCreditState {
  const { chain } = totals;
  const latestMark = totals.latestMarkAt;
  const unpinned = (at: number) => latestMark === null || at > latestMark;
  const paidInflows = [...(totals.paidInflows ?? [])].sort((a, b) => a[0] - b[0]);
  const recordedDebt = Math.max(0, chain.unfunded - chain.repaid);
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
  const paidFundingMicros = chain.paidPart - chain.repaid - repaid;
  // Credits ordinary spending may use: fee debt is owed from paid credit only.
  const credits = creditsMicros + feeDebtMicros;
  const recordedFloor = Math.min(0, chain.markFloor ?? 0);
  let floor = recordedFloor;
  let unrecordedUnpaid = 0;
  let paidBefore = totals.paidInflowBefore;
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
  const unpaidBefore = latestMark === null ? 0 : totals.latestMarkUnpaid;
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
    chain,
  };
}

/**
 * A receipt with the running totals after its row (`paidCreditTotals`):
 * the state's totals through now plus what this row adds. Every receipt
 * writer extends the chain, under the account lock.
 */
export function chainedReceipt<
  R extends Record<string, number> & {
    paidCreditsBeforeMicros: number;
    paidFundingBeforeMicros: number;
  },
>(
  state: PaidCreditState,
  row: { type: string; amountMicros: number },
  receipt: R,
): R & { paidCreditTotals: PaidCreditChain } {
  const fee = row.type === BYOK_PLATFORM_FEE_TYPE;
  const paidPart = fee ? -(receipt.creditPaidMicros ?? 0) : (receipt.paidCreditMicros ?? 0);
  const mark =
    receipt.paidCreditsBeforeMicros +
    (receipt.paidRestoredMicros ?? 0) -
    receipt.paidFundingBeforeMicros;
  const paidInflow =
    row.amountMicros > 0 &&
    (PAID_INFLOW_TYPES as readonly string[]).includes(row.type) &&
    paidPart > 0
      ? paidPart
      : 0;
  const { chain } = state;
  return {
    ...receipt,
    paidCreditTotals: {
      n: chain.n + 1,
      paidPart: chain.paidPart + paidPart,
      repaid: chain.repaid + (receipt.feeDebtRepaidMicros ?? 0),
      unfunded: chain.unfunded + (fee ? (receipt.unfundedMicros ?? 0) : 0),
      markFloor: Math.min(chain.markFloor ?? mark, mark),
      paidInflow: chain.paidInflow + paidInflow,
      feeMonth: chain.feeMonth,
      feesInMonth: chain.feesInMonth + (fee ? Math.abs(row.amountMicros) : 0),
    },
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
