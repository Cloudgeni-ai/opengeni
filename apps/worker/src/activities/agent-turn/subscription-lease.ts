export type LeaseRenewReason = "timer" | "runtime_event" | "model_usage";
export type LeaseLossReason = "deadline" | "not_found";

type LeaseIdentity = { turnId: string; holderId: string; generation: number };
export type SubscriptionLeaseDeps = {
  ttlMs: number;
  getTurnId: () => string | undefined;
  heartbeat: (identity: LeaseIdentity) => Promise<Date | null>;
  onLost: (reason: LeaseLossReason) => void;
  onRenewed?: (reason: LeaseRenewReason) => void;
  onError: (error: unknown, reason: LeaseRenewReason) => void;
  lostError: (reason: LeaseLossReason) => Error;
  now?: () => number;
};

/** Cross-provider lease lifecycle. Only on-time DB confirmation extends ownership. */
export class SubscriptionTurnLease {
  held = false;
  lost = false;
  lossReason: LeaseLossReason | null = null;
  holderId: string | null = null;
  generation: number | null = null;
  confirmedUntilMs: number | null = null;
  private heartbeatInFlight = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;

  constructor(private readonly leaseDeps: SubscriptionLeaseDeps) {
    if (!Number.isFinite(leaseDeps.ttlMs) || leaseDeps.ttlMs <= 0)
      throw new Error("Subscription lease TTL must be positive");
    this.now = leaseDeps.now ?? (() => performance.now());
  }

  private expired = (deadline: number | null): boolean =>
    deadline === null || !Number.isFinite(deadline) || this.now() >= deadline;

  markLost = (reason: LeaseLossReason): void => {
    if (this.lost) return;
    this.lost = true;
    this.lossReason = reason;
    this.leaseDeps.onLost(reason);
  };

  assertUsable = (): void => {
    if (this.lost) throw this.leaseDeps.lostError(this.lossReason ?? "not_found");
    if (
      !this.held ||
      this.holderId === null ||
      this.generation === null ||
      this.expired(this.confirmedUntilMs)
    ) {
      this.markLost("deadline");
      throw this.leaseDeps.lostError("deadline");
    }
  };

  renew = async (reason: LeaseRenewReason = "timer"): Promise<void> => {
    const turnId = this.leaseDeps.getTurnId();
    if (!turnId || !this.held || !this.holderId || this.generation === null || this.lost) return;
    if (this.expired(this.confirmedUntilMs)) {
      this.markLost("deadline");
      return;
    }
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    const priorDeadline = this.confirmedUntilMs;
    const startedAt = this.now();
    const identity = { turnId, holderId: this.holderId, generation: this.generation };
    try {
      const renewedUntil = await this.leaseDeps.heartbeat(identity);
      // A late confirmation is not proof of uninterrupted ownership, even if
      // Postgres extended the row. A changed holder must also discard its reply.
      if (
        !this.held ||
        this.lost ||
        this.leaseDeps.getTurnId() !== identity.turnId ||
        this.holderId !== identity.holderId ||
        this.generation !== identity.generation
      )
        return;
      if (!renewedUntil) this.markLost("not_found");
      else if (this.expired(priorDeadline) || this.expired(startedAt + this.leaseDeps.ttlMs))
        this.markLost("deadline");
      else {
        this.confirmedUntilMs = startedAt + this.leaseDeps.ttlMs;
        this.leaseDeps.onRenewed?.(reason);
      }
    } catch (error) {
      if (
        !this.held ||
        this.lost ||
        this.leaseDeps.getTurnId() !== identity.turnId ||
        this.holderId !== identity.holderId ||
        this.generation !== identity.generation
      )
        return;
      if (this.expired(this.confirmedUntilMs)) this.markLost("deadline");
      else this.leaseDeps.onError(error, reason);
    } finally {
      this.heartbeatInFlight = false;
    }
  };

  startHeartbeat = (): void => {
    if (!this.leaseDeps.getTurnId() || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.renew("timer"), 60_000);
    this.heartbeatTimer.unref?.();
  };

  stopHeartbeat = (): void => {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  };
}
