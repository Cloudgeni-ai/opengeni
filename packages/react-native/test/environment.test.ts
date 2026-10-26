import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
