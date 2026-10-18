/**
 * Bounded classification of the error underneath an operational failure, so a
 * 500 says which component refused it (the browser controller, the connected
 * machine, the database) instead of only "unexpected".
 *
 * Only reviewed closed values cross this boundary: an allowlisted error class
 * name, a closed interaction-controller error code, a connected-machine error
 * enum number, an HTTP status and a SQLSTATE. Never messages, stacks, paths,
 * identifiers or arbitrary `code` properties.
 */

/** Reviewed error classes whose names carry no data. Wrappers that only
 * translate another error into a response are skipped to reach the cause. */
export const PUBLIC_ERROR_CAUSE_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "ZodError",
  "PostgresError",
  "DrizzleQueryError",
  "BrowserControlRequestError",
  "BrowserControlProtocolError",
  "BrowserControlTransportError",
  "BrowserControlServerError",
  "BrowserControlUnsupportedError",
  "BrowserControlServerUnsupportedError",
  "BrowserSessionNotFoundError",
  "BrowserSessionOperationConflictError",
  "BrowserSessionStateError",
  "BrowserIdentityNotFoundError",
  "BrowserIdentityConflictError",
  "BrowserIdentityStateError",
  "BrowserStateUploadStateError",
  "ComputerSessionNotFoundError",
  "ComputerSessionOperationConflictError",
  "ComputerSessionStateError",
  "InteractionResourceNotFoundError",
  "InteractionResourceConflictError",
  "InteractionResourceStateError",
  "SelfhostedControlError",
  "SandboxProviderError",
]);

/** The interaction controller's closed error codes (contracts InteractionError). */
export const PUBLIC_INTERACTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "resource_not_found",
  "resource_unavailable",
  "controller_stale",
  "target_not_found",
  "target_stale",
  "observation_stale",
  "document_stale",
  "frame_stale",
  "locator_not_found",
  "locator_ambiguous",
  "unsupported",
  "permission_denied",
  "machine_locked",
  "capacity_exhausted",
  "attempt_stale",
  "operation_conflict",
  "outcome_unknown",
  "invalid_action",
  "timeout",
  "tab_not_responding",
  "tab_crashed",
  "controller_lost",
  "driver_failed",
]);

const WRAPPER_NAMES = new Set(["HTTPException", "ApiHttpError"]);
const SQLSTATE = /^[0-9A-Z]{5}$/;

export type ErrorCauseAttributes = {
  causeName?: string;
  causeCode?: string;
  causeAgentCode?: number;
  causeStatus?: number;
  causeSqlState?: string;
};

/** Classify the first non-wrapper error in a cause chain. */
export function errorCauseAttributes(error: unknown): ErrorCauseAttributes {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const name = reviewedName(current);
    if (name === null || !WRAPPER_NAMES.has(name)) return classify(current, name);
    current = ownValue(current, "cause");
  }
  return {};
}

/** Re-validate attributes at the log boundary; callers may pass anything. */
export function projectErrorCauseAttributes(
  attributes: Record<string, unknown>,
): ErrorCauseAttributes {
  const { causeName, causeCode, causeAgentCode, causeStatus, causeSqlState } = attributes;
  return {
    ...(typeof causeName === "string" && PUBLIC_ERROR_CAUSE_NAMES.has(causeName)
      ? { causeName }
      : {}),
    ...(typeof causeCode === "string" && PUBLIC_INTERACTION_ERROR_CODES.has(causeCode)
      ? { causeCode }
      : {}),
    ...(typeof causeAgentCode === "number" &&
    Number.isInteger(causeAgentCode) &&
    causeAgentCode >= 0 &&
    causeAgentCode <= 63
      ? { causeAgentCode }
      : {}),
    ...(typeof causeStatus === "number" &&
    Number.isInteger(causeStatus) &&
    causeStatus >= 100 &&
    causeStatus <= 599
      ? { causeStatus }
      : {}),
    ...(typeof causeSqlState === "string" && SQLSTATE.test(causeSqlState) ? { causeSqlState } : {}),
  };
}

function classify(error: object, name: string | null): ErrorCauseAttributes {
  if (name === null || !PUBLIC_ERROR_CAUSE_NAMES.has(name)) return {};
  const result: ErrorCauseAttributes = { causeName: name };
  const status = ownValue(error, "status");
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    result.causeStatus = status;
  }
  if (name === "BrowserControlRequestError") {
    const code = ownValue(ownValue(error, "error"), "code");
    if (typeof code === "string" && PUBLIC_INTERACTION_ERROR_CODES.has(code)) {
      result.causeCode = code;
    }
  }
  if (name === "SelfhostedControlError") {
    const code = ownValue(error, "code");
    if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 63) {
      result.causeAgentCode = code;
    }
  }
  if (name === "PostgresError") {
    const code = ownValue(error, "code");
    if (typeof code === "string" && SQLSTATE.test(code)) result.causeSqlState = code;
  }
  return result;
}

function reviewedName(error: object): string | null {
  const own = ownValue(error, "name");
  if (typeof own === "string" && (PUBLIC_ERROR_CAUSE_NAMES.has(own) || WRAPPER_NAMES.has(own))) {
    return own;
  }
  try {
    const constructorName = (Object.getPrototypeOf(error) as { constructor?: { name?: unknown } })
      ?.constructor?.name;
    if (
      typeof constructorName === "string" &&
      (PUBLIC_ERROR_CAUSE_NAMES.has(constructorName) || WRAPPER_NAMES.has(constructorName))
    ) {
      return constructorName;
    }
  } catch {
    /* Untrusted proxies contribute no type information. */
  }
  return typeof own === "string" ? own : null;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) return descriptor.value;
    // Class fields like `readonly name = "X"` are own; prototype getters are not read.
    return undefined;
  } catch {
    return undefined;
  }
}
