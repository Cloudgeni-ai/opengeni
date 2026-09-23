import { Loader2Icon } from "lucide-react";

import { formatMoneyMicros } from "@/lib/format";
import type { BillingSummary } from "@/types";

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
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
          Credit balance
        </h2>
        <p
          className={
            billing
              ? "mt-1 text-2xl font-semibold tracking-tight text-fg"
              : "mt-2 flex items-center gap-1.5 text-xs text-fg-muted"
          }
        >
          {balance ? (
            isNegative ? (
              `${formatMoneyMicros(Math.abs(balance.balanceMicros), balance.currency)} in prior usage`
            ) : (
              `${formatMoneyMicros(balance.balanceMicros, balance.currency)} available`
            )
          ) : !canReadBilling || !hasAccount ? (
            "You don't have permission to view billing."
          ) : hasError ? (
            "Couldn't load your balance"
          ) : loading ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading balance…
            </>
          ) : (
            "Billing balance unavailable"
          )}
        </p>
        <p className="mt-1 text-xs text-fg-muted">
          {isNegative
            ? "Future credit purchases cover prior usage first. Your card is not charged automatically."
            : "Used for organization-funded model and platform usage."}
        </p>
      </div>
      <span className="rounded-full border border-border px-2 py-1 text-xs text-fg-muted">
        {billing?.mode ?? "unknown"}
      </span>
    </div>
  );
}
