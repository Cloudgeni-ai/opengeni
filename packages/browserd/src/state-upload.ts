import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { BROWSER_STATE_ARTIFACT_CONTENT_TYPE } from "@opengeni/contracts";

export { BROWSER_STATE_ARTIFACT_CONTENT_TYPE } from "@opengeni/contracts";

const MAX_UPLOAD_URL_BYTES = 16 * 1024;
const MAX_UPLOAD_HEADERS = 16;
const MAX_UPLOAD_HEADER_BYTES = 16 * 1024;
const DEFAULT_UPLOAD_TIMEOUT_MS = 15 * 60_000;

export type BrowserStateUploadAuthority = {
  url: string;
  requiredHeaders: Readonly<Record<string, string>>;
  expiresAt: string;
};

export class BrowserStateUploadError extends Error {
  readonly name = "BrowserStateUploadError";
  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
  }
}

/** Upload one already-encrypted artifact through a short-lived object-store grant. */
export async function uploadBrowserStateArtifact(
  artifactPathInput: string,
  authorityInput: BrowserStateUploadAuthority,
  options: { timeoutMs?: number; fetch?: typeof fetch; now?: () => Date } = {},
): Promise<void> {
  const artifactPath = resolve(artifactPathInput);
  const authority = validateUploadAuthority(authorityInput, options.now?.() ?? new Date());
  const info = await stat(artifactPath);
  if (!info.isFile() || info.size < 1) throw new Error("browser state artifact is unavailable");
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(authority.url, {
        method: "PUT",
        headers: authority.requiredHeaders,
        body: Bun.file(artifactPath),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new BrowserStateUploadError(
        "browser state upload outcome is unknown after transport failure",
        true,
      );
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new BrowserStateUploadError(
        `browser state upload outcome is unknown after storage returned HTTP ${response.status}`,
        true,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export function validateUploadAuthority(
  input: BrowserStateUploadAuthority,
  now = new Date(),
): BrowserStateUploadAuthority {
  if (!input || typeof input !== "object") throw new Error("browser state upload is invalid");
  if (typeof input.url !== "string" || Buffer.byteLength(input.url) > MAX_UPLOAD_URL_BYTES) {
    throw new Error("browser state upload URL is invalid");
  }
  const url = new URL(input.url);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("browser state upload URL is invalid");
  }
  const expiresAt = canonicalTimestamp(input.expiresAt, "browser state upload expiry");
  if (expiresAt.valueOf() <= now.valueOf()) throw new Error("browser state upload grant expired");
  if (!input.requiredHeaders || typeof input.requiredHeaders !== "object") {
    throw new Error("browser state upload headers are invalid");
  }
  const entries = Object.entries(input.requiredHeaders);
  if (entries.length < 1 || entries.length > MAX_UPLOAD_HEADERS) {
    throw new Error("browser state upload header count is invalid");
  }
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(name) ||
      !allowedHeader(name) ||
      typeof rawValue !== "string" ||
      /[\r\n]/u.test(rawValue)
    ) {
      throw new Error("browser state upload header is invalid");
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(rawValue);
    if (headerBytes > MAX_UPLOAD_HEADER_BYTES) {
      throw new Error("browser state upload headers exceed their byte envelope");
    }
    headers[name] = rawValue;
  }
  if (headers["content-type"] !== BROWSER_STATE_ARTIFACT_CONTENT_TYPE) {
    throw new Error("browser state upload content type is invalid");
  }
  return {
    url: url.toString(),
    requiredHeaders: headers,
    expiresAt: expiresAt.toISOString(),
  };
}

function allowedHeader(name: string): boolean {
  return name === "content-type" || name === "x-ms-blob-type";
}

function canonicalTimestamp(value: string, label: string): Date {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > DEFAULT_UPLOAD_TIMEOUT_MS) {
    throw new Error("browser state upload timeout is invalid");
  }
  return value;
}
