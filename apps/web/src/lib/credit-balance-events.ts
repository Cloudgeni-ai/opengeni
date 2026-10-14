/** Invalidate account balances and model funding after confirmed fulfillment. */
export const CREDIT_BALANCE_CHANGED = "credit-balance-changed";

export function notifyCreditBalanceChanged(accountId: string): void {
  window.dispatchEvent(new CustomEvent(CREDIT_BALANCE_CHANGED, { detail: { accountId } }));
}
