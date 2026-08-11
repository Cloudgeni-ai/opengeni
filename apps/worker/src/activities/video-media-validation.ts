import type { GeneratedVideoFacts } from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

const RANGE_BYTES = 1024 * 1024;
const PROBE_STDOUT_MAX_BYTES = 64 * 1024;
const PROBE_STDERR_MAX_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 20_000;

export type VerifiedTempFile = Readonly<{
  directory: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  cleanup: () => Promise<void>;
}>;

export async function copyVersionedObjectToVerifiedTemp(input: {
  storage: ObjectStorage;
  key: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  expectedContentType: string;
  maxBytes: number;
  tempRoot: string;
  signal?: AbortSignal;
}): Promise<VerifiedTempFile> {
  if (!input.storage.headObject || !input.storage.getObjectRange) {
    throw new Error("Object storage lacks versioned range reads");
  }
  assertSha256(input.expectedSha256);
  if (
    !Number.isSafeInteger(input.expectedSizeBytes) ||
    input.expectedSizeBytes <= 0 ||
    input.expectedSizeBytes > input.maxBytes
  ) {
    throw new Error("Media staging size is invalid");
  }
  throwIfAborted(input.signal);
  const head = await input.storage.headObject(input.key);
  if (
    !head ||
    head.ContentLength !== input.expectedSizeBytes ||
    head.ContentType !== input.expectedContentType ||
    head.Metadata?.sha256 !== input.expectedSha256 ||
    !head.VersionToken
  ) {
    throw new Error("Media staging metadata does not match its sealed reference");
  }
  const versionToken = head.VersionToken;
  await mkdir(input.tempRoot, { recursive: true, mode: 0o700 });
  const directory = join(input.tempRoot, `media-${randomUUID()}`);
  const path = join(directory, "payload");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let offset = 0;
  try {
    while (offset < input.expectedSizeBytes) {
      throwIfAborted(input.signal);
      const endInclusive = Math.min(input.expectedSizeBytes - 1, offset + RANGE_BYTES - 1);
      const range = await input.storage.getObjectRange({
        key: input.key,
        start: offset,
        endInclusive,
        expectedVersionToken: versionToken,
      });
      if (
        !range ||
        range.versionToken !== versionToken ||
        range.bytes.byteLength !== endInclusive - offset + 1
      ) {
        throw new Error("Media staging object changed during range read");
      }
      await writeAll(handle, range.bytes, offset);
      hash.update(range.bytes);
      offset += range.bytes.byteLength;
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await handle.close();
  const digest = hash.digest("hex");
  if (offset !== input.expectedSizeBytes || digest !== input.expectedSha256) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Media staging bytes do not match their sealed digest");
  }
  const after = await input.storage.headObject(input.key);
  if (!after || after.VersionToken !== versionToken) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Media staging object changed after verification");
  }
  return Object.freeze({
    directory,
    path,
    sizeBytes: offset,
    sha256: digest,
    contentType: input.expectedContentType,
    cleanup: async () => await rm(directory, { recursive: true, force: true }),
  });
}

export async function validateImageReference(path: string): Promise<{
  contentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}> {
  const metadata = await sharp(path, { failOn: "error", limitInputPixels: 67_108_864 }).metadata();
  const contentType =
    metadata.format === "jpeg"
      ? "image/jpeg"
      : metadata.format === "png"
        ? "image/png"
        : metadata.format === "webp"
          ? "image/webp"
          : null;
  if (
    !contentType ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > 8_192 ||
    metadata.height > 8_192
  ) {
    throw new Error("Video image reference is not a supported JPEG, PNG, or WebP image");
  }
  return { contentType, width: metadata.width, height: metadata.height };
}

export async function validateGeneratedVideo(input: {
  path: string;
  ffprobePath: string;
  expectedDurationSeconds?: number;
}): Promise<GeneratedVideoFacts> {
  const facts = await probeBrowserCompatibleMp4(input.path, input.ffprobePath);
  if (
    input.expectedDurationSeconds !== undefined &&
    Math.abs(facts.durationSeconds - input.expectedDurationSeconds) > 3
  ) {
    throw new Error("Generated video duration differs from the requested duration");
  }
  return facts;
}

export async function validateVideoReference(input: {
  path: string;
  ffprobePath: string;
}): Promise<GeneratedVideoFacts> {
  return await probeBrowserCompatibleMp4(input.path, input.ffprobePath);
}

async function probeBrowserCompatibleMp4(
  path: string,
  ffprobePath: string,
): Promise<GeneratedVideoFacts> {
  const file = await stat(path);
  if (!file.isFile() || file.size <= 0) throw new Error("Media probe input is not a regular file");
  const result = await spawnBounded(ffprobePath, [
    "-v",
    "error",
    "-protocol_whitelist",
    "file,pipe",
    "-probesize",
    "8388608",
    "-analyzeduration",
    "5000000",
    "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
    "-of",
    "json",
    "--",
    path,
  ]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    throw new Error("Media probe returned malformed metadata");
  }
  const root = record(decoded);
  const format = record(root?.format);
  const streams = Array.isArray(root?.streams) ? root.streams.map(record).filter(Boolean) : [];
  const video = streams.filter((stream) => stream?.codec_type === "video");
  const audio = streams.filter((stream) => stream?.codec_type === "audio");
  const durationSeconds = finitePositive(format?.duration);
  const width = positiveInteger(video[0]?.width);
  const height = positiveInteger(video[0]?.height);
  const fps = parseFrameRate(video[0]?.avg_frame_rate);
  if (
    !stringValue(format?.format_name)
      ?.split(",")
      .some((value) => value === "mp4") ||
    video.length !== 1 ||
    audio.length > 1 ||
    video[0]?.codec_name !== "h264" ||
    (audio.length === 1 && audio[0]?.codec_name !== "aac") ||
    !durationSeconds ||
    durationSeconds > 120 ||
    !width ||
    !height ||
    width > 8_192 ||
    height > 8_192 ||
    !fps ||
    fps > 120
  ) {
    throw new Error("Video is not a supported browser-compatible H.264 MP4");
  }
  return {
    durationSeconds,
    width,
    height,
    fps,
    hasAudio: audio.length === 1,
    videoCodec: "h264",
    audioCodec: audio.length === 1 ? "aac" : null,
  };
}

async function spawnBounded(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("Media probe timed out")), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > PROBE_STDOUT_MAX_BYTES) fail(new Error("Media probe output is too large"));
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > PROBE_STDERR_MAX_BYTES) fail(new Error("Media probe error is too large"));
      else stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => fail(error));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new Error(
            stderrText ? `Media probe failed: ${stderrText.slice(0, 1_000)}` : "Media probe failed",
          ),
        );
      } else {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: stderrText });
      }
    });
  });
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
  offset: number,
): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    const result = await handle.write(chunk, written, chunk.byteLength - written, offset + written);
    if (result.bytesWritten <= 0) throw new Error("Media temporary file write stalled");
    written += result.bytesWritten;
  }
}

function parseFrameRate(value: unknown): number | null {
  const text = stringValue(value);
  if (!text) return null;
  const [left, right] = text.split("/");
  const numerator = Number(left);
  const denominator = right === undefined ? 1 : Number(right);
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("Media SHA-256 is invalid");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Media operation was cancelled");
}
