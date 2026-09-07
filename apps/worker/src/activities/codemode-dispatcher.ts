import { randomUUID } from "node:crypto";
import {
  AttemptToolApprovalRequiredError,
  AttemptToolCatalogStaleError,
  AttemptToolInputValidationError,
  AttemptToolNotFoundError,
  codemodeDispatchSubject,
  decodeCodemodeDispatchRequest,
  encodeCodemodeDispatchAck,
  type AttemptToolCatalogEntry,
  type AttemptToolEnvironment,
} from "@opengeni/codemode";
import {
  CODEMODE_CLAIM_LEASE_MS,
  CODEMODE_CLAIM_HEARTBEAT_MS,
  CODEMODE_MAX_CONCURRENT_CALLS_PER_ATTEMPT,
  type CodemodeOperation,
  type SessionEvent,
} from "@opengeni/contracts";
import {
  cancelQueuedCodemodeOperationsForAttempt,
  claimCodemodeOperation,
  failCodemodeOperation,
  getSessionEventByClientEventId,
  getSessionToolCallCreatedEventByOperationId,
  markCodemodeOperationExecutionStarted,
  renewCodemodeOperationClaim,
  settleCodemodeOperationWithOutput,
  type Database,
} from "@opengeni/db";
import {
  appendAndPublishTurnEventsFenced,
  publishDurableSessionEvents,
  type EventBus,
} from "@opengeni/events";

export type CodemodeDispatcherScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

export type CodemodeDispatcherTimings = {
  claimLeaseMs?: number;
  claimHeartbeatMs?: number;
};

/**
 * Owns the only Codemode execution edge for one exact attempt. NATS carries a
 * wake-up only; the durable row is claimed before any side effect and the call
 * is executed by the same AttemptToolEnvironment already bound to model MCP.
 */
