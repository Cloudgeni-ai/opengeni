import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { RowButton } from "@/components/ui/page-actions";
import { OrganizationCreditBalance } from "@/components/organization-credit-balance";
import { ErrorMessage } from "@/components/ui/error-message";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { CouponRedeem } from "@/components/credits/coupon-redeem";
import { useAppContext } from "@/context";
import { billingCheckoutReturnUrl } from "@/lib/credit-checkout";
import { CREDIT_BALANCE_CHANGED, notifyCreditBalanceChanged } from "@/lib/credit-balance-events";
import {
  apiErrorAdvice,
  apiErrorDetails,
  isPermissionDenied,
  userErrorText,
} from "@/lib/api-error";
import { entitlementEntries } from "@/lib/format";
import { CreditTopupRow } from "@/components/credits/credit-topup-row";
import {
  beginOrganizationAdminOperation,
  organizationAdminIdentityKey,
  organizationAdminOperationSlot,
  ownsOrganizationAdminOperation,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperation,
  type OrganizationAdminOperationLane,
  type OrganizationAdminOperationSlot,
} from "@/lib/organization-admin";
import type { BillingEntitlementsResponse, BillingSummary } from "@/types";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { SubscriptionPlans } from "./subscription-plans";
import { useSubscriptionCatalog } from "./use-subscription-catalog";

// Budgets load only on this page: they never join the session or rail graphs.
const CreditsCelebrationDialog = lazy(() =>
  import("@/components/credits/checkout-credits-celebration").then((module) => ({
    default: module.CreditsCelebrationDialog,
  })),
);
const WorkspaceBudgetsSection = lazy(() =>
  import("@/components/usage/workspace-budgets-section").then((module) => ({
    default: module.WorkspaceBudgetsSection,
  })),
);
const WorkspaceBudgetPage = lazy(() =>
  import("@/components/usage/workspace-budget-page").then((module) => ({
    default: module.WorkspaceBudgetPage,
  })),
);

/* ----------------------------------------------------------------------------
   Organization settings > Billing: the credit balance and top-ups,
   plan limits, workspace budgets, and usage by workspace. A workspace's budget
   page (`?section=billing&workspace=<id>`) opens from the budgets list.
   -------------------------------------------------------------------------- */

export function OrganizationBillingPage({
  budgetWorkspaceId,
  ...props
}: {
  identity: OrganizationAdminIdentity;
  canReadBilling: boolean;
  canManageBilling: boolean;
  /** The workspace whose budget page is open. */
  budgetWorkspaceId?: string | undefined;
}) {
  const navigate = useNavigate();
  const anchorWorkspaceId = props.identity.workspaceId;
  const openBudget = useCallback(
    (workspace: string | undefined) =>
      void navigate({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId: anchorWorkspaceId },
        search: workspace ? { section: "billing", workspace } : { section: "billing" },
      }),
    [anchorWorkspaceId, navigate],
  );
  if (budgetWorkspaceId) {
    return (
      <Suspense fallback={null}>
        <WorkspaceBudgetPage
          key={budgetWorkspaceId}
          workspaceId={budgetWorkspaceId}
          onBack={() => openBudget(undefined)}
        />
      </Suspense>
    );
  }
  return <BillingOverview {...props} onOpenBudget={openBudget} />;
}

