// Usage allowances in the Opengeni console. Budgets here are paid from the
// organization's credit balance, which the console already shows in dollars
// (balance, top-ups, usage dashboard), so budgets and limits use the same unit:
// an owner compares "$500 a month" with "$1,240 available" without converting.
// Members still see shares first ("38% left"), with the amount alongside.
import type { UsageAmountFormat } from "@opengeni/react/usage";

import { MICROS_PER_DOLLAR, parseDollars } from "@/lib/dollars";
import { formatMoneyMicros } from "@/lib/format";

export { MAX_BUDGET_MICROS, parseDollars } from "@/lib/dollars";

export function formatCredits(micros: number): string {
  return formatMoneyMicros(micros, "usd");
}

/** "$500" for whole dollars, "$83.33" otherwise: budgets read as round numbers. */
export function formatBudget(micros: number): string {
  if (micros % MICROS_PER_DOLLAR === 0) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(micros / MICROS_PER_DOLLAR);
  }
  return formatCredits(micros);
}

/** Plain dollars for an input's value ("500", "83.33"), no symbol or grouping. */
export function dollarsInputValue(micros: number): string {
  const dollars = micros / MICROS_PER_DOLLAR;
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

export const CONSOLE_USAGE_AMOUNTS: UsageAmountFormat = {
  format: formatCredits,
  parse: parseDollars,
  prefix: "$",
  step: 0.01,
};

/** "1st", "2nd", "31st". */
export function ordinalDay(day: number): string {
  const tens = day % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  return `${day}${suffix}`;
}

export { CONSOLE_ALLOWANCE_LABELS, CONSOLE_TIMELINE_ALLOWANCE_LABELS } from "./allowance-labels";
