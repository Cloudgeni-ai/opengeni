/**
 * What an agent cost in the last 30 days, and per run, on its page. Read from
 * Insights usage (filtered to the agent, one group per run), with the spend
 * Insights > Usage shows: credits charged, plus the list-price estimate of
 * usage paid by plans or your own keys. Only people who may see Usage get it;
 * anything else (no access, an older server, an error) shows nothing.
 */
import { useEffect, useState } from "react";
import type { Agent } from "@opengeni/contracts";

import { useAppContext } from "../../app-context";
import { canManageWorkspaceSettings } from "../../lib/permissions";
import { formatUsageMoney, usageCostMicros } from "../../lib/usage-cost";

type Cost = { spendMicros: number; runs: number };

/** "Last 30 days: $12.40 · $0.31 per run", or that it had no runs. */
export function agentCostText(cost: Cost): string {
  if (cost.runs === 0) return "No runs in the last 30 days";
  return `Last 30 days: ${formatUsageMoney(cost.spendMicros)} · ${formatUsageMoney(
    Math.round(cost.spendMicros / cost.runs),
  )} per run`;
}

export function AgentCost({
  agent,
  workspaceId,
}: {
  agent: Pick<Agent, "id">;
  workspaceId: string;
}) {
  const { client, accessContext, workspaces, managedSelfContext } = useAppContext();
  const workspace = workspaces.find((row) => row.id === workspaceId) ?? null;
  // The Usage page's own gate; the API checks it again.
  const allowed = canManageWorkspaceSettings(accessContext, workspace, managedSelfContext);
  const [cost, setCost] = useState<Cost | null>(null);

  useEffect(() => {
    setCost(null);
    if (!allowed) return;
    const controller = new AbortController();
    client
      .getWorkspaceInsightsUsage(
        workspaceId,
        { range: "30d", agentId: agent.id, groupBy: "rootSession", limit: 1 },
        { signal: controller.signal },
      )
      .then(
        (usage) => {
          if (controller.signal.aborted) return;
          setCost({ spendMicros: usageCostMicros(usage.totals), runs: usage.groupCount });
        },
        () => undefined,
      );
    return () => controller.abort();
  }, [client, workspaceId, agent.id, allowed]);

  if (!allowed || cost === null) return null;
  return (
    <p className="m-0 text-sm text-fg-muted tabular-nums" data-agent-cost="">
      {agentCostText(cost)}
    </p>
  );
}
