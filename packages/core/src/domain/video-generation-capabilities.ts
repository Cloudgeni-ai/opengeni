import {
  SEEDANCE_2_5_MODEL_ID,
  VideoGenerationCapabilities,
  VideoGenerationPolicy,
  type VideoGenerationModelCapability,
  type VideoGenerationPolicy as VideoGenerationPolicyType,
} from "@opengeni/contracts";
import { videoGenerationCapabilityRevision } from "./video-generation";

/** Reviewed executable catalog. Dynamic workspace policy never mutates tool schemas. */
export const VIDEO_GENERATION_MODEL_CATALOG: readonly VideoGenerationModelCapability[] =
  Object.freeze([
    Object.freeze({
      modelId: SEEDANCE_2_5_MODEL_ID,
      label: "Seedance 2.5",
      providerLabel: "Vercel AI Gateway",
      sourceModes: Object.freeze([
        "text",
        "first_frame",
        "first_and_last_frames",
        "image_reference",
        "video_reference",
      ]),
      resolutions: Object.freeze(["480p", "720p"]),
      aspectRatios: Object.freeze(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]),
      duration: Object.freeze({ minSeconds: 4, maxSeconds: 30, stepSeconds: 1 }),
      supportsAudio: true,
    }) as VideoGenerationModelCapability,
  ]);

export function defaultVideoGenerationPolicy(): VideoGenerationPolicyType {
  return VideoGenerationPolicy.parse({
    schemaVersion: 1,
    revision: 0,
    enabledModelIds: [],
    defaultModelId: null,
  });
}

export function videoGenerationCapabilitiesForPolicy(input: {
  policy: VideoGenerationPolicyType;
  credentialVersion: number;
}): VideoGenerationCapabilities {
  const policy = VideoGenerationPolicy.parse(input.policy);
  const enabled = new Set(policy.enabledModelIds);
  const models = VIDEO_GENERATION_MODEL_CATALOG.filter((model) => enabled.has(model.modelId));
  if (models.length === 0 || policy.defaultModelId === null) {
    throw new Error("Video generation is disabled for this workspace");
  }
  return VideoGenerationCapabilities.parse({
    schemaVersion: 1,
    capabilityRevision: videoGenerationCapabilityRevision({
      policyRevision: policy.revision,
      credentialVersion: input.credentialVersion,
      modelIds: models.map((model) => model.modelId),
    }),
    defaultModelId: policy.defaultModelId,
    models,
  });
}

export function assertKnownVideoGenerationModelIds(modelIds: readonly string[]): void {
  const known = new Set(VIDEO_GENERATION_MODEL_CATALOG.map((model) => model.modelId));
  for (const modelId of modelIds) {
    if (!known.has(modelId)) throw new Error(`Unknown video generation model: ${modelId}`);
  }
}