function BillingOverview({
  identity,
  canReadBilling,
  canManageBilling,
  onOpenBudget,
}: {
  identity: OrganizationAdminIdentity;
  canReadBilling: boolean;
  canManageBilling: boolean;
  onOpenBudget: (workspaceId: string) => void;
}) {
  const { client, clientConfig } = useAppContext();
  const navigate = useNavigate();
  const accountId = identity.organizationId;
  const workspaceId = identity.workspaceId;
  const identityKey = organizationAdminIdentityKey(identity);
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [billingOwnerKey, setBillingOwnerKey] = useState("");
  const [billingError, setBillingError] = useState<Error | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [entitlements, setEntitlements] = useState<BillingEntitlementsResponse | null>(null);
  const [entitlementsOwnerKey, setEntitlementsOwnerKey] = useState("");
  const [entitlementsError, setEntitlementsError] = useState<Error | null>(null);
  const [topupAmount, setTopupAmount] = useState("25.00");
  const [busy, setBusy] = useState(false);
  // A coupon just redeemed here, celebrated with its real amount.
  const [redeemed, setRedeemed] = useState<BillingCheckoutStatus | null>(null);
  const [busyOwnerKey, setBusyOwnerKey] = useState("");
  const identityRef = useRef<OrganizationAdminIdentity | null>(identity);
  identityRef.current = identity;
  const billingSequenceRef = useRef(new Map<OrganizationAdminOperationSlot, number>());
  const billingOperationRef = useRef(
    new Map<OrganizationAdminOperationSlot, OrganizationAdminOperation>(),
  );
  const claimBillingOperation = useCallback(
    (resource: "billing" | "entitlements", lane: OrganizationAdminOperationLane) => {
      const slot = organizationAdminOperationSlot(resource, lane);
      const operation = beginOrganizationAdminOperation({
        identity,
        resource,
        lane,
        previousSequence: billingSequenceRef.current.get(slot) ?? 0,
      });
      billingSequenceRef.current.set(slot, operation.sequence);
      billingOperationRef.current.set(slot, operation);
      return operation;
    },
    [identity],
  );
  const ownsBillingOperation = useCallback(
    (operation: OrganizationAdminOperation) =>
      ownsOrganizationAdminOperation({
        currentIdentity: identityRef.current,
        currentOperation:
          billingOperationRef.current.get(
            organizationAdminOperationSlot(operation.resource, operation.lane),
          ) ?? null,
        accepted: operation,
      }),
    [],
  );
  useEffect(() => {
    const activeOperations = billingOperationRef.current;
    identityRef.current = identity;
    return () => {
      identityRef.current = null;
      activeOperations.clear();
    };
  }, [identity]);
  const refreshBilling = useCallback(async () => {
    if (!accountId || !canReadBilling) {
      setBilling(null);
      setBillingOwnerKey(identityKey);
      setBillingError(null);
      return;
    }
    const operation = claimBillingOperation("billing", "read");
    setBillingOwnerKey(identityKey);
    setBillingLoading(true);
    try {
      const result = await client.getBilling({ accountId });
      if (!ownsBillingOperation(operation)) return;
      setBilling(result);
      setBillingError(null);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      setBilling(null);
      setBillingError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (ownsBillingOperation(operation)) setBillingLoading(false);
    }
  }, [accountId, canReadBilling, claimBillingOperation, client, identityKey, ownsBillingOperation]);

  const refreshEntitlements = useCallback(async () => {
    if (!accountId || !canReadBilling) {
      setEntitlements(null);
      setEntitlementsOwnerKey(identityKey);
      setEntitlementsError(null);
      return;
    }
    const operation = claimBillingOperation("entitlements", "read");
    setEntitlementsOwnerKey(identityKey);
    setEntitlements(null);
    try {
      const result = await client.getBillingEntitlements({ accountId });
      if (!ownsBillingOperation(operation)) return;
      setEntitlements(result);
      setEntitlementsError(null);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      setEntitlements(null);
      setEntitlementsError(error instanceof Error ? error : new Error(String(error)));
    }
  }, [accountId, canReadBilling, claimBillingOperation, client, identityKey, ownsBillingOperation]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshBilling(), refreshEntitlements()]);
  }, [refreshBilling, refreshEntitlements]);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    void refresh();
  }, [workspaceId, refresh]);

  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ accountId: string }>).detail.accountId === accountId)
        void refreshBilling();
    };
    window.addEventListener(CREDIT_BALANCE_CHANGED, changed);
    return () => window.removeEventListener(CREDIT_BALANCE_CHANGED, changed);
  }, [accountId, refreshBilling]);

  async function startCheckout(amountUsd: number) {
    const operation = claimBillingOperation("billing", "mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const session = await client.createBillingCheckout({
        amountUsd,
        ...(accountId ? { accountId } : {}),
        successUrl: billingCheckoutReturnUrl(window.location.origin, workspaceId, "success"),
        cancelUrl: billingCheckoutReturnUrl(window.location.origin, workspaceId, "cancelled"),
      });
      if (!ownsBillingOperation(operation)) return;
      window.location.assign(session.url);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      toast.error("Couldn't open checkout", { description: userErrorText(error) });
    } finally {
      if (ownsBillingOperation(operation)) setBusy(false);
    }
  }

  async function openBillingPortal() {
    const operation = claimBillingOperation("billing", "mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const session = await client.createBillingPortalSession({
        ...(accountId ? { accountId } : {}),
        returnUrl: window.location.href,
      });
      if (!ownsBillingOperation(operation)) return;
      window.location.assign(session.url);
    } catch (error) {
      if (!ownsBillingOperation(operation)) return;
      toast.error("Couldn't open Stripe billing", { description: userErrorText(error) });
    } finally {
      if (ownsBillingOperation(operation)) setBusy(false);
    }
  }

  const visibleBilling = canReadBilling && billingOwnerKey === identityKey ? billing : null;
  const visibleBillingError = billingOwnerKey === identityKey ? billingError : null;
  const visibleBillingLoading = billingOwnerKey === identityKey ? billingLoading : true;
  const visibleEntitlements = entitlementsOwnerKey === identityKey ? entitlements : null;
  const visibleEntitlementsError = entitlementsOwnerKey === identityKey ? entitlementsError : null;
  const visibleBusy = busyOwnerKey === identityKey && busy;
  const subscriptions = useSubscriptionCatalog(
    client,
    accountId,
    identityKey,
    visibleBilling?.balance.plan,
  );
  const showPlans = Boolean(subscriptions.catalog && visibleBilling?.balance.plan);

  const stripe = visibleBilling?.mode === "stripe";
  return (
    <SectionStack>
      {redeemed ? (
        <Suspense fallback={null}>
          <CreditsCelebrationDialog
            status={redeemed}
            open
            onOpenChange={(open) => {
              if (!open) setRedeemed(null);
            }}
          />
        </Suspense>
      ) : null}
      {subscriptions.catalog && visibleBilling?.balance.plan ? (
        <SubscriptionPlans
          key={identityKey}
          client={client}
          accountId={accountId}
          returnUrl={`${window.location.origin}/workspaces/${encodeURIComponent(workspaceId)}/organization?section=billing`}
          catalog={subscriptions.catalog}
          plan={visibleBilling.balance.plan}
          canManage={canManageBilling}
          supportEmail={clientConfig.supportEmail}
          onChanged={() => notifyCreditBalanceChanged(accountId)}
        />
      ) : null}
      {subscriptions.error ? (
        <BillingLoadFailure
          title="Couldn't load subscription options"
          denied="Ask an organization owner to manage subscriptions."
          error={
            subscriptions.error instanceof Error
              ? subscriptions.error
              : new Error(String(subscriptions.error))
          }
          onRetry={subscriptions.retry}
        />
      ) : null}
      <section aria-label="Credits and payments" className="min-w-0">
        <Section title={showPlans ? "Credit balance and top-ups" : "Credits"}>
          <div className="mt-1 flex min-w-0 flex-col gap-4">
            <OrganizationCreditBalance
              billing={visibleBilling}
              canReadBilling={canReadBilling}
              hasAccount={Boolean(accountId)}
              loading={visibleBillingLoading}
              hasError={Boolean(visibleBillingError)}
              showPlanCredit={showPlans}
            />
            {visibleBillingError ? (
              <BillingLoadFailure
                title="Couldn't load the billing balance"
                denied="You can't see the billing balance. Ask an organization owner for access."
                error={visibleBillingError}
                onRetry={() => void refreshBilling()}
              />
            ) : null}
            {stripe && canManageBilling ? (
              <SettingRowGroup>
                <CreditTopupRow
                  amount={topupAmount}
                  onAmountChange={setTopupAmount}
                  onCheckout={(amount) => void startCheckout(amount)}
                  busy={visibleBusy}
                  hasPlan={showPlans}
                />
                {accountId ? (
                  <SettingRow
                    label="Promo code"
                    description="Opens Stripe to confirm your code."
                    controlWidth="auto"
                    control={
                      <CouponRedeem
                        variant="inline"
                        client={client}
                        accountId={accountId}
                        workspaceId={workspaceId}
                        disabled={visibleBusy}
                        onGranted={(status) => {
                          setRedeemed(status);
                        }}
                      />
                    }
                  />
                ) : null}
                {!showPlans ? (
                  <SettingRow
                    label="Invoices and payment details"
                    controlWidth="auto"
                    control={
                      <RowButton disabled={visibleBusy} onClick={() => void openBillingPortal()}>
                        Open Stripe billing
                        <ArrowUpRightIcon aria-hidden="true" />
                      </RowButton>
                    }
                  />
                ) : null}
              </SettingRowGroup>
            ) : stripe ? (
              <p className="text-xs leading-[18px] text-fg-muted">
                Only organization owners can buy credits.
              </p>
            ) : visibleBilling ? (
              <p className="text-xs leading-[18px] text-fg-muted">
                Buying credits needs Stripe billing, which this deployment hasn't turned on.
              </p>
            ) : null}
          </div>
        </Section>
      </section>

      <EntitlementsSection
        enabled={canReadBilling && Boolean(accountId)}
        entitlements={visibleEntitlements}
        error={visibleEntitlementsError}
        onRetry={() => void refreshEntitlements()}
      />

      <Suspense fallback={null}>
        <WorkspaceBudgetsSection onOpenWorkspace={onOpenBudget} />
      </Suspense>

      {canReadBilling && accountId ? (
        <Section title="Usage">
          <SettingRowGroup>
            <SettingRow
              label="Insights"
              description="Spend, tokens and model calls across every workspace, by model, workspace, person and more."
              controlWidth="auto"
              control={
                <RowButton
                  onClick={() =>
                    void navigate({
                      to: "/workspaces/$workspaceId/organization",
                      params: { workspaceId },
                      search: { section: "insights" },
                    })
                  }
                >
                  Open Insights
                </RowButton>
              }
            />
          </SettingRowGroup>
        </Section>
      ) : null}
    </SectionStack>
  );
}

