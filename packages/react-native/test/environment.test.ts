import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PAGE_WAKE_GAP_MS, subscribePageWake } from "../../react/src/hooks/page-wake";
import type { OpenGeniReactNativeAdapters } from "../src/adapters";
import { installOpenGeniReactNativeEnvironment } from "../src/environment";

function adapters(): OpenGeniReactNativeAdapters {
  return {
    lifecycle: {
      currentState: () => "active",
      subscribe: () => () => undefined,
    },
    persistence: {
      hydrate: async () => undefined,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
      flush: async () => undefined,
      invalidate: async () => undefined,
    },
    crypto: {
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
      sha256Hex: async () => "00".repeat(32),
    },
    files: {
      pickDocuments: async () => [],
      pickImages: async () => [],
      readBytes: async () => new Uint8Array(),
    },
    fetch: globalThis.fetch,
  };
}

type AppState = "active" | "background" | "inactive";

/**
 * Install the shim the way a Hermes app sees it: no global `window` event
 * target of its own, and an app-state subscription the test drives by hand.
 */
function installWithLifecycle() {
  let state: AppState = "active";
  const subscribers = new Set<(next: AppState) => void>();
  const base = adapters();
  const previousWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {});
  const installed = installOpenGeniReactNativeEnvironment({
    ...base,
    lifecycle: {
      currentState: () => state,
      subscribe: (listener) => {
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      },
    },
  });
  return {
    moveTo(next: AppState) {
      state = next;
      for (const listener of subscribers) listener(next);
    },
    cleanup() {
      installed.cleanup();
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else Reflect.set(globalThis, "window", previousWindow);
    },
  };
}

describe("installOpenGeniReactNativeEnvironment", () => {
  test("installs isolated browser-compatible globals and restores the previous environment", () => {
    const previousWindow = Reflect.get(globalThis, "window");
    const previousDocument = Reflect.get(globalThis, "document");
    const previousStorage = Reflect.get(globalThis, "sessionStorage");
    const previousCrypto = Reflect.get(globalThis, "crypto");

    const installed = installOpenGeniReactNativeEnvironment(adapters());

    expect(Reflect.get(globalThis, "window")).not.toBe(previousWindow);
    expect(Reflect.get(globalThis, "document")).not.toBe(previousDocument);
    expect(Reflect.get(globalThis, "sessionStorage")).not.toBe(previousStorage);

    installed.cleanup();

    expect(Reflect.get(globalThis, "window")).toBe(previousWindow);
    expect(Reflect.get(globalThis, "document")).toBe(previousDocument);
    expect(Reflect.get(globalThis, "sessionStorage")).toBe(previousStorage);
    expect(Reflect.get(globalThis, "crypto")).toBe(previousCrypto);
  });

  test("returning to the foreground runs the real @opengeni/react pageshow handler", () => {
    const app = installWithLifecycle();
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const realNow = Date.now;
    let wakes = 0;
    const unsubscribe = subscribePageWake(() => {
      wakes += 1;
    });
    try {
      app.moveTo("background");
      // The phone slept with the app in the background.
      const later = realNow() + PAGE_WAKE_GAP_MS + 1_000;
      Date.now = () => later;
      expect(() => app.moveTo("active")).not.toThrow();
      // visibilitychange saw the gap; pageshow (not from a back/forward cache) adds no second wake.
      expect(wakes).toBe(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
      unsubscribe();
      errors.mockRestore();
      app.cleanup();
    }
  });

  test("gives every listener a browser-shaped event and keeps dispatching past a throwing one", () => {
    const app = installWithLifecycle();
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const nativeWindow = globalThis.window;
    const nativeDocument = globalThis.document;
    const seen: Array<{ type: string; target: unknown; persisted: unknown }> = [];
    const record = (event: Event) =>
      seen.push({
        type: event.type,
        target: event.target,
        persisted: (event as PageTransitionEvent).persisted,
      });
    const fail = () => {
      throw new Error("listener failed");
    };
    let once = 0;
    try {
      nativeDocument.addEventListener("visibilitychange", fail);
      nativeDocument.addEventListener("visibilitychange", record);
      nativeWindow.addEventListener("pageshow", record);
      nativeWindow.addEventListener("pageshow", { handleEvent: record });
      nativeWindow.addEventListener("pageshow", () => (once += 1), { once: true });

      app.moveTo("background");
      expect(nativeDocument.visibilityState).toBe("hidden");
      expect(nativeDocument.hasFocus()).toBe(false);
      expect(() => app.moveTo("active")).not.toThrow();
      app.moveTo("background");
      app.moveTo("active");

      expect(seen.slice(0, 4)).toEqual([
        { type: "visibilitychange", target: nativeDocument, persisted: undefined },
        { type: "visibilitychange", target: nativeDocument, persisted: undefined },
        { type: "pageshow", target: nativeWindow, persisted: false },
        { type: "pageshow", target: nativeWindow, persisted: false },
      ]);
      expect(seen).toHaveLength(8);
      expect(once).toBe(1);
      expect(errors).toHaveBeenCalledTimes(4);
    } finally {
      errors.mockRestore();
      app.cleanup();
    }
  });

  test("keeps provider globals independent of hydration-driven child unmounts", () => {
    const source = readFileSync(new URL("../src/environment.tsx", import.meta.url), "utf8");
    const layoutEffect = source.indexOf("useLayoutEffect(() => {");
    const install = source.indexOf("installOpenGeniReactNativeEnvironment(adapters)", layoutEffect);
    const layoutEffectEnd = source.indexOf("}, [adapters])", install);
    const hydrationGate = source.indexOf("if (!hydrated) return loadingFallback");

    expect(layoutEffect).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(layoutEffect);
    expect(layoutEffectEnd).toBeGreaterThan(install);
    expect(source.slice(layoutEffect, layoutEffectEnd)).not.toContain("hydrated");
    expect(source.slice(install, layoutEffectEnd)).toContain(
      "globalThis.setTimeout(() => installed.cleanup(), 0)",
    );
    expect(hydrationGate).toBeGreaterThan(layoutEffectEnd);
  });

  test("gives a reason-dropping AbortController the standard reason and throwIfAborted", () => {
    // React Native's controller ignores abort(reason) and has no throwIfAborted.
    class LegacySignal {
      aborted = false;
    }
    class LegacyController {
      readonly signal = new LegacySignal();
      abort(): void {
        this.signal.aborted = true;
      }
    }
    const previous = globalThis.AbortController;
    Reflect.set(globalThis, "AbortController", LegacyController);
    const installed = installOpenGeniReactNativeEnvironment(adapters());
    try {
      const closed = new Error("closed");
      const controller = new LegacyController() as unknown as AbortController;
      expect(() => controller.signal.throwIfAborted()).not.toThrow();
      controller.abort(closed);
      expect(controller.signal.reason).toBe(closed);
      expect(() => controller.signal.throwIfAborted()).toThrow(closed);

      const plain = new LegacyController() as unknown as AbortController;
      plain.abort();
      expect((plain.signal.reason as Error).name).toBe("AbortError");
    } finally {
      installed.cleanup();
      Reflect.set(globalThis, "AbortController", previous);
    }
  });

  test("leaves a standard AbortController untouched", () => {
    const abort = AbortController.prototype.abort;
    const installed = installOpenGeniReactNativeEnvironment(adapters());
    installed.cleanup();
    expect(AbortController.prototype.abort).toBe(abort);
  });
});
