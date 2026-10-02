import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { RowButton } from "@/components/ui/page-actions";
import { OrganizationCreditBalance } from "@/components/organization-credit-balance";
import { OrganizationUsageDashboard } from "@/components/organization-usage-dashboard";
import { ErrorMessage } from "@/components/ui/error-message";
import { TextInput } from "@/components/ui/field";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { analyticsAction } from "@/lib/analytics-actions";
import {
  apiErrorAdvice,
  apiErrorDetails,
  isPermissionDenied,
  userErrorText,
} from "@/lib/api-error";
import { entitlementEntries, validTopupAmount } from "@/lib/format";
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

// Budgets load only on this page: they never join the session or rail graphs.
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
   Organization settings > Billing & usage: the credit balance and top-ups,
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
  const client = useAppContext().client;
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
    setBilling(null);
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

  async function startCheckout(amountUsd: number) {
    const operation = claimBillingOperation("billing", "mutation");
    setBusyOwnerKey(identityKey);
    setBusy(true);
    try {
      const session = await client.createBillingCheckout({
        amountUsd,
        ...(accountId ? { accountId } : {}),
        successUrl: `${window.location.origin}/workspaces/${workspaceId}/organization?section=billing&checkout=success`,
        cancelUrl: `${window.location.origin}/workspaces/${workspaceId}/organization?section=billing&checkout=cancelled`,
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

  const visibleBilling = billingOwnerKey === identityKey ? billing : null;
  const visibleBillingError = billingOwnerKey === identityKey ? billingError : null;
  const visibleBillingLoading = billingOwnerKey === identityKey ? billingLoading : true;
  const visibleEntitlements = entitlementsOwnerKey === identityKey ? entitlements : null;
  const visibleEntitlementsError = entitlementsOwnerKey === identityKey ? entitlementsError : null;
  const visibleBusy = busyOwnerKey === identityKey && busy;

  const stripe = visibleBilling?.mode === "stripe";
  return (
    <SectionStack>
      <section aria-label="Credits and payments" className="min-w-0">
        <Section title="Credits">
          <div className="mt-1 flex min-w-0 flex-col gap-4">
            <OrganizationCreditBalance
              billing={visibleBilling}
              canReadBilling={canReadBilling}
              hasAccount={Boolean(accountId)}
              loading={visibleBillingLoading}
              hasError={Boolean(visibleBillingError)}
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
                <SettingRow
                  label="Add credits"
                  description="Minimum $5.00. Enter a gift code in Stripe Checkout. You receive the selected credit amount, including when the coupon covers the full price."
                  controlWidth="auto"
                  control={
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle"
                        >
                          $
                        </span>
                        <TextInput
                          aria-label="Amount to add (USD)"
                          type="number"
                          name="credit-amount"
                          autoComplete="off"
                          inputMode="decimal"
                          min="5"
                          max="10000"
                          step="0.01"
                          value={topupAmount}
                          onChange={(event) => setTopupAmount(event.target.value)}
                          className="h-8 w-28 pl-6 tabular-nums pointer-coarse:h-11"
                        />
                      </div>
                      <RowButton
                        variant="default"
                        {...analyticsAction("buy_credits")}
                        disabled={visibleBusy || !validTopupAmount(topupAmount)}
                        onClick={() => void startCheckout(Number(topupAmount))}
                      >
                        Add credits
                      </RowButton>
                    </div>
                  }
                />
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

      <OrganizationUsageDashboard
        key={identityKey}
        accountId={accountId}
        enabled={canReadBilling && Boolean(accountId)}
      />
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
  const words = name.replace(/[_.-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  const rows = props.entitlements ? entitlementEntries(props.entitlements.entitlements) : [];
  if (!props.enabled) return null;
  if (props.error) {
    return (
      <Section title="Plan limits">
        <BillingLoadFailure
          title="Couldn't load the plan's limits"
          denied="You can't see the plan's limits. Ask an organization owner for access."
          error={props.error}
          onRetry={props.onRetry}
        />
      </Section>
    );
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
