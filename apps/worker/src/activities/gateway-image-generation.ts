import type { Database } from "@opengeni/db";
import { readJsonBase64Field, readResponseTextBounded, type FetchLike } from "@opengeni/network";
import type { ObjectStorage } from "@opengeni/storage";
import { type GeneratedImageOutput, type GeneratedImageReceipt } from "./generated-images";
import {
  executeImageGenerationOperation,
  imageProviderBindingHash,
} from "./image-generation-operation";

const GATEWAY_IMAGE_PROVIDER_ID = "vercel-ai-gateway";
const GATEWAY_IMAGE_URL = "https://ai-gateway.vercel.sh/v3/ai/image-model";
const GATEWAY_PROTOCOL_VERSION = "0.0.1";
const GATEWAY_IMAGE_SPECIFICATION_VERSION = "3";
const GATEWAY_IMAGE_RESPONSE_MAX_BYTES = 90 * 1024 * 1024;
const GATEWAY_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const GATEWAY_IMAGE_ERROR_MAX_BYTES = 64 * 1024;

export class GatewayImageApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayImageApiError";
  }
}

export async function executeGatewayImageGeneration(input: {
  db: Database;
  objectStorage: ObjectStorage | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  toolCallId: string;
  abortSignal?: AbortSignal;
}): Promise<GeneratedImageReceipt> {
  const providerBindingHash = imageProviderBindingHash(GATEWAY_IMAGE_PROVIDER_ID, input.apiKey);
  return await executeImageGenerationOperation({
    ...input,
    providerId: GATEWAY_IMAGE_PROVIDER_ID,
    providerBindingHash,
    generate: async () =>
      await generateGatewayImage({
        apiKey: input.apiKey,
        modelId: input.modelId,
        prompt: input.prompt,
        toolCallId: input.toolCallId,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      }),
  });
}

/**
 * One explicit Vercel AI Gateway image-protocol adapter. The caller owns durable
 * operation admission; this function never retries an outcome-ambiguous paid
 * request. The response is decoded directly from its JSON stream so neither
 * the complete envelope nor its multi-megabyte base64 string enters memory.
 */
export async function generateGatewayImage(input: {
  apiKey: string;
  modelId: string;
  prompt: string;
  toolCallId: string;
  abortSignal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<GeneratedImageOutput> {
  if (!input.apiKey.trim()) throw new Error("AI Gateway image generation credential is empty");
  if (!input.modelId.trim()) throw new Error("AI Gateway image generation model is empty");
  const response = await (input.fetch ?? globalThis.fetch)(GATEWAY_IMAGE_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      accept: "application/json",
      "content-type": "application/json",
      "ai-gateway-auth-method": "api-key",
      "ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
      "ai-image-model-specification-version": GATEWAY_IMAGE_SPECIFICATION_VERSION,
      "ai-model-id": input.modelId,
      "user-agent": "opengeni/image-generation",
    },
    body: JSON.stringify({ prompt: input.prompt, n: 1 }),
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
  });
  if (!response.ok) {
    const detail = await readResponseTextBounded(
      response,
      GATEWAY_IMAGE_ERROR_MAX_BYTES,
      "AI Gateway image error",
      input.abortSignal ? { signal: input.abortSignal } : {},
    ).catch(() => "");
    throw new GatewayImageApiError(
      response.status,
      detail
        ? `AI Gateway image generation failed (${response.status}): ${boundedErrorMessage(detail)}`
        : `AI Gateway image generation failed (${response.status})`,
    );
  }
  const bytes = await readJsonBase64Field(response, {
    fieldName: "images",
    shape: "first_array_string",
    maxResponseBytes: GATEWAY_IMAGE_RESPONSE_MAX_BYTES,
    maxDecodedBytes: GATEWAY_IMAGE_MAX_BYTES,
    label: "AI Gateway image generation",
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
  });
  return {
    toolCallId: input.toolCallId,
    providerItemId: null,
    bytes,
  };
}

function boundedErrorMessage(body: string): string {
  let message = body;
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const candidate = value.error?.message ?? value.message;
    if (typeof candidate === "string") message = candidate;
  } catch {
    // Preserve a bounded non-JSON provider diagnostic.
  }
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000);
}
