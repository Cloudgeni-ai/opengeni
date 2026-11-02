import {
  createJsonSafeSummary,
  createJsonSafeWarning,
  toJsonSafeValue,
  type JsonSafeAdjustment,
} from "@opengeni/contracts/json-safe";

export type ProtocolJsonOptions = {
  /**
   * Receives every converted or dropped value instead of the default log
   * line. A boundary whose input is known to carry request-local values (for
   * example symbol-keyed marks on a turn's model input) passes its own.
   */
  onAdjustment?: (adjustment: JsonSafeAdjustment) => void;
};

/**
 * A protocol JSON boundary refused a value. Normalization itself converts
 * instead of refusing (see {@link normalizeProtocolJsonValue}); a stricter
 * boundary may still raise this, and a turn that meets it ends with a typed,
 * recoverable failure instead of failing the session.
 */
export class UnsupportedProtocolJsonValueError extends TypeError {
  override readonly name = "UnsupportedProtocolJsonValueError";

  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Protocol JSON value at ${path} ${detail}`);
  }
}

/**
 * Normalize a value received from a JavaScript SDK, a tool, an error or an
 * event into protocol JSON, the form that is stored and sent.
 *
 * A value that JSON cannot carry never fails the caller: it is converted or
 * dropped as `JSON.stringify` would (see `toJsonSafeValue`), and each change
 * is logged with its kind and a redacted path, never the value, at most once a
 * minute for the same root and kinds. Changes that lose nothing JSON carries
 * (an absent optional property, `-0`, a request-local symbol-keyed mark) are
 * not logged. Inputs are never mutated; already-valid graphs retain their
 * references.
 */
export function normalizeProtocolJsonValue<T>(
  value: T,
  rootPath = "$",
  options: ProtocolJsonOptions = {},
): T {
  if (options.onAdjustment) {
    return toJsonSafeValue(value, { rootPath, onAdjustment: options.onAdjustment });
  }
  const summary = createJsonSafeSummary();
  const normalized = toJsonSafeValue(value, { rootPath, onAdjustment: summary.onAdjustment });
  const adjusted = summary.result();
  if (adjusted) warnProtocolJsonAdjusted({ rootPath }, adjusted);
  return normalized;
}

const warnProtocolJsonAdjusted = createJsonSafeWarning("Protocol JSON value adjusted");
