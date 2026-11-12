// Agents, Members and Usage: short Console pages that lean on the app's own
// organization settings for anything beyond reading.
import type { ConsoleRange } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, BotIcon, CreditCardIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { Section } from "@opengeni/react/ui/section";
import { StatGroup, StatTile } from "@opengeni/react/ui/stat-tile";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

import {
  ConsoleLoadError,
  ConsolePage,
  formatMicros,
  rangeLabel,
  useConsole,
  useConsoleQuery,
} from "./console-shared";
import { RangeControl, useConsoleSummary } from "./overview";

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

/** A link into the app's organization settings, anchored on a workspace there. */
function OrganizationSettingsLink({
  section,
  children,
}: {
  section: "people" | "billing";
  children: string;
}) {
  const { appWorkspaceId } = useConsole();
  if (!appWorkspaceId) return null;
  return (
    <Button variant="outline" asChild>
      <Link
        to="/workspaces/$workspaceId/organization"
        params={{ workspaceId: appWorkspaceId }}
        search={{ section }}
      >
        {children}
        <ArrowUpRightIcon aria-hidden="true" />
      </Link>
    </Button>
  );
}

function roleLabel(role: string): string {
  return role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member";
}

export function ConsoleMembersRoute() {
  const { client, organizationId } = useConsole();
  const members = useConsoleQuery(
    () => client.listOrganizationAdministrationMembers(organizationId),
    [client, organizationId],
  );
  const rows = (members.data?.members ?? []).filter((member) => member.status !== "revoked");
  return (
    <ConsolePage>
      <PageHeader
        title="Members"
        icon={<UsersIcon />}
        description="The same people and roles as in Opengeni"
        actions={
          <OrganizationSettingsLink section="people">Manage members</OrganizationSettingsLink>
        }
      />
      {members.error ? (
        <ConsoleLoadError error={members.error} onRetry={members.reload} />
      ) : !members.data ? (
        <ListRowSkeleton count={4} />
      ) : (
        <RowList
          variant="table"
          label="Members"
          nameLabel="Member"
          columns={[{ id: "role", label: "Role", width: 112 }]}
        >
          {rows.map((member) => (
            <ListRow
              key={member.id}
              title={member.name ?? member.email ?? "Unnamed member"}
              description={member.name && member.email ? member.email : undefined}
              status={
                member.status === "active" ? undefined : (
                  <StatusBadge
                    variant="dot"
                    status={member.status === "suspended" ? "suspended" : "invited"}
                  />
                )
              }
              cells={{ role: roleLabel(member.role) }}
            />
          ))}
        </RowList>
      )}
    </ConsolePage>
  );
}

export function ConsoleUsageRoute() {
  const [range, setRange] = useState<ConsoleRange>("30d");
  const summary = useConsoleSummary(range);
  const data = summary.data;
  const total = data?.spend.totalMicros ?? 0;
  const share = (micros: number) => (total > 0 ? `${Math.round((micros / total) * 100)}%` : "—");
  return (
    <ConsolePage>
      <PageHeader
        title="Usage and billing"
        icon={<CreditCardIcon />}
        description={rangeLabel(range)}
        actions={
          <>
            <RangeControl value={range} onChange={setRange} />
            <OrganizationSettingsLink section="billing">Billing</OrganizationSettingsLink>
          </>
        }
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
    </ConsolePage>
  );
}
