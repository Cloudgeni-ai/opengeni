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
