import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEPLOYMENT_REFRESH_INTERVAL_MS, startDeploymentRefresh } from "./deployment-refresh";

beforeAll(() => GlobalRegistrator.register({ url: "https://app.example.test/" }));
beforeEach(() => {
  jest.useFakeTimers();
  visibility("visible");
  online(true);
});
afterEach(() => jest.useRealTimers());
afterAll(() => GlobalRegistrator.unregister());

function visibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function online(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

test("checks periodically without duplicating the successful bootstrap read", async () => {
  let reads = 0;
  const stop = startDeploymentRefresh(async () => {
    reads++;
  });
  try {
    expect(reads).toBe(0);
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    expect(reads).toBe(1);
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS - 1);
    expect(reads).toBe(1);
    await advance(1);
    expect(reads).toBe(2);
  } finally {
    stop();
  }
});

test("a failed background read retries at the normal interval", async () => {
  let reads = 0;
  const stop = startDeploymentRefresh(async () => {
    reads++;
    throw new TypeError("Synthetic network failure");
  });
  try {
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    expect(reads).toBe(1);
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    expect(reads).toBe(2);
  } finally {
    stop();
  }
});

test("skips hidden or offline time and checks immediately on return", async () => {
  let reads = 0;
  const stop = startDeploymentRefresh(async () => {
    reads++;
  });
  try {
    visibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS * 2);
    expect(reads).toBe(0);
    online(false);
    visibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    expect(reads).toBe(0);
    online(true);
    window.dispatchEvent(new Event("online"));
    await advance(0);
    expect(reads).toBe(1);
  } finally {
    stop();
  }
});

test("one in-flight read coalesces return events and cleanup aborts it", async () => {
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const stop = startDeploymentRefresh(async (signal) => {
    signals.push(signal);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  try {
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS * 2);
    expect(signals).toHaveLength(1);
    stop();
    expect(signals[0]!.aborted).toBe(true);
    release();
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    window.dispatchEvent(new Event("online"));
    expect(signals).toHaveLength(1);
  } finally {
    stop();
  }
});

test("returning before an aborted read settles waits for it, then checks once", async () => {
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const stop = startDeploymentRefresh(async (signal) => {
    signals.push(signal);
    if (signals.length === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  try {
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS);
    visibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(signals[0]!.aborted).toBe(true);
    visibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    expect(signals).toHaveLength(1);
    release();
    await advance(0);
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    await advance(DEPLOYMENT_REFRESH_INTERVAL_MS - 1);
    expect(signals).toHaveLength(2);
  } finally {
    stop();
  }
});
