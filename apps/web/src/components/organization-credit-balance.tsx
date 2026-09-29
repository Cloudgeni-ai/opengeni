import { formatMoneyMicros } from "@/lib/format";
import type { BillingSummary } from "@/types";

/** The credit balance, large, with one line on what it means. */
export function OrganizationCreditBalance({
  billing,
  canReadBilling,
  hasAccount,
  loading,
  hasError,
}: {
  billing: BillingSummary | null;
  canReadBilling: boolean;
  hasAccount: boolean;
  loading: boolean;
  hasError: boolean;
}) {
  const balance = billing?.balance;
  const isNegative = balance !== undefined && balance.balanceMicros < 0;
  if (!balance) {
    return (
      <p
        role={loading && !hasError ? "status" : undefined}
        className="text-sm leading-5 text-fg-muted"
      >
        {!canReadBilling || !hasAccount
          ? "You don't have permission to view billing."
          : hasError
            ? "Couldn't load your balance."
            : loading
              ? "Loading balance…"
              : "The balance isn't available on this deployment."}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-2xl leading-8 font-semibold tracking-[-0.5px] text-fg tabular-nums">
        {isNegative
          ? `${formatMoneyMicros(Math.abs(balance.balanceMicros), balance.currency)} in prior usage`
          : `${formatMoneyMicros(balance.balanceMicros, balance.currency)} available`}
      </p>
      <p className="mt-1 text-xs leading-[18px] text-fg-muted">
        {isNegative
          ? "Future credit purchases cover prior usage first. Your card is not charged automatically."
          : "Pays for model and platform usage the organization funds."}
      </p>
    </div>
  );
}
