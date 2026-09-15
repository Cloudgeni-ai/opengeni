/**
 * DISPLAY-ONLY General number formatting for spreadsheet canvas and a11y
 * labels. This is not numeric arithmetic and must never feed formula-bar /
 * cell-edit `input`, stored cells, formula results, or serialized exports.
 *
 * Policy for independent review:
 * IEEE-754 cannot represent many decimal fractions exactly, so values such as
 * `110.00000000000001` and `0.1 + 0.2` leak binary residue through `String(n)`.
 * General display therefore collapses a finite number to 15 significant decimal
 * digits — the same bound spreadsheet General uses — via
 * `String(Number(value.toPrecision(15)))`.
 *
 * That mapping yields `110` / `220` / `0.3` for the noisy cases while keeping
 * exponent-scale values (`1e-20`, `1e21`) and ~15-digit legitimate precision.
 * Integers stringify without a decimal; `-0` displays as `0`; non-finite
 * numbers, dates, booleans, errors, and strings keep their existing labels.
 *
 * Do not reuse `Intl.NumberFormat({ maximumFractionDigits: 12 })` from the
 * artifact-tool renderer: 12 fraction digits rounds `1e-20` to `0` and truncates
 * high-precision values that General should still show.
 */
export function formatSpreadsheetGeneralDisplay(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (Object.is(value, -0) || value === 0) return "0";
    if (!Number.isFinite(value)) return String(value);
    const rounded = Number(value.toPrecision(15));
    // Rounding at the finite IEEE-754 boundary can overflow. A display policy
    // must not turn a finite source into an infinity label.
    return String(Number.isFinite(rounded) ? rounded : value);
  }
  return String(value);
}

/** Exact edit/formula-bar source. Numbers stay `String(value)` with no General collapse. */
export function spreadsheetCellEditSource(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toLocaleDateString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}
