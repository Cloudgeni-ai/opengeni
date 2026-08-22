import type {
  PendingSessionForkAttempt,
  PendingSessionVisibilityAttempt,
  SessionTenancyTarget,
} from "@/lib/session-tenancy";
import type { SessionVisibility } from "@opengeni/sdk";

export type SessionTenancyOperationScope = SessionTenancyTarget & {
  principalId: string;
  workspaceTransitionRevision: number;
};

export type SessionTenancyOperationSnapshot = {
  visibility: PendingSessionVisibilityAttempt | null;
  fork: PendingSessionForkAttempt | null;
};

function sameScope(
  left: SessionTenancyOperationScope | null,
  right: SessionTenancyOperationScope,
): boolean {
  return (
    left?.principalId === right.principalId &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.workspaceTransitionRevision === right.workspaceTransitionRevision
  );
}

/**
 * App-lifetime retention for one exact principal/workspace/session target.
 * Component unmounts are deliberately inert; a principal/workspace/session
 * transition synchronously replaces the scope and retires every older key.
 */
export class SessionTenancyOperationController {
  private scope: SessionTenancyOperationScope | null = null;
  private visibility: PendingSessionVisibilityAttempt | null = null;
  private fork: PendingSessionForkAttempt | null = null;

  snapshot(scope: SessionTenancyOperationScope): SessionTenancyOperationSnapshot {
    this.bind(scope);
    return { visibility: this.visibility, fork: this.fork };
  }

  prepareVisibility(
    scope: SessionTenancyOperationScope,
    input: { visibility: SessionVisibility; expectedAuthorityEpoch: number },
    createIdempotencyKey: () => string,
  ): PendingSessionVisibilityAttempt {
    this.bind(scope);
    if (this.visibility) return this.visibility;
    const attempt: PendingSessionVisibilityAttempt = {
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      ...input,
      idempotencyKey: createIdempotencyKey(),
    };
    this.visibility = attempt;
    return attempt;
  }

  prepareFork(
    scope: SessionTenancyOperationScope,
    createIdempotencyKey: () => string,
  ): PendingSessionForkAttempt {
    this.bind(scope);
    if (this.fork) return this.fork;
    this.fork = {
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
      idempotencyKey: createIdempotencyKey(),
    };
    return this.fork;
  }

  settleVisibility(
    scope: SessionTenancyOperationScope,
    attempt: PendingSessionVisibilityAttempt,
  ): void {
    if (!sameScope(this.scope, scope)) return;
    if (this.visibility?.idempotencyKey === attempt.idempotencyKey) this.visibility = null;
  }

  settleFork(scope: SessionTenancyOperationScope, attempt: PendingSessionForkAttempt): void {
    if (!sameScope(this.scope, scope)) return;
    if (this.fork?.idempotencyKey === attempt.idempotencyKey) this.fork = null;
  }

  invalidate(): void {
    this.scope = null;
    this.visibility = null;
    this.fork = null;
  }

  private bind(scope: SessionTenancyOperationScope): void {
    if (sameScope(this.scope, scope)) return;
    this.scope = { ...scope };
    this.visibility = null;
    this.fork = null;
  }
}

/** One retained controller for the activation-gated web module's app lifetime. */
export const sessionTenancyOperationController = new SessionTenancyOperationController();
