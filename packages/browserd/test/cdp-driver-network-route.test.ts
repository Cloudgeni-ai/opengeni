import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AgentBrowserDriver,
  type BrowserCdpConnection,
  type BrowserCommandRunner,
  type CdpEvent,
} from "../src";

test("installs route emulation on about:blank before the first external navigation", async () => {
  const destination = "https://route.example.test/";
  const runnerCalls: string[][] = [];
  const cdpCalls: Array<{
    method: string;
    params: Readonly<Record<string, unknown>> | undefined;
    sessionId: string | undefined;
  }> = [];
  let currentUrl = "about:blank";
  let metadataUrl = "about:blank";
  const runner: BrowserCommandRunner = {
    async run<T>(args: readonly string[]): Promise<T> {
      runnerCalls.push([...args]);
      if (args[0] === "open") {
        return { url: "about:blank", targetId: "target-1" } as T;
      }
      if (args[0] === "get" && args[1] === "cdp-url") {
        return { cdpUrl: "ws://127.0.0.1:9222/devtools/browser/test" } as T;
      }
      if (args[0] === "close") return { closed: true } as T;
      throw new Error(`unexpected runner command: ${args.join(" ")}`);
    },
  };
  const connection: BrowserCdpConnection = {
    async send<T>(
      method: string,
      params?: Readonly<Record<string, unknown>>,
      options?: { sessionId?: string },
    ): Promise<T> {
      cdpCalls.push({ method, params, sessionId: options?.sessionId });
      switch (method) {
        case "Browser.getVersion":
          return { product: "Chrome/151.0.0.0", userAgent: "fixture" } as T;
        case "Target.getTargets":
          return {
            targetInfos: [
              {
                targetId: "target-1",
                type: "page",
                title: currentUrl === destination ? "Routed" : "",
                url: currentUrl,
                attached: true,
              },
            ],
          } as T;
        case "Target.attachToTarget":
          return {
            sessionId:
              params?.targetId === "metadata-target"
                ? "metadata-target-session"
                : "target-session-1",
          } as T;
        case "Target.createTarget":
          expect(params).toEqual({ url: "about:blank", hidden: true });
          return { targetId: "metadata-target" } as T;
        case "Target.closeTarget":
          expect(params).toEqual({ targetId: "metadata-target" });
          return { success: true } as T;
        case "Page.getFrameTree":
          return {
            frameTree: {
              frame: {
                id: "frame-1",
                loaderId: currentUrl === destination ? "loader-2" : "loader-1",
                url: currentUrl,
              },
            },
          } as T;
        case "Page.navigate":
          if (options?.sessionId === "metadata-target-session") {
            metadataUrl = String(params?.url);
          } else {
            currentUrl = String(params?.url);
          }
          return {} as T;
        case "Runtime.evaluate":
          if (String(params?.expression).includes("navigator.userAgentData")) {
            if (
              options?.sessionId !== "metadata-target-session" ||
              metadataUrl !== "chrome://version/"
            ) {
              return { result: { value: null } } as T;
            }
            return {
              result: {
                value: {
                  brands: [{ brand: "Chromium", version: "151" }],
                  fullVersionList: [{ brand: "Chromium", version: "151.0.0.0" }],
                  platform: "Linux",
                  platformVersion: "6.1.0",
                  architecture: "arm",
                  model: "",
                  mobile: false,
                  bitness: "64",
                  wow64: false,
                  formFactors: ["Desktop"],
                },
              },
            } as T;
          }
          return { result: { value: "complete" } } as T;
        case "Accessibility.getFullAXTree":
          return { nodes: [] } as T;
        default:
          return {} as T;
      }
    },
    on(): () => void {
      return () => undefined;
    },
    async waitForEvent(): Promise<CdpEvent> {
      return { method: "Page.loadEventFired", params: {}, sessionId: "target-session-1" };
    },
    close() {},
  };
  const driver = new AgentBrowserDriver({
    browserSessionId: randomUUID(),
    controllerGeneration: "controller-1",
    runner,
    connect: async () => connection,
    emulation: {
      locale: "nb-NO",
      timezone: "Europe/Oslo",
      geolocation: {
        latitude: 59.9139,
        longitude: 10.7522,
        accuracyMeters: 25,
      },
    },
  });
  try {
    const observation = await driver.start(destination);
    expect(observation.target.url).toBe(destination);
    expect(runnerCalls[0]).toEqual(["open", "about:blank"]);

    const navigateIndex = cdpCalls.findIndex(
      (call) => call.method === "Page.navigate" && call.params?.url === destination,
    );
    expect(
      cdpCalls.filter((call) => call.method === "Page.navigate").map((call) => call.params?.url),
    ).toEqual(["chrome://version/", destination]);
    for (const method of [
      "Browser.grantPermissions",
      "Emulation.setLocaleOverride",
      "Emulation.setUserAgentOverride",
      "Emulation.setTimezoneOverride",
      "Emulation.setGeolocationOverride",
    ]) {
      const index = cdpCalls.findIndex((call) => call.method === method);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(navigateIndex);
    }
    expect(
      cdpCalls.find((call) => call.method === "Emulation.setUserAgentOverride")?.params,
    ).toEqual({
      userAgent: "fixture",
      acceptLanguage: "nb-NO",
      userAgentMetadata: {
        brands: [{ brand: "Chromium", version: "151" }],
        fullVersionList: [{ brand: "Chromium", version: "151.0.0.0" }],
        platform: "Linux",
        platformVersion: "6.1.0",
        architecture: "arm",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
        formFactors: ["Desktop"],
      },
    });
    expect(
      cdpCalls.find((call) => call.method === "Emulation.setGeolocationOverride")?.params,
    ).toEqual({ latitude: 59.9139, longitude: 10.7522, accuracy: 25 });
  } finally {
    await driver.close();
  }
});
