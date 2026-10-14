import type { CodexProviderRequestIdentity, CodexProviderRequestSettlement } from "@opengeni/codex";
import { fetchCodexUsage } from "@opengeni/codex";
import {
  buildSubscriptionCoreCodexOperationFetch,
  reserveSubscriptionCoreCodexTurnCredentialRequest,
  settleSubscriptionCoreCodexTurnCredentialRequest,
  SubscriptionCoreCodexRequestOutcomeUnknownError,
  type Database,
  type SubscriptionCoreTurnIdentity,
  type SubscriptionCoreCodexLeaseRef,
} from "@opengeni/db";
import { createCoreSubscriptionRequests } from "./subscription-core-requests";

export { providerRequestIdPrefix } from "./subscription-core-requests";

/** The usage probe is a finite read, authorized by this attempt's chat lease. */
export function buildCoreCodexUsageReader(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  ref: SubscriptionCoreCodexLeaseRef,
  execution: { attemptId: string; executionGeneration: number },
  fetchImpl?: Parameters<typeof buildSubscriptionCoreCodexOperationFetch>[4],
): typeof fetchCodexUsage {
  const physicalFetch = buildSubscriptionCoreCodexOperationFetch(
    db,
    { kind: "turn", identity },
    null,
    ref.connectionId,
    fetchImpl,
    {
      // There is no separate operation lease for a turn's usage precheck.
      // Keep exact-attempt/chat-lease authority, but classify the read as a
      // credential request: an unknown GET is not an unknown model response.
      // Reuse finite-body buffering and bounded timeout custody.
      reserve: (_db, _scope, _lease, _connection, request) =>
        reserveSubscriptionCoreCodexTurnCredentialRequest(db, identity, ref, {
          ...request,
          ...execution,
        }),
      settle: (_db, _scope, request) =>
        settleSubscriptionCoreCodexTurnCredentialRequest(db, identity, ref, {
          ...request,
          ...execution,
        }),
    },
  );
  return async (auth, _fetch, timeout) => {
    // The shared finite-read client normalizes transport errors. This native
    // admission refusal must survive that boundary instead of becoming a
    // retryable/rotatable usage-policy error. Keep it local to this probe.
    let unresolved: SubscriptionCoreCodexRequestOutcomeUnknownError | null = null;
    try {
      return await fetchCodexUsage(
        auth,
        async (url, init) => {
          try {
            return await physicalFetch(url, init);
          } catch (error) {
            if (error instanceof SubscriptionCoreCodexRequestOutcomeUnknownError)
              unresolved = error;
            throw error;
          }
        },
        timeout,
      );
    } catch (error) {
      throw unresolved ?? error;
    }
  };
}

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
