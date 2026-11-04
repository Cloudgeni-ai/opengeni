import type { Settings } from "@opengeni/config";
import { knowledgeEmbeddingTarget } from "@opengeni/core";
import { recordUsageEvent, type Database, type UsageEventProcessingResidency } from "@opengeni/db";
import type { DecisionUsage, DecisionModel } from "@opengeni/decisions";
import { createDocumentEmbedder, type DocumentEmbedder } from "@opengeni/documents";
import {
  createEmbeddingToolRanker,
  sideFeatureRouteRunnable,
  type EmbeddingToolRanker,
  type ToolMeaningRanker,
} from "@opengeni/runtime";
import { runAuxiliaryProviderDispatch } from "../auxiliary-provider-dispatch";
import { configuredDecisionModel } from "./decision-model";

// One ranker per embedding space in this process, so turns share tool vectors;
// each sends through the embedder of the latest turn that used it.
const meaningRankers = new Map<string, EmbeddingToolRanker>();
const latestEmbedders = new Map<string, DocumentEmbedder>();

/**
 * Tool search's meaning ranking over the deployment's document embedder, the
 * one Knowledge uses: none for a local embedder (it carries no meaning), one
 * without a credential, or a route the run may not use. The route is checked
 * again before every search, since it can depend on the run's context.
 */
export function configuredToolMeaningRanker(input: {
  settings: Settings;
  onError?: (error: unknown) => void;
  embedder?: (settings: Settings) => DocumentEmbedder;
}): ToolMeaningRanker | undefined {
  if (input.settings.documentEmbeddingProvider === "deterministic") return undefined;
  const embedder = (input.embedder ?? createDocumentEmbedder)(input.settings);
  if (embedder.local || embedder.available === false) return undefined;
  const target = knowledgeEmbeddingTarget(embedder);
  if (!sideFeatureRouteRunnable(input.settings, target)) return undefined;
  const space = JSON.stringify([embedder.endpoint ?? null, embedder.model, embedder.dimensions]);
  latestEmbedders.set(space, embedder);
  let ranker = meaningRankers.get(space);
  if (!ranker) {
    ranker = createEmbeddingToolRanker(
      {
        space,
        embed: (texts) =>
          runAuxiliaryProviderDispatch(() => latestEmbedders.get(space)!.embedMany(texts)),
      },
      input.onError ? { onError: input.onError } : {},
    );
    meaningRankers.set(space, ranker);
  }
  const shared = ranker;
  return async (search) =>
    sideFeatureRouteRunnable(input.settings, target) ? await shared(search) : undefined;
}

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
      input.settings.decisionModelBaseUrl ||
      input.settings.decisionModelAuth === "deployment_identity"
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
