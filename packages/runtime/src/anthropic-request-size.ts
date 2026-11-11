import { AnthropicRequestError } from "./anthropic-request-error";

// The Messages API accepts 32 MB. Reserve room below that boundary for proxy
// differences; this is a transport bound, not a model token/context setting.
export const ANTHROPIC_REQUEST_MAX_BYTES = 24_000_000;
export const ANTHROPIC_IMAGE_MAX_ENCODED_BYTES = 512 * 1024;

export type AnthropicRequestSize = {
  requestBytes: number;
  imageCount: number;
  imageBase64Bytes: number;
  systemBytes: number;
  toolsBytes: number;
  limitBytes: number;
};

/** Content-free facts measured from the final, already serialized wire body. */
export function anthropicRequestSize(
  body: Record<string, unknown>,
  serialized: string,
): AnthropicRequestSize {
  let imageCount = 0;
  let imageBase64Bytes = 0;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const block = value as Record<string, unknown>;
    if (block.type === "image") {
      imageCount++;
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === "base64" && typeof source.data === "string")
        imageBase64Bytes += Buffer.byteLength(source.data);
      return;
    }
    // Traverse only the Messages content structure, never tool arguments or
    // arbitrary user JSON that merely resembles an image block.
    if (block.content) visit(block.content);
  };
  visit(body.messages);
  return {
    requestBytes: Buffer.byteLength(serialized, "utf8"),
    imageCount,
    imageBase64Bytes,
    systemBytes: body.system ? Buffer.byteLength(JSON.stringify(body.system)) : 0,
    toolsBytes: body.tools ? Buffer.byteLength(JSON.stringify(body.tools)) : 0,
    limitBytes: ANTHROPIC_REQUEST_MAX_BYTES,
  };
}

/** Only a local preflight refusal or an HTTP 413 before a response stream. */
export class AnthropicRequestSizeError extends AnthropicRequestError {
  constructor(
    readonly requestSize: AnthropicRequestSize,
    readonly rejection: "preflight" | "http_413",
    headers = new Headers(),
  ) {
    super(
      "Claude request exceeds the request byte budget; a smaller context checkpoint is required.",
      rejection === "http_413" ? 413 : undefined,
      "anthropic_request_too_large",
      undefined,
      headers,
    );
    this.name = "AnthropicRequestSizeError";
  }
}

export class AnthropicSizeRecoveryExhaustedError extends Error {
  readonly code = "anthropic_request_size_recovery_exhausted";
  constructor() {
    super(
      "Claude request is still too large after its one automatic size-recovery attempt. The original history is retained; reduce the current input or request another explicit compaction.",
    );
    this.name = "AnthropicSizeRecoveryExhaustedError";
  }
}

export function findAnthropicRequestSizeError(error: unknown): AnthropicRequestSizeError | null {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length && seen.size < 32) {
    const next = pending.pop();
    if (next instanceof AnthropicRequestSizeError) return next;
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    // Read only data properties; error diagnostics must not run arbitrary getters.
    for (const key of ["cause", "error"]) {
      const descriptor = Object.getOwnPropertyDescriptor(next, key);
      if (descriptor && "value" in descriptor) pending.push(descriptor.value);
    }
  }
  return null;
}
