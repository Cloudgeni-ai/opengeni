/**
 * Request custody for a chat turn on the shared subscription core, for any
 * provider (generalized from the M3 Codex custody; Codex binds it in
 * `codex-core-requests.ts` under the names it shipped). A physical request
 * is reserved before network I/O and settled once; an unknown outcome is
 * never replayed automatically.
 */
import { SubscriptionCoreError } from "@opengeni/db";

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
  let lastResponseAt: number | null = null;
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
        lastResponseAt = Date.now();
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
    /** When a request of this lane last received a response (the binding's cache clock). */
    lastResponseReceivedAt(): Date | null {
      return lastResponseAt === null ? null : new Date(lastResponseAt);
    },
  };
}

export type CoreSubscriptionRequests = ReturnType<typeof createCoreSubscriptionRequests>;

/**
 * An HTTP error status is a definite answer: no model response was produced.
 * Timeouts (408, 504) and conflicts (409) stay ambiguous because the
 * provider may still be processing the request (the Codex and SuperGrok
 * transports' rule).
 */
export function definiteRefusalStatus(status: number): boolean {
  return status >= 400 && status < 600 && status !== 408 && status !== 409 && status !== 504;
}

/**
 * Reads a successful response body as it passes to the SDK and decides the
 * request's outcome when the body ends (`ended`) or stops early (an error or
 * a cancel by the reader). Without one, a body read to its end is a
 * response and anything else is unknown.
 */
export type CoreResponseInspector = {
  chunk: (bytes: Uint8Array) => void;
  outcome: (ended: boolean) => SubscriptionCoreRequestSettlement["outcome"];
};

/**
 * Settle one physical request of a lane from the response a fetch-level
 * transport received: a definite error status is refused at once and an
 * ambiguous one is unknown; any other response settles when its body ends or
 * stops (the inspector decides; a body that stops early is unknown, never
 * replayed). The returned response carries the same status, headers and
 * bytes.
 */
export async function settleCoreResponse(
  lane: Pick<CoreSubscriptionRequests, "observe">,
  request: SubscriptionCoreRequestIdentity,
  response: Response,
  inspector?: CoreResponseInspector,
): Promise<Response> {
  let settled = false;
  const settle = async (outcome: SubscriptionCoreRequestSettlement["outcome"]) => {
    if (settled) return;
    settled = true;
    await lane.observe({ ...request, outcome });
  };
  if (response.status >= 400) {
    await settle(definiteRefusalStatus(response.status) ? "refused" : "unknown");
    return response;
  }
  if (!response.body) {
    await settle("response_received");
    return response;
  }
  const decide = (ended: boolean) =>
    inspector ? inspector.outcome(ended) : ended ? "response_received" : "unknown";
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        await settle(decide(false)).catch(() => undefined);
        controller.error(error);
        return;
      }
      if (chunk.done) {
        await settle(decide(true));
        controller.close();
        return;
      }
      inspector?.chunk(chunk.value);
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await settle(decide(false)).catch(() => undefined);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

type CoreLanes = {
  requests?: Pick<CoreSubscriptionRequests, "hasUnknownOutcome" | "canRecover" | "checkpoint">;
  titleRequests?: Pick<CoreSubscriptionRequests, "hasUnknownOutcome" | "canRecover">;
};

/**
 * The terminal unknown-outcome failure of a core turn, or null: an earlier or
 * own request whose outcome is unknown (the error chain carries the core's
 * code, or either lane observed one) is never replayed automatically.
 */
export function coreRequestOutcomeUnknownFailure(
  error: unknown,
  core: CoreLanes,
  outcomeUnknown: () => Error,
): (Error & { code: string }) | null {
  let current: unknown = error;
  let unknown = false;
  for (let depth = 0; depth < 8 && current instanceof Error && !unknown; depth++) {
    unknown =
      current instanceof SubscriptionCoreError &&
      current.code === "subscription_core_request_outcome_unknown";
    current = current.cause;
  }
  if (!unknown && !core.requests?.hasUnknownOutcome() && !core.titleRequests?.hasUnknownOutcome())
    return null;
  return outcomeUnknown() as Error & { code: string };
}

/** After the history commit, settle completed responses; true when no request is unresolved. */
export async function coreLanesRecoverAfterCheckpoint(
  core: CoreLanes,
  commitHistory: () => Promise<void>,
): Promise<boolean> {
  try {
    await commitHistory();
    await core.requests?.checkpoint();
    return (
      (!core.requests || core.requests.canRecover()) &&
      (!core.titleRequests || core.titleRequests.canRecover())
    );
  } catch {
    return false;
  }
}
