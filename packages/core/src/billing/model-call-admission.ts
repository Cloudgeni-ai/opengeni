import { configuredStaticUsageLimits, type Settings } from "@opengeni/config";
import type { EntitlementsPort } from "@opengeni/contracts";
import {
  checkWorkspaceAllowance,
  getSpendableCreditBalance,
  sumUsageQuantity,
  type Database,
} from "@opengeni/db";

export type ModelCallAdmissionDenial =
  | "insufficient_credits"
  | "allowance_exhausted"
  | "monthly_model_cost_limit"
  | "monthly_token_limit";

export type ModelCallAdmission =
  | { allowed: true; creditPolicyRevision: number | undefined }
  | { allowed: false; denial: ModelCallAdmissionDenial; message: string };

/**
 * Admission for one stateless model call, with the same funding rules as an
 * agent turn between model calls: an Opengeni-credit model needs a positive
 * spendable balance, the workspace allowance must not be exhausted, and the
 * static monthly caps apply. Admission is a read, never a reservation or an
 * estimate of the call's cost; settlement charges actual usage afterwards.
 * Externally funded calls (subscriptions, workspace or organization keys)
 * skip the credit gate and the token cap.
 */
export async function admitModelCall(
  services: { db: Database; settings: Settings; entitlements?: EntitlementsPort | null },
  input: {
    accountId: string;
    workspaceId: string;
    /** Canonical product model id; scopes model-specific promotional credits. */
    model: string;
    chargesOpenGeniCredits: boolean;
    countsTowardTokenCap: boolean;
    subjectId: string | null;
  },
): Promise<ModelCallAdmission> {
  const { settings, db } = services;
  const metered = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  let creditPolicyRevision: number | undefined;
  if (input.chargesOpenGeniCredits && metered) {
    if (services.entitlements) {
      const decision = await services.entitlements.admitRun({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        action: "model_call:create",
        quantity: 1,
      });
      if (!decision.allowed) {
        return {
          allowed: false,
          denial: "insufficient_credits",
          message: decision.reason || "Insufficient Opengeni credits.",
        };
      }
    } else {
      const balance = await getSpendableCreditBalance(db, input.accountId, input.model);
      creditPolicyRevision = balance.creditPolicyRevision;
      if (balance.balanceMicros <= 0) {
        return {
          allowed: false,
          denial: "insufficient_credits",
          message: "Insufficient Opengeni credits.",
        };
      }
    }
  }
  const refusal = await checkWorkspaceAllowance(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    ...(input.chargesOpenGeniCredits ? {} : { fundedWithoutCredits: true }),
  });
  if (refusal) {
    return { allowed: false, denial: "allowance_exhausted", message: refusal.message };
  }
  if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
    const limits = configuredStaticUsageLimits(settings);
    const since = startOfUtcMonth();
    if (input.chargesOpenGeniCredits && limits.maxMonthlyCostMicrosPerAccount) {
      const used = await sumUsageQuantity(db, {
        accountId: input.accountId,
        eventType: "model.cost",
        since,
      });
      if (used >= limits.maxMonthlyCostMicrosPerAccount) {
        return {
          allowed: false,
          denial: "monthly_model_cost_limit",
          message: "The monthly model cost limit has been reached.",
        };
      }
    }
    if (input.countsTowardTokenCap && limits.maxMonthlyTokensPerWorkspace) {
      const used = await sumUsageQuantity(db, {
        workspaceId: input.workspaceId,
        eventType: "model.tokens",
        since,
      });
      if (used >= limits.maxMonthlyTokensPerWorkspace) {
        return {
          allowed: false,
          denial: "monthly_token_limit",
          message: "The monthly token limit has been reached.",
        };
      }
    }
  }
  return { allowed: true, creditPolicyRevision };
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
