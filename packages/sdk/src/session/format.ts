/** JSON.parse that returns `undefined` for non-JSON or malformed input. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith('"')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export const CREDIT_EXHAUSTION_MESSAGE =
  "Out of OpenGeni credits — this workspace's balance is empty. Add credits to continue; the conversation is preserved.";

export function isCreditExhaustion(
  input: { error?: string | null; detail?: string | null; segmentLimit?: string | null } | string,
): boolean {
  if (typeof input === "string") {
    return input.toLowerCase().includes("insufficient opengeni credits");
  }
  if (input.segmentLimit === "budget_exhausted") return true;
  return [input.error, input.detail].some(
    (text) =>
      typeof text === "string" && text.toLowerCase().includes("insufficient opengeni credits"),
  );
}

export function humanizeFailureReason(reason: string | null): string | null {
  if (!reason) return reason;
  if (isCreditExhaustion(reason)) return CREDIT_EXHAUSTION_MESSAGE;
  const normalized = reason.toLowerCase();
  const authFailure =
    normalized.includes("incorrect api key") ||
    normalized.includes("invalid api key") ||
    normalized.includes("invalid_api_key") ||
    normalized.includes("platform.openai.com/account/api-keys") ||
    (normalized.includes("401") &&
      (normalized.includes("api key") || normalized.includes("unauthorized")));
  if (authFailure) {
    return "The model provider rejected this deployment's engine credentials. Sending messages won't help until the deployment's engine configuration is fixed.";
  }
  if (
    normalized.includes("insufficient_quota") ||
    normalized.includes("exceeded your current quota")
  ) {
    return "The model provider refused the request: this deployment's provider quota is exhausted.";
  }
  return reason;
}
