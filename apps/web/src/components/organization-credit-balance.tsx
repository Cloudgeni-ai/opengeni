import { formatMoneyMicros } from "@opengeni/react/app/lib/format";
import type { BillingSummary } from "@opengeni/react/app/types";
import { CreditScopeDetails } from "@/components/credits/credit-scope-details";
import { PromotionReviewNotice } from "@/components/promotion-review-notice";

/** The credit balance, large, with one line on what it means. */
export function OrganizationCreditBalance({
  billing,
  canReadBilling,
  hasAccount,
  loading,
  hasError,
  showPlanCredit = false,
  supportEmail,
}: {
  billing: BillingSummary | null;
  canReadBilling: boolean;
  hasAccount: boolean;
  loading: boolean;
  hasError: boolean;
  /** Only true after the enabled subscription catalog has been read. */
  showPlanCredit?: boolean;
  supportEmail?: string | undefined;
}) {
  const balance = billing?.balance;
  const holdNotice =
    balance?.promotionDecision && balance.promotionDecision !== "eligible" ? (
      <div className="mt-2">
        <PromotionReviewNotice
          decision={balance.promotionDecision}
          accountId={balance.accountId}
          supportEmail={supportEmail}
        />
        {(balance.heldCreditMicros ?? 0) > 0 ? (
          <p className="mt-2 text-sm text-fg-muted">
            {formatMoneyMicros(balance.heldCreditMicros!, balance.currency)} of the balance is on
            hold.
          </p>
        ) : null}
      </div>
    ) : null;
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
  // A period without a monthly grant shows no "$0.00 monthly plan credit" row.
  const plan = showPlanCredit && (balance.plan?.creditGrantedMicros ?? 0) > 0 ? balance.plan : null;
  const byokFee = balance.byokPlatformFeeMonthMicros ?? 0;
  // A charge, not a balance: set apart below the balances.
  const feeLine =
    byokFee > 0 ? (
      <div
        data-testid="byok-platform-fee"
        className="mt-3 flex items-center justify-between gap-4 border-t border-border pt-3 pr-6"
      >
        <div className="min-w-0">
          <p className="text-sm text-fg-muted">Platform fee on your own keys</p>
          <p className="mt-0.5 text-xs leading-[18px] text-fg-subtle">Charged this month</p>
        </div>
        <span className="shrink-0 text-sm text-fg-muted tabular-nums">
          {formatMoneyMicros(byokFee, balance.currency)}
        </span>
      </div>
    ) : null;
  if (balance.promotionalCredits?.length || plan) {
    // Credits: what API use spends, and app use beyond plan credit. Without a
    // plan row, plan credit stays in this row so the rows add up.
    const general = plan
      ? (balance.creditsMicros ??
        (balance.generalBalanceMicros ?? balance.balanceMicros) -
          (plan.creditScoped ? 0 : plan.creditRemainingMicros))
      : (balance.generalBalanceMicros ?? balance.balanceMicros);
    const scopedPlan = balance.promotionalCredits?.find((grant) => grant.planCredit);
    // With a plan, plan credit and credits pay for different use, so they
    // show as two balances without a blended total.
    return (
      <div className="min-w-0">
        {plan ? null : (
          <>
            <p className="text-2xl leading-8 font-semibold tracking-[-0.5px] text-fg tabular-nums">
              {formatMoneyMicros(balance.balanceMicros, balance.currency)}
            </p>
            <p className="mt-1 text-xs leading-[18px] text-fg-muted">Total balance</p>
          </>
        )}
        {holdNotice}
        <div
          className={plan ? "-mx-2 divide-y divide-border" : "mt-4 -mx-2 divide-y divide-border"}
        >
          {plan && !scopedPlan ? (
            <div className="flex min-h-16 items-center justify-between gap-4 py-3 pl-2 pr-8">
              <div>
                <p className="text-sm font-medium text-fg">Plan credit</p>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {plan.creditScoped
                    ? "For free-credit models in the app. Resets monthly."
                    : "For app use. Resets monthly."}
                </p>
              </div>
              <span className="shrink-0 text-sm font-medium text-fg tabular-nums">
                {formatMoneyMicros(plan.creditRemainingMicros, balance.currency)}
              </span>
            </div>
          ) : null}
          {balance.promotionalCredits?.map((grant) => (
            <CreditScopeDetails
              key={grant.grantId}
              label={grant.planCredit ? "Plan credit" : grant.label}
              amount={formatMoneyMicros(grant.remainingMicros, balance.currency)}
              eligibleModelIds={grant.eligibleModelIds}
              coversVoice={grant.coversVoice}
              description={
                grant.held
                  ? "On hold · Not available to spend"
                  : grant.planCredit
                    ? "For app use · Resets monthly · View models"
                    : undefined
              }
            />
          ))}
          <div className="flex min-h-16 items-center justify-between gap-4 py-3 pl-2 pr-8">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Credits</p>
              <p className="mt-0.5 text-xs leading-[18px] text-fg-muted">
                {general < 0
                  ? "Future purchases cover prior usage first."
                  : general === 0 && balance.promotionalCredits?.length
                    ? "Other models need credits."
                    : plan
                      ? "For API use, and app use beyond plan credit."
                      : "For any model and platform usage."}
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-fg tabular-nums">
              {formatMoneyMicros(general, balance.currency)}
            </span>
          </div>
        </div>
        {feeLine}
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
      {holdNotice}
      {feeLine}
    </div>
  );
}
