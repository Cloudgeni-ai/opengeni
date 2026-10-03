import { Buffer } from "node:buffer";

function bounded(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  const marker = "… [truncated]";
  let end = maxBytes - Buffer.byteLength(marker);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + marker;
}

/** Structural log message; only the durable failure payload reads provider detail. */
export class AnthropicRequestError extends Error {
  readonly request_id: string | null;
  readonly headers: Record<string, string>;
  #detail: string | undefined;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    source: unknown,
    headers: Headers,
  ) {
    super(message);
    this.name = "AnthropicRequestError";
    const error =
      source && typeof source === "object" && !Array.isArray(source)
        ? (source as Record<string, unknown>)
        : undefined;
    const type = bounded(error?.type, 256);
    const detail = bounded(error?.message, 4096);
    // Select only error.type/message, never the raw body, echoed request fields,
    // cookies, or outgoing content. Keep diagnostics out of generic serialization.
    this.#detail = bounded([type, detail].filter(Boolean).join(": "), 4096);
    this.request_id = bounded(headers.get("request-id"), 256) ?? null;
    const retryAfter = bounded(headers.get("retry-after"), 256);
    this.headers = retryAfter ? { "retry-after": retryAfter } : {};
  }

  get detail(): string | undefined {
    return this.#detail;
  }
}
