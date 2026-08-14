import { pinnedFetch, readJsonBase64Field, readResponseTextBounded } from "@opengeni/network";

import {
  XAI_CLIENT_VERSION,
  XAI_IMAGE_MODEL,
  XAI_IMAGE_REQUEST_TIMEOUT_MS,
  XAI_PUBLIC_API_BASE_URL,
} from "./constants";
import { XaiSubscriptionError } from "./errors";
import type { XaiFetchLike } from "./fetch";
import type { XaiSubscriptionTokenSnapshot } from "./request-context";

const XAI_IMAGE_RESPONSE_MAX_BYTES = 90 * 1024 * 1024;
const XAI_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const XAI_IMAGE_ERROR_MAX_BYTES = 64 * 1024;

export type XaiImageReference = Readonly<{
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}>;

const defaultImageFetch: XaiFetchLike = async (input, init) =>
  await pinnedFetch(
    input,
    init,
    { environment: "production", integrationsAllowPrivateNetworkTargets: false },
    { label: "xAI image generation", requireHttpsOutsideLocalTest: true },
  );

export type XaiGeneratedImage = {
  bytes: Uint8Array;
  declaredMediaType: "image/png" | "image/jpeg" | "image/webp";
};

export async function generateXaiSubscriptionImage(input: {
  prompt: string;
  aspectRatio?: string;
  references?: readonly XaiImageReference[];
  sessionId?: string;
  getToken: () => Promise<XaiSubscriptionTokenSnapshot>;
  refresh: () => Promise<XaiSubscriptionTokenSnapshot>;
  abortSignal?: AbortSignal;
  fetch?: XaiFetchLike;
  requestTimeoutMs?: number;
  baseUrl?: string;
}): Promise<XaiGeneratedImage> {
  const timeoutMs = input.requestTimeoutMs ?? XAI_IMAGE_REQUEST_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new XaiSubscriptionError("timeout", "xAI image generation timed out")),
    timeoutMs,
  );
  const signal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, deadline.signal])
    : deadline.signal;
  const fetchImpl = input.fetch ?? defaultImageFetch;
  const references = input.references ?? [];
  if (references.length > 3) {
    throw new XaiSubscriptionError(
      "provider_rejected",
      "xAI image editing supports at most three references",
    );
  }
  const url = `${(input.baseUrl ?? XAI_PUBLIC_API_BASE_URL).replace(/\/+$/, "")}/images/${references.length > 0 ? "edits" : "generations"}`;
  const request = async (token: XaiSubscriptionTokenSnapshot): Promise<Response> =>
    await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
        "user-agent": `opengeni/${XAI_CLIENT_VERSION}`,
        "x-grok-client-version": XAI_CLIENT_VERSION,
        "x-grok-client-identifier": "opengeni",
        ...(input.sessionId ? { "x-grok-session-id": input.sessionId } : {}),
      },
      body: JSON.stringify(
        references.length > 0
          ? {
              model: XAI_IMAGE_MODEL,
              prompt: input.prompt,
              n: 1,
              resolution: "1k",
              response_format: "b64_json",
              ...(references.length === 1
                ? { image: referencePayload(references[0]!) }
                : {
                    images: references.map(referencePayload),
                    aspect_ratio: input.aspectRatio ?? "auto",
                  }),
            }
          : {
              model: XAI_IMAGE_MODEL,
              prompt: input.prompt,
              n: 1,
              aspect_ratio: input.aspectRatio ?? "auto",
              resolution: "1k",
              response_format: "b64_json",
            },
      ),
      signal,
    });
  try {
    let response = await request(await input.getToken());
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await request(await input.refresh());
    }
    if (!response.ok) {
      const detail = await readResponseTextBounded(
        response,
        XAI_IMAGE_ERROR_MAX_BYTES,
        "xAI image generation error",
        { signal },
      ).catch(() => "");
      throw new XaiSubscriptionError(
        "provider_rejected",
        `xAI image generation failed (${response.status})${detail ? `: ${boundedMessage(detail)}` : ""}`,
        response.status,
      );
    }
    const bytes = await readJsonBase64Field(response, {
      fieldName: "b64_json",
      shape: "string",
      maxResponseBytes: XAI_IMAGE_RESPONSE_MAX_BYTES,
      maxDecodedBytes: XAI_IMAGE_MAX_BYTES,
      label: "xAI image generation",
      signal,
    });
    return { bytes, declaredMediaType: detectImageMediaType(bytes) };
  } finally {
    clearTimeout(timer);
  }
}

function referencePayload(reference: XaiImageReference): { url: string } {
  return {
    url: `data:${reference.mediaType};base64,${Buffer.from(reference.bytes).toString("base64")}`,
  };
}

function detectImageMediaType(bytes: Uint8Array): XaiGeneratedImage["declaredMediaType"] {
  if (
    bytes.byteLength >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new XaiSubscriptionError("invalid_response", "xAI returned an unsupported image format");
}

function boundedMessage(body: string): string {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const error =
      value.error && typeof value.error === "object" && !Array.isArray(value.error)
        ? (value.error as Record<string, unknown>)
        : null;
    const message = error?.message ?? value.message;
    if (typeof message === "string") return message.replace(/\s+/g, " ").trim().slice(0, 1_000);
  } catch {
    // Preserve only a bounded normalized provider diagnostic.
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 1_000);
}
