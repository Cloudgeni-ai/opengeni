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
    expect([b.tryAcquire(0), b.tryAcquire(0), b.tryAcquire(0)].map((l) => l?.trial)).toEqual([
      false,
      false,
      false,
    ]);
    b.recordFailure(outage(), 0);
    expect(b.tryAcquire(999)).toBeNull();
    // half-open: concurrent callers race for the single trial
    expect(Array.from({ length: 5 }, () => b.tryAcquire(1000)?.trial ?? null)).toEqual([
      true,
      null,
      null,
      null,
      null,
    ]);
    expect(b.status(1000)).toMatchObject({ state: "half_open", trialInFlight: true });
    expect(b.tryAcquire(60_000)).toBeNull();
    // isOpen keeps meaning "cooldown running", so the tool is still offered
    expect(b.isOpen(60_000)).toBe(false);
  });

  test("the trial ends with release, recordFailure or recordSuccess of its lease", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure(outage(), 0);
    // released without contacting Jev: the next caller may try
    const first = b.tryAcquire(1000)!;
    b.release(first);
    expect(b.status(1000)).toMatchObject({ state: "half_open", trialInFlight: false });
    const second = b.tryAcquire(1000)!;
    expect(second.trial).toBe(true);
    expect(b.tryAcquire(1000)).toBeNull();
    // another error neither reopens nor keeps the trial slot
    b.recordFailure(new JevRequestError("bad", { status: 400 }), 1000, second);
    expect(b.status(1000)).toMatchObject({ state: "half_open", trialInFlight: false });
    const third = b.tryAcquire(1000)!;
    // an unavailable failure reopens at once
    b.recordFailure(outage(), 1000, third);
    expect(b.tryAcquire(1001)).toBeNull();
    expect(b.status(1001)).toMatchObject({ state: "open", trialInFlight: false });
    // after the next cooldown a successful trial closes the breaker
    const fourth = b.tryAcquire(2000)!;
    expect(b.tryAcquire(2000)).toBeNull();
    b.recordSuccess(fourth);
    expect(b.status(2000)).toMatchObject({ state: "closed", trialInFlight: false });
    expect([b.tryAcquire(2000)?.trial, b.tryAcquire(2000)?.trial]).toEqual([false, false]);
  });

  test("a call admitted while closed cannot end a trial that started later", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    const released = b.tryAcquire(0)!;
    const rejected = b.tryAcquire(0)!;
    const aborted = b.tryAcquire(0)!;
    b.recordFailure(outage(), 0);
    const trial = b.tryAcquire(1000)!;
    expect(trial.trial).toBe(true);

    b.release(released);
    b.recordFailure(new JevRequestError("bad", { status: 400 }), 1001, rejected);
    b.recordFailure(new DOMException("aborted", "AbortError"), 1002, aborted);
    b.recordFailure(new JevRequestError("bad", { status: 400 }), 1003);
    expect(b.status(1003)).toMatchObject({ state: "half_open", trialInFlight: true });
    expect(b.tryAcquire(1003)).toBeNull();

    // the trial's own lease still ends it
    b.release(trial);
    expect(b.status(1004)).toMatchObject({ state: "half_open", trialInFlight: false });
    expect(b.tryAcquire(1004)?.trial).toBe(true);
  });

  test("any call's success closes the breaker, and any call's outage reopens it", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    const early = b.tryAcquire(0)!;
    const late = b.tryAcquire(0)!;
    b.recordFailure(outage(), 0);
    const trial = b.tryAcquire(1000)!;
    // a closed-era outage reopens at once and frees the slot for the next cooldown's trial
    b.recordFailure(outage(), 1001, early);
    expect(b.status(1001)).toMatchObject({ state: "open", trialInFlight: false });
    const next = b.tryAcquire(2001)!;
    expect(next.trial).toBe(true);
    // the superseded trial settling does not end the new one
    b.release(trial);
    expect(b.status(2001).trialInFlight).toBe(true);
    // a closed-era success still proves Jev works
    b.recordSuccess(late);
    expect(b.status(2001)).toMatchObject({ state: "closed", trialInFlight: false });
    b.release(next);
    expect(b.status(2001).state).toBe("closed");
  });

  test("leases are distinct and matched by identity", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    const leases = [b.tryAcquire(0)!, b.tryAcquire(0)!];
    b.recordFailure(outage(), 0);
    const trial = b.tryAcquire(1000)!;
    leases.push(trial);
    expect(new Set(leases.map((l) => l.id)).size).toBe(3);
    expect(leases.map((l) => l.trial)).toEqual([false, false, true]);
    expect(Object.isFrozen(trial)).toBe(true);

    // a copy, or another breaker's lease with the same id, is not the trial
    b.release({ ...trial });
    const other = new JevCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    let foreign = other.tryAcquire(0)!;
    while (foreign.id < trial.id) foreign = other.tryAcquire(0)!;
    expect(foreign.id).toBe(trial.id);
    b.release(foreign);
    b.recordFailure(new JevRequestError("bad", { status: 400 }), 1000, foreign);
    expect(b.status(1000).trialInFlight).toBe(true);

    b.release(trial);
    expect(b.status(1000).trialInFlight).toBe(false);
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
    const stuck = b.tryAcquire(1000)!;
    expect(b.tryAcquire(5999)).toBeNull();
    expect(b.status(5999).trialInFlight).toBe(true);
    expect(b.status(6000).trialInFlight).toBe(false);
    expect(b.tryAcquire(6000)?.trial).toBe(true);
    expect(b.tryAcquire(6001)).toBeNull();
    // the expired trial settling late does not end its successor
    b.release(stuck);
    expect(b.status(6001).trialInFlight).toBe(true);
  });

  test("a trial blocks others for 10 minutes by default", () => {
    const b = new JevCircuitBreaker({ failureThreshold: 1 });
    b.recordFailure(outage(), 0);
    expect(b.tryAcquire(5 * MIN)?.trial).toBe(true);
    expect(b.tryAcquire(15 * MIN - 1)).toBeNull();
    expect(b.tryAcquire(15 * MIN)?.trial).toBe(true);
  });
});
