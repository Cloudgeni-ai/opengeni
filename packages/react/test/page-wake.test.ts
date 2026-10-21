import { afterEach, expect, jest, spyOn, test } from "bun:test";
import {
  PAGE_WAKE_CHECK_INTERVAL_MS,
  PAGE_WAKE_GAP_MS,
  subscribePageWake,
} from "../src/hooks/page-wake";
import { registerDom } from "./render-hook";

registerDom();

const realNow = Date.now;
let clockOffset = 0;

afterEach(() => {
  Date.now = realNow;
  clockOffset = 0;
});

/** Move the wall clock without running timers, as a machine sleep does. */
function sleepFor(ms: number) {
  clockOffset += ms;
  Date.now = () => realNow() + clockOffset;
}

test("a wall-clock jump between timer ticks is a wake; ordinary ticks are not", () => {
  jest.useFakeTimers();
  // Timers advance by hand; the wall clock only moves with sleepFor.
  sleepFor(0);
  const tick = () => {
    clockOffset += PAGE_WAKE_CHECK_INTERVAL_MS;
    jest.advanceTimersByTime(PAGE_WAKE_CHECK_INTERVAL_MS);
  };
  let wakes = 0;
  const unsubscribe = subscribePageWake(() => {
    wakes += 1;
  });
  try {
    for (let index = 0; index < 20; index += 1) tick();
    expect(wakes).toBe(0);
    sleepFor(PAGE_WAKE_GAP_MS + 1_000);
    tick();
    expect(wakes).toBe(1);
    tick();
    expect(wakes).toBe(1);
  } finally {
    unsubscribe();
    jest.useRealTimers();
  }
});

test("a page that becomes visible after a sleep wakes at once, before the next tick", () => {
  let wakes = 0;
  const unsubscribe = subscribePageWake(() => {
    wakes += 1;
  });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wakes).toBe(0);
    sleepFor(PAGE_WAKE_GAP_MS + 1_000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(wakes).toBe(1);
  } finally {
    unsubscribe();
  }
});

test("network return, lifecycle resume and a bfcache restore wake every subscriber", () => {
  const wakes: string[] = [];
  const first = subscribePageWake(() => wakes.push("first"));
  const throwing = subscribePageWake(() => {
    throw new Error("one subscriber failed");
  });
  const second = subscribePageWake(() => wakes.push("second"));
  try {
    window.dispatchEvent(new Event("online"));
    expect(wakes).toEqual(["first", "second"]);
    document.dispatchEvent(new Event("resume"));
    expect(wakes).toHaveLength(4);
    const restored = new Event("pageshow") as Event & { persisted?: boolean };
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    expect(wakes).toHaveLength(6);
    // An ordinary page load is not a wake.
    window.dispatchEvent(new Event("pageshow"));
    expect(wakes).toHaveLength(6);
  } finally {
    first();
    throwing();
    second();
  }
  // The last unsubscribe stops listening.
  window.dispatchEvent(new Event("online"));
  expect(wakes).toHaveLength(6);
});

test("one wall-clock timer serves every subscriber and stops with the last", () => {
  const started = spyOn(globalThis, "setInterval");
  const stopped = spyOn(globalThis, "clearInterval");
  try {
    const first = subscribePageWake(() => {});
    const second = subscribePageWake(() => {});
    expect(started).toHaveBeenCalledTimes(1);
    const timer = started.mock.results[0]!.value;
    first();
    expect(stopped).not.toHaveBeenCalled();
    second();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith(timer);
  } finally {
    started.mockRestore();
    stopped.mockRestore();
  }
});
