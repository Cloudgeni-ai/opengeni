import { formatMoneyMicros } from "@/lib/format";
import type { BillingSummary } from "@/types";
import { CreditScopeDetails } from "@/components/credits/credit-scope-details";

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
  if (balance.promotionalCredits?.length) {
    const general = balance.generalBalanceMicros ?? balance.balanceMicros;
    return (
      <div className="min-w-0">
        <p className="text-2xl leading-8 font-semibold tracking-[-0.5px] text-fg tabular-nums">
          {formatMoneyMicros(balance.balanceMicros, balance.currency)}
        </p>
        <p className="mt-1 text-xs leading-[18px] text-fg-muted">Total balance</p>
        <div className="mt-4 -mx-2 divide-y divide-border">
          {balance.promotionalCredits.map((grant) => (
            <CreditScopeDetails
              key={grant.grantId}
              label={grant.label}
              amount={formatMoneyMicros(grant.remainingMicros, balance.currency)}
              eligibleModelIds={grant.eligibleModelIds}
              coversVoice={grant.coversVoice}
            />
          ))}
          <div className="flex min-h-16 items-center justify-between gap-4 py-3 pl-2 pr-8">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">General credits</p>
              <p className="mt-0.5 text-xs leading-[18px] text-fg-muted">
                {general < 0
                  ? "Future purchases cover prior usage first."
                  : "For models and platform usage."}
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-fg tabular-nums">
              {formatMoneyMicros(general, balance.currency)}
            </span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <p className="text-2xl leading-8 font-semibold tracking-[-0.5px] text-fg tabular-nums">
        {isNegative
          ? `${formatMoneyMicros(Math.abs(balance.balanceMicros), balance.currency)} in prior usage`
          : formatMoneyMicros(balance.balanceMicros, balance.currency)}
      </p>
      <p className="mt-1 text-xs leading-[18px] text-fg-muted">
        {isNegative
          ? "Future credit purchases cover prior usage first. Your card is not charged automatically."
          : "Total balance"}
      </p>
    </div>
  );
}
