import {
  CODEX_RESPONSE_HEADERS_TIMEOUT_MS,
  CODEX_RESPONSE_NO_BYTE_RETRIES,
  CODEX_RESPONSE_RETRY_BACKOFF_MS,
  CODEX_RESPONSE_STREAM_IDLE_TIMEOUT_MS,
  CODEX_RESPONSE_WHOLE_TIMEOUT_MS,
} from "./constants";
import type { CodexResponseTimeoutClass, CodexResponseTimeoutPolicy } from "./request-context";

export const CODEX_RESPONSE_TIMEOUT_ERROR_TYPE = "opengeni_codex_response_timeout";

export const DEFAULT_CODEX_RESPONSE_TIMEOUT_POLICY: CodexResponseTimeoutPolicy = Object.freeze({
  headersTimeoutMs: CODEX_RESPONSE_HEADERS_TIMEOUT_MS,
  streamIdleTimeoutMs: CODEX_RESPONSE_STREAM_IDLE_TIMEOUT_MS,
  wholeRequestTimeoutMs: CODEX_RESPONSE_WHOLE_TIMEOUT_MS,
  noByteRetries: CODEX_RESPONSE_NO_BYTE_RETRIES,
  retryBackoffMs: CODEX_RESPONSE_RETRY_BACKOFF_MS,
});

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveCodexResponseTimeoutPolicy(
  override: Partial<CodexResponseTimeoutPolicy> | undefined,
): CodexResponseTimeoutPolicy {
  return {
    headersTimeoutMs: positiveFinite(
      override?.headersTimeoutMs,
      DEFAULT_CODEX_RESPONSE_TIMEOUT_POLICY.headersTimeoutMs,
    ),
    streamIdleTimeoutMs: positiveFinite(
      override?.streamIdleTimeoutMs,
      DEFAULT_CODEX_RESPONSE_TIMEOUT_POLICY.streamIdleTimeoutMs,
    ),
    wholeRequestTimeoutMs: positiveFinite(
      override?.wholeRequestTimeoutMs,
      DEFAULT_CODEX_RESPONSE_TIMEOUT_POLICY.wholeRequestTimeoutMs,
    ),
    noByteRetries:
      override?.noByteRetries !== undefined && Number.isFinite(override.noByteRetries)
        ? Math.max(0, Math.floor(override.noByteRetries))
        : DEFAULT_CODEX_RESPONSE_TIMEOUT_POLICY.noByteRetries,
    retryBackoffMs:
      override?.retryBackoffMs !== undefined &&
      Number.isFinite(override.retryBackoffMs) &&
      override.retryBackoffMs >= 0
        ? override.retryBackoffMs
        : DEFAULT_CODEX_RESPONSE_TIMEOUT_POLICY.retryBackoffMs,
  };
}

export class CodexResponseTimeoutError extends Error {
  readonly code = CODEX_RESPONSE_TIMEOUT_ERROR_TYPE;
  readonly type = CODEX_RESPONSE_TIMEOUT_ERROR_TYPE;

  constructor(
    readonly timeoutClass: CodexResponseTimeoutClass,
    readonly requestId: string,
    readonly responseObserved: boolean,
    message = `Codex response ${timeoutClass.replaceAll("_", " ")} timed out`,
  ) {
    super(message);
    this.name = "CodexResponseTimeoutError";
  }
}

export type CodexResponseTimeoutInfo = {
  timeoutClass: CodexResponseTimeoutClass;
  requestId: string | null;
  responseObserved: boolean;
  message: string;
};

function timeoutClass(value: unknown): CodexResponseTimeoutClass | null {
  return value === "connect" ||
    value === "headers" ||
    value === "idle_stream" ||
    value === "whole_request"
    ? value
    : null;
}

/**
 * Recover structured transport timeouts through SDK wrapping. The optional
 * legacy match is deliberately opt-in: `Request timed out.` alone has no
 * provider provenance and the worker enables it only for a confirmed Codex
 * subscription turn.
 */
export function classifyCodexResponseTimeoutError(
  error: unknown,
  options: { allowLegacyRequestTimeout?: boolean } = {},
): CodexResponseTimeoutInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const value = current as Record<string, unknown>;
    const nested =
      value.error && typeof value.error === "object"
        ? (value.error as Record<string, unknown>)
        : undefined;
    const type =
      (typeof value.type === "string" ? value.type : undefined) ??
      (typeof value.code === "string" ? value.code : undefined) ??
      (typeof nested?.type === "string" ? nested.type : undefined) ??
      (typeof nested?.code === "string" ? nested.code : undefined);
    if (type === CODEX_RESPONSE_TIMEOUT_ERROR_TYPE || value.name === "CodexResponseTimeoutError") {
      const klass =
        timeoutClass(value.timeoutClass) ?? timeoutClass(nested?.timeout_class) ?? "headers";
      return {
        timeoutClass: klass,
        requestId:
          (typeof value.requestId === "string" ? value.requestId : undefined) ??
          (typeof nested?.request_id === "string" ? nested.request_id : null),
        responseObserved:
          typeof value.responseObserved === "boolean"
            ? value.responseObserved
            : nested?.response_observed === true,
        message:
          (typeof value.message === "string" ? value.message : undefined) ??
          (typeof nested?.message === "string" ? nested.message : "Codex response timed out"),
      };
    }
    current = value.cause;
  }

  if (options.allowLegacyRequestTimeout && error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (
      value.name === "APIConnectionTimeoutError" ||
      (value.message === "Request timed out." && value.name === "Error")
    ) {
      return {
        timeoutClass: "headers",
        requestId: null,
        responseObserved: false,
        message: String(value.message ?? "Request timed out."),
      };
    }
  }
  return null;
}

export function isPreHeadersTimeoutError(error: unknown): CodexResponseTimeoutClass | null {
  const structured = classifyCodexResponseTimeoutError(error);
  if (structured && !structured.responseObserved) {
    return structured.timeoutClass;
  }
  if (!error || typeof error !== "object") return null;
  const value = error as Record<string, unknown>;
  const code = typeof value.code === "string" ? value.code : "";
  const name = typeof value.name === "string" ? value.name : "";
  const message = typeof value.message === "string" ? value.message : String(error);
  if (/^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/i.test(code) || /ConnectTimeout/i.test(name)) {
    return "connect";
  }
  return /connect(?:ion)?[^.]*timed?\s*out/i.test(`${name} ${message}`) ? "connect" : null;
}
