import {
  imageGenerationCreditCostMicros,
  sideFeatureProcessingResidency,
  type Settings,
} from "@opengeni/config";
import type {
  Database,
  ImageGenerationCreditError,
  ImageGenerationCreditRefusalCode,
} from "@opengeni/db";
import { readJsonBase64Field, readResponseTextBounded, type FetchLike } from "@opengeni/network";
import type { Observability } from "@opengeni/observability";
import {
  classifyProviderQuotaError,
  PROVIDER_QUOTA_RETRY_HINT_MS,
  providerMessageRetryHintMs,
} from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";
import { type GeneratedImageOutput, type GeneratedImageReceipt } from "./generated-images";
import {
  executeImageGenerationOperation,
  imageProviderBindingHash,
  type ImageGenerationOperationPorts,
} from "./image-generation-operation";
import type { ResolvedImageGenerationReference } from "./image-generation-references";

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
    /** The provider's own bounded reason, without the adapter prefix. */
    readonly providerMessage: string | null = null,
    /** The provider's retry hint, read by the quota classifier and the busy text. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "GatewayImageApiError";
  }
}

/**
 * A Gateway response that refused the request outright (a 4xx other than a
 * request timeout): no image was made and no paid provider work happened, so
 * the operation returns to `prepared` and holds no credits.
 */
export function isGatewayImageRequestRefused(error: unknown): error is GatewayImageApiError {
  return (
    error instanceof GatewayImageApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408
  );
}

export type ImageGenerationProviderFailureCode =
  | "image_provider_unavailable"
  | "image_provider_busy"
  | "image_request_refused";

export type ImageGenerationProviderFailedResult = Readonly<{
  isError: true;
  /** `rejected` when the provider refused outright; `failed` when its outcome is unknown. */
  status: "rejected" | "failed";
  code: ImageGenerationProviderFailureCode;
  message: string;
  content: readonly [{ readonly type: "text"; readonly text: string }];
}>;

const REQUEST_REFUSED_STATUSES = new Set([400, 413, 415, 422]);
const PROVIDER_REASON_MAX_CHARS = 300;
const UNAVAILABLE_TEXT = "Image generation isn't available right now, so no image was made.";
const UNKNOWN_OUTCOME_TEXT =
  "Image generation isn't available right now, and the image may not have been made.";
const REFUSED_TEXT = "The image provider refused this request, so no image was made.";

/**
 * Model-visible result for an image the provider did not make. The tool's own
 * provider failing (out of credit, rate limited, down) is not the chat
 * model's failure, so the turn continues and the agent can tell the person.
 * Provider account details and links never reach the agent; only a request
 * refusal (for example a content policy) carries the provider's reason, so
 * the agent can change the request.
 */
export function imageGenerationProviderFailedResult(
  error: GatewayImageApiError,
): ImageGenerationProviderFailedResult {
  const refused = isGatewayImageRequestRefused(error);
  const status = refused ? "rejected" : "failed";
  const { code, text } = REQUEST_REFUSED_STATUSES.has(error.status)
    ? requestRefused(modelVisibleProviderReason(error.providerMessage))
    : isShortRateLimit(error)
      ? {
          code: "image_provider_busy" as const,
          text: `Image generation is busy right now, so no image was made. ${retryAdvice(error)}`,
        }
      : {
          code: "image_provider_unavailable" as const,
          // A 408 or 5xx may have reached paid work; never claim it didn't.
          text: refused ? UNAVAILABLE_TEXT : UNKNOWN_OUTCOME_TEXT,
        };
  return { isError: true, status, code, message: text, content: [{ type: "text", text }] };
}

function requestRefused(reason: string | null) {
  return {
    code: "image_request_refused" as const,
    text:
      reason === null
        ? REFUSED_TEXT
        : `The image provider refused this request, so no image was made: ${reason}`,
  };
}

/**
 * A 429 that clears soon. A quota, or any stated wait beyond 15 minutes, is
 * "isn't available right now" rather than "busy".
 */
