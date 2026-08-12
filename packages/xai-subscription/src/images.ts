import { pinnedFetch, readJsonBase64Field, readResponseTextBounded } from "@opengeni/network";

import {
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

const defaultImageFetch: XaiFetchLike = async (input, init) =>
  await pinnedFetch(
    input,
    init,
    { environment: "production", integrationsAllowPrivateNetworkTargets: false },
    { label: "xAI image generation", requireHttpsOutsideLocalTest: true },
  );

export type XaiGeneratedImage = {
  bytes: Uint8Array;
  declaredMediaType: "image/png";
};

export async function generateXaiSubscriptionImage(input: {
  prompt: string;
  aspectRatio?: string;
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
  const url = `${(input.baseUrl ?? XAI_PUBLIC_API_BASE_URL).replace(/\/+$/, "")}/images/generations`;
  const request = async (token: XaiSubscriptionTokenSnapshot): Promise<Response> =>
    await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: XAI_IMAGE_MODEL,
        prompt: input.prompt,
        n: 1,
        aspect_ratio: input.aspectRatio ?? "auto",
        resolution: "1k",
        response_format: "b64_json",
      }),
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
    return { bytes, declaredMediaType: "image/png" };
  } finally {
    clearTimeout(timer);
  }
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
