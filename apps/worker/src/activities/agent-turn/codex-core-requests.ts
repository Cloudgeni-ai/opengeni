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

/**
 * Prefix for this activity execution's physical model request IDs.
 *
 * Request reservations are unique per account, so an ID must not repeat across
 * turns or executions. A Temporal activity ID is unique only within its own
 * workflow (every turn's first activity is typically "1"), and a retried
 * activity keeps its ID, so the prefix also names the turn attempt and the
 * activity attempt.
 */
export function providerRequestIdPrefix(input: {
  turnAttemptId: string;
  activityId: string;
  activityAttempt: number;
}): string {
  return `${input.turnAttemptId}:${input.activityId}:${input.activityAttempt}`;
}

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

/** One attempt's bounded request custody; no tokens or response bodies live here. */
export function createCoreCodexRequests(deps: {
  reserve: (request: CodexProviderRequestIdentity) => Promise<{ operationId: string }>;
  settle: (request: {
    operationId: string;
    outcome: CodexProviderRequestSettlement["outcome"];
  }) => Promise<void>;
}) {
  const requests = new Map<string, { operationId: string; responseReceived: boolean }>();
  let uncertain = false;
  // Which custody produced the uncertainty. "own" means this attempt's own
  // physical request ended without a definite answer (dropped stream, stall,
  // gateway timeout). "admission" means the durable fence refused a new
  // request because an earlier request is still unresolved; only an explicit
  // reconciliation can clear that.
  let ownUnknown = false;
  let admissionRefused = false;
  let reserving = false;
  const key = (request: CodexProviderRequestIdentity) =>
    JSON.stringify([request.requestId, request.transportAttempt]);
  return {
    async reserve(request: CodexProviderRequestIdentity): Promise<void> {
      if (uncertain || requests.size > 0 || reserving) {
        throw new SubscriptionCoreCodexRequestOutcomeUnknownError();
      }
      // The DB also rejects duplicate reservations, including ones already
      // settled locally. Never turn a repeated callback into a reusable permit.
      reserving = true;
      try {
        const reservation = await deps.reserve(request);
        requests.set(key(request), { ...reservation, responseReceived: false });
      } catch (error) {
        if (error instanceof SubscriptionCoreCodexRequestOutcomeUnknownError) {
          uncertain = true;
          admissionRefused = true;
        }
        throw error;
      } finally {
        reserving = false;
      }
    },
    async observe(request: CodexProviderRequestSettlement): Promise<void> {
      const id = key(request);
      const pending = requests.get(id);
      if (!pending) throw new Error("Codex request settlement has no reservation");
      if (request.outcome === "response_received") {
        pending.responseReceived = true;
        return;
      }
      if (request.outcome === "unknown") {
        uncertain = true;
        ownUnknown = true;
      }
      await deps.settle({ operationId: pending.operationId, outcome: request.outcome });
      requests.delete(id);
    },
    /** Call only AFTER the response/history writer has committed durably. */
    async checkpoint(): Promise<void> {
      for (const [id, request] of requests) {
        if (!request.responseReceived) continue;
        await deps.settle({ operationId: request.operationId, outcome: "response_received" });
        requests.delete(id);
      }
    },
    /** Absence of a response (including a detached timeout) is never replay proof. */
    canRecover(): boolean {
      return !uncertain && !reserving && requests.size === 0;
    },
    /** Preserve an observed unknown outcome even when the SDK throws a plain HTTP error. */
    hasUnknownOutcome(): boolean {
      return uncertain;
    },
    /**
     * True only when every unknown outcome came from this attempt's own
     * settled request and nothing is still reserved or in flight. The request
     * row keeps its unknown outcome; closing this attempt as recoverable lets
     * the next generation be admitted.
     */
    unknownIsOwnAndSettled(): boolean {
      return ownUnknown && !admissionRefused && !reserving && requests.size === 0;
    },
    /** The durable fence refused this attempt because of an earlier unresolved request. */
    admissionRefused(): boolean {
      return admissionRefused;
    },
  };
}
