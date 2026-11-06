import { dollarsInputValue, parseDollars } from "@/lib/usage-allowances";

/** Presentation input; the API remains the authority for billing limits. */
export type AutoTopUpValues = {
  enabled: boolean;
  thresholdMicros: number;
  amountMicros: number;
  monthlyCapMicros: number;
};

export type AutoTopUpDraft = {
  enabled: boolean;
  threshold: string;
  amount: string;
  monthlyCap: string;
};

export function autoTopUpDraft(settings: AutoTopUpValues): AutoTopUpDraft {
  return {
    enabled: settings.enabled,
    threshold: dollarsInputValue(settings.thresholdMicros),
    amount: dollarsInputValue(settings.amountMicros),
    monthlyCap: dollarsInputValue(settings.monthlyCapMicros),
  };
}

/** Keep only fields the person edited; untouched fields follow refreshed settings. */
export function reconcileAutoTopUpDraft(
  draft: AutoTopUpDraft,
  previous: AutoTopUpValues,
  next: AutoTopUpValues,
): AutoTopUpDraft {
  return {
    enabled: draft.enabled === previous.enabled ? next.enabled : draft.enabled,
    threshold:
      parseDollars(draft.threshold) === previous.thresholdMicros
        ? dollarsInputValue(next.thresholdMicros)
        : draft.threshold,
    amount:
      parseDollars(draft.amount) === previous.amountMicros
        ? dollarsInputValue(next.amountMicros)
        : draft.amount,
    monthlyCap:
      parseDollars(draft.monthlyCap) === previous.monthlyCapMicros
        ? dollarsInputValue(next.monthlyCapMicros)
        : draft.monthlyCap,
  };
}

export function parseAutoTopUpDraft(draft: AutoTopUpDraft): {
  values: AutoTopUpValues | null;
  errors: Partial<Record<"threshold" | "amount" | "monthlyCap", string>>;
} {
  const thresholdMicros = parseDollars(draft.threshold);
  const amountMicros = parseDollars(draft.amount);
  const monthlyCapMicros = parseDollars(draft.monthlyCap);
  const errors: Partial<Record<"threshold" | "amount" | "monthlyCap", string>> = {};
  if (thresholdMicros === null || thresholdMicros <= 0 || thresholdMicros > 10_000_000_000)
    errors.threshold = "Enter an amount above $0 and up to $10,000.";
  if (amountMicros === null || amountMicros < 5_000_000 || amountMicros > 10_000_000_000)
    errors.amount = "Enter an amount from $5 to $10,000.";
  if (monthlyCapMicros === null || monthlyCapMicros <= 0 || monthlyCapMicros > 10_000_000_000)
    errors.monthlyCap = "Enter a monthly limit up to $10,000.";
  else if (amountMicros !== null && monthlyCapMicros < amountMicros)
    errors.monthlyCap = "The monthly limit must cover at least one top-up.";
  return {
    values:
      Object.keys(errors).length === 0
        ? {
            enabled: draft.enabled,
            thresholdMicros: thresholdMicros!,
            amountMicros: amountMicros!,
            monthlyCapMicros: monthlyCapMicros!,
          }
        : null,
    errors,
  };
}

export function sameAutoTopUpValues(a: AutoTopUpValues, b: AutoTopUpValues): boolean {
  return (
    a.enabled === b.enabled &&
    a.thresholdMicros === b.thresholdMicros &&
    a.amountMicros === b.amountMicros &&
    a.monthlyCapMicros === b.monthlyCapMicros
  );
}
