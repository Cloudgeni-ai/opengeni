import {
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  CLAUDE_CREDENTIAL_LEASE_TTL_MS,
  heartbeatClaudeCredentialLeaseUntil,
  heartbeatCodexCredentialLeaseUntil,
  releaseCodexCredentialLease,
  releaseSubscriptionTurnLease,
  heartbeatXaiCredentialLeaseUntil,
  assertSubscriptionTurnLeaseCurrent,
  renewSubscriptionTurnLease,
  withRlsContext,
} from "@opengeni/db";
import type { SharedActivityServices } from "../types";
import {
  SubscriptionTurnLease,
  type LeaseRenewReason,
  type LeaseLossReason,
} from "./subscription-lease";
export type { LeaseRenewReason, LeaseLossReason } from "./subscription-lease";
import { safeErrorDiagnostic } from "./errors";

export class CodexCredentialLeaseLostError extends Error {
  readonly code = "codex_credential_lease_lost";

  constructor(readonly reason: LeaseLossReason) {
    super("Codex credential lease is not usable for provider dispatch");
    this.name = "CodexCredentialLeaseLostError";
  }
}

export type TurnCredentialLeaseDeps = {
  db: SharedActivityServices["db"];
  observability: SharedActivityServices["observability"];
  accountId: string;
  workspaceId: string;
  codexWorkspaceKey: string;
  getTurnId: () => string | undefined;
  getSessionId?: () => string | undefined;
};

/**
 * The Codex credential holder for one running turn. The DB row is the
 * cross-replica fairness primitive; the heartbeat here only extends its short
 * TTL. A killed worker stops heartbeating and the holder self-expires.
 */
export class CodexTurnLease extends SubscriptionTurnLease {
  private readonly codexDeps: TurnCredentialLeaseDeps;
  private subscriptionCoreConnectionId: string | null = null;

  constructor(deps: TurnCredentialLeaseDeps) {
    super({
      ttlMs: CODEX_CREDENTIAL_LEASE_TTL_MS,
      getTurnId: deps.getTurnId,
      heartbeat: ({ turnId, holderId, generation }) => {
        const connectionId = this.subscriptionCoreConnectionId;
        if (connectionId) {
          const sessionId = deps.getSessionId?.();
          if (!sessionId) return Promise.resolve(null);
          return withRlsContext(
            deps.db,
            { accountId: deps.accountId, workspaceId: deps.workspaceId },
            (scoped) =>
              renewSubscriptionTurnLease(scoped, {
                accountId: deps.accountId,
                workspaceId: deps.workspaceId,
                sessionId,
                turnId,
                provider: "codex",
                connectionId,
                holderId,
                generation,
                ttlMs: CODEX_CREDENTIAL_LEASE_TTL_MS,
              }),
          );
        }
        return heartbeatCodexCredentialLeaseUntil(
          deps.db,
          deps.accountId,
          deps.workspaceId,
          turnId,
          holderId,
          generation,
          CODEX_CREDENTIAL_LEASE_TTL_MS,
        );
      },
      lostError: (reason) => new CodexCredentialLeaseLostError(reason),
      onLost: (reason) => {
        deps.observability.incrementCounter({
          name: "opengeni_codex_lease_renewals_total",
          help: "Codex lease renewal checkpoints by outcome and reason.",
          labels: { workspace_key: deps.codexWorkspaceKey, outcome: "lost", reason },
        });
        deps.observability.warn("Codex credential lease was lost during an active turn", {
          workspaceId: deps.workspaceId,
          turnId: deps.getTurnId(),
          reason,
        });
      },
      onRenewed: (reason) =>
        deps.observability.incrementCounter({
          name: "opengeni_codex_lease_renewals_total",
          help: "Codex lease renewal checkpoints by outcome and reason.",
          labels: { workspace_key: deps.codexWorkspaceKey, outcome: "completed", reason },
        }),
      onError: (error, reason) => {
        deps.observability.warn("Codex credential lease heartbeat failed", {
          workspaceId: deps.workspaceId,
          turnId: deps.getTurnId(),
          reason,
          ...safeErrorDiagnostic(error),
        });
        deps.observability.incrementCounter({
          name: "opengeni_codex_lease_renewals_total",
          help: "Codex lease renewal checkpoints by outcome and reason.",
          labels: { workspace_key: deps.codexWorkspaceKey, outcome: "error", reason },
        });
      },
    });
    this.codexDeps = deps;
  }

  /** Route heartbeat renewal to the canonical per-turn lease after core placement. */
  useSubscriptionCoreLease(connectionId: string): void {
    if (!connectionId.trim()) throw new Error("Core Codex lease connection id is required");
    this.subscriptionCoreConnectionId = connectionId;
  }

  /** Keep legacy routing explicit when placement has not crossed cutover. */
  useLegacyCodexLease(): void {
    this.subscriptionCoreConnectionId = null;
  }

