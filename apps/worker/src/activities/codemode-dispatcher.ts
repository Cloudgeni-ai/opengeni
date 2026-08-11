import { randomUUID } from "node:crypto";
import {
  AttemptToolApprovalRequiredError,
  AttemptToolCatalogStaleError,
  AttemptToolNotFoundError,
  codemodeDispatchSubject,
  decodeCodemodeDispatchRequest,
  encodeCodemodeDispatchAck,
  type AttemptToolEnvironment,
} from "@opengeni/codemode";
import {
  CODEMODE_CLAIM_HEARTBEAT_MS,
  CODEMODE_MAX_CONCURRENT_CALLS_PER_ATTEMPT,
  type CodemodeOperation,
} from "@opengeni/contracts";
import {
  cancelQueuedCodemodeOperationsForAttempt,
  claimCodemodeOperation,
  failCodemodeOperation,
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

  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly environment: AttemptToolEnvironment,
    private readonly scope: CodemodeDispatcherScope,
    private readonly turnSignal?: AbortSignal,
    private readonly maxConcurrentCalls = CODEMODE_MAX_CONCURRENT_CALLS_PER_ATTEMPT,
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
          });
          if (claim.status === "claimed") {
            const execution = this.execute(claim.operation, claim.claimId).finally(() => {
              this.inFlight.delete(request.operationId);
            });
            this.inFlight.set(request.operationId, execution);
            return encodeCodemodeDispatchAck({
              version: 1,
              operationId: request.operationId,
              status: "accepted",
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

  private async execute(operation: CodemodeOperation, claimId: string): Promise<void> {
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
    ).catch(() => ({ accepted: false }));
    if (!created.accepted) {
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

    const claimAuthority = {
      accountId: this.scope.accountId,
      workspaceId: this.scope.workspaceId,
      attemptId: this.scope.attemptId,
      operationId: operation.operationId,
      claimId,
    };
    const crossedExecutionBoundary = await markCodemodeOperationExecutionStarted(
      this.db,
      claimAuthority,
    );
    if (!crossedExecutionBoundary) return;
    const heartbeat = setInterval(() => {
      void renewCodemodeOperationClaim(this.db, claimAuthority).catch(() => undefined);
    }, CODEMODE_CLAIM_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      const result = await this.environment.call(
        {
          operationId: operation.operationId,
          catalogDigest: operation.catalogDigest,
          identity: operation.identity,
          arguments: operation.arguments,
          caller: operation.caller,
        },
        { signal },
      );
      await this.settleWithOutput(operation, claimId, { state: "completed", result });
    } catch (error) {
      const knownPreExecution =
        error instanceof AttemptToolApprovalRequiredError ||
        error instanceof AttemptToolCatalogStaleError ||
        error instanceof AttemptToolNotFoundError;
      await this.settleWithOutput(operation, claimId, {
        state: knownPreExecution ? "failed" : "outcome_unknown",
        errorCode: errorCode(error, signal),
        errorMessage: !knownPreExecution
          ? "Tool execution ended without a durable result. Its side-effect outcome is unknown; inspect actual state before retrying."
          : safeErrorMessage(error),
      });
    } finally {
      clearInterval(heartbeat);
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

function combinedSignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  return secondary ? AbortSignal.any([primary, secondary]) : primary;
}

function errorCode(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "attempt_cancelled_during_execution";
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
    error instanceof AttemptToolNotFoundError
  ) {
    return error.message;
  }
  return "Codemode call failed before tool execution";
}
