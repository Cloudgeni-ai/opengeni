import {
  canonicalizeConfiguredModelId,
  configuredStaticUsageLimits,
  type Settings,
} from "@opengeni/config";
import type { BillingOrigin, EntitlementsPort } from "@opengeni/contracts";
import { coreRoutedSubscriptionFunding, modelFundingForAdmission } from "./limits";
import {
  chargeBillingOrigin,
  checkWorkspaceAllowance,
  getSpendableCreditBalance,
  isCodexBilledTurn,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";

export type AgentRunAdmissionDenial =
  | "insufficient_credits"
  /** API work found no credits: plan credit never pays for it. */
  | "api_credits_required"
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
    acceptedTurn?: { sessionId: string; turnId: string };
    /**
     * Who pays: API work needs credits; plan credit never pays for it. A
     * resolver is read only when credits decide admission.
     */
    billingOrigin?: BillingOrigin | null | (() => Promise<BillingOrigin | null>);
  },
): Promise<AgentRunAdmissionDenial | null> {
  const codexBilled = await isCodexBilledTurn({
    db: services.db,
    settings: services.settings,
    workspaceId: input.workspaceId,
    model: input.model,
    accountId: input.accountId,
    subjectId: input.initiatingHumanSubjectId ?? null,
    ...(input.acceptedTurn ? { acceptedTurn: input.acceptedTurn } : {}),
  });
  const externallyBilled = modelFundingForAdmission(
    services.settings,
    input.model,
    codexBilled,
    await coreRoutedSubscriptionFunding(services.db, services.settings, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      model: input.model,
      subjectId: input.initiatingHumanSubjectId ?? null,
      ...(input.acceptedTurn ? { acceptedTurn: input.acceptedTurn } : {}),
    }),
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
      const billingOrigin =
        typeof input.billingOrigin === "function"
          ? await input.billingOrigin()
          : input.billingOrigin;
      const balance = await getSpendableCreditBalance(
        services.db,
        input.accountId,
        canonicalizeConfiguredModelId(services.settings, input.model),
        undefined,
        undefined,
        billingOrigin,
      );
      if (balance.balanceMicros <= 0) {
        return chargeBillingOrigin(billingOrigin) === "api"
          ? "api_credits_required"
          : "insufficient_credits";
      }
    }
  }
  const refusal = await checkWorkspaceAllowance(services.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.initiatingHumanSubjectId ?? null,
    ...(externallyBilled ? { fundedWithoutCredits: true } : {}),
  });
  if (refusal) return refusal.code;
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
