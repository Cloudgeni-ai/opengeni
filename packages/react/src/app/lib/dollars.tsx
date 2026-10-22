// Dollars a person types, as integer micros. Tiny and dependency-free on
// purpose: the chat route's usage-limit editor needs it, and importing it from
// the budget pages' module would make their lazy chunk a direct-session load.

export const MICROS_PER_DOLLAR = 1_000_000;
/** The largest amount the console accepts: $10M, far inside safe integers. */
export const MAX_BUDGET_MICROS = 10_000_000 * MICROS_PER_DOLLAR;

/** Dollars typed by a person ("500", "83.33", "$1,200") to integer micros, or null. */
export function parseDollars(text: string): number | null {
  const cleaned = text.replace(/[\s$,]/g, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(cleaned)) return null;
  const micros = Math.round(Number(cleaned) * MICROS_PER_DOLLAR);
  return Number.isSafeInteger(micros) && micros <= MAX_BUDGET_MICROS ? micros : null;
}
