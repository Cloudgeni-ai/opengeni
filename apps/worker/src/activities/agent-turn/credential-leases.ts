import {
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  CLAUDE_CREDENTIAL_LEASE_TTL_MS,
  heartbeatClaudeCredentialLeaseUntil,
  heartbeatCodexCredentialLeaseUntil,
  heartbeatXaiCredentialLeaseUntil,
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
};

/**
 * The Codex credential holder for one running turn. The DB row is the
 * cross-replica fairness primitive; the heartbeat here only extends its short
 * TTL. A killed worker stops heartbeating and the holder self-expires.
 */
export class CodexTurnLease extends SubscriptionTurnLease {
  constructor(deps: TurnCredentialLeaseDeps) {
    super({
      ttlMs: CODEX_CREDENTIAL_LEASE_TTL_MS,
      getTurnId: deps.getTurnId,
      heartbeat: ({ turnId, holderId, generation }) =>
        heartbeatCodexCredentialLeaseUntil(
          deps.db,
          deps.accountId,
          deps.workspaceId,
          turnId,
          holderId,
          generation,
          CODEX_CREDENTIAL_LEASE_TTL_MS,
        ),
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
