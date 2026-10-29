import { useLayoutEffect, useState } from "react";
import type { BillingPlanBalance, BillingSubscriptionCatalog } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { AppContext } from "@opengeni/react/app/app-context";
import { CreditRefusalNotice } from "@opengeni/react/app/components/credits/credit-refusal-notice";
import { FailedSessionBanner } from "@opengeni/react/app/components/session/failed-session-banner";
import { SubscriptionPlans } from "@/components/organization/subscription-plans";
import { PlanSeats, SeatLimitNotice } from "@/components/organization/plan-seats";
import { OrganizationCreditBalance } from "@/components/organization-credit-balance";
import { CreditTopupRow } from "@/components/credits/credit-topup-row";
import { Section, SectionStack, SectionVariantProvider } from "@opengeni/react/ui/section";
import { SettingRowGroup } from "@opengeni/react/ui/setting-row";
import type { BillingSummary } from "@opengeni/react/app/types";

/** DEV only. The production components with deterministic API fixtures, no payments. */
export const previewPlans: BillingSubscriptionCatalog["plans"] = [
  {
    key: "free",
    label: "Free",
    monthlyPriceMicros: 0,
    monthlyCreditMicros: 10_000_000,
    seatLimit: 5,
    freeCredit: true,
    stripePriceId: null,
    selfService: false,
  },
  {
    key: "pro",
    label: "Pro",
    monthlyPriceMicros: 20_000_000,
    monthlyCreditMicros: 100_000_000,
    seatLimit: 10,
    freeCredit: false,
    stripePriceId: "price_preview_pro",
    selfService: true,
  },
  {
    key: "max",
    label: "Max",
    monthlyPriceMicros: 100_000_000,
    monthlyCreditMicros: 500_000_000,
    seatLimit: null,
    freeCredit: false,
    stripePriceId: "price_preview_max",
    selfService: true,
  },
  {
    key: "enterprise",
    label: "Enterprise",
    monthlyPriceMicros: null,
    monthlyCreditMicros: 0,
    seatLimit: null,
    freeCredit: false,
    stripePriceId: null,
    selfService: false,
  },
];

export function previewPlan(key: string): BillingPlanBalance {
  const item = previewPlans.find((plan) => plan.key === key) ?? previewPlans[0]!;
  return {
    key: item.key,
    label: item.label,
    status: "active",
    creditGrantedMicros: item.monthlyCreditMicros,
    creditRemainingMicros: key === "pro" ? 73_450_000 : item.monthlyCreditMicros,
    creditScoped: key === "free",
    periodResetAt: "2026-11-01T10:00:00Z",
    seatsUsed: key === "pro" ? 7 : 5,
    seatLimit: item.seatLimit,
    cancelAtPeriodEnd: false,
  };
}

// A refusal the server already explained reads no balance, so no client calls.
const refusalPreviewContext = { client: {} } as never;

