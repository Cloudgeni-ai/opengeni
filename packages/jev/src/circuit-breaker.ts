/**
 * In-process circuit breaker for Jev. Consecutive JevUnavailableError failures open it for a cooldown, so a
 * Jev outage costs one fast refusal per call instead of a full retry cycle. After the cooldown the breaker is
 * half-open and tryAcquire() admits exactly one trial call at a time.
 *
 * Every admitted call gets a lease and settles it exactly once:
 * - recordSuccess(lease) from any call closes the breaker, because any success proves Jev works.
 * - recordFailure(unavailable, now, lease) from any call counts, and reopens a half-open breaker at once.
 * - release(lease) (the call never reached Jev) or recordFailure with another error (a rejected request, a
 *   workspace failure, an abort) neither counts nor resets the streak. It ends the trial only when that
 *   lease is the trial, so a call admitted while closed cannot free the slot of a trial running now.
 * isOpen() only says whether the cooldown is running, so a half-open breaker still offers the tool.
 * The worker keeps one breaker per process.
 */
import { JevUnavailableError } from "./client";

export interface JevCircuitBreakerOptions {
  /** Consecutive unavailable failures that open the breaker. */
  failureThreshold?: number | undefined;
  /** Cooldown after an outage-style failure. */
  cooldownMs?: number | undefined;
  /** Cooldown when the opening failure was HTTP 401/402/403 (key or billing problem). */
  authCooldownMs?: number | undefined;
  /** A half-open trial that has not ended after this long no longer blocks the next trial. */
  trialTimeoutMs?: number | undefined;
}

/** One admitted call. Leases are matched by identity, so only the issued object ends its trial. */
export interface JevCircuitLease {
  readonly id: number;
  /** This call is the half-open trial. */
  readonly trial: boolean;
}

export type JevCircuitState = "closed" | "open" | "half_open";

export interface JevCircuitStatus {
  state: JevCircuitState;
  consecutiveFailures: number;
  /** Epoch ms until which calls are refused; null when not open. */
  openUntil: number | null;
  /** Half-open and the one trial call is running. */
  trialInFlight: boolean;
  lastFailure: { message: string; status: number | null; at: number } | null;
}

export class JevCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly authCooldownMs: number;
  private readonly trialTimeoutMs: number;
  private consecutiveFailures = 0;
  private openUntil: number | null = null;
  private trial: { lease: JevCircuitLease; startedAt: number } | null = null;
  private nextLeaseId = 1;
  private lastFailure: JevCircuitStatus["lastFailure"] = null;

  constructor(options: JevCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.authCooldownMs = options.authCooldownMs ?? 30 * 60_000;
    // Longer than one Jev retry cycle at the largest allowed request timeout (3 attempts of up to
    // 120 s, OPENGENI_JEV_REQUEST_TIMEOUT_MS) plus backoff and sandbox recall, so a slow trial is not
    // mistaken for a stuck one and joined by a second trial.
    this.trialTimeoutMs = options.trialTimeoutMs ?? 10 * 60_000;
  }

  /** True while calls should be refused without contacting Jev (the cooldown is running). */
  isOpen(now: number = Date.now()): boolean {
    return this.openUntil !== null && now < this.openUntil;
  }

  /**
   * Admit one call and return its lease, or null when refused. Closed: always. Open: never. Half-open:
   * only the first caller, as the trial, until its lease is settled or it has run for trialTimeoutMs, so
   * a trial that never ends cannot block the tool for good.
   */
  tryAcquire(now: number = Date.now()): JevCircuitLease | null {
    if (this.openUntil === null) return this.issue(false);
    if (now < this.openUntil) return null;
    if (this.trial !== null && now - this.trial.startedAt < this.trialTimeoutMs) return null;
    const lease = this.issue(true);
    this.trial = { lease, startedAt: now };
    return lease;
  }

  /** End an admitted call that did not contact Jev, so its outcome says nothing about Jev. */
  release(lease: JevCircuitLease): void {
    if (this.trial !== null && this.trial.lease === lease) this.trial = null;
  }

  /** Any call's success proves Jev works, so the lease does not change the outcome. */
  recordSuccess(_lease?: JevCircuitLease | null): void {
    this.consecutiveFailures = 0;
    this.openUntil = null;
    this.trial = null;
  }

  /** Settle a failed call. A failure without a lease counts the same but never ends a trial. */
  recordFailure(error: unknown, now: number = Date.now(), lease?: JevCircuitLease | null): void {
    if (!(error instanceof JevUnavailableError)) {
      if (lease) this.release(lease);
      return;
    }
    const halfOpen = this.openUntil !== null && now >= this.openUntil;
    this.consecutiveFailures += 1;
    this.lastFailure = { message: error.message, status: error.status ?? null, at: now };
    if (halfOpen || this.consecutiveFailures >= this.failureThreshold) {
      const auth = error.status === 401 || error.status === 402 || error.status === 403;
      this.openUntil = now + (auth ? this.authCooldownMs : this.cooldownMs);
      // A new cooldown starts: whatever trial was running no longer blocks the next one.
      this.trial = null;
    }
  }

  status(now: number = Date.now()): JevCircuitStatus {
    const state: JevCircuitState =
      this.openUntil === null ? "closed" : now < this.openUntil ? "open" : "half_open";
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      openUntil: state === "open" ? this.openUntil : null,
      trialInFlight:
        state === "half_open" &&
        this.trial !== null &&
        now - this.trial.startedAt < this.trialTimeoutMs,
      lastFailure: this.lastFailure,
    };
  }

  private issue(trial: boolean): JevCircuitLease {
    return Object.freeze({ id: this.nextLeaseId++, trial });
  }
}
