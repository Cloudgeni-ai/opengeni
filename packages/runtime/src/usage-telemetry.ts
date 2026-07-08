type UsageDetails = Record<string, unknown> | Array<Record<string, unknown>>;

export type ModelCallUsageTelemetry = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
};

export function modelCallUsageTelemetry(usage: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  inputTokensDetails?: UsageDetails | undefined;
  outputTokensDetails?: UsageDetails | undefined;
} | null | undefined): ModelCallUsageTelemetry {
  return {
    inputTokens: finiteNumberOrNull(usage?.inputTokens),
    outputTokens: finiteNumberOrNull(usage?.outputTokens),
    cachedTokens: usage ? firstPositiveDetailNumber(usage.inputTokensDetails, [
      "cached_tokens",
      "cachedInputTokens",
      "cached_input_tokens",
    ]) : null,
    reasoningTokens: usage ? firstPositiveDetailNumber(usage.outputTokensDetails, [
      "reasoning_tokens",
      "reasoningTokens",
      "reasoning_output_tokens",
    ]) : null,
  };
}

function firstPositiveDetailNumber(details: UsageDetails | undefined, keys: string[]): number | null {
  if (!details) {
    return null;
  }
  const entries = Array.isArray(details) ? details : [details];
  for (const entry of entries) {
    for (const key of keys) {
      const value = finiteNumberOrNull(entry[key]);
      if (value !== null && value > 0) {
        return value;
      }
    }
  }
  return null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
