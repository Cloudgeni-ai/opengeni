/**
 * A narrow, forensic classifier for the Responses streaming invalid-content
 * error. This is intentionally NOT a generic provider-error parser: nested
 * provider payloads can contain prompts, tool output, headers, or credentials.
 *
 * The known shape is a status-less SDK `APIError` emitted after the provider
 * accepted a Responses streaming request. The message is used only as an exact
 * discriminator and is never returned, logged, or persisted.
 */
export const PROVIDER_INVALID_CONTENT_CODE = "provider_invalid_content" as const;
export const PROVIDER_INVALID_CONTENT_PHASE = "responses_stream" as const;
export const PROVIDER_INVALID_CONTENT_API = "responses" as const;

const INVALID_CONTENT_PREFIX = "The model produced invalid content.";
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ERROR_SCALAR_LENGTH = 64;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;
const SAFE_ERROR_SCALAR = /^[A-Za-z0-9._:-]+$/;
const REQUEST_ID_MESSAGE_SUFFIX = /(?:^|\s)Request ID:\s*([A-Za-z0-9._:-]{1,128})\s*$/;

export type ProviderInvalidContentDiagnostic = Readonly<{
  code: typeof PROVIDER_INVALID_CONTENT_CODE;
  phase: typeof PROVIDER_INVALID_CONTENT_PHASE;
  api: typeof PROVIDER_INVALID_CONTENT_API;
  providerRequestId: string;
  providerErrorType?: string;
  providerErrorCode?: string;
}>;

export type ProviderInvalidContentFailurePayload = Readonly<{
  error: string;
  code: typeof PROVIDER_INVALID_CONTENT_CODE;
  retryable: false;
  phase: typeof PROVIDER_INVALID_CONTENT_PHASE;
  api: typeof PROVIDER_INVALID_CONTENT_API;
  providerRequestId: string;
  providerErrorType?: string;
  providerErrorCode?: string;
}>;

export type ProviderInvalidContentRecoveryPlan = Readonly<{
  sessionStatus: "idle" | "failed";
  activityStatus: "idle" | "failed";
  recovery: "goal_continuation" | "user_message";
  continueDelayMs?: number;
}>;

function ownSafeScalar(
  value: object,
  key: string,
  maxLength: number,
  pattern: RegExp,
): string | null {
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return null;
    }
    const candidate = Reflect.get(value, key);
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > maxLength ||
      !pattern.test(candidate)
    ) {
      return null;
    }
    return candidate;
  } catch {
    // Error-like values can use hostile getters or proxies. A diagnostic path
    // must never turn an already-recoverable provider failure into a throw.
    return null;
  }
}

