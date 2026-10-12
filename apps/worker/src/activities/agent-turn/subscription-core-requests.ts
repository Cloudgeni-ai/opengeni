/**
 * Request custody for a chat turn on the shared subscription core, for any
 * provider (generalized from the M3 Codex custody; Codex binds it in
 * `codex-core-requests.ts` under the names it shipped). A physical request
 * is reserved before network I/O and settled once; an unknown outcome is
 * never replayed automatically.
 */

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

/** One physical request: the logical request id and its transport attempt. */
export type SubscriptionCoreRequestIdentity = { requestId: string; transportAttempt: number };

export type SubscriptionCoreRequestSettlement = SubscriptionCoreRequestIdentity & {
  /** Transport evidence only; response_received is NOT a durable history checkpoint. */
  outcome: "response_received" | "refused" | "unknown";
};

export type CoreSubscriptionRequestsDeps = {
  reserve: (request: SubscriptionCoreRequestIdentity) => Promise<{ operationId: string }>;
  settle: (request: {
    operationId: string;
    outcome: SubscriptionCoreRequestSettlement["outcome"];
  }) => Promise<void>;
  /** The provider's name in internal error text. */
  displayName: string;
  /** The provider's unresolved-outcome error (the durable fence raises the same). */
  outcomeUnknown: () => Error;
  isOutcomeUnknown: (error: unknown) => boolean;
};

/** One attempt's bounded request custody; no tokens or response bodies live here. */
export function createCoreSubscriptionRequests(deps: CoreSubscriptionRequestsDeps) {
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
  const key = (request: SubscriptionCoreRequestIdentity) =>
    JSON.stringify([request.requestId, request.transportAttempt]);
  return {
    async reserve(request: SubscriptionCoreRequestIdentity): Promise<void> {
      if (uncertain || requests.size > 0 || reserving) {
        throw deps.outcomeUnknown();
      }
      // The DB also rejects duplicate reservations, including ones already
      // settled locally. Never turn a repeated callback into a reusable permit.
      reserving = true;
      try {
        const reservation = await deps.reserve(request);
        requests.set(key(request), { ...reservation, responseReceived: false });
      } catch (error) {
        if (deps.isOutcomeUnknown(error)) {
          uncertain = true;
          admissionRefused = true;
        }
        throw error;
      } finally {
        reserving = false;
      }
    },
    async observe(request: SubscriptionCoreRequestSettlement): Promise<void> {
      const id = key(request);
      const pending = requests.get(id);
      if (!pending) throw new Error(`${deps.displayName} request settlement has no reservation`);
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

export type CoreSubscriptionRequests = ReturnType<typeof createCoreSubscriptionRequests>;
