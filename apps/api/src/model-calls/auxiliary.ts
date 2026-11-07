import {
  decisionModelConfiguration,
  decisionModelRoute,
  decisionModelTarget,
  sideFeatureProcessingResidency,
} from "@opengeni/config";
import { type ModelEmbeddingsResponse } from "@opengeni/contracts";
import {
  ModelCallError,
  knowledgeEmbeddingTarget,
  settingsWithInferenceResidency,
  type AuxiliaryModelCallService,
} from "@opengeni/core";
import { createDocumentEmbedder, type DocumentEmbedder } from "@opengeni/documents";
import {
  configuredDecisionModel,
  assertSideFeatureRoute,
  sideFeatureRouteFetch,
  withInferenceResidency,
} from "@opengeni/runtime/model-call";
import { withAccessGrantSessionRlsContext } from "../access-grant-rls";
import { executeMeteredModelCall, type ModelCallServiceDeps } from "./service";
import { PendingUsageSettlements } from "./pending-usage-settlements";

/** Deployment-owned inference; no chat-model resolution or customer credential fallback. */
export function createAuxiliaryModelCallService(
  deps: ModelCallServiceDeps & {
    fetch?: typeof fetch;
    embedder?: (
      settings: ModelCallServiceDeps["settings"],
      options: { fetch: typeof fetch },
    ) => DocumentEmbedder;
  },
): AuxiliaryModelCallService {
  const pending = deps.pendingUsageSettlements ?? new PendingUsageSettlements();
  const settingsFor = (
    input:
      | Parameters<AuxiliaryModelCallService["decide"]>[0]
      | Parameters<AuxiliaryModelCallService["embed"]>[0],
  ) =>
    withAccessGrantSessionRlsContext(deps, input.grant, () =>
      settingsWithInferenceResidency(deps.db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        settings: deps.settings,
      }),
    );
  return {
    async decide(input) {
      const settings = await settingsFor(input);
      const route = decisionModelRoute(settings);
      if (route) assertSideFeatureRoute(settings, route);
      const config = decisionModelConfiguration(settings);
      if (!config) throw unavailable("decision");
      const target = decisionModelTarget(config);
      assertSideFeatureRoute(settings, target);
      const configured = configuredDecisionModel(settings, deps.fetch ? { fetch: deps.fetch } : {});
      if (!configured) throw unavailable("decision");
      return await executeMeteredModelCall(deps, pending, input, {
        model: configured.id,
        externalPricing: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: true,
        prepare: async () => settings,
        execute: async (_, report) =>
          await withInferenceResidency(settings, async () => {
            const result = await configured.model.decide(
              input.request.input,
              input.request.questions,
              {
                ...(input.signal ? { signal: input.signal } : {}),
                onUsage: (usage) =>
                  report({
                    usage: {
                      usage: {
                        ...(usage.inputTokens !== null ? { inputTokens: usage.inputTokens } : {}),
                        ...(usage.outputTokens !== null
                          ? { outputTokens: usage.outputTokens }
                          : {}),
                      },
                    },
                    processingResidency: sideFeatureProcessingResidency(settings, target),
                    ...(usage.costUsd !== null && usage.costSource !== "unknown"
                      ? { providerCost: { costUsd: usage.costUsd, source: usage.costSource } }
                      : {}),
                  }),
              },
            );
            return {
              id: input.requestId,
              object: "decision" as const,
              model: configured.id,
              ...result,
            };
          }),
      });
    },
    async embed(input) {
      const settings = await settingsFor(input);
      const embedder = (deps.embedder ?? createDocumentEmbedder)(settings, {
        fetch: sideFeatureRouteFetch(
          settings,
          "knowledge.embeddings",
          deps.fetch ?? globalThis.fetch,
        ),
      });
      if (embedder.available === false) throw unavailable("embedding");
      const target = knowledgeEmbeddingTarget(embedder);
      if (!embedder.local) assertSideFeatureRoute(settings, target);
      const usage: ModelEmbeddingsResponse["usage"] = {
        inputTokens: null,
        totalTokens: null,
        requests: 0,
        costUsd: null,
        costSource: "unknown",
      };
      return await executeMeteredModelCall(deps, pending, input, {
        model: embedder.model,
        externalPricing: true,
        chargesOpenGeniCredits: false,
        countsTowardTokenCap: !embedder.local,
        prepare: async () => settings,
        execute: async (_, report) =>
          await withInferenceResidency(settings, async () => {
            const texts =
              typeof input.request.input === "string" ? [input.request.input] : input.request.input;
            const vectors = await embedder.embedMany(texts, {
              ...(input.signal ? { signal: input.signal } : {}),
              onUsage: (batch) => {
                const sum = (current: number | null, next: number | null) =>
                  next === null || (usage.requests > 0 && current === null)
                    ? null
                    : (current ?? 0) + next;
                usage.inputTokens = sum(usage.inputTokens, batch.inputTokens);
                usage.totalTokens = sum(usage.totalTokens, batch.totalTokens);
                usage.requests++;
                report({
                  usage: {
                    usage: {
                      ...(usage.inputTokens !== null ? { inputTokens: usage.inputTokens } : {}),
                      outputTokens: 0,
                      ...(usage.totalTokens !== null ? { totalTokens: usage.totalTokens } : {}),
                    },
                  },
                  processingResidency: sideFeatureProcessingResidency(settings, target),
                });
              },
            });
            if (
              vectors.length !== texts.length ||
              vectors.some(
                (vector) =>
                  vector.length !== embedder.dimensions || vector.some((n) => !Number.isFinite(n)),
              )
            ) {
              throw new Error("Embedding provider returned invalid vectors");
            }
            return {
              id: input.requestId,
              object: "list" as const,
              model: embedder.model,
              dimensions: embedder.dimensions,
              data: vectors.map((embedding, index) => ({
                object: "embedding" as const,
                index,
                embedding,
              })),
              usage,
            };
          }),
      });
    },
  };
}

function unavailable(category: string): ModelCallError {
  return new ModelCallError({
    status: 503,
    type: "service_unavailable",
    code: "unavailable",
    message: `The deployment's ${category} model is not configured.`,
  });
}
