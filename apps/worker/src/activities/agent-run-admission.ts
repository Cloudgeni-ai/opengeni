import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import { getBillingBalance, isCodexBilledTurn, sumUsageQuantity } from "@opengeni/db";
import type { ControlActivityServices } from "./types";

export type AgentRunAdmissionDenial =
  | "insufficient_credits"
  | "monthly_model_cost_limit"
  | "monthly_agent_run_limit";

/** One worker-side admission boundary for service-authored agent runs. */
export async function agentRunAdmissionDenial(
  services: Pick<ControlActivityServices, "db" | "entitlements"> & { settings: Settings },
  input: {
    accountId: string;
    workspaceId: string;
    model: string;
    requestedAgentRuns: number;
  },
): Promise<AgentRunAdmissionDenial | null> {
  const externallyBilled = await isCodexBilledTurn({
    db: services.db,
    settings: services.settings,
    workspaceId: input.workspaceId,
    model: input.model,
  });
  if (
    !externallyBilled &&
    (services.settings.billingMode === "stripe" || services.settings.usageLimitsMode === "managed")
  ) {
    if (services.entitlements) {
      const decision = await services.entitlements.admitRun({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        action: "agent_run:create",
        quantity: input.requestedAgentRuns,
      });
      if (!decision.allowed) return "insufficient_credits";
    } else {
      const balance = await getBillingBalance(services.db, input.accountId);
      if (balance.balanceMicros <= 0) return "insufficient_credits";
    }
  }
  if (
    services.settings.usageLimitsMode !== "static" &&
    services.settings.usageLimitsMode !== "managed"
  ) {
    return null;
  }
  const limits = configuredStaticUsageLimits(services.settings);
  if (!externallyBilled && limits.maxMonthlyCostMicrosPerAccount) {
    const used = await sumUsageQuantity(services.db, {
      accountId: input.accountId,
      eventType: "model.cost",
      since: startOfUtcMonth(),
    });
    if (used >= limits.maxMonthlyCostMicrosPerAccount) {
      return "monthly_model_cost_limit";
    }
  }
  if (limits.maxMonthlyAgentRunsPerWorkspace) {
    const used = await sumUsageQuantity(services.db, {
      workspaceId: input.workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    if (used + input.requestedAgentRuns > limits.maxMonthlyAgentRunsPerWorkspace) {
      return "monthly_agent_run_limit";
    }
  }
  return null;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
