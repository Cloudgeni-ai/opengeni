import type { CanonicalVideoGenerationRequest } from "@opengeni/core";
import { readResponseTextBounded, type FetchLike } from "@opengeni/network";

export const GATEWAY_VIDEO_PROVIDER_ID = "vercel-ai-gateway" as const;
export const GATEWAY_VIDEO_START_URL =
  "https://ai-gateway.vercel.sh/v4/ai/video-model/start" as const;
export const GATEWAY_VIDEO_STATUS_URL =
  "https://ai-gateway.vercel.sh/v4/ai/video-model/status" as const;

const PROTOCOL_VERSION = "0.0.1";
const VIDEO_SPECIFICATION_VERSION = "4";
const RESPONSE_MAX_BYTES = 1024 * 1024;
const ERROR_MAX_BYTES = 64 * 1024;

export type GatewayVideoReferenceGrant = Readonly<{
  role: "first_frame" | "last_frame" | "image_reference" | "video_reference";
  url: string;
  mediaType: string;
}>;

export type GatewayVideoStartResult = Readonly<{ providerJobId: string }>;
export type GatewayVideoStatusResult =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; outputUrl: string; mediaType: string }>
  | Readonly<{ status: "error"; publicReason: string }>;

export class GatewayVideoApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "GatewayVideoApiError";
  }
}

