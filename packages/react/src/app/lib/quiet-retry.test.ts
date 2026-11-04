import { afterEach, describe, expect, jest, test } from "bun:test";

import { registerDom } from "../../../test/render-hook";
import { createQuietRetry } from "./quiet-retry";

registerDom();

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("quiet retry", () => {
  afterEach(() => {
    jest.useRealTimers();
    setVisibility("visible");
  });

  test("waits longer after each failure, settles at the last pause and starts over on success", () => {
    jest.useFakeTimers();
    const retry = createQuietRetry([10, 20, 40]);
    let runs = 0;
    const run = () => {
      runs += 1;
    };
    retry.schedule(run);
    jest.advanceTimersByTime(9);
    expect(runs).toBe(0);
    jest.advanceTimersByTime(1);
    expect(runs).toBe(1);
    retry.schedule(run);
    jest.advanceTimersByTime(19);
    expect(runs).toBe(1);
    jest.advanceTimersByTime(1);
    expect(runs).toBe(2);
    retry.schedule(run);
    jest.advanceTimersByTime(40);
    retry.schedule(run);
    jest.advanceTimersByTime(40);
    expect(runs).toBe(4);
    retry.reset();
    retry.schedule(run);
    jest.advanceTimersByTime(10);
    expect(runs).toBe(5);
  });

  test("a newer schedule or cancel replaces the waiting retry", () => {
    jest.useFakeTimers();
    const retry = createQuietRetry([10]);
    const runs: string[] = [];
    retry.schedule(() => runs.push("first"));
    retry.schedule(() => runs.push("second"));
    jest.advanceTimersByTime(10);
    expect(runs).toEqual(["second"]);
    retry.schedule(() => runs.push("cancelled"));
    retry.cancel();
    jest.advanceTimersByTime(100);
    expect(runs).toEqual(["second"]);
  });

  test("another key (a workspace switch) starts over at the first pause", () => {
    jest.useFakeTimers();
    const retry = createQuietRetry([10, 20, 40]);
    let runs = 0;
    const run = () => {
      runs += 1;
    };
    retry.schedule(run, "workspace-a");
    jest.advanceTimersByTime(10);
    retry.schedule(run, "workspace-a");
    jest.advanceTimersByTime(20);
    expect(runs).toBe(2);
    retry.cancel();
    retry.schedule(run, "workspace-b");
    jest.advanceTimersByTime(10);
    expect(runs).toBe(3);
  });

  test("a hidden page asks nothing until it is back in view", () => {
    jest.useFakeTimers();
    const retry = createQuietRetry([10]);
    let runs = 0;
    setVisibility("hidden");
    retry.schedule(() => {
      runs += 1;
    });
    jest.advanceTimersByTime(1_000);
    expect(runs).toBe(0);
    setVisibility("visible");
    expect(runs).toBe(1);
    setVisibility("hidden");
    setVisibility("visible");
    expect(runs).toBe(1);
  });
});
