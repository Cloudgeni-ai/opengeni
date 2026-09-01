import { describe, expect, test } from "bun:test";
import type { OpenGeniExternalStore } from "@opengeni/sdk/session";
import { controllerStore, readableFromController } from "../src/store";

function controller(): OpenGeniExternalStore<{ value: number }> & {
  counts: { starts: number; destroys: number; subscriptions: number };
  publish(value: number): void;
} {
  let snapshot = { value: 0 };
  const listeners = new Set<() => void>();
  const counts = { starts: 0, destroys: 0, subscriptions: 0 };
  return {
    counts,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      counts.subscriptions += 1;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      counts.starts += 1;
    },
    destroy() {
      counts.destroys += 1;
      listeners.clear();
    },
    publish(value) {
      snapshot = { value };
      for (const listener of listeners) listener();
    },
  };
}

describe("native Svelte controller readables", () => {
  test("shares one controller, publishes snapshots directly, and retires after the final owner", async () => {
    const owned = controller();
    const readable = readableFromController(owned, { startOnServer: true });
    const first: number[] = [];
    const second: number[] = [];
    const unsubscribeFirst = readable.subscribe((snapshot) => first.push(snapshot.value));
    const unsubscribeSecond = readable.subscribe((snapshot) => second.push(snapshot.value));
    owned.publish(1);
    expect(first).toEqual([0, 1]);
    expect(second).toEqual([0, 1]);
    expect(owned.counts.starts).toBe(1);

    unsubscribeFirst();
    await Promise.resolve();
    expect(owned.counts.destroys).toBe(0);
    unsubscribeSecond();
    await Promise.resolve();
    expect(owned.counts.destroys).toBe(1);
  });

  test("a synchronous remount cancels retirement and host-owned controllers are never destroyed", async () => {
    const owned = controller();
    const readable = readableFromController(owned, { startOnServer: true });
    const unsubscribe = readable.subscribe(() => undefined);
    unsubscribe();
    const remounted = readable.subscribe(() => undefined);
    await Promise.resolve();
    expect(owned.counts.destroys).toBe(0);
    remounted();
    await Promise.resolve();
    expect(owned.counts.destroys).toBe(1);

    const external = controller();
    const wrapped = controllerStore(external, { owned: false, startOnServer: true });
    const release = wrapped.store.subscribe(() => undefined);
    release();
    await Promise.resolve();
    wrapped.destroy();
    expect(external.counts.destroys).toBe(0);
  });

  test("acquires a linked lifecycle once and releases it after the final owner", async () => {
    const owned = controller();
    const linked = controller();
    let acquisitions = 0;
    let releases = 0;
    const readable = readableFromController(owned, {
      acquire: () => {
        acquisitions += 1;
        void linked.start();
        return () => {
          releases += 1;
          linked.destroy();
        };
      },
      startOnServer: true,
    });
    const unsubscribeFirst = readable.subscribe(() => undefined);
    const unsubscribeSecond = readable.subscribe(() => undefined);
    expect(owned.counts.starts).toBe(1);
    expect(linked.counts.starts).toBe(1);
    expect(acquisitions).toBe(1);
    unsubscribeFirst();
    unsubscribeSecond();
    await Promise.resolve();
    expect(releases).toBe(1);
    expect(linked.counts.destroys).toBe(1);
  });
});