  /** Recheck the canonical lease at the last boundary before Codex network I/O. */
  async assertCurrentForDispatch(): Promise<void> {
    this.assertUsable();
    const connectionId = this.subscriptionCoreConnectionId;
    if (!connectionId) return;
    const turnId = this.codexDeps.getTurnId();
    const sessionId = this.codexDeps.getSessionId?.();
    if (!turnId || !sessionId || !this.holderId || this.generation === null) {
      this.markLost("not_found");
      this.assertUsable();
      return;
    }
    const current = await withRlsContext(
      this.codexDeps.db,
      { accountId: this.codexDeps.accountId, workspaceId: this.codexDeps.workspaceId },
      (scoped) =>
        assertSubscriptionTurnLeaseCurrent(scoped, {
          accountId: this.codexDeps.accountId,
          workspaceId: this.codexDeps.workspaceId,
          sessionId,
          turnId,
          provider: "codex",
          connectionId,
          holderId: this.holderId!,
          generation: this.generation!,
        }),
    );
    if (!current) {
      this.markLost("not_found");
      this.assertUsable();
    }
  }

  /** Release the lease system that acquired this turn's Codex connection. */
  async releaseCurrent(): Promise<boolean> {
    const turnId = this.codexDeps.getTurnId();
    if (!turnId || !this.holderId || this.generation === null) return false;
    const connectionId = this.subscriptionCoreConnectionId;
    if (!connectionId) {
      return await releaseCodexCredentialLease(
        this.codexDeps.db,
        this.codexDeps.accountId,
        this.codexDeps.workspaceId,
        turnId,
        this.holderId,
        this.generation,
      );
    }
    const sessionId = this.codexDeps.getSessionId?.();
    if (!sessionId) return false;
    return await withRlsContext(
      this.codexDeps.db,
      { accountId: this.codexDeps.accountId, workspaceId: this.codexDeps.workspaceId },
      (scoped) =>
        releaseSubscriptionTurnLease(scoped, {
          accountId: this.codexDeps.accountId,
          workspaceId: this.codexDeps.workspaceId,
          sessionId,
          turnId,
          provider: "codex",
          connectionId,
          holderId: this.holderId!,
          generation: this.generation!,
        }),
    );
  }
}

/** Scoped subscriptions share the existing holder and monotonic deadline implementation. */
class ScopedSubscriptionTurnLease extends SubscriptionTurnLease {
  subjectId: string | null = null;
  constructor(
    deps: TurnCredentialLeaseDeps,
    provider: {
      name: string;
      code: string;
      ttlMs: number;
      heartbeat: typeof heartbeatXaiCredentialLeaseUntil;
    },
  ) {
    super({
      ttlMs: provider.ttlMs,
      getTurnId: deps.getTurnId,
      heartbeat: ({ turnId, holderId, generation }) =>
        this.subjectId
          ? provider.heartbeat(deps.db, {
              workspaceId: deps.workspaceId,
              subjectId: this.subjectId,
              turnId,
              holderId,
              generation,
              leaseTtlMs: provider.ttlMs,
            })
          : Promise.resolve(null),
      lostError: (reason) =>
        Object.assign(
          new Error(provider.name + " credential lease is not usable for provider dispatch"),
          { code: provider.code, reason },
        ),
      onLost: (reason) =>
        deps.observability.warn(
          provider.name + " credential lease was lost during an active turn",
          { workspaceId: deps.workspaceId, turnId: deps.getTurnId(), reason },
        ),
      onError: (error) =>
        deps.observability.warn(provider.name + " credential lease heartbeat failed", {
          workspaceId: deps.workspaceId,
          turnId: deps.getTurnId(),
          ...safeErrorDiagnostic(error),
        }),
    });
  }
}
export class XaiTurnLease extends ScopedSubscriptionTurnLease {
  constructor(deps: TurnCredentialLeaseDeps) {
    super(deps, {
      name: "SuperGrok",
      code: "xai_credential_lease_lost",
      ttlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
      heartbeat: heartbeatXaiCredentialLeaseUntil,
    });
  }
}
export class ClaudeTurnLease extends ScopedSubscriptionTurnLease {
  constructor(deps: TurnCredentialLeaseDeps) {
    super(deps, {
      name: "Claude",
      code: "claude_credential_lease_lost",
      ttlMs: CLAUDE_CREDENTIAL_LEASE_TTL_MS,
      heartbeat: heartbeatClaudeCredentialLeaseUntil,
    });
  }
}

/** Serving-credential leases for one turn attempt plus their composite views. */
export type TurnCredentialLeases = {
  codex: CodexTurnLease;
  xai: XaiTurnLease;
  claude: ClaudeTurnLease;
  renewServing: (reason: LeaseRenewReason) => Promise<void>;
  servingLost: () => boolean;
};

export function createTurnCredentialLeases(deps: TurnCredentialLeaseDeps): TurnCredentialLeases {
  const codex = new CodexTurnLease(deps);
  const xai = new XaiTurnLease(deps);
  const claude = new ClaudeTurnLease(deps);
  return {
    codex,
    xai,
    claude,
    renewServing: async (reason) => {
      await codex.renew(reason);
      await xai.renew(reason);
      await claude.renew(reason);
    },
    servingLost: () => codex.lost || xai.lost || claude.lost,
  };
}
