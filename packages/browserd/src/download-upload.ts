import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserDownloadExportRequest } from "@opengeni/contracts";
import { InteractionControllerError } from "@opengeni/interaction";

const CONTENT_TYPE = "application/octet-stream";
const MAX_UPLOAD_URL_BYTES = 16 * 1024;
const MAX_UPLOAD_HEADERS = 16;
const MAX_UPLOAD_HEADER_BYTES = 16 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;

type UploadAuthority = BrowserDownloadExportRequest["upload"];
type DownloadFetch = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

/** Stream one controller-private, integrity-verified download through a narrow
 * object-store grant. No signed authority is retained or reflected in errors. */
export async function uploadBrowserDownload(
  filePathInput: string,
  authorityInput: UploadAuthority,
  expected: { sizeBytes: number; sha256: string },
  options: { timeoutMs?: number; fetch?: DownloadFetch; now?: () => Date } = {},
): Promise<void> {
  const authority = validateDownloadUploadAuthority(
    authorityInput,
    expected.sha256,
    options.now?.() ?? new Date(),
  );
  const filePath = resolve(filePathInput);
  const facts = await stat(filePath);
  if (!facts.isFile() || facts.size !== expected.sizeBytes) {
    throw new InteractionControllerError(
      "resource_unavailable",
      "browser download bytes are unavailable",
      true,
    );
  }
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(authority.url, {
        method: "PUT",
        headers: {
          ...authority.requiredHeaders,
          "content-length": String(expected.sizeBytes),
        },
        // A FileBlob request body crashes Bun standalone executables on Linux.
        // The file-backed stream preserves bounded-memory transfer while using
        // the stable fetch body path in both source and compiled browserd.
        body: Bun.file(filePath).stream(),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new InteractionControllerError(
        "resource_unavailable",
        "browser download publication transport failed",
        true,
      );
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new InteractionControllerError(
        "resource_unavailable",
        `browser download publication returned HTTP ${response.status}`,
        true,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export function validateDownloadUploadAuthority(
  input: UploadAuthority,
  expectedSha256: string,
  now = new Date(),
): UploadAuthority {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw new Error("browser download upload digest is invalid");
  }
  if (typeof input.url !== "string" || Buffer.byteLength(input.url) > MAX_UPLOAD_URL_BYTES) {
    throw new Error("browser download upload URL is invalid");
  }
  const url = new URL(input.url);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("browser download upload URL is invalid");
  }
  const expiresAt = canonicalTimestamp(input.expiresAt);
  if (expiresAt.valueOf() <= now.valueOf())
    throw new Error("browser download upload grant expired");
  const entries = Object.entries(input.requiredHeaders);
  if (entries.length < 1 || entries.length > MAX_UPLOAD_HEADERS) {
    throw new Error("browser download upload header count is invalid");
  }
  const requiredHeaders: Record<string, string> = {};
  let bytes = 0;
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      !allowedHeader(name) ||
      typeof value !== "string" ||
      /[\r\n]/u.test(value)
    ) {
      throw new Error("browser download upload header is invalid");
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > MAX_UPLOAD_HEADER_BYTES) {
      throw new Error("browser download upload headers exceed their byte envelope");
    }
    requiredHeaders[name] = value;
  }
  if (requiredHeaders["content-type"] !== CONTENT_TYPE) {
    throw new Error("browser download upload content type is invalid");
  }
  for (const metadataName of ["x-goog-meta-sha256", "x-ms-meta-sha256"]) {
    const value = requiredHeaders[metadataName];
    if (value !== undefined && value !== expectedSha256) {
      throw new Error("browser download upload metadata digest is invalid");
    }
  }
  return {
    url: url.toString(),
    requiredHeaders,
    expiresAt: expiresAt.toISOString(),
  };
}

function allowedHeader(name: string): boolean {
  return (
    name === "content-type" ||
    name === "x-ms-blob-type" ||
    name === "x-ms-meta-sha256" ||
    name === "x-goog-meta-sha256"
  );
}

function canonicalTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("browser download upload expiry is invalid");
  }
  return parsed;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > DEFAULT_UPLOAD_TIMEOUT_MS) {
    throw new Error("browser download upload timeout is invalid");
  }
  return value;
}
