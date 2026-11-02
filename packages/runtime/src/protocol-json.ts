import {
  summarizeJsonSafeAdjustments,
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
 * is logged with its path. Absent optional properties (`undefined`) are
 * omitted silently, as on every JSON wire. Inputs are never mutated;
 * already-valid graphs retain their references.
 */
export function normalizeProtocolJsonValue<T>(
  value: T,
  rootPath = "$",
  options: ProtocolJsonOptions = {},
): T {
  if (options.onAdjustment) {
    return toJsonSafeValue(value, { rootPath, onAdjustment: options.onAdjustment });
  }
  const adjustments: JsonSafeAdjustment[] = [];
  const normalized = toJsonSafeValue(value, {
    rootPath,
    onAdjustment: (adjustment) => adjustments.push(adjustment),
  });
  if (adjustments.length > 0) {
    // Paths and kinds only: never the values, which may be private.
    console.warn("Protocol JSON value adjusted", {
      rootPath,
      ...summarizeJsonSafeAdjustments(adjustments),
    });
  }
  return normalized;
}
