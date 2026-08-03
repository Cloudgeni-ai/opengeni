import { describe, expect, test } from "bun:test";

import { applyAnalyticsConsent, syncAnalytics } from "./analytics";
import {
  analyticsHasProviders,
  analyticsPreferencesAvailable,
  openAnalyticsPreferences,
  persistAnalyticsConsent,
  storedAnalyticsConsent,
  takePendingAnalyticsPreferencesOpen,
} from "./analytics-consent";

describe("analytics consent", () => {
  test("recognizes only configured provider adapters", () => {
    expect(analyticsHasProviders({ consentRequired: true, providers: {} })).toBe(false);
    expect(
      analyticsHasProviders({
        consentRequired: true,
        providers: { reo: { clientId: "reo_client-1" } },
      }),
    ).toBe(true);
    expect(analyticsPreferencesAvailable({ consentRequired: true, providers: {} })).toBe(false);
    expect(
      analyticsPreferencesAvailable({
        consentRequired: true,
        providers: { reo: { clientId: "reo_client-1" } },
      }),
    ).toBe(true);
    expect(
      analyticsPreferencesAvailable({
        consentRequired: false,
        providers: { reo: { clientId: "reo_client-1" } },
      }),
    ).toBe(false);
  });

  test("persists and validates consent choices", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(storedAnalyticsConsent(storage)).toBeNull();
    persistAnalyticsConsent("granted", storage);
    expect(storedAnalyticsConsent(storage)).toBe("granted");
    values.set("opengeni.analyticsConsent", "invalid");
    expect(storedAnalyticsConsent(storage)).toBeNull();
  });

  test("uses the in-memory choice when browser storage is unavailable", () => {
    persistAnalyticsConsent("denied", {
      setItem: () => {
        throw new Error("storage denied");
      },
    });
    expect(
      storedAnalyticsConsent({
        getItem: () => {
          throw new Error("storage denied");
        },
      }),
    ).toBe("denied");
  });

  test("queues preference opens until the lazy manager consumes them", () => {
    expect(takePendingAnalyticsPreferencesOpen()).toBe(false);
    openAnalyticsPreferences();
    expect(takePendingAnalyticsPreferencesOpen()).toBe(true);
    expect(takePendingAnalyticsPreferencesOpen()).toBe(false);
  });
});

describe("analytics providers", () => {
  test("sends only the latest page view while providers initialize", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const dataLayer: unknown[] = [];
    const fakeWindow = {
      dataLayer,
      localStorage: {
        getItem: () => "granted",
        setItem: () => undefined,
      },
      location: { origin: "https://app.opengeni.ai" },
    };

    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: () => null,
        createElement: () => ({ id: "", async: false, src: "" }),
        head: { append: () => undefined },
      },
    });

    try {
      const config = {
        consentRequired: true,
        providers: { ga4: { measurementId: "G-TEST123" } },
      };
      syncAnalytics(config, "/first");
      syncAnalytics(config, "/second");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(pageViewLocations(dataLayer)).toEqual(["https://app.opengeni.ai/second"]);

      syncAnalytics(config, "/third");
      expect(pageViewLocations(dataLayer)).toEqual([
        "https://app.opengeni.ai/second",
        "https://app.opengeni.ai/third",
      ]);
      persistAnalyticsConsent("denied", fakeWindow.localStorage);
      applyAnalyticsConsent("denied");
    } finally {
      restoreGlobal("window", originalWindow);
      restoreGlobal("document", originalDocument);
    }
  });

  test("initializes Reo with copy capture disabled and unloads it on denial", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const initCalls: unknown[] = [];
    let unloadCalls = 0;
    const listeners = new Map<string, () => void>();
    const script = {
      id: "",
      async: false,
      src: "",
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      remove: () => undefined,
    };
    const fakeWindow = {
      localStorage: {
        getItem: () => "granted",
        setItem: () => undefined,
      },
      location: { origin: "https://app.opengeni.ai" },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      Reo: undefined as ReoClientForTest | undefined,
    };
    const reo = {
      init: (config: unknown) => initCalls.push(config),
      unload: () => {
        unloadCalls += 1;
      },
    };

    Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: () => null,
        createElement: () => script,
        head: {
          append: () => {
            fakeWindow.Reo = reo;
            queueMicrotask(() => listeners.get("load")?.());
          },
        },
      },
    });

    try {
      syncAnalytics(
        {
          consentRequired: true,
          providers: { reo: { clientId: "reo_client-1" } },
        },
        "/workspaces",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(initCalls).toEqual([{ clientID: "reo_client-1", dnt: ["copy", "ai"] }]);
      expect(script.src).toBe("https://static.reo.dev/reo_client-1/reo.js");

      persistAnalyticsConsent("denied", fakeWindow.localStorage);
      applyAnalyticsConsent("denied");
      expect(unloadCalls).toBe(1);
    } finally {
      restoreGlobal("window", originalWindow);
      restoreGlobal("document", originalDocument);
    }
  });
});

type ReoClientForTest = {
  init: (config: unknown) => void;
  unload: () => void;
};

function pageViewLocations(dataLayer: unknown[]): unknown[] {
  return dataLayer
    .filter(
      (entry): entry is [string, string, { page_location: unknown }] =>
        Array.isArray(entry) && entry[0] === "event" && entry[1] === "page_view",
    )
    .map((entry) => entry[2].page_location);
}

function restoreGlobal(name: "document" | "window", descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}
