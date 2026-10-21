import { expect, jest, test } from "bun:test";
import { useEffect, useState } from "react";
import { flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "virtual" });

test("logical flush advances the requested delay and commits its React update", async () => {
  const hook = await renderHook(() => {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const timer = setTimeout(() => setReady(true), 100);
      return () => clearTimeout(timer);
    }, []);
    return ready;
  }, undefined);
  try {
    expect(jest.isFakeTimers()).toBe(true);
    await flush(99);
    expect(hook.result.current).toBe(false);
    await flush(1);
    expect(hook.result.current).toBe(true);
  } finally {
    await hook.unmount();
  }
});

test("logical flush yields to native asynchronous work, not only microtasks", async () => {
  let result: ArrayBuffer | undefined;
  const digest = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode("fixture"))
    .then((value) => {
      result = value;
    });
  for (let turn = 0; turn < 100 && !result; turn += 1) await flush();
  expect(result?.byteLength).toBe(32);
  await digest;
});

test("logical flush settles a request before advancing to its timeout", async () => {
  let result = "pending";
  setTimeout(() => {
    const timeout = setTimeout(() => {
      result = "timed out";
    }, 20);
    void Promise.resolve().then(() => {
      clearTimeout(timeout);
      result = "complete";
    });
  }, 100);
  await flush(1000);
  expect(result).toBe("complete");
});

test("a file can retain real scheduling for a native-boundary assertion", async () => {
  jest.useRealTimers();
  let settled = false;
  setTimeout(() => {
    settled = true;
  }, 0);
  await flush(1);
  expect(jest.isFakeTimers()).toBe(false);
  expect(settled).toBe(true);
});

test("the next test receives a fresh virtual clock after a real-clock exception", async () => {
  expect(jest.isFakeTimers()).toBe(true);
  let settled = false;
  setTimeout(() => {
    settled = true;
  }, 50);
  await flush(50);
  expect(settled).toBe(true);
});
