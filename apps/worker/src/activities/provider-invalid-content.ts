/**
 * Narrow, secret-safe classification for the Responses SSE invalid-content
 * failure observed in OPE-13.
 *
 * OpenAI SDK 6.47 constructs this error after an accepted SSE response emits a
 * `data.error` frame. The resulting object is status-less, has
 * `constructor.name === "APIError"` (while `error.name` remains `"Error"`), and
 * exposes the response request ID as `requestID`. Arbitrary nested provider
 * data is deliberately ignored because it may contain prompts, tool output,
 * headers, or credentials.
 */
export const PROVIDER_INVALID_CONTENT_CODE = "provider_invalid_content" as const;
export const PROVIDER_INVALID_CONTENT_PHASE = "responses_stream" as const;
export const PROVIDER_INVALID_CONTENT_API = "responses" as const;

const INVALID_CONTENT_PREFIX = "The model produced invalid content.";
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ERROR_SCALAR_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 4_096;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;
const SAFE_ERROR_SCALAR = /^[A-Za-z0-9._:-]+$/;
const REQUEST_ID_SUFFIXES = [
  /^The model produced invalid content\. Request ID: ([A-Za-z0-9._:-]+)\.?$/,
  /^The model produced invalid content\. \(request id: ([A-Za-z0-9._:-]+)\)$/,
] as const;

export type ProviderInvalidContentDiagnostic = Readonly<{
  code: typeof PROVIDER_INVALID_CONTENT_CODE;
  phase: typeof PROVIDER_INVALID_CONTENT_PHASE;
  api: typeof PROVIDER_INVALID_CONTENT_API;
  sdkErrorName: "APIError";
  httpStatus: null;
  providerRequestId: string;
  providerErrorType?: string;
  providerErrorCode?: string;
  providerErrorParam?: string;
}>;

export type ProviderInvalidContentFailurePayload = Readonly<{
  error: string;
  code: typeof PROVIDER_INVALID_CONTENT_CODE;
  retryable: false;
  phase: typeof PROVIDER_INVALID_CONTENT_PHASE;
  api: typeof PROVIDER_INVALID_CONTENT_API;
  sdkErrorName: "APIError";
  httpStatus: null;
  providerRequestId: string;
  providerErrorType?: string;
  providerErrorCode?: string;
  providerErrorParam?: string;
}>;

function safeRead(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function safeScalar(
  value: object,
  key: PropertyKey,
  maxLength: number,
  pattern: RegExp,
): string | null {
  const candidate = safeRead(value, key);
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > maxLength ||
    !pattern.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function safeConstructorName(value: object): string | null {
  const constructor = safeRead(value, "constructor");
  return constructor && (typeof constructor === "object" || typeof constructor === "function")
    ? safeScalar(constructor, "name", MAX_ERROR_SCALAR_LENGTH, SAFE_ERROR_SCALAR)
    : null;
}

function isStatuslessApiError(value: unknown): value is Error & Record<string, unknown> {
  try {
    if (!(value instanceof Error) || typeof value !== "object" || value === null) return false;
    if (safeRead(value, "status") !== undefined) return false;
    // `constructor.name` is the real SDK 6.47 surface. The `.name` fallback
    // preserves structurally wrapped APIErrors without depending on one exact
    // installed OpenAI package identity.
    return (
      safeConstructorName(value) === "APIError" ||
      safeScalar(value, "name", MAX_ERROR_SCALAR_LENGTH, SAFE_ERROR_SCALAR) === "APIError"
    );
  } catch {
    // A hostile Proxy/Symbol.hasInstance must never make diagnostics throw.
    return false;
  }
}

function safeHeaderRequestId(value: object): string | null {
  const headers = safeRead(value, "headers");
  if (!headers || typeof headers !== "object") return null;

  const get = safeRead(headers, "get");
  if (typeof get === "function") {
    try {
      const requestId = Reflect.apply(get, headers, ["x-request-id"]);
      if (
        typeof requestId === "string" &&
        requestId.length > 0 &&
        requestId.length <= MAX_REQUEST_ID_LENGTH &&
        SAFE_REQUEST_ID.test(requestId)
      ) {
        return requestId;
      }
    } catch {
      // Fall through to a plain-record lookup.
    }
  }

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(headers);
  } catch {
    return null;
  }
  const requestIdKey = keys.find(
    (key) => typeof key === "string" && key.toLowerCase() === "x-request-id",
  );
  return requestIdKey
    ? safeScalar(headers, requestIdKey, MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID)
    : null;
}

function requestIdFromExactMessageSuffix(message: string): string | null {
  for (const pattern of REQUEST_ID_SUFFIXES) {
    const candidate = pattern.exec(message)?.[1];
    if (candidate && candidate.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Recognize only a status-less Responses streaming APIError with the exact
 * invalid-content prefix and a bounded request ID. No request ID means no
 * classification: fail closed rather than infer acceptance from arbitrary
 * provider prose.
 */
export function classifyProviderInvalidContentError(
  error: unknown,
): ProviderInvalidContentDiagnostic | null {
  if (!isStatuslessApiError(error)) return null;

  const message = safeScalar(error, "message", MAX_MESSAGE_LENGTH, /^[\s\S]+$/);
  if (!message?.startsWith(INVALID_CONTENT_PREFIX)) return null;

  const providerRequestId =
    safeScalar(error, "requestID", MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID) ??
    safeScalar(error, "requestId", MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID) ??
    safeHeaderRequestId(error) ??
    requestIdFromExactMessageSuffix(message);
  if (!providerRequestId) return null;

  const providerErrorType = safeScalar(error, "type", MAX_ERROR_SCALAR_LENGTH, SAFE_ERROR_SCALAR);
  const providerErrorCode = safeScalar(error, "code", MAX_ERROR_SCALAR_LENGTH, SAFE_ERROR_SCALAR);
  const providerErrorParam = safeScalar(error, "param", MAX_ERROR_SCALAR_LENGTH, SAFE_ERROR_SCALAR);

  return {
    code: PROVIDER_INVALID_CONTENT_CODE,
    phase: PROVIDER_INVALID_CONTENT_PHASE,
    api: PROVIDER_INVALID_CONTENT_API,
    sdkErrorName: "APIError",
    httpStatus: null,
    providerRequestId,
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
    ...(providerErrorParam ? { providerErrorParam } : {}),
  };
}

/** Product-owned text plus allow-listed scalar diagnostics only. */
export function providerInvalidContentFailurePayload(
  diagnostic: ProviderInvalidContentDiagnostic,
): ProviderInvalidContentFailurePayload {
  return {
    error:
      "The model provider produced invalid content after accepting the request. The accepted provider call was not replayed.",
    ...diagnostic,
    retryable: false,
  };
}
