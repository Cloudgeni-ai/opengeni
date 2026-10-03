import { useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import { UsageDashboard } from "@/components/insights/usage-dashboard";
import {
  nextUsageSearch,
  parseUsageSearch,

  type UsageSearch,
} from "@/components/insights/usage-search";
import { WorkspaceActivity } from "@/components/insights/workspace-activity";
import type { InsightsRange } from "@/components/insights/activity-data";
import { ContentPage } from "@/components/ui/content-layout";
import { BackLink } from "@/components/ui/detail-page";
import { LineTabsLink, LineTabsNav } from "@/components/ui/line-tabs";
import { PageHeader } from "@/components/ui/page-header";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { ReturnTo } from "@/lib/return-to";
import { workspaceSessionPath } from "@/lib/routes";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";

/** The workspace Insights selection: the usage dashboard's keys plus the tab. */
export type InsightsSearch = UsageSearch & { view?: "activity" };

const ACTIVITY_RANGES: readonly InsightsRange[] = ["today", "week", "month", "ytd"];

export function parseInsightsSearch(search: Record<string, unknown>): InsightsSearch {
  return {
    ...(search.view === "activity" ? { view: "activity" as const } : {}),
    ...parseUsageSearch(search),
  };
}

function sameSearch(raw: Record<string, unknown>, parsed: InsightsSearch): boolean {
  const rawKeys = Object.keys(raw).filter((key) => raw[key] !== undefined);
  const parsedEntries = Object.entries(parsed).filter(([, value]) => value !== undefined);
  return (
    rawKeys.length === parsedEntries.length &&
    parsedEntries.every(([key, value]) => raw[key] === value)
  );
}

/**
 * Workspace Insights: the usage dashboard (spend, tokens by type, calls and a
 * breakdown) and Activity (what's running, sandbox time, limits). The selection
 * lives in the URL.
 */
export function InsightsRoute({
  workspaceId,
  search,
  onSearchChange,
  returnTo,
}: {
  workspaceId: string;
  search?: Record<string, unknown>;
  /** Changes push history; `replace` only normalizes an invalid URL. */
  onSearchChange?: (next: InsightsSearch, options?: { replace?: boolean }) => void;
  /** Where a cross-scope link came from; the back link returns there. */
  returnTo?: ReturnTo | undefined;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const workspace = context.workspaces.find((w) => w.id === workspaceId);
  const canRead = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const selection = useMemo(() => parseInsightsSearch(search ?? {}), [search]);
  const catalog = useWorkspaceModelCatalog(canRead ? workspaceId : null);

  useEffect(() => {
    if (!onSearchChange || sameSearch(search ?? {}, selection)) return;
    onSearchChange(selection, { replace: true });
  }, [onSearchChange, search, selection]);

  const setSearch = (next: InsightsSearch) => onSearchChange?.(next);
  const tab = selection.view === "activity" ? "activity" : "usage";
  const { view: _view, ...usageSearch } = selection;
  const openSession = (sessionId: string) =>
    void navigate({ href: workspaceSessionPath(workspaceId, sessionId) });

  const tabs = (
    <LineTabsNav aria-label="Insights views">
      {(
        [
          ["usage", "Usage"],
          ["activity", "Activity"],
        ] as const
      ).map(([id, label]) => (
        <LineTabsLink key={id} asChild active={tab === id}>
          <button
            type="button"
            onClick={() =>
              setSearch(id === "activity" ? { ...usageSearch, view: "activity" } : usageSearch)
            }
          >
            {label}
          </button>
        </LineTabsLink>
      ))}
    </LineTabsNav>
  );

  const activityRange: InsightsRange = ACTIVITY_RANGES.includes(
    (usageSearch.range ?? "week") as InsightsRange,
  )
    ? ((usageSearch.range ?? "week") as InsightsRange)
    : "month";

  return (
    <ContentPage width="wide" data-insights className="gap-6">
      <div className="min-w-0">
        {returnTo ? (
          <BackLink
            back={{ label: returnTo.label, onClick: () => void navigate({ href: returnTo.path }) }}
          />
        ) : null}
        <PageHeader
          title="Insights"
          description={`Spend, tokens and activity in ${workspace?.name ?? "this workspace"}.`}
          tabs={canRead ? tabs : undefined}
        />
      </div>
      {!canRead ? (
        <p role="alert" className="text-sm text-fg-muted">
          Only workspace admins can see Insights. Ask a workspace admin for access.
        </p>
      ) : tab === "activity" ? (
        <WorkspaceActivity
          workspaceId={workspaceId}
          range={activityRange}
          onRangeChange={(range) =>
            setSearch({ ...nextUsageSearch(usageSearch, { range }), view: "activity" })
          }
          onOpenSession={openSession}
          onFilterSession={(rootSessionId) =>
            setSearch(
              nextUsageSearch(usageSearch, {
                filter: { field: "rootSessionId", values: [rootSessionId] },
                group: "model",
              }),
            )
          }
        />
      ) : (
        <UsageDashboard
          scope={{ kind: "workspace", workspaceId, accountId: workspace?.accountId ?? null }}
          search={usageSearch}
          onSearchChange={(next) => setSearch(next)}
          modelLabels={catalog.models}
          onOpenSession={(sessionId) => openSession(sessionId)}
          deniedMessage="Only workspace admins can see Insights. Ask a workspace admin for access."
        />
      )}
    </ContentPage>
  );
}

