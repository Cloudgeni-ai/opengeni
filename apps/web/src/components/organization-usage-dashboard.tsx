import type {
  OrganizationUsagePeriod,
  OrganizationUsageSummary,
  OrganizationUsageWorkspacePage,
} from "@opengeni/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UserIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAppContext } from "@/context";
import { AreaChart } from "@/components/insights/charts";
import { OrganizationModelUsagePanel } from "@/components/organization-model-usage";
import { useOptionalOrganizationDirectory } from "@/components/organization/organization-directory";
import { memberName } from "@/components/organization/organization-people-model";
import { RowButton } from "@/components/ui/page-actions";
import { EmptyState, EmptyStateLink } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LockGlyph } from "@/components/insights/lock-glyph";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { formatDate } from "@/components/ui/relative-time";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorAdvice, apiErrorDetails, isPermissionDenied } from "@/lib/api-error";
import { inAppClick } from "@/lib/in-app-click";
import { hasWorkspacePermission } from "@/lib/permissions";
import { currentPageReturnTo, returnToSearch } from "@/lib/return-to";
import { workspaceInsightsPath } from "@/lib/routes";
import { usageMetricLabel, usageUnitLabel } from "@/lib/usage-metric";
import type { AccessContext } from "@/types";

type Total = OrganizationUsageSummary["totals"][number];
const periods: Array<{ value: OrganizationUsagePeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "This month" },
  { value: "ytd", label: "This year" },
];
const WORKSPACE_COLUMNS: RowListColumn[] = [
  { id: "total", label: "Total", width: 132, align: "end", hideLabel: true, leadsWhenFolded: true },
];
const metricKey = (total: Pick<Total, "eventType" | "unit">) =>
  JSON.stringify([total.eventType, total.unit]);

