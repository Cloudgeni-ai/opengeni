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
  let secondTarget = false;
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
              ...(secondTarget
                ? [
                    {
                      targetId: "target-2",
                      type: "page",
                      title: "",
                      url: "about:blank",
                      attached: true,
                    },
                  ]
                : []),
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
          if (params?.hidden === true) {
            expect(params).toEqual({ url: "about:blank", hidden: true });
            return { targetId: "metadata-target" } as T;
          }
          expect(params).toEqual({ url: "about:blank", background: true });
          secondTarget = true;
          return { targetId: "target-2" } as T;
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
  const browserSessionId = randomUUID();
  const controllerGeneration = "controller-1";
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
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
    await driver.selectTarget("target-1");
    expect((await driver.openTarget()).target.id).toBe("target-2");
    expect(cdpCalls.some((call) => call.method === "Target.activateTarget")).toBe(false);

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
    await driver.dispatch({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: observation.target.id,
      expectedTargetGeneration: observation.target.targetGeneration,
      expectedDocumentGeneration: observation.target.documentGeneration,
      expectedFrameId: observation.frameId,
      actor: { kind: "agent", subjectId: "agent:test" },
      action: { type: "permission", permission: "notifications", setting: "denied" },
    });
    expect([...cdpCalls].reverse().find((call) => call.method === "Browser.setPermission")).toEqual(
      {
        method: "Browser.setPermission",
        params: {
          permission: { name: "notifications" },
          setting: "denied",
          origin: "https://route.example.test",
        },
        sessionId: undefined,
      },
    );
  } finally {
    await driver.close();
  }
});

test("rotates physical generations exactly once after a provider profile reconfiguration", async () => {
  const browserSessionId = randomUUID();
  const controllerGeneration = "controller-1";
  const authRunId = randomUUID();
  const operationId = randomUUID();
  let reconfigured = false;
  let authCalls = 0;
  let oldConnectionCloses = 0;
  const runner: BrowserCommandRunner = {
    async run<T>(args: readonly string[]): Promise<T> {
      if (args[0] === "get" && args[1] === "cdp-url") {
        return {
          cdpUrl: reconfigured ? "wss://provider.test/after" : "wss://provider.test/before",
        } as T;
      }
      throw new Error(`unexpected runner command: ${args.join(" ")}`);
    },
    async externalAuth() {
      authCalls += 1;
      reconfigured = true;
      return {
        result: {
          state: "authenticated",
          externalAction: null,
          interactiveUrl: null,
          failureCode: null,
          profileLoaded: true,
        },
        browserReconfigured: true,
      };
    },
  };
  const connection = (label: "before" | "after"): BrowserCdpConnection => ({
    async send<T>(method: string): Promise<T> {
      if (method === "Browser.getVersion") {
        return { product: "Chrome/151.0.0.0", userAgent: label } as T;
      }
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            {
              targetId: "provider-reused-target-id",
              type: "page",
              title: label,
              url: `https://${label}.example.test/`,
              attached: false,
            },
          ],
        } as T;
      }
      return {} as T;
    },
    on() {
      return () => undefined;
    },
    async waitForEvent(): Promise<CdpEvent> {
      throw new Error("unused");
    },
    close() {
      if (label === "before") oldConnectionCloses += 1;
    },
  });
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    targetLifecycle: "cdp",
    connect: async (endpoint) => connection(endpoint.endsWith("/after") ? "after" : "before"),
  });
  try {
    const before = (await driver.listTargets())[0]!;
    const command = {
      browserSessionId,
      controllerGeneration,
      operationId,
      authRunId,
      adapterId: "kernel",
      connectionId: "managed-auth-1",
      action: "poll" as const,
    };
    expect(await driver.externalAuth(command)).toMatchObject({
      state: "authenticated",
      profileLoaded: true,
    });
    const after = (await driver.listTargets())[0]!;
    expect(after.id).toBe(before.id);
    expect(after.targetGeneration).not.toBe(before.targetGeneration);
    expect(after.url).toBe("https://after.example.test/");
    expect(oldConnectionCloses).toBe(1);
    expect(await driver.externalAuth(command)).toMatchObject({ state: "authenticated" });
    expect((await driver.listTargets())[0]!.targetGeneration).toBe(after.targetGeneration);
    expect(authCalls).toBe(1);
    await expect(driver.externalAuth({ ...command, action: "interactive" })).rejects.toThrow(
      "operation id was reused",
    );
  } finally {
    await driver.close();
  }
});
