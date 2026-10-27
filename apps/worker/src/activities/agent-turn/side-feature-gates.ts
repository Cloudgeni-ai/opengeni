import {
  decisionModelRoute,
  sideFeatureProcessingResidency,
  type DecisionModelSettings,
  type SideFeatureProcessingResidency,
  type SideFeatureResidencySettings,
  type CodeOwnedSideFeatureRouteId,
  type Settings,
} from "@opengeni/config";
import {
  assertSideFeatureRoute,
  sideFeatureRouteRunnable,
  type BuildAgentOptions,
} from "@opengeni/runtime";

/**
 * EU-only gates for the turn's media tools. Under EU a media tool is offered
 * only when its route's residency record is EU; otherwise the agent never
 * sees it. Each execution checks again before any byte leaves, against the
 * turn's settings and the residency context it runs in (a nested EU or
 * unresolved context refuses). A workspace setting changed mid-turn applies
 * from the next turn. No media route has an EU record today, so these tools
 * are off in EU-only workspaces.
 */

/** The route an image tool for this turn would use. */
export function imageGenerationRoute(input: {
  nativeHosted: boolean;
  providerKind: string | undefined;
}): CodeOwnedSideFeatureRouteId {
  if (input.nativeHosted) return "image_generation.openai_hosted";
  if (input.providerKind === "codex-subscription") return "image_generation.codex_subscription";
  if (input.providerKind === "xai-subscription") return "image_generation.supergrok_subscription";
  return "image_generation.ai_gateway";
}

/** The route a video tool funded this way would use. */
export function videoGenerationRoute(
  fundingSource: string | null | undefined,
): CodeOwnedSideFeatureRouteId {
  return fundingSource === "supergrok_subscription"
    ? "video_generation.supergrok_subscription"
    : "video_generation.ai_gateway";
}

export function gateImageGenerationOption(
  settings: SideFeatureResidencySettings,
  route: CodeOwnedSideFeatureRouteId,
  option: Pick<BuildAgentOptions, "imageGeneration">,
): Pick<BuildAgentOptions, "imageGeneration"> {
  const imageGeneration = option.imageGeneration;
  if (!imageGeneration) return option;
  if (!sideFeatureRouteRunnable(settings, route)) return {};
  if (imageGeneration.kind !== "provider_adapter") return option;
  return {
    imageGeneration: {
      kind: "provider_adapter",
      execute: async (input, context) => {
        assertSideFeatureRoute(settings, route, "image_generation");
        return await imageGeneration.execute(input, context);
      },
    },
  };
}

export function gateVideoGenerationOption(
  settings: SideFeatureResidencySettings,
  route: CodeOwnedSideFeatureRouteId,
  option: Pick<BuildAgentOptions, "videoGeneration">,
): Pick<BuildAgentOptions, "videoGeneration"> {
  const videoGeneration = option.videoGeneration;
  if (!videoGeneration) return option;
  if (!sideFeatureRouteRunnable(settings, route)) return {};
  return {
    videoGeneration: {
      capabilities: videoGeneration.capabilities,
      execute: async (input, context) => {
        assertSideFeatureRoute(settings, route, "video_generation");
        return await videoGeneration.execute(input, context);
      },
    },
  };
}

/** Where the deployment's decision model processes calls, for their usage events. */
export function decisionModelProcessingResidency(
  settings: DecisionModelSettings &
    Partial<Pick<Settings, "jevApiKey" | "jevModel" | "jevBaseUrl">>,
  allowLegacyCodeSearch = false,
): SideFeatureProcessingResidency | null {
  const route = decisionModelRoute(settings, allowLegacyCodeSearch);
  return route ? sideFeatureProcessingResidency(settings, route) : null;
}
