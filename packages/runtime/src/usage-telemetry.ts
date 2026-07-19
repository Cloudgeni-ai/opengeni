type UsageDetails = Record<string, unknown> | Array<Record<string, unknown>>;

export type ModelCallUsageTelemetry = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

export function modelCallUsageTelemetry(
  usage:
    | {
        inputTokens?: unknown;
        outputTokens?: unknown;
        inputTokensDetails?: UsageDetails | undefined;
        outputTokensDetails?: UsageDetails | undefined;
      }
    | null
    | undefined,
): ModelCallUsageTelemetry {
  return {
    inputTokens: finiteNumberOrNull(usage?.inputTokens),
    outputTokens: finiteNumberOrNull(usage?.outputTokens),
    cachedTokens: usage
      ? firstPositiveDetailNumber(usage.inputTokensDetails, [
          "cached_tokens",
          "cachedInputTokens",
          "cached_input_tokens",
        ])
      : null,
    cacheWriteTokens: usage
      ? firstPositiveDetailNumber(usage.inputTokensDetails, [
          "cache_write_tokens",
          "cacheWriteTokens",
        ])
      : null,
    reasoningTokens: usage
      ? firstPositiveDetailNumber(usage.outputTokensDetails, [
          "reasoning_tokens",
          "reasoningTokens",
          "reasoning_output_tokens",
        ])
      : null,
  };
}

function firstPositiveDetailNumber(
  details: UsageDetails | undefined,
  keys: string[],
): number | null {
  if (!details) {
    return null;
  }
  // A reported 0 is REAL DATA ("the provider cached/reasoned nothing"), not
  // absence — the old >0-only filter recorded wire `cached_tokens: 0` as null,
  // making "0% cached" indistinguishable from "no telemetry" (which is exactly
  // how 10k+ genuinely-uncached Azure calls masqueraded as a telemetry gap).
  // Prefer the first positive value across entries (multi-entry detail arrays
  // may carry zero placeholders next to the real number), but if every entry
  // says 0, report 0.
  const entries = Array.isArray(details) ? details : [details];
  let sawZero = false;
  for (const entry of entries) {
    for (const key of keys) {
      const value = finiteNumberOrNull(entry[key]);
      if (value !== null && value > 0) {
        return value;
      }
      if (value === 0) {
        sawZero = true;
      }
    }
  }
  return sawZero ? 0 : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