export function formatExactUsage(quantity: string, unit: string): string {
  if (unit !== "usd_micros") return `${BigInt(quantity).toLocaleString("en-US")} ${unit}`;
  const value = BigInt(quantity);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}$${(absolute / 1_000_000n).toLocaleString("en-US")}.${(absolute % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * An amount for reading: dollars to the cent ("$12.34", "< $0.01" for a
 * sliver), other units whole. The exact metered value goes in the tooltip.
 */
export function formatUsageAmount(quantity: string, unit: string): string {
  if (unit !== "usd_micros") return formatExactUsage(quantity, unit);
  const value = BigInt(quantity);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const cents = (absolute + 5_000n) / 10_000n;
  if (cents === 0n && absolute > 0n) return negative ? "> -$0.01" : "< $0.01";
  const text = `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
  return negative && cents > 0n ? `-${text}` : text;
}

/** Fill every UTC bucket; missing metering rows are zero, never connected gaps. */
export function organizationUsageChart(summary: OrganizationUsageSummary, selected: Total) {
  const step = summary.granularity === "hour" ? 3_600_000 : 86_400_000;
  const rows = new Map(summary.buckets.map((row) => [row.bucket, row.totals]));
  const labels: string[] = [];
  const values: number[] = [];
  for (let time = Date.parse(summary.since); time < Date.parse(summary.until); time += step) {
    const date = new Date(time).toISOString();
    const bucket = summary.granularity === "hour" ? date.slice(0, 16) : date.slice(0, 10);
    const quantity =
      rows.get(bucket)?.find((total) => metricKey(total) === metricKey(selected))?.quantity ?? "0";
    labels.push(bucket);
    values.push(Number(quantity) / (selected.unit === "usd_micros" ? 1_000_000 : 1));
  }
  return { labels, values };
}
/** One row of "By workspace": a shared workspace, or a member's Personal workspace. */
export interface OrganizationUsageRow {
  key: string;
  kind: "shared" | "personal";
  /** The workspace name, or the Personal workspace owner's name. */
  title: string;
  quantity: string;
  /** Your own Personal workspace. */
  you: boolean;
  /** Set when you can open the workspace's Insights. Never set for Personal rows. */
  insightsWorkspaceId: string | null;
}

type Member = { id: string; name: string | null; email: string | null };

/**
 * Shared workspaces and members' Personal workspaces as one list, largest
 * first for the selected metric. A Personal row never links anywhere: its
 * owner's chats are private, and billing readers see its amounts only.
 */
export function organizationUsageRows(input: {
  shared: OrganizationUsageSummary["workspaces"];
  personal: OrganizationUsageSummary["personalWorkspaces"];
  selected: Pick<Total, "eventType" | "unit">;
  members: readonly Member[];
  youMembershipId: string | null;
  accessContext: AccessContext | null;
}): OrganizationUsageRow[] {
  const amount = (totals: readonly Total[]) =>
    totals.find((total) => metricKey(total) === metricKey(input.selected))?.quantity ?? "0";
  const members = new Map(input.members.map((member) => [member.id, member]));
  const rows: OrganizationUsageRow[] = [
    ...input.shared.map((workspace) => ({
      key: `workspace:${workspace.workspaceId}`,
      kind: "shared" as const,
      title: workspace.name ?? "Workspace",
      quantity: amount(workspace.totals),
      you: false,
      insightsWorkspaceId: hasWorkspacePermission(
        input.accessContext,
        workspace.workspaceId,
        "workspace:admin",
      )
        ? workspace.workspaceId
        : null,
    })),
    ...input.personal.map((workspace) => {
      const member = members.get(workspace.membershipId);
      return {
        key: `personal:${workspace.membershipId}`,
        kind: "personal" as const,
        // Named as on the People page; a row the roster can't name stays generic.
        title: member ? memberName(member) : "Organization member",
        quantity: amount(workspace.totals),
        you: workspace.membershipId === input.youMembershipId,
        insightsWorkspaceId: null,
      };
    }),
  ];
  return rows.sort((a, b) => {
    const difference = BigInt(b.quantity) - BigInt(a.quantity);
    if (difference !== 0n) return difference > 0n ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

/** One person's private-chat spend in one shared workspace: a name and an amount, nothing else. */
export interface OrganizationPrivateRow {
  key: string;
  person: string;
  workspace: string;
  quantity: string;
}

/**
 * Other people's Only me chats as amounts for the selected metric, largest
 * first. An older API replica omits them; the list is then empty.
 */
export function organizationPrivateRows(input: {
  summary: OrganizationUsageSummary;
  selected: Pick<Total, "eventType" | "unit">;
  members: readonly Member[];
  workspaceNames: ReadonlyMap<string, string>;
}): { rows: OrganizationPrivateRow[]; truncated: boolean } {
  const { summary } = input;
  const members = new Map(input.members.map((member) => [member.id, member]));
  // The SDK does not apply the contract defaults: an older replica omits both.
  const rows = (summary.privateChats ?? [])
    .map((entry) => {
      const member = entry.membershipId ? members.get(entry.membershipId) : undefined;
      return {
        key: `private:${entry.workspaceId}:${entry.membershipId ?? entry.name ?? "unknown"}`,
        person: member ? memberName(member) : (entry.name ?? "Organization member"),
        workspace: input.workspaceNames.get(entry.workspaceId) ?? "a workspace",
        quantity:
          entry.totals.find((total) => metricKey(total) === metricKey(input.selected))?.quantity ??
          "0",
      };
    })
    .filter((row) => row.quantity !== "0")
    .sort((a, b) => {
      const difference = BigInt(b.quantity) - BigInt(a.quantity);
      if (difference !== 0n) return difference > 0n ? 1 : -1;
      return a.person.localeCompare(b.person);
    });
  return { rows, truncated: summary.privateChatsTruncated ?? false };
}

/** Says only what the rows can back: a link hint when one opens, the Personal rule when one shows. */
function breakdownDescription(rows: readonly OrganizationUsageRow[]): string | undefined {
  const parts = [
    rows.some((row) => row.insightsWorkspaceId) ? "Open a workspace to see its Insights." : null,
    rows.some((row) => row.kind === "personal")
      ? "Personal workspaces show amounts only, never their chats."
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

type MorePages = {
  key: string;
  pages: OrganizationUsageWorkspacePage[];
  loading: boolean;
  error?: Error;
};

export function OrganizationUsageDashboard(props: { accountId: string; enabled: boolean }) {
  const { client, accessContext } = useAppContext();
  const directory = useOptionalOrganizationDirectory();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<OrganizationUsagePeriod>("month");
  const longerPeriod = periods[periods.findIndex((option) => option.value === period) + 1];
  const [revision, setRevision] = useState(0);
  const [metric, setMetric] = useState("");
  const [state, setState] = useState<{
    key: string;
    data?: OrganizationUsageSummary;
    error?: Error;
  }>({ key: "" });
  const [more, setMore] = useState<MorePages>({ key: "", pages: [], loading: false });
  const key = JSON.stringify([props.accountId, props.enabled, period, revision]);
  useEffect(() => {
    if (!props.enabled) return;
    let active = true;
    const controller = new AbortController();
    // The identity check also hides prior-account data before effects run.
    setState({ key });
    void (async () => {
      try {
        const data = await client.getOrganizationUsageSummary(
          { accountId: props.accountId, period },
          { signal: controller.signal },
        );
        if (active) setState({ key, data });
      } catch (error) {
        if (active)
          setState({ key, error: error instanceof Error ? error : new Error(String(error)) });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, key, props.accountId, props.enabled, period]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  // Further pages of shared workspaces belong to this exact summary.
  const moreKey = JSON.stringify([key, data?.until]);
  const pages = more.key === moreKey ? more.pages : [];
  const loadingMore = more.key === moreKey && more.loading;
  const moreError = more.key === moreKey ? more.error : undefined;
  const nextCursor =
    pages.length > 0 ? pages.at(-1)!.nextWorkspaceCursor : data?.nextWorkspaceCursor;
  async function loadMoreWorkspaces() {
    if (!data || !nextCursor || loadingMore) return;
    const pagesSoFar = pages;
    setMore({ key: moreKey, pages: pagesSoFar, loading: true });
    try {
      const page = await client.getOrganizationUsageWorkspacePage({
        accountId: props.accountId,
        period,
        until: data.until,
        afterWorkspaceId: nextCursor,
      });
      setMore((current) =>
        current.key === moreKey
          ? { key: moreKey, pages: [...pagesSoFar, page], loading: false }
          : current,
      );
    } catch (pageLoadError) {
      setMore((current) =>
        current.key === moreKey
          ? {
              key: moreKey,
              pages: pagesSoFar,
              loading: false,
              error:
                pageLoadError instanceof Error ? pageLoadError : new Error(String(pageLoadError)),
            }
          : current,
      );
    }
  }
  const selected =
    data?.totals.find((total) => metricKey(total) === metric) ??
    data?.totals.find((total) => total.eventType === "model.cost") ??
    data?.totals[0];
  const chart = data && selected ? organizationUsageChart(data, selected) : null;
  const hasCorrections = chart?.values.some((value) => value < 0) ?? false;
  const range = data
    ? `${formatDate(data.since, { utc: true })} - ${formatDate(data.until, { utc: true })}, UTC`
    : null;
  const rows =
    data && selected
      ? organizationUsageRows({
          shared: [...data.workspaces, ...pages.flatMap((page) => page.workspaces)],
          // An older API replica omits the Personal fields; the SDK does not
          // apply the contract defaults, so treat them as absent here.
          personal: data.personalWorkspaces ?? [],
          selected,
          members: directory?.members.value ?? [],
          youMembershipId: directory?.you?.id ?? null,
          accessContext,
        })
      : [];
  const { rows: privateRows, truncated: privateTruncated } =
    data && selected
      ? organizationPrivateRows({
          summary: data,
          selected,
          members: directory?.members.value ?? [],
          workspaceNames: new Map(
            [...data.workspaces, ...pages.flatMap((page) => page.workspaces)].map((workspace) => [
              workspace.workspaceId,
              workspace.name ?? "a workspace",
            ]),
          ),
        })
      : { rows: [], truncated: false };
  const unlistedPersonal = data
    ? Math.max(0, (data.personalWorkspaceCount ?? 0) - (data.personalWorkspaces?.length ?? 0))
    : 0;
  const openInsights = (workspaceId: string) => {
    const back = currentPageReturnTo("Billing & usage");
    void navigate({
      to: "/workspaces/$workspaceId/insights",
      params: { workspaceId },
      search: returnToSearch(back),
    });
  };
  const insightsHref = (workspaceId: string) => {
    const back = returnToSearch(currentPageReturnTo("Billing & usage"));
    const query = new URLSearchParams(back as Record<string, string>).toString();
    return `${workspaceInsightsPath(workspaceId)}${query ? `?${query}` : ""}`;
  };
  return (
    <section aria-label="Organization usage dashboard" className="min-w-0">
      <SectionStack>
        <Section
          title="Usage"
          description="Every workspace, private chats included. Not an invoice."
          action={
            <SegmentedControl<OrganizationUsagePeriod>
              size="sm"
              aria-label="Usage period"
              disabled={!props.enabled}
              value={period}
              onValueChange={setPeriod}
              options={periods}
            />
          }
        >
          <div className="mt-3 flex min-w-0 flex-col gap-4">
            {!props.enabled || (error && isPermissionDenied(error)) ? (
              <p className="text-xs leading-[18px] text-fg-muted">
                You don't have permission to view usage. Ask an organization owner.
              </p>
            ) : error ? (
              <ErrorMessage
                variant="block"
                title="Couldn't load period usage"
                announce
                action={
                  <RowButton onClick={() => setRevision((value) => value + 1)}>Try again</RowButton>
                }
                {...apiErrorDetails(error)}
              >
                {apiErrorAdvice(error)}
              </ErrorMessage>
            ) : !data ? (
              <div role="status" aria-label="Loading period usage" className="flex flex-col gap-4">
                <div aria-hidden="true" className="flex min-w-0 flex-col gap-1">
                  <Skeleton className="h-7 w-28 rounded-md" />
                  <Skeleton className="h-[18px] w-56 max-w-full rounded-full" />
                </div>
                <Skeleton aria-hidden="true" className="h-[220px] rounded-lg" />
              </div>
            ) : data.totals.length === 0 ? (
              <EmptyState
                variant="inline"
                title="No usage recorded in this period."
                description={range ?? undefined}
                action={
                  longerPeriod ? (
                    <EmptyStateLink onClick={() => setPeriod(longerPeriod.value)}>
                      Show {longerPeriod.label.toLowerCase()}
                    </EmptyStateLink>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
                  <div className="min-w-0">
                    {selected ? (
                      <p
                        className="text-xl leading-7 font-semibold tracking-[-0.5px] text-fg tabular-nums"
                        title={formatExactUsage(selected.quantity, selected.unit)}
                      >
                        {formatUsageAmount(selected.quantity, selected.unit)}
                      </p>
                    ) : null}
                    <p className="text-xs leading-[18px] text-fg-muted">{range}</p>
                  </div>
                  {data.totals.length > 1 ? (
                    <SelectMenu
                      size="sm"
                      aria-label="Usage metric"
                      value={selected ? metricKey(selected) : null}
                      onValueChange={setMetric}
                      options={data.totals.map((total) => ({
                        value: metricKey(total),
                        label: usageMetricLabel(total.eventType),
                        meta: usageUnitLabel(total.unit),
                      }))}
                      className="w-60 max-w-full"
                    />
                  ) : null}
                </div>
                {chart && selected && (
                  <AreaChart
                    labels={chart.labels.map((bucket) =>
                      data.granularity === "hour"
                        ? `${bucket.slice(11, 16)} UTC`
                        : formatDate(`${bucket}T00:00:00.000Z`, { utc: true }),
                    )}
                    series={[
                      {
                        id: "usage",
                        label: usageMetricLabel(selected.eventType),
                        values: chart.values.map((value) => Math.max(0, value)),
                        className: "text-brand",
                      },
                      ...(hasCorrections
                        ? [
                            {
                              id: "corrections",
                              label: "Negative adjustment magnitude",
                              values: chart.values.map((value) => Math.max(0, -value)),
                              className: "text-status-waiting",
                            },
                          ]
                        : []),
                    ]}
                    valuePrefix={selected.unit === "usd_micros" ? "$" : ""}
                    valueSuffix={selected.unit === "usd_micros" ? "" : ` ${selected.unit}`}
                  />
                )}
                {hasCorrections && (
                  <p className="text-xs leading-[18px] text-fg-muted">
                    Negative adjustments show as a separate line. The total includes them.
                  </p>
                )}
              </>
            )}
          </div>
        </Section>
        {props.enabled ? (
          <OrganizationModelUsagePanel
            accountId={props.accountId}
            period={period}
            revision={revision}
            ledgerCreditMicros={
              data
                ? (data.totals.find(
                    (total) => total.eventType === "model.cost" && total.unit === "usd_micros",
                  )?.quantity ?? "0")
                : undefined
            }
          />
        ) : null}
        {props.enabled && data && data.totals.length > 0 && selected ? (
          <div className="flex min-w-0 flex-col gap-3">
            <Section title="By workspace" description={breakdownDescription(rows)}>
              <RowList
                label="Usage by workspace"
                columns={WORKSPACE_COLUMNS}
                nameLabel="Workspace"
                flush
              >
                {rows.map((row) => {
                  const cells = {
                    total: (
                      <span
                        className="text-fg tabular-nums"
                        title={formatExactUsage(row.quantity, selected.unit)}
                      >
                        {formatUsageAmount(row.quantity, selected.unit)}
                      </span>
                    ),
                  };
                  if (row.kind === "personal") {
                    return (
                      <ListRow
                        key={row.key}
                        leading={<LogoTile icon={<UserIcon />} name={row.title} />}
                        title={row.title}
                        titleAddon={
                          row.you ? <MetaChip variant="outline">You</MetaChip> : undefined
                        }
                        meta={["Personal workspace"]}
                        cells={cells}
                      />
                    );
                  }
                  const workspaceId = row.insightsWorkspaceId;
                  return (
                    <ListRow
                      key={row.key}
                      leading={<LogoTile name={row.title} />}
                      title={row.title}
                      meta={workspaceId ? undefined : ["Only its admins can open Insights"]}
                      cells={cells}
                      {...(workspaceId
                        ? {
                            indicator: "open" as const,
                            href: insightsHref(workspaceId),
                            linkProps: { onClick: inAppClick(() => openInsights(workspaceId)) },
                          }
                        : {})}
                    />
                  );
                })}
              </RowList>
            </Section>
            {moreError ? (
              <ErrorMessage
                variant="inline"
                title="Couldn't load more workspaces"
                announce
                action={<RowButton onClick={() => void loadMoreWorkspaces()}>Try again</RowButton>}
                {...apiErrorDetails(moreError)}
              >
                {apiErrorAdvice(moreError)}
              </ErrorMessage>
            ) : null}
            {nextCursor && !moreError ? (
              <div>
                <RowButton disabled={loadingMore} onClick={() => void loadMoreWorkspaces()}>
                  {loadingMore ? "Loading workspaces…" : "Show more workspaces"}
                </RowButton>
              </div>
            ) : null}
            {unlistedPersonal > 0 ? (
              <p className="text-xs leading-[18px] text-fg-muted">
                {data.personalWorkspaceCount} Personal workspaces had usage. This lists the{" "}
                {data.personalWorkspaces.length} that spent the most.
              </p>
            ) : null}
          </div>
        ) : null}
        {props.enabled && data && selected && privateRows.length > 0 ? (
          <Section
            title="Private chats"
            description="Other people's Only me chats, already counted above. Amounts only."
          >
            <RowList
              label="Private chats by person"
              columns={WORKSPACE_COLUMNS}
              nameLabel="Person"
              flush
            >
              {/* Plain rows: no link, button or drilldown. The workspace sits in
                  the title so on a phone the amount leads the second line. */}
              {privateRows.map((row) => (
                <ListRow
                  key={row.key}
                  leading={<LogoTile icon={<LockGlyph />} name={row.person} />}
                  title={`${row.person} in ${row.workspace}`}
                  cells={{
                    total: (
                      <span
                        className="text-fg tabular-nums"
                        title={formatExactUsage(row.quantity, selected.unit)}
                      >
                        {formatUsageAmount(row.quantity, selected.unit)}
                      </span>
                    ),
                  }}
                />
              ))}
            </RowList>
            {privateTruncated ? (
              <p className="pt-2 text-xs leading-[18px] text-fg-muted">Showing the largest 200.</p>
            ) : null}
          </Section>
        ) : null}
      </SectionStack>
    </section>
  );
}