function safeRequestIdFromHeaders(value: object): string | null {
  let headers: unknown;
  try {
    headers = Reflect.get(value, "headers");
  } catch {
    return null;
  }
  if (typeof headers !== "object" || headers === null) {
    return null;
  }

  // Plain SDK header records are not guaranteed to preserve casing. Inspect
  // own KEY NAMES only (never values), with a hard bound, and read the one
  // allow-listed field through the same hostile-getter-safe scalar helper.
  try {
    const keys = Object.getOwnPropertyNames(headers);
    if (keys.length <= 64) {
      const requestIdKey = keys.find(
        (key) => key.length <= 64 && key.toLowerCase() === "x-request-id",
      );
      if (requestIdKey) {
        const candidate = ownSafeScalar(
          headers,
          requestIdKey,
          MAX_REQUEST_ID_LENGTH,
          SAFE_REQUEST_ID,
        );
        if (candidate) {
          return candidate;
        }
      }
    }
  } catch {
    // Proxies may reject ownKeys/getOwnPropertyDescriptor. Fall through to the
    // WHATWG Headers path, which is separately bounded and guarded.
  }

  // The OpenAI SDK can expose a WHATWG Headers instance. Read one allow-listed
  // key only; never enumerate or serialize the complete provider headers.
  try {
    const get = Reflect.get(headers, "get");
    if (typeof get !== "function") {
      return null;
    }
    const candidate = Reflect.apply(get, headers, ["x-request-id"]);
    return typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate.length <= MAX_REQUEST_ID_LENGTH &&
      SAFE_REQUEST_ID.test(candidate)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function safeRequestIdFromMessageSuffix(message: string): string | null {
  const match = REQUEST_ID_MESSAGE_SUFFIX.exec(message);
  return match?.[1] ?? null;
}

function isStatuslessApiError(value: unknown): value is Error & Record<string, unknown> {
  try {
    return (
      value instanceof Error &&
      value.name === "APIError" &&
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "status") === undefined
    );
  } catch {
    return false;
  }
}

/**
 * Recognize only the documented status-less Responses streaming APIError shape.
 * No request ID means no match: we fail closed rather than guessing from a
 * message that could also describe malformed local tool/history input.
 */
export function classifyProviderInvalidContentError(
  error: unknown,
): ProviderInvalidContentDiagnostic | null {
  if (!isStatuslessApiError(error)) {
    return null;
  }
  const message = ownSafeScalar(error, "message", 4_096, /^[\s\S]+$/);
  if (!message?.startsWith(INVALID_CONTENT_PREFIX)) {
    return null;
  }
  const providerRequestId =
    ownSafeScalar(error, "request_id", MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID) ??
    ownSafeScalar(error, "requestID", MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID) ??
    ownSafeScalar(error, "requestId", MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID) ??
    safeRequestIdFromHeaders(error) ??
    safeRequestIdFromMessageSuffix(message);
  if (!providerRequestId) {
    return null;
  }
  const providerErrorType = ownSafeScalar(
    error,
    "type",
    MAX_ERROR_SCALAR_LENGTH,
    SAFE_ERROR_SCALAR,
  );
  const providerErrorCode = ownSafeScalar(
    error,
    "code",
    MAX_ERROR_SCALAR_LENGTH,
    SAFE_ERROR_SCALAR,
  );
  return {
    code: PROVIDER_INVALID_CONTENT_CODE,
    phase: PROVIDER_INVALID_CONTENT_PHASE,
    api: PROVIDER_INVALID_CONTENT_API,
    providerRequestId,
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
  };
}

/**
 * Build the durable/public failure fields without copying raw provider text or
 * payload. The sentence is product-owned; diagnostics are already bounded and
 * allow-listed by `classifyProviderInvalidContentError`.
 */
export function providerInvalidContentFailurePayload(
  diagnostic: ProviderInvalidContentDiagnostic,
): ProviderInvalidContentFailurePayload {
  return {
    error:
      "The model provider produced invalid content after accepting the request. OpenGeni stopped this turn without replaying the provider request; a new turn is required to continue.",
    code: diagnostic.code,
    retryable: false,
    phase: diagnostic.phase,
    api: diagnostic.api,
    providerRequestId: diagnostic.providerRequestId,
    ...(diagnostic.providerErrorType ? { providerErrorType: diagnostic.providerErrorType } : {}),
    ...(diagnostic.providerErrorCode ? { providerErrorCode: diagnostic.providerErrorCode } : {}),
  };
}

/**
 * A failed final checkpoint is not a retry ticket. It makes the session
 * recoverably failed so the workflow cannot synthesize an active-goal turn
 * from incomplete conversation truth. A later user message is the explicit
 * revival boundary. Successful checkpoints may continue only as a new turn.
 */
export function providerInvalidContentRecoveryPlan(input: {
  checkpointSucceeded: boolean;
  goalActive: boolean;
  continuationDelayMs: number;
}): ProviderInvalidContentRecoveryPlan {
  if (!input.checkpointSucceeded) {
    return {
      sessionStatus: "failed",
      activityStatus: "failed",
      recovery: "user_message",
    };
  }
  if (input.goalActive) {
    return {
      sessionStatus: "idle",
      activityStatus: "idle",
      recovery: "goal_continuation",
      continueDelayMs: input.continuationDelayMs,
    };
  }
  return {
    sessionStatus: "idle",
    activityStatus: "idle",
    recovery: "user_message",
  };
}
