import { expect, test } from "bun:test";
import { usePageLiveActivity, usePolledValue } from "../src/hooks/internal";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

test("hidden pages suspend after the grace period and resume immediately when visible", async () => {
  let visibility: DocumentVisibilityState = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  const hook = await renderHook(() => usePageLiveActivity(5), undefined);
  expect(hook.result.current).toBe(true);

  visibility = "hidden";
  await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
  await flush(10);
  expect(hook.result.current).toBe(false);

  visibility = "visible";
  await actRun(() => document.dispatchEvent(new Event("visibilitychange")));
  await flush();
  expect(hook.result.current).toBe(true);
  await hook.unmount();
});

test("completion-scheduled polling never overlaps a slow request", async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const load = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return calls;
  };
  const hook = await renderHook(() => usePolledValue(load, { pollIntervalMs: 1 }), undefined);
  await flush(35);
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(maximumActive).toBe(1);
  await hook.unmount();
});
