import type { UnsupportedProtocolJsonValueError } from "@opengeni/runtime";

export const UNSUPPORTED_PROTOCOL_VALUE_CODE = "unsupported_protocol_value";

export const UNSUPPORTED_PROTOCOL_VALUE_MESSAGE =
  "Opengeni couldn't prepare this conversation for the model. Send a new message to continue, or start a new chat if this keeps happening.";

/**
 * The turn failure for a value that a protocol JSON boundary refused (a
 * symbol key, a function, a cycle, ...), given that refusal from the error's
 * cause chain, or null when there is none.
 *
 * The same value is refused again on a retry of the same turn, so the
 * failure is not retryable. It is a defect in how a turn's values are
 * prepared, not in the session: the turn ends with this copy and the session
 * takes the next message. The boundary's own message names the offending
 * path and stays on the event for diagnosis.
 */
export function unsupportedProtocolValueFailure(
  rejection: UnsupportedProtocolJsonValueError | null,
): {
  error: string;
  code: typeof UNSUPPORTED_PROTOCOL_VALUE_CODE;
  retryable: false;
  protocolValueError: string;
} | null {
  if (!rejection) return null;
  return {
    error: UNSUPPORTED_PROTOCOL_VALUE_MESSAGE,
    code: UNSUPPORTED_PROTOCOL_VALUE_CODE,
    retryable: false,
    protocolValueError: rejection.message,
  };
}
