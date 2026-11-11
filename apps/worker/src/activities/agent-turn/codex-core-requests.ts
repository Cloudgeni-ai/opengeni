import type { CodexProviderRequestIdentity, CodexProviderRequestSettlement } from "@opengeni/codex";
import { SubscriptionCoreCodexRequestOutcomeUnknownError } from "@opengeni/db";
import { createCoreSubscriptionRequests } from "./subscription-core-requests";

export { providerRequestIdPrefix } from "./subscription-core-requests";

/** One attempt's bounded Codex request custody (the shared custody, Codex errors). */
export function createCoreCodexRequests(deps: {
  reserve: (request: CodexProviderRequestIdentity) => Promise<{ operationId: string }>;
  settle: (request: {
    operationId: string;
    outcome: CodexProviderRequestSettlement["outcome"];
  }) => Promise<void>;
}) {
  return createCoreSubscriptionRequests({
    ...deps,
    displayName: "Codex",
    outcomeUnknown: () => new SubscriptionCoreCodexRequestOutcomeUnknownError(),
    isOutcomeUnknown: (error) => error instanceof SubscriptionCoreCodexRequestOutcomeUnknownError,
  });
}
