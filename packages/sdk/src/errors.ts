import type { SessionSpawnDenial } from "./types";

/** Error for a non-2xx OpenGeni API response. */
export class OpenGeniApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(status: number, body: string) {
    const parsed = parseErrorEnvelope(body);
    // Preserve the historical message/body surface for all existing callers;
    // typed envelope fields are additive and must not rewrite unrelated errors.
    super(`OpenGeni API ${status}: ${body || "(empty body)"}`);
    this.name = "OpenGeniApiError";
    this.status = status;
    this.body = body;
    this.code = parsed?.code ?? null;
    this.details = parsed?.details ?? null;
  }
}

/**
 * Discriminated error for a complete, server-authored nested-session denial.
 * The factory emits this subclass only after validating every denial field;
 * malformed/unrelated envelopes remain generic OpenGeniApiError instances.
 */
export class SessionSpawnDeniedError extends OpenGeniApiError {
  declare readonly code: SessionSpawnDenial["code"];
  declare readonly details: { denial: SessionSpawnDenial };
  readonly denial: SessionSpawnDenial;

  constructor(status: number, body: string, denial: SessionSpawnDenial) {
    super(status, body);
    this.name = "SessionSpawnDeniedError";
    this.code = denial.code;
    this.details = { denial };
    this.denial = denial;
  }
}

/** Construct the most specific validated API error for a response body. */
export function createOpenGeniApiError(status: number, body: string): OpenGeniApiError {
  const parsed = parseErrorEnvelope(body);
  const denial =
    status === 403 || status === 409 ? parseSessionSpawnDenial(parsed?.details?.["denial"]) : null;
  const statusMatchesCode =
    (status === 409 && denial?.code === "nested_agent_depth_exceeded") ||
    (status === 403 && denial?.code === "nested_agent_depth_override_forbidden");
  if (denial && parsed?.code === denial.code && statusMatchesCode) {
    return new SessionSpawnDeniedError(status, body, denial);
  }
  return new OpenGeniApiError(status, body);
}

function parseErrorEnvelope(
  body: string,
): { code: string; message: string; details: Record<string, unknown> | null } | null {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object") return null;
    const error = (value as Record<string, unknown>)["error"];
    if (!error || typeof error !== "object") return null;
    const record = error as Record<string, unknown>;
    if (typeof record["code"] !== "string" || typeof record["message"] !== "string") return null;
    const details = record["details"];
    return {
      code: record["code"],
      message: record["message"],
      details: details && typeof details === "object" ? (details as Record<string, unknown>) : null,
    };
  } catch {
    return null;
  }
}

function parseSessionSpawnDenial(value: unknown): SessionSpawnDenial | null {
  if (!isRecord(value)) return null;
  const code = value["code"];
  const policySource = value["policySource"];
  if (
    (code !== "nested_agent_depth_exceeded" && code !== "nested_agent_depth_override_forbidden") ||
    (policySource !== "session" &&
      policySource !== "workspace" &&
      policySource !== "deployment" &&
      policySource !== "default") ||
    !isString(value["id"]) ||
    !isString(value["accountId"]) ||
    !isString(value["workspaceId"]) ||
    !isNullableString(value["parentSessionId"]) ||
    !isNullableString(value["rootSessionId"]) ||
    !isNonNegativeInteger(value["currentDepth"]) ||
    !isNonNegativeInteger(value["attemptedDepth"]) ||
    !isNonNegativeInteger(value["effectiveMaxNestedAgentDepth"]) ||
    !isNullableNonNegativeInteger(value["requestedMaxNestedAgentDepthOverride"]) ||
    !isNullableString(value["policySessionId"]) ||
    !isNullableString(value["subjectId"]) ||
    !isNullableString(value["idempotencyKey"]) ||
    !isString(value["createdAt"])
  ) {
    return null;
  }
  return {
    id: value["id"],
    accountId: value["accountId"],
    workspaceId: value["workspaceId"],
    parentSessionId: value["parentSessionId"],
    rootSessionId: value["rootSessionId"],
    currentDepth: value["currentDepth"],
    attemptedDepth: value["attemptedDepth"],
    effectiveMaxNestedAgentDepth: value["effectiveMaxNestedAgentDepth"],
    requestedMaxNestedAgentDepthOverride: value["requestedMaxNestedAgentDepthOverride"],
    policySource,
    policySessionId: value["policySessionId"],
    subjectId: value["subjectId"],
    code,
    idempotencyKey: value["idempotencyKey"],
    createdAt: value["createdAt"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

/** The browser bundle and API disagree about their state-changing wire contract. */
export class OpenGeniApiContractMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`OpenGeni API contract mismatch: client expects ${expected}, API serves ${actual}`);
    this.name = "OpenGeniApiContractMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Error for an unrecoverable event-stream condition (not a transient drop). */
export class OpenGeniStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenGeniStreamError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/**
 * Transient conditions worth a reconnect: network-level failures (`fetch`
 * rejects with `TypeError`) and HTTP statuses that signal a temporary server
 * or contention condition. Auth/validation failures (401/403/404/...) are
 * permanent and surface to the caller instead.
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (error instanceof OpenGeniApiError) {
    return (
      error.status === 408 ||
      error.status === 409 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  return error instanceof TypeError;
}