function isShortRateLimit(error: GatewayImageApiError): boolean {
  if (error.status !== 429 || classifyProviderQuotaError(error)) return false;
  const hintMs = retryHintMs(error);
  return hintMs === null || hintMs <= PROVIDER_QUOTA_RETRY_HINT_MS;
}

function retryHintMs(error: GatewayImageApiError): number | null {
  const hintMs =
    error.retryAfterSeconds !== null
      ? error.retryAfterSeconds * 1_000
      : providerMessageRetryHintMs(error.providerMessage ?? "");
  return hintMs !== null && hintMs > 0 ? hintMs : null;
}

function retryAdvice(error: GatewayImageApiError): string {
  const hintMs = retryHintMs(error);
  if (hintMs === null) return "Try again in a minute.";
  const seconds = Math.ceil(hintMs / 1_000);
  if (seconds <= 90)
    return seconds === 1 ? "Try again in a second." : `Try again in ${seconds} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return `Try again in ${minutes} minutes.`;
}

/** Tell the operator, never the person, that the image provider failed. */
export function reportImageGenerationProviderFailure(
  observability: Pick<Observability, "incrementCounter" | "warn">,
  input: Readonly<{
    error: GatewayImageApiError;
    result: ImageGenerationProviderFailedResult;
    modelId: string;
    funding: "opengeni_credits" | "workspace_gateway";
  }>,
): void {
  const quota = classifyProviderQuotaError(input.error);
  observability.incrementCounter({
    name: "opengeni_image_generation_provider_failures_total",
    help: "Image generations the image provider did not make, by funding and bounded reason.",
    labels: {
      provider: GATEWAY_IMAGE_PROVIDER_ID,
      funding: input.funding,
      code: input.result.code,
    },
  });
  observability.warn("image generation provider failed", {
    provider: GATEWAY_IMAGE_PROVIDER_ID,
    funding: input.funding,
    modelId: input.modelId,
    status: input.error.status,
    code: input.result.code,
    ...(quota ? { quotaScope: quota.scope } : {}),
    detail: input.error.message,
  });
}

function modelVisibleProviderReason(message: string | null): string | null {
  // Drop every sentence that carries a link or a bare web address (billing,
  // docs, consoles); with nothing left, the agent gets the plain refusal.
  const reason = message
    ?.replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !WEB_ADDRESS.test(sentence))
    .join(" ")
    .trim()
    .slice(0, PROVIDER_REASON_MAX_CHARS)
    .trim();
  return reason ? reason : null;
}

// A scheme or www. prefix, a host followed by a path (`example.com/billing`),
// or a bare host on a common top-level domain (`example.com`).
const WEB_ADDRESS =
  /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|app|dev|sh|co|cloud|me|so|xyz)\b/i;

/** The deployment's Gateway image route, funded by Opengeni credits. */
export type ManagedImageGenerationCredential = Readonly<{
  apiKey: string;
  modelId: string;
  /** Zero when the deployment does not bill or meter Opengeni credits. */
  pricedCostMicros: number;
}>;

/**
 * The deployment's Gateway key pays the provider and the workspace pays
 * Opengeni credits at the frozen product price of the configured image model,
 * like managed video. Operators turn it off with
 * `imageGenerationOpengeniCreditsEnabled`; a billed deployment never offers a
 * model it cannot price. The caller withholds it when the workspace turns
 * credits off.
 */
export function managedImageGenerationCredential(
  settings: Pick<
    Settings,
    | "vercelAiGatewayApiKey"
    | "imageGenerationModel"
    | "imageGenerationOpengeniCreditsEnabled"
    | "imageGenerationCreditMicrosPerImage"
    | "billingMode"
    | "usageLimitsMode"
  >,
): ManagedImageGenerationCredential | null {
  if (!settings.imageGenerationOpengeniCreditsEnabled) return null;
  const apiKey = settings.vercelAiGatewayApiKey?.trim();
  if (!apiKey) return null;
  const debitsCredits = settings.billingMode === "stripe" || settings.usageLimitsMode === "managed";
  const pricedCostMicros = debitsCredits ? imageGenerationCreditCostMicros(settings) : 0;
  if (pricedCostMicros === null) return null;
  return Object.freeze({ apiKey, modelId: settings.imageGenerationModel, pricedCostMicros });
}

export type ImageGenerationCreditRefusedResult = Readonly<{
  isError: true;
  status: "rejected";
  code: ImageGenerationCreditRefusalCode;
  message: string;
  content: readonly [{ readonly type: "text"; readonly text: string }];
}>;

/**
 * Model-visible result for an image Opengeni credits refused before any
 * provider request, so the agent can tell the person why in plain words.
 */
export function imageGenerationCreditRefusedResult(
  error: ImageGenerationCreditError,
): ImageGenerationCreditRefusedResult {
  return {
    isError: true,
    status: "rejected",
    code: error.code,
    message: error.message,
    content: [{ type: "text", text: `This image can't be paid for: ${error.message}.` }],
  };
}

