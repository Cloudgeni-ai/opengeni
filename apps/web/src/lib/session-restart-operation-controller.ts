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

function scopeKey(scope: SessionRestartOperationScope): string {
  return JSON.stringify([scope.principalId, scope.workspaceId, scope.sessionId]);
}

/**
 * App-lifetime retention for restart-with-setup. An uncertain attempt keeps its
 * exact ordered setup, so a remount or edited picker cannot mint a second fork
 * before the original idempotency key is reconciled.
 */
export class SessionRestartOperationController {
  private readonly attempts = new Map<string, PendingSessionRestartAttempt>();

  snapshot(scope: SessionRestartOperationScope): PendingSessionRestartAttempt | null {
    return this.attempts.get(scopeKey(scope)) ?? null;
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
    const key = scopeKey(scope);
    const retained = this.attempts.get(key);
    if (retained) return retained;
    const attempt = {
      ...scope,
      visibility: input.visibility,
      rigId: input.rigId,
      variableSetIds: [...input.variableSetIds],
      idempotencyKey: createIdempotencyKey(),
    };
    this.attempts.set(key, attempt);
    return attempt;
  }

  settle(scope: SessionRestartOperationScope, attempt: PendingSessionRestartAttempt): void {
    const key = scopeKey(scope);
    if (this.attempts.get(key)?.idempotencyKey === attempt.idempotencyKey) {
      this.attempts.delete(key);
    }
  }

  invalidate(): void {
    this.attempts.clear();
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
