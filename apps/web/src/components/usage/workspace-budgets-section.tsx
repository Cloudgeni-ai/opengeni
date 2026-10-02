import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  getMyUsage,
  getWorkspaceAllowanceState,
  type WorkspaceAllowanceState,
  type WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";
import { useEffect, useState } from "react";

import { useOrganizationDirectory } from "@/components/organization/organization-directory";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Section } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { formatBudget, formatCredits } from "@/lib/usage-allowances";
import { cn } from "@/lib/utils";
import { isForbidden } from "./use-workspace-budget";

// One fact column: on a phone the list folds a single fact under the name,
// and "how much of the budget is used" is the one that matters.
const COLUMNS: RowListColumn[] = [{ id: "month", label: "This month", width: 280 }];

type Row = {
  state: WorkspaceAllowanceState | null;
  usage: WorkspaceUsageResponse | null;
  /** The budget could not be read (no authority, or an error). */
  unreadable: boolean;
};

async function loadRow(client: OpenGeniBrowserClient, workspaceId: string): Promise<Row> {
  const [state, usage] = await Promise.allSettled([
    getWorkspaceAllowanceState(client, workspaceId),
    getMyUsage(client, workspaceId),
  ]);
  return {
    state: state.status === "fulfilled" ? state.value : null,
    // Not a member: the budget still shows; this month's total needs access.
    usage: usage.status === "fulfilled" ? usage.value : null,
    unreadable: state.status === "rejected" && !isForbidden(state.reason),
  };
}

/** "$146.80 of $500 · 29%" plus a 64px bar; quiet until it matters. */
function MonthCell({ usage, limit }: { usage: WorkspaceUsageResponse | null; limit: number }) {
  const pool = usage?.workspace;
  if (!pool || pool.limit === null) {
    return (
      <span className="text-xs text-fg-muted tabular-nums">{formatBudget(limit)} a month</span>
    );
  }
  const fraction = pool.fraction ?? 0;
  const tone =
    pool.status === "exhausted"
      ? "bg-danger"
      : pool.status === "warning"
        ? "bg-status-waiting"
        : "bg-brand";
  const text = `${formatCredits(pool.used)} of ${formatBudget(pool.limit)} · ${Math.round(fraction * 100)}%`;
  return (
    <span
      role="meter"
      aria-label="Used this month"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, fraction) * 100)}
      aria-valuetext={text}
      className="inline-flex min-w-0 items-center gap-3"
    >
      <span className="min-w-0 truncate text-xs text-fg-muted tabular-nums">{text}</span>
      <span
        aria-hidden="true"
        className={cn(
          "relative block h-1 w-16 shrink-0 overflow-hidden rounded-full @max-[639px]/list:hidden",
          pool.status === "exhausted" ? "bg-danger/15" : "bg-surface-3",
        )}
      >
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", tone)}
          style={{ width: `${Math.min(1, fraction) * 100}%` }}
        />
      </span>
    </span>
  );
}

/**
 * Organization settings > Billing & usage: one row per shared workspace with
 * its monthly budget and this month's usage. A row opens the workspace's
 * budget page (budget, member limits).
 */
export function WorkspaceBudgetsSection({
  onOpenWorkspace,
}: {
  onOpenWorkspace: (workspaceId: string) => void;
}) {
  const client = useAppContext().client;
  const directory = useOrganizationDirectory();
  const workspaces = directory.overview.value?.workspaces ?? null;
  const [rows, setRows] = useState<Map<string, Row>>(() => new Map());
  const ids = workspaces?.map((workspace) => workspace.id).join(",") ?? "";

  useEffect(() => {
    if (!ids) return;
    let active = true;
    void Promise.all(
      ids.split(",").map(async (id) => [id, await loadRow(client, id)] as const),
    ).then((entries) => {
      if (active) setRows(new Map(entries));
    });
    return () => {
      active = false;
    };
  }, [client, ids]);

  const description =
    "A monthly limit on what each workspace spends from the organization's credits. Members get an equal share unless an admin changes it.";
  if (!workspaces) {
    return (
      <Section title="Workspace budgets" description={description}>
        <RowList columns={COLUMNS} label="Workspace budgets" busy flush>
          <ListRowSkeleton count={3} />
        </RowList>
      </Section>
    );
  }
  if (workspaces.length === 0) {
    return (
      <Section title="Workspace budgets" description={description}>
        <EmptyState
          title="No shared workspaces yet"
          description="Budgets apply to shared workspaces. Personal workspaces use the organization's credits directly."
          className="py-6"
        />
      </Section>
    );
  }
  return (
    <Section title="Workspace budgets" description={description}>
      <RowList columns={COLUMNS} label="Workspace budgets" nameLabel="Workspace" flush>
        {workspaces.map((workspace) => {
          const row = rows.get(workspace.id);
          const config = row?.state?.config ?? null;
          const status = row?.usage?.workspace.status;
          return (
            <ListRow
              key={workspace.id}
              leading={<LogoTile name={workspace.name} />}
              title={workspace.name}
              status={
                !config ? undefined : status === "exhausted" ? (
                  <StatusBadge status="limit_reached" variant="dot" />
                ) : status === "warning" ? (
                  <StatusBadge status="near_limit" variant="dot" />
                ) : undefined
              }
              cells={{
                month: !row ? (
                  <span className="text-xs text-fg-subtle">…</span>
                ) : config ? (
                  <MonthCell usage={row.usage} limit={config.includedCredits} />
                ) : (
                  <span className="text-xs text-fg-subtle">
                    {row.unreadable ? "Couldn't load the budget" : "No budget"}
                  </span>
                ),
              }}
              indicator={{ kind: "open", label: `Open ${workspace.name} budget` }}
              onOpen={() => onOpenWorkspace(workspace.id)}
            />
          );
        })}
      </RowList>
    </Section>
  );
}
