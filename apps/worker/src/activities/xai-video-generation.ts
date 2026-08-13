import { GROK_IMAGINE_VIDEO_1_5_MODEL_ID } from "@opengeni/contracts";
import type { CanonicalVideoGenerationRequest } from "@opengeni/core";
import {
  getXaiSubscriptionVideoStatus,
  startXaiSubscriptionVideoWithBody,
  XAI_VIDEO_MODEL,
  type XaiFetch,
  type XaiSubscriptionRequestContext,
  type XaiVideoStatus,
} from "@opengeni/xai-subscription";
import type { GatewayVideoReferenceGrant } from "./gateway-video-generation";

export function buildXaiVideoStartBody(
  request: CanonicalVideoGenerationRequest,
  referenceGrants: readonly GatewayVideoReferenceGrant[],
): Record<string, unknown> {
  if (request.modelId !== GROK_IMAGINE_VIDEO_1_5_MODEL_ID) {
    throw new Error("The selected video model is not a SuperGrok video model");
  }
  if (request.sourceMode === "first_and_last_frames" || request.sourceMode === "video_reference") {
    throw new Error(`Grok Imagine Video does not support ${request.sourceMode}`);
  }
  if (referenceGrants.length !== request.references.length) {
    throw new Error("Video reference grants do not match the sealed request");
  }
  const reference = referenceGrants[0];
  return {
    model: XAI_VIDEO_MODEL,
    prompt: request.prompt,
    duration: request.durationSeconds,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    ...(request.sourceMode === "first_frame" && reference
      ? { image: { url: reference.url } }
      : request.sourceMode === "image_reference" && reference
        ? { reference_images: [{ url: reference.url }] }
        : {}),
  };
}

export async function startXaiVideoGeneration(input: {
  body: Record<string, unknown>;
  sessionId: string | null;
  auth: Pick<XaiSubscriptionRequestContext, "getToken" | "refresh">;
  fetch?: XaiFetch;
}): Promise<{ providerJobId: string }> {
  return await startXaiSubscriptionVideoWithBody({
    body: input.body,
    getToken: input.auth.getToken,
    refresh: input.auth.refresh,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

export async function getXaiVideoGenerationStatus(input: {
  providerJobId: string;
  sessionId: string | null;
  auth: Pick<XaiSubscriptionRequestContext, "getToken" | "refresh">;
  fetch?: XaiFetch;
}): Promise<XaiVideoStatus> {
  return await getXaiSubscriptionVideoStatus({
    providerJobId: input.providerJobId,
    getToken: input.auth.getToken,
    refresh: input.auth.refresh,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}
