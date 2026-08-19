import type { Settings } from "@opengeni/config";
import { GENERATED_VIDEO_MAX_BYTES, type GeneratedVideoFacts } from "@opengeni/contracts";
import { pinnedFetch, type FetchLike } from "@opengeni/network";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateGeneratedVideo, type VerifiedTempFile } from "./video-media-validation";

const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const READ_STALL_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 3;
const STORAGE_RANGE_BYTES = 1024 * 1024;
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

export type RetainedGeneratedVideo = Readonly<{
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
  facts: GeneratedVideoFacts;
}>;

/**
 * Treat the provider's result URL and bytes as hostile. DNS is pinned, every
 * redirect is revalidated, and the body streams to a private temporary file
 * under hard time/size limits before ffprobe sees it.
 */
export async function downloadGeneratedVideoToVerifiedTemp(input: {
  url: string;
  mediaType: string;
  settings: Settings;
  expectedDurationSeconds: number;
  fetch?: FetchLike;
  signal?: AbortSignal;
}): Promise<{ temp: VerifiedTempFile; facts: GeneratedVideoFacts }> {
  if (normalizedMediaType(input.mediaType) !== "video/mp4") {
    throw new Error("Video provider returned an unsupported media type");
  }
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchFollowingSafeRedirects(input.url, {
    settings: input.settings,
    signal,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Video provider output could not be downloaded");
  }
  if (normalizedMediaType(response.headers.get("content-type")) !== "video/mp4") {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Video provider output is not an MP4 response");
  }
  const declaredBytes = parseContentLength(response.headers.get("content-length"));
  if (declaredBytes !== null && declaredBytes > GENERATED_VIDEO_MAX_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Generated video exceeds the retained output limit");
  }

  await mkdir(input.settings.videoGenerationTempDirectory, { recursive: true, mode: 0o700 });
  const directory = join(input.settings.videoGenerationTempDirectory, `output-${randomUUID()}`);
  const path = join(directory, "video.mp4");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let sizeBytes = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const chunk = await readChunkWithStallLimit(reader, signal);
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;
      sizeBytes += chunk.value.byteLength;
      if (sizeBytes > GENERATED_VIDEO_MAX_BYTES) {
        throw new Error("Generated video exceeds the retained output limit");
      }
      await writeAll(handle, chunk.value, sizeBytes - chunk.value.byteLength);
      digest.update(chunk.value);
    }
    await handle.sync();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The aborted transport may retain the lock until cancellation settles.
    }
  }
  await handle.close();
  if (sizeBytes <= 0 || (declaredBytes !== null && sizeBytes !== declaredBytes)) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Generated video response was truncated");
  }
  const sha256 = digest.digest("hex");
  const temp: VerifiedTempFile = Object.freeze({
    directory,
    path,
    sizeBytes,
    sha256,
    contentType: "video/mp4",
    cleanup: async () => await rm(directory, { recursive: true, force: true }),
  });
  try {
    const facts = await validateGeneratedVideo({
      path,
      ffprobePath: input.settings.videoGenerationFfprobePath,
      expectedDurationSeconds: input.expectedDurationSeconds,
    });
    return { temp, facts };
  } catch (error) {
    await temp.cleanup();
    throw error;
  }
}

/** Stream verified bytes into an immutable content-addressed object. */
export async function retainVerifiedGeneratedVideo(input: {
  storage: ObjectStorage;
  temp: VerifiedTempFile;
  facts: GeneratedVideoFacts;
  signal?: AbortSignal;
}): Promise<RetainedGeneratedVideo> {
  if (!input.storage.putObjectStreamIfAbsent) {
    throw new Error("Object storage lacks bounded immutable video primitives");
  }
  const objectKey = `video-generation/objects/sha256/${input.temp.sha256}.mp4`;
  const chunks = fileChunks(input.temp.path, input.signal);
  await input.storage.putObjectStreamIfAbsent({
    key: objectKey,
    contentType: "video/mp4",
    chunks,
    byteSize: input.temp.sizeBytes,
    sha256: input.temp.sha256,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return Object.freeze({
    bucket: input.storage.bucket,
    objectKey,
    sizeBytes: input.temp.sizeBytes,
    sha256: input.temp.sha256,
    facts: input.facts,
  });
}

async function fetchFollowingSafeRedirects(
  rawUrl: string,
  input: { settings: Settings; fetch?: FetchLike; signal: AbortSignal },
): Promise<Response> {
  let url = requireSafeOutputUrl(rawUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await pinnedFetch(
      url,
      {
        method: "GET",
        headers: { accept: "video/mp4", "accept-encoding": "identity" },
        redirect: "manual",
        signal: input.signal,
      },
      {
        environment: input.settings.environment,
        // Provider output must never inherit an integration-level private-net override.
        integrationsAllowPrivateNetworkTargets: false,
      },
      {
        label: "video provider output",
        requireHttpsOutsideLocalTest: true,
        ...(input.fetch ? { fetchImpl: input.fetch } : {}),
      },
    );
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirect === MAX_REDIRECTS) {
      throw new Error("Video provider output redirect is invalid");
    }
    url = requireSafeOutputUrl(new URL(location, url).toString());
  }
  throw new Error("Video provider output has too many redirects");
}

function requireSafeOutputUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Video provider output URL is invalid");
  }
  return url.toString();
}

async function* fileChunks(path: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  const stream = createReadStream(path, { highWaterMark: STORAGE_RANGE_BYTES });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
  } finally {
    stream.destroy();
  }
}

async function readChunkWithStallLimit(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  if (signal.aborted) throw signal.reason;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Generated video download stalled")),
          READ_STALL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  offset: number,
): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await handle.write(chunk, written, chunk.byteLength - written, offset + written);
    if (result.bytesWritten <= 0) throw new Error("Generated video write stalled");
    written += result.bytesWritten;
  }
}

function normalizedMediaType(value: string | null): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/u.test(value.trim())) throw new Error("Generated video length is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Generated video length is invalid");
  }
  return parsed;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Video retention was cancelled");
}
