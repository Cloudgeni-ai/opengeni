import { UnsupportedProtocolJsonValueError } from "@opengeni/runtime";

export const UNSUPPORTED_PROTOCOL_VALUE_CODE = "unsupported_protocol_value";

export const UNSUPPORTED_PROTOCOL_VALUE_MESSAGE =
  "Opengeni couldn't prepare this conversation for the model. Send your message again, or start a new chat if this keeps happening.";

/**
 * The turn failure for a value that a protocol JSON boundary refused (a
 * symbol key, a function, a cycle, ...), or null for any other error.
 *
 * The same value is refused again on a retry of the same turn, so the
 * failure is not retryable. It is a defect in how a turn's values are
 * prepared, not in the session: the turn ends with this copy and the session
 * takes the next message. The boundary's own message names the offending
 * path and stays on the event for diagnosis.
 */
export function unsupportedProtocolValueFailure(error: unknown): {
  error: string;
  code: typeof UNSUPPORTED_PROTOCOL_VALUE_CODE;
  retryable: false;
  protocolValueError: string;
} | null {
  const rejection = findUnsupportedProtocolValue(error);
  if (!rejection) return null;
  return {
    error: UNSUPPORTED_PROTOCOL_VALUE_MESSAGE,
    code: UNSUPPORTED_PROTOCOL_VALUE_CODE,
    retryable: false,
    protocolValueError: rejection.message,
  };
}

function findUnsupportedProtocolValue(error: unknown): UnsupportedProtocolJsonValueError | null {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (current instanceof UnsupportedProtocolJsonValueError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
