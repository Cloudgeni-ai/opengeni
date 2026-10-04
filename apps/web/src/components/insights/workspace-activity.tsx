import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkspaceInsightsSnapshot } from "@opengeni/sdk";

import { AreaChart, UsageMeter } from "@/components/insights/charts";
import {
  CACHE_MISS_MIN_INPUT_TOKENS,
  OUTLIER_MEDIAN_MULTIPLE,
  backendLabel,
  buildInsightsDiagnostics,
  driverRootSessionId,
  formatTokens,
  formatWarmHours,
  pctDelta,
  type FloorSession,
  type InsightsRange,
} from "@/components/insights/activity-data";
import { Button } from "@/components/ui/button";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { StatGroup, StatTile, type StatDelta } from "@/components/ui/stat-tile";
import { useAppContext } from "@/context";
import { apiErrorAdvice } from "@/lib/api-error";
import { cn } from "@/lib/utils";

import { modelDisplayName } from "./model-display";
import { formatChange, priorLabel } from "./usage-format";

const PROMPT_SOURCE_LABELS = {
  workspace_instruction_policy: "Workspace instruction policy",
  legacy_workspace_instructions: "Legacy workspace instructions",
  preference_registry_descriptor: "Skill descriptors",
  company_profile: "Organization identity",
  legacy_memory_v1: "Workspace memory",
  runtime_skill_catalog: "Available skill guides",
} as const;

const ACTIVITY_RANGES: ReadonlyArray<{ value: InsightsRange; label: string }> = [
  { value: "today", label: "Today" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "This month" },
  { value: "ytd", label: "Year to date" },
];

const FLOOR_COLUMNS: RowListColumn[] = [
  { id: "state", label: "State", width: 104 },
  { id: "age", label: "Running for", width: 104, align: "end" },
  { id: "cache", label: "Cache hit", width: 80, align: "end" },
];

const WARM_COLUMNS: RowListColumn[] = [
  { id: "warm", label: "Warm time", width: 104, align: "end" },
  { id: "sessions", label: "Chats", width: 80, align: "end" },
];

const PROMPT_COLUMNS: RowListColumn[] = [
  { id: "tokens", label: "Est. tokens", width: 104, align: "end" },
  { id: "share", label: "Share", width: 72, align: "end" },
  { id: "calls", label: "Calls", width: 80, align: "end" },
];

function delta(current: number, prior: number, comparison: string): StatDelta | undefined {
  const change = pctDelta(current, prior);
  if (change === null || prior <= 0) return undefined;
  return {
    value: formatChange(change / 100),
    trend: change === 0 ? "flat" : change > 0 ? "up" : "down",
    sentiment: "neutral",
    comparison,
  };
}

/**
 * Insights > Activity: what's running now, sandbox time, limits, the depth of
 * subagent trees, calls worth a look and knowledge in prompts. Workspace-wide.
 */
