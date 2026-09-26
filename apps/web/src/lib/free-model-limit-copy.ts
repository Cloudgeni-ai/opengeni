import type { ConnectableSubscriptions } from "./deployment-free-model";

/**
 * How connecting a model reads on this deployment. Only the subscriptions the
 * deployment enables are named; without either, the models settings still
 * offer provider accounts, so the remedy stays generic.
 */
export function freeModelConnectRemedy({ codex, supergrok }: ConnectableSubscriptions): {
  phrase: string;
  linkLabel: string;
} {
  if (codex && supergrok) {
    return { phrase: "connect ChatGPT or SuperGrok", linkLabel: "Connect a subscription" };
  }
  if (codex) return { phrase: "connect ChatGPT", linkLabel: "Connect ChatGPT" };
  if (supergrok) return { phrase: "connect SuperGrok", linkLabel: "Connect SuperGrok" };
  return { phrase: "connect a model provider", linkLabel: "Connect a model" };
}

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
  subscriptions,
  canChooseModel,
}: {
  /** Another model is already selected; the remedy has been chosen. */
  modelChanged: boolean;
  canBuyCredits: boolean;
  canConnectModel: boolean;
  /** Subscriptions this deployment offers; decides how the connect remedy reads. */
  subscriptions: ConnectableSubscriptions;
  /** The composer offers a model picker, even while it is briefly locked. */
  canChooseModel: boolean;
}): string {
  const headline = "The free model has reached its daily limit.";
  if (modelChanged) return headline;
  const remedies = [
    canBuyCredits ? "buy OpenGeni credits" : null,
    canConnectModel ? freeModelConnectRemedy(subscriptions).phrase : null,
    canChooseModel ? "pick another model" : null,
  ].filter((remedy): remedy is string => remedy !== null);
  if (remedies.length === 0) return `${headline} Try again after it resets.`;
  const last = remedies.pop()!;
  const list = remedies.length > 0 ? `${remedies.join(", ")}, or ${last}` : last;
  return `${headline} ${list.charAt(0).toUpperCase()}${list.slice(1)} to keep going.`;
}
