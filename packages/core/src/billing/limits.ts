import { configuredStaticUsageLimits } from "@opengeni/config";
import type {
  LimitAction,
  LimitDecision,
  SessionTurnSource,
  TurnInitiator,
  TurnInitiatorContext,
} from "@opengeni/contracts";
import {
  countActiveApiKeysForWorkspace,
  countScheduledTasksForWorkspace,
  countWorkspacesForAccount,
  getBillingBalance,
  isCodexBilledTurn,
  recordUsageEvent,
  sumUsageQuantity,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";

export type LimitDependencies = Pick<ApiRouteDeps, "db" | "settings">;

export type LimitCheckInput = {
  accountId: string;
  workspaceId?: string;
  action: LimitAction;
  quantity?: number;
  // The turn's model id, when the action represents an agent turn. When this is a
  // Codex-billed turn (codex/<slug> + feature enabled + active workspace
  // credential) the turn is paid by the user's ChatGPT/Codex plan and consumes
  // ZERO OpenGeni credits, so the credit-balance + model-cost + token gates are
  // skipped. Non-model infra actions (workspace/api_key/schedule create) leave
  // this undefined and are unaffected.
  model?: string | null;
};

export async function requireLimit(deps: LimitDependencies, input: LimitCheckInput): Promise<void> {
  const decision = await checkLimit(deps, input);
  if (decision.allowed) {
    return;
  }
  throw new HTTPException(decision.code === "insufficient_credits" ? 402 : 429, {
    message: decision.message,
  });
}

export async function checkLimit(
  deps: LimitDependencies,
  input: LimitCheckInput,
): Promise<LimitDecision> {
  // Resolve the canonical codex-billed predicate ONCE. Returns false for any
  // action that carries no model (infra caps) or any codex/<slug> model without
  // an active credential — so the bypass never triggers on the prefix alone.
  const codexBilled = input.workspaceId
    ? await isCodexBilledTurn({
        db: deps.db,
        settings: deps.settings,
        workspaceId: input.workspaceId,
        model: input.model,
      })
    : false;
  const creditDecision = await checkCreditBalance(deps, input, codexBilled);
  if (!creditDecision.allowed) {
    return creditDecision;
  }
  if (deps.settings.usageLimitsMode !== "static" && deps.settings.usageLimitsMode !== "managed") {
    return { allowed: true };
  }
  return await checkStaticCaps(deps, input, codexBilled);
}

async function checkCreditBalance(
  deps: LimitDependencies,
  input: LimitCheckInput,
  codexBilled: boolean,
): Promise<LimitDecision> {
  if (codexBilled) {
    return { allowed: true }; // paid by the user's ChatGPT/Codex plan — zero OpenGeni credits
  }
  if (!usesCreditLimits(deps) || !isCostlyAction(input.action)) {
    return { allowed: true };
  }
  const balance = await getBillingBalance(deps.db, input.accountId);
  if (balance.balanceMicros > 0) {
    return { allowed: true };
  }
  return { allowed: false, code: "insufficient_credits", message: "insufficient OpenGeni credits" };
}

async function checkStaticCaps(
  deps: LimitDependencies,
  input: LimitCheckInput,
  codexBilled: boolean,
): Promise<LimitDecision> {
  const limits = configuredStaticUsageLimits(deps.settings);
  if (limits.maxMonthlyCostMicrosPerAccount && isCostlyAction(input.action) && !codexBilled) {
    const used = await sumUsageQuantity(deps.db, {
      accountId: input.accountId,
      eventType: "model.cost",
      since: startOfUtcMonth(),
    });
    if (used >= limits.maxMonthlyCostMicrosPerAccount) {
      return blocked(
        "max_monthly_cost_micros_per_account",
        `monthly model cost limit reached (${limits.maxMonthlyCostMicrosPerAccount} micros)`,
      );
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
        : blocked(
            "max_workspaces_per_account",
            `workspace limit reached (${limits.maxWorkspacesPerAccount})`,
          );
    }
    case "api_key:create": {
      if (!limits.maxApiKeysPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const count = await countActiveApiKeysForWorkspace(deps.db, input.workspaceId);
      return count < limits.maxApiKeysPerWorkspace
        ? { allowed: true }
        : blocked(
            "max_api_keys_per_workspace",
            `API key limit reached (${limits.maxApiKeysPerWorkspace})`,
          );
    }
    case "schedule:create": {
      if (!limits.maxSchedulesPerWorkspace || !input.workspaceId) {
        return { allowed: true };
      }
      const count = await countScheduledTasksForWorkspace(deps.db, input.workspaceId);
      return count < limits.maxSchedulesPerWorkspace
        ? { allowed: true }
        : blocked(
            "max_schedules_per_workspace",
            `scheduled task limit reached (${limits.maxSchedulesPerWorkspace})`,
          );
    }
    case "file:upload": {
      if (!limits.maxFileUploadBytes || !input.quantity) {
        return { allowed: true };
      }
      return input.quantity <= limits.maxFileUploadBytes
        ? { allowed: true }
        : blocked(
            "max_file_upload_bytes",
            `file upload exceeds static limit of ${limits.maxFileUploadBytes} bytes`,
          );
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
        : blocked(
            "max_monthly_agent_runs_per_workspace",
            `monthly agent run limit reached (${limits.maxMonthlyAgentRunsPerWorkspace})`,
          );
    }
    case "tokens:consume": {
      if (codexBilled || !limits.maxMonthlyTokensPerWorkspace || !input.workspaceId) {
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
        : blocked(
            "max_monthly_tokens_per_workspace",
            `monthly token limit reached (${limits.maxMonthlyTokensPerWorkspace})`,
          );
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
        : blocked(
            "max_document_indexed_chunks_per_workspace",
            `monthly document indexing limit reached (${limits.maxDocumentIndexedChunksPerWorkspace} chunks)`,
          );
    }
  }
}

export async function recordWorkspaceUsage(
  deps: LimitDependencies,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId?: string | null;
    eventType: "agent_run.created" | "file.uploaded" | "document.indexed" | "scheduled_task.fired";
    quantity: number;
    unit: string;
    sourceResourceType: string;
    sourceResourceId: string;
    sessionId?: string | null;
    turnId?: string | null;
    turnAttemptId?: string | null;
    initiator?: TurnInitiator | null;
    initiatorContext?: TurnInitiatorContext;
    origin?: SessionTurnSource | null;
    idempotencyKey: string;
  },
): Promise<void> {
  await recordUsageEvent(deps.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId ?? null,
    eventType: input.eventType,
    quantity: input.quantity,
    unit: input.unit,
    sourceResourceType: input.sourceResourceType,
    sourceResourceId: input.sourceResourceId,
    sessionId: input.sessionId ?? null,
    turnId: input.turnId ?? null,
    turnAttemptId: input.turnAttemptId ?? null,
    initiator:
      input.initiator ?? (input.subjectId ? { kind: "subject", subjectId: input.subjectId } : null),
    ...(input.initiatorContext ? { initiatorContext: input.initiatorContext } : {}),
    origin: input.origin ?? null,
    idempotencyKey: input.idempotencyKey,
  });
}

function usesCreditLimits(deps: LimitDependencies): boolean {
  return deps.settings.billingMode === "stripe" || deps.settings.usageLimitsMode === "managed";
}

function isCostlyAction(action: LimitAction): boolean {
  return (
    action === "agent_run:create" || action === "tokens:consume" || action === "document:index"
  );
}

function blocked(code: string, message: string): LimitDecision {
  return { allowed: false, code, message };
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
