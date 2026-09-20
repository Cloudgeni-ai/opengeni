import type { SessionFailureSummary } from "./events";

/** Summarize recorded evidence without guessing a provider, expiry or reset time. */
export function failedSessionCopy(
  failure: SessionFailureSummary,
  creditExhausted = false,
  modelChanged = false,
) {
  const recorded = failure.reason?.replace(/\s+/g, " ").trim();
  // Require an explicit claim about the model itself, not e.g. its connection
  // or service being unavailable. Unknown errors retain their recorded wording.
  const unavailableModel =
    /\bmodel(?:\s+[`'"][^`'"]+[`'"])?\s+(?:(?:is|was)\s+)?(?:not supported|not available|unavailable|does not exist)\b/i.test(
      recorded ?? "",
    );
  const reason = creditExhausted
    ? "This workspace is out of OpenGeni credits."
    : failure.safetyRefusal
      ? "The model provider declined this request."
      : unavailableModel
        ? modelChanged
          ? "The previous model isn’t available."
          : "This model isn’t available. Choose another below."
        : recorded
          ? recorded.length > 160
            ? `${recorded.slice(0, 157)}…`
            : recorded
          : "This session failed.";
  return { reason, unavailableModel };
}
