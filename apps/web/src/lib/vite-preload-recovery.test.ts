import { describe, expect, test } from "bun:test";

import { installVitePreloadRecovery } from "./vite-preload-recovery";

describe("Vite preload recovery", () => {
  test("reloads once for one app build and prevents the lazy import error", () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    let reloads = 0;
    installVitePreloadRecovery({
      target,
      storage,
      buildId: "https://example.test/assets/app-old.js",
      reload: () => {
        reloads += 1;
      },
    });

    const first = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reloads).toBe(1);

    const repeated = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(false);
    expect(reloads).toBe(1);
  });

  test("permits recovery again after the entry asset changes", () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    let reloads = 0;
    installVitePreloadRecovery({
      target,
      storage,
      buildId: "https://example.test/assets/app-old.js",
      reload: () => {
        reloads += 1;
      },
    });
    target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    const nextTarget = new EventTarget();
    installVitePreloadRecovery({
      target: nextTarget,
      storage,
      buildId: "https://example.test/assets/app-new.js",
      reload: () => {
        reloads += 1;
      },
    });
    nextTarget.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    expect(reloads).toBe(2);
  });

  test("does not risk a reload loop when session storage is unavailable", () => {
    const target = new EventTarget();
    let reloads = 0;
    installVitePreloadRecovery({
      target,
      storage: {
        getItem() {
          throw new Error("storage unavailable");
        },
        setItem() {},
      },
      buildId: "https://example.test/assets/app.js",
      reload: () => {
        reloads += 1;
      },
    });

    const event = new Event("vite:preloadError", { cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(reloads).toBe(0);
  });
});

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
