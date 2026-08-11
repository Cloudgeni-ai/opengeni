import { pinnedFetch, readResponseBodyBounded, type FetchLike } from "@opengeni/network";

import type { IntegrationTransport, PinnedIntegrationTransportOptions } from "./types";
import { IntegrationInvocationError } from "./types";

export const DEFAULT_INTEGRATION_TIMEOUT_MS = 30_000;
export const DEFAULT_INTEGRATION_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_INTEGRATION_SPEC_BYTES = 8 * 1024 * 1024;
export const MAX_INTEGRATION_TOOLS = 2_000;

export async function fetchIntegrationSourceDocument(
  transport: IntegrationTransport,
  sourceUrl: string,
  maxBytes = MAX_INTEGRATION_SPEC_BYTES,
): Promise<Uint8Array> {
  const url = new URL(sourceUrl);
  const response = await fetchWithDeadline(
    transport,
    url,
    {
      method: "GET",
      headers: { accept: "application/json, application/yaml, text/yaml, */*;q=0.5" },
    },
    DEFAULT_INTEGRATION_TIMEOUT_MS,
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntegrationInvocationError(
      "source_redirect_rejected",
      "Integration source attempted to redirect",
      "failed",
      false,
      response.status,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new IntegrationInvocationError(
      "source_fetch_rejected",
      "Integration source could not be read",
      "failed",
      response.status >= 500,
      response.status,
    );
  }
  return await readResponseBodyBounded(response, maxBytes, "Integration source");
}

export function createPinnedIntegrationTransport(
  options: PinnedIntegrationTransportOptions,
): IntegrationTransport {
  return {
    fetch: (input, init) =>
      pinnedFetch(input, init, options.network, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        label: "Integration request",
        requireHttpsOutsideLocalTest: true,
      }),
  };
}

export function directIntegrationTransport(fetchImpl: FetchLike): IntegrationTransport {
  return { fetch: fetchImpl };
}

export async function fetchWithDeadline(
  transport: IntegrationTransport,
  url: URL,
  init: RequestInit,
  timeoutMs = DEFAULT_INTEGRATION_TIMEOUT_MS,
): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError("integration timeout must be between 1 and 120000 milliseconds");
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) onAbort();
  else init.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("integration request timed out")),
    timeoutMs,
  );
  try {
    return await transport.fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch {
    const timedOut = controller.signal.aborted && !init.signal?.aborted;
    throw new IntegrationInvocationError(
      timedOut ? "request_timeout" : "request_failed",
      timedOut ? "Integration request timed out" : "Integration request failed",
      requestCouldHaveStarted(init.method) ? "unknown" : "not_started",
      !requestCouldHaveStarted(init.method),
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
}

function requestCouldHaveStarted(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

export async function readIntegrationResponse(
  response: Response,
  maxBytes = DEFAULT_INTEGRATION_RESPONSE_BYTES,
): Promise<{ data: unknown; contentType: string; bytes: number }> {
  const body = await readResponseBodyBounded(response, maxBytes, "Integration response");
  const contentType =
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (body.byteLength === 0) return { data: null, contentType, bytes: 0 };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    try {
      return { data: JSON.parse(text), contentType, bytes: body.byteLength };
    } catch {
      throw new IntegrationInvocationError(
        "response_json_invalid",
        "Integration returned invalid JSON",
        "failed",
        false,
        response.status,
      );
    }
  }
  return { data: text, contentType, bytes: body.byteLength };
}
