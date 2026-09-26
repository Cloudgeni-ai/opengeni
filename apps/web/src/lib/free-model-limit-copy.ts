/**
 * The deployment's free model (catalog `cost: "free"`) draws on one
 * deployment-funded daily allowance, so its daily limit is not something a
 * Retry or a provider top-up fixes. Name the free model and list only the
 * remedies this viewer can act on. Every other model keeps the generic
 * daily-limit wording from `failedSessionCopy`.
 *
 * Imported only by the lazily loaded failed-session banner, so the copy stays
 * out of the direct session bundle.
 */
export function freeModelDailyLimitReason({
  modelChanged,
  canBuyCredits,
  canConnectModel,
  canChooseModel,
}: {
  /** Another model is already selected; the remedy has been chosen. */
  modelChanged: boolean;
  canBuyCredits: boolean;
  canConnectModel: boolean;
  canChooseModel: boolean;
}): string {
  const headline = "The free model has reached its daily limit.";
  if (modelChanged) return headline;
  const remedies = [
    canBuyCredits ? "add OpenGeni credits" : null,
    canConnectModel ? "connect ChatGPT or SuperGrok" : null,
    canChooseModel ? "pick another model" : null,
  ].filter((remedy): remedy is string => remedy !== null);
  if (remedies.length === 0) return `${headline} Try again after it resets.`;
  const last = remedies.pop()!;
  const list = remedies.length > 0 ? `${remedies.join(", ")}, or ${last}` : last;
  return `${headline} ${list.charAt(0).toUpperCase()}${list.slice(1)} to keep going.`;
}
