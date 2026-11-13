// Agents, Members and Usage and billing. Members and billing are the app's
// own organization settings pages, kept inside Console.
import type { ConsoleRange } from "@opengeni/sdk";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { BotIcon, CreditCardIcon, UsersIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { Section } from "@opengeni/react/ui/section";
import { StatGroup, StatTile } from "@opengeni/react/ui/stat-tile";

import {
  ConsoleLoadError,
  ConsolePage,
  formatMicros,
  rangeLabel,
  useConsole,
} from "./console-shared";
import { OrganizationBillingPage } from "@/components/organization/billing-page";
import { OrganizationPeoplePage } from "@/components/organization/people-page";
import type { ConsoleMembersSearch, ConsoleUsageSearch } from "@/lib/console-route";

import {
  ConsoleOrganizationProvider,
  useConsoleOrganizationAccess,
  useConsoleOrganizationIdentity,
} from "./console-organization";
import { RangeControl, useConsoleSummary } from "./overview";

const CheckoutCreditsCelebration = lazy(async () => {
  const module =
    await import("@opengeni/react/app/components/credits/checkout-credits-celebration");
  return { default: module.CheckoutCreditsCelebration };
});

export function ConsoleAgentsRoute() {
  return (
    <ConsolePage>
      <PageHeader title="Agents" icon={<BotIcon />} />
      <EmptyState
        variant="page"
        icon={<BotIcon />}
        title="Organization agents are coming"
        description="For now, agents live in each workspace."
      />
    </ConsolePage>
  );
}

export function ConsoleMembersRoute() {
  const { appWorkspaceId } = useConsole();
  const { person, invitation, view } = useSearch({ strict: false }) as ConsoleMembersSearch;
  const access = useConsoleOrganizationAccess();
  const subPage = Boolean(person || invitation || view);
  return (
    <ConsolePage>
      {subPage ? null : <PageHeader title="Members" icon={<UsersIcon />} />}
      <ConsoleOrganizationProvider>
        <OrganizationPeoplePage
          workspaceId={appWorkspaceId ?? ""}
          person={person}
          invitation={invitation}
          view={view}
          canManageBilling={access.canManageBilling}
          hideEndUsers
        />
      </ConsoleOrganizationProvider>
    </ConsolePage>
  );
}

// A Stripe return is a full page load: one report per outcome per document.
const reportedCheckoutReturns = new Set<string>();

export function ConsoleUsageRoute() {
  const navigate = useNavigate();
  const { client, organizationId, search } = useConsole();
  const { workspace, checkout, checkoutSession } = useSearch({
    strict: false,
  }) as ConsoleUsageSearch;
  const access = useConsoleOrganizationAccess();
  const identity = useConsoleOrganizationIdentity();
  const [range, setRange] = useState<ConsoleRange>("30d");
  const summary = useConsoleSummary(range);
  // Kept past the URL cleanup below, which drops the session id right away.
  const [celebrated] = useState(() => checkoutSession ?? null);
  useEffect(() => {
    if (!checkout) return;
    if (!reportedCheckoutReturns.has(checkout)) {
      reportedCheckoutReturns.add(checkout);
      if (checkout === "cancelled") toast("Checkout cancelled", { description: "No charge was made." });
      else if (!checkoutSession) {
        toast.success("Payment received", { description: "Your credits will appear shortly." });
      }
    }
    void navigate({ to: "/console/usage", search, replace: true });
  }, [checkout, checkoutSession, navigate, search]);

  const billing = (
    <ConsoleOrganizationProvider>
      {celebrated && access.canReadBilling ? (
        <Suspense fallback={null}>
          <CheckoutCreditsCelebration
            client={client}
            accountId={organizationId}
            checkoutSessionId={celebrated}
          />
        </Suspense>
      ) : null}
      <OrganizationBillingPage
        key={organizationId}
        identity={identity}
        canReadBilling={access.canReadBilling}
        canManageBilling={access.canManageBilling}
        canManageAutomaticTopUp={access.canManageAutomaticTopUp}
        budgetWorkspaceId={workspace}
      />
    </ConsoleOrganizationProvider>
  );
  // A workspace's budget page brings its own back link and title.
  if (workspace) return <ConsolePage>{billing}</ConsolePage>;

  const data = summary.data;
  const total = data?.spend.totalMicros ?? 0;
  const share = (micros: number) => (total > 0 ? `${Math.round((micros / total) * 100)}%` : "—");
  return (
    <ConsolePage>
      <PageHeader
        title="Usage and billing"
        icon={<CreditCardIcon />}
        description={rangeLabel(range)}
        actions={<RangeControl value={range} onChange={setRange} />}
      />
      {summary.error ? (
        <ConsoleLoadError error={summary.error} onRetry={summary.reload} />
      ) : (
        <>
          <StatGroup label={rangeLabel(range)} columns={3}>
            <StatTile
              label="Spend"
              loading={!data}
              value={data ? formatMicros(total) : undefined}
            />
            <StatTile
              label="Managed by product"
              loading={!data}
              value={data ? formatMicros(data.spend.managedMicros) : undefined}
            />
            <StatTile
              label="Team"
              loading={!data}
              value={data ? formatMicros(data.spend.teamMicros) : undefined}
            />
          </StatGroup>
          <Section title="By workspace kind">
            {!data ? (
              <ListRowSkeleton count={3} />
            ) : (
              <RowList
                variant="table"
                label="Spend by workspace kind"
                nameLabel="Kind"
                columns={[
                  { id: "share", label: "Share", width: 80, align: "end" },
                  { id: "spend", label: "Spend", width: 104, align: "end", leadsWhenFolded: true },
                ]}
              >
                <ListRow
                  title="Managed by product"
                  description={`${data.workspaces.managed} workspaces`}
                  cells={{
                    share: share(data.spend.managedMicros),
                    spend: formatMicros(data.spend.managedMicros),
                  }}
                />
                <ListRow
                  title="Team"
                  description={`${data.workspaces.team} workspaces`}
                  cells={{
                    share: share(data.spend.teamMicros),
                    spend: formatMicros(data.spend.teamMicros),
                  }}
                />
                <ListRow
                  title="Personal and other"
                  cells={{
                    share: share(data.spend.otherMicros),
                    spend: formatMicros(data.spend.otherMicros),
                  }}
                />
              </RowList>
            )}
          </Section>
          <p className="text-xs text-fg-muted">
            Actual charges. Work paid by a connected subscription or your own model keys shows only
            the platform fee.
          </p>
        </>
      )}
      <Section title="Billing">{billing}</Section>
    </ConsolePage>
  );
}
