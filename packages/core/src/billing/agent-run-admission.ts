import {
  canonicalizeConfiguredModelId,
  configuredStaticUsageLimits,
  type Settings,
} from "@opengeni/config";
import type { EntitlementsPort } from "@opengeni/contracts";
import { modelFundingForAdmission } from "./limits";
import {
  checkWorkspaceAllowance,
  getSpendableCreditBalance,
  isCodexBilledTurn,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";

export type AgentRunAdmissionDenial =
  | "insufficient_credits"
  | "allowance_exhausted"
  | "monthly_model_cost_limit"
  | "monthly_agent_run_limit";

/** Read-only admission shared by service-authored runs and goal Resume. */
export async function agentRunAdmissionDenial(
  services: { db: Database; settings: Settings; entitlements?: EntitlementsPort | null },
  input: {
    accountId: string;
    workspaceId: string;
    model: string;
    requestedAgentRuns: number;
    /** The accepted work's causal human, not the scheduler/service caller. */
    initiatingHumanSubjectId?: string | null;
  },
): Promise<AgentRunAdmissionDenial | null> {
  const codexBilled = await isCodexBilledTurn({
    db: services.db,
    settings: services.settings,
    workspaceId: input.workspaceId,
    model: input.model,
  });
  const externallyBilled = modelFundingForAdmission(
    services.settings,
    input.model,
    codexBilled,
  ).fundedWithoutCredits;
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
      const balance = await getSpendableCreditBalance(
        services.db,
        input.accountId,
        canonicalizeConfiguredModelId(services.settings, input.model),
      );
      if (balance.balanceMicros <= 0) return "insufficient_credits";
    }
  }
  if (!externallyBilled) {
    const refusal = await checkWorkspaceAllowance(services.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.initiatingHumanSubjectId ?? null,
    });
    if (refusal) return refusal.code;
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