export class CodemodeAttemptDispatcher {
  private readonly stopController = new AbortController();
  private readonly inFlight = new Map<string, Promise<void>>();
  private pendingClaims = 0;
  private unsubscribe: (() => void) | null = null;
  private closing = false;
  private readonly claimLeaseMs: number;
  private readonly claimHeartbeatMs: number;

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly environment: AttemptToolEnvironment,
    private readonly scope: CodemodeDispatcherScope,
    private readonly turnSignal?: AbortSignal,
    private readonly maxConcurrentCalls = CODEMODE_MAX_CONCURRENT_CALLS_PER_ATTEMPT,
    timings: CodemodeDispatcherTimings = {},
  ) {
    if (
      environment.catalog.accountId !== scope.accountId ||
      environment.catalog.workspaceId !== scope.workspaceId ||
      environment.catalog.sessionId !== scope.sessionId ||
      environment.catalog.turnId !== scope.turnId ||
      environment.catalog.attemptId !== scope.attemptId ||
      environment.catalog.executionGeneration !== scope.executionGeneration
    ) {
      throw new Error("Codemode dispatcher scope does not match its tool environment");
    }
    if (!Number.isSafeInteger(maxConcurrentCalls) || maxConcurrentCalls < 1) {
      throw new Error("Codemode dispatcher concurrency must be a positive safe integer");
    }
    this.claimLeaseMs = timings.claimLeaseMs ?? CODEMODE_CLAIM_LEASE_MS;
    this.claimHeartbeatMs = timings.claimHeartbeatMs ?? CODEMODE_CLAIM_HEARTBEAT_MS;
    if (
      !Number.isSafeInteger(this.claimLeaseMs) ||
      this.claimLeaseMs < 1_000 ||
      this.claimLeaseMs > 10 * 60_000
    ) {
      throw new Error("Codemode dispatcher claim lease must be between 1 second and 10 minutes");
    }
    if (
      !Number.isSafeInteger(this.claimHeartbeatMs) ||
      this.claimHeartbeatMs < 1 ||
      this.claimHeartbeatMs >= this.claimLeaseMs
    ) {
      throw new Error("Codemode dispatcher heartbeat must be positive and shorter than its lease");
    }
  }

  start(): void {
    if (this.unsubscribe || this.closing)
      throw new Error("Codemode dispatcher cannot be restarted");
    this.unsubscribe = this.bus.subscribeRequests(
      codemodeDispatchSubject(this.scope.workspaceId, this.scope.attemptId),
      async (payload) => {
        const request = decodeCodemodeDispatchRequest(payload);
        if (request.catalogDigest !== this.environment.catalog.digest || this.closing) {
          return encodeCodemodeDispatchAck({
            version: 1,
            operationId: request.operationId,
            status: "rejected",
          });
        }
        if (
          !this.inFlight.has(request.operationId) &&
          this.inFlight.size + this.pendingClaims >= this.maxConcurrentCalls
        ) {
          return encodeCodemodeDispatchAck({
            version: 1,
            operationId: request.operationId,
            status: "unavailable",
          });
        }
        this.pendingClaims += 1;
        try {
          const claim = await claimCodemodeOperation(this.db, {
            ...this.scope,
            catalogDigest: request.catalogDigest,
            operationId: request.operationId,
            claimId: randomUUID(),
            claimLeaseMs: this.claimLeaseMs,
          });
          if (claim.status === "claimed") {
            const execution = this.execute(claim.operation, claim.claimId, claim.reclaimed).finally(
              () => {
                this.inFlight.delete(request.operationId);
              },
            );
            this.inFlight.set(request.operationId, execution);
            return encodeCodemodeDispatchAck({
              version: 1,
              operationId: request.operationId,
              status: "accepted",
            });
          }
          if (claim.status === "execution_owner_lost") {
            await this.settleWithOutput(claim.operation, claim.claimId, {
              state: "outcome_unknown",
              errorCode: "worker_lost_during_execution",
              errorMessage:
                "The execution owner disappeared after the tool call began. Inspect actual state before retrying.",
            });
            return encodeCodemodeDispatchAck({
              version: 1,
              operationId: request.operationId,
              status: "terminal",
            });
          }
          return encodeCodemodeDispatchAck({
            version: 1,
            operationId: request.operationId,
            status: claim.status,
          });
        } finally {
          this.pendingClaims -= 1;
        }
      },
    );
  }

  async close(reason = "Execution attempt ended"): Promise<void> {
    if (this.closing) {
      await Promise.allSettled([...this.inFlight.values()]);
      return;
    }
    this.closing = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopController.abort(reason);
    await cancelQueuedCodemodeOperationsForAttempt(this.db, {
      accountId: this.scope.accountId,
      workspaceId: this.scope.workspaceId,
      attemptId: this.scope.attemptId,
      reason,
    });
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private async execute(
    operation: CodemodeOperation,
    claimId: string,
    reclaimed: boolean,
  ): Promise<void> {
    const claimAuthority = {
      accountId: this.scope.accountId,
      workspaceId: this.scope.workspaceId,
      attemptId: this.scope.attemptId,
      operationId: operation.operationId,
      claimId,
      claimLeaseMs: this.claimLeaseMs,
    };
    // Preparation may include provider preflight and policy resolution. Keep the
    // durable claim alive from the moment execution is accepted, not only after
    // the provider side-effect marker, so a slow preflight cannot be reclaimed.
    const heartbeat = setInterval(() => {
      void renewCodemodeOperationClaim(this.db, claimAuthority).catch(() => undefined);
    }, this.claimHeartbeatMs);
    heartbeat.unref?.();
    try {
      await this.executeClaimed(operation, claimId, reclaimed, claimAuthority);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async executeClaimed(
    operation: CodemodeOperation,
    claimId: string,
    reclaimed: boolean,
    claimAuthority: Parameters<typeof markCodemodeOperationExecutionStarted>[1],
  ): Promise<void> {
    const entry = this.environment.catalog.entries.find(
      (candidate) =>
        candidate.identity.serverId === operation.identity.serverId &&
        candidate.identity.toolName === operation.identity.toolName,
    );
    if (!entry) {
      await this.failBeforeExecution(
        operation.operationId,
        claimId,
        "tool_not_found",
        "Tool left the active catalog",
      );
      return;
    }
    const signal = combinedSignal(this.stopController.signal, this.turnSignal);
    if (signal.aborted) {
      await this.failBeforeExecution(
        operation.operationId,
        claimId,
        "attempt_cancelled",
        "Execution attempt ended before the Codemode call started",
      );
      return;
    }
    if (!(await this.ensureToolCallCreated(operation, entry, reclaimed))) {
      await this.failBeforeExecution(
        operation.operationId,
        claimId,
        "attempt_fence_closed",
        "Execution attempt ended before the Codemode call started",
      );
      return;
    }
    if (signal.aborted) {
      await this.settleWithOutput(operation, claimId, {
        state: "failed",
        errorCode: "attempt_cancelled",
        errorMessage: "Execution attempt ended before the Codemode call started",
      });
      return;
    }

    let preparedCall: Awaited<ReturnType<AttemptToolEnvironment["prepareCall"]>>;
    try {
      preparedCall = await this.environment.prepareCall(
        {
          operationId: operation.operationId,
          catalogDigest: operation.catalogDigest,
          identity: operation.identity,
          arguments: operation.arguments,
          caller: operation.caller,
        },
        { signal },
      );
    } catch (error) {
      await this.settleWithOutput(operation, claimId, {
        state: "failed",
        errorCode: errorCode(error, signal, false),
        errorMessage: safeErrorMessage(error),
      });
      return;
    }
    if (signal.aborted) {
      await this.settleWithOutput(operation, claimId, {
        state: "failed",
        errorCode: "attempt_cancelled",
        errorMessage: "Execution attempt ended before the Codemode call started",
      });
      return;
    }

    const crossedExecutionBoundary = await markCodemodeOperationExecutionStarted(
      this.db,
      claimAuthority,
    );
    if (!crossedExecutionBoundary) return;
    try {
      const result = await preparedCall.execute();
      await this.settleWithOutput(operation, claimId, {
        state: "completed",
        result,
      });
    } catch (error) {
      const knownPreExecution =
        error instanceof AttemptToolApprovalRequiredError ||
        error instanceof AttemptToolCatalogStaleError ||
        error instanceof AttemptToolNotFoundError ||
        connectorActionWasNotExecuted(error);
      await this.settleWithOutput(operation, claimId, {
        state: knownPreExecution ? "failed" : "outcome_unknown",
        errorCode: errorCode(error, signal, true),
        errorMessage: !knownPreExecution
          ? "Tool execution ended without a durable result. Its side-effect outcome is unknown; inspect actual state before retrying."
          : safeErrorMessage(error),
      });
    }
  }

  private async ensureToolCallCreated(
    operation: CodemodeOperation,
    entry: AttemptToolCatalogEntry,
    reclaimed: boolean,
  ): Promise<boolean> {
    const clientEventId = codemodeToolCallCreatedClientEventId(operation.operationId);
    if (reclaimed) {
      const existing = await getSessionEventByClientEventId(
        this.db,
        this.scope.workspaceId,
        this.scope.sessionId,
        clientEventId,
      ).catch(() => null);
      if (existing) {
        assertMatchingCodemodeToolCallCreated(existing, operation, entry, this.scope);
        return true;
      }
      const legacyCreated = await getSessionToolCallCreatedEventByOperationId(this.db, {
        workspaceId: this.scope.workspaceId,
        sessionId: this.scope.sessionId,
        turnId: this.scope.turnId,
        attemptId: this.scope.attemptId,
        operationId: operation.operationId,
      }).catch(() => null);
      if (legacyCreated) {
        assertMatchingCodemodeToolCallCreated(legacyCreated, operation, entry, this.scope);
        return true;
      }
    }
    try {
      const created = await appendAndPublishTurnEventsFenced(
        this.db,
        this.bus,
        this.scope.workspaceId,
        this.scope.sessionId,
        this.scope.turnId,
        this.scope.executionGeneration,
        this.scope.attemptId,
        [
          {
            type: "agent.toolCall.created",
            clientEventId,
            turnId: this.scope.turnId,
            turnGeneration: this.scope.executionGeneration,
            turnAttemptId: this.scope.attemptId,
            producerId: operation.caller.subjectId,
            payload: {
              id: operation.operationId,
              name: entry.modelName,
              arguments: operation.arguments,
              origin: "codemode",
              subjectId: operation.caller.subjectId,
              raw: {
                type: "codemode_call",
                serverId: operation.identity.serverId,
                toolName: operation.identity.toolName,
                catalogDigest: operation.catalogDigest,
              },
            },
          },
        ],
      );
      return created.accepted;
    } catch {
      // A concurrent reclaimed claimant can win the unique client-event insert,
      // or a committed append can lose its response. Reconcile durable truth
      // before treating the attempt fence as closed.
      const raced = await getSessionEventByClientEventId(
        this.db,
        this.scope.workspaceId,
        this.scope.sessionId,
        clientEventId,
      ).catch(() => null);
      if (!raced) return false;
      assertMatchingCodemodeToolCallCreated(raced, operation, entry, this.scope);
      return true;
    }
  }

  private async settleWithOutput(
    operation: CodemodeOperation,
    claimId: string,
    settlement:
      | { state: "completed"; result: NonNullable<CodemodeOperation["result"]> }
      | {
          state: "failed" | "outcome_unknown";
          errorCode: string;
          errorMessage: string;
        },
  ): Promise<void> {
    const result = await settleCodemodeOperationWithOutput(this.db, {
      ...this.scope,
      operationId: operation.operationId,
      claimId,
      producerId: operation.caller.subjectId,
      settlement,
    });
    if (!result.committed || result.events.length === 0) return;
    await publishDurableSessionEvents(
      this.bus,
      this.scope.workspaceId,
      this.scope.sessionId,
      result.events,
    );
  }

  private async failBeforeExecution(
    operationId: string,
    claimId: string,
    failureCode: string,
    failureMessage: string,
  ): Promise<void> {
    await failCodemodeOperation(this.db, {
      accountId: this.scope.accountId,
      workspaceId: this.scope.workspaceId,
      attemptId: this.scope.attemptId,
      operationId,
      claimId,
      state: "failed",
      errorCode: failureCode,
      errorMessage: failureMessage,
    });
  }
}

export function codemodeToolCallCreatedClientEventId(operationId: string): string {
  return `opengeni:codemode-tool-call-created:${operationId}`;
}

function assertMatchingCodemodeToolCallCreated(
  event: SessionEvent,
  operation: CodemodeOperation,
  entry: AttemptToolCatalogEntry,
  scope: CodemodeDispatcherScope,
): void {
  const payload = recordValue(event.payload);
  const raw = recordValue(payload?.raw);
  if (
    event.type !== "agent.toolCall.created" ||
    event.turnId !== scope.turnId ||
    event.turnGeneration !== scope.executionGeneration ||
    event.turnAttemptId !== scope.attemptId ||
    event.turnAssociation !== "current" ||
    payload?.id !== operation.operationId ||
    payload?.name !== entry.modelName ||
    payload?.origin !== "codemode" ||
    payload?.subjectId !== operation.caller.subjectId ||
    raw?.type !== "codemode_call" ||
    raw?.serverId !== operation.identity.serverId ||
    raw?.toolName !== operation.identity.toolName ||
    raw?.catalogDigest !== operation.catalogDigest
  ) {
    throw new Error("Codemode tool-call creation id is bound to incompatible durable evidence");
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function connectorActionWasNotExecuted(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "connectorActionOutcome" in error &&
    (error as { connectorActionOutcome?: unknown }).connectorActionOutcome === "not_executed",
  );
}

function combinedSignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary ? AbortSignal.any([primary, secondary]) : primary;
}

function errorCode(error: unknown, signal: AbortSignal, executionStarted: boolean): string {
  if (signal.aborted) {
    return executionStarted ? "attempt_cancelled_during_execution" : "attempt_cancelled";
  }
  if (connectorActionWasNotExecuted(error)) return "connector_action_not_executed";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_]{1,128}$/u.test(code)) return code;
  }
  return "tool_outcome_unknown";
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof AttemptToolApprovalRequiredError ||
    error instanceof AttemptToolCatalogStaleError ||
    error instanceof AttemptToolInputValidationError ||
    error instanceof AttemptToolNotFoundError
  ) {
    return error.message;
  }
  return "Codemode call failed before tool execution";
}
