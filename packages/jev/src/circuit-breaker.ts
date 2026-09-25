/**
 * In-process circuit breaker for Jev. Consecutive JevUnavailableError failures open it for a cooldown, so a
 * Jev outage costs one fast refusal per call instead of a full retry cycle. After the cooldown the breaker is
 * half-open and tryAcquire() admits exactly one trial call at a time: success closes the breaker, another
 * unavailable failure reopens it at once, and any other outcome (recordFailure with another error, or
 * release() when the call never reached Jev) lets the next caller try. Other errors (a rejected request, a
 * workspace failure, an abort) neither count nor reset the streak.
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
  private trialStartedAt: number | null = null;
  private lastFailure: JevCircuitStatus["lastFailure"] = null;

  constructor(options: JevCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.authCooldownMs = options.authCooldownMs ?? 30 * 60_000;
    this.trialTimeoutMs = options.trialTimeoutMs ?? 3 * 60_000;
  }

  /** True while calls should be refused without contacting Jev (the cooldown is running). */
  isOpen(now: number = Date.now()): boolean {
    return this.openUntil !== null && now < this.openUntil;
  }

  /**
   * Admit one call. Closed: always. Open: never. Half-open: only the first caller, as the trial, until it
   * ends with recordSuccess(), recordFailure() or release(), or until it has run for trialTimeoutMs, so a
   * trial that never ends cannot block the tool for good.
   */
  tryAcquire(now: number = Date.now()): boolean {
    if (this.openUntil === null) return true;
    if (now < this.openUntil) return false;
    if (this.trialStartedAt !== null && now - this.trialStartedAt < this.trialTimeoutMs)
      return false;
    this.trialStartedAt = now;
    return true;
  }

  /** End an admitted call that did not contact Jev, so its outcome says nothing about Jev. */
  release(): void {
    this.trialStartedAt = null;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = null;
    this.trialStartedAt = null;
  }

  recordFailure(error: unknown, now: number = Date.now()): void {
    this.trialStartedAt = null;
    if (!(error instanceof JevUnavailableError)) return;
    const halfOpen = this.openUntil !== null && now >= this.openUntil;
    this.consecutiveFailures += 1;
    this.lastFailure = { message: error.message, status: error.status ?? null, at: now };
    if (halfOpen || this.consecutiveFailures >= this.failureThreshold) {
      const auth = error.status === 401 || error.status === 402 || error.status === 403;
      this.openUntil = now + (auth ? this.authCooldownMs : this.cooldownMs);
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
        this.trialStartedAt !== null &&
        now - this.trialStartedAt < this.trialTimeoutMs,
      lastFailure: this.lastFailure,
    };
  }
}
