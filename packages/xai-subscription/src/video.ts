import {
  pinnedFetch,
  readResponseBodyBounded,
  readResponseJsonBounded,
  readResponseTextBounded,
  validateHttpUrl,
} from "@opengeni/network";

import {
  XAI_PUBLIC_API_BASE_URL,
  XAI_VIDEO_DOWNLOAD_TIMEOUT_MS,
  XAI_VIDEO_GENERATION_TIMEOUT_MS,
  XAI_VIDEO_MODEL,
  XAI_VIDEO_POLL_INTERVAL_MS,
  XAI_VIDEO_POLL_REQUEST_TIMEOUT_MS,
  XAI_VIDEO_START_TIMEOUT_MS,
} from "./constants";
import { XaiSubscriptionError } from "./errors";
import type { XaiFetchLike } from "./fetch";
import type { XaiSubscriptionTokenSnapshot } from "./request-context";

const XAI_VIDEO_MAX_BYTES = 256 * 1024 * 1024;
const XAI_VIDEO_ERROR_MAX_BYTES = 64 * 1024;

const defaultVideoFetch: XaiFetchLike = async (input, init) =>
  await pinnedFetch(
    input,
    init,
    { environment: "production", integrationsAllowPrivateNetworkTargets: false },
    { label: "xAI video generation", requireHttpsOutsideLocalTest: true },
  );

export type XaiGeneratedVideo = {
  bytes: Uint8Array;
  declaredMediaType: "video/mp4";
  requestId: string;
};

export async function generateXaiSubscriptionVideo(input: {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: "480p" | "720p";
  imageUrl?: string;
  referenceImageUrls?: readonly string[];
  getToken: () => Promise<XaiSubscriptionTokenSnapshot>;
  refresh: () => Promise<XaiSubscriptionTokenSnapshot>;
  abortSignal?: AbortSignal;
  fetch?: XaiFetchLike;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  baseUrl?: string;
  generationTimeoutMs?: number;
}): Promise<XaiGeneratedVideo> {
  const baseUrl = (input.baseUrl ?? XAI_PUBLIC_API_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = input.fetch ?? defaultVideoFetch;
  const deadline = new AbortController();
  const timeoutMs = input.generationTimeoutMs ?? XAI_VIDEO_GENERATION_TIMEOUT_MS;
  const timer = setTimeout(
    () => deadline.abort(new XaiSubscriptionError("timeout", "xAI video generation timed out")),
    timeoutMs,
  );
  const signal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, deadline.signal])
    : deadline.signal;
  const references = (input.referenceImageUrls ?? []).map(validateMediaUrl);
  const image = input.imageUrl ? validateMediaUrl(input.imageUrl) : undefined;
  const request = async (token: XaiSubscriptionTokenSnapshot): Promise<Response> =>
    await fetchWithDeadline(
      fetchImpl,
      `${baseUrl}/videos/generations`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: XAI_VIDEO_MODEL,
          prompt: input.prompt,
          ...(image ? { image: { url: image } } : {}),
          ...(references.length > 0
            ? { reference_images: references.map((url) => ({ url })) }
            : {}),
          ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
          aspect_ratio: input.aspectRatio ?? "16:9",
          resolution: input.resolution ?? "480p",
        }),
        signal,
      },
      XAI_VIDEO_START_TIMEOUT_MS,
      signal,
    );
  try {
    let start = await request(await input.getToken());
    if (start.status === 401) {
      await start.body?.cancel().catch(() => undefined);
      start = await request(await input.refresh());
    }
    if (!start.ok) throw await providerError("start", start, signal);
    const started = await readResponseJsonBounded<Record<string, unknown>>(
      start,
      1024 * 1024,
      "xAI video start",
      { signal },
    );
    const requestId =
      typeof started.request_id === "string" && started.request_id.length > 0
        ? started.request_id
        : null;
    if (!requestId) {
      throw new XaiSubscriptionError(
        "invalid_response",
        "xAI video generation did not return request_id",
      );
    }
    const sleep = input.sleep ?? abortableSleep;
    for (;;) {
      await sleep(XAI_VIDEO_POLL_INTERVAL_MS, signal);
      let poll = await pollVideo(fetchImpl, baseUrl, requestId, await input.getToken(), signal);
      if (poll.status === 401) {
        await poll.body?.cancel().catch(() => undefined);
        poll = await pollVideo(fetchImpl, baseUrl, requestId, await input.refresh(), signal);
      }
      if (!poll.ok && poll.status !== 202) throw await providerError("poll", poll, signal);
      const status = await readResponseJsonBounded<Record<string, unknown>>(
        poll,
        1024 * 1024,
        "xAI video poll",
        { signal },
      );
      if (status.status === "failed" || status.status === "expired") {
        throw new XaiSubscriptionError(
          "provider_rejected",
          `xAI video generation ${status.status}`,
        );
      }
      if (status.status !== "done") continue;
      const video =
        status.video && typeof status.video === "object" && !Array.isArray(status.video)
          ? (status.video as Record<string, unknown>)
          : null;
      const downloadUrl = typeof video?.url === "string" ? validateMediaUrl(video.url) : null;
      if (!downloadUrl) {
        throw new XaiSubscriptionError(
          "invalid_response",
          "xAI video generation completed without a download URL",
        );
      }
      const download = await fetchWithDeadline(
        fetchImpl,
        downloadUrl,
        { method: "GET", redirect: "error", signal },
        XAI_VIDEO_DOWNLOAD_TIMEOUT_MS,
        signal,
      );
      if (!download.ok) throw await providerError("download", download, signal);
      const bytes = await readResponseBodyBounded(
        download,
        XAI_VIDEO_MAX_BYTES,
        "xAI video download",
        { signal },
      );
      return { bytes, declaredMediaType: "video/mp4", requestId };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function pollVideo(
  fetchImpl: XaiFetchLike,
  baseUrl: string,
  requestId: string,
  token: XaiSubscriptionTokenSnapshot,
  signal: AbortSignal,
): Promise<Response> {
  return await fetchWithDeadline(
    fetchImpl,
    `${baseUrl}/videos/${encodeURIComponent(requestId)}`,
    {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${token.accessToken}` },
      signal,
    },
    XAI_VIDEO_POLL_REQUEST_TIMEOUT_MS,
    signal,
  );
}

async function fetchWithDeadline(
  fetchImpl: XaiFetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return await fetchImpl(url, { ...init, signal: AbortSignal.any([outerSignal, timeout]) });
}

async function providerError(
  phase: string,
  response: Response,
  signal: AbortSignal,
): Promise<XaiSubscriptionError> {
  const detail = await readResponseTextBounded(
    response,
    XAI_VIDEO_ERROR_MAX_BYTES,
    `xAI video ${phase} error`,
    { signal },
  ).catch(() => "");
  return new XaiSubscriptionError(
    "provider_rejected",
    `xAI video ${phase} failed (${response.status})${detail ? `: ${detail.replace(/\s+/g, " ").trim().slice(0, 1_000)}` : ""}`,
    response.status,
  );
}

function validateMediaUrl(value: string): string {
  try {
    return validateHttpUrl(value, { label: "xAI media" });
  } catch {
    throw new XaiSubscriptionError("invalid_response", "xAI returned an invalid media URL");
  }
}

async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(signal.reason);
    function done(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      error === undefined ? resolve() : reject(error);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}