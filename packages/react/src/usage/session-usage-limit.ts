// Per-task usage limits as a person reads them. Pure and React-free, so the
// timeline projection, the web console and native clients share one wording.
//
// Amounts are API-equivalent model usage (provider list-price estimate) in USD
// micros, not a bill. Unknown usage is never shown as $0: a task whose usage
// is still being prepared or can't be read says so in words instead.
import {
  formatSessionUsageMicros,
  type ParsedSessionUsageLimitReachedRefusal,
  type SessionUsageLimit,
} from "@opengeni/sdk/session-usage-limits";

/** Share of the limit at which a quiet, dismissible near-limit notice appears. */
export const SESSION_USAGE_LIMIT_NEAR_FRACTION = 0.8;

export type SessionUsageLimitLabels = {
  /** The setting's name: "Usage limit". */
  title: string;
  /** The one explanation, shown once next to the setting. */
  explanation: string;
  /** Short help: what the amount is not. */
  notYourBill: string;
  noLimit: string;
  /** "Pause at $50.00". */
  pauseAt: (limit: string) => string;
  /** "$12.34 of $50.00". */
  usedOfLimit: (used: string, limit: string) => string;
  /** "At least $12.34 of $50.00" when some usage has no known price. */
  atLeastOfLimit: (used: string, limit: string) => string;
  /** "$12.34 used" without a limit. */
  used: (used: string) => string;
  /** "At least $12.34 used". */
  atLeastUsed: (used: string) => string;
  preparing: string;
  unavailable: string;
  /** Notes under the amount when the total is incomplete. */
  unpricedNote: string;
  legacyNote: string;
  preparingNote: string;
  unavailableNote: string;
  /** A refresh failed after a good read: the last known amount is shown. */
  staleNote: string;
  reachedTitle: string;
  /** "$52.10 of $50.00 API-equivalent model usage." */
  reachedAmount: (amount: string) => string;
  reachedRemedy: string;
  /** Added when the goal paused at the limit: raising it never resumes by itself. */
  reachedGoalRemedy: string;
  /** Added to a read-only (child or no permission) reached notice. */
  reachedReadOnlyRemedy: string;
  /** "This task has used 84% of its usage limit ($42.00 of $50.00)." */
  near: (percent: string, amount: string) => string;
  changeLimit: string;
  openMainTask: string;
  dismiss: string;
};

export const DEFAULT_SESSION_USAGE_LIMIT_LABELS: SessionUsageLimitLabels = {
  title: "Usage limit",
  explanation:
    "API-equivalent model usage for this chat and its agents. In-progress requests may take usage above the limit.",
  notYourBill:
    "Estimated from model list prices, whoever pays for the model. It's not your bill and doesn't change your credits.",
  noLimit: "No limit",
  pauseAt: (limit) => `Pause at ${limit}`,
  usedOfLimit: (used, limit) => `${used} of ${limit}`,
  atLeastOfLimit: (used, limit) => `At least ${used} of ${limit}`,
  used: (used) => `${used} used`,
  atLeastUsed: (used) => `At least ${used} used`,
  preparing: "Preparing usage",
  unavailable: "Usage unavailable",
  unpricedNote: "Some model usage has no known price, so it isn't counted.",
  legacyNote: "This chat started before usage limits, so some earlier usage may be missing.",
  preparingNote: "Earlier usage is still being counted. You can set a limit when it's ready.",
  unavailableNote: "Couldn't read this chat's usage right now. A set limit still applies.",
  staleNote: "Couldn't refresh, so this may be out of date. The limit still applies.",
  reachedTitle: "Usage limit reached",
  reachedAmount: (amount) => `${amount} API-equivalent model usage.`,
  reachedRemedy: "Raise or remove the limit to continue.",
  reachedGoalRemedy: "Raise or remove the limit, then resume the goal.",
  reachedReadOnlyRemedy: "Someone who can run the main task can raise or remove its limit.",
  near: (percent, amount) => `This task has used ${percent}% of its usage limit (${amount}).`,
  changeLimit: "Change limit",
  openMainTask: "Open main task",
  dismiss: "Dismiss",
};

export function sessionUsageLimitLabels(
  overrides?: Partial<SessionUsageLimitLabels>,
): SessionUsageLimitLabels {
  return { ...DEFAULT_SESSION_USAGE_LIMIT_LABELS, ...overrides };
}

export type SessionUsageLimitState =
  | "unknown"
  | "unlimited"
  | "within"
  | "near"
  | "reached"
  | "preparing"
  | "unavailable";

export type SessionUsageLimitSummary = {
  state: SessionUsageLimitState;
  /** Configured limit, null for none or while unreadable. */
  limitMicros: number | null;
  /** Recorded known usage; null whenever it is not known (never $0 then). */
  usedMicros: number | null;
  /** Some usage is missing from the total: show "at least". */
  partial: boolean;
  /** Used share of the limit, clamped to 0..1 for a bar; null without both amounts. */
  barFraction: number | null;
  /** Unclamped share; may exceed 1 when in-progress requests overshot. */
  fraction: number | null;
  /** "$12.34 of $50.00", "At least $12.34 used", "Preparing usage", ... */
  amountText: string | null;
  /** Plain sentences explaining an incomplete or unreadable total. */
  notes: string[];
  inherited: boolean;
  rootSessionId: string | null;
  version: number | null;
  /** The last refresh failed: amounts are the last known ones, maybe out of date. */
  stale: boolean;
};

