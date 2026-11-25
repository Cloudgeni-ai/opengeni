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

/** Cents from a cent up, as on a bill; Usage's finer digits below that. */
function agentMoney(micros: number): string {
  const value = micros / 1_000_000;
  if (value >= 0.01 && value < 1) return `$${value.toFixed(2)}`;
  return formatUsageMoney(micros);
}

/** "Last 30 days: $12.40 · $0.31 per run", or that it had no runs. */
export function agentCostText(cost: Cost): string {
  if (cost.runs === 0) return "No runs in the last 30 days";
  return `Last 30 days: ${agentMoney(cost.spendMicros)} · ${agentMoney(
    Math.round(cost.spendMicros / cost.runs),
  )} per run`;
}

/** The agent's cost line for its page's header, or null while unknown or not shown. */
export function useAgentCostText(agent: Pick<Agent, "id">, workspaceId: string): string | null {
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

  return allowed && cost !== null ? agentCostText(cost) : null;
}

export function AgentCost({
  agent,
  workspaceId,
}: {
  agent: Pick<Agent, "id">;
  workspaceId: string;
}) {
  const text = useAgentCostText(agent, workspaceId);
  if (text === null) return null;
  return (
    <span className="tabular-nums" data-agent-cost="">
      {text}
    </span>
  );
}
