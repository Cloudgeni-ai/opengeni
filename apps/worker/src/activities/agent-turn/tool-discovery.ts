import type { Settings } from "@opengeni/config";
import { recordUsageEvent, type Database, type UsageEventProcessingResidency } from "@opengeni/db";
import type { DecisionUsage, DecisionModel } from "@opengeni/decisions";
import { runAuxiliaryProviderDispatch } from "../auxiliary-provider-dispatch";
import { configuredDecisionModel } from "./decision-model";

/** Explicitly configured typed inference, never a borrowed customer key/subscription. */
export function configuredToolDecisionModel(input: {
  settings: Settings;
  recordUsage: (modelId: string, usage: DecisionUsage, requestId: string) => Promise<void>;
  onUnavailable: () => void;
  fetch?: typeof fetch;
}): DecisionModel | undefined {
  const route = configuredDecisionModel(input.settings, input.fetch ? { fetch: input.fetch } : {});
  if (!route) {
    if (
      input.settings.decisionModelProvider ||
      input.settings.decisionModelId ||
      input.settings.decisionModelApiKey ||
      input.settings.decisionModelBaseUrl
    )
      input.onUnavailable();
    return undefined;
  }
  return {
    async decide(state, questions, options = {}) {
      const requestId = crypto.randomUUID();
      return await runAuxiliaryProviderDispatch(() =>
        route.model.decide(state, questions, {
          ...options,
          onUsage: async (usage) => {
            await input.recordUsage(route.id, usage, requestId);
            await options.onUsage?.(usage);
          },
        }),
      );
    },
  };
}

export async function recordToolDecisionUsage(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  modelId: string;
  usage: DecisionUsage;
  requestId: string;
  /** Where the decision model processed the call (its route's residency claim). */
  processingResidency?: UsageEventProcessingResidency | null;
}): Promise<void> {
  const entries = [
    ["input_tokens", input.usage.inputTokens, "tokens"],
    ["output_tokens", input.usage.outputTokens, "tokens"],
    [
      input.usage.costSource === "estimate" ? "estimated_provider_cost" : "provider_cost",
      input.usage.costUsd === null ? null : Math.round(input.usage.costUsd * 1_000_000),
      "usd_micros",
    ],
  ] as const;
  const identity = input.usage.requestId ?? input.requestId;
  for (const [category, quantity, unit] of entries) {
    if (quantity === null) continue;
    await recordUsageEvent(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      turnAttemptId: input.turnAttemptId,
      sourceResourceType: "tool_discovery",
      sourceResourceId: `${input.modelId}:${identity}`,
      eventType: `tool_discovery.${category}`,
      quantity,
      unit,
      idempotencyKey: `usage:tool_discovery:${category}:${input.turnAttemptId}:${identity}`,
      ...(input.processingResidency ? { processingResidency: input.processingResidency } : {}),
    });
  }
}
