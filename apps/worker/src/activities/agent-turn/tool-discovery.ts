import type { Settings } from "@opengeni/config";
import { knowledgeEmbeddingTarget } from "@opengeni/core";
import { recordUsageEvent, type Database, type UsageEventProcessingResidency } from "@opengeni/db";
import { DecisionError, type DecisionUsage, type DecisionModel } from "@opengeni/decisions";
import { createDocumentEmbedder, type DocumentEmbedder } from "@opengeni/documents";
import type { Observability } from "@opengeni/observability";
import {
  createEmbeddingToolRanker,
  sideFeatureRouteRunnable,
  type EmbeddingToolRanker,
  type ToolMeaningRanker,
  type ToolSelectionFailure,
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
  /**
   * Each decision request becomes a span and a duration sample. A tool
   * search decides before its result exists, inside the model step that
   * asked for it, so without this the wait shows only as an unexplained gap.
   */
  observability?: Pick<Observability, "startSpan" | "observeHistogram">;
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
      const started = performance.now();
      const span = input.observability?.startSpan(TOOL_DECISION_SPAN, {
        provider: route.id,
        questions: Object.keys(questions).length,
      });
      let outcome: ToolDecisionOutcome = "failed";
      let inputTokens: number | null = null;
      let failure: unknown;
      try {
        const result = await runAuxiliaryProviderDispatch(() =>
          route.model.decide(state, questions, {
            ...options,
            onUsage: async (usage) => {
              inputTokens = usage.inputTokens;
              await input.recordUsage(route.id, usage, requestId);
              await options.onUsage?.(usage);
            },
          }),
        );
        outcome = "completed";
        return result;
      } catch (error) {
        // A hedged request that lost the race, or a deadline, aborts this one.
        outcome = options.signal?.aborted ? "cancelled" : "failed";
        failure = error;
        throw error;
      } finally {
        recordToolDecision(input.observability, span, {
          outcome,
          inputTokens,
          failure,
          durationSeconds: (performance.now() - started) / 1_000,
        });
      }
    },
  };
}

type ToolDecisionOutcome = "completed" | "cancelled" | "failed";

export const TOOL_DECISION_SPAN = "worker.tool_search.decision";
export const TOOL_DECISION_DURATION_METRIC = {
  name: "opengeni_tool_search_decision_duration_seconds",
  help: "Tool search decision-model requests by outcome; a hedged request is its own sample.",
} as const;

function recordToolDecision(
  observability: Pick<Observability, "startSpan" | "observeHistogram"> | undefined,
  span: ReturnType<Observability["startSpan"]> | undefined,
  input: {
    outcome: ToolDecisionOutcome;
    inputTokens: number | null;
    failure: unknown;
    durationSeconds: number;
  },
): void {
  // Telemetry never changes the decision.
  try {
    span?.end({
      attributes: {
        outcome: input.outcome,
        ...(input.inputTokens === null ? {} : { input_tokens: input.inputTokens }),
      },
      ...(input.outcome === "failed" ? { error: input.failure } : {}),
    });
    observability?.observeHistogram({
      ...TOOL_DECISION_DURATION_METRIC,
      labels: { outcome: input.outcome },
      value: input.durationSeconds,
    });
  } catch {
    // Best effort.
  }
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

/**
 * Why a tool search's selection fell back to keywords, as a bounded metric
 * label: its own deadline, a rate limit, another provider reply, a dropped
 * request, or an answer the runtime could not use.
 */
export function toolSelectionFallbackReason(
  failure: ToolSelectionFailure,
): "deadline" | "rate_limited" | "provider_error" | "request_failed" | "invalid_answer" {
  if (failure.timedOut) return "deadline";
  const { error } = failure;
  if (error instanceof DecisionError) {
    if (error.status === 429) return "rate_limited";
    if (error.status !== undefined) return "provider_error";
    if (error.code === "request_failed") return "request_failed";
  }
  return "invalid_answer";
}

export const TOOL_SELECTION_FALLBACK_METRIC = {
  name: "opengeni_tool_search_selection_fallbacks_total",
  help: "Tool searches whose decision-model selection fell back to keywords, by reason.",
} as const;
