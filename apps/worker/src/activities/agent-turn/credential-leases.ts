import {
  CODEX_CREDENTIAL_LEASE_TTL_MS,
  XAI_CREDENTIAL_LEASE_TTL_MS,
  heartbeatCodexCredentialLeaseUntil,
  heartbeatXaiCredentialLeaseUntil,
} from "@opengeni/db";
import type { SharedActivityServices } from "../types";
import { codexCredentialLeaseDeadlineExpired } from "./codex";
import { safeErrorDiagnostic } from "./errors";

export type LeaseRenewReason = "timer" | "runtime_event" | "model_usage";
export type LeaseLossReason = "deadline" | "not_found";

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
export class CodexTurnLease {
  held = false;
  lost = false;
  lossReason: LeaseLossReason | null = null;
  holderId: string | null = null;
  generation: number | null = null;
  // Monotonic worker deadline, not a comparison between the Postgres and
  // worker wall clocks. It is advanced only after a database renewal confirms,
  // from the request START + TTL; slow queries therefore shorten (never extend)
  // the conservative ownership window.
  confirmedUntilMs: number | null = null;
  private heartbeatInFlight = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: TurnCredentialLeaseDeps) {}

  markLost = (reason: LeaseLossReason): void => {
    if (this.lost) return;
    this.lost = true;
    this.lossReason = reason;
    this.deps.observability.incrementCounter({
      name: "opengeni_codex_lease_renewals_total",
      help: "Codex lease renewal checkpoints by outcome and reason.",
      labels: { workspace_key: this.deps.codexWorkspaceKey, outcome: "lost", reason },
    });
    this.deps.observability.warn("Codex credential lease was lost during an active turn", {
      workspaceId: this.deps.workspaceId,
      turnId: this.deps.getTurnId(),
      reason,
    });
  };

  /** Fail closed at the last worker-confirmed lease deadline before dispatch. */
  assertUsable = (): void => {
    if (this.lost) {
      throw new CodexCredentialLeaseLostError(this.lossReason ?? "not_found");
    }
    if (
      !this.held ||
      this.holderId === null ||
      this.generation === null ||
      codexCredentialLeaseDeadlineExpired(this.confirmedUntilMs)
    ) {
      this.markLost("deadline");
      throw new CodexCredentialLeaseLostError("deadline");
    }
  };

  renew = async (reason: LeaseRenewReason): Promise<void> => {
    const turnId = this.deps.getTurnId();
    if (!turnId || !this.held || !this.holderId || this.generation === null || this.lost) {
      return;
    }
    if (codexCredentialLeaseDeadlineExpired(this.confirmedUntilMs)) {
      this.markLost("deadline");
      return;
    }
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    const renewalStartedAtMs = performance.now();
    try {
      const renewedUntil = await heartbeatCodexCredentialLeaseUntil(
        this.deps.db,
        this.deps.accountId,
        this.deps.workspaceId,
        turnId,
        this.holderId,
        this.generation,
        CODEX_CREDENTIAL_LEASE_TTL_MS,
      );
      if (!renewedUntil) {
        this.markLost("not_found");
      } else {
        this.confirmedUntilMs = renewalStartedAtMs + CODEX_CREDENTIAL_LEASE_TTL_MS;
        this.deps.observability.incrementCounter({
          name: "opengeni_codex_lease_renewals_total",
          help: "Codex lease renewal checkpoints by outcome and reason.",
          labels: {
            workspace_key: this.deps.codexWorkspaceKey,
            outcome: "completed",
            reason,
          },
        });
      }
    } catch (error) {
      if (codexCredentialLeaseDeadlineExpired(this.confirmedUntilMs)) {
        this.markLost("deadline");
        return;
      }
      this.deps.observability.warn("Codex credential lease heartbeat failed", {
        workspaceId: this.deps.workspaceId,
        turnId,
        reason,
        ...safeErrorDiagnostic(error),
      });
      this.deps.observability.incrementCounter({
        name: "opengeni_codex_lease_renewals_total",
        help: "Codex lease renewal checkpoints by outcome and reason.",
        labels: {
          workspace_key: this.deps.codexWorkspaceKey,
          outcome: "error",
          reason,
        },
      });
    } finally {
      this.heartbeatInFlight = false;
    }
  };

  startHeartbeat = (): void => {
    if (!this.deps.getTurnId() || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.renew("timer");
    }, 60_000);
    this.heartbeatTimer.unref?.();
  };

  stopHeartbeat = (): void => {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  };
}

/** The xAI/SuperGrok credential holder for one running turn; same shape. */
export class XaiTurnLease {
  held = false;
  lost = false;
  subjectId: string | null = null;
  holderId: string | null = null;
  generation: number | null = null;
  confirmedUntilMs: number | null = null;
  private heartbeatInFlight = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: TurnCredentialLeaseDeps) {}

  markLost = (reason: LeaseLossReason): void => {
    if (this.lost) return;
    this.lost = true;
    this.deps.observability.warn("xAI credential lease was lost during an active turn", {
      workspaceId: this.deps.workspaceId,
      turnId: this.deps.getTurnId(),
      reason,
    });
  };

  renew = async (): Promise<void> => {
    const turnId = this.deps.getTurnId();
    if (
      !turnId ||
      !this.held ||
      !this.subjectId ||
      !this.holderId ||
      this.generation === null ||
      this.lost
    ) {
      return;
    }
    if (codexCredentialLeaseDeadlineExpired(this.confirmedUntilMs)) {
      this.markLost("deadline");
      return;
    }
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    const renewalStartedAtMs = performance.now();
    try {
      const renewedUntil = await heartbeatXaiCredentialLeaseUntil(this.deps.db, {
        workspaceId: this.deps.workspaceId,
        subjectId: this.subjectId,
        turnId,
        holderId: this.holderId,
        generation: this.generation,
        leaseTtlMs: XAI_CREDENTIAL_LEASE_TTL_MS,
      });
      if (!renewedUntil) {
        this.markLost("not_found");
      } else {
        this.confirmedUntilMs = renewalStartedAtMs + XAI_CREDENTIAL_LEASE_TTL_MS;
      }
    } catch (error) {
      if (codexCredentialLeaseDeadlineExpired(this.confirmedUntilMs)) {
        this.markLost("deadline");
        return;
      }
      this.deps.observability.warn("xAI credential lease heartbeat failed", {
        workspaceId: this.deps.workspaceId,
        turnId,
        ...safeErrorDiagnostic(error),
      });
    } finally {
      this.heartbeatInFlight = false;
    }
  };

  startHeartbeat = (): void => {
    if (!this.deps.getTurnId() || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.renew();
    }, 60_000);
    this.heartbeatTimer.unref?.();
  };

  stopHeartbeat = (): void => {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  };
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
