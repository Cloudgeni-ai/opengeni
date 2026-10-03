import {
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  XAI_CREDENTIAL_LEASE_TTL_MS,
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

/** SuperGrok uses the same deadline and holder fences as Codex. */
export class XaiTurnLease extends SubscriptionTurnLease {
  subjectId: string | null = null;
  constructor(deps: TurnCredentialLeaseDeps) {
    super({
      ttlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
      getTurnId: deps.getTurnId,
      heartbeat: ({ turnId, holderId, generation }) =>
        this.subjectId
          ? heartbeatXaiCredentialLeaseUntil(deps.db, {
              workspaceId: deps.workspaceId,
              subjectId: this.subjectId,
              turnId,
              holderId,
              generation,
              leaseTtlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
            })
          : Promise.resolve(null),
      lostError: (reason) =>
        Object.assign(new Error("SuperGrok credential lease is not usable for provider dispatch"), {
          code: "xai_credential_lease_lost",
          reason,
        }),
      onLost: (reason) =>
        deps.observability.warn("xAI credential lease was lost during an active turn", {
          workspaceId: deps.workspaceId,
          turnId: deps.getTurnId(),
          reason,
        }),
      onError: (error) =>
        deps.observability.warn("xAI credential lease heartbeat failed", {
          workspaceId: deps.workspaceId,
          turnId: deps.getTurnId(),
          ...safeErrorDiagnostic(error),
        }),
    });
  }
}

/** Both serving-credential leases for one turn attempt plus their composite views. */
export type TurnCredentialLeases = {
  codex: CodexTurnLease;
  xai: XaiTurnLease;
  renewServing: (reason: LeaseRenewReason) => Promise<void>;
  servingLost: () => boolean;
};

export function createTurnCredentialLeases(deps: TurnCredentialLeaseDeps): TurnCredentialLeases {
  const codex = new CodexTurnLease(deps);
  const xai = new XaiTurnLease(deps);
  return {
    codex,
    xai,
    renewServing: async (reason) => {
      await codex.renew(reason);
      await xai.renew();
    },
    servingLost: () => codex.lost || xai.lost,
  };
}
