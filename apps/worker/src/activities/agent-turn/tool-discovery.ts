import { withResponsesConversation } from "@opengeni/codex";
import { calculateModelUsageCostBreakdown, type Settings } from "@opengeni/config";
import { recordUsageEvent, type Database } from "@opengeni/db";
import {
  createToolDecisionModel,
  normalizeModelCallUsage,
  type ModelResponseUsage,
  type OpenGeniRuntime,
  type ToolDecisionModel,
} from "@opengeni/runtime";
import { runAuxiliaryProviderDispatch } from "../auxiliary-provider-dispatch";
import { sessionTitleReasoningEffort } from "./session-title";

/**
 * Internal discovery inference is paid by the explicitly configured deployment
 * provider, just like code search. Never silently borrow a customer's key or
 * subscription. Embedders can supply their own admitted runtime callback.
 */
export function configuredToolDecisionModel(input: {
  settings: Settings;
  runtime: Pick<OpenGeniRuntime, "resolveTurnModel">;
  recordUsage: (modelId: string, usage: ModelResponseUsage, requestId: string) => Promise<void>;
  onUnavailable: () => void;
}): ToolDecisionModel | undefined {
  const id = input.settings.toolSearchDecisionModelId;
  if (!id) return undefined;
  try {
    const route = input.runtime.resolveTurnModel(input.settings, id);
    if (!route || route.provider.credentialSource.kind !== "deployment") {
      input.onUnavailable();
      return undefined;
    }
    const effort = sessionTitleReasoningEffort(route.configured.capabilities);
    return async (request) => {
      const requestId = crypto.randomUUID();
      const select = createToolDecisionModel(
        {
          client: route.client,
          provider: route.provider,
          modelId: route.configured.upstreamModelId,
        },
        {
          ...(effort ? { reasoningEffort: effort } : {}),
          onUsage: (usage) => input.recordUsage(id, usage, requestId),
        },
      );
      // The side request cannot replace the agent's Responses conversation or
      // enter its latency accounting. Existing dispatch checks still run.
      return await runAuxiliaryProviderDispatch(() =>
        withResponsesConversation(undefined, () => select(request)),
      );
    };
  } catch {
    input.onUnavailable();
    return undefined;
  }
}

export async function recordToolDecisionUsage(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  turnAttemptId: string;
  modelId: string;
  usage: ModelResponseUsage;
  requestId: string;
}): Promise<void> {
  const normalized = normalizeModelCallUsage(input.usage.usage).telemetry;
  const cost = calculateModelUsageCostBreakdown(
    input.settings,
    input.modelId,
    input.usage.usage,
  ).providerCostMicros;
  const entries = [
    ["input_tokens", normalized.inputTokens, "tokens"],
    ["cached_input_tokens", normalized.cachedTokens, "tokens"],
    ["output_tokens", normalized.outputTokens, "tokens"],
    ["provider_cost", cost, "usd_micros"],
  ] as const;
  const identity = input.usage.responseId ?? input.requestId;
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
    });
  }
}
