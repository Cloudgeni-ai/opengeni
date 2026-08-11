import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_DOWNLOAD_URL_BYTES = 16 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 5_000_000_000;

export type BrowserStateDownloadAuthority = {
  url: string;
  expiresAt: string;
};

export class BrowserStateDownloadError extends Error {
  readonly name = "BrowserStateDownloadError";
  readonly retryable = true;
}

/** Download one encrypted immutable profile through a short-lived read grant.
 * The exact byte length is checked here; authenticated digests and GCM are
 * checked by the artifact decoder before any profile becomes live. */
export async function downloadBrowserStateArtifact(
  artifactPathInput: string,
  authorityInput: BrowserStateDownloadAuthority,
  expectedSizeBytesInput: number,
  options: {
    timeoutMs?: number;
    maxArtifactBytes?: number;
    fetch?: typeof fetch;
    now?: () => Date;
  } = {},
): Promise<void> {
  const artifactPath = resolve(artifactPathInput);
  const authority = validateDownloadAuthority(authorityInput, options.now?.() ?? new Date());
  const maximum = boundedPositiveInteger(
    options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    "browser state download byte limit",
  );
  const expectedSizeBytes = boundedPositiveInteger(
    expectedSizeBytesInput,
    "browser state artifact size",
  );
  if (expectedSizeBytes > maximum) {
    throw new Error("browser state artifact exceeds the download byte limit");
  }
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const temporaryPath = `${artifactPath}.partial`;
  await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  await rm(temporaryPath, { force: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(authority.url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new BrowserStateDownloadError("browser state download transport failed");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new BrowserStateDownloadError(
        `browser state download returned HTTP ${response.status}`,
      );
    }
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^(0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) !== expectedSizeBytes)
    ) {
      await response.body.cancel().catch(() => undefined);
      throw new BrowserStateDownloadError(
        "browser state download length does not match its authority",
      );
    }
    const counter = new BoundedByteCounter(expectedSizeBytes);
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        counter,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
    } catch (error) {
      if (error instanceof BrowserStateDownloadError) throw error;
      throw new BrowserStateDownloadError("browser state download stream failed");
    }
    if (counter.bytes !== expectedSizeBytes) {
      throw new BrowserStateDownloadError("browser state download was truncated");
    }
    await rename(temporaryPath, artifactPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function validateDownloadAuthority(
  input: BrowserStateDownloadAuthority,
  now = new Date(),
): BrowserStateDownloadAuthority {
  if (!input || typeof input !== "object") {
    throw new Error("browser state download is invalid");
  }
  if (typeof input.url !== "string" || Buffer.byteLength(input.url) > MAX_DOWNLOAD_URL_BYTES) {
    throw new Error("browser state download URL is invalid");
  }
  const url = new URL(input.url);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("browser state download URL is invalid");
  }
  const expiresAt = canonicalTimestamp(input.expiresAt, "browser state download expiry");
  if (expiresAt.valueOf() <= now.valueOf()) {
    throw new Error("browser state download grant expired");
  }
  return { url: url.toString(), expiresAt: expiresAt.toISOString() };
}

class BoundedByteCounter extends Transform {
  bytes = 0;

  constructor(private readonly expectedBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += bytes.byteLength;
    if (this.bytes > this.expectedBytes) {
      callback(new BrowserStateDownloadError("browser state download exceeds its authorized size"));
      return;
    }
    callback(null, bytes);
  }
}

function canonicalTimestamp(value: string, label: string): Date {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > DEFAULT_DOWNLOAD_TIMEOUT_MS) {
    throw new Error("browser state download timeout is invalid");
  }
  return value;
}
