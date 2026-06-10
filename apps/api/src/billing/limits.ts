import { configuredStaticUsageLimits } from "@opengeni/config";
import type { LimitAction, LimitDecision } from "@opengeni/contracts";
import {
  countActiveApiKeysForWorkspace,
  countScheduledTasksForWorkspace,
  countWorkspacesForAccount,
  getBillingBalance,
  recordUsageEvent,
  sumUsageQuantity,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";

export type LimitCheckInput = {
  accountId: string;
  workspaceId?: string;
  action: LimitAction;
  quantity?: number;
};

export async function requireLimit(deps: ApiRouteDeps, input: LimitCheckInput): Promise<void> {
  const decision = await checkLimit(deps, input);
  if (decision.allowed) {
    return;
  }
  throw new HTTPException(decision.code === "insufficient_credits" ? 402 : 429, { message: decision.message });
}

export async function checkLimit(deps: ApiRouteDeps, input: LimitCheckInput): Promise<LimitDecision> {
  const creditDecision = await checkCreditBalance(deps, input);
  if (!creditDecision.allowed) {
    return creditDecision;
  }
  if (deps.settings.usageLimitsMode !== "static" && deps.settings.usageLimitsMode !== "managed") {
    return { allowed: true };
  }
  return await checkStaticCaps(deps, input);
}

async function checkCreditBalance(deps: ApiRouteDeps, input: LimitCheckInput): Promise<LimitDecision> {
  if (!usesCreditLimits(deps) || !isCostlyAction(input.action)) {
    return { allowed: true };
  }
  const balance = await getBillingBalance(deps.db, input.accountId);
  if (balance.balanceMicros > 0) {
    return { allowed: true };
  }
  return { allowed: false, code: "insufficient_credits", message: "insufficient OpenGeni credits" };
}

async function checkStaticCaps(deps: ApiRouteDeps, input: LimitCheckInput): Promise<LimitDecision> {
  const limits = configuredStaticUsageLimits(deps.settings);
  if (limits.maxMonthlyCostMicrosPerAccount && isCostlyAction(input.action)) {
    const used = await sumUsageQuantity(deps.db, {
      accountId: input.accountId,
      eventType: "model.cost",
      since: startOfUtcMonth(),
    });
    if (used >= limits.maxMonthlyCostMicrosPerAccount) {
      return blocked("max_monthly_cost_micros_per_account", `monthly model cost limit reached (${limits.maxMonthlyCostMicrosPerAccount} micros)`);
    }
  }
  switch (input.action) {
    case "workspace:create": {
      if (!limits.maxWorkspacesPerAccount) {
        return { allowed: true };
      }
      const count = await countWorkspacesForAccount(deps.db, input.accountId);
      return count < limits.maxWorkspacesPerAccount
        ? { allowed: true }
        : blocked("max_workspaces_per_account", `workspace limit reached (${limits.maxWorkspacesPerAccount})`);
    }
    case "api_key:create": {
      if (!limits.maxApiKeysPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const count = await countActiveApiKeysForWorkspace(deps.db, input.workspaceId);
      return count < limits.maxApiKeysPerWorkspace
        ? { allowed: true }
        : blocked("max_api_keys_per_workspace", `API key limit reached (${limits.maxApiKeysPerWorkspace})`);
    }
    case "schedule:create": {
      if (!limits.maxSchedulesPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const count = await countScheduledTasksForWorkspace(deps.db, input.workspaceId);
      return count < limits.maxSchedulesPerWorkspace
        ? { allowed: true }
        : blocked("max_schedules_per_workspace", `scheduled task limit reached (${limits.maxSchedulesPerWorkspace})`);
    }
    case "file:upload": {
      if (!limits.maxFileUploadBytes || !input.quantity) {
        return { allowed: true };
      }
      return input.quantity <= limits.maxFileUploadBytes
        ? { allowed: true }
        : blocked("max_file_upload_bytes", `file upload exceeds static limit of ${limits.maxFileUploadBytes} bytes`);
    }
    case "agent_run:create": {
      if (!limits.maxMonthlyAgentRunsPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const used = await sumUsageQuantity(deps.db, {
        workspaceId: input.workspaceId,
        eventType: "agent_run.created",
        since: startOfUtcMonth(),
      });
      const requested = input.quantity ?? 0;
      return used + requested <= limits.maxMonthlyAgentRunsPerWorkspace
        ? { allowed: true }
        : blocked("max_monthly_agent_runs_per_workspace", `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`);
    }
    case "tokens:consume": {
      if (!limits.maxMonthlyTokensPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const used = await sumUsageQuantity(deps.db, {
        workspaceId: input.workspaceId,
        eventType: "model.tokens",
        since: startOfUtcMonth(),
      });
      const requested = input.quantity ?? 0;
      return used + requested <= limits.maxMonthlyTokensPerWorkspace
        ? { allowed: true }
        : blocked("max_monthly_tokens_per_workspace", `monthly token limit reached (${limits.maxMonthlyTokensPerWorkspace})`);
    }
    case "document:index": {
      if (!limits.maxDocumentIndexedChunksPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const used = await sumUsageQuantity(deps.db, {
        workspaceId: input.workspaceId,
        eventType: "document.indexed",
        since: startOfUtcMonth(),
      });
      const requested = input.quantity ?? 0;
      return used + requested <= limits.maxDocumentIndexedChunksPerWorkspace
        ? { allowed: true }
        : blocked("max_document_indexed_chunks_per_workspace", `monthly document indexing limit reached (${limits.maxDocumentIndexedChunksPerWorkspace} chunks)`);
    }
  }
}

export async function recordWorkspaceUsage(deps: ApiRouteDeps, input: {
  accountId: string;
  workspaceId: string;
  subjectId?: string | null;
  eventType:
    | "agent_run.created"
    | "file.uploaded"
    | "document.indexed"
    | "scheduled_task.fired";
  quantity: number;
  unit: string;
  sourceResourceType: string;
  sourceResourceId: string;
  idempotencyKey: string;
}): Promise<void> {
  await recordUsageEvent(deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId ?? null,
    eventType: input.eventType,
    quantity: input.quantity,
    unit: input.unit,
    sourceResourceType: input.sourceResourceType,
    sourceResourceId: input.sourceResourceId,
    idempotencyKey: input.idempotencyKey,
  });
}

function usesCreditLimits(deps: ApiRouteDeps): boolean {
  return deps.settings.billingMode === "stripe" || deps.settings.usageLimitsMode === "managed";
}

function isCostlyAction(action: LimitAction): boolean {
  return action === "agent_run:create"
    || action === "tokens:consume"
    || action === "file:upload"
    || action === "document:index";
}

function blocked(code: string, message: string): LimitDecision {
  return { allowed: false, code, message };
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
