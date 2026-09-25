/**
 * In-process circuit breaker for Jev. Consecutive JevUnavailableError failures open it for a cooldown, so a
 * Jev outage costs one fast refusal per call instead of a full retry cycle. After the cooldown one trial call
 * is let through (half-open): success closes the breaker, another unavailable failure reopens it at once.
 * Other errors (a rejected request, a workspace failure, an abort) neither count nor reset the streak.
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
}

export type JevCircuitState = "closed" | "open" | "half_open";

export interface JevCircuitStatus {
  state: JevCircuitState;
  consecutiveFailures: number;
  /** Epoch ms until which calls are refused; null when not open. */
  openUntil: number | null;
  lastFailure: { message: string; status: number | null; at: number } | null;
}

export class JevCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly authCooldownMs: number;
  private consecutiveFailures = 0;
  private openUntil: number | null = null;
  private lastFailure: JevCircuitStatus["lastFailure"] = null;

  constructor(options: JevCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.authCooldownMs = options.authCooldownMs ?? 30 * 60_000;
  }

  /** True while calls should be refused without contacting Jev. */
  isOpen(now: number = Date.now()): boolean {
    return this.openUntil !== null && now < this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = null;
  }

  recordFailure(error: unknown, now: number = Date.now()): void {
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
      lastFailure: this.lastFailure,
    };
  }
}
