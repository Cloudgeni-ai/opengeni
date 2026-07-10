// The selfhosted control-op RETRY POLICY — a small, PURE decision function the
// `SelfhostedSession.call()` loop consults after each control-plane reply.
//
// Before this, a typed AgentError surfaced straight to the model as a failed tool
// call: a `DRAINING` backpressure rejection (the machine was momentarily at its
// concurrent-work capacity) and a transient `TIMEOUT` / `agent_reconnecting` blip
// both looked like hard failures even though the op never ran (DRAINING) or was a
// pure read that is safe to re-issue (a read that timed out). This policy retries
// exactly those two, with a hard safety line around anything that MUTATES state.
//
// It is intentionally a pure function (op kind + error + prior-retry counts +
// injected jitter → a decision) so the whole retry matrix is unit-testable with no
// clock, no transport, and no session. The sleep + jitter side effects live behind
// the injected `SelfhostedRetryClock` so tests are deterministic.

import type { SelfhostedControlError } from "./control-rpc";

/**
 * The read-only, idempotent-safe control ops that MAY be retried after a TIMEOUT
 * / `agent_reconnecting` blip.
 *
 * A timed-out request is AT-LEAST-ONCE on the wire: the agent may have RECEIVED
 * and fully EXECUTED the op before its reply was lost, so re-issuing it is only
 * safe when a second execution is observably identical to one — i.e. a pure read.
 * Every MUTATING op (`exec`, `git`, `fsWrite`/`fsMove`/`fsMkdir`/`fsRemove`, and
 * the pty/desktop input ops) is DELIBERATELY EXCLUDED: re-running a mutation that
 * already ran on the machine is a real correctness hazard (a duplicated write, a
 * second `git push`, a re-applied command). Only DRAINING (a pre-admission
 * rejection — see `decideSelfhostedRetry`) is safe to retry for those.
 */
export const SELFHOSTED_IDEMPOTENT_READONLY_OPS: ReadonlySet<string> = new Set([
  "ping",
  "metrics",
  "fsStat",
  "fsList",
  "fsRead",
]);

/** DRAINING is a pre-admission backpressure rejection (the op never started), so
 *  it is safe to retry for ANY op kind. Bounded so a relentlessly-saturated
 *  machine still surfaces a clear error instead of hanging the turn. */
export const SELFHOSTED_DRAINING_MAX_RETRIES = 3;
/** A read-only op that timed out is retried at most once (see the at-least-once
 *  note above — even a read gets a single re-issue, not an unbounded loop). */
export const SELFHOSTED_TIMEOUT_MAX_RETRIES = 1;

/** Full-jitter backoff base (ms). Delay N is sampled in `[0, base * factor^N)`. */
export const SELFHOSTED_RETRY_BACKOFF_BASE_MS = 400;
export const SELFHOSTED_RETRY_BACKOFF_FACTOR = 2;
/** Per-delay ceiling so the summed backoff of the bounded retries stays well under
 *  a few seconds (3 DRAINING retries → at most 400+800+1600 ≈ 2.8s of added wait). */
export const SELFHOSTED_RETRY_BACKOFF_CAP_MS = 2_000;

export type SelfhostedRetryDecision =
  | { readonly action: "fail" }
  | { readonly action: "retry"; readonly delayMs: number };

/**
 * Full-jitter exponential backoff. Returns a delay in
 * `[0, min(cap, base * factor^attempt))`. `jitter` is an injected sample in
 * `[0, 1)` so the delay is fully deterministic under test.
 */
export function selfhostedRetryBackoffMs(attempt: number, jitter: number): number {
  const uncapped = SELFHOSTED_RETRY_BACKOFF_BASE_MS * SELFHOSTED_RETRY_BACKOFF_FACTOR ** attempt;
  const ceiling = Math.min(SELFHOSTED_RETRY_BACKOFF_CAP_MS, uncapped);
  const clampedJitter = Math.min(0.999_999, Math.max(0, jitter));
  return Math.floor(clampedJitter * ceiling);
}

/**
 * PURE retry policy for one selfhosted control-op reply.
 *
 *  - `error.draining` (DRAINING — pre-admission host-work backpressure; the op was
 *    rejected at the pool gate and NEVER started) → retry up to
 *    `SELFHOSTED_DRAINING_MAX_RETRIES` for ANY op kind, since nothing executed.
 *  - `error.reason === "agent_reconnecting"` (a TIMEOUT / transient blip) → retry
 *    at most `SELFHOSTED_TIMEOUT_MAX_RETRIES`, and ONLY for a read-only
 *    idempotent-safe op (`SELFHOSTED_IDEMPOTENT_READONLY_OPS`). A timed-out
 *    MUTATION is never retried here — it may already have run (at-least-once).
 *  - Everything else → no retry at this layer:
 *      · FENCED is retried by the routing proxy against a RE-RESOLVED backend
 *        (retrying here under the same stale epoch would just re-fence);
 *      · AGENT_OFFLINE / OS / PROTOCOL / PAYLOAD_TOO_LARGE / CONSENT_REQUIRED are
 *        not transient and must surface to the caller.
 *
 * The draining and timeout budgets are SEPARATE counters so a read that first hit
 * backpressure still keeps its single timeout re-issue (and vice versa); both are
 * bounded, so the total number of attempts — and the summed backoff — is bounded.
 */
export function decideSelfhostedRetry(input: {
  opKind: string;
  error: SelfhostedControlError;
  drainingRetries: number;
  timeoutRetries: number;
  jitter: number;
}): SelfhostedRetryDecision {
  const { opKind, error, drainingRetries, timeoutRetries, jitter } = input;

  if (error.draining) {
    if (drainingRetries >= SELFHOSTED_DRAINING_MAX_RETRIES) {
      return { action: "fail" };
    }
    return { action: "retry", delayMs: selfhostedRetryBackoffMs(drainingRetries, jitter) };
  }

  if (error.reason === "agent_reconnecting") {
    if (!SELFHOSTED_IDEMPOTENT_READONLY_OPS.has(opKind)) {
      // A timed-out mutation may already have executed on the machine — never
      // re-issue it (at-least-once). Surface the reconnecting error instead.
      return { action: "fail" };
    }
    if (timeoutRetries >= SELFHOSTED_TIMEOUT_MAX_RETRIES) {
      return { action: "fail" };
    }
    return { action: "retry", delayMs: selfhostedRetryBackoffMs(timeoutRetries, jitter) };
  }

  return { action: "fail" };
}

/**
 * The injected clock the retry loop drives — real in production, a deterministic
 * fake in tests. `jitter()` returns a full-jitter sample in `[0, 1)`.
 */
export interface SelfhostedRetryClock {
  sleep(ms: number): Promise<void>;
  jitter(): number;
}

/** The production clock: a real timer + `Math.random()` jitter. */
export const defaultSelfhostedRetryClock: SelfhostedRetryClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  jitter: () => Math.random(),
};
