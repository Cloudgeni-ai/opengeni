import {
  decisionModelRoute,
  resolveWebSearchProvider,
  sideFeatureRouteIsEu,
  webSearchEndpointTarget,
  type SideFeatureTarget,
  type Settings,
} from "@opengeni/config";
import {
  INFERENCE_FEATURE_IDS,
  REGION_RESTRICTED,
  type InferenceFeatureAvailability,
  type InferenceFeatureId,
} from "@opengeni/contracts";
import type { DocumentEmbedder } from "@opengeni/documents";
import { knowledgeEmbeddingTarget } from "./side-feature-routes";
import { createSpeechToTextDeployment } from "./transcription-service/deployment";

/** What the deployment runs that settings alone do not describe. */
export type InferenceFeatureSources = {
  /** The deployment's Knowledge embedder (local embedders send nothing). */
  embedder?: Pick<DocumentEmbedder, "local" | "endpoint"> | null;
};

/**
 * The routes this deployment is configured to use for a feature that could
 * be EU, with the endpoints they call. Code-owned routes are never EU, so a
 * feature with only those (media) lists none; where a list includes one it
 * never makes the feature available.
 */
function configuredDeclarableTargets(
  settings: Settings,
  feature: InferenceFeatureId,
  sources: InferenceFeatureSources,
): SideFeatureTarget[] {
  switch (feature) {
    case "web_search": {
      const resolution = resolveWebSearchProvider(settings);
      return resolution.status === "configured"
        ? resolution.config.search.map((endpoint) => webSearchEndpointTarget(endpoint, "search"))
        : [];
    }
    case "realtime_voice":
      return settings.azureLiveEndpoint
        ? [{ route: "realtime_voice.azure_live", endpoint: settings.azureLiveEndpoint }]
        : [];
    case "voice_input":
    case "meeting_transcription":
    case "live_transcription": {
      // Each provider's own route, as the deployment resolves it (the
      // recording Azure Speech account wins over voice input MAI, and so on).
      let deployment: ReturnType<typeof createSpeechToTextDeployment>;
      try {
        deployment = createSpeechToTextDeployment({ settings });
      } catch {
        // A deployment that cannot be built offers no route: not available.
        return [];
      }
      return deployment.order.flatMap((providerId) => {
        if (feature === "live_transcription") {
          const live = deployment.registry
            .get(providerId)
            ?.models.some((spec) => spec.capabilities.live);
          const target = live ? deployment.liveRoute(providerId) : null;
          return target ? [target] : [];
        }
        const target = deployment.route(providerId);
        return target ? [target] : [];
      });
    }
    case "knowledge_embeddings":
      return sources.embedder ? [knowledgeEmbeddingTarget(sources.embedder)] : [];
    case "code_search": {
      const target = decisionModelRoute(settings, true);
      return target ? [target] : [];
    }
    case "image_generation":
    case "video_generation":
      return [];
  }
}

/**
 * Whether EU-only inference leaves this feature a route here: without the EU
 * requirement always; under it only when a route the deployment is actually
 * configured to use, at the endpoint it calls, has an EU residency record
 * (or, for Knowledge, the embedder is local). This is the region answer
 * only; whether the feature is configured at all is reported where it
 * always was.
 */
export function inferenceFeatureRegionAllowed(
  settings: Settings,
  feature: InferenceFeatureId,
  sources: InferenceFeatureSources = {},
): boolean {
  if (settings.requiredModelGeography !== "eu") return true;
  if (feature === "knowledge_embeddings" && sources.embedder?.local === true) return true;
  return configuredDeclarableTargets(settings, feature, sources).some((target) =>
    sideFeatureRouteIsEu(settings, target),
  );
}

/**
 * Every side feature's region availability for settings already narrowed
 * with `settingsWithInferenceResidency`: the one list clients read to show
 * "Not supported in EU".
 */
export function inferenceFeatureAvailability(
  settings: Settings,
  sources: InferenceFeatureSources = {},
): InferenceFeatureAvailability[] {
  return INFERENCE_FEATURE_IDS.map((id) => {
    const available = inferenceFeatureRegionAllowed(settings, id, sources);
    return { id, available, unavailableReason: available ? null : REGION_RESTRICTED };
  });
}