export async function startGatewayVideoGeneration(input: {
  apiKey: string;
  request: CanonicalVideoGenerationRequest;
  idempotencyKey: string;
  referenceGrants: readonly GatewayVideoReferenceGrant[];
  signal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<GatewayVideoStartResult> {
  return await startGatewayVideoGenerationWithBody({
    apiKey: input.apiKey,
    modelId: input.request.modelId,
    body: buildGatewayVideoStartBody(input.request, input.referenceGrants),
    idempotencyKey: input.idempotencyKey,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

/** Replay entrypoint for the encrypted, byte-stable provider request. */
export async function startGatewayVideoGenerationWithBody(input: {
  apiKey: string;
  modelId: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
  signal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<GatewayVideoStartResult> {
  requireSecret(input.apiKey);
  requireIdempotencyKey(input.idempotencyKey);
  const response = await gatewayFetch({
    url: GATEWAY_VIDEO_START_URL,
    apiKey: input.apiKey,
    modelId: input.modelId,
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const parsed = await readGatewayJson(response, "AI Gateway video start", input.signal);
  const operation = record(parsed.operation);
  const providerJobId = stringValue(operation?.gatewayJobId);
  if (!providerJobId || providerJobId.length > 1_024) {
    throw new GatewayVideoApiError(null, true, "AI Gateway video start response is malformed");
  }
  return Object.freeze({ providerJobId });
}

export async function getGatewayVideoGenerationStatus(input: {
  apiKey: string;
  modelId: string;
  providerJobId: string;
  signal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<GatewayVideoStatusResult> {
  requireSecret(input.apiKey);
  if (!input.providerJobId.trim() || input.providerJobId.length > 1_024) {
    throw new Error("AI Gateway video job identity is invalid");
  }
  const response = await gatewayFetch({
    url: GATEWAY_VIDEO_STATUS_URL,
    apiKey: input.apiKey,
    modelId: input.modelId,
    body: { operation: { gatewayJobId: input.providerJobId } },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const parsed = await readGatewayJson(response, "AI Gateway video status", input.signal);
  const status = stringValue(parsed.status);
  if (status === "pending" || status === "queued" || status === "running") {
    return Object.freeze({ status: "pending" });
  }
  if (status === "error" || status === "cancelled") {
    return Object.freeze({
      status: "error",
      publicReason: publicProviderReason(parsed.error, status === "cancelled"),
    });
  }
  if (status !== "completed" || !Array.isArray(parsed.videos) || parsed.videos.length !== 1) {
    throw new GatewayVideoApiError(null, true, "AI Gateway video status response is malformed");
  }
  const video = record(parsed.videos[0]);
  const outputUrl = video?.type === "url" ? stringValue(video.url) : null;
  const mediaType = stringValue(video?.mediaType);
  if (!outputUrl || !mediaType || outputUrl.length > 8_192 || mediaType.length > 128) {
    throw new GatewayVideoApiError(null, false, "AI Gateway returned an unsupported video result");
  }
  return Object.freeze({ status: "completed", outputUrl, mediaType });
}

export function buildGatewayVideoStartBody(
  request: CanonicalVideoGenerationRequest,
  referenceGrants: readonly GatewayVideoReferenceGrant[],
): Record<string, unknown> {
  const expectedRoles = request.references.map((reference) => reference.role);
  if (
    referenceGrants.length !== expectedRoles.length ||
    referenceGrants.some((grant, index) => grant.role !== expectedRoles[index])
  ) {
    throw new Error("Video reference grants do not match the sealed request");
  }
  const files = referenceGrants.map((grant) => ({
    role: grant.role,
    file: { type: "url" as const, url: requireHttps(grant.url), mediaType: grant.mediaType },
  }));
  return {
    prompt: request.prompt,
    n: 1,
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    duration: request.durationSeconds,
    fps: 24,
    generateAudio: request.generateAudio,
    providerOptions: {},
    ...(request.sourceMode === "first_frame" || request.sourceMode === "first_and_last_frames"
      ? {
          frameImages: files.map(({ role, file }) => ({
            frameType: role,
            image: file,
          })),
        }
      : request.sourceMode === "image_reference" || request.sourceMode === "video_reference"
        ? { inputReferences: files.map(({ file }) => file) }
        : {}),
  };
}

async function gatewayFetch(input: {
  url: string;
  apiKey: string;
  modelId: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  fetch?: FetchLike;
}): Promise<Response> {
  const timeout = AbortSignal.timeout(60_000);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(input.url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "ai-gateway-auth-method": "api-key",
        "ai-gateway-protocol-version": PROTOCOL_VERSION,
        "ai-video-model-specification-version": VIDEO_SPECIFICATION_VERSION,
        "ai-model-id": input.modelId,
        "user-agent": "opengeni/video-generation",
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify(input.body),
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new GatewayVideoApiError(
      null,
      true,
      error instanceof Error ? error.message : "AI Gateway video request failed",
    );
  }
  if (response.ok) return response;
  const detail = await readResponseTextBounded(
    response,
    ERROR_MAX_BYTES,
    "AI Gateway video error",
    {
      signal,
    },
  ).catch(() => "");
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw new GatewayVideoApiError(
    response.status,
    retryable,
    detail
      ? `AI Gateway video request failed (${response.status}): ${boundedError(detail)}`
      : `AI Gateway video request failed (${response.status})`,
  );
}

async function readGatewayJson(
  response: Response,
  label: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const text = await readResponseTextBounded(response, RESPONSE_MAX_BYTES, label, {
    ...(signal ? { signal } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewayVideoApiError(null, true, `${label} response is not JSON`);
  }
  const value = record(parsed);
  if (!value) throw new GatewayVideoApiError(null, true, `${label} response is malformed`);
  return value;
}

function requireSecret(value: string): void {
  if (!value.trim()) throw new Error("AI Gateway video generation credential is empty");
}

function requireIdempotencyKey(value: string): void {
  if (!/^ogvid_[0-9a-f]{48}$/u.test(value)) {
    throw new Error("AI Gateway video idempotency key is invalid");
  }
}

function requireHttps(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Video reference grant must be an HTTPS bearer URL");
  }
  return url.toString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function boundedError(value: string): string {
  let message = value;
  try {
    const parsed = record(JSON.parse(value));
    const error = record(parsed?.error);
    message = stringValue(error?.message) ?? stringValue(parsed?.message) ?? value;
  } catch {
    // Preserve the already-bounded non-JSON diagnostic.
  }
  return message.replace(/\s+/gu, " ").trim().slice(0, 1_000);
}

function publicProviderReason(error: unknown, cancelled: boolean): string {
  if (cancelled) return "The video provider cancelled the generation.";
  const message =
    typeof error === "string"
      ? error
      : (stringValue(record(error)?.message) ??
        "The video provider could not complete the generation.");
  return message.replace(/\s+/gu, " ").trim().slice(0, 1_000);
}
