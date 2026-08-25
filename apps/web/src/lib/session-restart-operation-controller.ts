import type { SessionVisibility } from "@opengeni/sdk";

import {
  classifySessionTenancyFailure,
  retryableSessionTenancyReconciliationFailure,
} from "@/lib/session-tenancy";

export type SessionRestartOperationScope = {
  principalId: string;
  workspaceId: string;
  sessionId: string;
};

export type PendingSessionRestartAttempt = SessionRestartOperationScope & {
  visibility: SessionVisibility;
  rigId: string | null;
  variableSetIds: string[];
  idempotencyKey: string;
};

function sameScope(
  left: SessionRestartOperationScope | null,
  right: SessionRestartOperationScope,
): boolean {
  return (
    left?.principalId === right.principalId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId
  );
}

/**
 * App-lifetime retention for restart-with-setup. An uncertain attempt keeps its
 * exact ordered setup, so a remount or edited picker cannot mint a second fork
 * before the original idempotency key is reconciled.
 */
export class SessionRestartOperationController {
  private scope: SessionRestartOperationScope | null = null;
  private attempt: PendingSessionRestartAttempt | null = null;

  snapshot(scope: SessionRestartOperationScope): PendingSessionRestartAttempt | null {
    this.bind(scope);
    return this.attempt;
  }

  prepare(
    scope: SessionRestartOperationScope,
    input: {
      visibility: SessionVisibility;
      rigId: string | null;
      variableSetIds: readonly string[];
    },
    createIdempotencyKey: () => string,
  ): PendingSessionRestartAttempt {
    this.bind(scope);
    if (this.attempt) return this.attempt;
    this.attempt = {
      ...scope,
      visibility: input.visibility,
      rigId: input.rigId,
      variableSetIds: [...input.variableSetIds],
      idempotencyKey: createIdempotencyKey(),
    };
    return this.attempt;
  }

  settle(scope: SessionRestartOperationScope, attempt: PendingSessionRestartAttempt): void {
    if (!sameScope(this.scope, scope)) return;
    if (this.attempt?.idempotencyKey === attempt.idempotencyKey) this.attempt = null;
  }

  invalidate(): void {
    this.scope = null;
    this.attempt = null;
  }

  private bind(scope: SessionRestartOperationScope): void {
    if (sameScope(this.scope, scope)) return;
    this.scope = { ...scope };
    this.attempt = null;
  }
}

export function retainSessionRestartAttemptAfterFailure(
  error: unknown,
  receiptConfirmed: boolean,
): boolean {
  const classified = classifySessionTenancyFailure(error);
  return (
    classified.retainAttempt ||
    (receiptConfirmed && retryableSessionTenancyReconciliationFailure(error))
  );
}

/** One retained controller for the web application's lifetime. */
export const sessionRestartOperationController = new SessionRestartOperationController();
