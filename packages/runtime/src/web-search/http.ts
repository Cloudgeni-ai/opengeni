import type { WebSearchProviderId } from "@opengeni/config";
import { WebSearchProviderError } from "./types";

/** Largest provider response body read into worker memory. */
export const WEB_PROVIDER_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ERROR_DETAIL_MAX_CHARS = 300;

export type ProviderHttp = {
  provider: WebSearchProviderId;
  fetch: typeof fetch;
  timeoutMs: number;
};

async function readBounded(response: Response, provider: WebSearchProviderId): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > WEB_PROVIDER_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new WebSearchProviderError(provider, "Provider response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > WEB_PROVIDER_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new WebSearchProviderError(provider, "Provider response is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function errorDetail(body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const candidate =
      parsed.error ??
      parsed.message ??
      parsed.detail ??
      (parsed.data as { error?: unknown })?.error;
    if (typeof candidate === "string") detail = candidate;
    else if (candidate && typeof candidate === "object") {
      const nested = (candidate as Record<string, unknown>).message;
      if (typeof nested === "string") detail = nested;
    }
  } catch {
    // Plain-text error body.
  }
  return detail.replace(/\s+/gu, " ").trim().slice(0, ERROR_DETAIL_MAX_CHARS);
}

/**
 * One JSON request with a timeout, a response size bound, and errors that
 * never echo credentials. Callers pass headers; nothing here logs them.
 */
export async function providerJson<T>(
  http: ProviderHttp,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(http.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await http.fetch(url, { ...init, signal: combined, redirect: "follow" });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new WebSearchProviderError(
        http.provider,
        `Provider did not answer within ${Math.round(http.timeoutMs / 1000)} seconds`,
        { retryable: true },
      );
    }
    throw new WebSearchProviderError(http.provider, "Provider is unreachable", {
      retryable: true,
    });
  }
  const body = await readBounded(response, http.provider);
  if (!response.ok) {
    const detail = errorDetail(body);
    throw new WebSearchProviderError(
      http.provider,
      `Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      { status: response.status, retryable: response.status === 429 || response.status >= 500 },
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new WebSearchProviderError(http.provider, "Provider returned a non-JSON response");
  }
}

/** Remove markup a provider leaves in snippets and collapse whitespace. */
export function plainText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]{0,200}>/gu, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gu, (_, entity: string) =>
      entity === "amp"
        ? "&"
        : entity === "lt"
          ? "<"
          : entity === "gt"
            ? ">"
            : entity === "quot"
              ? '"'
              : entity === "#39"
                ? "'"
                : " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** USD (floating) reported by a provider to integer micros, or undefined. */
export function dollarsToMicros(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.ceil(Math.round(value * 1_000_000_000) / 1_000)
    : undefined;
}
