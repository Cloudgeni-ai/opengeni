import { expect, test } from "bun:test";
import type { EstablishedSandboxSession } from "@opengeni/runtime/sandbox";
import { SandboxHostHandleCache, releaseSandboxHostHandle } from "../src/sandbox/host-handle-cache";

function fixture() {
  let legacyCloses = 0;
  const handle = {
    session: { close: async () => legacyCloses++ },
    instanceId: "sb-cache-fixture",
  } as unknown as EstablishedSandboxSession;
  return { handle, legacyCloses: () => legacyCloses };
}

test("overlapping borrowers share only the SDK identity and close once after eviction and last release", async () => {
  const { handle } = fixture();
  let creates = 0;
  const closed: EstablishedSandboxSession[] = [];
  const cache = new SandboxHostHandleCache(60_000, 2, async (value) => {
    closed.push(value);
  });
  const acquire = () =>
    cache.acquire("exact", async () => {
      creates++;
      return handle;
    });
  const [a, b] = await Promise.all([acquire(), acquire()]);
  expect(creates).toBe(1);
  expect(a).not.toBe(b);
  expect(a.session).toBe(handle.session);
  expect(b.session).toBe(handle.session);
  cache.evict("exact");
  expect(closed).toHaveLength(0);
  await releaseSandboxHostHandle(a);
  await releaseSandboxHostHandle(a);
  expect(closed).toHaveLength(0);
  await releaseSandboxHostHandle(b);
  await releaseSandboxHostHandle(b);
  expect(closed).toEqual([handle]);
});

test("evicted pending establishment remains owned until its borrower leaves", async () => {
  const { handle } = fixture();
  let resolve!: (value: EstablishedSandboxSession) => void;
  const pending = new Promise<EstablishedSandboxSession>((done) => {
    resolve = done;
  });
  let closes = 0;
  const cache = new SandboxHostHandleCache(60_000, 1, async () => {
    closes++;
  });
  const old = cache.acquire("old", async () => pending);
  const next = await cache.acquire("next", async () => fixture().handle);
  expect(closes).toBe(0);
  resolve(handle);
  const borrowed = await old;
  expect(closes).toBe(0);
  await releaseSandboxHostHandle(borrowed);
  expect(closes).toBe(1);
  cache.evict("next");
  await releaseSandboxHostHandle(next);
  expect(closes).toBe(2);
});

test("failed establishment is not cached and a replacement is not evicted by an old failure", async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<EstablishedSandboxSession>((_resolve, fail) => {
    reject = fail;
  });
  const cache = new SandboxHostHandleCache(60_000, 1);
  const failed = cache.acquire("exact", async () => pending);
  const observedFailure = failed.catch((error: unknown) => error);
  cache.evict("exact");
  const f = fixture();
  const replacement = await cache.acquire("exact", async () => f.handle);
  reject(new Error("creation failed"));
  expect(await observedFailure).toEqual(new Error("creation failed"));
  const shared = await cache.acquire("exact", async () => {
    throw new Error("must reuse");
  });
  expect(shared.session).toBe(replacement.session);
  cache.evict("exact");
  await releaseSandboxHostHandle(shared);
  await releaseSandboxHostHandle(replacement);
  expect(f.legacyCloses()).toBe(0);
});

test("idle expiry needs no later request, but does not retire an actively borrowed handle", async () => {
  let closes = 0;
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  const cache = new SandboxHostHandleCache(10, 1, async () => {
    closes++;
    notifyClosed();
  });
  const a = await cache.acquire("exact", async () => fixture().handle);
  await Bun.sleep(30);
  expect(closes).toBe(0);
  await releaseSandboxHostHandle(a);
  await closed;
  expect(closes).toBe(1);
});

test("remember transfers an uncached handle, refuses borrowed transfer, and leaves legacy close untouched", async () => {
  const f = fixture();
  const cache = new SandboxHostHandleCache(60_000, 1);
  const a = await cache.remember("exact", f.handle);
  await expect(cache.remember("other", a)).rejects.toThrow("borrowed");
  cache.evict("exact");
  await releaseSandboxHostHandle(a);
  await releaseSandboxHostHandle(f.handle);
  expect(f.legacyCloses()).toBe(0);
});

test("a failed last-close is observable and never invoked twice", async () => {
  let closes = 0;
  const cache = new SandboxHostHandleCache(60_000, 1, async () => {
    closes++;
    throw new Error("join failed");
  });
  const handle = await cache.acquire("exact", async () => fixture().handle);
  cache.evict("exact");
  await expect(releaseSandboxHostHandle(handle)).rejects.toThrow("join failed");
  await expect(releaseSandboxHostHandle(handle)).rejects.toThrow("join failed");
  expect(closes).toBe(1);
});
