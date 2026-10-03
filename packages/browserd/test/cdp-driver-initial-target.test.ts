import { expect, test } from "bun:test";
import { AgentBrowserDriver, type BrowserCdpConnection } from "../src";

test.each([undefined, "", "missing-target"])(
  "startup cannot borrow an existing tab when created target is %j",
  async (createdTargetId) => {
    const calls: string[] = [];
    const connection: BrowserCdpConnection = {
      async send<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "Browser.getVersion") return { product: "Chrome/151" } as T;
        if (method === "Target.createTarget") return { targetId: createdTargetId } as T;
        if (method === "Target.getTargets") {
          return {
            targetInfos: [
              { targetId: "user-page", type: "page", url: "https://example.com/" },
              { targetId: "user-blank", type: "page", url: "about:blank" },
            ],
          } as T;
        }
        if (method === "Target.setDiscoverTargets") return {} as T;
        throw new Error(`must not touch an existing tab: ${method}`);
      },
      on: () => () => {},
      waitForEvent: async () => {
        throw new Error("must not wait for an existing tab event");
      },
      close() {},
    };
    const driver = new AgentBrowserDriver({
      browserSessionId: crypto.randomUUID(),
      controllerGeneration: "initial-target-test",
      targetLifecycle: "cdp",
      focusEmulation: true,
      runner: {
        async run<T>(args: readonly string[]): Promise<T> {
          if (args[0] === "get") return { cdpUrl: "ws://localhost/test" } as T;
          if (args[0] === "close") return {} as T;
          throw new Error(`unexpected command: ${args[0]}`);
        },
      },
      connect: async () => connection,
    });
    try {
      if (createdTargetId) {
        await expect(driver.start("https://destination.example/")).rejects.toMatchObject({
          code: "target_not_found",
        });
      } else {
        await expect(driver.start("https://destination.example/")).rejects.toThrow(
          "browser did not return its initial page target",
        );
      }
      expect(calls.filter((method) => method === "Target.createTarget")).toHaveLength(1);
      expect(calls).not.toContain("Target.attachToTarget");
      expect(calls).not.toContain("Target.activateTarget");
      expect(calls).not.toContain("Page.navigate");
    } finally {
      await driver.close();
    }
  },
  10_000,
);

test.each([
  undefined,
  [],
  [{ type: "browser", id: 2002 }],
  [{ type: "renderer", id: 2001 }],
  [
    { type: "browser", id: 2001 },
    { type: "browser", id: 2001 },
  ],
])(
  "reattachment rejects unmatched CDP process proof %j before target/configuration commands",
  async (processInfo) => {
    const calls: string[] = [];
    let disconnected = 0,
      launches = 0;
    const process = {
      pid: 2001,
      birth: "synthetic-birth",
      executablePath: "/synthetic/chrome",
      profileDirectory: "/synthetic/profile",
      cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
    };
    const connection: BrowserCdpConnection = {
      async send<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "SystemInfo.getProcessInfo") return { processInfo } as T;
        throw new Error("must not configure an unproven process");
      },
      on: () => () => {},
      waitForEvent: async () => {
        throw new Error("unused");
      },
      close() {
        disconnected++;
      },
    };
    const driver = new AgentBrowserDriver({
      browserSessionId: crypto.randomUUID(),
      controllerGeneration: "synthetic-reattach",
      runner: {
        reattachedOwnedProcess: process,
        async run<T>(args: readonly string[]): Promise<T> {
          if (args[0] === "get") return { cdpUrl: process.cdpEndpoint } as T;
          launches++;
          throw new Error("must not launch");
        },
      },
      connect: async () => connection,
    });
    await expect(driver.start()).rejects.toThrow("owned browser");
    expect(calls).toEqual(["SystemInfo.getProcessInfo"]);
    expect(disconnected).toBe(1);
    expect(launches).toBe(0);
    await driver.detach();
  },
);

test("exact owned CDP PID proof precedes configuration; detach never terminates its browser", async () => {
  const calls: string[] = [];
  let terminated = 0;
  const process = {
    pid: 2001,
    birth: "synthetic-birth",
    executablePath: "/synthetic/chrome",
    profileDirectory: "/synthetic/profile",
    cdpEndpoint: "ws://127.0.0.1:12345/devtools/browser/11111111-1111-4111-8111-111111111111",
  };
  const connection: BrowserCdpConnection = {
    async send<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "SystemInfo.getProcessInfo")
        return { processInfo: [{ type: "browser", id: 2001 }] } as T;
      if (method === "Browser.getVersion") return { product: "Chrome/151" } as T;
      if (method === "Target.setDiscoverTargets") return {} as T;
      if (method === "Target.getTargets") return { targetInfos: [] } as T;
      if (method === "Target.createTarget") return {} as T;
      throw new Error("unexpected target command");
    },
    on: () => () => {},
    waitForEvent: async () => {
      throw new Error("unused");
    },
    close() {},
  };
  const driver = new AgentBrowserDriver({
    browserSessionId: crypto.randomUUID(),
    controllerGeneration: "synthetic-reattach",
    runner: {
      reattachedOwnedProcess: process,
      async run<T>() {
        return { cdpUrl: process.cdpEndpoint } as T;
      },
      async terminate() {
        terminated++;
      },
    },
    connect: async () => connection,
  });
  await expect(driver.start()).rejects.toThrow("initial page target");
  expect(calls[0]).toBe("SystemInfo.getProcessInfo");
  expect(calls).not.toContain("Page.navigate");
  await driver.detach();
  expect(terminated).toBe(0);
});
