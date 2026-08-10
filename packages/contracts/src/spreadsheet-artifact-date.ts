const ECMASCRIPT_DATE_MAX_MILLISECONDS = 8_640_000_000_000_000n;

/** Parses only the exact string form emitted by `Date.prototype.toISOString`. */
export function canonicalSpreadsheetDateMilliseconds(value: unknown): number {
  const milliseconds = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError("date must be canonical ISO");
  }
  return milliseconds;
}

/** Converts a signed wire integer to a canonical ISO instant without lossy coercion. */
export function canonicalSpreadsheetDateFromMilliseconds(milliseconds: bigint): string {
  if (
    milliseconds < -ECMASCRIPT_DATE_MAX_MILLISECONDS ||
    milliseconds > ECMASCRIPT_DATE_MAX_MILLISECONDS
  ) {
    throw new RangeError("date outside supported range");
  }
  return new Date(Number(milliseconds)).toISOString();
}
