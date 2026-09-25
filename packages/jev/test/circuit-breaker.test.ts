import { describe, expect, test } from "bun:test";
import {
  CodeSearchWorkspaceError,
  JevCircuitBreaker,
  JevRequestError,
  JevUnavailableError,
} from "../src";

const MIN = 60_000;
const outage = () =>
  new JevUnavailableError("Jev unavailable after 3 attempts (HTTP 503)", { status: 503 });

describe("JevCircuitBreaker", () => {
  test("opens after 3 consecutive unavailable failures for 5 minutes", () => {
    const b = new JevCircuitBreaker();
    b.recordFailure(outage(), 0);
    b.recordFailure(outage(), 1);
    expect(b.isOpen(2)).toBe(false);
    b.recordFailure(outage(), 2);
    expect(b.isOpen(3)).toBe(true);
    expect(b.status(3)).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      openUntil: 2 + 5 * MIN,
      lastFailure: { status: 503, at: 2 },
    });
    expect(b.isOpen(2 + 5 * MIN - 1)).toBe(true);
    expect(b.isOpen(2 + 5 * MIN)).toBe(false);
  });

  test("a success resets the streak", () => {
    const b = new JevCircuitBreaker();
    b.recordFailure(outage(), 0);
    b.recordFailure(outage(), 1);
    b.recordSuccess();
    b.recordFailure(outage(), 2);
    expect(b.isOpen(3)).toBe(false);
    expect(b.status(3)).toMatchObject({ state: "closed", consecutiveFailures: 1, openUntil: null });
  });

  test("401, 402 and 403 open it for 30 minutes", () => {
    for (const status of [401, 402, 403]) {
      const b = new JevCircuitBreaker();
      for (let i = 0; i < 3; i++) b.recordFailure(new JevUnavailableError("auth", { status }), 0);
      expect(b.isOpen(29 * MIN)).toBe(true);
      expect(b.isOpen(30 * MIN)).toBe(false);
    }
  });

  test("half-open after the cooldown: one more failure reopens at once, a success closes", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    b.recordFailure(outage(), 0);
    b.recordFailure(outage(), 0);
    expect(b.status(1000).state).toBe("half_open");
    b.recordFailure(outage(), 1000);
    expect(b.isOpen(1500)).toBe(true);
    expect(b.status(2000).state).toBe("half_open");
    b.recordSuccess();
    expect(b.status(2000)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  test("tryAcquire: closed admits every call, open none, half-open exactly one trial at a time", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    expect([b.tryAcquire(0), b.tryAcquire(0), b.tryAcquire(0)]).toEqual([true, true, true]);
    b.recordFailure(outage(), 0);
    expect(b.tryAcquire(999)).toBe(false);
    // half-open: concurrent callers race for the single trial
    expect(Array.from({ length: 5 }, () => b.tryAcquire(1000))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(b.status(1000)).toMatchObject({ state: "half_open", trialInFlight: true });
    expect(b.tryAcquire(60_000)).toBe(false);
    // isOpen keeps meaning "cooldown running", so the tool is still offered
    expect(b.isOpen(60_000)).toBe(false);
  });

  test("the trial ends with release, recordFailure or recordSuccess", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(outage(), 0);
    // released without contacting Jev: the next caller may try
    expect(b.tryAcquire(1000)).toBe(true);
    b.release();
    expect(b.status(1000)).toMatchObject({ state: "half_open", trialInFlight: false });
    expect(b.tryAcquire(1000)).toBe(true);
    expect(b.tryAcquire(1000)).toBe(false);
    // another error neither reopens nor keeps the trial slot
    b.recordFailure(new JevRequestError("bad", { status: 400 }), 1000);
    expect(b.status(1000)).toMatchObject({ state: "half_open", trialInFlight: false });
    expect(b.tryAcquire(1000)).toBe(true);
    // an unavailable failure reopens at once
    b.recordFailure(outage(), 1000);
    expect(b.tryAcquire(1001)).toBe(false);
    expect(b.status(1001)).toMatchObject({ state: "open", trialInFlight: false });
    // after the next cooldown a successful trial closes the breaker
    expect(b.tryAcquire(2000)).toBe(true);
    expect(b.tryAcquire(2000)).toBe(false);
    b.recordSuccess();
    expect(b.status(2000)).toMatchObject({ state: "closed", trialInFlight: false });
    expect([b.tryAcquire(2000), b.tryAcquire(2000)]).toEqual([true, true]);
  });

  test("errors other than JevUnavailableError are ignored", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1 });
    b.recordFailure(new JevRequestError("bad", { status: 400 }), 0);
    b.recordFailure(new CodeSearchWorkspaceError("rg missing"), 0);
    b.recordFailure(new DOMException("aborted", "AbortError"), 0);
    expect(b.isOpen(1)).toBe(false);
    expect(b.status(1).consecutiveFailures).toBe(0);
  });

  test("a half-open trial that never ends stops blocking after trialTimeoutMs", () => {
    const b = new JevCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1000,
      trialTimeoutMs: 5000,
    });
    b.recordFailure(new JevUnavailableError("down"), 0);
    expect(b.tryAcquire(1000)).toBe(true);
    expect(b.tryAcquire(5999)).toBe(false);
    expect(b.status(5999).trialInFlight).toBe(true);
    expect(b.status(6000).trialInFlight).toBe(false);
    expect(b.tryAcquire(6000)).toBe(true);
    expect(b.tryAcquire(6001)).toBe(false);
  });
});