/**
 * A billing read that failed: a calm line without Try again when the viewer
 * lacks the permission, otherwise what happened and what to do.
 */
function BillingLoadFailure(props: {
  title: string;
  denied: string;
  error: Error;
  onRetry: () => void;
}) {
  if (isPermissionDenied(props.error)) {
    return <p className="text-xs leading-[18px] text-fg-muted">{props.denied}</p>;
  }
  return (
    <ErrorMessage
      variant="inline"
      title={props.title}
      announce
      action={<RowButton onClick={props.onRetry}>Try again</RowButton>}
      {...apiErrorDetails(props.error)}
    >
      {apiErrorAdvice(props.error)}
    </ErrorMessage>
  );
}

/** "max_concurrent_sessions" as "Max concurrent sessions". */
function entitlementLabel(name: string): string {
  const words = name
    .replace(/^limits?\./, "")
    .replace(/[_.-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Only limits a customer can run into: numbers. Feature switches
 * ("managed.api_keys": true) are how the deployment is built, not a limit.
 */
function customerLimits(entitlements: BillingEntitlementsResponse["entitlements"]) {
  return entitlementEntries(entitlements).filter(
    (row) => !row.name.startsWith("managed.") && /^[\d,.]+$/.test(row.value),
  );
}

/**
 * Plan & entitlements (/v1/billing/entitlements): the limits the organization
 * runs under. Shown only when there are some, or when loading them failed.
 */
function EntitlementsSection(props: {
  enabled: boolean;
  entitlements: BillingEntitlementsResponse | null;
  error: Error | null;
  onRetry: () => void;
}) {
  const rows = props.entitlements ? customerLimits(props.entitlements.entitlements) : [];
  if (!props.enabled) return null;
  if (props.error) {
    // Limits are rare; a failed read of them is not worth a red box on Billing.
    return null;
  }
  if (rows.length === 0) return null;
  return (
    <Section title="Plan limits">
      <SettingRowGroup>
        {rows.map((row) => (
          <SettingRow
            key={row.name}
            label={entitlementLabel(row.name)}
            controlWidth="auto"
            control={
              <span className="text-sm text-fg-muted tabular-nums">
                {row.value.charAt(0).toUpperCase() + row.value.slice(1)}
              </span>
            }
          />
        ))}
      </SettingRowGroup>
    </Section>
  );
}
