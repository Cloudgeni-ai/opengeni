import type { UsageMeasures, UsagePayerId, UsageRange, UsageTokens } from "./usage-contract";

export const RANGES: ReadonlyArray<{ id: UsageRange; label: string; short: string }> = [
  { id: "today", label: "Today", short: "Today" },
  { id: "week", label: "Last 7 days", short: "7D" },
  { id: "30d", label: "Last 30 days", short: "30D" },
  { id: "month", label: "This month", short: "MTD" },
  { id: "90d", label: "Last 90 days", short: "90D" },
  { id: "ytd", label: "Year to date", short: "YTD" },
];

export function rangeLabel(range: UsageRange): string {
  return RANGES.find((option) => option.id === range)?.label ?? range;
}

export function priorLabel(range: UsageRange): string {
  switch (range) {
    case "today":
      return "yesterday";
    case "week":
      return "the 7 days before";
    case "30d":
      return "the 30 days before";
    case "90d":
      return "the 90 days before";
    case "month":
      return "last month to date";
    case "ytd":
      return "last year to date";
  }
}

export type TokenClassId = "uncachedInput" | "cacheRead" | "cacheWrite" | "output";

export const TOKEN_CLASSES: ReadonlyArray<{
  id: TokenClassId;
  label: string;
  short: string;
  /** Tailwind text-* (for fill/stroke currentColor) and bg-* classes. */
  text: string;
  bg: string;
  help: string;
}> = [
  {
    id: "uncachedInput",
    label: "Input",
    short: "Input",
    text: "text-chart-input",
    bg: "bg-chart-input",
    help: "New input the model read at the full input price.",
  },
  {
    id: "cacheRead",
    label: "Cache reads",
    short: "Cached",
    text: "text-chart-cache-read",
    bg: "bg-chart-cache-read",
    help: "Input read back from the prompt cache, usually at a tenth of the input price.",
  },
  {
    id: "cacheWrite",
    label: "Cache writes",
    short: "Cache writes",
    text: "text-chart-cache-write",
    bg: "bg-chart-cache-write",
    help: "Input written to the prompt cache. Some providers charge extra for it.",
  },
  {
    id: "output",
    label: "Output",
    short: "Output",
    text: "text-chart-output",
    bg: "bg-chart-output",
    help: "Text, tool calls and reasoning the model wrote.",
  },
];

export const SERIES_TONES = [
  { text: "text-chart-1", bg: "bg-chart-1" },
  { text: "text-chart-2", bg: "bg-chart-2" },
  { text: "text-chart-3", bg: "bg-chart-3" },
  { text: "text-chart-4", bg: "bg-chart-4" },
  { text: "text-chart-5", bg: "bg-chart-5" },
  { text: "text-chart-6", bg: "bg-chart-6" },
] as const;
export const OTHER_TONE = { text: "text-fg-subtle", bg: "bg-fg-subtle" } as const;

export function tokenTotal(tokens: UsageTokens): number {
  return tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}

export function inputTotal(tokens: UsageTokens): number {
  return tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite;
}

/** Share of input served from cache, or null when no call reported cache use. */
export function cacheHitRate(measures: UsageMeasures): number | null {
  if (measures.cacheKnownCalls === 0) return null;
  const input = inputTotal(measures.tokens);
  if (input <= 0) return null;
  return measures.tokens.cacheRead / input;
}

const PAYER_NAMES: Record<UsagePayerId, string> = {
  opengeni_credits: "Opengeni credits",
  subscription: "Plans",
  own_key: "Your API keys",
};

export function payerName(payer: UsagePayerId): string {
  return PAYER_NAMES[payer];
}

export const PAYER_IDS: readonly UsagePayerId[] = ["opengeni_credits", "subscription", "own_key"];

/**
 * What the usage cost. Credits count what was charged; plans and your own keys
 * count their list-price estimate, since nothing was charged here.
 */
export function costMicros(measures: UsageMeasures): number {
  const payers = measures.byPayer;
  if (payers) {
    const credits = payers.opengeni_credits;
    const external = (payers.subscription?.listMicros ?? 0) + (payers.own_key?.listMicros ?? 0);
    return (credits?.chargedMicros ?? 0) + external;
  }
  return Math.max(measures.chargedMicros, measures.listMicros);
}

/** True when any part of costMicros is a list-price estimate. */
export function costIsEstimate(measures: UsageMeasures): boolean {
  const payers = measures.byPayer;
  if (payers) return (payers.subscription?.calls ?? 0) + (payers.own_key?.calls ?? 0) > 0;
  return measures.chargedMicros < measures.listMicros;
}

/** No list price for any call: amounts would read as a misleading $0. */
export function costUnknown(measures: UsageMeasures): boolean {
  return measures.calls > 0 && measures.pricedCalls === 0 && measures.chargedMicros === 0;
}

export function usd(micros: number): number {
  return micros / 1_000_000;
}

export function formatMoney(micros: number, options: { compact?: boolean } = {}): string {
  const value = usd(micros);
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.0001) return "<$0.0001";
  if (options.compact && abs >= 10_000) {
    return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
  }
  const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: abs >= 1000 ? 0 : digits,
    maximumFractionDigits: abs >= 1000 ? 0 : digits,
  })}`;
}

export function formatMoneyAxis(micros: number): string {
  const value = usd(micros);
  if (value === 0) return "$0";
  if (Math.abs(value) >= 1000) {
    return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
  }
  if (Math.abs(value) >= 10) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toFixed(Math.abs(value % 1) < 1e-9 ? 0 : 2)}`;
}

export function formatCount(value: number): string {
  // Round first so 999,999 reads "1M", not "1000K".
  if (value >= 999_950_000) return `${trim(value / 1_000_000_000)}B`;
  if (value >= 999_950) return `${trim(value / 1_000_000)}M`;
  if (value >= 10_000) return `${trim(value / 1_000)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

export function formatPct(fraction: number | null, digits = 0): string {
  if (fraction === null || !Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  if (pct > 0 && pct < 1 && digits === 0) return "<1%";
  return `${pct.toFixed(digits)}%`;
}

/** Relative change, or null when there's nothing to compare against. */
export function relativeChange(current: number, prior: number | null | undefined): number | null {
  if (prior === null || prior === undefined || prior <= 0) return null;
  return (current - prior) / prior;
}

export function formatChange(change: number): string {
  const pct = change * 100;
  const rounded = Math.abs(pct) >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
}

export function formatBucket(start: string, bucket: "hour" | "day", long = false): string {
  const date = new Date(start);
  if (bucket === "hour") {
    return date.toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(long ? { weekday: "short" } : {}),
    timeZone: "UTC",
  });
}

export function formatUtc(value: string): string {
  return `${new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })} UTC`;
}