export function SubscriptionPlansPreview() {
  const search = new URLSearchParams(window.location.search);
  const view = search.get("plan") ?? "free";
  const theme = search.get("theme");
  useLayoutEffect(() => {
    if (theme !== "light" && theme !== "dark") return;
    document.documentElement.dataset.ogTheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const [plan, setPlan] = useState(() => previewPlan(view));
  const [amount, setAmount] = useState("25.00");
  const [message, setMessage] = useState("");
  const client = {
    async upgradeBillingSubscription(input: { planKey: string }) {
      setPlan(previewPlan(input.planKey));
      return {
        subscriptionId: "sub_preview",
        planKey: input.planKey,
        effectiveAt: "2026-10-16T14:00:00Z",
        cancelAtPeriodEnd: false,
      };
    },
    async changeBillingSubscription(input: { planKey: string }) {
      return {
        subscriptionId: "sub_preview",
        planKey: input.planKey,
        effectiveAt: plan.periodResetAt,
        cancelAtPeriodEnd: false,
      };
    },
    async cancelBillingSubscription() {
      setPlan({ ...plan, cancelAtPeriodEnd: true });
      return {
        subscriptionId: "sub_preview",
        planKey: "free",
        effectiveAt: plan.periodResetAt,
        cancelAtPeriodEnd: true,
      };
    },
    async createSubscriptionCheckout() {
      throw new Error("Preview only. A live checkout opens Stripe.");
    },
    async createSubscriptionPortalSession() {
      throw new Error("Preview only. Manage billing opens Stripe.");
    },
  } as unknown as OpenGeniBrowserClient;
  const billing: BillingSummary = {
    mode: "stripe",
    balance: {
      accountId: "00000000-0000-4000-8000-000000000001",
      balanceMicros: plan.creditRemainingMicros + 25_000_000,
      generalBalanceMicros: (plan.creditScoped ? 0 : plan.creditRemainingMicros) + 25_000_000,
      creditsMicros: 25_000_000,
      byokPlatformFeeMonthMicros: 1_840_000,
      promotionalCredits: plan.creditScoped
        ? [
            {
              grantId: "00000000-0000-4000-8000-000000000002",
              label: "Monthly plan credit",
              remainingMicros: plan.creditRemainingMicros,
              eligibleModelIds: ["gpt-6-luna", "azure-astra/gpt-6-astra"],
              planCredit: true,
            },
          ]
        : [],
      currency: "usd",
      updatedAt: "2026-10-16T14:00:00Z",
      plan,
    },
  };
  return (
    <main data-canvas className="h-dvh overflow-y-auto bg-canvas p-6 text-fg sm:p-10">
      <div className="mx-auto max-w-[960px]">
        <p className="mb-6 text-xs text-fg-muted">
          Development preview · Sample account · No live payments
        </p>
        <h1 className="mb-8 text-xl font-semibold tracking-[-0.5px]">
          {view === "seats" ? "Invite people" : view === "refusal" ? "Chat" : "Billing & usage"}
        </h1>
        <SectionVariantProvider variant="group">
          <SectionStack>
            {view === "refusal" ? (
              <AppContext.Provider value={refusalPreviewContext}>
                <div className="space-y-4">
                  {(
                    [
                      "byok_upgrade_required",
                      "byok_paid_credit_required",
                      "api_credits_required",
                    ] as const
                  ).map((code) => (
                    <CreditRefusalNotice
                      key={code}
                      gap={{ modelLabel: "Claude Opus 5.5", covered: [], selectionUsable: false }}
                      refusalCode={code}
                      workspaceId="00000000-0000-4000-8000-000000000003"
                      canBuyCredits
                      canConnectModel={false}
                      onAddCredits={() => setMessage("Preview only. Add credits opens Stripe.")}
                    />
                  ))}
                  {/* A chat that stopped on a refusal, for an owner and for a member. */}
                  {(
                    [
                      ["byok_upgrade_required", true],
                      ["byok_upgrade_required", false],
                      ["api_credits_required", true],
                      ["api_credits_required", false],
                    ] as const
                  ).map(([code, owner]) => (
                    <FailedSessionBanner
                      key={`${code}-${owner}`}
                      failure={{ failedAt: null, consecutiveRecoveryCount: null, reason: null }}
                      creditExhausted
                      creditRefusal={code}
                      workspaceId="00000000-0000-4000-8000-000000000003"
                      canBuyCredits={owner}
                    />
                  ))}
                  {message ? (
                    <p role="status" className="text-sm text-fg-muted">
                      {message}
                    </p>
                  ) : null}
                </div>
              </AppContext.Provider>
            ) : view === "seats" ? (
              <>
                <PlanSeats plan={plan} />
                <SeatLimitNotice
                  canManage
                  onUpgrade={() => {
                    window.location.search = "?plan=free";
                  }}
                />
              </>
            ) : (
              <>
                <SubscriptionPlans
                  client={client}
                  accountId={billing.balance.accountId}
                  returnUrl={window.location.href}
                  catalog={{
                    accountId: billing.balance.accountId,
                    revision: 1,
                    plans: previewPlans,
                    plan,
                  }}
                  plan={plan}
                  canManage
                  supportEmail="support@opengeni.ai"
                  onChanged={() => undefined}
                />
                <Section title="Credit balance and top-ups">
                  <div className="space-y-4">
                    <OrganizationCreditBalance
                      billing={billing}
                      canReadBilling
                      hasAccount
                      loading={false}
                      hasError={false}
                      showPlanCredit
                    />
                    <SettingRowGroup>
                      <CreditTopupRow
                        amount={amount}
                        onAmountChange={setAmount}
                        onCheckout={() => setMessage("Preview only. A live top-up opens Stripe.")}
                        busy={false}
                        hasPlan
                      />
                    </SettingRowGroup>
                    {message ? (
                      <p role="status" className="text-sm text-fg-muted">
                        {message}
                      </p>
                    ) : null}
                  </div>
                </Section>
              </>
            )}
          </SectionStack>
        </SectionVariantProvider>
      </div>
    </main>
  );
}
