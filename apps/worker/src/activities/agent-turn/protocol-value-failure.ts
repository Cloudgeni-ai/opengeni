export const UNSUPPORTED_PROTOCOL_VALUE_CODE = "unsupported_protocol_value";

export const UNSUPPORTED_PROTOCOL_VALUE_MESSAGE =
  "Opengeni couldn't prepare this conversation for the model. Send a new message to continue, or start a new chat if this keeps happening.";

/**
 * The turn failure for a value that could not be serialized, given that
 * refusal from the error's cause chain (a protocol JSON boundary's
 * rejection, or `JSON.stringify` throwing on a bigint or a cycle), or null
 * when there is none.
 *
 * The same value is refused again on a retry of the same turn, so the
 * failure is not retryable. It is a defect in how a turn's values are
 * prepared, not in the session: the turn ends with this copy and the session
 * takes the next message. The boundary's own message names the offending
 * path and stays on the event for diagnosis.
 */
export function unsupportedProtocolValueFailure(rejection: Error | null): {
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

/** `JSON.stringify` refusals in JavaScriptCore (Bun) and V8. */
const JSON_STRINGIFY_REFUSAL =
  /^(?:JSON\.stringify cannot serialize (?:BigInt|cyclic structures)\.|Do not know how to serialize a BigInt|Converting circular structure to JSON)/;

/**
 * A `JSON.stringify` refusal, or a refusal by the database's canonical JSON
 * encoder (which converts before it refuses, so this is a last resort),
 * anywhere in the error's cause chain.
 */
export function findJsonStringifyRefusal(error: unknown): TypeError | null {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    if (
      current instanceof TypeError &&
      (current.name === "UnsupportedCanonicalValueError" ||
        JSON_STRINGIFY_REFUSAL.test(current.message))
    ) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