export function WorkspaceActivity(props: {
  workspaceId: string;
  range: InsightsRange;
  onRangeChange: (range: InsightsRange) => void;
  onOpenSession: (sessionId: string) => void;
  onFilterSession: (rootSessionId: string) => void;
}) {
  const { client } = useAppContext();
  const [snap, setSnap] = useState<WorkspaceInsightsSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [floorFilter, setFloorFilter] = useState<"all" | "active">("all");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client
      .getWorkspaceInsights(props.workspaceId, { range: props.range, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setSnap(response.snapshot);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught);
        setLoading(false);
      });
    return () => controller.abort();
  }, [client, props.workspaceId, props.range, retry]);

  const diagnostics = useMemo(() => (snap ? buildInsightsDiagnostics(snap) : null), [snap]);

  const rangeControl = (
    <SelectMenu
      aria-label="Period"
      size="sm"
      value={props.range}
      onValueChange={props.onRangeChange}
      options={ACTIVITY_RANGES}
      className="w-40"
    />
  );

  if (error && !snap) {
    return (
      <div role="alert">
        <Notice
          tone="failed"
          title="Activity couldn't load"
          action={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRetry((n) => n + 1)}
            >
              Try again
            </Button>
          }
        >
          {apiErrorAdvice(error)}
        </Notice>
      </div>
    );
  }
  if (!snap || !diagnostics) {
    return (
      <div className="flex min-w-0 flex-col gap-6" aria-busy="true">
        <span className="sr-only" role="status">
          Loading activity
        </span>
        {rangeControl}
        {[0, 1, 2, 3].map((index) => (
          <ListRowSkeleton key={index} />
        ))}
      </div>
    );
  }

  const comparison = `vs ${priorLabel(props.range)}`;
  const floor = snap.floor.filter((row) =>
    floorFilter === "active"
      ? row.state === "running" || row.state === "compacting" || row.state === "waiting"
      : true,
  );
  const maxDepthSessions = Math.max(...snap.depth.map((bucket) => bucket.sessions), 1);
  const contributions = snap.promptContributions;
  const hasDiagnostics =
    diagnostics.outliers.length > 0 ||
    diagnostics.cacheMisses.length > 0 ||
    diagnostics.lowCacheRoots.length > 0;
  const modelName = (provider: string, model: string) => modelDisplayName(provider, model);

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-6", loading && "opacity-60 transition-opacity")}
      aria-busy={loading || undefined}
    >
      {rangeControl}
      <SectionStack variant="open">
        <Section
          title="Live now"
          description="Chats running or waiting right now. Select one to open it."
          action={
            snap.floor.length > 0 ? (
              <SegmentedControl<"all" | "active">
                size="sm"
                aria-label="Live chats shown"
                value={floorFilter}
                onValueChange={setFloorFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "active", label: "Working" },
                ]}
              />
            ) : undefined
          }
        >
          {floor.length > 0 ? (
            <RowList variant="table" label="Live chats" nameLabel="Chat" columns={FLOOR_COLUMNS}>
              {floor.map((row) => (
                <ListRow
                  key={row.id}
                  leading={<StateDot state={row.state} />}
                  title={row.title}
                  meta={[
                    row.model && row.provider
                      ? modelName(row.provider, row.model)
                      : (row.model ?? "No model yet"),
                    backendLabel(row.route),
                  ]}
                  onOpen={() => props.onOpenSession(row.id)}
                  indicator="open"
                  cells={{
                    state: <span className="text-fg-muted capitalize">{row.state}</span>,
                    age: <Quiet>{row.ageLabel}</Quiet>,
                    cache: <Quiet>{formatCachePct(row.cacheHitPct)}</Quiet>,
                  }}
                />
              ))}
            </RowList>
          ) : (
            <EmptyLine>No chats are running right now.</EmptyLine>
          )}
        </Section>

        {hasDiagnostics ? (
          <Section
            title="Worth a look"
            description={`From the ${diagnostics.sampleSize.toLocaleString()} most recent calls${diagnostics.sampleTruncated ? "; older calls aren't checked" : ""}.`}
          >
            <div className="grid min-w-0 gap-6 lg:grid-cols-3">
              {diagnostics.outliers.length > 0 ? (
                <DiagnosticList
                  title="Unusually large calls"
                  description={`At least ${OUTLIER_MEDIAN_MULTIPLE}x the typical ${formatTokens(Math.round(diagnostics.medianTotalTokens ?? 0))} tokens per call.`}
                  rows={diagnostics.outliers.map(({ call, ratio }) => ({
                    id: call.id,
                    title: call.sessionTitle,
                    meta: `${modelName(call.provider, call.model)} · ${formatTokens(call.totalTokens ?? 0)} · ${ratio.toFixed(1)}x`,
                    onSelect: () => props.onOpenSession(call.sessionId),
                  }))}
                />
              ) : null}
              {diagnostics.cacheMisses.length > 0 ? (
                <DiagnosticList
                  title="Missed the cache"
                  description={`No cache read on at least ${formatTokens(CACHE_MISS_MIN_INPUT_TOKENS)} input tokens.`}
                  rows={diagnostics.cacheMisses.map(({ call, uncachedInputTokens }) => ({
                    id: call.id,
                    title: call.sessionTitle,
                    meta: `${modelName(call.provider, call.model)} · ${formatTokens(uncachedInputTokens)} new input`,
                    onSelect: () => props.onOpenSession(call.sessionId),
                  }))}
                />
              ) : null}
              {diagnostics.lowCacheRoots.length > 0 ? (
                <DiagnosticList
                  title="Little cache reuse"
                  description="Large sessions where under a quarter of the input came from cache."
                  rows={diagnostics.lowCacheRoots.map((driver) => {
                    const rootId = driverRootSessionId(driver.id);
                    return {
                      id: driver.id,
                      title: driver.label,
                      meta: `${formatTokens(driver.tokens)} tokens · ${formatCachePct(driver.cacheHitPct)} from cache`,
                      onSelect: rootId ? () => props.onFilterSession(rootId) : undefined,
                    };
                  })}
                />
              ) : null}
            </div>
          </Section>
        ) : null}

        {contributions && contributions.sources.length > 0 ? (
          <Section
            title="Knowledge in prompts"
            description={`About ${
              contributions.coveredCalls > 0
                ? formatTokens(
                    Math.round(contributions.estimatedTokens / contributions.coveredCalls),
                  )
                : "—"
            } tokens per call come from instructions, organization identity, memory and skills (estimated from their size). Measured on ${contributions.coveredCalls.toLocaleString()} of ${contributions.totalCalls.toLocaleString()} calls.`}
          >
            <RowList
              variant="table"
              label="Knowledge in prompts"
              nameLabel="Source"
              columns={PROMPT_COLUMNS}
            >
              {contributions.sources.map((row) => (
                <ListRow
                  key={row.source}
                  title={PROMPT_SOURCE_LABELS[row.source]}
                  cells={{
                    tokens: <Quiet>{formatTokens(row.estimatedTokens)}</Quiet>,
                    share: (
                      <Quiet>
                        {contributions.estimatedTokens > 0
                          ? `${Math.round((row.estimatedTokens / contributions.estimatedTokens) * 100)}%`
                          : "—"}
                      </Quiet>
                    ),
                    calls: <Quiet>{row.calls.toLocaleString()}</Quiet>,
                  }}
                />
              ))}
            </RowList>
          </Section>
        ) : null}

        <Section title="Sandbox time">
          <div className="flex min-w-0 flex-col gap-4">
            <StatGroup label="Sandbox time">
              <StatTile
                label="Warm time"
                value={formatWarmHours(snap.warmSeconds)}
                {...(delta(snap.warmSeconds, snap.priorWarmSeconds, comparison)
                  ? { delta: delta(snap.warmSeconds, snap.priorWarmSeconds, comparison)! }
                  : {})}
              />
              <StatTile
                label="Warm now"
                value={snap.liveWarm.length.toLocaleString()}
                caption={`${snap.warmIdleNow} idle · ${snap.liveWarm.length - snap.warmIdleNow} in use`}
              />
              <StatTile
                label="Machines online"
                value={snap.machinesOnline.toLocaleString()}
                caption={snap.selfhostedEnabled ? "Not metered" : "Not enabled on this server"}
              />
              <StatTile
                label="Sandbox groups"
                value={snap.warmGroups.length.toLocaleString()}
                caption="With warm time in this period"
              />
            </StatGroup>
            <AreaChart
              key={`warm-${props.range}`}
              labels={snap.series.map((p) => p.label)}
              valueSuffix="h"
              valueDigits={1}
              height={180}
              series={[
                {
                  id: "warm",
                  label: "Warm hours",
                  values: snap.series.map((d) => Math.round((d.warmSeconds / 3600) * 10) / 10),
                  className: "text-chart-1",
                },
              ]}
            />
            {snap.warmGroups.length > 0 ? (
              <RowList
                variant="table"
                label="Warm time by sandbox"
                nameLabel="Sandbox"
                columns={WARM_COLUMNS}
              >
                {[...snap.warmGroups]
                  .sort((a, b) => b.warmSeconds - a.warmSeconds)
                  .map((group) => (
                    <ListRow
                      key={group.id}
                      title={group.label}
                      meta={[backendLabel(group.backend)]}
                      cells={{
                        warm: <Quiet>{formatWarmHours(group.warmSeconds)}</Quiet>,
                        sessions: <Quiet>{group.sessionsAttached.toLocaleString()}</Quiet>,
                      }}
                    />
                  ))}
              </RowList>
            ) : null}
          </div>
        </Section>

        <Section
          title="Limits"
          description="Credit-paid tokens and agent runs since the start of this UTC month. Calls paid by a plan or your own key don't count."
        >
          <div className="grid min-w-0 gap-6 sm:grid-cols-2">
            {snap.billableTokenCap != null ? (
              <UsageMeter
                label="Credit-paid tokens"
                detail={`${formatTokens(snap.billableTokensUsed)} of ${formatTokens(snap.billableTokenCap)}`}
                total={snap.billableTokenCap}
                segments={[
                  {
                    id: "billable",
                    value: snap.billableTokensUsed,
                    className: "bg-brand",
                    label: "Tokens",
                  },
                ]}
              />
            ) : (
              <StatTile
                framed
                label="Credit-paid tokens"
                value={formatTokens(snap.billableTokensUsed)}
                caption="No token limit"
              />
            )}
            {snap.agentRunCap != null ? (
              <UsageMeter
                label="Agent runs"
                detail={`${snap.agentRunsUsed.toLocaleString()} of ${snap.agentRunCap.toLocaleString()}`}
                total={snap.agentRunCap}
                segments={[
                  {
                    id: "runs",
                    value: Math.min(snap.agentRunCap, snap.agentRunsUsed),
                    className: "bg-chart-1",
                    label: "Runs",
                  },
                ]}
              />
            ) : (
              <StatTile
                framed
                label="Agent runs"
                value={snap.agentRunsUsed.toLocaleString()}
                caption="No run limit"
              />
            )}
          </div>
        </Section>

        <Section title="Subagents" description="How deep sessions go, across all time.">
          <div className="flex min-w-0 flex-col gap-4">
            <StatGroup label="Subagents" columns={3}>
              <StatTile
                label="Chats"
                value={snap.sessionsTouched.toLocaleString()}
                caption={`${snap.rootSessions.toLocaleString()} sessions · ${snap.avgDepth.toFixed(2)} deep on average`}
              />
              <StatTile
                label="Deepest"
                value={snap.deepestDepth}
                caption={snap.deepestSessionTitle}
              />
              <StatTile
                label="Goals done"
                value={snap.goalsCompleted.toLocaleString()}
                caption={`${snap.goalsActive} active now`}
              />
            </StatGroup>
            <ul className="grid gap-3">
              {snap.depth.map((bucket) => (
                <li key={bucket.depth} className="grid gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-medium text-fg">
                      {bucket.depth === 0 ? "Sessions" : `Level ${bucket.depth} subagents`}
                    </span>
                    <span className="text-fg-muted tabular-nums">
                      {bucket.sessions.toLocaleString()}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-fg-muted"
                      style={{
                        width: `${Math.max(2, (bucket.sessions / maxDepthSessions) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      </SectionStack>
    </div>
  );
}

function formatCachePct(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value}%`;
}

function Quiet(props: { children: ReactNode }) {
  return <span className="text-fg-muted tabular-nums">{props.children}</span>;
}

function EmptyLine(props: { children: ReactNode }) {
  return <p className="text-sm text-fg-muted">{props.children}</p>;
}

function DiagnosticList(props: {
  title: string;
  description: string;
  rows: Array<{ id: string; title: string; meta: string; onSelect?: (() => void) | undefined }>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <h3 className="text-sm leading-5 font-medium text-fg">{props.title}</h3>
        <p className="text-xs leading-[18px] text-fg-muted">{props.description}</p>
      </div>
      <RowList label={props.title} flush>
        {props.rows.map((row) => (
          <ListRow key={row.id} title={row.title} meta={[row.meta]} onOpen={row.onSelect} />
        ))}
      </RowList>
    </div>
  );
}

function StateDot(props: { state: FloorSession["state"] }) {
  const live = props.state === "running" || props.state === "compacting";
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden="true">
      {live ? (
        <span className="absolute inline-flex size-full rounded-full bg-status-running opacity-40 motion-safe:animate-ping" />
      ) : null}
      <span className={cn("relative size-2 rounded-full", stateColor(props.state))} />
    </span>
  );
}

function stateColor(state: FloorSession["state"]): string {
  switch (state) {
    case "waiting":
      return "bg-status-waiting";
    case "running":
    case "compacting":
      return "bg-status-running";
    case "paused":
      return "bg-fg-subtle";
    case "failed":
      return "bg-danger";
    case "idle":
      return "bg-status-idle";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}