export async function executeGatewayImageGeneration(
  input: {
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
    references?: readonly ResolvedImageGenerationReference[];
    toolCallId: string;
    /** Opengeni-credit price; set only for the managed credential. */
    pricedCostMicros?: number;
    /** The turn's canonical chat model whose plan and trial grants may pay. */
    creditUsageModelId?: string;
    abortSignal?: AbortSignal;
    fetch?: FetchLike;
  },
  ports?: ImageGenerationOperationPorts,
): Promise<GeneratedImageReceipt> {
  const providerBindingHash = imageProviderBindingHash(GATEWAY_IMAGE_PROVIDER_ID, input.apiKey);
  return await executeImageGenerationOperation(
    {
      ...input,
      providerId: GATEWAY_IMAGE_PROVIDER_ID,
      providerBindingHash,
      ...(input.references ? { referenceDigests: input.references } : {}),
      // A code-owned rule: the Gateway can process in any region.
      processingResidency: sideFeatureProcessingResidency({}, "image_generation.ai_gateway"),
      isProviderDispatchRejected: isGatewayImageRequestRefused,
      generate: async () =>
        await generateGatewayImage({
          apiKey: input.apiKey,
          modelId: input.modelId,
          prompt: input.prompt,
          ...(input.references ? { references: input.references } : {}),
          toolCallId: input.toolCallId,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          ...(input.fetch ? { fetch: input.fetch } : {}),
        }),
    },
    ports,
  );
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
  references?: readonly ResolvedImageGenerationReference[];
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
    body: JSON.stringify({
      prompt: input.prompt,
      n: 1,
      ...(input.references?.length
        ? {
            files: input.references.map((reference) => ({
              type: "file",
              mediaType: reference.mediaType,
              data: Buffer.from(reference.bytes).toString("base64"),
            })),
          }
        : {}),
    }),
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
  });
  if (!response.ok) {
    const detail = await readResponseTextBounded(
      response,
      GATEWAY_IMAGE_ERROR_MAX_BYTES,
      "AI Gateway image error",
      input.abortSignal ? { signal: input.abortSignal } : {},
    ).catch(() => "");
    const providerMessage = detail ? boundedErrorMessage(detail) : null;
    throw new GatewayImageApiError(
      response.status,
      providerMessage
        ? `AI Gateway image generation failed (${response.status}): ${providerMessage}`
        : `AI Gateway image generation failed (${response.status})`,
      providerMessage,
      headerRetryAfterSeconds(response.headers),
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

/** `retry-after-ms`, or `retry-after` as seconds or an HTTP date, in seconds. */
function headerRetryAfterSeconds(headers: Headers, nowMs = Date.now()): number | null {
  const millis = Number(headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(millis) && millis > 0) return millis / 1_000;
  const header = headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const date = Date.parse(header);
  return Number.isFinite(date) && date > nowMs ? (date - nowMs) / 1_000 : null;
}
