import {
  decisionModelRoute,
  resolveVoiceInputProviderRegistry,
  resolveWebSearchProvider,
  sideFeatureRouteAllowed,
  sideFeatureRouteIsEu,
  webSearchEndpointTarget,
  type CodeOwnedSideFeatureRouteId,
  type SideFeatureResidencySettings,
  type SideFeatureTarget,
  type Settings,
} from "@opengeni/config";
import {
  INFERENCE_FEATURE_IDS,
  REGION_RESTRICTED,
  REGION_RESTRICTED_MESSAGE,
  type InferenceFeatureAvailability,
  type InferenceFeatureId,
} from "@opengeni/contracts";
import { isWorkspaceEuOnly, type Database } from "@opengeni/db";
import type { DocumentEmbedder } from "@opengeni/documents";

/** What the deployment runs that settings alone do not describe. */
export type InferenceFeatureSources = {
  /** The deployment's Knowledge embedder (local embedders send nothing). */
  embedder?: Pick<DocumentEmbedder, "local" | "endpoint"> | null;
};

/** The route a Knowledge embedder sends texts to, with its endpoint. */
export function knowledgeEmbeddingTarget(
  embedder: Pick<DocumentEmbedder, "endpoint">,
): SideFeatureTarget {
  return { route: "knowledge.embeddings", endpoint: embedder.endpoint };
}

/**
 * The routes this deployment is configured to use for a feature that could
 * be EU, with the endpoints they call. Code-owned routes are never EU, so
 * they are not listed: a feature with only those (media) has none.
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
    case "meeting_transcription": {
      const targets: SideFeatureTarget[] = [];
      for (const config of resolveVoiceInputProviderRegistry(settings)) {
        if (config.kind === "azure-openai") {
          targets.push({ route: "transcription.azure-openai", endpoint: config.endpoint });
        } else if (config.kind === "azure-mai") {
          targets.push({ route: "transcription.azure-speech", endpoint: config.endpoint });
        }
      }
      if (settings.recordingAzureSpeechEndpoint) {
        targets.push({
          route: "transcription.azure-speech",
          endpoint: settings.recordingAzureSpeechEndpoint,
        });
      }
      return targets;
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

/** The unavailable reason for a code-owned route under these settings, or null when it may run. */
export function sideFeatureRouteUnavailableReason(
  settings: SideFeatureResidencySettings,
  route: CodeOwnedSideFeatureRouteId,
): typeof REGION_RESTRICTED_MESSAGE | null {
  return sideFeatureRouteAllowed(settings, route) ? null : REGION_RESTRICTED_MESSAGE;
}

/**
 * Whether a side-feature call for this workspace may use the route, for
 * calls that run outside a turn: the workspace's EU-only setting is read
 * (a failed read throws), and under EU only a route with an EU residency
 * record for the endpoint it calls passes.
 */
export async function sideFeatureAllowedForWorkspace(
  db: Database,
  settings: SideFeatureResidencySettings | undefined,
  scope: { accountId: string; workspaceId: string },
  target: SideFeatureTarget,
  isEuOnly: typeof isWorkspaceEuOnly = isWorkspaceEuOnly,
): Promise<boolean> {
  const euOnly = settings?.requiredModelGeography === "eu" || (await isEuOnly(db, scope));
  if (!euOnly) return true;
  return sideFeatureRouteAllowed({ ...settings, requiredModelGeography: "eu" }, target);
}