const UNKNOWN: SessionUsageLimitSummary = {
  state: "unknown",
  limitMicros: null,
  usedMicros: null,
  partial: false,
  barFraction: null,
  fraction: null,
  amountText: null,
  notes: [],
  inherited: false,
  rootSessionId: null,
  version: null,
  stale: false,
};

/**
 * Fold the server's usage-limit projection into what to show. `null` or
 * `undefined` (an older server, or not loaded yet) is `unknown`: render
 * nothing rather than "No limit" or "$0".
 */
export function summarizeSessionUsageLimit(
  usage: SessionUsageLimit | null | undefined,
  overrides?: Partial<SessionUsageLimitLabels>,
  options?: {
    /**
     * The last refresh failed after this projection was read. The amounts and
     * any reached state stay (never $0); a note says they may be out of date.
     */
    stale?: boolean;
  },
): SessionUsageLimitSummary {
  if (!usage) return UNKNOWN;
  const summary = summarizeFresh(usage, overrides);
  if (!options?.stale) return summary;
  const labels = sessionUsageLimitLabels(overrides);
  return { ...summary, stale: true, notes: [...summary.notes, labels.staleNote] };
}

function summarizeFresh(
  usage: SessionUsageLimit,
  overrides?: Partial<SessionUsageLimitLabels>,
): SessionUsageLimitSummary {
  const labels = sessionUsageLimitLabels(overrides);
  const base = {
    inherited: usage.inherited,
    rootSessionId: usage.rootSessionId,
    version: usage.version,
    stale: false,
  };
  if (usage.status === "unavailable") {
    return {
      ...UNKNOWN,
      ...base,
      state: "unavailable",
      amountText: labels.unavailable,
      notes: [labels.unavailableNote],
    };
  }
  if (usage.status === "preparing" || usage.usedMicros === null) {
    return {
      ...UNKNOWN,
      ...base,
      state: usage.status === "preparing" ? "preparing" : "unavailable",
      limitMicros: usage.limitMicros,
      amountText: usage.status === "preparing" ? labels.preparing : labels.unavailable,
      notes: [usage.status === "preparing" ? labels.preparingNote : labels.unavailableNote],
    };
  }
  const used = usage.usedMicros;
  const limit = usage.limitMicros;
  const legacy = usage.history === "legacy_partial";
  const unpriced = usage.unpricedCalls > 0;
  const partial = usage.coverage === "partial" || legacy || unpriced;
  const notes = [
    ...(unpriced ? [labels.unpricedNote] : []),
    ...(legacy ? [labels.legacyNote] : []),
  ];
  const usedText = formatSessionUsageMicros(used);
  if (limit === null) {
    return {
      ...base,
      state: "unlimited",
      limitMicros: null,
      usedMicros: used,
      partial,
      barFraction: null,
      fraction: null,
      amountText: partial ? labels.atLeastUsed(usedText) : labels.used(usedText),
      notes,
    };
  }
  const fraction = limit === 0 ? (used > 0 ? Infinity : 1) : used / limit;
  const reached = usage.status === "reached" || used >= limit;
  const limitText = formatSessionUsageMicros(limit);
  return {
    ...base,
    state: reached ? "reached" : fraction >= SESSION_USAGE_LIMIT_NEAR_FRACTION ? "near" : "within",
    limitMicros: limit,
    usedMicros: used,
    partial,
    barFraction: Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 1)),
    fraction: Number.isFinite(fraction) ? fraction : null,
    // Text keeps the real overshoot; only the bar is clamped.
    amountText: partial
      ? labels.atLeastOfLimit(usedText, limitText)
      : labels.usedOfLimit(usedText, limitText),
    notes,
  };
}

/**
 * A summary for a refused Send before the projection was re-read: the refusal
 * carries the amounts that applied when the server refused.
 */
export function summarizeSessionUsageLimitRefusal(
  refusal: Pick<
    ParsedSessionUsageLimitReachedRefusal,
    "limitMicros" | "usedMicros" | "rootSessionId"
  >,
  overrides?: Partial<SessionUsageLimitLabels>,
): SessionUsageLimitSummary {
  const labels = sessionUsageLimitLabels(overrides);
  return {
    ...UNKNOWN,
    state: "reached",
    limitMicros: refusal.limitMicros,
    usedMicros: refusal.usedMicros,
    barFraction: 1,
    fraction: refusal.limitMicros === 0 ? null : refusal.usedMicros / refusal.limitMicros,
    amountText: labels.usedOfLimit(
      formatSessionUsageMicros(refusal.usedMicros),
      formatSessionUsageMicros(refusal.limitMicros),
    ),
    rootSessionId: refusal.rootSessionId,
  };
}

/** "84" for 0.84; never rounds a near-limit share up to a misleading 100. */
export function sessionUsageLimitPercent(fraction: number): string {
  return String(Math.min(99, Math.floor(fraction * 100)));
}
